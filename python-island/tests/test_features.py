import json

import numpy as np
import pytest

from python_island.errors import AnalysisError
from python_island.features import (
    KICK_GATE_MODES,
    KICK_GATE_THRESHOLDS,
    _frequency_spectrum,
    _waveform_peaks,
    detect_kicks,
    detect_kicks_legacy,
    detect_snares,
    estimate_bpm,
    extract_features,
)


def make_stems(duration_seconds: float = 2.0) -> dict[str, np.ndarray]:
    rate = 44_100
    length = round(rate * duration_seconds)
    time = np.arange(length) / rate
    bass = 0.2 * np.sin(2 * np.pi * 55 * time)
    drums = np.zeros(length, dtype=np.float64)
    for onset in (0.25, 0.9, 1.55):
        start = int(onset * rate)
        count = min(int(0.08 * rate), length - start)
        if count > 0:
            local = np.arange(count) / rate
            drums[start : start + count] = (
                0.8 * np.sin(2 * np.pi * 60 * local) * np.exp(-local * 45)
            )

    def stereo(mono: np.ndarray) -> np.ndarray:
        return np.column_stack((mono, mono))

    return {
        "drums": stereo(drums),
        "bass": stereo(bass),
        "vocals": stereo(0.04 * np.sin(2 * np.pi * 240 * time)),
        "other": stereo(0.02 * np.sin(2 * np.pi * 700 * time)),
    }


def test_kick_estimation_finds_synthetic_low_frequency_impulses():
    events, strengths = detect_kicks(make_stems()["drums"])
    assert len(events) >= 3
    assert events == sorted(set(events))
    assert all(0.0 <= strength <= 1.0 for strength in strengths)
    assert all(0.0 <= event <= 2000 for event in events)


def test_kick_gate_modes_keep_hard_compatible_and_monotonic_on_synthetic_drums():
    drums = make_stems()["drums"]
    outputs = {mode: detect_kicks(drums, mode) for mode in KICK_GATE_MODES}
    assert detect_kicks(drums) == outputs["hard"]
    counts = [len(outputs[mode][0]) for mode in KICK_GATE_MODES]
    assert counts == sorted(counts)
    assert all(len(events) == len(strengths) for events, strengths in outputs.values())
    assert all(events == sorted(set(events)) for events, _ in outputs.values())
    assert all(0 <= strength <= 1 for _, strengths in outputs.values() for strength in strengths)
    for mode in KICK_GATE_MODES:
        if mode != "off":
            assert len(outputs[mode][0]) > 0


def test_kick_gate_thresholds_are_nested_and_invalid_mode_is_rejected():
    assert KICK_GATE_THRESHOLDS["hard"] == (0.18, 0.08, 0.12, 0.70, 0.50)
    ordered = [KICK_GATE_THRESHOLDS[mode] for mode in KICK_GATE_MODES]
    for index in range(1, len(ordered)):
        less_strict, more_strict = ordered[index - 1], ordered[index]
        assert less_strict[0] <= more_strict[0]
        assert less_strict[1] <= more_strict[1]
        assert less_strict[2] <= more_strict[2]
        assert less_strict[3] <= more_strict[3]
        assert less_strict[4] >= more_strict[4]
    with pytest.raises(AnalysisError, match="gate mode"):
        detect_kicks(make_stems()["drums"], "medium")


def test_extract_features_passes_the_selected_kick_gate_mode(monkeypatch):
    import python_island.features as features

    stems = make_stems()
    captured: list[str] = []

    def fake_detect(_drums: np.ndarray, gate_mode: str = "hard") -> tuple[list[int], list[float]]:
        captured.append(gate_mode)
        return [250], [0.5]

    monkeypatch.setattr(features, "detect_kicks", fake_detect)
    audio = np.mean(np.stack(list(stems.values())), axis=0)
    timeline = extract_features(stems, 2000, audio, kick_gate_mode="soft")
    assert captured == ["soft"]
    assert timeline["kickEvents"] == [250]
    assert timeline["kickEventStrengths"] == [0.5]


def test_off_gate_mode_still_rejects_silence_and_keeps_peak_merge():
    silence = np.zeros((44_100, 2))
    assert detect_kicks(silence, "off") == ([], [])
    drums = make_stems()["drums"]
    events, strengths = detect_kicks(drums, "off")
    assert len(events) == len(strengths)
    assert events == sorted(set(events))


def _add_synthetic_kick(signal: np.ndarray, onset_s: float, amplitude: float = 0.6) -> None:
    rate = 44_100
    start = round(onset_s * rate)
    count = min(round(0.14 * rate), len(signal) - start)
    local = np.arange(count) / rate
    signal[start : start + count] += (
        amplitude
        * np.sin(2 * np.pi * (55 - 25 * np.exp(-local / 0.01)) * local)
        * np.exp(-local / 0.055)
    )


def _add_synthetic_snare(signal: np.ndarray, onset_s: float, amplitude: float = 0.6) -> None:
    rate = 44_100
    start = round(onset_s * rate)
    count = min(round(0.05 * rate), len(signal) - start)
    local = np.arange(count) / rate
    rng = np.random.default_rng(round(onset_s * 1000))
    signal[start : start + count] += amplitude * rng.normal(size=count) * np.exp(-local / 0.012)


def test_kick_detector_reduces_synthetic_snare_tom_and_sustained_bass_false_positives():
    rate = 44_100
    seconds = 4
    mixed = np.zeros(rate * seconds)
    kick_truth = [400, 1400, 2400]
    for onset_ms in kick_truth:
        _add_synthetic_kick(mixed, onset_ms / 1000)
    for onset in (0.9, 1.9, 2.9):
        _add_synthetic_snare(mixed, onset)
    for onset in (1.1, 2.1, 3.1):
        # Tom body in the 100–250Hz distinction band, without a sub-kick hit.
        start = round(onset * rate)
        end = min(start + round(0.14 * rate), len(mixed))
        local = np.arange(end - start) / rate
        mixed[start:end] += 0.55 * np.sin(2 * np.pi * 115 * local) * np.exp(-local / 0.085)

    current, strengths = detect_kicks(np.column_stack((mixed, mixed)))
    legacy, _ = detect_kicks_legacy(np.column_stack((mixed, mixed)))
    true_positives = sum(any(abs(event - truth) <= 80 for event in current) for truth in kick_truth)
    assert true_positives == len(kick_truth)
    assert len(current) < len(legacy)
    assert len(current) == len(strengths)
    assert current == sorted(set(current))
    assert all(0 <= strength <= 1 for strength in strengths)


def test_kick_detector_handles_double_weak_concurrent_events_and_is_deterministic():
    rate = 44_100
    signal = np.zeros(rate * 3)
    expected = (500, 640, 1500)
    _add_synthetic_kick(signal, 0.5, 0.65)
    _add_synthetic_kick(signal, 0.64, 0.65)
    _add_synthetic_kick(signal, 1.5, 0.12)
    _add_synthetic_snare(signal, 1.5, 0.35)  # Kick and snare may coincide.
    first = detect_kicks(np.column_stack((signal, signal)))
    assert first == detect_kicks(np.column_stack((signal, signal)))
    assert len(first[0]) == len(expected)
    assert all(any(abs(event - truth) <= 80 for event in first[0]) for truth in expected)
    assert all(a < b for a, b in zip(first[0], first[0][1:], strict=False))


def test_kick_detector_rejects_silence_noise_and_tom_only_and_bounds_terminal_events():
    rate = 44_100
    silent = np.zeros((rate, 2))
    assert detect_kicks(silent) == ([], [])
    noise = np.random.default_rng(7).normal(0, 0.005, rate * 2)
    assert detect_kicks(np.column_stack((noise, noise))) == ([], [])

    # Validate a distinct 115Hz tom-only stem.
    tom_only = np.zeros(rate * 2)
    for onset in (0.25, 0.9, 1.55):
        start = round(onset * rate)
        count = round(0.14 * rate)
        local = np.arange(count) / rate
        tom_only[start : start + count] = (
            0.55 * np.sin(2 * np.pi * 115 * local) * np.exp(-local / 0.085)
        )
    assert detect_kicks(np.column_stack((tom_only, tom_only))) == ([], [])
    terminal = np.zeros(rate)
    _add_synthetic_kick(terminal, 0.95, 0.55)
    events, strengths = detect_kicks(np.column_stack((terminal, terminal)))
    assert len(events) == len(strengths)
    assert all(0 <= event <= 1000 for event in events)


def test_snare_estimator_finds_mid_high_noise_transients_without_claiming_isolation():
    rate = 44_100
    signal = np.zeros(rate * 2)
    rng = np.random.default_rng(42)
    for onset in (0.35, 1.1, 1.7):
        start = round(onset * rate)
        count = round(0.045 * rate)
        signal[start:start + count] += rng.normal(0, 0.6, count) * np.exp(-np.arange(count) / (rate * 0.012))
    events, strengths = detect_snares(np.column_stack((signal, signal)))
    assert len(events) >= 2
    assert events == sorted(set(events))
    assert len(events) == len(strengths)
    assert all(0 <= value <= 1 for value in strengths)
    assert all(any(abs(value - expected * 1000) <= 80 for value in events) for expected in (0.35, 1.1, 1.7))


def test_feature_timeline_is_finite_bounded_and_serializable():
    stems = make_stems()
    audio = np.mean(np.stack(list(stems.values())), axis=0)
    result = extract_features(stems, 2000, audio)
    assert result["bpmSource"] in {"kick-estimated", "fallback"}
    assert 60 <= result["bpm"] <= 180 or (result["bpm"] == 120 and result["bpmSource"] == "fallback")
    assert result["featureHopMs"] == 10
    assert result["featureSampleRateHz"] == 100
    assert result["kickEvents"] == sorted(result["kickEvents"])
    assert len(result["kickEvents"]) == len(result["kickEventStrengths"])
    assert result["bassEnvelope"]
    assert result["drumEnergy"] and result["vocalsEnvelope"] and result["otherEnvelope"] and result["musicEnergy"]
    assert result["musicEnergy"] == extract_features(stems, 2000, audio)["musicEnergy"]
    peaks = result["waveformPeaks"]
    assert peaks["sampleIntervalMs"] == 20
    assert peaks["windowSamples"] == 882
    assert peaks["normalization"] == "signed-full-scale"
    assert set(peaks) == {"sampleIntervalMs", "windowSamples", "normalization", "music", "drums", "bass", "vocals", "other"}
    assert len(peaks["music"]) == 100
    assert peaks["drums"][12]["min"] < 0 < peaks["drums"][12]["max"]
    assert all(peak["min"] <= peak["max"] for key in ("music", "drums", "bass", "vocals", "other") for peak in peaks[key])
    for key in ("bassEnvelope", "drumEnergy", "vocalsEnvelope", "otherEnvelope", "musicEnergy"):
        points = result[key]
        assert all(0 <= point["timeMs"] <= 2000 for point in points)
        assert all(np.isfinite(point["value"]) and 0 <= point["value"] <= 1 for point in points)
    json.dumps(result, allow_nan=False)
    assert extract_features(stems, 2000, audio) == result


def test_silent_and_boundary_features_are_finite_and_duration_bounded():
    stems = {name: np.zeros((441, 2)) for name in ("drums", "bass", "vocals", "other")}
    result = extract_features(stems, 10, np.zeros((441, 2)))
    assert result["snareEvents"] == [] and result["snareEventStrengths"] == []
    assert all(result[key][0] == {"timeMs": 0, "value": 0.0} for key in ("bassEnvelope", "drumEnergy", "vocalsEnvelope", "otherEnvelope", "musicEnergy"))
    assert all(point["timeMs"] <= 10 for key in ("bassEnvelope", "musicEnergy") for point in result[key])
    assert len(result["waveformPeaks"]["music"]) == 1
    assert result["waveformPeaks"]["music"] == [{"min": 0.0, "max": 0.0}]


def test_waveform_peaks_clamp_overrange_separation_stems():
    stem = np.zeros((882, 2), dtype=np.float64)
    stem[56, 0] = 1.4
    stem[56, 1] = -1.2

    assert _waveform_peaks(stem) == [{"min": -1.0, "max": 1.0}]


def test_invalid_stem_shape_or_non_finite_input_is_rejected():
    stems = make_stems()
    audio = np.mean(np.stack(list(stems.values())), axis=0)
    stems["drums"] = np.zeros((0, 2))
    with pytest.raises(AnalysisError, match="non-empty"):
        extract_features(stems, 2000, audio)
    stems = make_stems()
    audio = np.mean(np.stack(list(stems.values())), axis=0)
    stems["bass"][3, 0] = np.inf
    with pytest.raises(AnalysisError, match="NaN or Infinity"):
        extract_features(stems, 2000, audio)


def test_waveform_peak_timeline_stays_under_two_mib_for_a_full_clip():
    # The API request serializes compact JSON.  A 60s 100Hz Timeline plus
    # 20ms min/max peaks for all five sources must remain below the fixed 2MiB cap.
    rate = 44_100
    length = rate * 60
    stems = {name: np.zeros((length, 2), dtype=np.float32) for name in ("drums", "bass", "vocals", "other")}
    audio = np.zeros((length, 2), dtype=np.float32)
    timeline = extract_features(stems, 60_000, audio)
    serialized = json.dumps(timeline, separators=(",", ":"), allow_nan=False).encode()
    assert len(serialized) < 2 * 1024 * 1024
    spectrum = timeline["frequencySpectrum"]
    assert spectrum["bandCount"] == 32
    assert len(spectrum["values"]) == 3000 * 32


def test_frequency_spectrum_detects_low_mid_high_tones_in_log_bands():
    rate = 44_100
    seconds = 2
    time = np.arange(rate * seconds) / rate
    frequencies = (60.0, 1000.0, 8000.0)
    band_peaks = []
    for frequency in frequencies:
        signal = 0.7 * np.sin(2 * np.pi * frequency * time)
        spectrum = _frequency_spectrum(np.column_stack((signal, signal)))
        frames = np.asarray(spectrum["values"], dtype=np.uint8).reshape(-1, 32)
        band_peaks.append(int(np.argmax(frames.max(axis=0))))
        assert spectrum["hopMs"] == 20 and spectrum["fftSize"] == 4096
        assert spectrum["sampleRateHz"] == rate and spectrum["maxHz"] == 16_000
        assert set(np.unique(frames)).issubset(set(range(256)))
    assert band_peaks[0] < band_peaks[1] < band_peaks[2]
    assert len(set(band_peaks)) == 3


def test_frequency_spectrum_silence_boundary_nyquist_and_non_finite_input():
    silence = _frequency_spectrum(np.zeros((441, 1)))
    assert len(silence["values"]) == 32
    assert set(silence["values"]) == {0}
    low_rate = _frequency_spectrum(np.zeros((160, 1)), sample_rate_hz=8_000)
    assert low_rate["maxHz"] == 4_000
    assert all(0 <= value <= 255 for value in low_rate["values"])
    bad = np.zeros((441, 1))
    bad[10] = np.nan
    with pytest.raises(AnalysisError, match="NaN or Infinity"):
        _frequency_spectrum(bad)


@pytest.mark.parametrize(
    "interval_ms, expected",
    [(2000, 60), (1000, 60), (500, 120), (250, 120), (1000 / 3, 180)],
)
def test_kick_tempo_estimation_for_common_tempos(interval_ms, expected):
    events = [round(index * interval_ms) for index in range(12)]
    bpm, source = estimate_bpm(events)
    assert bpm == pytest.approx(expected, abs=0.2)
    assert source == "kick-estimated"


def test_kick_tempo_falls_back_for_sparse_or_irregular_events():
    assert estimate_bpm([0, 500, 1000]) == (120.0, "fallback")
    assert estimate_bpm([0, 400, 1400, 1800, 3000]) == (120.0, "fallback")


def test_invalid_stem_names_are_rejected():
    with pytest.raises(AnalysisError, match="exactly"):
        extract_features({"bass": np.ones((10, 2))}, 1, np.ones((10, 2)))
