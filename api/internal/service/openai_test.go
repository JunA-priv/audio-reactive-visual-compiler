package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/blueprint"
)

func TestOpenAISchemaEnumeratesAllBindingSources(t *testing.T) {
	schema := OpenAIEditorBlueprintJSONSchema()
	props := schema["properties"].(map[string]any)
	bindings := props["bindings"].(map[string]any)
	items := bindings["items"].(map[string]any)
	bindingProps := items["properties"].(map[string]any)
	source := bindingProps["source"].(map[string]any)
	enum := source["enum"].([]string)
	want := []string{"bass.envelope", "kick.events", "snare.events", "drums.energy", "vocals.envelope", "other.envelope", "music.energy"}
	if len(enum) != len(want) {
		t.Fatalf("source enum has %d values, want %d", len(enum), len(want))
	}
	for i, value := range want {
		if enum[i] != value {
			t.Fatalf("source enum[%d]=%q, want %q", i, enum[i], value)
		}
	}
}

func TestOpenAISchemaSupportsGlobalGradientAndColorMode(t *testing.T) {
	schema := OpenAIEditorBlueprintJSONSchema()
	props := schema["properties"].(map[string]any)
	if _, ok := props["globalGradient"]; !ok {
		t.Fatal("globalGradient missing from schema")
	}
	effects := props["effects"].(map[string]any)
	items := effects["items"].(map[string]any)
	effectProps := items["properties"].(map[string]any)
	encodedKind, err := json.Marshal(effectProps["kind"])
	if err != nil || !strings.Contains(string(encodedKind), `"spectrum-bars"`) || !strings.Contains(string(encodedKind), `"spectrum-line"`) || !strings.Contains(string(encodedKind), `"ink-diffusion"`) || !strings.Contains(string(encodedKind), `"ink-flow"`) || !strings.Contains(string(encodedKind), `"color-mixing"`) {
		t.Fatalf("Spectrum Effect kinds missing from schema: %s (%v)", encodedKind, err)
	}
	for _, key := range []string{"segmented", "segmentsPerBar", "attackMs", "releaseMs"} {
		if _, ok := effectProps[key]; !ok {
			t.Errorf("%s missing from Spectrum schema", key)
		}
	}
	if _, ok := effectProps["colorMode"]; !ok {
		t.Fatal("colorMode missing from schema")
	}
	for _, key := range []string{"rotationMode", "beatsPerRevolution", "rotationDirection", "initialAngleDeg", "opacity", "visibilityMode", "audioReactive", "layerCount", "layerRadiusStep", "layerAngleOffsetDeg", "layerAmplitudeDecay"} {
		if _, ok := effectProps[key]; !ok {
			t.Errorf("%s missing from OpenAI Effect schema", key)
		}
	}
	for _, key := range []string{"spread", "speedInfluence", "audioInfluence", "swirl", "baselineOpacity", "customPalette"} {
		if _, ok := effectProps[key]; !ok {
			t.Errorf("%s missing from Particle schema", key)
		}
	}
	countProp := effectProps["count"].(map[string]any)
	countRange := countProp["anyOf"].([]any)[0].(map[string]any)
	if countRange["maximum"] != float64(64) && countRange["maximum"] != 64 {
		t.Errorf("particle count schema maximum=%v, want 64", countRange["maximum"])
	}
	nullableLayerCount := effectProps["layerCount"].(map[string]any)
	layerCount := nullableLayerCount["anyOf"].([]any)[0].(map[string]any)
	if layerCount["maximum"] != 10 {
		t.Errorf("layerCount max=%v, want 10", layerCount["maximum"])
	}
	nullableVisibility := effectProps["visibilityMode"].(map[string]any)
	visibility := nullableVisibility["anyOf"].([]any)[0].(map[string]any)
	if got := visibility["enum"].([]string); len(got) != 2 || got[0] != "triggered" || got[1] != "always" {
		t.Errorf("unexpected visibility modes: %#v", got)
	}
	encoded, err := json.Marshal(effectProps["colorMode"])
	if err != nil || !strings.Contains(string(encoded), `"global-gradient"`) || !strings.Contains(string(encoded), `"custom"`) {
		t.Fatalf("unexpected colorMode schema: %s (%v)", encoded, err)
	}
}

func TestOpenAIInkDiffusionSchemaAndDefaults(t *testing.T) {
	schema := OpenAIEditorBlueprintJSONSchema()
	effects := schema["properties"].(map[string]any)["effects"].(map[string]any)
	props := effects["items"].(map[string]any)["properties"].(map[string]any)
	for _, key := range []string{"diffusionSpeed", "flowStrength", "turbulence", "inkDensity", "cloudScale", "responseTime"} {
		if _, ok := props[key]; !ok {
			t.Errorf("%s missing from Ink schema", key)
		}
	}
	raw := []byte(`{"version":1,"width":640,"height":360,"seed":1,"background":{"kind":"solid","color":"#10131c"},"regions":[{"id":"r","name":"r","geometry":{"kind":"rect","x":0,"y":0,"width":1,"height":1}}],"effects":[{"id":"ink","kind":"ink-diffusion","regionId":"r","color":"#8855cc"}],"bindings":[{"id":"b","effectId":"ink","source":"music.energy","strength":1,"threshold":0,"attackMs":0,"releaseMs":100}]}`)
	normalized, err := normalizeStrictOutput(raw)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeBlueprintForTest(normalized); err != nil {
		t.Fatalf("normalized Ink Blueprint rejected: %v", err)
	}
	for _, expected := range []string{`"diffusionSpeed":0.25`, `"flowStrength":0.4`, `"turbulence":0.3`, `"inkDensity":0.65`, `"cloudScale":0.5`, `"responseTime":3`} {
		if !strings.Contains(string(normalized), expected) {
			t.Errorf("Ink normalization missing %s", expected)
		}
	}
}

func TestOpenAINormalizesInkFamilyDefaults(t *testing.T) {
	for _, test := range []struct {
		kind     string
		defaults []string
	}{
		{"ink-flow", []string{`"diffusionSpeed":0.45`, `"flowStrength":0.95`, `"turbulence":0.65`, `"inkDensity":0.5`, `"cloudScale":0.65`, `"responseTime":3`}},
		{"color-mixing", []string{`"diffusionSpeed":0.25`, `"flowStrength":0.5`, `"turbulence":0.55`, `"inkDensity":0.65`, `"cloudScale":0.9`, `"responseTime":4`, `"customPalette":["#22d3ee","#8b5cf6","#ec4899"]`}},
	} {
		raw := []byte(`{"version":1,"width":640,"height":360,"seed":1,"background":{"kind":"solid","color":"#10131c"},"regions":[{"id":"r","name":"r","geometry":{"kind":"rect","x":0,"y":0,"width":1,"height":1}}],"effects":[{"id":"ink","kind":"` + test.kind + `","regionId":"r","color":"#8855cc"}],"bindings":[{"id":"b","effectId":"ink","source":"music.energy","strength":1,"threshold":0,"attackMs":0,"releaseMs":100}]}`)
		normalized, err := normalizeStrictOutput(raw)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := decodeBlueprintForTest(normalized); err != nil {
			t.Fatalf("normalized %s rejected: %v", test.kind, err)
		}
		for _, want := range test.defaults {
			if !strings.Contains(string(normalized), want) {
				t.Errorf("%s missing default %s", test.kind, want)
			}
		}
	}
}

func TestOpenAINormalizesEnhancedParticleDefaults(t *testing.T) {
	raw := []byte(`{"version":1,"width":640,"height":360,"seed":1,"background":{"kind":"solid","color":"#10131c"},"regions":[{"id":"r","name":"r","geometry":{"kind":"rect","x":0,"y":0,"width":1,"height":1}}],"effects":[{"id":"p","kind":"particles","regionId":"r","color":"#ffffff","count":64,"sizePx":4,"cycleMs":2200,"visibilityMode":"always","audioReactive":false},{"id":"b","kind":"particle-burst","regionId":"r","color":"#ffffff","originX":0.5,"originY":0.5,"directionDeg":0,"spreadDeg":90,"speedPxPerSec":420,"lifetimeMs":1500,"count":32,"sizePx":7}],"bindings":[{"id":"bp","effectId":"p","source":"bass.envelope","strength":1,"threshold":0,"attackMs":0,"releaseMs":100},{"id":"bb","effectId":"b","source":"kick.events","strength":1,"threshold":0,"attackMs":0,"releaseMs":100}]}`)
	normalized, err := normalizeStrictOutput(raw)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeBlueprintForTest(normalized); err != nil {
		t.Fatalf("normalized particle Blueprint rejected: %v", err)
	}
	var normalizedBlueprint struct {
		Effects []struct {
			Kind           string `json:"kind"`
			VisibilityMode string `json:"visibilityMode"`
			AudioReactive  bool   `json:"audioReactive"`
		} `json:"effects"`
	}
	if err := json.Unmarshal(normalized, &normalizedBlueprint); err != nil {
		t.Fatal(err)
	}
	if normalizedBlueprint.Effects[0].VisibilityMode != "triggered" || !normalizedBlueprint.Effects[0].AudioReactive {
		t.Fatalf("AI normalized Particles settings = %#v, want triggered/reactive", normalizedBlueprint.Effects[0])
	}
	for _, expected := range []string{`"spread":0.78`, `"speedInfluence":0.9`, `"glowIntensity":1.1`, `"baselineOpacity":0.14`, `"swirl":0.55`, `"audioInfluence":1`} {
		if !strings.Contains(string(normalized), expected) {
			t.Errorf("particle normalization missing %s: %s", expected, normalized)
		}
	}
}

func TestOpenAINormalizesOpacityAndNewWaveRingDefaults(t *testing.T) {
	raw := []byte(`{"version":1,"width":640,"height":360,"seed":1,"background":{"kind":"solid","color":"#10131c"},"regions":[{"id":"r","name":"r","geometry":{"kind":"rect","x":0,"y":0,"width":1,"height":1}}],"effects":[{"id":"e","kind":"wave-ring","regionId":"r","color":"#ffffff","centerX":0.5,"centerY":0.5,"radius":0.25,"amplitude":0.1,"points":64,"lineWidth":0.01}],"bindings":[{"id":"b","effectId":"e","source":"bass.envelope","strength":1,"threshold":0,"attackMs":0,"releaseMs":100}]}`)
	normalized, err := normalizeStrictOutput(raw)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeBlueprintForTest(normalized); err != nil {
		t.Fatalf("normalized blueprint invalid: %v", err)
	}
	for _, expected := range []string{`"opacity":1`, `"visibilityMode":"always"`, `"audioReactive":true`, `"layerCount":4`, `"layerRadiusStep":0.018`, `"layerAngleOffsetDeg":0`, `"layerAmplitudeDecay":0.9`} {
		if !strings.Contains(string(normalized), expected) {
			t.Errorf("normalization missing %s: %s", expected, normalized)
		}
	}
}

func TestOpenAIPromptDoesNotReceiveRawSpectrumMatrix(t *testing.T) {
	prompt := BuildPrompt(Summary{}, CompactFeatures{DurationMs: 60_000, BPM: 120, BPMSource: "fallback", BassSamples: []FeaturePoint{{TimeMs: 0, Value: 0.4}}}, "eq visualizer")
	if strings.Contains(prompt, `"values"`) || strings.Contains(prompt, `"frequencySpectrum":{`) {
		t.Fatalf("raw Spectrum matrix leaked into compact prompt: %s", prompt)
	}
}

func TestOpenAIRotationDefaultsOnlyWhenRotationWasRequested(t *testing.T) {
	raw := []byte(`{"version":1,"width":640,"height":360,"seed":1,"background":{"kind":"solid","color":"#10131c"},"regions":[{"id":"r","name":"r","geometry":{"kind":"rect","x":0,"y":0,"width":1,"height":1}}],"effects":[{"id":"e","kind":"radial-bars","regionId":"r","color":"#ffffff","centerX":0.5,"centerY":0.5,"radius":0.2,"bars":32,"barLength":0.16,"lineWidth":0.6,"rotationMode":"triggered","beatsPerRevolution":null,"rotationDirection":null,"initialAngleDeg":null}],"bindings":[{"id":"b","effectId":"e","source":"bass.envelope","strength":1,"threshold":0,"attackMs":0,"releaseMs":100}]}`)
	normalized, err := normalizeStrictOutput(raw)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeBlueprintForTest(normalized); err != nil {
		t.Fatalf("normalized circular rotation rejected: %v", err)
	}
	if !strings.Contains(string(normalized), `"beatsPerRevolution":8`) || !strings.Contains(string(normalized), `"rotationDirection":"clockwise"`) {
		t.Fatalf("rotation defaults missing: %s", normalized)
	}
}

func TestOpenAIResponsesRequestUsesStrictStructuredOutput(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/responses" || r.Method != http.MethodPost {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer local-mock-key" {
			t.Error("missing Authorization bearer header")
		}
		body, _ := io.ReadAll(r.Body)
		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatal(err)
		}
		if payload["model"] != OpenAIModel || payload["max_output_tokens"] != float64(4000) {
			t.Errorf("request model/output limit mismatch: %#v", payload)
		}
		if payload["reasoning"].(map[string]any)["effort"] != "none" {
			t.Errorf("reasoning effort mismatch: %#v", payload["reasoning"])
		}
		textConfig := payload["text"].(map[string]any)
		format := textConfig["format"].(map[string]any)
		if format["type"] != "json_schema" || format["strict"] != true || format["name"] != "editor_blueprint_v1" {
			t.Errorf("structured output format mismatch: %#v", format)
		}
		schema := format["schema"].(map[string]any)
		props := schema["properties"].(map[string]any)
		required := schema["required"].([]any)
		if len(required) != len(props) || schema["additionalProperties"] != false {
			t.Errorf("root strict contract incomplete: required=%d properties=%d", len(required), len(props))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"resp_mock","model":"gpt-6-luna","status":"completed","usage":{"input_tokens":321,"output_tokens":456,"output_tokens_details":{"reasoning_tokens":12}},"output":[{"type":"message","content":[{"type":"output_text","text":`+jsonString(FixtureBlueprint)+`}]}]}`)
	}))
	defer server.Close()
	generator, err := newOpenAIGenerator("local-mock-key", OpenAIModel, server.Client(), server.URL+"/v1")
	if err != nil {
		t.Fatal(err)
	}
	result, err := generator.GenerateWithOutputLimit(context.Background(), "synthetic prompt", 4000)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("generation requests=%d; retries must be disabled", calls)
	}
	if result.ModelVersion != OpenAIModel || result.Usage == nil || result.Usage.PromptTokens != 321 || result.Usage.CandidateTokens != 456 || result.Usage.ThoughtsTokens != 12 || result.Usage.TotalTokens != 777 {
		t.Fatalf("unexpected result usage/model: %+v", result)
	}
	if _, err := json.Marshal(result); err != nil {
		t.Fatal(err)
	}
	if _, err := decodeBlueprintForTest(result.Blueprint); err != nil {
		t.Fatalf("normalized Blueprint invalid: %v", err)
	}
}

func TestOpenAIInputTokenCountUsesSameStructuredSchema(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/responses/input_tokens" {
			t.Errorf("path=%q", r.URL.Path)
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		if payload["model"] != OpenAIModel || payload["input"] != "prompt" {
			t.Errorf("token-count request mismatch: %#v", payload)
		}
		format := payload["text"].(map[string]any)["format"].(map[string]any)
		if format["strict"] != true {
			t.Error("token count does not include strict output schema")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"object":"response.input_tokens","input_tokens":42}`)
	}))
	defer server.Close()
	generator, _ := newOpenAIGenerator("local-mock-key", OpenAIModel, server.Client(), server.URL+"/v1")
	count, err := generator.CountTokens(context.Background(), "prompt")
	if err != nil || count != 42 || calls != 1 {
		t.Fatalf("count=%d calls=%d err=%v", count, calls, err)
	}
}

func TestOpenAIOutputRemovesNullableSchemaFieldsBeforeGoValidation(t *testing.T) {
	blueprint := strings.Replace(FixtureBlueprint, `"kind":"gradient"`, `"kind":"gradient","color":null`, 1)
	// Ensure the test fixture has the expected serialized key order even if the canonical fixture changes.
	if blueprint == FixtureBlueprint {
		t.Skip("fixture schema has no matching gradient marker")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"model":"gpt-6-luna","status":"completed","usage":{"input_tokens":10,"output_tokens":20},"output":[{"content":[{"type":"output_text","text":`+jsonString(blueprint)+`}]}]}`)
	}))
	defer server.Close()
	generator, _ := newOpenAIGenerator("mock", OpenAIModel, server.Client(), server.URL)
	result, err := generator.Generate(context.Background(), "synthetic")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(result.Blueprint), `"color":null`) {
		t.Fatal("nullable optional field was not normalized away")
	}
	if _, err := decodeBlueprintForTest(result.Blueprint); err != nil {
		t.Fatalf("normalized Blueprint invalid: %v", err)
	}
}

func TestOpenAIRefusalIncompleteAndInvalidJSONAreDistinguished(t *testing.T) {
	cases := []struct {
		name, body string
		want       error
	}{
		{"refusal", `{"status":"completed","output":[{"content":[{"type":"refusal","refusal":"private refusal"}]}],"usage":{"input_tokens":1,"output_tokens":1}}`, ErrProviderRefusal},
		{"incomplete", `{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}`, ErrIncompleteOutput},
		{"invalid JSON", `{"status":"completed","output":[{"content":[{"type":"output_text","text":"{broken"}]}],"usage":{"input_tokens":1,"output_tokens":1}}`, ErrInvalidModelOutput},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, tc.body)
			}))
			defer server.Close()
			g, _ := newOpenAIGenerator("mock", OpenAIModel, server.Client(), server.URL)
			_, err := g.Generate(context.Background(), "synthetic")
			if !errors.Is(err, tc.want) {
				t.Fatalf("error=%v want=%v", err, tc.want)
			}
		})
	}
}

func TestOpenAIHTTPStatusClassificationSanitizesBodyAndDoesNotRetry(t *testing.T) {
	for _, status := range []int{400, 401, 403, 404, 429, 503} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.WriteHeader(status)
				_, _ = io.WriteString(w, `{"error":{"message":"secret prompt api-key"}}`)
			}))
			defer server.Close()
			g, _ := newOpenAIGenerator("mock", OpenAIModel, server.Client(), server.URL)
			_, err := g.CountTokens(context.Background(), "synthetic")
			var failure *ProviderFailure
			if !errors.As(err, &failure) || failure.UpstreamStatus != status || calls != 1 {
				t.Fatalf("err=%v calls=%d", err, calls)
			}
			if strings.Contains(err.Error(), "secret") {
				t.Fatal("provider body exposed")
			}
		})
	}
}

func TestOpenAITimeoutUsesCallerContext(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(100 * time.Millisecond):
		}
	}))
	defer server.Close()
	g, _ := newOpenAIGenerator("mock", OpenAIModel, server.Client(), server.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	_, err := g.CountTokens(ctx, "synthetic")
	var failure *ProviderFailure
	if !errors.As(err, &failure) || failure.Classification != "openai_timeout" {
		t.Fatalf("failure=%v", err)
	}
}

func jsonString(value string) string { b, _ := json.Marshal(value); return string(b) }

func decodeBlueprintForTest(raw []byte) (any, error) {
	return blueprint.Decode(raw)
}
