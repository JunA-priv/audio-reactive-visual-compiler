package authn

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync/atomic"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
	"github.com/labstack/echo/v5"
)

const (
	MaxBearerTokenBytes = 16 << 10
	roleAuthenticated   = "authenticated"
)

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var hostedIssuerPattern = regexp.MustCompile(`^https://[a-z0-9]{20}\.supabase\.co/auth/v1$`)

type claims struct {
	jwt.RegisteredClaims
	Role string `json:"role"`
}

type Principal struct{ Subject string }
type contextKey struct{}

type Validator struct {
	issuer string
	keys   keyfunc.Keyfunc
	cancel context.CancelFunc
	failed *atomic.Bool
}

// NewValidator preserves the local Supabase entry point for existing callers.
func NewValidator(parent context.Context, issuer string) (*Validator, error) {
	return NewValidatorForMode(parent, "local", issuer)
}

// NewValidatorForMode requires an explicit trust mode: loopback HTTP for local
// Supabase, or the canonical HTTPS project issuer for hosted Supabase.
func NewValidatorForMode(parent context.Context, mode, issuer string) (*Validator, error) {
	mode = strings.TrimSpace(strings.ToLower(mode))
	issuer = strings.TrimSpace(issuer)
	if err := validateIssuer(mode, issuer); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	refreshFailed := &atomic.Bool{}
	client := &http.Client{Timeout: 4 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	keys, err := keyfunc.NewDefaultOverrideCtx(ctx, []string{issuer + "/.well-known/jwks.json"}, keyfunc.Override{
		Client:           client,
		HTTPTimeout:      4 * time.Second,
		RefreshInterval:  10 * time.Minute,
		RateLimitWaitMax: time.Second,
		RefreshErrorHandlerFunc: func(_ string) func(context.Context, error) {
			return func(context.Context, error) {
				// Never log URLs, response bodies, or key material from JWKS failures.
				refreshFailed.Store(true)
			}
		},
	})
	if err != nil {
		cancel()
		return nil, errors.New("could not initialize Supabase JWKS")
	}
	return &Validator{issuer: issuer, keys: keys, cancel: cancel, failed: refreshFailed}, nil
}

func validateIssuer(mode, issuer string) error {
	parsed, err := url.Parse(issuer)
	if err != nil || parsed == nil || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.RawPath != "" || parsed.Opaque != "" || strings.HasSuffix(issuer, "/") {
		return errors.New("Supabase issuer configuration is invalid")
	}
	switch mode {
	case "local":
		expectedHost := parsed.Hostname()
		if strings.Contains(expectedHost, ":") {
			expectedHost = "[" + expectedHost + "]"
		}
		if parsed.Port() != "" {
			expectedHost += ":" + parsed.Port()
		}
		if parsed.Scheme != "http" || !isLoopback(parsed.Hostname()) || parsed.Path != "/auth/v1" || parsed.Host != expectedHost {
			return errors.New("local Supabase issuer configuration is invalid")
		}
	case "hosted":
		if !hostedIssuerPattern.MatchString(issuer) || parsed.Scheme != "https" || parsed.Port() != "" || parsed.Host != parsed.Hostname() || parsed.Path != "/auth/v1" {
			return errors.New("hosted Supabase issuer configuration is invalid")
		}
	default:
		return errors.New("authentication mode must be local or hosted")
	}
	return nil
}

func isLoopback(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func (v *Validator) Close() {
	if v != nil && v.cancel != nil {
		v.cancel()
	}
}

func (v *Validator) Validate(raw string) (Principal, error) {
	if v == nil || v.keys == nil || (v.failed != nil && v.failed.Load()) || len(raw) == 0 || len(raw) > MaxBearerTokenBytes {
		return Principal{}, errors.New("invalid bearer token")
	}
	var parsed claims
	token, err := jwt.ParseWithClaims(raw, &parsed, v.keys.Keyfunc,
		jwt.WithValidMethods([]string{jwt.SigningMethodES256.Alg()}),
		jwt.WithIssuer(v.issuer),
		jwt.WithAudience(roleAuthenticated),
		jwt.WithExpirationRequired(),
	)
	if err != nil || token == nil || !token.Valid || parsed.Role != roleAuthenticated || !uuidPattern.MatchString(parsed.Subject) {
		return Principal{}, errors.New("invalid bearer token")
	}
	return Principal{Subject: strings.ToLower(parsed.Subject)}, nil
}

func (v *Validator) Middleware(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		values := c.Request().Header.Values(echo.HeaderAuthorization)
		if len(values) != 1 {
			return c.JSON(http.StatusUnauthorized, map[string]any{"error": map[string]string{"code": "unauthorized", "message": "valid bearer token required"}})
		}
		parts := strings.Fields(values[0])
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			return c.JSON(http.StatusUnauthorized, map[string]any{"error": map[string]string{"code": "unauthorized", "message": "valid bearer token required"}})
		}
		principal, err := v.Validate(parts[1])
		if err != nil {
			return c.JSON(http.StatusUnauthorized, map[string]any{"error": map[string]string{"code": "unauthorized", "message": "valid bearer token required"}})
		}
		c.SetRequest(c.Request().WithContext(context.WithValue(c.Request().Context(), contextKey{}, principal)))
		return next(c)
	}
}

func PrincipalFrom(ctx context.Context) (Principal, bool) {
	value, ok := ctx.Value(contextKey{}).(Principal)
	return value, ok && value.Subject != ""
}

// ContextWithPrincipal is used by trusted middleware adapters and tests after
// token validation; HTTP callers cannot set this context value directly.
func ContextWithPrincipal(ctx context.Context, principal Principal) context.Context {
	return context.WithValue(ctx, contextKey{}, principal)
}
