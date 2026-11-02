package service

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestInputValidatesQuantizedFrequencySpectrumWithinRequestLimit(t *testing.T) {
	var request map[string]json.RawMessage
	if err := json.Unmarshal([]byte(validRequest), &request); err != nil {
		t.Fatal(err)
	}
	var timeline map[string]json.RawMessage
	if err := json.Unmarshal(request["featureTimeline"], &timeline); err != nil {
		t.Fatal(err)
	}
	var summary map[string]json.RawMessage
	if err := json.Unmarshal(request["musicSummary"], &summary); err != nil {
		t.Fatal(err)
	}
	summary["durationMs"] = json.RawMessage("60000")
	summaryJSON, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	request["musicSummary"] = summaryJSON
	timeline["durationMs"] = json.RawMessage("60000")
	values := make([]int, 3000*SpectrumBandCount)
	for index := range values {
		values[index] = index % 256
	}
	spectrum, err := json.Marshal(map[string]any{
		"hopMs": 20, "fftSize": 4096, "bandCount": SpectrumBandCount, "sampleRateHz": 44100,
		"minHz": 40, "maxHz": 16000, "normalization": "whole-clip-p99-log-rms",
		"encoding": "uint8-linear-0-255", "values": values,
	})
	if err != nil {
		t.Fatal(err)
	}
	timeline["frequencySpectrum"] = spectrum
	peaks := make([]map[string]float64, 3000)
	for index := range peaks {
		peaks[index] = map[string]float64{"min": -0.5, "max": 0.5}
	}
	peakSources := map[string]any{"sampleIntervalMs": 20, "windowSamples": 882, "normalization": "signed-full-scale", "music": peaks, "drums": peaks, "bass": peaks, "vocals": peaks, "other": peaks}
	timeline["waveformPeaks"], err = json.Marshal(peakSources)
	if err != nil { t.Fatal(err) }
	encodedTimeline, err := json.Marshal(timeline)
	if err != nil {
		t.Fatal(err)
	}
	request["featureTimeline"] = encodedTimeline
	encodedRequest, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if len(encodedRequest) >= MaxBodyBytes {
		t.Fatalf("60s quantized spectrum request is %d bytes, exceeds 2MiB", len(encodedRequest))
	}
	t.Logf("60s Timeline with spectrum and all waveform peak sources: %d request bytes (2MiB limit)", len(encodedRequest))
	var req Request
	if err := json.Unmarshal(encodedRequest, &req); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := ValidateInput(req); err != nil {
		t.Fatalf("valid 60s spectrum rejected: %v", err)
	}

	for _, bad := range []string{
		strings.Replace(string(encodedRequest), `"hopMs":20`, `"hopMs":10`, 1),
		strings.Replace(string(encodedRequest), `"values":[0,1,2`, `"values":[256,1,2`, 1),
		strings.Replace(string(encodedRequest), `"maxHz":16000`, `"maxHz":22051`, 1),
	} {
		var invalid Request
		if err := json.Unmarshal([]byte(bad), &invalid); err != nil {
			t.Fatal(err)
		}
		if _, _, _, err := ValidateInput(invalid); err == nil {
			t.Errorf("invalid spectrum accepted: %s", bad[:min(len(bad), 120)])
		}
	}
}
