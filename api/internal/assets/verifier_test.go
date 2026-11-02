package assets

import (
	"strings"
	"testing"
)

func TestVerifierDSNRequiresDedicatedRoleAndTLSForRemote(t *testing.T) {
	secret := "never-print-this-verifier-password"
	cases := []struct {
		name, dsn string
	}{
		{"wrong role", "postgres://postgres:" + secret + "@127.0.0.1:54322/postgres?sslmode=disable"},
		{"remote without full verification", "postgres://arvc_asset_verifier:" + secret + "@db.example.invalid:5432/postgres?sslmode=require"},
		{"remote without explicit ssl mode", "postgres://arvc_asset_verifier:" + secret + "@db.example.invalid:5432/postgres"},
		{"wrong database", "postgres://arvc_asset_verifier:" + secret + "@127.0.0.1:54322/other?sslmode=disable"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateVerifierDSN(tc.dsn)
			if err == nil {
				t.Fatal("invalid verifier DSN was accepted")
			}
			if strings.Contains(err.Error(), secret) {
				t.Fatal("verifier error exposed credential material")
			}
		})
	}
}

func TestVerifierDSNAcceptsLocalDedicatedRole(t *testing.T) {
	if err := validateVerifierDSN("postgres://arvc_asset_verifier:local-only@127.0.0.1:54322/postgres?sslmode=disable"); err != nil {
		t.Fatalf("valid local verifier DSN rejected: %v", err)
	}
}
