package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"

	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/blueprint"
)

type Generator interface {
	Generate(context.Context, string) (GenerationResult, error)
}

type TokenCounter interface {
	CountTokens(context.Context, string) (int32, error)
}

type LimitedGenerator interface {
	GenerateWithOutputLimit(context.Context, string, int32) (GenerationResult, error)
}

type GenerationResult struct {
	Blueprint    []byte
	ModelVersion string
	Usage        *TokenUsage
}

type TokenUsage struct {
	PromptTokens    int32 `json:"promptTokens"`
	CandidateTokens int32 `json:"candidateTokens"`
	ThoughtsTokens  int32 `json:"thoughtsTokens"`
	TotalTokens     int32 `json:"totalTokens"`
}

const (
	OpenAIModel = "gpt-6-luna"
	openAIURL   = "https://api.openai.com/v1"
)

type OpenAIGenerator struct {
	apiKey  string
	model   string
	client  *http.Client
	baseURL string
}

func NewOpenAIGenerator(apiKey, model string) (*OpenAIGenerator, error) {
	return newOpenAIGenerator(apiKey, model, http.DefaultClient, openAIURL)
}

func newOpenAIGenerator(apiKey, model string, client *http.Client, baseURL string) (*OpenAIGenerator, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, errors.New("OpenAI API key is not configured")
	}
	if model == "" {
		model = OpenAIModel
	}
	if model != OpenAIModel || client == nil || !strings.HasPrefix(baseURL, "https://") && !strings.HasPrefix(baseURL, "http://127.0.0.1") {
		return nil, errors.New("OpenAI client configuration is invalid")
	}
	return &OpenAIGenerator{apiKey: apiKey, model: model, client: client, baseURL: strings.TrimRight(baseURL, "/")}, nil
}

type openAIInputTokenResponse struct {
	InputTokens int32 `json:"input_tokens"`
}

type openAIResponse struct {
	ID     string `json:"id"`
	Model  string `json:"model"`
	Status string `json:"status"`
	Error  *struct {
		Code string `json:"code"`
	} `json:"error"`
	IncompleteDetails *struct {
		Reason string `json:"reason"`
	} `json:"incomplete_details"`
	Usage *struct {
		InputTokens         int32 `json:"input_tokens"`
		OutputTokens        int32 `json:"output_tokens"`
		OutputTokensDetails *struct {
			ReasoningTokens int32 `json:"reasoning_tokens"`
		} `json:"output_tokens_details"`
	} `json:"usage"`
	Output []struct {
		Type    string `json:"type"`
		Content []struct {
			Type    string `json:"type"`
			Text    string `json:"text"`
			Refusal string `json:"refusal"`
		} `json:"content"`
	} `json:"output"`
}

func (g *OpenAIGenerator) post(ctx context.Context, path string, payload any, target any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return ErrInvalidModelOutput
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return ErrProviderUpstream
	}
	req.Header.Set("Authorization", "Bearer "+g.apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := g.client.Do(req)
	if err != nil {
		return classifyProviderError(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return classifyProviderStatus(resp.StatusCode, nil)
	}
	dec := json.NewDecoder(io.LimitReader(resp.Body, 2<<20))
	if err := dec.Decode(target); err != nil {
		return ErrInvalidModelOutput
	}
	return nil
}

func (g *OpenAIGenerator) CountTokens(ctx context.Context, prompt string) (int32, error) {
	payload := map[string]any{"model": g.model, "input": prompt, "text": map[string]any{"format": openAITextFormat()}}
	var result openAIInputTokenResponse
	if err := g.post(ctx, "/responses/input_tokens", payload, &result); err != nil {
		return 0, err
	}
	if result.InputTokens < 0 {
		return 0, ErrInvalidModelOutput
	}
	return result.InputTokens, nil
}

func (g *OpenAIGenerator) Generate(ctx context.Context, prompt string) (GenerationResult, error) {
	return g.GenerateWithOutputLimit(ctx, prompt, 4000)
}

func (g *OpenAIGenerator) GenerateWithOutputLimit(ctx context.Context, prompt string, maxOutputTokens int32) (GenerationResult, error) {
	if maxOutputTokens < 1 || maxOutputTokens > 4000 {
		return GenerationResult{}, ErrInvalidModelOutput
	}
	payload := map[string]any{"model": g.model, "input": prompt, "max_output_tokens": maxOutputTokens, "reasoning": map[string]any{"effort": "none"}, "text": map[string]any{"format": openAITextFormat()}}
	var response openAIResponse
	if err := g.post(ctx, "/responses", payload, &response); err != nil {
		return GenerationResult{}, err
	}
	if response.Status == "incomplete" {
		return GenerationResult{}, &ProviderFailure{Classification: "openai_incomplete_output", cause: ErrIncompleteOutput}
	}
	if response.Status == "failed" {
		return GenerationResult{}, &ProviderFailure{Classification: "openai_failed_response", cause: ErrProviderUpstream}
	}
	if response.Status != "completed" {
		return GenerationResult{}, ErrInvalidModelOutput
	}
	var output string
	for _, item := range response.Output {
		for _, content := range item.Content {
			switch content.Type {
			case "refusal":
				return GenerationResult{}, ErrProviderRefusal
			case "output_text":
				output += content.Text
			}
		}
	}
	if strings.TrimSpace(output) == "" || response.Usage == nil || response.Usage.InputTokens < 0 || response.Usage.OutputTokens < 0 || response.Usage.OutputTokensDetails != nil && response.Usage.OutputTokensDetails.ReasoningTokens < 0 {
		return GenerationResult{}, ErrInvalidModelOutput
	}
	normalized, err := normalizeStrictOutput([]byte(output))
	if err != nil {
		return GenerationResult{}, ErrInvalidModelOutput
	}
	usage := &TokenUsage{PromptTokens: response.Usage.InputTokens, CandidateTokens: response.Usage.OutputTokens, TotalTokens: response.Usage.InputTokens + response.Usage.OutputTokens}
	if response.Usage.OutputTokensDetails != nil {
		usage.ThoughtsTokens = response.Usage.OutputTokensDetails.ReasoningTokens
	}
	model := response.Model
	if model == "" {
		model = g.model
	}
	return GenerationResult{Blueprint: normalized, ModelVersion: model, Usage: usage}, nil
}

func normalizeStrictOutput(raw []byte) ([]byte, error) {
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, errors.New("multiple output JSON values")
	}
	var stripNulls func(any) any
	stripNulls = func(input any) any {
		switch current := input.(type) {
		case map[string]any:
			for key, child := range current {
				if child == nil {
					delete(current, key)
				} else {
					current[key] = stripNulls(child)
				}
			}
		case []any:
			for i, child := range current {
				current[i] = stripNulls(child)
			}
		}
		return input
	}
	normalized := stripNulls(value)
	if root, ok := normalized.(map[string]any); ok {
		if _, exists := root["globalGradient"]; !exists {
			root["globalGradient"] = map[string]any{"startColor": "#22d3ee", "middleColor": "#8b5cf6", "endColor": "#ec4899", "angleDeg": json.Number("0")}
		}
		if effects, ok := root["effects"].([]any); ok {
			for _, item := range effects {
				if effect, ok := item.(map[string]any); ok {
					if _, exists := effect["opacity"]; !exists {
						effect["opacity"] = json.Number("1")
					}
					if _, exists := effect["colorMode"]; !exists {
						effect["colorMode"] = "global-gradient"
					}
					if _, exists := effect["visibilityMode"]; !exists {
						effect["visibilityMode"] = "always"
					}
					if _, exists := effect["audioReactive"]; !exists {
						effect["audioReactive"] = true
					}
					if effect["audioReactive"] == false {
						effect["visibilityMode"] = "always"
					}
					kind, _ := effect["kind"].(string)
					if kind == "particles" {
						effect["visibilityMode"] = "triggered"
						effect["audioReactive"] = true
					}
					if kind == "wave-ring" {
						defaults := map[string]any{"layerCount": json.Number("4"), "layerRadiusStep": json.Number("0.018"), "layerAngleOffsetDeg": json.Number("0"), "layerAmplitudeDecay": json.Number("0.9")}
						for key, defaultValue := range defaults {
							if _, exists := effect[key]; !exists {
								effect[key] = defaultValue
							}
						}
					}
					if kind == "particles" {
						defaults := map[string]any{"spread": json.Number("0.78"), "speedInfluence": json.Number("0.9"), "glowIntensity": json.Number("1.1"), "baselineOpacity": json.Number("0.14")}
						for key, defaultValue := range defaults {
							if _, exists := effect[key]; !exists {
								effect[key] = defaultValue
							}
						}
					}
					if kind == "particle-burst" {
						defaults := map[string]any{"swirl": json.Number("0.55"), "audioInfluence": json.Number("1"), "baselineOpacity": json.Number("0.12")}
						for key, defaultValue := range defaults {
							if _, exists := effect[key]; !exists {
								effect[key] = defaultValue
							}
						}
					}
					if kind == "ink-diffusion" || kind == "ink-flow" || kind == "color-mixing" {
						defaults := map[string]any{"diffusionSpeed": json.Number("0.25"), "flowStrength": json.Number("0.4"), "turbulence": json.Number("0.3"), "inkDensity": json.Number("0.65"), "cloudScale": json.Number("0.5"), "responseTime": json.Number("3")}
						if kind == "ink-flow" {
							defaults = map[string]any{"diffusionSpeed": json.Number("0.45"), "flowStrength": json.Number("0.95"), "turbulence": json.Number("0.65"), "inkDensity": json.Number("0.5"), "cloudScale": json.Number("0.65"), "responseTime": json.Number("3")}
						}
						if kind == "color-mixing" {
							defaults = map[string]any{"diffusionSpeed": json.Number("0.25"), "flowStrength": json.Number("0.5"), "turbulence": json.Number("0.55"), "inkDensity": json.Number("0.65"), "cloudScale": json.Number("0.9"), "responseTime": json.Number("4")}
							if _, exists := effect["customPalette"]; !exists {
								effect["customPalette"] = []any{"#22d3ee", "#8b5cf6", "#ec4899"}
							}
						}
						for key, defaultValue := range defaults {
							if _, exists := effect[key]; !exists {
								effect[key] = defaultValue
							}
						}
					}
					if kind == "radial-bars" || kind == "wave-ring" || kind == "waveform-ring" {
						rotationKeys := []string{"rotationMode", "beatsPerRevolution", "rotationDirection", "initialAngleDeg"}
						provided := false
						for _, key := range rotationKeys {
							if _, exists := effect[key]; exists {
								provided = true
							}
						}
						if provided {
							if _, exists := effect["rotationMode"]; !exists {
								effect["rotationMode"] = "continuous"
							}
							if _, exists := effect["beatsPerRevolution"]; !exists {
								effect["beatsPerRevolution"] = json.Number("8")
							}
							if _, exists := effect["rotationDirection"]; !exists {
								effect["rotationDirection"] = "clockwise"
							}
							if _, exists := effect["initialAngleDeg"]; !exists {
								effect["initialAngleDeg"] = json.Number("0")
							}
						}
					}
				}
			}
		}
	}
	return json.Marshal(normalized)
}

func openAITextFormat() map[string]any {
	return map[string]any{"type": "json_schema", "name": "editor_blueprint_v1", "strict": true, "schema": OpenAIEditorBlueprintJSONSchema()}
}

// OpenAIEditorBlueprintJSONSchema converts the shared schema to Structured Outputs' strict subset.
func OpenAIEditorBlueprintJSONSchema() map[string]any {
	return strictOpenAISchema(EditorBlueprintJSONSchema(), false).(map[string]any)
}

func strictOpenAISchema(value any, optional bool) any {
	switch v := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(v)+1)
		properties, isObject := v["properties"].(map[string]any)
		originalRequired := map[string]bool{}
		if req, ok := v["required"].([]string); ok {
			for _, key := range req {
				originalRequired[key] = true
			}
		}
		if req, ok := v["required"].([]any); ok {
			for _, key := range req {
				if text, ok := key.(string); ok {
					originalRequired[text] = true
				}
			}
		}
		for key, child := range v {
			if key == "required" || key == "properties" {
				continue
			}
			out[key] = strictOpenAISchema(child, false)
		}
		if isObject {
			newProperties := make(map[string]any, len(properties))
			required := make([]string, 0, len(properties))
			for key, child := range properties {
				newProperties[key] = strictOpenAISchema(child, !originalRequired[key])
				required = append(required, key)
			}
			out["properties"] = newProperties
			out["required"] = required
			out["additionalProperties"] = false
		}
		if optional {
			return map[string]any{"anyOf": []any{out, map[string]any{"type": "null"}}}
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, child := range v {
			out[i] = strictOpenAISchema(child, false)
		}
		return out
	default:
		return value
	}
}

func classifyProviderError(err error) error {
	if err == nil {
		return ErrProviderUpstream
	}
	var existing *ProviderFailure
	if errors.As(err, &existing) {
		return existing
	}
	if errors.Is(err, ErrRateLimited) {
		return &ProviderFailure{Classification: "openai_rate_limited", UpstreamStatus: 429, cause: err}
	}
	if errors.Is(err, ErrProviderUpstream) {
		return &ProviderFailure{Classification: "openai_upstream_error", cause: err}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &ProviderFailure{Classification: "openai_timeout", cause: err}
	}
	if errors.Is(err, context.Canceled) {
		return &ProviderFailure{Classification: "openai_canceled", cause: err}
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return &ProviderFailure{Classification: "openai_transport_error", cause: err}
	}
	return &ProviderFailure{Classification: "openai_upstream_error", cause: err}
}

func classifyProviderStatus(status int, cause error) error {
	class := "openai_upstream_http_error"
	switch status {
	case 400:
		class = "openai_upstream_bad_request"
	case 401:
		class = "openai_upstream_unauthorized"
	case 403:
		class = "openai_upstream_forbidden"
	case 404:
		class = "openai_upstream_not_found"
	case 429:
		class = "openai_rate_limited"
	default:
		if status >= 500 && status <= 599 {
			class = "openai_upstream_5xx"
		}
	}
	return &ProviderFailure{Classification: class, UpstreamStatus: status, cause: cause}
}

// ProviderFailure contains safe status data only; upstream bodies are never exposed.
type ProviderFailure struct {
	Classification string
	UpstreamStatus int
	cause          error
}

func (e *ProviderFailure) Error() string { return "OpenAI upstream request failed" }
func (e *ProviderFailure) Unwrap() error { return e.cause }
func (e *ProviderFailure) Is(target error) bool {
	return (target == ErrRateLimited && e.Classification == "openai_rate_limited") ||
		(target == ErrProviderUpstream && e.Classification != "openai_rate_limited" && e.Classification != "openai_timeout" && e.Classification != "openai_canceled")
}

// EditorBlueprintJSONSchema avoids union keywords: it constrains structure, enums,
// and scalar ranges; variant-specific required fields and references are checked by Go.
func EditorBlueprintJSONSchema() map[string]any {
	str := map[string]any{"type": "string"}
	num := func(min, max float64) map[string]any {
		return map[string]any{"type": "number", "minimum": min, "maximum": max}
	}
	intNum := func(min, max int) map[string]any {
		return map[string]any{"type": "integer", "minimum": min, "maximum": max}
	}
	obj := func(props map[string]any, required ...string) map[string]any {
		return map[string]any{"type": "object", "properties": props, "required": required, "additionalProperties": false}
	}
	point := obj(map[string]any{"x": num(0, 1), "y": num(0, 1)}, "x", "y")
	geometry := obj(map[string]any{
		"kind": map[string]any{"type": "string", "enum": []string{"rect", "polygon"}},
		"x":    num(0, 1), "y": num(0, 1), "width": num(0, 1), "height": num(0, 1),
		"points": map[string]any{"type": "array", "items": point, "minItems": 3, "maxItems": 64},
	}, "kind")
	region := obj(map[string]any{"id": str, "name": str, "geometry": geometry}, "id", "name", "geometry")
	background := obj(map[string]any{
		"kind": map[string]any{"type": "string", "enum": []string{"solid", "gradient"}}, "color": str, "from": str, "to": str, "angleDeg": num(0, 360),
	}, "kind")
	globalGradient := obj(map[string]any{"startColor": str, "middleColor": str, "endColor": str, "angleDeg": num(0, 360)}, "startColor", "middleColor", "endColor", "angleDeg")
	effect := obj(map[string]any{
		"id": str, "kind": map[string]any{"type": "string", "enum": []string{"pulse-scale", "glow-brightness", "rotation-movement", "particles", "waveform-bars", "waveform-line", "waveform-peak-bars", "waveform-ring", "spectrum-bars", "spectrum-line", "radial-bars", "wave-ring", "particle-burst", "particle-trail", "ripple", "shockwave", "oscilloscope-line", "ink-diffusion", "ink-flow", "color-mixing"}}, "regionId": str, "color": str, "opacity": num(0, 1),
		"visibilityMode": map[string]any{"type": "string", "enum": []string{"triggered", "always"}}, "audioReactive": map[string]any{"type": "boolean"},
		"colorMode": map[string]any{"type": "string", "enum": []string{"global-gradient", "custom"}},
		"baseScale": num(0, 4), "maxScale": num(0, 4), "blurPx": num(0, 100), "brightness": num(0, 3), "glowIntensity": num(0, 2),
		"rotationDeg": num(-360, 360), "moveX": num(-1, 1), "moveY": num(-1, 1), "count": intNum(1, 64), "sizePx": num(0.000001, 100),
		"spread": num(0.1, 1), "speedInfluence": num(0, 2), "audioInfluence": num(0, 2), "swirl": num(-2, 2), "baselineOpacity": num(0, 0.35),
		"cycleMs": num(100, 60000), "bars": intNum(2, 256), "lineWidth": num(0.000001, 1), "centerX": num(0, 1), "centerY": num(0, 1),
		"radius": num(0.05, 0.45), "barLength": num(0.02, 0.3), "amplitude": num(0, 0.5), "points": intNum(16, 128),
		"originX": num(0, 1), "originY": num(0, 1), "directionDeg": num(-360, 360), "spreadDeg": num(0, 360), "speedPxPerSec": num(0, 1000), "lifetimeMs": num(100, 5000),
		"samples": intNum(8, 128), "trailMs": num(100, 5000),
		"waves": intNum(1, 6), "periodMs": num(250, 4000), "maxRadius": num(0.05, 0.5),
		"barWidth": num(0.05, 1), "spikeSharpness": num(0, 1), "innerRadius": num(0.02, 0.45), "amplitudeScale": num(0.1, 4), "segmented": map[string]any{"type": "boolean"}, "segmentsPerBar": intNum(1, 24), "attackMs": num(0, 1000), "releaseMs": num(0, 3000),
		"sampleCount": intNum(16, 512), "jaggedness": num(0, 1), "smoothing": num(0, 1), "spacing": num(0, 0.5), "opacityBoost": num(0.5, 2), "coreBrightness": num(0, 2), "lengthScale": num(0.25, 1.5),
		"rotationMode": map[string]any{"type": "string", "enum": []string{"continuous", "triggered"}}, "beatsPerRevolution": map[string]any{"type": "integer", "enum": []int{4, 8, 16, 32}}, "rotationDirection": map[string]any{"type": "string", "enum": []string{"clockwise", "counterclockwise"}}, "initialAngleDeg": num(-360, 360),
		"layerCount": intNum(1, 10), "layerRadiusStep": num(0, 0.1), "layerAngleOffsetDeg": num(0, 360), "layerAmplitudeDecay": num(0.5, 1),
		"orientation":    map[string]any{"type": "string", "enum": []string{"horizontal", "vertical", "radial"}},
		"diffusionSpeed": num(0, 2), "flowStrength": num(0, 2), "turbulence": num(0, 2), "inkDensity": num(0, 1), "cloudScale": num(0.1, 2), "responseTime": num(0.5, 10),
		"customPalette": map[string]any{"type": "array", "items": map[string]any{"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"}, "minItems": 2, "maxItems": 4},
	}, "id", "kind", "regionId", "color")
	binding := obj(map[string]any{"id": str, "effectId": str, "source": map[string]any{"type": "string", "enum": []string{"bass.envelope", "kick.events", "snare.events", "drums.energy", "vocals.envelope", "other.envelope", "music.energy"}}, "strength": num(0, 1), "threshold": num(0, 1), "attackMs": num(0, 5000), "releaseMs": num(0, 10000)}, "id", "effectId", "source", "strength", "threshold", "attackMs", "releaseMs")
	return obj(map[string]any{
		"version": map[string]any{"type": "integer", "enum": []int{1}}, "width": intNum(1, 4096), "height": intNum(1, 4096), "seed": intNum(-2147483648, 2147483647),
		"background":     background,
		"globalGradient": globalGradient,
		"regions":        map[string]any{"type": "array", "items": region, "maxItems": blueprint.MaxRegions},
		"effects":        map[string]any{"type": "array", "items": effect, "maxItems": blueprint.MaxEffects},
		"bindings":       map[string]any{"type": "array", "items": binding, "maxItems": blueprint.MaxBindings},
	}, "version", "width", "height", "seed", "background", "regions", "effects", "bindings")
}

func BuildPrompt(summary Summary, features CompactFeatures, visualIntent string) string {
	payload := struct {
		MusicSummary   Summary         `json:"musicSummary"`
		FeatureSummary CompactFeatures `json:"featureSummary"`
		VisualIntent   string          `json:"visualIntent,omitempty"`
		Contract       string          `json:"contract"`
	}{summary, features, visualIntent, "Return only an EditorBlueprint v1 JSON object. Create an artistic but editable declarative composition using only the supported schema. Prefer visibilityMode always and audioReactive true; set triggered only when the Effect should disappear without source response. audioReactive false must use visibilityMode always. Set opacity per effect when useful. Ink Diffusion (ink-diffusion), Ink Flow (ink-flow), and Color Mixing (color-mixing) belong to Ambient / Atmospheric and default to music.energy. Ink Diffusion uses a localized translucent density cloud. Ink Flow emphasizes thin curved streams and vortices. Color Mixing uses independently moving, overlapping pigment density fields; Global Gradient uses the shared palette, while Custom Color may add customPalette with 2-4 distinct #RRGGBB colors for source-weighted pigment mixing. All use deterministic Ink WebGL2 rendering with Canvas2D fallback and a 3 second response smoothing. Their optional diffusionSpeed (0-2), flowStrength (0-2), turbulence (0-2), inkDensity (0-1), cloudScale (.1-2), and responseTime (.5-10 seconds) tune each effect; defaults are effect-specific. Particles are the exception: always set visibilityMode triggered and audioReactive true, emit only in response to its Binding source, and use count (max 64), spread, speedInfluence, glowIntensity, and baselineOpacity for an upward field across the lower Region. For particle-burst, emit an evenly distributed 360-degree radial burst; directionDeg rotates the whole pattern, spreadDeg adds per-particle angular variation, swirl rotates through the lifetime, and audioInfluence scales count/speed/spread/glow. Keep bursts deterministic and restrained in baseline when always. Wave Ring can use 1-10 layers (prefer 4), with automatic full-turn offsets at 360/layerCount degrees when layerAngleOffsetDeg is 0; positive values specify the manual angle step. Wave Ring layers share one radius; legacy layerRadiusStep is ignored by rendering and layerAmplitudeDecay adjusts contour amplitude. Spectrum Bars and Spectrum Line use 32 log-spaced bands from the decoded music's frequencySpectrum Timeline field; the matrix is handled by the renderer and must not be copied into the Blueprint. They can combine FFT shape with one of the seven audio Binding sources for extra response strength. Real signed waveform peak data is available from Feature Timeline at render time; waveform-line, waveform-peak-bars, and waveform-ring can use any of the seven audio binding sources. Circular effects may use BPM-synchronized rotation: choose rotationMode continuous or triggered, beatsPerRevolution 4/8/16/32 (prefer 8), rotationDirection, and initialAngleDeg together. Continuous rotates at BPM-derived speed; triggered rotation integrates the selected binding response from time zero. Use a shared cyan-to-purple-to-pink globalGradient and set colorMode to global-gradient for effects unless a deliberate custom effect color is needed. No code, no data URLs, no external assets. Bind every effect exactly once. Use normalized regions. Make no claims beyond the provided analysis."}
	b, err := json.Marshal(payload)
	if err != nil {
		return fmt.Sprintf("Create an EditorBlueprint v1. Duration %d ms.", summary.DurationMs)
	}
	return string(b)
}

var (
	ErrRateLimited        = errors.New("OpenAI rate limited")
	ErrProviderUpstream   = errors.New("OpenAI upstream failure")
	ErrProviderRefusal    = errors.New("OpenAI refused the request")
	ErrIncompleteOutput   = errors.New("OpenAI response is incomplete")
	ErrInvalidModelOutput = errors.New("invalid provider output")
)
