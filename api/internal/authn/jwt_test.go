package authn

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

func TestValidateES256ClaimsAndRejectsInvalidTokens(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	secondKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	issuer := "http://127.0.0.1:54321/auth/v1"
	setBytes, err := json.Marshal(map[string]any{"keys": []any{map[string]string{
		"kty": "EC", "crv": "P-256", "kid": "test-key", "use": "sig", "alg": "ES256",
		"x": base64.RawURLEncoding.EncodeToString(privateKey.X.Bytes()),
		"y": base64.RawURLEncoding.EncodeToString(privateKey.Y.Bytes()),
	}}})
	if err != nil {
		t.Fatal("test JWKS serialization failed")
	}
	keys, err := keyfunc.NewJWKSetJSON(setBytes)
	if err != nil {
		t.Fatal("test JWKS initialization failed")
	}
	validator := &Validator{issuer: issuer, keys: keys}
	validClaims := claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: issuer, Subject: "00000000-0000-4000-8000-000000000001",
			Audience: jwt.ClaimStrings{roleAuthenticated}, ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
		Role: roleAuthenticated,
	}
	validToken := signClaims(t, privateKey, validClaims, "test-key", jwt.SigningMethodES256)
	principal, err := validator.Validate(validToken)
	if err != nil || principal.Subject != validClaims.Subject {
		t.Fatalf("valid token rejected or wrong subject: valid=%v subject_match=%v", err == nil, principal.Subject == validClaims.Subject)
	}
	cases := []struct {
		name   string
		claims claims
		key    *ecdsa.PrivateKey
		alg    jwt.SigningMethod
	}{
		{"expired", mutateClaims(validClaims, func(c *claims) { c.ExpiresAt = jwt.NewNumericDate(time.Now().Add(-time.Minute)) }), privateKey, jwt.SigningMethodES256},
		{"wrong issuer", mutateClaims(validClaims, func(c *claims) { c.Issuer += "/wrong" }), privateKey, jwt.SigningMethodES256},
		{"wrong audience", mutateClaims(validClaims, func(c *claims) { c.Audience = jwt.ClaimStrings{"anon"} }), privateKey, jwt.SigningMethodES256},
		{"wrong role", mutateClaims(validClaims, func(c *claims) { c.Role = "service_role" }), privateKey, jwt.SigningMethodES256},
		{"invalid subject", mutateClaims(validClaims, func(c *claims) { c.Subject = "not-a-uuid" }), privateKey, jwt.SigningMethodES256},
		{"signature mismatch", validClaims, secondKey, jwt.SigningMethodES256},
		{"wrong algorithm", validClaims, privateKey, jwt.SigningMethodHS256},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			token := signClaims(t, tc.key, tc.claims, "test-key", tc.alg)
			if _, err := validator.Validate(token); err == nil {
				t.Fatal("invalid token accepted")
			}
		})
	}
	missingExpiration := validClaims
	missingExpiration.ExpiresAt = nil
	if _, err := validator.Validate(signClaims(t, privateKey, missingExpiration, "test-key", jwt.SigningMethodES256)); err == nil {
		t.Fatal("token without exp accepted")
	}
	if _, err := validator.Validate(validToken + "x"); err == nil {
		t.Fatal("tampered token accepted")
	}
	if _, err := validator.Validate(string(make([]byte, MaxBearerTokenBytes+1))); err == nil {
		t.Fatal("oversized token accepted")
	}
	if _, err := NewValidator(context.Background(), "https://hosted.example/auth/v1"); err == nil {
		t.Fatal("non-loopback issuer accepted")
	}
}

func mutateClaims(in claims, mutate func(*claims)) claims {
	copy := in
	copy.RegisteredClaims = in.RegisteredClaims
	mutate(&copy)
	return copy
}

func signClaims(t *testing.T, key *ecdsa.PrivateKey, value claims, kid string, method jwt.SigningMethod) string {
	t.Helper()
	token := jwt.NewWithClaims(method, value)
	token.Header["kid"] = kid
	var signingKey any = key
	if method == jwt.SigningMethodHS256 {
		signingKey = []byte("test-only-secret-that-is-never-logged")
	}
	signed, err := token.SignedString(signingKey)
	if err != nil {
		t.Fatal("test token signing failed")
	}
	return signed
}

func TestNewValidatorRequiresLocalIssuerPath(t *testing.T) {
	for _, issuer := range []string{"http://example.test/auth/v1", "http://127.0.0.1:54321/not-auth", "http://user:pass@127.0.0.1:54321/auth/v1"} {
		if _, err := NewValidator(context.Background(), issuer); err == nil {
			t.Fatal("unsafe issuer accepted")
		}
	}
}

func TestValidatorModeRejectsUntrustedHostedIssuersBeforeFetch(t *testing.T) {
	for _, issuer := range []string{
		"https://attacker.example/auth/v1", "http://abcdefghijklmnopqrst.supabase.co/auth/v1",
		"https://abcdefghijklmnopqrst.supabase.co:443/auth/v1", "https://abcdefghijklmnopqrst.supabase.co.evil.test/auth/v1",
		"https://user@abcdefghijklmnopqrst.supabase.co/auth/v1", "https://abcdefghijklmnopqrst.supabase.co/auth/v1/",
		"https://abcdefghijklmnopqrst.supabase.co/auth/v1?x=1", "https://abcdefghijklmnopqrst.supabase.co/auth/v1#x",
	} {
		if _, err := NewValidatorForMode(context.Background(), "hosted", issuer); err == nil {
			t.Fatalf("unsafe hosted issuer accepted: %q", issuer)
		}
	}
	for _, mode := range []string{"", "HOSTED ", "remote"} {
		if _, err := NewValidatorForMode(context.Background(), mode, "http://127.0.0.1:54321/auth/v1"); err == nil {
			t.Fatalf("invalid mode accepted: %q", mode)
		}
	}
	if _, err := NewValidatorForMode(context.Background(), "local", "https://abcdefghijklmnopqrst.supabase.co/auth/v1"); err == nil {
		t.Fatal("hosted issuer accepted in local mode")
	}
	for _, issuer := range []string{"http://localhost:54321/auth/v1", "http://127.0.0.1:65432/auth/v1", "http://[::1]:9000/auth/v1"} {
		if err := validateIssuer("local", issuer); err != nil {
			t.Fatalf("previously supported local issuer rejected (%s): %v", issuer, err)
		}
	}
	if err := validateIssuer("hosted", "https://abcdefghijklmnopqrst.supabase.co/auth/v1"); err != nil {
		t.Fatalf("canonical hosted issuer rejected: %v", err)
	}
}

func TestHostedIssuerClaimsUseExistingES256Policy(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal("key generation failed")
	}
	issuer := "https://abcdefghijklmnopqrst.supabase.co/auth/v1"
	setBytes, err := json.Marshal(map[string]any{"keys": []any{map[string]string{"kty": "EC", "crv": "P-256", "kid": "test-key", "use": "sig", "alg": "ES256", "x": base64.RawURLEncoding.EncodeToString(privateKey.X.Bytes()), "y": base64.RawURLEncoding.EncodeToString(privateKey.Y.Bytes())}}})
	if err != nil {
		t.Fatal("test JWKS serialization failed")
	}
	keys, err := keyfunc.NewJWKSetJSON(setBytes)
	if err != nil {
		t.Fatal("test JWKS initialization failed")
	}
	validator := &Validator{issuer: issuer, keys: keys}
	claims := claims{RegisteredClaims: jwt.RegisteredClaims{Issuer: issuer, Subject: "00000000-0000-4000-8000-000000000001", Audience: jwt.ClaimStrings{roleAuthenticated}, ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))}, Role: roleAuthenticated}
	token := signClaims(t, privateKey, claims, "test-key", jwt.SigningMethodES256)
	if _, err := validator.Validate(token); err != nil {
		t.Fatalf("valid hosted-issuer token rejected: %v", err)
	}
	validator.failed = &atomic.Bool{}
	validator.failed.Store(true)
	if _, err := validator.Validate(token); err == nil {
		t.Fatal("JWT accepted after JWKS refresh failure")
	}
}
