// Package supabasepg validates the dedicated audio-analysis connection target.
package supabasepg

import (
	"errors"
	"net/url"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

const audioAnalysisRole = "arvc_audio_analysis"
const aiBudgetRole = "arvc_ai_budget"

var projectRefPattern = regexp.MustCompile(`^[a-z0-9]{20}$`)
var sharedPoolerHostPattern = regexp.MustCompile(`^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$`)

// ProjectRefFromURL extracts a Hosted project's reference from its canonical
// API URL. Local URLs deliberately return an empty ref.
func ProjectRefFromURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u == nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" {
		return "", errors.New("Supabase project URL is invalid")
	}
	if u.Scheme == "http" && isLoopback(u.Hostname()) && u.Port() != "" {
		return "", nil
	}
	if u.Scheme != "https" || u.Port() != "" || u.Host != u.Hostname() || !strings.HasSuffix(u.Hostname(), ".supabase.co") {
		return "", errors.New("Hosted Supabase project URL is invalid")
	}
	ref := strings.TrimSuffix(u.Hostname(), ".supabase.co")
	if !projectRefPattern.MatchString(ref) {
		return "", errors.New("Hosted Supabase project reference is invalid")
	}
	return ref, nil
}

// ParseAudioAnalysisConfig permits local loopback direct connections, Hosted
// direct connections for the exact project, or that project's IPv4 session
// pooler username. It never relaxes TLS verification for remote targets.
func ParseAudioAnalysisConfig(dsn, expectedProjectRef string) (*pgxpool.Config, error) {
	return ParseDedicatedRoleConfig(dsn, expectedProjectRef, audioAnalysisRole)
}

// ParseAIBudgetConfig validates the separate AI quota role with the same
// exact Hosted project and pooler restrictions as the audio-analysis role.
func ParseAIBudgetConfig(dsn, expectedProjectRef string) (*pgxpool.Config, error) {
	return ParseDedicatedRoleConfig(dsn, expectedProjectRef, aiBudgetRole)
}

func ParseDedicatedRoleConfig(dsn, expectedProjectRef, expectedRole string) (*pgxpool.Config, error) {
	if strings.TrimSpace(dsn) == "" {
		return nil, errors.New("audio-analysis database DSN is empty")
	}
	cfg, err := pgxpool.ParseConfig(strings.TrimSpace(dsn))
	if err != nil || cfg.ConnConfig.Database != "postgres" {
		return nil, errors.New("audio-analysis database DSN is invalid")
	}
	host := strings.Trim(cfg.ConnConfig.Host, "[]")
	if isLoopback(host) {
		if expectedProjectRef != "" || cfg.ConnConfig.User != expectedRole {
			return nil, errors.New("local audio-analysis database target is invalid")
		}
		return cfg, nil
	}
	if !projectRefPattern.MatchString(expectedProjectRef) {
		return nil, errors.New("Hosted audio-analysis project reference is required")
	}
	if cfg.ConnConfig.TLSConfig == nil || cfg.ConnConfig.TLSConfig.InsecureSkipVerify || cfg.ConnConfig.TLSConfig.ServerName != cfg.ConnConfig.Host {
		return nil, errors.New("Hosted audio-analysis database TLS must verify the hostname")
	}
	if cfg.ConnConfig.Port != 5432 {
		return nil, errors.New("Hosted audio-analysis database must use port 5432")
	}
	directHost := "db." + expectedProjectRef + ".supabase.co"
	if strings.EqualFold(host, directHost) && cfg.ConnConfig.User == expectedRole {
		return cfg, nil
	}
	poolerUser := expectedRole + "." + expectedProjectRef
	if sharedPoolerHostPattern.MatchString(strings.ToLower(host)) && cfg.ConnConfig.User == poolerUser {
		return cfg, nil
	}
	return nil, errors.New("Hosted audio-analysis database role or project target is invalid")
}

// MaxAudioAnalysisPoolConns keeps each Hosted role pool at one connection so
// bounded Cloud Run instances stay within Free shared-pooler capacity.
func MaxAudioAnalysisPoolConns(hosted bool) int {
	if hosted {
		return 1
	}
	return 4
}

func isLoopback(host string) bool {
	return host == "127.0.0.1" || host == "localhost" || host == "::1"
}
