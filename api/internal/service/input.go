package service

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strings"
)

const (
	MaxBodyBytes      = 2 << 20
	MaxTimelinePoints = 50000
	MaxKickEvents     = 20000
	MaxWaveformPeaks  = 12000
	MaxSpectrumFrames = 12000
	SpectrumBandCount = 32
)

type FeaturePoint struct {
	TimeMs float64 `json:"timeMs"`
	Value  float64 `json:"value"`
}
type WaveformPeak struct {
	Min float64 `json:"min"`
	Max float64 `json:"max"`
}
type WaveformPeaks struct {
	SampleIntervalMs int            `json:"sampleIntervalMs"`
	WindowSamples    int            `json:"windowSamples"`
	Normalization    string         `json:"normalization"`
	Music            []WaveformPeak `json:"music"`
	Drums            []WaveformPeak `json:"drums"`
	Bass             []WaveformPeak `json:"bass"`
	Vocals           []WaveformPeak `json:"vocals"`
	Other            []WaveformPeak `json:"other"`
}
type FrequencySpectrum struct {
	HopMs         int     `json:"hopMs"`
	FFTSize       int     `json:"fftSize"`
	BandCount     int     `json:"bandCount"`
	SampleRateHz  int     `json:"sampleRateHz"`
	MinHz         float64 `json:"minHz"`
	MaxHz         float64 `json:"maxHz"`
	Normalization string  `json:"normalization"`
	Encoding      string  `json:"encoding"`
	Values        []int   `json:"values"`
}
type Timeline struct {
	DurationMs         int64              `json:"durationMs"`
	BPM                *float64           `json:"bpm,omitempty"`
	BPMSource          string             `json:"bpmSource,omitempty"`
	BassEnvelope       []FeaturePoint     `json:"bassEnvelope"`
	KickEvents         []float64          `json:"kickEvents"`
	KickEventStrengths []float64          `json:"kickEventStrengths,omitempty"`
	DrumEnergy         []FeaturePoint     `json:"drumEnergy,omitempty"`
	SnareEvents        []float64          `json:"snareEvents,omitempty"`
	SnareStrengths     []float64          `json:"snareEventStrengths,omitempty"`
	VocalsEnvelope     []FeaturePoint     `json:"vocalsEnvelope,omitempty"`
	OtherEnvelope      []FeaturePoint     `json:"otherEnvelope,omitempty"`
	MusicEnergy        []FeaturePoint     `json:"musicEnergy,omitempty"`
	WaveformPeaks      *WaveformPeaks     `json:"waveformPeaks,omitempty"`
	FrequencySpectrum  *FrequencySpectrum `json:"frequencySpectrum,omitempty"`
	SchemaVersion      int                `json:"schemaVersion"`
}
type Summary struct {
	SummaryVersion int   `json:"summaryVersion"`
	DurationMs     int64 `json:"durationMs"`
	SourceAudio    struct {
		Format       string `json:"format"`
		Codec        string `json:"codec"`
		SampleRateHz int    `json:"sampleRateHz"`
		Channels     int    `json:"channels"`
		FileBytes    int64  `json:"fileBytes"`
	} `json:"sourceAudio"`
	Analysis struct {
		Model               string             `json:"model"`
		Device              string             `json:"device"`
		StemRms             map[string]float64 `json:"stemRms"`
		EstimatedKickCount  int                `json:"estimatedKickCount"`
		FeatureSampleRateHz float64            `json:"featureSampleRateHz"`
		KickDetection       string             `json:"kickDetection"`
	} `json:"analysis"`
}
type Request struct {
	MusicSummary    json.RawMessage `json:"musicSummary"`
	FeatureTimeline json.RawMessage `json:"featureTimeline"`
	VisualIntent    string          `json:"visualIntent,omitempty"`
}
type CompactFeatures struct {
	DurationMs    int64          `json:"durationMs"`
	BPM           float64        `json:"bpm"`
	BPMSource     string         `json:"bpmSource"`
	SampleRateHz  float64        `json:"featureSampleRateHz"`
	BassMin       float64        `json:"bassMin"`
	BassMax       float64        `json:"bassMax"`
	BassMean      float64        `json:"bassMean"`
	BassSamples   []FeaturePoint `json:"bassSamples"`
	KickCount     int            `json:"kickCount"`
	KickSamplesMs []float64      `json:"kickSamplesMs"`
}

func decodeOne(data []byte, target any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	if err := d.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := d.Decode(&extra); err == io.EOF {
		return nil
	} else if err == nil {
		return errors.New("multiple JSON values")
	} else {
		return err
	}
}

func ValidateInput(req Request) (Summary, Timeline, CompactFeatures, error) {
	var s Summary
	var t Timeline
	var compact CompactFeatures
	if len(req.MusicSummary) == 0 || len(req.FeatureTimeline) == 0 {
		return s, t, compact, errors.New("musicSummary and featureTimeline are required")
	}
	if err := decodeOne(req.MusicSummary, &s); err != nil {
		return s, t, compact, errors.New("invalid musicSummary JSON")
	}
	if err := decodeOne(req.FeatureTimeline, &t); err != nil {
		return s, t, compact, errors.New("invalid featureTimeline JSON")
	}
	var sm, tm map[string]json.RawMessage
	_ = json.Unmarshal(req.MusicSummary, &sm)
	_ = json.Unmarshal(req.FeatureTimeline, &tm)
	for _, key := range []string{"summaryVersion", "durationMs", "sourceAudio", "analysis"} {
		if _, ok := sm[key]; !ok {
			return s, t, compact, fmt.Errorf("musicSummary.%s is required", key)
		}
	}
	for _, key := range []string{"schemaVersion", "durationMs", "bassEnvelope", "kickEvents"} {
		if _, ok := tm[key]; !ok {
			return s, t, compact, fmt.Errorf("featureTimeline.%s is required", key)
		}
	}
	var sourceFields, analysisFields map[string]json.RawMessage
	_ = json.Unmarshal(sm["sourceAudio"], &sourceFields)
	_ = json.Unmarshal(sm["analysis"], &analysisFields)
	for _, key := range []string{"format", "codec", "sampleRateHz", "channels", "fileBytes"} {
		if _, ok := sourceFields[key]; !ok {
			return s, t, compact, fmt.Errorf("musicSummary.sourceAudio.%s is required", key)
		}
	}
	for _, key := range []string{"model", "device", "stemRms", "estimatedKickCount", "featureSampleRateHz", "kickDetection"} {
		if _, ok := analysisFields[key]; !ok {
			return s, t, compact, fmt.Errorf("musicSummary.analysis.%s is required", key)
		}
	}
	if unit, ok := tm["timeUnit"]; !ok {
		return s, t, compact, errors.New("featureTimeline.timeUnit is required")
	} else {
		var value string
		if json.Unmarshal(unit, &value) != nil || value != "ms" {
			return s, t, compact, errors.New("featureTimeline.timeUnit must be ms")
		}
	}
	if s.SummaryVersion != 1 || t.SchemaVersion != 1 {
		return s, t, compact, errors.New("unsupported summary or feature timeline schema version")
	}
	if s.DurationMs < 1 || s.DurationMs > 24*60*60*1000 || t.DurationMs != s.DurationMs {
		return s, t, compact, errors.New("summary and timeline durationMs must match and be in 1..86400000")
	}
	if (t.BPM == nil) != (t.BPMSource == "") {
		return s, t, compact, errors.New("featureTimeline BPM and bpmSource must be provided together")
	}
	if t.BPM != nil {
		if !finite(*t.BPM) || *t.BPM < 40 || *t.BPM > 240 || (t.BPMSource != "kick-estimated" && t.BPMSource != "fallback") || (t.BPMSource == "fallback" && *t.BPM != 120) || (t.BPMSource == "kick-estimated" && (*t.BPM < 60 || *t.BPM > 180)) {
			return s, t, compact, errors.New("featureTimeline BPM metadata is invalid")
		}
	}
	if s.SourceAudio.Format == "" || s.SourceAudio.Codec == "" || s.SourceAudio.SampleRateHz < 1 || s.SourceAudio.SampleRateHz > 384000 || s.SourceAudio.Channels < 1 || s.SourceAudio.Channels > 8 || s.SourceAudio.FileBytes < 0 {
		return s, t, compact, errors.New("invalid musicSummary.sourceAudio")
	}
	a := s.Analysis
	if a.Model == "" || a.Device == "" || a.KickDetection == "" || a.EstimatedKickCount < 0 || a.EstimatedKickCount > MaxKickEvents || !finite(a.FeatureSampleRateHz) || a.FeatureSampleRateHz <= 0 || a.FeatureSampleRateHz > 1000 {
		return s, t, compact, errors.New("invalid musicSummary.analysis")
	}
	for _, stem := range []string{"drums", "bass", "vocals", "other"} {
		v, ok := a.StemRms[stem]
		if !ok || !finite(v) || v < 0 {
			return s, t, compact, fmt.Errorf("invalid stemRms.%s", stem)
		}
	}
	if len(t.BassEnvelope) == 0 || len(t.BassEnvelope) > MaxTimelinePoints || len(t.KickEvents) > MaxKickEvents {
		return s, t, compact, errors.New("feature timeline element limit exceeded or bassEnvelope is empty")
	}
	var pointFields []map[string]json.RawMessage
	_ = json.Unmarshal(tm["bassEnvelope"], &pointFields)
	for i, fields := range pointFields {
		if _, ok := fields["timeMs"]; !ok || fields["value"] == nil {
			return s, t, compact, fmt.Errorf("featureTimeline.bassEnvelope[%d] requires timeMs and value", i)
		}
	}
	prev := -1.0
	minV, maxV, sum := 1.0, 0.0, 0.0
	for _, p := range t.BassEnvelope {
		if !finite(p.TimeMs) || !finite(p.Value) || p.TimeMs < 0 || p.TimeMs > float64(t.DurationMs) || p.TimeMs <= prev || p.Value < 0 || p.Value > 1 {
			return s, t, compact, errors.New("invalid or unsorted bassEnvelope values")
		}
		prev = p.TimeMs
		minV = math.Min(minV, p.Value)
		maxV = math.Max(maxV, p.Value)
		sum += p.Value
	}
	prev = -1
	for _, event := range t.KickEvents {
		if !finite(event) || event < 0 || event > float64(t.DurationMs) || event <= prev {
			return s, t, compact, errors.New("invalid or unsorted kickEvents")
		}
		prev = event
	}
	if (t.KickEventStrengths != nil && len(t.KickEventStrengths) != len(t.KickEvents)) || ((t.SnareEvents == nil) != (t.SnareStrengths == nil)) || (t.SnareStrengths != nil && len(t.SnareStrengths) != len(t.SnareEvents)) || len(t.SnareEvents) > MaxKickEvents {
		return s, t, compact, errors.New("featureTimeline event strength alignment is invalid")
	}
	for i, strength := range t.KickEventStrengths {
		if !finite(strength) || strength < 0 || strength > 1 {
			return s, t, compact, fmt.Errorf("featureTimeline.kickEventStrengths[%d] is invalid", i)
		}
	}
	prev = -1
	for i, event := range t.SnareEvents {
		if !finite(event) || event < 0 || event > float64(t.DurationMs) || event <= prev || !finite(t.SnareStrengths[i]) || t.SnareStrengths[i] < 0 || t.SnareStrengths[i] > 1 {
			return s, t, compact, errors.New("featureTimeline snare events are invalid")
		}
		prev = event
	}
	for name, points := range map[string][]FeaturePoint{"drumEnergy": t.DrumEnergy, "vocalsEnvelope": t.VocalsEnvelope, "otherEnvelope": t.OtherEnvelope, "musicEnergy": t.MusicEnergy} {
		if len(points) > MaxTimelinePoints || (points != nil && len(points) == 0) {
			return s, t, compact, fmt.Errorf("featureTimeline.%s has invalid size", name)
		}
		prev = -1
		for _, point := range points {
			if !finite(point.TimeMs) || !finite(point.Value) || point.TimeMs < 0 || point.TimeMs > float64(t.DurationMs) || point.TimeMs <= prev || point.Value < 0 || point.Value > 1 {
				return s, t, compact, fmt.Errorf("featureTimeline.%s is invalid", name)
			}
			prev = point.TimeMs
		}
	}
	peakRaw, hasPeakField := tm["waveformPeaks"]
	if hasPeakField && t.WaveformPeaks == nil {
		return s, t, compact, errors.New("featureTimeline.waveformPeaks must not be null")
	}
	if t.WaveformPeaks != nil {
		if t.WaveformPeaks.SampleIntervalMs != 20 || t.WaveformPeaks.WindowSamples != 882 || t.WaveformPeaks.Normalization != "signed-full-scale" {
			return s, t, compact, errors.New("featureTimeline.waveformPeaks metadata is invalid")
		}
		want := int((t.DurationMs + 19) / 20)
		if want > MaxWaveformPeaks {
			return s, t, compact, errors.New("featureTimeline.waveformPeaks exceeds size limit")
		}
		for name, peaks := range map[string][]WaveformPeak{"music": t.WaveformPeaks.Music, "drums": t.WaveformPeaks.Drums, "bass": t.WaveformPeaks.Bass, "vocals": t.WaveformPeaks.Vocals, "other": t.WaveformPeaks.Other} {
			if len(peaks) != want {
				return s, t, compact, fmt.Errorf("featureTimeline.waveformPeaks.%s has invalid window count", name)
			}
			var rawPeaks []map[string]json.RawMessage
			_ = json.Unmarshal(objectField(peakRaw, name), &rawPeaks)
			if len(rawPeaks) != want {
				return s, t, compact, fmt.Errorf("featureTimeline.waveformPeaks.%s has invalid items", name)
			}
			for i, peak := range peaks {
				if len(rawPeaks[i]) != 2 || rawPeaks[i]["min"] == nil || rawPeaks[i]["max"] == nil || !finite(peak.Min) || !finite(peak.Max) || peak.Min < -1 || peak.Min > 1 || peak.Max < -1 || peak.Max > 1 || peak.Min > peak.Max {
					return s, t, compact, fmt.Errorf("featureTimeline.waveformPeaks.%s[%d] is invalid", name, i)
				}
			}
		}
		var object map[string]json.RawMessage
		_ = json.Unmarshal(tm["waveformPeaks"], &object)
		if len(object) != 8 {
			return s, t, compact, errors.New("featureTimeline.waveformPeaks has unknown or missing fields")
		}
	}
	spectrumRaw, hasSpectrumField := tm["frequencySpectrum"]
	if hasSpectrumField && t.FrequencySpectrum == nil {
		return s, t, compact, errors.New("featureTimeline.frequencySpectrum must not be null")
	}
	if spectrum := t.FrequencySpectrum; spectrum != nil {
		wantFrames := int((t.DurationMs + 19) / 20)
		if spectrum.HopMs != 20 || spectrum.FFTSize != 4096 || spectrum.BandCount != SpectrumBandCount || spectrum.SampleRateHz < 1 || !finite(spectrum.MinHz) || !finite(spectrum.MaxHz) || spectrum.MinHz != 40 || spectrum.MaxHz <= spectrum.MinHz || spectrum.MaxHz > 16000 || spectrum.MaxHz > float64(spectrum.SampleRateHz)/2 || spectrum.Normalization != "whole-clip-p99-log-rms" || spectrum.Encoding != "uint8-linear-0-255" || wantFrames > MaxSpectrumFrames || len(spectrum.Values) != wantFrames*SpectrumBandCount {
			return s, t, compact, errors.New("featureTimeline.frequencySpectrum metadata or dimensions are invalid")
		}
		var object map[string]json.RawMessage
		if err := json.Unmarshal(spectrumRaw, &object); err != nil || len(object) != 9 {
			return s, t, compact, errors.New("featureTimeline.frequencySpectrum has unknown or missing fields")
		}
		var rawValues []json.RawMessage
		_ = json.Unmarshal(object["values"], &rawValues)
		if len(rawValues) != len(spectrum.Values) {
			return s, t, compact, errors.New("featureTimeline.frequencySpectrum values are invalid")
		}
		for i, value := range spectrum.Values {
			var integer int
			if value < 0 || value > 255 || json.Unmarshal(rawValues[i], &integer) != nil || integer != value {
				return s, t, compact, fmt.Errorf("featureTimeline.frequencySpectrum.values[%d] is invalid", i)
			}
		}
	}
	if stringsTrim(req.VisualIntent) != "" && len(req.VisualIntent) > 500 {
		return s, t, compact, errors.New("visualIntent exceeds 500 characters")
	}
	bpm, bpmSource := 120.0, "fallback"
	if t.BPM != nil {
		bpm, bpmSource = *t.BPM, t.BPMSource
	}
	compact = CompactFeatures{DurationMs: t.DurationMs, BPM: bpm, BPMSource: bpmSource, SampleRateHz: a.FeatureSampleRateHz, BassMin: minV, BassMax: maxV, BassMean: sum / float64(len(t.BassEnvelope)), BassSamples: sampleBass(t.BassEnvelope, 64), KickCount: len(t.KickEvents), KickSamplesMs: sampleKicks(t.KickEvents, 64)}
	return s, t, compact, nil
}

func objectField(raw json.RawMessage, field string) json.RawMessage {
	var object map[string]json.RawMessage
	_ = json.Unmarshal(raw, &object)
	return object[field]
}

func finite(x float64) bool       { return !math.IsNaN(x) && !math.IsInf(x, 0) }
func stringsTrim(s string) string { return strings.TrimSpace(s) }
func sampleBass(points []FeaturePoint, max int) []FeaturePoint {
	if len(points) <= max {
		return points
	}
	out := make([]FeaturePoint, 0, max)
	for i := 0; i < max; i++ {
		index := int(math.Round(float64(i) * float64(len(points)-1) / float64(max-1)))
		out = append(out, points[index])
	}
	return out
}
func sampleKicks(events []float64, max int) []float64 {
	if len(events) <= max {
		return events
	}
	out := make([]float64, 0, max)
	for i := 0; i < max; i++ {
		index := int(math.Round(float64(i) * float64(len(events)-1) / float64(max-1)))
		out = append(out, events[index])
	}
	return out
}
