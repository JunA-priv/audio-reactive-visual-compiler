package service

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/aibudget"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/authn"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/blueprint"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/projects"
	"github.com/labstack/echo/v5"
)

type Config struct {
	Mode                        string
	Model                       string
	LocalFixtureUnlimitedUserID string
	Generator                   Generator
	Timeout                     time.Duration
	Logger                      *slog.Logger
	Projects                    *projects.Handler
	GenerateAuth                func(echo.HandlerFunc) echo.HandlerFunc
	Budget                      aibudget.Store
}

const DefaultGenerationTimeout = 120 * time.Second

type API struct{ cfg Config }
type errorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}
type generateResponse struct {
	Blueprint   json.RawMessage       `json:"blueprint"`
	Mode        string                `json:"mode"`
	Model       string                `json:"model,omitempty"`
	Diagnostics generationDiagnostics `json:"diagnostics"`
}

type generationDiagnostics struct {
	LatencyMs  int64       `json:"latencyMs"`
	Validation string      `json:"validation"`
	Usage      *TokenUsage `json:"usage,omitempty"`
}

func NewServer(cfg Config) *echo.Echo {
	if cfg.Mode == "" {
		cfg.Mode = "fixture"
	}
	if cfg.Model == "" {
		cfg.Model = OpenAIModel
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = DefaultGenerationTimeout
	}
	a := &API{cfg: cfg}
	e := echo.New()
	e.HTTPErrorHandler = func(c *echo.Context, err error) {
		status := http.StatusInternalServerError
		var he *echo.HTTPError
		if errors.As(err, &he) {
			status = he.Code
		}
		code, message := "http_error", "request failed"
		switch status {
		case http.StatusNotFound:
			code, message = "not_found", "route not found"
		case http.StatusMethodNotAllowed:
			code, message = "method_not_allowed", "method not allowed"
		case http.StatusInternalServerError:
			code, message = "internal_error", "internal server error"
		}
		_ = respondError(c, status, code, message)
	}
	e.Use(localCORS)
	e.GET("/healthz", func(c *echo.Context) error { return c.JSON(http.StatusOK, map[string]string{"status": "ok"}) })
	generateAuth := cfg.GenerateAuth
	if generateAuth == nil {
		generateAuth = func(next echo.HandlerFunc) echo.HandlerFunc {
			return func(c *echo.Context) error {
				return respondError(c, http.StatusServiceUnavailable, "generation_auth_unavailable", "Blueprint generation is not configured")
			}
		}
	}
	e.POST("/api/v1/blueprints/generate", a.generate, generateAuth)
	if cfg.Projects != nil {
		cfg.Projects.Register(e)
	}
	return e
}

func localCORS(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		origin := c.Request().Header.Get("Origin")
		if origin == "http://127.0.0.1:5173" || origin == "http://localhost:5173" {
			c.Response().Header().Set("Access-Control-Allow-Origin", origin)
			c.Response().Header().Add("Vary", "Origin")
			c.Response().Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			c.Response().Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key")
		}
		if c.Request().Method == http.MethodOptions {
			return c.NoContent(http.StatusNoContent)
		}
		return next(c)
	}
}

func (a *API) generate(c *echo.Context) error {
	principal, authenticated := authn.PrincipalFrom(c.Request().Context())
	if !authenticated {
		return respondError(c, http.StatusUnauthorized, "unauthorized", "valid bearer token required")
	}
	if a.cfg.Budget == nil {
		return respondError(c, http.StatusServiceUnavailable, "ai_budget_unavailable", "Blueprint generation is unavailable")
	}
	if !strings.HasPrefix(strings.ToLower(c.Request().Header.Get("Content-Type")), "application/json") {
		return respondError(c, http.StatusUnsupportedMediaType, "unsupported_media_type", "Content-Type must be application/json")
	}
	r := c.Request()
	r.Body = http.MaxBytesReader(c.Response(), r.Body, MaxBodyBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return respondError(c, http.StatusRequestEntityTooLarge, "request_too_large", "request exceeds 2 MiB")
		}
		return respondError(c, http.StatusBadRequest, "invalid_request", "could not read request")
	}
	var req Request
	d := json.NewDecoder(strings.NewReader(string(body)))
	d.DisallowUnknownFields()
	if err = d.Decode(&req); err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_request", "request must be one valid JSON object")
	}
	var extra any
	if err = d.Decode(&extra); err != io.EOF {
		return respondError(c, http.StatusBadRequest, "invalid_request", "request must contain exactly one JSON object")
	}
	summary, timeline, compact, err := ValidateInput(req)
	_ = timeline
	if err != nil {
		return respondError(c, http.StatusUnprocessableEntity, "invalid_input", err.Error())
	}
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if len(idempotencyKey) < 16 || len(idempotencyKey) > 128 || !validIdempotencyKey(idempotencyKey) {
		return respondError(c, http.StatusBadRequest, "invalid_idempotency_key", "Idempotency-Key must be 16-128 safe characters")
	}
	prompt := BuildPrompt(summary, compact, strings.TrimSpace(req.VisualIntent))
	var reservation aibudget.Reservation
	var reserveErr error
	if a.cfg.Mode == "fixture" && a.cfg.LocalFixtureUnlimitedUserID != "" && principal.Subject == a.cfg.LocalFixtureUnlimitedUserID {
		localStore, ok := a.cfg.Budget.(aibudget.LocalFixtureStore)
		if !ok {
			return respondError(c, http.StatusServiceUnavailable, "ai_budget_unavailable", "Blueprint generation is unavailable")
		}
		reservation, reserveErr = localStore.ReserveLocalFixture(r.Context(), principal.Subject, hashKey(idempotencyKey))
	} else {
		reservation, reserveErr = a.cfg.Budget.Reserve(r.Context(), principal.Subject, hashKey(idempotencyKey))
	}
	if reserveErr != nil {
		return budgetError(c, reserveErr)
	}
	settled := false
	settle := func(value aibudget.Settlement) error {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		err := a.cfg.Budget.Settle(ctx, reservation.ID, value)
		if err == nil {
			settled = true
		}
		return err
	}
	defer func() {
		if !settled {
			_ = settle(aibudget.Settlement{State: "usage_unknown", ErrorCode: "request_interrupted"})
		}
	}()
	var raw []byte
	model := ""
	var usage *TokenUsage
	startedAt := time.Now()
	switch a.cfg.Mode {
	case "fixture":
		raw = []byte(FixtureBlueprint)
		if err := settle(aibudget.Settlement{State: "succeeded"}); err != nil {
			return respondError(c, http.StatusServiceUnavailable, "ai_budget_unavailable", "Blueprint generation could not be recorded")
		}
	case "openai":
		if a.cfg.Generator == nil {
			_ = settle(aibudget.Settlement{State: "failed_known", ErrorCode: "openai_not_configured"})
			return respondError(c, http.StatusServiceUnavailable, "openai_not_configured", "OpenAI mode is enabled but no server-side API key is configured")
		}
		counter, ok := a.cfg.Generator.(TokenCounter)
		if !ok {
			_ = settle(aibudget.Settlement{State: "failed_known", ErrorCode: "token_counter_unavailable"})
			return respondError(c, http.StatusServiceUnavailable, "token_counter_unavailable", "Blueprint generation is unavailable")
		}
		if reservation.Model != a.cfg.Model {
			_ = settle(aibudget.Settlement{State: "failed_known", ErrorCode: "model_policy_mismatch"})
			return respondError(c, http.StatusServiceUnavailable, "model_policy_mismatch", "Blueprint generation is unavailable")
		}
		ctx, cancel := context.WithTimeout(r.Context(), a.cfg.Timeout)
		defer cancel()
		inputTokens, countErr := counter.CountTokens(ctx, prompt)
		if countErr != nil {
			_ = settle(aibudget.Settlement{State: "usage_unknown", ErrorCode: "token_count_failed"})
			return respondProviderFailure(c, countErr)
		}
		if inputTokens > reservation.MaxInputTokens {
			if err := settle(aibudget.Settlement{State: "failed_known", ErrorCode: "input_token_limit"}); err != nil {
				return respondError(c, http.StatusServiceUnavailable, "ai_budget_unavailable", "Blueprint generation could not be recorded")
			}
			return respondError(c, http.StatusUnprocessableEntity, "input_token_limit", "generation input exceeds the configured token limit")
		}
		limitedGenerator, ok := a.cfg.Generator.(LimitedGenerator)
		if !ok || reservation.MaxOutputTokens < 1 || reservation.MaxOutputTokens > 4000 {
			_ = settle(aibudget.Settlement{State: "failed_known", ErrorCode: "output_limit_unavailable"})
			return respondError(c, http.StatusServiceUnavailable, "output_limit_unavailable", "Blueprint generation is unavailable")
		}
		generated, generateErr := limitedGenerator.GenerateWithOutputLimit(ctx, prompt, reservation.MaxOutputTokens)
		err = generateErr
		if err != nil {
			failure := classifyProviderError(err)
			var diagnostic *ProviderFailure
			if errors.As(failure, &diagnostic) {
				logger := a.cfg.Logger
				if logger == nil {
					logger = slog.Default()
				}
				attrs := []any{"event", "openai_generation_failed", "classification", diagnostic.Classification, "latency_ms", time.Since(startedAt).Milliseconds(), "model", a.cfg.Model}
				if diagnostic.UpstreamStatus > 0 {
					attrs = append(attrs, "upstream_http_status", diagnostic.UpstreamStatus)
				}
				logger.Error("OpenAI generation failed", attrs...)
			}
			_ = settle(aibudget.Settlement{State: "usage_unknown", ErrorCode: safeOpenAICode(failure)})
			return respondProviderFailure(c, failure)
		}
		raw = generated.Blueprint
		model = generated.ModelVersion
		usage = generated.Usage
		if usage == nil || usage.PromptTokens < 0 || usage.TotalTokens < usage.PromptTokens {
			_ = settle(aibudget.Settlement{State: "usage_unknown", ErrorCode: "usage_metadata_missing"})
			return respondError(c, http.StatusBadGateway, "openai_usage_unknown", "OpenAI usage could not be verified")
		}
		actualOutputTokens := usage.TotalTokens - usage.PromptTokens
		if usage.PromptTokens > reservation.MaxInputTokens || actualOutputTokens > reservation.MaxOutputTokens {
			_ = settle(aibudget.Settlement{State: "usage_unknown", ErrorCode: "reported_usage_over_limit"})
			return respondError(c, http.StatusBadGateway, "openai_usage_unknown", "OpenAI usage exceeded the reserved maximum")
		}
		state := "succeeded"
		if _, decodeErr := blueprint.Decode(raw); decodeErr != nil || len(raw) > 256<<10 {
			state = "failed_known"
		}
		if err := settle(aibudget.Settlement{State: state, InputTokens: usage.PromptTokens, OutputTokens: actualOutputTokens}); err != nil {
			return respondError(c, http.StatusServiceUnavailable, "ai_budget_unavailable", "Blueprint generation could not be recorded")
		}
	default:
		_ = settle(aibudget.Settlement{State: "failed_known", ErrorCode: "server_configuration_error"})
		return respondError(c, http.StatusInternalServerError, "server_configuration_error", "server mode is invalid")
	}
	if len(raw) > 256<<10 {
		return respondError(c, http.StatusBadGateway, "openai_invalid_output", "Blueprint output exceeds 256 KiB")
	}
	if _, err := blueprint.Decode(raw); err != nil {
		return respondError(c, http.StatusBadGateway, "openai_invalid_output", "OpenAI output was not a valid EditorBlueprint v1")
	}
	if a.cfg.Mode == "openai" {
		if model == "" {
			model = a.cfg.Model
		}
	}
	return c.JSON(http.StatusOK, generateResponse{
		Blueprint: json.RawMessage(raw), Mode: a.cfg.Mode, Model: model,
		Diagnostics: generationDiagnostics{LatencyMs: time.Since(startedAt).Milliseconds(), Validation: "passed", Usage: usage},
	})
}

func budgetError(c *echo.Context, err error) error {
	switch {
	case errors.Is(err, aibudget.ErrNotEntitled):
		return respondError(c, http.StatusForbidden, "ai_not_permitted", "AI generation is not enabled for this account")
	case errors.Is(err, aibudget.ErrQuotaExceeded), errors.Is(err, aibudget.ErrConcurrency):
		return respondError(c, http.StatusTooManyRequests, "ai_quota_exceeded", "AI generation limit reached")
	case errors.Is(err, aibudget.ErrDisabled), errors.Is(err, aibudget.ErrBudgetExceeded), errors.Is(err, aibudget.ErrUnavailable):
		return respondError(c, http.StatusServiceUnavailable, "ai_generation_unavailable", "AI generation is unavailable")
	case errors.Is(err, aibudget.ErrDuplicate):
		return respondError(c, http.StatusConflict, "idempotency_key_reused", "this Idempotency-Key has already been used")
	default:
		return respondError(c, http.StatusServiceUnavailable, "ai_generation_unavailable", "AI generation is unavailable")
	}
}

func respondProviderFailure(c *echo.Context, err error) error {
	failure := classifyProviderError(err)
	if errors.Is(failure, ErrProviderRefusal) {
		return respondError(c, http.StatusBadGateway, "openai_refusal", "OpenAI refused the generation request")
	}
	if failureClass(failure) == "openai_incomplete_output" {
		return respondError(c, http.StatusBadGateway, "openai_incomplete_output", "OpenAI response was incomplete")
	}
	switch {
	case errors.Is(failure, context.DeadlineExceeded), errors.Is(failure, context.Canceled), failureClass(failure) == "openai_timeout", failureClass(failure) == "openai_canceled":
		return respondError(c, http.StatusGatewayTimeout, "openai_timeout", "OpenAI request timed out")
	case errors.Is(failure, ErrRateLimited):
		return respondError(c, http.StatusTooManyRequests, "openai_rate_limited", "OpenAI rate limit reached")
	default:
		return respondError(c, http.StatusBadGateway, "openai_upstream_error", "OpenAI request failed")
	}
}

func safeOpenAICode(err error) string {
	if class := failureClass(err); class != "" {
		return class
	}
	return "openai_upstream_error"
}

func hashKey(key string) []byte {
	hash := sha256.Sum256([]byte(key))
	return hash[:]
}

func validIdempotencyKey(key string) bool {
	for _, r := range key {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.' || r == ':') {
			return false
		}
	}
	return true
}

func failureClass(err error) string {
	var failure *ProviderFailure
	if errors.As(err, &failure) {
		return failure.Classification
	}
	return ""
}

func respondError(c *echo.Context, status int, code, message string) error {
	var out errorBody
	out.Error.Code = code
	out.Error.Message = message
	return c.JSON(status, out)
}
