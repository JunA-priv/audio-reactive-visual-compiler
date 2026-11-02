package projects

import (
	"encoding/json"
	"strings"
	"testing"
)

const validBlueprint = `{"version":1,"width":640,"height":360,"seed":4242,"background":{"kind":"solid","color":"#10131c"},"regions":[{"id":"r","name":"stage","geometry":{"kind":"rect","x":0,"y":0,"width":1,"height":1}}],"effects":[{"id":"e","kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1}],"bindings":[{"id":"b","effectId":"e","source":"bass.envelope","strength":1,"threshold":0,"attackMs":0,"releaseMs":100}]}`

func validDocument(t *testing.T) json.RawMessage {
	t.Helper()
	return json.RawMessage(`{"documentVersion":1,"metadata":{"blueprintSchemaVersion":1,"featureTimelineSchemaVersion":1,"rendererVersion":"editor-renderer/1","analysisVersion":"unknown","seed":4242},"blueprint":` + validBlueprint + `,"featureTimeline":{"schemaVersion":1,"timeUnit":"ms","durationMs":1000,"bassEnvelope":[{"timeMs":0,"value":0.2},{"timeMs":1000,"value":0.8}],"kickEvents":[500]}}`)
}

func TestDecodeProjectDocumentV1(t *testing.T) {
	decoded, err := DecodeDocument(validDocument(t))
	if err != nil {
		t.Fatal("valid document rejected")
	}
	if string(decoded.Document.Blueprint) == "" || string(decoded.Document.FeatureTimeline) == "" {
		t.Fatal("v1 data was not retained")
	}
}

func TestDecodeProjectDocumentV1AcceptsPhaseAEffects(t *testing.T) {
	raw := string(validDocument(t))
	raw = strings.Replace(raw, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, `"kind":"radial-bars","regionId":"r","color":"#ffffff","centerX":0.5,"centerY":0.5,"radius":0.2,"bars":32,"barLength":0.16,"lineWidth":0.6`, 1)
	if _, err := DecodeDocument([]byte(raw)); err != nil {
		t.Fatalf("ProjectDocument v1 rejected radial-bars: %v", err)
	}
	raw = string(validDocument(t))
	raw = strings.Replace(raw, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, `"kind":"wave-ring","regionId":"r","color":"#ffffff","centerX":0.5,"centerY":0.5,"radius":0.28,"amplitude":0.08,"points":64,"lineWidth":0.012`, 1)
	if _, err := DecodeDocument([]byte(raw)); err != nil {
		t.Fatalf("ProjectDocument v1 rejected wave-ring: %v", err)
	}
}

func TestProjectAndCloudV1AcceptParticleEffects(t *testing.T) {
	effects := []struct {
		json   string
		source string
	}{
		{`"kind":"particles","regionId":"r","color":"#ffffff","count":64,"sizePx":4,"cycleMs":2200,"spread":0.78,"speedInfluence":0.9,"glowIntensity":1.1,"baselineOpacity":0.14`, `"source":"bass.envelope"`},
		{`"kind":"particle-burst","regionId":"r","color":"#ffffff","originX":0.5,"originY":0.5,"directionDeg":0,"spreadDeg":90,"speedPxPerSec":420,"lifetimeMs":1500,"count":64,"sizePx":7,"swirl":0.55,"audioInfluence":1,"baselineOpacity":0.12`, `"source":"kick.events"`},
		{`"kind":"particle-trail","regionId":"r","color":"#ffffff","samples":48,"trailMs":1800,"sizePx":7,"amplitude":0.28`, `"source":"bass.envelope"`},
		{`"kind":"ripple","regionId":"r","color":"#ffffff","centerX":0.5,"centerY":0.5,"waves":3,"periodMs":1600,"radius":0.34,"amplitude":0.08,"lineWidth":0.012`, `"source":"bass.envelope"`},
		{`"kind":"shockwave","regionId":"r","color":"#ffffff","centerX":0.5,"centerY":0.5,"maxRadius":0.42,"lifetimeMs":1000,"lineWidth":0.018`, `"source":"kick.events"`},
		{`"kind":"ink-diffusion","regionId":"r","color":"#ffffff","diffusionSpeed":0.25,"flowStrength":0.4,"turbulence":0.3,"inkDensity":0.65,"cloudScale":0.5,"responseTime":3`, `"source":"music.energy"`},
	}
	base, err := DecodeDocument(validDocument(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range effects {
		blueprint := strings.Replace(validBlueprint, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, item.json, 1)
		blueprint = strings.Replace(blueprint, `"source":"bass.envelope"`, item.source, 1)
		document := strings.Replace(string(validDocument(t)), validBlueprint, blueprint, 1)
		if _, err := DecodeDocument([]byte(document)); err != nil {
			t.Fatalf("ProjectDocument v1 rejected particle effect: %v", err)
		}
		envelope := CloudEnvelope{CloudDocumentVersion: 1, Metadata: base.Document.Metadata, EditorState: CloudEditorState{Blueprint: json.RawMessage(blueprint)}, FeatureTimeline: base.Document.FeatureTimeline}
		raw, err := json.Marshal(envelope)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := DecodeCloudEnvelope(raw); err != nil {
			t.Fatalf("Cloud Envelope v1 rejected particle effect: %v", err)
		}
	}
}

func TestDecodeCloudDocumentEnvelopeV1(t *testing.T) {
	base, err := DecodeDocument(validDocument(t))
	if err != nil {
		t.Fatal(err)
	}
	blueprintPlaceholder := strings.Replace(validBlueprint, `"#10131c"`, `"#000000"`, 1)
	envelope := CloudEnvelope{
		CloudDocumentVersion: 1,
		Metadata:             base.Document.Metadata,
		EditorState:          CloudEditorState{Blueprint: json.RawMessage(blueprintPlaceholder), BackgroundAssetID: ptr("00000000-0000-4000-8000-000000000003")},
		FeatureTimeline:      base.Document.FeatureTimeline,
		AssetRefs:            CloudAssetRefs{AudioAssetID: ptr("00000000-0000-4000-8000-000000000004")},
	}
	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeStoredDocument(raw)
	if err != nil || decoded.Cloud == nil {
		t.Fatalf("valid cloud envelope rejected: %v", err)
	}
	backgroundID, audioID, cloud, err := CloudAssetReferences(raw)
	if err != nil || !cloud || backgroundID != *envelope.EditorState.BackgroundAssetID || audioID != *envelope.AssetRefs.AudioAssetID {
		t.Fatal("cloud asset references were not preserved")
	}

	envelope.EditorState.Blueprint = json.RawMessage(strings.Replace(blueprintPlaceholder, `"#000000"`, `"#10131c"`, 1))
	invalid, _ := json.Marshal(envelope)
	if _, err := DecodeCloudEnvelope(invalid); err == nil {
		t.Fatal("asset reference without canonical placeholder was accepted")
	}
}

func TestDecodeCloudEnvelopeAcceptsPhaseAEffects(t *testing.T) {
	base, err := DecodeDocument(validDocument(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, effect := range []string{
		`"kind":"radial-bars","regionId":"r","color":"#ffffff","centerX":0.5,"centerY":0.5,"radius":0.2,"bars":32,"barLength":0.16,"lineWidth":0.6`,
		`"kind":"wave-ring","regionId":"r","color":"#ffffff","centerX":0.5,"centerY":0.5,"radius":0.28,"amplitude":0.08,"points":64,"lineWidth":0.012`,
		`"kind":"oscilloscope-line","regionId":"r","color":"#ffffff","orientation":"horizontal","lineWidth":0.012,"sampleCount":256,"amplitudeScale":0.8,"glowIntensity":1.5`,
	} {
		blueprint := strings.Replace(validBlueprint, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, effect, 1)
		envelope := CloudEnvelope{CloudDocumentVersion: 1, Metadata: base.Document.Metadata, EditorState: CloudEditorState{Blueprint: json.RawMessage(blueprint)}, FeatureTimeline: base.Document.FeatureTimeline}
		raw, marshalErr := json.Marshal(envelope)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		if _, decodeErr := DecodeCloudEnvelope(raw); decodeErr != nil {
			t.Fatalf("Cloud Envelope v1 rejected Phase A effect: %v", decodeErr)
		}
	}
}

func ptr(value string) *string { return &value }

func TestDecodeProjectDocumentRejectsInvalidOrAssetBearingData(t *testing.T) {
	valid := string(validDocument(t))
	cases := []struct {
		name string
		data string
	}{
		{"unsupported document version", strings.Replace(valid, `"documentVersion":1`, `"documentVersion":2`, 1)},
		{"unsupported timeline version", strings.Replace(valid, `"schemaVersion":1`, `"schemaVersion":2`, 1)},
		{"image background requires an asset", strings.Replace(valid, `"kind":"solid","color":"#10131c"`, `"kind":"image","src":"data:image/png;base64,AA=="`, 1)},
		{"embedded assets are not accepted", strings.Replace(valid, `"documentVersion":1,`, `"documentVersion":1,"assets":{},`, 1)},
		{"bad region reference", strings.Replace(valid, `"regionId":"r"`, `"regionId":"missing"`, 1)},
		{"NaN rejected", strings.Replace(valid, `"value":0.2`, `"value":NaN`, 1)},
		{"unknown key rejected", strings.Replace(valid, `"documentVersion":1,`, `"documentVersion":1,"unknown":true,`, 1)},
		{"trailing JSON rejected", valid + `{}`},
		{"oversize rejected", strings.Repeat(" ", MaxDocumentBytes+1)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := DecodeDocument([]byte(tc.data)); err == nil {
				t.Fatal("invalid document accepted")
			}
		})
	}
}

func TestTimelineRejectsInvalidNumbersOrderAndBounds(t *testing.T) {
	cases := []Timeline{
		{SchemaVersion: 1, TimeUnit: "ms", DurationMs: 10, BassEnvelope: []FeaturePoint{{TimeMs: 0, Value: 0.2}, {TimeMs: 0, Value: 0.3}}},
		{SchemaVersion: 1, TimeUnit: "ms", DurationMs: 10, BassEnvelope: []FeaturePoint{{TimeMs: 0, Value: 1.01}}},
		{SchemaVersion: 2, TimeUnit: "ms", DurationMs: 10, BassEnvelope: []FeaturePoint{{TimeMs: 0, Value: 0.2}}},
		{SchemaVersion: 1, TimeUnit: "seconds", DurationMs: 10, BassEnvelope: []FeaturePoint{{TimeMs: 0, Value: 0.2}}},
	}
	for _, candidate := range cases {
		if err := validateTimeline(candidate); err == nil {
			t.Fatal("invalid timeline accepted")
		}
	}
}

func TestTimelineV1AcceptsAdditiveFeaturesAndRejectsInvalidSnareAlignment(t *testing.T) {
	var timeline Timeline
	input := `{"schemaVersion":1,"timeUnit":"ms","durationMs":1000,"bassEnvelope":[{"timeMs":0,"value":0.2}],"kickEvents":[],"drumEnergy":[{"timeMs":0,"value":0.5}],"snareEvents":[200],"snareEventStrengths":[0.8],"vocalsEnvelope":[{"timeMs":0,"value":0.3}],"otherEnvelope":[{"timeMs":0,"value":0.4}],"musicEnergy":[{"timeMs":0,"value":0.7}]}`
	if err := json.Unmarshal([]byte(input), &timeline); err != nil {
		t.Fatal(err)
	}
	if err := validateTimeline(timeline); err != nil {
		t.Fatalf("additive Timeline v1 rejected: %v", err)
	}
	timeline.SnareEventStrengths = nil
	if err := validateTimeline(timeline); err == nil {
		t.Fatal("misaligned snare events accepted")
	}
}

func TestTimelineBPMMetadataAndV1Compatibility(t *testing.T) {
	var timeline Timeline
	if err := json.Unmarshal([]byte(`{"schemaVersion":1,"timeUnit":"ms","durationMs":1000,"bassEnvelope":[{"timeMs":0,"value":0.2}],"kickEvents":[],"bpm":120,"bpmSource":"fallback"}`), &timeline); err != nil {
		t.Fatal(err)
	}
	if err := validateTimeline(timeline); err != nil {
		t.Fatalf("valid BPM metadata rejected: %v", err)
	}
	timeline.BPM = floatPtr(130.0)
	if err := validateTimeline(timeline); err == nil {
		t.Fatal("fallback BPM other than 120 accepted")
	}
	timeline.BPM, timeline.BPMSource = nil, ""
	if err := validateTimeline(timeline); err != nil {
		t.Fatalf("legacy Timeline v1 rejected: %v", err)
	}
}

func floatPtr(value float64) *float64 { return &value }

func TestProjectDocumentV1AcceptsAddedTimelineFields(t *testing.T) {
	raw := strings.Replace(string(validDocument(t)), `"kickEvents":[500]`, `"kickEvents":[500],"snareEvents":[700],"snareEventStrengths":[0.6],"vocalsEnvelope":[{"timeMs":0,"value":0.3}],"otherEnvelope":[{"timeMs":0,"value":0.4}],"musicEnergy":[{"timeMs":0,"value":0.7}]`, 1)
	decoded, err := DecodeDocument([]byte(raw))
	if err != nil {
		t.Fatalf("ProjectDocument v1 rejected additive Timeline fields: %v", err)
	}
	envelope := CloudEnvelope{CloudDocumentVersion: 1, Metadata: decoded.Document.Metadata, EditorState: CloudEditorState{Blueprint: decoded.Document.Blueprint}, FeatureTimeline: decoded.Document.FeatureTimeline}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeCloudEnvelope(encoded); err != nil {
		t.Fatalf("Cloud Envelope v1 rejected additive Timeline fields: %v", err)
	}
}

func TestValidateTitle(t *testing.T) {
	for _, title := range []string{"", "  ", strings.Repeat("a", 121)} {
		if err := ValidateTitle(title); err == nil {
			t.Fatal("invalid title accepted")
		}
	}
	if err := ValidateTitle("A project"); err != nil {
		t.Fatal("valid title rejected")
	}
}
