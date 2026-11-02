package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/aibudget"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/authn"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/blueprint"
	"github.com/labstack/echo/v5"
)

const validRequest = `{"musicSummary":{"summaryVersion":1,"durationMs":12000,"sourceAudio":{"format":"fixture","codec":"fixture","sampleRateHz":44100,"channels":2,"fileBytes":0},"analysis":{"model":"fixture","device":"cpu","stemRms":{"drums":0.18,"bass":0.24,"vocals":0.12,"other":0.16},"estimatedKickCount":2,"featureSampleRateHz":10,"kickDetection":"fixture"}},"featureTimeline":{"schemaVersion":1,"timeUnit":"ms","durationMs":12000,"bassEnvelope":[{"timeMs":0,"value":0.2},{"timeMs":12000,"value":0.8}],"kickEvents":[1000,6000]}}`

type fakeGenerator struct {
	output        []byte
	err           error
	wait          bool
	prompt        string
	deadline      time.Time
	generateCalls int
	countTokens   int32
	countErr      error
}

func (f *fakeGenerator) CountTokens(context.Context, string) (int32, error) {
	if f.countErr != nil {
		return 0, f.countErr
	}
	if f.countTokens != 0 {
		return f.countTokens, nil
	}
	return 321, nil
}

type fakeBudget struct {
	reserveErr        error
	reservations      int
	localReservations int
	settlements       []aibudget.Settlement
	reservation       aibudget.Reservation
}

func (f *fakeBudget) Reserve(context.Context, string, []byte) (aibudget.Reservation, error) {
	f.reservations++
	if f.reserveErr != nil {
		return aibudget.Reservation{}, f.reserveErr
	}
	if f.reservation.ID != "" {
		return f.reservation, nil
	}
	return aibudget.Reservation{ID: "00000000-0000-4000-8000-000000000099", Model: OpenAIModel, MaxInputTokens: 8000, MaxOutputTokens: 4000}, nil
}
func (f *fakeBudget) ReserveLocalFixture(context.Context, string, []byte) (aibudget.Reservation, error) {
	f.localReservations++
	if f.reserveErr != nil {
		return aibudget.Reservation{}, f.reserveErr
	}
	if f.reservation.ID != "" {
		return f.reservation, nil
	}
	return aibudget.Reservation{ID: "00000000-0000-4000-8000-000000000099", Model: OpenAIModel, MaxInputTokens: 8000, MaxOutputTokens: 4000}, nil
}
func (f *fakeBudget) Settle(_ context.Context, _ string, value aibudget.Settlement) error {
	f.settlements = append(f.settlements, value)
	return nil
}
func (f *fakeBudget) Close() {}

func testAIAuth(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		if c.Request().Header.Get(echo.HeaderAuthorization) != "Bearer test-user-token" {
			return respondError(c, http.StatusUnauthorized, "unauthorized", "valid bearer token required")
		}
		ctx := authn.ContextWithPrincipal(c.Request().Context(), authn.Principal{Subject: "00000000-0000-4000-8000-000000000001"})
		c.SetRequest(c.Request().WithContext(ctx))
		return next(c)
	}
}

func (f *fakeGenerator) Generate(ctx context.Context, prompt string) (GenerationResult, error) {
	f.generateCalls++
	f.prompt = prompt
	if deadline, ok := ctx.Deadline(); ok {
		f.deadline = deadline
	}
	if f.wait {
		<-ctx.Done()
		return GenerationResult{}, ctx.Err()
	}
	return GenerationResult{Blueprint: f.output, ModelVersion: OpenAIModel, Usage: &TokenUsage{PromptTokens: 123, CandidateTokens: 456, TotalTokens: 579}}, f.err
}

func (f *fakeGenerator) GenerateWithOutputLimit(ctx context.Context, prompt string, maxOutputTokens int32) (GenerationResult, error) {
	if maxOutputTokens < 1 || maxOutputTokens > 4000 {
		return GenerationResult{}, ErrInvalidModelOutput
	}
	return f.Generate(ctx, prompt)
}

func request(t *testing.T, mode string, gen Generator, body string, timeout time.Duration) (int, string) {
	t.Helper()
	e := NewServer(Config{Mode: mode, Generator: gen, Timeout: timeout, GenerateAuth: testAIAuth, Budget: &fakeBudget{}})
	r := httptest.NewRequest(http.MethodPost, "/api/v1/blueprints/generate", strings.NewReader(body))
	r.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	r.Header.Set(echo.HeaderAuthorization, "Bearer test-user-token")
	r.Header.Set("Idempotency-Key", "test-idempotency-key-0001")
	w := httptest.NewRecorder()
	e.ServeHTTP(w, r)
	return w.Code, w.Body.String()
}

func TestFixtureEndpointReturnsValidatedBlueprint(t *testing.T) {
	summary, err := os.ReadFile("../../testdata/music-summary.json")
	if err != nil {
		t.Fatal(err)
	}
	timeline, err := os.ReadFile("../../testdata/feature-timeline.json")
	if err != nil {
		t.Fatal(err)
	}
	bodyBytes, err := json.Marshal(map[string]json.RawMessage{"musicSummary": summary, "featureTimeline": timeline})
	if err != nil {
		t.Fatal(err)
	}
	status, body := request(t, "fixture", nil, string(bodyBytes), 0)
	if status != http.StatusOK {
		t.Fatalf("status=%d body=%s", status, body)
	}
	var got struct {
		Blueprint   json.RawMessage       `json:"blueprint"`
		Mode        string                `json:"mode"`
		Diagnostics generationDiagnostics `json:"diagnostics"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	if got.Mode != "fixture" {
		t.Fatalf("mode=%q", got.Mode)
	}
	if _, err := blueprint.Decode(got.Blueprint); err != nil {
		t.Fatal(err)
	}
	if got.Diagnostics.Validation != "passed" {
		t.Fatalf("validation diagnostic=%q", got.Diagnostics.Validation)
	}
}

func TestLocalFixtureExemptionIsSubjectAndModeScoped(t *testing.T) {
	const developerID = "00000000-0000-4000-8000-000000000001"
	for _, tc := range []struct {
		name       string
		mode       string
		developer  string
		reserveErr error
		wantLocal  int
		wantNormal int
		wantStatus int
	}{
		{name: "configured local fixture developer", mode: "fixture", developer: developerID, wantLocal: 1, wantStatus: http.StatusOK},
		{name: "other authenticated user", mode: "fixture", developer: "00000000-0000-4000-8000-000000000002", wantNormal: 1, wantStatus: http.StatusOK},
		{name: "OpenAI mode never uses exemption", mode: "openai", developer: developerID, wantNormal: 1, wantStatus: http.StatusOK},
		{name: "entitlement still required for exempt subject", mode: "fixture", developer: developerID, reserveErr: aibudget.ErrNotEntitled, wantLocal: 1, wantStatus: http.StatusForbidden},
		{name: "kill switch still blocks exempt user", mode: "fixture", developer: developerID, reserveErr: aibudget.ErrDisabled, wantLocal: 1, wantStatus: http.StatusServiceUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			budget := &fakeBudget{reserveErr: tc.reserveErr}
			gen := &fakeGenerator{output: []byte(FixtureBlueprint)}
			e := NewServer(Config{Mode: tc.mode, Generator: gen, GenerateAuth: testAIAuth, Budget: budget, LocalFixtureUnlimitedUserID: tc.developer})
			r := httptest.NewRequest(http.MethodPost, "/api/v1/blueprints/generate", strings.NewReader(validRequest))
			r.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
			r.Header.Set(echo.HeaderAuthorization, "Bearer test-user-token")
			r.Header.Set("Idempotency-Key", "scoped-idempotency-key-0001")
			w := httptest.NewRecorder()
			e.ServeHTTP(w, r)
			if w.Code != tc.wantStatus {
				t.Fatalf("status=%d want=%d", w.Code, tc.wantStatus)
			}
			if budget.localReservations != tc.wantLocal || budget.reservations != tc.wantNormal {
				t.Fatalf("local reservations=%d normal reservations=%d", budget.localReservations, budget.reservations)
			}
			if tc.reserveErr != nil && gen.generateCalls != 0 {
				t.Fatal("generator ran despite a failed reservation")
			}
		})
	}
}

func TestRejectsMalformedAndIncompleteRequests(t *testing.T) {
	cases := []struct {
		name, body string
		status     int
	}{
		{"bad json", "{", 400}, {"missing field", `{"musicSummary":{},"featureTimeline":{}}`, 422},
		{"wrong version", strings.Replace(validRequest, `"schemaVersion":1`, `"schemaVersion":2`, 1), 422},
		{"wrong unit", strings.Replace(validRequest, `"timeUnit":"ms"`, `"timeUnit":"seconds"`, 1), 422},
		{"missing nested summary field", strings.Replace(validRequest, `,"fileBytes":0`, ``, 1), 422},
		{"missing point value", strings.Replace(validRequest, `,"value":0.2`, ``, 1), 422},
		{"nonfinite", strings.Replace(validRequest, `"value":0.2`, `"value":NaN`, 1), 400},
		{"unsorted", strings.Replace(validRequest, `"kickEvents":[1000,6000]`, `"kickEvents":[6000,1000]`, 1), 422},
		{"out of range feature", strings.Replace(validRequest, `"value":0.2`, `"value":1.2`, 1), 422},
		{"duration mismatch", strings.Replace(validRequest, `"durationMs":12000`, `"durationMs":11000`, 1), 422},
		{"too large", validRequest + strings.Repeat(" ", MaxBodyBytes), 413},
		{"unknown request key", strings.TrimSuffix(validRequest, "}") + `,"unknown":true}`, 400},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, _ := request(t, "fixture", nil, tc.body, 0)
			if status != tc.status {
				t.Fatalf("status=%d want=%d", status, tc.status)
			}
		})
	}
}

func TestProviderSecretIsNotReturned(t *testing.T) {
	status, body := request(t, "openai", &fakeGenerator{err: errors.New("provider rejected request: secret token=do-not-leak")}, validRequest, 0)
	if status != 502 || strings.Contains(body, "secret") || strings.Contains(body, "do-not-leak") {
		t.Fatalf("status=%d body=%s", status, body)
	}
}

func TestMapsProviderFailuresWithoutLeakingProviderMessages(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
		code string
	}{{"429", ErrRateLimited, 429, "openai_rate_limited"}, {"5xx", ErrProviderUpstream, 502, "openai_upstream_error"}, {"upstream 504", classifyProviderStatus(504, errors.New("private upstream response")), 502, "openai_upstream_error"}, {"timeout", context.DeadlineExceeded, 504, "openai_timeout"}}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, body := request(t, "openai", &fakeGenerator{err: tc.err}, validRequest, 0)
			if status != tc.want {
				t.Fatalf("status=%d body=%s", status, body)
			}
			if strings.Contains(body, "secret") || strings.Contains(body, tc.err.Error()) && tc.name != "timeout" {
				t.Fatalf("leaked error: %s", body)
			}
			if !strings.Contains(body, tc.code) {
				t.Fatalf("missing code: %s", body)
			}
		})
	}
}

func TestOpenAIContextTimeout(t *testing.T) {
	status, body := request(t, "openai", &fakeGenerator{wait: true}, validRequest, time.Millisecond)
	if status != 504 || !strings.Contains(body, "openai_timeout") {
		t.Fatalf("status=%d body=%s", status, body)
	}
}

func TestKeyMissingAndInvalidModelOutput(t *testing.T) {
	status, body := request(t, "openai", nil, validRequest, 0)
	if status != 503 || !strings.Contains(body, "openai_not_configured") {
		t.Fatalf("status=%d body=%s", status, body)
	}
	status, body = request(t, "openai", &fakeGenerator{output: []byte(`{"version":1}`)}, validRequest, 0)
	if status != 502 || !strings.Contains(body, "openai_invalid_output") {
		t.Fatalf("status=%d body=%s", status, body)
	}
}

func TestOpenAIResponseIncludesSanitizedEvaluationDiagnostics(t *testing.T) {
	status, body := request(t, "openai", &fakeGenerator{output: []byte(FixtureBlueprint)}, validRequest, 0)
	if status != http.StatusOK {
		t.Fatalf("status=%d body=%s", status, body)
	}
	var got struct {
		Model       string                `json:"model"`
		Diagnostics generationDiagnostics `json:"diagnostics"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	if got.Model != OpenAIModel || got.Diagnostics.Validation != "passed" || got.Diagnostics.LatencyMs < 0 {
		t.Fatalf("unexpected diagnostics: %+v", got)
	}
	if got.Diagnostics.Usage == nil || got.Diagnostics.Usage.TotalTokens != 579 {
		t.Fatalf("usage metadata missing: %+v", got.Diagnostics.Usage)
	}
}

func TestUpstreamInvalidBlueprintReferencesAreRejected(t *testing.T) {
	bad := strings.Replace(FixtureBlueprint, "region-stage", "missing-region", 1)
	status, body := request(t, "openai", &fakeGenerator{output: []byte(bad)}, validRequest, 0)
	if status != 502 || !strings.Contains(body, "openai_invalid_output") {
		t.Fatalf("status=%d body=%s", status, body)
	}
}

func TestGenerateRequiresJWTAndBudgetReservationBeforeProvider(t *testing.T) {
	for _, tc := range []struct {
		name       string
		token      string
		reserveErr error
		wantStatus int
	}{
		{name: "missing JWT", wantStatus: http.StatusUnauthorized},
		{name: "no entitlement", token: "Bearer test-user-token", reserveErr: aibudget.ErrNotEntitled, wantStatus: http.StatusForbidden},
		{name: "quota exceeded", token: "Bearer test-user-token", reserveErr: aibudget.ErrQuotaExceeded, wantStatus: http.StatusTooManyRequests},
		{name: "concurrency exceeded", token: "Bearer test-user-token", reserveErr: aibudget.ErrConcurrency, wantStatus: http.StatusTooManyRequests},
		{name: "global generation disabled", token: "Bearer test-user-token", reserveErr: aibudget.ErrDisabled, wantStatus: http.StatusServiceUnavailable},
		{name: "estimated budget exceeded", token: "Bearer test-user-token", reserveErr: aibudget.ErrBudgetExceeded, wantStatus: http.StatusServiceUnavailable},
		{name: "budget store unavailable", token: "Bearer test-user-token", reserveErr: aibudget.ErrUnavailable, wantStatus: http.StatusServiceUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gen := &fakeGenerator{output: []byte(FixtureBlueprint)}
			budget := &fakeBudget{reserveErr: tc.reserveErr}
			e := NewServer(Config{Mode: "openai", Model: OpenAIModel, Generator: gen, GenerateAuth: testAIAuth, Budget: budget})
			r := httptest.NewRequest(http.MethodPost, "/api/v1/blueprints/generate", strings.NewReader(validRequest))
			r.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
			r.Header.Set("Idempotency-Key", "test-idempotency-key-0002")
			if tc.token != "" {
				r.Header.Set(echo.HeaderAuthorization, tc.token)
			}
			w := httptest.NewRecorder()
			e.ServeHTTP(w, r)
			if w.Code != tc.wantStatus {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
			if gen.generateCalls != 0 {
				t.Fatalf("provider generate calls=%d", gen.generateCalls)
			}
			if tc.token == "" && budget.reservations != 0 {
				t.Fatalf("unauthenticated request reserved budget: %d", budget.reservations)
			}
		})
	}
}

func TestLocalCORSAllowsIdempotencyHeader(t *testing.T) {
	e := NewServer(Config{})
	r := httptest.NewRequest(http.MethodOptions, "/api/v1/blueprints/generate", nil)
	r.Header.Set("Origin", "http://127.0.0.1:5173")
	r.Header.Set("Access-Control-Request-Headers", "authorization,content-type,idempotency-key")
	w := httptest.NewRecorder()
	e.ServeHTTP(w, r)
	if w.Code != http.StatusNoContent || !strings.Contains(w.Header().Get("Access-Control-Allow-Headers"), "Idempotency-Key") {
		t.Fatalf("preflight status=%d allowed_headers=%q", w.Code, w.Header().Get("Access-Control-Allow-Headers"))
	}
}

func TestInputTokenLimitAndDuplicateKeyNeverGenerate(t *testing.T) {
	gen := &fakeGenerator{output: []byte(FixtureBlueprint), countTokens: 8001}
	budget := &fakeBudget{reservation: aibudget.Reservation{ID: "00000000-0000-4000-8000-000000000099", Model: OpenAIModel, MaxInputTokens: 8000, MaxOutputTokens: 4000}}
	e := NewServer(Config{Mode: "openai", Model: OpenAIModel, Generator: gen, GenerateAuth: testAIAuth, Budget: budget})
	r := httptest.NewRequest(http.MethodPost, "/api/v1/blueprints/generate", strings.NewReader(validRequest))
	r.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	r.Header.Set(echo.HeaderAuthorization, "Bearer test-user-token")
	r.Header.Set("Idempotency-Key", "test-idempotency-key-0003")
	w := httptest.NewRecorder()
	e.ServeHTTP(w, r)
	if w.Code != http.StatusUnprocessableEntity || gen.generateCalls != 0 {
		t.Fatalf("status=%d calls=%d", w.Code, gen.generateCalls)
	}
	if len(budget.settlements) != 1 || budget.settlements[0].State != "failed_known" {
		t.Fatalf("settlement=%+v", budget.settlements)
	}

	budget.reserveErr = aibudget.ErrDuplicate
	gen.countTokens = 321
	e = NewServer(Config{Mode: "openai", Model: OpenAIModel, Generator: gen, GenerateAuth: testAIAuth, Budget: budget})
	r = httptest.NewRequest(http.MethodPost, "/api/v1/blueprints/generate", strings.NewReader(validRequest))
	r.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	r.Header.Set(echo.HeaderAuthorization, "Bearer test-user-token")
	r.Header.Set("Idempotency-Key", "test-idempotency-key-0003")
	w = httptest.NewRecorder()
	e.ServeHTTP(w, r)
	if w.Code != http.StatusConflict || gen.generateCalls != 0 {
		t.Fatalf("duplicate status=%d calls=%d", w.Code, gen.generateCalls)
	}
}

func TestTokenCountFailureLeavesReservationUnknown(t *testing.T) {
	gen := &fakeGenerator{output: []byte(FixtureBlueprint), countErr: errors.New("safe count failure")}
	budget := &fakeBudget{}
	e := NewServer(Config{Mode: "openai", Model: OpenAIModel, Generator: gen, GenerateAuth: testAIAuth, Budget: budget})
	r := httptest.NewRequest(http.MethodPost, "/api/v1/blueprints/generate", strings.NewReader(validRequest))
	r.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	r.Header.Set(echo.HeaderAuthorization, "Bearer test-user-token")
	r.Header.Set("Idempotency-Key", "test-idempotency-key-0004")
	w := httptest.NewRecorder()
	e.ServeHTTP(w, r)
	if w.Code != http.StatusBadGateway || gen.generateCalls != 0 {
		t.Fatalf("status=%d calls=%d", w.Code, gen.generateCalls)
	}
	if len(budget.settlements) != 1 || budget.settlements[0].State != "usage_unknown" {
		t.Fatalf("settlement=%+v", budget.settlements)
	}
}

func TestPromptUsesCompactFeatureSummaryOnly(t *testing.T) {
	var req Request
	if err := json.Unmarshal([]byte(validRequest), &req); err != nil {
		t.Fatal(err)
	}
	summary, _, compact, err := ValidateInput(req)
	if err != nil {
		t.Fatal(err)
	}
	gen := &fakeGenerator{output: []byte(FixtureBlueprint)}
	e := NewServer(Config{Mode: "openai", Generator: gen, GenerateAuth: testAIAuth, Budget: &fakeBudget{}})
	r := httptest.NewRequest(http.MethodPost, "/api/v1/blueprints/generate", strings.NewReader(validRequest))
	r.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	r.Header.Set(echo.HeaderAuthorization, "Bearer test-user-token")
	r.Header.Set("Idempotency-Key", "test-idempotency-key-0001")
	w := httptest.NewRecorder()
	e.ServeHTTP(w, r)
	status := w.Code
	if status != 200 {
		t.Fatalf("status=%d", status)
	}
	if !strings.Contains(gen.prompt, `"bassSamples"`) || strings.Contains(gen.prompt, `bassEnvelope`) {
		t.Fatalf("prompt did not use compact summary: %s", gen.prompt)
	}
	if summary.DurationMs != compact.DurationMs {
		t.Fatal("compact duration mismatch")
	}
}

func TestProviderFailureClassification(t *testing.T) {
	cases := []struct {
		name, class string
		status      int
		err         error
	}{
		{"400", "openai_upstream_bad_request", 400, classifyProviderStatus(400, nil)},
		{"401", "openai_upstream_unauthorized", 401, classifyProviderStatus(401, nil)},
		{"403", "openai_upstream_forbidden", 403, classifyProviderStatus(403, nil)},
		{"404", "openai_upstream_not_found", 404, classifyProviderStatus(404, nil)},
		{"429", "openai_rate_limited", 429, classifyProviderStatus(429, nil)},
		{"503", "openai_upstream_5xx", 503, classifyProviderStatus(503, nil)},
		{"504", "openai_upstream_5xx", 504, classifyProviderStatus(504, nil)},
		{"timeout", "openai_timeout", 0, context.DeadlineExceeded},
		{"transport", "openai_transport_error", 0, &url.Error{Op: "Post", URL: "https://user:pass@example.invalid/?key=secret", Err: &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("private transport details")}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var failure *ProviderFailure
			if err := classifyProviderError(tc.err); !errors.As(err, &failure) {
				t.Fatalf("classification type=%T", err)
			} else if failure.Classification != tc.class || failure.UpstreamStatus != tc.status {
				t.Fatalf("failure=%+v want class=%s status=%d", failure, tc.class, tc.status)
			}
		})
	}
}

func TestOpenAIErrorLogIsStructuredAndSanitized(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	providerErr := &ProviderFailure{Classification: "openai_upstream_forbidden", UpstreamStatus: 403, cause: errors.New("Authorization: secret-key prompt-summary-output private status")}
	e := NewServer(Config{Mode: "openai", Model: OpenAIModel, Generator: &fakeGenerator{err: providerErr}, Logger: logger, GenerateAuth: testAIAuth, Budget: &fakeBudget{}})
	r := httptest.NewRequest(http.MethodPost, "/api/v1/blueprints/generate", strings.NewReader(validRequest))
	r.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	r.Header.Set(echo.HeaderAuthorization, "Bearer test-user-token")
	r.Header.Set("Idempotency-Key", "test-idempotency-key-0005")
	w := httptest.NewRecorder()
	e.ServeHTTP(w, r)
	if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "openai_upstream_error") {
		t.Fatalf("public response changed: %d %s", w.Code, w.Body.String())
	}
	logText := output.String()
	for _, safe := range []string{"openai_generation_failed", "openai_upstream_forbidden", "403", "latency_ms", OpenAIModel} {
		if !strings.Contains(logText, safe) {
			t.Errorf("missing safe diagnostic %q in %s", safe, logText)
		}
	}
	for _, secret := range []string{"Authorization", "secret-key", "prompt-summary-output", "private status", "private transport details", "user:pass", "?key="} {
		if strings.Contains(logText, secret) {
			t.Errorf("unsafe provider detail %q in log: %s", secret, logText)
		}
	}
}

func TestProviderDefaultDeadlineIs120Seconds(t *testing.T) {
	gen := &fakeGenerator{output: []byte(FixtureBlueprint)}
	status, body := request(t, "openai", gen, validRequest, 0)
	if status != http.StatusOK {
		t.Fatalf("status=%d body=%s", status, body)
	}
	remaining := time.Until(gen.deadline)
	if remaining < 119*time.Second || remaining > 120*time.Second {
		t.Fatalf("default generation deadline remaining=%s, want near 120s", remaining)
	}
	if DefaultGenerationTimeout != 120*time.Second {
		t.Fatalf("DefaultGenerationTimeout=%s", DefaultGenerationTimeout)
	}
}

func TestOpenAIStructuredOutputSchemaRestrictsEffectsAndUsesStrictSubset(t *testing.T) {
	schema := OpenAIEditorBlueprintJSONSchema()
	encoded, err := json.Marshal(schema)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, supported := range []string{"pulse-scale", "glow-brightness", "rotation-movement", "particles", "waveform-bars", "waveform-line", "waveform-peak-bars", "waveform-ring", "radial-bars", "wave-ring", "particle-burst", "particle-trail", "ripple", "shockwave", "oscilloscope-line", "orientation", "sampleCount", "amplitudeScale", "spikeSharpness", "opacityBoost", "coreBrightness", "lengthScale", "speedPxPerSec", "lifetimeMs", "trailMs", "glowIntensity", "maxRadius", "periodMs", "smoothing", "spacing"} {
		if !strings.Contains(text, supported) {
			t.Errorf("schema missing %s", supported)
		}
	}
	if strings.Contains(text, "javascript") || strings.Contains(text, "shader") {
		t.Fatal("schema contains executable code surface")
	}
	if !strings.Contains(text, "anyOf") || strings.Contains(text, "oneOf") {
		t.Fatal("schema must use nullable anyOf for OpenAI strict optional fields")
	}
}

func TestHealthCheck(t *testing.T) {
	e := NewServer(Config{})
	w := httptest.NewRecorder()
	e.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"ok"`) {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestWaveformPeaksValidateInTimelineV1(t *testing.T) {
	var request Request
	if err := json.Unmarshal([]byte(validRequest), &request); err != nil {
		t.Fatal(err)
	}
	var timeline map[string]any
	if err := json.Unmarshal(request.FeatureTimeline, &timeline); err != nil {
		t.Fatal(err)
	}
	peaks := map[string]any{"sampleIntervalMs": 20, "windowSamples": 882, "normalization": "signed-full-scale"}
	for _, source := range []string{"music", "drums", "bass", "vocals", "other"} {
		items := make([]map[string]float64, 600)
		for i := range items {
			items[i] = map[string]float64{"min": -0.2, "max": 0.4}
		}
		peaks[source] = items
	}
	timeline["waveformPeaks"] = peaks
	request.FeatureTimeline, _ = json.Marshal(timeline)
	if _, _, _, err := ValidateInput(request); err != nil {
		t.Fatalf("valid waveform peaks rejected: %v", err)
	}
	peaks["sampleIntervalMs"] = 10
	timeline["waveformPeaks"] = peaks
	request.FeatureTimeline, _ = json.Marshal(timeline)
	if _, _, _, err := ValidateInput(request); err == nil {
		t.Fatal("invalid waveform peak interval accepted")
	}
}

func TestTimelineBPMMetadataValidation(t *testing.T) {
	var request Request
	if err := json.Unmarshal([]byte(validRequest), &request); err != nil {
		t.Fatal(err)
	}
	var timeline map[string]any
	if err := json.Unmarshal(request.FeatureTimeline, &timeline); err != nil {
		t.Fatal(err)
	}
	bpm := 120.0
	timeline["bpm"], timeline["bpmSource"] = bpm, "kick-estimated"
	request.FeatureTimeline, _ = json.Marshal(timeline)
	if _, _, _, err := ValidateInput(request); err != nil {
		t.Fatalf("valid BPM metadata rejected: %v", err)
	}
	for _, values := range []struct {
		bpm    any
		source any
	}{{240.1, "kick-estimated"}, {120, "unknown"}, {100, "fallback"}, {nil, "fallback"}} {
		timeline["bpm"], timeline["bpmSource"] = values.bpm, values.source
		request.FeatureTimeline, _ = json.Marshal(timeline)
		if _, _, _, err := ValidateInput(request); err == nil {
			t.Errorf("invalid BPM metadata accepted: %#v", values)
		}
	}
}
