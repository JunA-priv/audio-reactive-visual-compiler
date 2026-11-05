package main

import "testing"

func TestResolveListenAddress(t *testing.T) {
	tests := []struct {
		name       string
		port       string
		configured string
		want       string
		wantError  bool
	}{
		{name: "local default", want: "127.0.0.1:8080"},
		{name: "local configured", configured: "localhost:9090", want: "localhost:9090"},
		{name: "hosted port overrides local address", port: "8081", configured: "127.0.0.1:1", want: "0.0.0.0:8081"},
		{name: "hosted rejects invalid port", port: "70000", wantError: true},
		{name: "hosted rejects nonnumeric port", port: "http", wantError: true},
		{name: "local rejects public bind", configured: "0.0.0.0:8080", wantError: true},
		{name: "local rejects malformed address", configured: "8080", wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := resolveListenAddress(test.port, test.configured)
			if (err != nil) != test.wantError {
				t.Fatalf("resolveListenAddress() error = %v, wantError %v", err, test.wantError)
			}
			if err == nil && got != test.want {
				t.Fatalf("resolveListenAddress() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestResolveCORSOrigins(t *testing.T) {
	got, err := resolveCORSOrigins("https://app.example.com, https://editor.example.com")
	if err != nil || len(got) != 2 || got[0] != "https://app.example.com" {
		t.Fatalf("valid allowlist rejected: %v", err)
	}
	for _, raw := range []string{"*", "https://app.example.com/path", "http://app.example.com", "https://a.example.com,https://a.example.com", "https://user@app.example.com"} {
		if _, err := resolveCORSOrigins(raw); err == nil {
			t.Fatalf("invalid allowlist accepted: %q", raw)
		}
	}
}

func TestResolveAnalysisThreads(t *testing.T) {
	for _, test := range []struct {
		name      string
		value     string
		want      int
		wantError bool
	}{
		{name: "local default", want: 4},
		{name: "hosted two vCPU", value: "2", want: 2},
		{name: "invalid value", value: "many", wantError: true},
		{name: "out of range", value: "17", wantError: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := resolveAnalysisThreads(test.value)
			if (err != nil) != test.wantError {
				t.Fatalf("resolveAnalysisThreads() error = %v, wantError %v", err, test.wantError)
			}
			if err == nil && got != test.want {
				t.Fatalf("resolveAnalysisThreads() = %d, want %d", got, test.want)
			}
		})
	}
}

func TestLocalFixtureExemptionIsLocalOnly(t *testing.T) {
	const user = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	if got, err := resolveLocalFixtureDeveloperID(true, true, "fixture", "local", user); err != nil || got != user {
		t.Fatalf("local fixture exemption rejected: got=%q err=%v", got, err)
	}
	if _, err := resolveLocalFixtureDeveloperID(true, true, "fixture", "hosted", user); err == nil {
		t.Fatal("Hosted fixture exemption was accepted")
	}
}
