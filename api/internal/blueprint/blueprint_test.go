package blueprint

import (
	"strings"
	"testing"
)

const valid = `{"version":1,"width":640,"height":360,"seed":1,"background":{"kind":"solid","color":"#10131c"},"regions":[{"id":"r","name":"r","geometry":{"kind":"rect","x":0,"y":0,"width":1,"height":1}}],"effects":[{"id":"e","kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1}],"bindings":[{"id":"b","effectId":"e","source":"bass.envelope","strength":1,"threshold":0,"attackMs":0,"releaseMs":100}]}`

func TestFixtureIsValid(t *testing.T) {
	if _, err := Decode([]byte(valid)); err != nil {
		t.Fatal(err)
	}
}

func TestInkDiffusionOptionalParameters(t *testing.T) {
	ink := strings.Replace(valid, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, `"kind":"ink-diffusion","regionId":"r","color":"#ffffff","diffusionSpeed":0.25,"responseTime":3`, 1)
	if _, err := Decode([]byte(ink)); err != nil {
		t.Fatalf("valid ink-diffusion rejected: %v", err)
	}
	for _, bad := range []string{
		strings.Replace(ink, `"diffusionSpeed":0.25`, `"diffusionSpeed":2.1`, 1),
		strings.Replace(ink, `"responseTime":3`, `"responseTime":0.2`, 1),
		strings.Replace(ink, `,"responseTime":3`, `,"responseTime":"slow"`, 1),
	} {
		if _, err := Decode([]byte(bad)); err == nil {
			t.Errorf("invalid ink-diffusion accepted: %s", bad)
		}
	}
	minimal := strings.Replace(valid, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, `"kind":"ink-diffusion","regionId":"r","color":"#ffffff"`, 1)
	if _, err := Decode([]byte(minimal)); err != nil {
		t.Fatalf("legacy/minimal ink-diffusion rejected: %v", err)
	}
}

func TestInkFlowAndColorMixingKinds(t *testing.T) {
	for _, kind := range []string{"ink-flow", "color-mixing"} {
		value := strings.Replace(valid, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, `"kind":"`+kind+`","regionId":"r","color":"#ffffff","flowStrength":0.8,"responseTime":3`, 1)
		if kind == "color-mixing" {
			value = strings.Replace(value, `"responseTime":3`, `"responseTime":3,"customPalette":["#22d3ee","#8b5cf6","#ec4899","#f59e0b"]`, 1)
		}
		if _, err := Decode([]byte(value)); err != nil {
			t.Fatalf("valid %s rejected: %v", kind, err)
		}
		bad := strings.Replace(value, `"flowStrength":0.8`, `"flowStrength":2.1`, 1)
		if _, err := Decode([]byte(bad)); err == nil {
			t.Errorf("invalid %s parameter accepted", kind)
		}
		if kind == "color-mixing" {
			for _, invalidPalette := range []string{`["#ffffff"]`, `["#ffffff","#000000","#123456","#abcdef","#00ff00"]`, `["red","#ffffff"]`, `["#ffffff","#000000","#ffffff00"]`} {
				invalid := strings.Replace(value, `"customPalette":["#22d3ee","#8b5cf6","#ec4899","#f59e0b"]`, `"customPalette":`+invalidPalette, 1)
				if _, err := Decode([]byte(invalid)); err == nil {
					t.Errorf("invalid customPalette accepted: %s", invalidPalette)
				}
			}
			wrongKind := strings.Replace(value, `"kind":"color-mixing"`, `"kind":"ink-flow"`, 1)
			if _, err := Decode([]byte(wrongKind)); err == nil {
				t.Error("customPalette accepted for ink-flow")
			}
		}
	}
}

func TestCircularBPMRotationContract(t *testing.T) {
	base := strings.Replace(valid, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, `"kind":"radial-bars","regionId":"r","color":"#ffffff","centerX":0.5,"centerY":0.5,"radius":0.2,"bars":32,"barLength":0.16,"lineWidth":0.6,"rotationMode":"continuous","beatsPerRevolution":8,"rotationDirection":"clockwise","initialAngleDeg":15`, 1)
	if _, err := Decode([]byte(base)); err != nil {
		t.Fatalf("valid BPM rotation rejected: %v", err)
	}
	for _, bad := range []string{
		strings.Replace(base, `"beatsPerRevolution":8`, `"beatsPerRevolution":6`, 1),
		strings.Replace(base, `"rotationMode":"continuous"`, `"rotationMode":"fixed-speed"`, 1),
		strings.Replace(base, `,"initialAngleDeg":15`, ``, 1),
	} {
		if _, err := Decode([]byte(bad)); err == nil {
			t.Errorf("invalid BPM rotation accepted: %s", bad)
		}
	}
}

func TestOptionalGlobalGradientAndEffectColorMode(t *testing.T) {
	if _, err := Decode([]byte(valid)); err != nil {
		t.Fatalf("legacy v1 rejected: %v", err)
	}
	withGradient := strings.Replace(valid, `"background":`, `"globalGradient":{"startColor":"#22d3ee","middleColor":"#8b5cf6","endColor":"#ec4899","angleDeg":45},"background":`, 1)
	withGradient = strings.Replace(withGradient, `"color":"#ffffff"`, `"color":"#ffffff","colorMode":"global-gradient"`, 1)
	if _, err := Decode([]byte(withGradient)); err != nil {
		t.Fatalf("valid gradient/color mode rejected: %v", err)
	}
	for _, bad := range []string{
		strings.Replace(withGradient, `"angleDeg":45`, `"angleDeg":361`, 1),
		strings.Replace(withGradient, `"startColor":"#22d3ee"`, `"startColor":"cyan"`, 1),
		strings.Replace(withGradient, `"colorMode":"global-gradient"`, `"colorMode":"automatic"`, 1),
	} {
		if _, err := Decode([]byte(bad)); err == nil {
			t.Errorf("invalid gradient/color mode accepted: %s", bad)
		}
	}
}

func TestAllBindingSourcesAreAcceptedForEveryEffectKind(t *testing.T) {
	for _, source := range []string{"bass.envelope", "kick.events", "snare.events", "drums.energy", "vocals.envelope", "other.envelope", "music.energy"} {
		if _, err := Decode([]byte(strings.Replace(valid, `"source":"bass.envelope"`, `"source":"`+source+`"`, 1))); err != nil {
			t.Errorf("pulse-scale rejected supported source %s: %v", source, err)
		}
	}
	for _, source := range []string{"bass.envelope", "kick.events", "snare.events", "drums.energy", "vocals.envelope", "other.envelope", "music.energy"} {
		for _, kind := range []struct{ old, replacement string }{
			{`"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, `"kind":"particle-burst","regionId":"r","color":"#ffffff","originX":0.5,"originY":0.5,"directionDeg":0,"spreadDeg":90,"speedPxPerSec":100,"lifetimeMs":1000,"count":8,"sizePx":5`},
			{`"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, `"kind":"particle-trail","regionId":"r","color":"#ffffff","samples":16,"trailMs":1000,"sizePx":5,"amplitude":0.2`},
		} {
			raw := strings.Replace(valid, kind.old, kind.replacement, 1)
			raw = strings.Replace(raw, `"source":"bass.envelope"`, `"source":"`+source+`"`, 1)
			if _, err := Decode([]byte(raw)); err != nil {
				t.Errorf("%s rejected source %s: %v", strings.Split(kind.replacement, `"`)[1], source, err)
			}
		}
	}
}

func TestBlueprintValidationRejectsSchemaAndReferences(t *testing.T) {
	cases := []string{
		strings.Replace(valid, `"version":1`, `"version":2`, 1),
		strings.Replace(valid, `"regionId":"r"`, `"regionId":"absent"`, 1),
		strings.Replace(valid, `"effectId":"e"`, `"effectId":"absent"`, 1),
		strings.Replace(valid, `"x":0`, `"x":-0.1`, 1),
		strings.Replace(valid, `"baseScale":0.2`, `"baseScale":NaN`, 1),
		strings.Replace(valid, `"source":"bass.envelope"`, `"source":"arbitrary"`, 1),
		strings.Replace(valid, `"baseScale":0.2,"maxScale":1`, `"baseScale":2,"maxScale":1`, 1),
		strings.Replace(valid, `"releaseMs":100`, `"releaseMs":100,"script":"alert(1)"`, 1),
		strings.Replace(valid, `"geometry":{"kind":"rect","x":0,"y":0,"width":1,"height":1}`, `"geometry":{"kind":"polygon","points":[{"x":0,"y":0},"bad",{"x":1,"y":1}]}`, 1),
	}
	for i, input := range cases {
		if _, err := Decode([]byte(input)); err == nil {
			t.Errorf("case %d accepted", i)
		}
	}
}

func TestLimitsAndTrailingGarbage(t *testing.T) {
	if _, err := Decode([]byte(`{} {}`)); err == nil {
		t.Fatal("accepted multiple JSON values")
	}
	if _, err := Decode([]byte(`{} x`)); err == nil {
		t.Fatal("accepted invalid trailing JSON")
	}
}

func TestPhaseAEffectsValidateAndEnforceRanges(t *testing.T) {
	radial := strings.Replace(valid, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, `"kind":"radial-bars","regionId":"r","color":"#ffffff","centerX":0.5,"centerY":0.5,"radius":0.2,"bars":32,"barLength":0.16,"lineWidth":0.6`, 1)
	if _, err := Decode([]byte(radial)); err != nil {
		t.Fatalf("valid radial-bars rejected: %v", err)
	}
	badRadial := strings.Replace(radial, `"radius":0.2`, `"radius":0.5`, 1)
	if _, err := Decode([]byte(badRadial)); err == nil {
		t.Fatal("radial-bars accepted out-of-range radius")
	}

	ring := strings.Replace(valid, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, `"kind":"wave-ring","regionId":"r","color":"#ffffff","centerX":0.5,"centerY":0.5,"radius":0.28,"amplitude":0.08,"points":64,"lineWidth":0.012`, 1)
	if _, err := Decode([]byte(ring)); err != nil {
		t.Fatalf("valid wave-ring rejected: %v", err)
	}
	badRing := strings.Replace(ring, `"points":64`, `"points":15`, 1)
	if _, err := Decode([]byte(badRing)); err == nil {
		t.Fatal("wave-ring accepted too few points")
	}
}

func TestOpacityAndLayeredWaveRingContract(t *testing.T) {
	for _, opacity := range []string{"0", "0.5", "1"} {
		candidate := strings.Replace(valid, `"color":"#ffffff"`, `"color":"#ffffff","opacity":`+opacity, 1)
		if _, err := Decode([]byte(candidate)); err != nil {
			t.Errorf("valid opacity %s rejected: %v", opacity, err)
		}
	}
	for _, opacity := range []string{"-0.1", "1.1", "NaN"} {
		candidate := strings.Replace(valid, `"color":"#ffffff"`, `"color":"#ffffff","opacity":`+opacity, 1)
		if _, err := Decode([]byte(candidate)); err == nil {
			t.Errorf("invalid opacity %s accepted", opacity)
		}
	}
	ring := strings.Replace(valid, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, `"kind":"wave-ring","regionId":"r","color":"#ffffff","centerX":0.5,"centerY":0.5,"radius":0.25,"amplitude":0.1,"points":64,"lineWidth":0.01,"layerCount":10,"layerRadiusStep":0.02,"layerAngleOffsetDeg":0,"layerAmplitudeDecay":0.8,"visibilityMode":"always","audioReactive":true`, 1)
	if _, err := Decode([]byte(ring)); err != nil {
		t.Fatalf("valid layered Wave Ring rejected: %v", err)
	}
	for _, bad := range []string{strings.Replace(ring, `"layerCount":10`, `"layerCount":11`, 1), strings.Replace(ring, `"layerCount":10`, `"layerCount":7.5`, 1), strings.Replace(ring, `"layerRadiusStep":0.02`, `"layerRadiusStep":0.11`, 1), strings.Replace(ring, `"layerAmplitudeDecay":0.8`, `"layerAmplitudeDecay":0.4`, 1), strings.Replace(ring, `"layerAngleOffsetDeg":0`, `"layerAngleOffsetDeg":361`, 1), strings.Replace(ring, `"visibilityMode":"always"`, `"visibilityMode":"sometimes"`, 1), strings.Replace(ring, `"audioReactive":true`, `"audioReactive":"yes"`, 1), strings.Replace(ring, `"visibilityMode":"always","audioReactive":true`, `"visibilityMode":"triggered","audioReactive":false`, 1)} {
		if _, err := Decode([]byte(bad)); err == nil {
			t.Errorf("invalid layered Wave Ring accepted: %s", bad)
		}
	}
	legacyRadiusStep := strings.Replace(ring, `"layerRadiusStep":0.02`, `"layerRadiusStep":0.1`, 1)
	if _, err := Decode([]byte(legacyRadiusStep)); err != nil {
		t.Fatalf("legacy layerRadiusStep should remain accepted when its old radius rule is ignored: %v", err)
	}
}

func TestVisibilityModeLegacyAndReactiveCombination(t *testing.T) {
	if _, err := Decode([]byte(valid)); err != nil {
		t.Fatalf("legacy Blueprint rejected: %v", err)
	}
	validPair := strings.Replace(valid, `"color":"#ffffff"`, `"color":"#ffffff","visibilityMode":"always","audioReactive":false`, 1)
	if _, err := Decode([]byte(validPair)); err != nil {
		t.Fatalf("Always/non-reactive rejected: %v", err)
	}
	for _, bad := range []string{
		strings.Replace(valid, `"color":"#ffffff"`, `"color":"#ffffff","visibilityMode":"sometimes"`, 1),
		strings.Replace(valid, `"color":"#ffffff"`, `"color":"#ffffff","audioReactive":0`, 1),
		strings.Replace(valid, `"color":"#ffffff"`, `"color":"#ffffff","audioReactive":false`, 1),
	} {
		if _, err := Decode([]byte(bad)); err == nil {
			t.Errorf("invalid visibility configuration accepted: %s", bad)
		}
	}
}

func TestPhaseAEffectsRejectWrongParameterSets(t *testing.T) {
	raw := strings.Replace(valid, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, `"kind":"wave-ring","regionId":"r","color":"#ffffff","centerX":0.5,"centerY":0.5,"radius":0.28,"amplitude":0.08,"points":64,"lineWidth":0.012,"unexpected":1`, 1)
	if _, err := Decode([]byte(raw)); err == nil {
		t.Fatal("wave-ring accepted unknown effect parameter")
	}
}

func TestSpectrumEffectsValidateParameters(t *testing.T) {
	bars := strings.Replace(valid, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, `"kind":"spectrum-bars","regionId":"r","color":"#ffffff","barWidth":0.7,"spacing":0.1,"amplitudeScale":1.4,"glowIntensity":1,"segmented":true,"segmentsPerBar":12,"attackMs":35,"releaseMs":180`, 1)
	line := strings.Replace(valid, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, `"kind":"spectrum-line","regionId":"r","color":"#ffffff","amplitudeScale":1.5,"lineWidth":0.01,"smoothing":0.4,"glowIntensity":1.2,"attackMs":35,"releaseMs":180`, 1)
	for _, candidate := range []string{bars, line} {
		if _, err := Decode([]byte(candidate)); err != nil {
			t.Errorf("valid Spectrum Effect rejected: %v", err)
		}
	}
	for _, invalid := range []string{
		strings.Replace(bars, `"segmentsPerBar":12`, `"segmentsPerBar":1.5`, 1),
		strings.Replace(bars, `"segmented":true`, `"segmented":"yes"`, 1),
		strings.Replace(bars, `"attackMs":35`, `"attackMs":1001`, 1),
		strings.Replace(line, `"amplitudeScale":1.5`, `"amplitudeScale":3.1`, 1),
		strings.Replace(line, `"smoothing":0.4`, `"smoothing":1.1`, 1),
	} {
		if _, err := Decode([]byte(invalid)); err == nil {
			t.Errorf("invalid Spectrum Effect accepted: %s", invalid)
		}
	}
}

func TestParticleEffectsValidateAndRequireCompatibleBindings(t *testing.T) {
	burst := strings.Replace(valid, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, `"kind":"particle-burst","regionId":"r","color":"#ffffff","originX":0.5,"originY":0.5,"directionDeg":-90,"spreadDeg":100,"speedPxPerSec":120,"lifetimeMs":1200,"count":16,"sizePx":6`, 1)
	burst = strings.Replace(burst, `"source":"bass.envelope"`, `"source":"kick.events"`, 1)
	if _, err := Decode([]byte(burst)); err != nil {
		t.Fatalf("valid particle-burst rejected: %v", err)
	}
	for _, count := range []string{"1", "32", "64"} {
		candidate := strings.Replace(burst, `"count":16`, `"count":`+count, 1)
		if _, err := Decode([]byte(candidate)); err != nil {
			t.Errorf("particle-burst rejected count %s: %v", count, err)
		}
	}
	if _, err := Decode([]byte(strings.Replace(burst, `"count":16`, `"count":65`, 1))); err == nil {
		t.Fatal("particle-burst accepted count above 64")
	}
	if _, err := Decode([]byte(strings.Replace(burst, `"source":"kick.events"`, `"source":"bass.envelope"`, 1))); err != nil {
		t.Fatalf("particle-burst rejected continuous binding: %v", err)
	}

	trail := strings.Replace(valid, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, `"kind":"particle-trail","regionId":"r","color":"#ffffff","samples":48,"trailMs":1800,"sizePx":7,"amplitude":0.28`, 1)
	if _, err := Decode([]byte(trail)); err != nil {
		t.Fatalf("valid particle-trail rejected: %v", err)
	}
	if _, err := Decode([]byte(strings.Replace(trail, `"samples":48`, `"samples":7`, 1))); err == nil {
		t.Fatal("particle-trail accepted fewer than 8 samples")
	}
	if _, err := Decode([]byte(strings.Replace(trail, `"source":"bass.envelope"`, `"source":"kick.events"`, 1))); err != nil {
		t.Fatalf("particle-trail rejected event binding: %v", err)
	}
}

func TestParticleEnhancementFieldsValidateAndRemainOptional(t *testing.T) {
	particles := strings.Replace(valid, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, `"kind":"particles","regionId":"r","color":"#ffffff","count":64,"sizePx":4,"cycleMs":2200,"spread":0.78,"speedInfluence":0.9,"glowIntensity":1.1,"baselineOpacity":0.14`, 1)
	if _, err := Decode([]byte(particles)); err != nil {
		t.Fatalf("enhanced particles rejected: %v", err)
	}
	legacyParticles := strings.Replace(particles, `,"spread":0.78,"speedInfluence":0.9,"glowIntensity":1.1,"baselineOpacity":0.14`, "", 1)
	if _, err := Decode([]byte(legacyParticles)); err != nil {
		t.Fatalf("legacy particles without optional fields rejected: %v", err)
	}
	legacyAlways := strings.Replace(legacyParticles, `"kind":"particles"`, `"kind":"particles","visibilityMode":"always","audioReactive":false`, 1)
	if _, err := Decode([]byte(legacyAlways)); err != nil {
		t.Fatalf("legacy Always/non-reactive particles rejected: %v", err)
	}
	for _, invalid := range []string{
		strings.Replace(particles, `"count":64`, `"count":65`, 1),
		strings.Replace(particles, `"count":64`, `"count":64.5`, 1),
		strings.Replace(particles, `"spread":0.78`, `"spread":1.1`, 1),
		strings.Replace(particles, `"baselineOpacity":0.14`, `"baselineOpacity":0.5`, 1),
		strings.Replace(particles, `"speedInfluence":0.9`, `"speedInfluence":"fast"`, 1),
	} {
		if _, err := Decode([]byte(invalid)); err == nil {
			t.Errorf("invalid particle settings accepted: %s", invalid)
		}
	}
	for _, count := range []string{"1", "32", "64"} {
		candidate := strings.Replace(particles, `"count":64`, `"count":`+count, 1)
		if _, err := Decode([]byte(candidate)); err != nil {
			t.Errorf("particles rejected count %s: %v", count, err)
		}
	}

	burst := strings.Replace(valid, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, `"kind":"particle-burst","regionId":"r","color":"#ffffff","originX":0.5,"originY":0.5,"directionDeg":0,"spreadDeg":90,"speedPxPerSec":420,"lifetimeMs":1500,"count":64,"sizePx":7,"swirl":0.55,"audioInfluence":1,"baselineOpacity":0.12`, 1)
	burst = strings.Replace(burst, `"source":"bass.envelope"`, `"source":"kick.events"`, 1)
	if _, err := Decode([]byte(burst)); err != nil {
		t.Fatalf("enhanced particle-burst rejected: %v", err)
	}
	for _, invalid := range []string{
		strings.Replace(burst, `"count":64`, `"count":65`, 1),
		strings.Replace(burst, `"swirl":0.55`, `"swirl":2.1`, 1),
		strings.Replace(burst, `"audioInfluence":1`, `"audioInfluence":-0.1`, 1),
		strings.Replace(burst, `"baselineOpacity":0.12`, `"baselineOpacity":0.4`, 1),
		strings.Replace(burst, `"audioInfluence":1`, `"audioInfluence":"loud"`, 1),
	} {
		if _, err := Decode([]byte(invalid)); err == nil {
			t.Errorf("invalid burst settings accepted: %s", invalid)
		}
	}
}

func TestRippleShockwaveAndOptionalGlowIntensity(t *testing.T) {
	cases := []struct {
		kind, effect, source string
	}{
		{"ripple", `"kind":"ripple","regionId":"r","color":"#ffffff","centerX":0.5,"centerY":0.5,"waves":3,"periodMs":1600,"radius":0.34,"amplitude":0.08,"lineWidth":0.012`, `"source":"bass.envelope"`},
		{"shockwave", `"kind":"shockwave","regionId":"r","color":"#ffffff","centerX":0.5,"centerY":0.5,"maxRadius":0.42,"lifetimeMs":1000,"lineWidth":0.018`, `"source":"kick.events"`},
	}
	for _, tc := range cases {
		raw := strings.Replace(valid, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, tc.effect, 1)
		raw = strings.Replace(raw, `"source":"bass.envelope"`, tc.source, 1)
		if _, err := Decode([]byte(raw)); err != nil {
			t.Errorf("valid %s rejected: %v", tc.kind, err)
		}
		wrong := strings.Replace(raw, tc.source, `"source":"`+map[string]string{"ripple": "kick.events", "shockwave": "bass.envelope"}[tc.kind]+`"`, 1)
		if _, err := Decode([]byte(wrong)); err != nil {
			t.Errorf("%s rejected converted Binding source: %v", tc.kind, err)
		}
	}
	ripple := strings.Replace(valid, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, cases[0].effect, 1)
	if _, err := Decode([]byte(strings.Replace(ripple, `"waves":3`, `"waves":7`, 1))); err == nil {
		t.Fatal("ripple accepted too many waves")
	}
	legacyGlow := strings.Replace(valid, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, `"kind":"glow-brightness","regionId":"r","color":"#ffffff","blurPx":20,"brightness":1.2`, 1)
	if _, err := Decode([]byte(legacyGlow)); err != nil {
		t.Fatalf("legacy Glow without optional intensity rejected: %v", err)
	}
	newGlow := strings.Replace(legacyGlow, `"brightness":1.2`, `"brightness":1.2,"glowIntensity":1.5`, 1)
	if _, err := Decode([]byte(newGlow)); err != nil {
		t.Fatalf("Glow intensity rejected: %v", err)
	}
	if _, err := Decode([]byte(strings.Replace(newGlow, `"glowIntensity":1.5`, `"glowIntensity":2.1`, 1))); err == nil {
		t.Fatal("Glow intensity above range accepted")
	}
}

func TestOscilloscopeLineV1AndEnhancedOptionalParameters(t *testing.T) {
	base := strings.Replace(valid, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, `"kind":"oscilloscope-line","regionId":"r","color":"#ffffff","orientation":"radial","lineWidth":0.012,"sampleCount":256,"amplitudeScale":0.8,"glowIntensity":1.5`, 1)
	if _, err := Decode([]byte(base)); err != nil {
		t.Fatalf("valid oscilloscope-line rejected: %v", err)
	}
	for _, invalid := range []string{
		strings.Replace(base, `"orientation":"radial"`, `"orientation":"vertical"`, 1),
		strings.Replace(base, `"sampleCount":256`, `"sampleCount":31`, 1),
	} {
		if _, err := Decode([]byte(invalid)); err == nil {
			t.Errorf("invalid oscilloscope-line accepted: %s", invalid)
		}
	}

	radial := strings.Replace(valid, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, `"kind":"radial-bars","regionId":"r","color":"#ffffff","centerX":0.5,"centerY":0.5,"radius":0.2,"bars":32,"barLength":0.16,"lineWidth":0.6,"barWidth":0.4,"spikeSharpness":0.9,"innerRadius":0.12,"amplitudeScale":1.8,"glowIntensity":1.4`, 1)
	if _, err := Decode([]byte(radial)); err != nil {
		t.Fatalf("enhanced radial-bars rejected: %v", err)
	}
	if _, err := Decode([]byte(strings.Replace(radial, `"innerRadius":0.12`, `"innerRadius":0.21`, 1))); err == nil {
		t.Fatal("radial innerRadius beyond radius accepted")
	}
}

func TestWaveformPeakEffectsAndAllSevenSources(t *testing.T) {
	effects := []string{
		`"kind":"waveform-line","regionId":"r","color":"#ffffff","orientation":"horizontal","sampleCount":128,"amplitudeScale":1,"lineWidth":0.01,"glowIntensity":0.5`,
		`"kind":"waveform-peak-bars","regionId":"r","color":"#ffffff","bars":64,"barWidth":0.8,"spacing":0.1,"amplitudeScale":1,"glowIntensity":0.5`,
		`"kind":"waveform-ring","regionId":"r","color":"#ffffff","radius":0.28,"sampleCount":128,"amplitudeScale":1,"lineWidth":0.01,"smoothing":0.6,"glowIntensity":0.5`,
	}
	sources := []string{"bass.envelope", "kick.events", "snare.events", "drums.energy", "vocals.envelope", "other.envelope", "music.energy"}
	for _, effect := range effects {
		for _, source := range sources {
			raw := strings.Replace(valid, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, effect, 1)
			raw = strings.Replace(raw, `"source":"bass.envelope"`, `"source":"`+source+`"`, 1)
			if _, err := Decode([]byte(raw)); err != nil {
				t.Errorf("Effect %s rejected source %s: %v", effect[:20], source, err)
			}
		}
	}
	invalid := strings.Replace(valid, `"kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1`, effects[2], 1)
	if _, err := Decode([]byte(strings.Replace(invalid, `"smoothing":0.6`, `"smoothing":1.2`, 1))); err == nil {
		t.Fatal("waveform-ring accepted invalid smoothing")
	}
}
