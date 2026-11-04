package audioanalysis

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

type googleTaskClaims struct {
	jwt.RegisteredClaims
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
}
type GoogleOIDCAuthenticator struct {
	keys            keyfunc.Keyfunc
	audience, email string
	cancel          context.CancelFunc
}

func NewGoogleOIDCAuthenticator(parent context.Context, audience, serviceAccount string) (*GoogleOIDCAuthenticator, error) {
	audience = strings.TrimSpace(audience)
	serviceAccount = strings.TrimSpace(serviceAccount)
	if audience == "" || !strings.HasPrefix(audience, "https://") || serviceAccount == "" || !strings.Contains(serviceAccount, "@") {
		return nil, errors.New("worker OIDC configuration invalid")
	}
	ctx, cancel := context.WithCancel(parent)
	keys, err := keyfunc.NewDefaultOverrideCtx(ctx, []string{"https://www.googleapis.com/oauth2/v3/certs"}, keyfunc.Override{HTTPTimeout: 4 * time.Second, RefreshInterval: 10 * time.Minute})
	if err != nil {
		cancel()
		return nil, errors.New("Google OIDC keys unavailable")
	}
	return &GoogleOIDCAuthenticator{keys: keys, audience: audience, email: serviceAccount, cancel: cancel}, nil
}
func (a *GoogleOIDCAuthenticator) Close() {
	if a != nil && a.cancel != nil {
		a.cancel()
	}
}
func (a *GoogleOIDCAuthenticator) Authenticate(r *http.Request) bool {
	if a == nil || a.keys == nil || r == nil {
		return false
	}
	values := r.Header.Values("Authorization")
	if len(values) != 1 {
		return false
	}
	fields := strings.Fields(values[0])
	if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
		return false
	}
	var claims googleTaskClaims
	token, err := jwt.ParseWithClaims(fields[1], &claims, a.keys.Keyfunc, jwt.WithValidMethods([]string{jwt.SigningMethodRS256.Alg()}), jwt.WithIssuer("https://accounts.google.com"), jwt.WithAudience(a.audience), jwt.WithExpirationRequired())
	return err == nil && token != nil && token.Valid && claims.EmailVerified && strings.EqualFold(claims.Email, a.email)
}
