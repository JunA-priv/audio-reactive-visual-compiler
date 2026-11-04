package audiobudget

import (
	"os"
	"strings"
	"testing"
)

func TestMigrationAndVerificationSQLKeepAudioQuotaPrivateAndDefaultDenied(t *testing.T) {
	migration, err := os.ReadFile("../../../supabase/migrations/20261104000100_step7k42_audio_analysis_quota.sql")
	if err != nil {
		t.Fatal("Audio Analyze migration is missing")
	}
	verification, err := os.ReadFile("../../../supabase/verification/step7k42-audio-analysis-privilege-invariants.sql")
	if err != nil {
		t.Fatal("Audio Analyze privilege verification SQL is missing")
	}
	sql := string(migration)
	for _, required := range []string{
		"CREATE ROLE arvc_audio_analysis NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS",
		"enabled boolean NOT NULL DEFAULT false", "service_daily_limit integer NOT NULL DEFAULT 0", "daily_limit integer NOT NULL DEFAULT 0",
		"FOR UPDATE", "FOR SHARE", "lease_expired", "interval '90 days'", "date_trunc('day'", "date_trunc('month'",
		"request_window_seconds", "concurrent_limit", "SET state='expired_charged'", "IF u.state=p_state THEN RETURN true",
		"GRANT EXECUTE ON FUNCTION arvc_internal.audio_analysis_reserve(uuid) TO arvc_audio_analysis",
		"GRANT EXECUTE ON FUNCTION arvc_internal.audio_analysis_start(uuid) TO arvc_audio_analysis",
		"GRANT EXECUTE ON FUNCTION arvc_internal.audio_analysis_release(uuid) TO arvc_audio_analysis",
		"GRANT EXECUTE ON FUNCTION arvc_internal.audio_analysis_settle(uuid,text,text) TO arvc_audio_analysis",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration is missing invariant %q", required)
		}
	}
	if got := strings.Count(sql, "SECURITY DEFINER SET search_path = ''"); got != 4 {
		t.Errorf("SECURITY DEFINER fixed-path RPC count=%d, want 4", got)
	}
	for _, forbidden := range []string{"ai_generation_usage", "audio_bytes", "filename text", "jwt text"} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("audio quota migration contains unrelated/sensitive field %q", forbidden)
		}
	}
	for _, required := range []string{"audio_role_restricted", "audio_role_has_no_membership", "audio_role_has_only_four_private_rpcs", "application_roles_cannot_execute_audio_rpcs", "private_rpcs_security_definer_and_fixed_search_path", "audio_tables_force_rls_and_hide_api_roles", "control_defaults_fail_closed"} {
		if !strings.Contains(string(verification), required) {
			t.Errorf("verification SQL missing check %q", required)
		}
	}
}
