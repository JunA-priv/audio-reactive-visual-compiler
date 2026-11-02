package blueprint

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
)

const (
	MaxRegions  = 32
	MaxEffects  = 32
	MaxBindings = 32
)

var colorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$`)

type Blueprint struct {
	Version        int               `json:"version"`
	Width          int               `json:"width"`
	Height         int               `json:"height"`
	Seed           json.Number       `json:"seed"`
	Background     json.RawMessage   `json:"background"`
	GlobalGradient json.RawMessage   `json:"globalGradient,omitempty"`
	Regions        []json.RawMessage `json:"regions"`
	Effects        []json.RawMessage `json:"effects"`
	Bindings       []json.RawMessage `json:"bindings"`
}

func Decode(data []byte) (Blueprint, error) {
	var b Blueprint
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil {
		return b, fmt.Errorf("invalid blueprint JSON: %w", err)
	}
	if err := ensureEOF(dec); err != nil {
		return b, err
	}
	if err := Validate(b); err != nil {
		return b, err
	}
	return b, nil
}

func ensureEOF(dec *json.Decoder) error {
	var extra any
	if err := dec.Decode(&extra); err == io.EOF {
		return nil
	} else if err == nil {
		return errors.New("invalid JSON: multiple values")
	} else {
		return fmt.Errorf("invalid trailing JSON: %w", err)
	}
}

func object(raw json.RawMessage, required []string, optional ...string) (map[string]any, error) {
	var m map[string]any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if err := d.Decode(&m); err != nil || m == nil {
		return nil, errors.New("expected object")
	}
	allowed := map[string]bool{}
	for _, k := range required {
		allowed[k] = true
		if _, ok := m[k]; !ok {
			return nil, fmt.Errorf("missing field %q", k)
		}
	}
	for _, k := range optional {
		allowed[k] = true
	}
	for k := range m {
		if !allowed[k] {
			return nil, fmt.Errorf("unknown field %q", k)
		}
	}
	return m, nil
}

func number(v any, name string, min, max float64) (float64, error) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, fmt.Errorf("%s must be a number", name)
	}
	x, err := n.Float64()
	if err != nil || math.IsNaN(x) || math.IsInf(x, 0) || x < min || x > max {
		return 0, fmt.Errorf("%s is outside the allowed range", name)
	}
	return x, nil
}
func integer(v any, name string, min, max int64) (int64, error) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, fmt.Errorf("%s must be an integer", name)
	}
	i, err := n.Int64()
	if err != nil || i < min || i > max {
		return 0, fmt.Errorf("%s is outside the allowed range", name)
	}
	return i, nil
}
func str(v any, name string) (string, error) {
	s, ok := v.(string)
	if !ok || s == "" {
		return "", fmt.Errorf("%s must be a non-empty string", name)
	}
	return s, nil
}
func checkColor(v any, name string) error {
	s, ok := v.(string)
	if !ok || !colorPattern.MatchString(s) {
		return fmt.Errorf("%s must be a hex color", name)
	}
	return nil
}

func Validate(b Blueprint) error {
	if b.Version != 1 {
		return errors.New("unsupported blueprint version")
	}
	if b.Width < 1 || b.Width > 4096 || b.Height < 1 || b.Height > 4096 {
		return errors.New("canvas dimensions must be in 1..4096")
	}
	if _, err := number(b.Seed, "seed", -2147483648, 2147483647); err != nil {
		return err
	}
	if len(b.Regions) > MaxRegions || len(b.Effects) > MaxEffects || len(b.Bindings) > MaxBindings {
		return errors.New("blueprint element limit exceeded")
	}
	if err := validateBackground(b.Background); err != nil {
		return err
	}
	if len(b.GlobalGradient) > 0 {
		if bytes.Equal(bytes.TrimSpace(b.GlobalGradient), []byte("null")) {
			return errors.New("globalGradient must not be null")
		}
		if err := validateGlobalGradient(b.GlobalGradient); err != nil {
			return err
		}
	}
	regions := map[string]bool{}
	for _, raw := range b.Regions {
		id, err := validateRegion(raw)
		if err != nil {
			return err
		}
		if regions[id] {
			return fmt.Errorf("duplicate region id %q", id)
		}
		regions[id] = true
	}
	effects := map[string]bool{}
	for _, raw := range b.Effects {
		id, region, err := validateEffect(raw)
		if err != nil {
			return err
		}
		if effects[id] {
			return fmt.Errorf("duplicate effect id %q", id)
		}
		if !regions[region] {
			return fmt.Errorf("effect references missing region %q", region)
		}
		effects[id] = true
	}
	bound := map[string]bool{}
	bindingIDs := map[string]bool{}
	for _, raw := range b.Bindings {
		id, effect, err := validateBinding(raw)
		if err != nil {
			return err
		}
		if bindingIDs[id] {
			return fmt.Errorf("duplicate binding id %q", id)
		}
		if !effects[effect] {
			return fmt.Errorf("binding references missing effect %q", effect)
		}
		if bound[effect] {
			return fmt.Errorf("multiple bindings for effect %q", effect)
		}
		bindingIDs[id], bound[effect] = true, true
	}
	if len(bound) != len(effects) {
		return errors.New("every effect must have exactly one binding")
	}
	return nil
}

func validateBackground(raw json.RawMessage) error {
	m, err := object(raw, []string{"kind"}, "color", "from", "to", "angleDeg")
	if err != nil {
		return fmt.Errorf("background: %w", err)
	}
	k, _ := str(m["kind"], "background.kind")
	switch k {
	case "solid":
		if len(m) != 2 {
			return errors.New("solid background requires only kind and color")
		}
		return checkColor(m["color"], "background.color")
	case "gradient":
		if len(m) != 4 {
			return errors.New("gradient background requires kind, from, to, angleDeg")
		}
		if err := checkColor(m["from"], "background.from"); err != nil {
			return err
		}
		if err := checkColor(m["to"], "background.to"); err != nil {
			return err
		}
		_, err = number(m["angleDeg"], "background.angleDeg", 0, 360)
		return err
	case "image":
		return errors.New("AI Blueprint image backgrounds are not supported; choose solid or gradient")
	default:
		return errors.New("unsupported background kind")
	}
}

func validateGlobalGradient(raw json.RawMessage) error {
	m, err := object(raw, []string{"startColor", "middleColor", "endColor", "angleDeg"})
	if err != nil {
		return fmt.Errorf("globalGradient: %w", err)
	}
	for _, key := range []string{"startColor", "middleColor", "endColor"} {
		if err := checkColor(m[key], "globalGradient."+key); err != nil {
			return err
		}
	}
	_, err = number(m["angleDeg"], "globalGradient.angleDeg", 0, 360)
	return err
}

func validateRegion(raw json.RawMessage) (string, error) {
	m, err := object(raw, []string{"id", "name", "geometry"})
	if err != nil {
		return "", fmt.Errorf("region: %w", err)
	}
	id, err := str(m["id"], "region.id")
	if err != nil {
		return "", err
	}
	if _, err = str(m["name"], "region.name"); err != nil {
		return "", err
	}
	geoRaw, _ := json.Marshal(m["geometry"])
	g, err := object(geoRaw, []string{"kind"}, "x", "y", "width", "height", "points")
	if err != nil {
		return "", fmt.Errorf("region %s geometry: %w", id, err)
	}
	kind, _ := str(g["kind"], "geometry.kind")
	if kind == "rect" {
		if len(g) != 5 {
			return "", errors.New("rect geometry requires x, y, width, height")
		}
		x, e := number(g["x"], "x", 0, 1)
		if e != nil {
			return "", e
		}
		y, e := number(g["y"], "y", 0, 1)
		if e != nil {
			return "", e
		}
		w, e := number(g["width"], "width", 0, 1)
		if e != nil {
			return "", e
		}
		h, e := number(g["height"], "height", 0, 1)
		if e != nil {
			return "", e
		}
		if w == 0 || h == 0 || x+w > 1 || y+h > 1 {
			return "", errors.New("rect must have positive size inside normalized bounds")
		}
	} else if kind == "polygon" {
		if len(g) != 2 {
			return "", errors.New("polygon geometry requires points only")
		}
		p, ok := g["points"].([]any)
		if !ok || len(p) < 3 || len(p) > 64 {
			return "", errors.New("polygon must have 3..64 points")
		}
		coords := make([][2]float64, 0, len(p))
		for _, item := range p {
			pointRaw, _ := json.Marshal(item)
			point, e := object(pointRaw, []string{"x", "y"})
			if e != nil {
				return "", e
			}
			x, e := number(point["x"], "point.x", 0, 1)
			if e != nil {
				return "", e
			}
			y, e := number(point["y"], "point.y", 0, 1)
			if e != nil {
				return "", e
			}
			coords = append(coords, [2]float64{x, y})
		}
		area := 0.0
		for i, point := range coords {
			next := coords[(i+1)%len(coords)]
			area += point[0]*next[1] - next[0]*point[1]
		}
		if math.Abs(area) < 1e-8 {
			return "", errors.New("polygon area must be non-zero")
		}
	} else {
		return "", errors.New("unsupported geometry kind")
	}
	return id, nil
}

func validateEffect(raw json.RawMessage) (string, string, error) {
	m, err := object(raw, []string{"id", "kind", "regionId", "color"}, "opacity", "visibilityMode", "audioReactive", "colorMode", "customPalette", "baseScale", "maxScale", "blurPx", "brightness", "glowIntensity", "rotationDeg", "moveX", "moveY", "count", "sizePx", "cycleMs", "bars", "lineWidth", "centerX", "centerY", "radius", "barLength", "amplitude", "points", "originX", "originY", "directionDeg", "spreadDeg", "speedPxPerSec", "lifetimeMs", "samples", "trailMs", "waves", "periodMs", "maxRadius", "barWidth", "spikeSharpness", "innerRadius", "amplitudeScale", "sampleCount", "jaggedness", "opacityBoost", "coreBrightness", "lengthScale", "orientation", "smoothing", "spacing", "rotationMode", "beatsPerRevolution", "rotationDirection", "initialAngleDeg", "layerCount", "layerRadiusStep", "layerAngleOffsetDeg", "layerAmplitudeDecay", "segmented", "segmentsPerBar", "attackMs", "releaseMs", "spread", "speedInfluence", "audioInfluence", "swirl", "baselineOpacity", "diffusionSpeed", "flowStrength", "turbulence", "inkDensity", "cloudScale", "responseTime")
	if err != nil {
		return "", "", fmt.Errorf("effect: %w", err)
	}
	id, err := str(m["id"], "effect.id")
	if err != nil {
		return "", "", err
	}
	region, err := str(m["regionId"], "effect.regionId")
	if err != nil {
		return "", "", err
	}
	kind, err := str(m["kind"], "effect.kind")
	if err != nil {
		return "", "", err
	}
	if err = checkColor(m["color"], "effect.color"); err != nil {
		return "", "", err
	}
	if rawMode, ok := m["colorMode"]; ok {
		mode, modeErr := str(rawMode, "effect.colorMode")
		if modeErr != nil || (mode != "global-gradient" && mode != "custom") {
			return "", "", errors.New("effect.colorMode must be global-gradient or custom")
		}
	}
	if rawOpacity, ok := m["opacity"]; ok {
		if _, opacityErr := number(rawOpacity, "opacity", 0, 1); opacityErr != nil {
			return "", "", opacityErr
		}
	}
	if rawMode, ok := m["visibilityMode"]; ok {
		mode, modeErr := str(rawMode, "visibilityMode")
		if modeErr != nil || (mode != "triggered" && mode != "always") {
			return "", "", errors.New("visibilityMode must be triggered or always")
		}
	}
	if rawReactive, ok := m["audioReactive"]; ok {
		reactive, isBool := rawReactive.(bool)
		if !isBool {
			return "", "", errors.New("audioReactive must be boolean")
		}
		mode, _ := m["visibilityMode"].(string)
		if !reactive && mode != "always" {
			return "", "", errors.New("audioReactive=false requires visibilityMode=always")
		}
	}
	params := map[string][2]float64{}
	extraRequired := 0
	switch kind {
	case "pulse-scale":
		params = map[string][2]float64{"baseScale": {0, 4}, "maxScale": {0, 4}}
	case "glow-brightness":
		params = map[string][2]float64{"blurPx": {0, 100}, "brightness": {0, 3}}
		if _, ok := m["glowIntensity"]; ok {
			params["glowIntensity"] = [2]float64{0, 2}
		}
	case "rotation-movement":
		params = map[string][2]float64{"rotationDeg": {-360, 360}, "moveX": {-1, 1}, "moveY": {-1, 1}}
	case "particles":
		params = map[string][2]float64{"count": {1, 64}, "sizePx": {0.000001, 100}, "cycleMs": {100, 60000}}
		for key, limits := range map[string][2]float64{"spread": {0.1, 1}, "speedInfluence": {0, 2}, "glowIntensity": {0, 2}, "baselineOpacity": {0, 0.35}} {
			if _, ok := m[key]; ok {
				params[key] = limits
			}
		}
	case "waveform-bars":
		params = map[string][2]float64{"bars": {2, 128}, "lineWidth": {0.000001, 1}}
	case "waveform-line":
		params = map[string][2]float64{"sampleCount": {16, 512}, "amplitudeScale": {0.1, 2}, "lineWidth": {0.001, 0.05}, "glowIntensity": {0, 2}}
		extraRequired = 1
		orientation, e := str(m["orientation"], "orientation")
		if e != nil || (orientation != "horizontal" && orientation != "vertical") {
			return "", "", errors.New("waveform-line orientation must be horizontal or vertical")
		}
	case "waveform-peak-bars":
		params = map[string][2]float64{"bars": {2, 256}, "barWidth": {0.1, 1}, "spacing": {0, 0.5}, "amplitudeScale": {0.1, 2}, "glowIntensity": {0, 2}}
	case "spectrum-bars":
		params = map[string][2]float64{"barWidth": {0.2, 1}, "spacing": {0, 0.5}, "amplitudeScale": {0.1, 3}, "glowIntensity": {0, 2}}
		for key, limits := range map[string][2]float64{"segmentsPerBar": {1, 24}, "attackMs": {0, 1000}, "releaseMs": {0, 3000}} {
			if _, ok := m[key]; ok {
				params[key] = limits
			}
		}
		if raw, ok := m["segmented"]; ok {
			if _, isBool := raw.(bool); !isBool {
				return "", "", errors.New("spectrum-bars segmented must be boolean")
			}
		}
	case "spectrum-line":
		params = map[string][2]float64{"amplitudeScale": {0.1, 3}, "lineWidth": {0.001, 0.05}, "smoothing": {0, 1}, "glowIntensity": {0, 2}}
		for key, limits := range map[string][2]float64{"attackMs": {0, 1000}, "releaseMs": {0, 3000}} {
			if _, ok := m[key]; ok {
				params[key] = limits
			}
		}
	case "waveform-ring":
		params = map[string][2]float64{"radius": {0.05, 0.45}, "sampleCount": {16, 512}, "amplitudeScale": {0.1, 2}, "lineWidth": {0.001, 0.05}, "smoothing": {0, 1}, "glowIntensity": {0, 2}}
	case "radial-bars":
		params = map[string][2]float64{"centerX": {0, 1}, "centerY": {0, 1}, "radius": {0.05, 0.45}, "bars": {8, 128}, "barLength": {0.02, 0.3}, "lineWidth": {0.05, 1}}
		for key, limits := range map[string][2]float64{"barWidth": {0.05, 1}, "spikeSharpness": {0, 1}, "innerRadius": {0.02, 0.45}, "amplitudeScale": {0.1, 3}, "glowIntensity": {0, 2}} {
			if _, ok := m[key]; ok {
				params[key] = limits
			}
		}
	case "wave-ring":
		params = map[string][2]float64{"centerX": {0, 1}, "centerY": {0, 1}, "radius": {0.05, 0.45}, "amplitude": {0, 0.2}, "points": {16, 128}, "lineWidth": {0.003, 0.05}}
		for key, limits := range map[string][2]float64{"amplitudeScale": {0.1, 4}, "jaggedness": {0, 1}, "smoothing": {0, 1}, "glowIntensity": {0, 2}} {
			if _, ok := m[key]; ok {
				params[key] = limits
			}
		}
		if _, ok := m["sampleCount"]; ok {
			params["sampleCount"] = [2]float64{24, 256}
		}
		for key, limits := range map[string][2]float64{"layerCount": {1, 10}, "layerRadiusStep": {0, 0.1}, "layerAngleOffsetDeg": {0, 360}, "layerAmplitudeDecay": {0.5, 1}} {
			if _, ok := m[key]; ok {
				params[key] = limits
			}
		}
	case "particle-burst":
		params = map[string][2]float64{"originX": {0, 1}, "originY": {0, 1}, "directionDeg": {-360, 360}, "spreadDeg": {0, 360}, "speedPxPerSec": {0, 1000}, "lifetimeMs": {100, 5000}, "count": {1, 64}, "sizePx": {1, 32}}
		for key, limits := range map[string][2]float64{"glowIntensity": {0, 2}, "opacityBoost": {0.5, 2}, "coreBrightness": {0, 2}, "swirl": {-2, 2}, "audioInfluence": {0, 2}, "baselineOpacity": {0, 0.35}} {
			if _, ok := m[key]; ok {
				params[key] = limits
			}
		}
	case "particle-trail":
		params = map[string][2]float64{"samples": {8, 128}, "trailMs": {100, 5000}, "sizePx": {1, 32}, "amplitude": {0, 0.5}}
		for key, limits := range map[string][2]float64{"glowIntensity": {0, 2}, "opacityBoost": {0.5, 2}, "lengthScale": {0.25, 1.5}} {
			if _, ok := m[key]; ok {
				params[key] = limits
			}
		}
	case "ripple":
		params = map[string][2]float64{"centerX": {0, 1}, "centerY": {0, 1}, "waves": {1, 6}, "periodMs": {250, 4000}, "radius": {0.05, 0.45}, "amplitude": {0, 0.2}, "lineWidth": {0.003, 0.05}}
		for key, limits := range map[string][2]float64{"glowIntensity": {0, 2}, "opacityBoost": {0.5, 2}} {
			if _, ok := m[key]; ok {
				params[key] = limits
			}
		}
	case "shockwave":
		params = map[string][2]float64{"centerX": {0, 1}, "centerY": {0, 1}, "maxRadius": {0.05, 0.5}, "lifetimeMs": {100, 5000}, "lineWidth": {0.003, 0.05}}
		for key, limits := range map[string][2]float64{"glowIntensity": {0, 2}, "opacityBoost": {0.5, 2}} {
			if _, ok := m[key]; ok {
				params[key] = limits
			}
		}
	case "oscilloscope-line":
		params = map[string][2]float64{"lineWidth": {0.001, 0.05}, "sampleCount": {32, 512}, "amplitudeScale": {0.1, 1}, "glowIntensity": {0, 2}}
		extraRequired = 1
		orientation, e := str(m["orientation"], "orientation")
		if e != nil || (orientation != "horizontal" && orientation != "radial") {
			return "", "", errors.New("oscilloscope orientation must be horizontal or radial")
		}
	case "ink-diffusion", "ink-flow", "color-mixing":
		for key, limits := range map[string][2]float64{"diffusionSpeed": {0, 2}, "flowStrength": {0, 2}, "turbulence": {0, 2}, "inkDensity": {0, 1}, "cloudScale": {0.1, 2}, "responseTime": {0.5, 10}} {
			if _, ok := m[key]; ok {
				params[key] = limits
			}
		}
	default:
		return "", "", errors.New("unsupported effect kind")
	}
	rotationKeys := []string{"rotationMode", "beatsPerRevolution", "rotationDirection", "initialAngleDeg"}
	rotationCount := 0
	for _, key := range rotationKeys {
		if _, exists := m[key]; exists {
			rotationCount++
		}
	}
	if rotationCount != 0 {
		if kind != "radial-bars" && kind != "wave-ring" && kind != "waveform-ring" || rotationCount != len(rotationKeys) {
			return "", "", errors.New("rotation settings require a circular effect and all four fields")
		}
		mode, modeErr := str(m["rotationMode"], "rotationMode")
		direction, directionErr := str(m["rotationDirection"], "rotationDirection")
		beats, beatsErr := number(m["beatsPerRevolution"], "beatsPerRevolution", 4, 32)
		if modeErr != nil || (mode != "continuous" && mode != "triggered") || directionErr != nil || (direction != "clockwise" && direction != "counterclockwise") || beatsErr != nil || (beats != 4 && beats != 8 && beats != 16 && beats != 32) {
			return "", "", errors.New("invalid circular rotation mode, beat count, or direction")
		}
		if _, angleErr := number(m["initialAngleDeg"], "initialAngleDeg", -360, 360); angleErr != nil {
			return "", "", angleErr
		}
	}
	expectedFields := 4 + len(params) + extraRequired
	if rawPalette, ok := m["customPalette"]; ok {
		if kind != "color-mixing" {
			return "", "", errors.New("customPalette is only valid for color-mixing")
		}
		palette, ok := rawPalette.([]any)
		if !ok || len(palette) < 2 || len(palette) > 4 {
			return "", "", errors.New("customPalette must contain 2 to 4 HEX colors")
		}
		for index, color := range palette {
			value, ok := color.(string)
			if !ok {
				return "", "", fmt.Errorf("customPalette[%d] must be a HEX color", index)
			}
			if err := checkColor(value, fmt.Sprintf("customPalette[%d]", index)); err != nil {
				return "", "", err
			}
			if len(value) != 7 {
				return "", "", errors.New("customPalette colors must use #RRGGBB")
			}
		}
		expectedFields++
	}
	if _, ok := m["opacity"]; ok {
		expectedFields++
	}
	if _, ok := m["visibilityMode"]; ok {
		expectedFields++
	}
	if _, ok := m["audioReactive"]; ok {
		expectedFields++
	}
	if _, ok := m["colorMode"]; ok {
		expectedFields++
	}
	if _, ok := m["segmented"]; ok {
		expectedFields++
	}
	expectedFields += rotationCount
	if len(m) != expectedFields {
		return "", "", fmt.Errorf("effect %s has missing or irrelevant parameters", id)
	}
	for key, r := range params {
		v, ok := m[key]
		if !ok {
			return "", "", fmt.Errorf("effect %s missing %s", id, key)
		}
		n, e := number(v, key, r[0], r[1])
		if e != nil {
			return "", "", e
		}
		if (key == "count" || key == "bars" || key == "points" || key == "samples" || key == "waves" || key == "sampleCount" || key == "layerCount" || key == "segmentsPerBar") && math.Trunc(n) != n {
			return "", "", fmt.Errorf("%s must be integer", key)
		}
		if kind == "pulse-scale" && key == "maxScale" {
			base, _ := number(m["baseScale"], "baseScale", 0, 4)
			if n < base {
				return "", "", errors.New("maxScale must be >= baseScale")
			}
		}
		if kind == "radial-bars" && key == "innerRadius" {
			radius, _ := number(m["radius"], "radius", 0.05, 0.45)
			if n > radius {
				return "", "", errors.New("innerRadius must not exceed radius")
			}
		}
	}
	return id, region, nil
}

func validateBinding(raw json.RawMessage) (string, string, error) {
	m, err := object(raw, []string{"id", "effectId", "source", "strength", "threshold", "attackMs", "releaseMs"})
	if err != nil {
		return "", "", fmt.Errorf("binding: %w", err)
	}
	id, e := str(m["id"], "binding.id")
	if e != nil {
		return "", "", e
	}
	effect, e := str(m["effectId"], "binding.effectId")
	if e != nil {
		return "", "", e
	}
	source, e := str(m["source"], "binding.source")
	if e != nil {
		return "", "", e
	}
	if source != "bass.envelope" && source != "kick.events" && source != "snare.events" && source != "drums.energy" && source != "vocals.envelope" && source != "other.envelope" && source != "music.energy" {
		return "", "", errors.New("unsupported binding source")
	}
	for key, r := range map[string][2]float64{"strength": {0, 1}, "threshold": {0, 1}, "attackMs": {0, 5000}, "releaseMs": {0, 10000}} {
		if _, e = number(m[key], key, r[0], r[1]); e != nil {
			return "", "", e
		}
	}
	return id, effect, nil
}
