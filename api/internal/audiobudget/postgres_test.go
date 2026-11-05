package audiobudget

import (
	"errors"
	"testing"

	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/supabasepg"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestParseConfigRequiresDedicatedRoleAndVerifiedRemoteTLS(t *testing.T) {
	for _, tc := range []struct {
		name, dsn, projectRef string
		wantErr               bool
	}{
		{"local role", "postgres://arvc_audio_analysis@127.0.0.1:54322/postgres?sslmode=disable", "", false},
		{"IPv4 session pooler", "postgres://arvc_audio_analysis.abcdefghijklmnopqrst@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full", "abcdefghijklmnopqrst", false},
		{"remote TLS without hostname check", "postgres://arvc_audio_analysis.abcdefghijklmnopqrst@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require", "abcdefghijklmnopqrst", true},
		{"remote plaintext", "postgres://arvc_audio_analysis.abcdefghijklmnopqrst@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=disable", "abcdefghijklmnopqrst", true},
		{"wrong role", "postgres://postgres@127.0.0.1/postgres?sslmode=disable", "", true},
		{"invalid DSN", "not a DSN", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := supabasepg.ParseAudioAnalysisConfig(tc.dsn, tc.projectRef)
			if (err != nil) != tc.wantErr {
				t.Fatalf("parseConfig error=%v wantErr=%v", err, tc.wantErr)
			}
		})
	}
}

func TestInitializationErrorKeepsOnlySafeDiagnostics(t *testing.T) {
	secretMessage := "password authentication failed for user; never expose this detail"
	cause := &pgconn.PgError{Code: "28P01", Message: secretMessage}
	err := initializationFailure("ping", cause)
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("initialization error must preserve ErrUnavailable: %v", err)
	}
	if err.Stage != "ping" || err.Class != "postgres" || err.SQLState != "28P01" {
		t.Fatalf("safe diagnostics = (%q, %q, %q)", err.Stage, err.Class, err.SQLState)
	}
	if err.Error() != ErrUnavailable.Error() {
		t.Fatalf("error string exposed driver detail: %q", err.Error())
	}
}

func TestResultMappingFailsClosed(t *testing.T) {
	cases := map[string]error{"disabled": ErrDisabled, "not_entitled": ErrNotEntitled, "quota_exceeded": ErrQuotaExceeded, "concurrency_exceeded": ErrConcurrency, "rate_limited": ErrRateLimited, "expired": ErrExpired, "invalid": ErrInvalid, "unexpected": ErrUnavailable}
	for result, want := range cases {
		if got := mapResult(result); !errors.Is(got, want) {
			t.Errorf("mapResult(%q)=%v want %v", result, got, want)
		}
	}
}

func TestVerifyEnvironmentRejectsInvalidModeAndMissingStore(t *testing.T) {
	if err := (*Postgres)(nil).VerifyEnvironment(t.Context(), "hosted"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("nil store VerifyEnvironment error=%v", err)
	}
	if err := (*Postgres)(nil).VerifyEnvironment(t.Context(), "production"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("invalid environment VerifyEnvironment error=%v", err)
	}
}
