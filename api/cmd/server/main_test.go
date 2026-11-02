package main

import "testing"

func TestResolveLocalFixtureDeveloperID(t *testing.T) {
	const id = "18a85084-5e93-401a-a59e-1e4c45859ddf"
	tests := []struct {
		name      string
		enabled   bool
		aiEnabled bool
		mode      string
		userID    string
		wantID    string
		wantError bool
	}{
		{name: "disabled ignores configured UUID", userID: id},
		{name: "fixture mode enabled", enabled: true, aiEnabled: true, mode: "fixture", userID: id, wantID: id},
		{name: "OpenAI mode rejected", enabled: true, aiEnabled: true, mode: "openai", userID: id, wantError: true},
		{name: "AI auth disabled rejected", enabled: true, mode: "fixture", userID: id, wantError: true},
		{name: "invalid subject rejected", enabled: true, aiEnabled: true, mode: "fixture", userID: "dev-local@example.test", wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := resolveLocalFixtureDeveloperID(test.enabled, test.aiEnabled, test.mode, test.userID)
			if (err != nil) != test.wantError || got != test.wantID {
				t.Fatalf("result mismatch: got id configured=%t, err=%t", got != "", err != nil)
			}
		})
	}
}
