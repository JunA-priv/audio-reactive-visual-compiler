package supabasepg

import "testing"

const testProjectRef = "abcdefghijklmnopqrst"

func TestProjectRefFromURL(t *testing.T) {
	for _, tc := range []struct {
		name, raw, want string
		wantErr         bool
	}{
		{"hosted", "https://" + testProjectRef + ".supabase.co", testProjectRef, false},
		{"local", "http://127.0.0.1:54321", "", false},
		{"bad ref", "https://short.supabase.co", "", true},
		{"remote http", "http://" + testProjectRef + ".supabase.co", "", true},
		{"custom host", "https://example.com", "", true},
		{"path", "https://" + testProjectRef + ".supabase.co/path", "", true},
		{"credentials", "https://user@" + testProjectRef + ".supabase.co", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ProjectRefFromURL(tc.raw)
			if (err != nil) != tc.wantErr || got != tc.want {
				t.Fatalf("ProjectRefFromURL() = (%q, %v), want (%q, err=%v)", got, err, tc.want, tc.wantErr)
			}
		})
	}
}

func TestParseAudioAnalysisConfig(t *testing.T) {
	tests := []struct {
		name, dsn, ref string
		wantErr        bool
	}{
		{"local direct", "postgres://arvc_audio_analysis@127.0.0.1:54322/postgres?sslmode=disable", "", false},
		{"hosted direct", "postgres://arvc_audio_analysis@db." + testProjectRef + ".supabase.co:5432/postgres?sslmode=verify-full", testProjectRef, false},
		{"IPv4 session pooler", "postgres://arvc_audio_analysis." + testProjectRef + "@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full", testProjectRef, false},
		{"unrecognized pooler host", "postgres://arvc_audio_analysis." + testProjectRef + "@other-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full", testProjectRef, true},
		{"wrong role", "postgres://postgres." + testProjectRef + "@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full", testProjectRef, true},
		{"wrong project ref", "postgres://arvc_audio_analysis.aaaaaaaaaaaaaaaaaaaa@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full", testProjectRef, true},
		{"pooler role missing ref", "postgres://arvc_audio_analysis@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full", testProjectRef, true},
		{"pooler host with direct role", "postgres://arvc_audio_analysis@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full", testProjectRef, true},
		{"direct host wrong ref", "postgres://arvc_audio_analysis@db.aaaaaaaaaaaaaaaaaaaa.supabase.co:5432/postgres?sslmode=verify-full", testProjectRef, true},
		{"transaction pooler", "postgres://arvc_audio_analysis." + testProjectRef + "@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres?sslmode=verify-full", testProjectRef, true},
		{"unverified TLS", "postgres://arvc_audio_analysis." + testProjectRef + "@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require", testProjectRef, true},
		{"other database", "postgres://arvc_audio_analysis." + testProjectRef + "@aws-1-ap-northeast-1.pooler.supabase.com:5432/other?sslmode=verify-full", testProjectRef, true},
		{"missing expected ref", "postgres://arvc_audio_analysis." + testProjectRef + "@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full", "", true},
		{"invalid DSN", "not a DSN", testProjectRef, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseAudioAnalysisConfig(tc.dsn, tc.ref)
			if (err != nil) != tc.wantErr {
				t.Fatalf("ParseAudioAnalysisConfig() error=%v wantErr=%v", err, tc.wantErr)
			}
		})
	}
}

func TestPoolSizing(t *testing.T) {
	if MaxAudioAnalysisPoolConns(true) != 1 || MaxAudioAnalysisPoolConns(false) != 4 {
		t.Fatal("Hosted and local pool limits changed unexpectedly")
	}
}

func TestAIBudgetRoleIsExplicitlyAllowlisted(t *testing.T) {
	dsn := "postgres://arvc_ai_budget." + testProjectRef + "@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full"
	if _, err := ParseAIBudgetConfig(dsn, testProjectRef); err != nil {
		t.Fatalf("dedicated AI role rejected: %v", err)
	}
	if _, err := ParseAudioAnalysisConfig(dsn, testProjectRef); err == nil {
		t.Fatal("AI role accepted as audio-analysis role")
	}
	if _, err := ParseDedicatedRoleConfig(dsn, testProjectRef, "postgres"); err == nil {
		t.Fatal("arbitrary role accepted")
	}
}
