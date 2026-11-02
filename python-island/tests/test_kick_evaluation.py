from __future__ import annotations

import wave
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from python_island.errors import AnalysisError
from python_island.features import detect_kicks
from python_island.kick_evaluation import (
    Candidate,
    _events_for_gates,
    analyze_samples,
    evaluate_confirmed_intervals,
    evaluate_manifest,
    match_events,
)


def _write_pcm16_wav(path: Path, samples: np.ndarray, sample_rate: int = 44_100) -> None:
    pcm = np.clip(samples, -1, 1)
    encoded = np.rint(pcm * 32767).astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(encoded.shape[1])
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(encoded.tobytes())


def _kick_sample() -> np.ndarray:
    rate = 44_100
    signal = np.zeros((rate * 2, 2), dtype=np.float64)
    for onset in (400, 1400):
        start = round(onset * rate / 1000)
        local = np.arange(round(0.14 * rate)) / rate
        kick = (
            0.6
            * np.sin(2 * np.pi * (55 - 25 * np.exp(-local / 0.01)) * local)
            * np.exp(-local / 0.055)
        )
        signal[start : start + len(kick), 0] += kick
        signal[start : start + len(kick), 1] += kick
    return signal


def test_match_events_is_one_to_one_with_inclusive_tolerance_and_duplicate_events() -> None:
    result = match_events([100, 200], [100, 101, 200], tolerance_ms=80)
    assert result["tp"] == 2
    assert result["fp"] == 1
    assert result["fn"] == 0
    assert [pair["detected_ms"] for pair in result["matches"]] == [100, 200]


def test_match_events_reports_unmatched_and_exact_tolerance_boundary() -> None:
    result = match_events([100, 500], [180, 900], tolerance_ms=80)
    assert result["tp"] == 1
    assert result["fp"] == 1
    assert result["fn"] == 1
    assert result["matches"][0]["error_ms"] == 80
    assert result["recall"] == 0.5


def test_match_events_rejects_negative_tolerance() -> None:
    with pytest.raises(ValueError, match="nonnegative"):
        match_events([], [], tolerance_ms=-1)


def _candidate_review_data(times: list[int]) -> dict[str, object]:
    return {"candidates": [{"timeMs": time} for time in times]}


def _complete_interval(start: int, end: int, **extra: object) -> dict[str, object]:
    return {
        "id": f"{start}-{end}",
        "startMs": start,
        "endMs": end,
        "reviewStatus": "complete",
        "playedThrough": True,
        **extra,
    }


def test_complete_interval_evaluation_only_counts_in_range_and_boundary_match(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    samples = np.zeros((44_100 * 2, 2), dtype=np.float64)
    # A ground-truth event at 500ms can match a detector event just before the range.
    annotations = {
        "intervals": [_complete_interval(500, 1000, noKickConfirmed=False)],
        "kickOnsets": [{"timeMs": 500, "reviewStatus": "confirmed"}],
        "candidateReviews": [],
        "negativeEvents": [],
        "ambiguousEvents": [],
    }
    monkeypatch.setattr(
        "python_island.kick_evaluation.detect_kicks",
        lambda _samples: ([450, 1200], [1.0, 1.0]),
    )
    monkeypatch.setattr(
        "python_island.kick_evaluation.diagnose_candidates", lambda _samples: ([], {})
    )
    monkeypatch.setattr(
        "python_island.kick_evaluation._events_for_gates",
        lambda _candidates, disabled_gate=None: [450, 1200],
    )
    result = evaluate_confirmed_intervals(samples, annotations, _candidate_review_data([]))
    assert result["aggregate"]["tp"] == 1
    assert result["aggregate"]["fp"] == 0
    assert result["aggregate"]["fn"] == 0


def test_complete_interval_refuses_unreviewed_candidate_and_missing_truth() -> None:
    samples = np.zeros((44_100, 2), dtype=np.float64)
    annotations = {
        "intervals": [_complete_interval(0, 500)],
        "kickOnsets": [],
        "candidateReviews": [],
        "negativeEvents": [],
        "ambiguousEvents": [],
    }
    with pytest.raises(AnalysisError, match="explicit no-Kick"):
        evaluate_confirmed_intervals(samples, annotations, _candidate_review_data([]))
    annotations["intervals"][0]["noKickConfirmed"] = True  # type: ignore[index]
    with pytest.raises(AnalysisError, match="unverified or ambiguous"):
        evaluate_confirmed_intervals(samples, annotations, _candidate_review_data([250]))


def test_complete_intervals_need_gap_and_full_playback() -> None:
    samples = np.zeros((44_100, 2), dtype=np.float64)
    base = {
        "kickOnsets": [],
        "candidateReviews": [],
        "negativeEvents": [],
        "ambiguousEvents": [],
    }
    base["intervals"] = [
        _complete_interval(0, 500, noKickConfirmed=True),
        _complete_interval(600, 1000, noKickConfirmed=True),
    ]
    with pytest.raises(AnalysisError, match="separated"):
        evaluate_confirmed_intervals(samples, base, _candidate_review_data([]))
    base["intervals"] = [_complete_interval(0, 500, playedThrough=False, noKickConfirmed=True)]
    with pytest.raises(AnalysisError, match="played through"):
        evaluate_confirmed_intervals(samples, base, _candidate_review_data([]))


def test_detector_predictions_are_not_used_as_ground_truth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    samples = np.zeros((44_100, 2), dtype=np.float64)
    monkeypatch.setattr("python_island.kick_evaluation.detect_kicks", lambda _samples: ([], []))
    monkeypatch.setattr(
        "python_island.kick_evaluation.diagnose_candidates", lambda _samples: ([], {})
    )
    monkeypatch.setattr(
        "python_island.kick_evaluation._events_for_gates",
        lambda _candidates, disabled_gate=None: [],
    )
    annotations = {
        "intervals": [_complete_interval(0, 500, noKickConfirmed=True)],
        "candidateReviews": [{"candidateTimeMs": 100, "status": "rejected"}],
        "candidatePredictions": [
            {
                "candidateTimeMs": 100,
                "predictedKick": True,
                "reviewed": True,
                "finalLabel": "non_kick",
            }
        ],
        "kickOnsets": [],
        "negativeEvents": [],
        "ambiguousEvents": [],
    }
    result = evaluate_confirmed_intervals(
        samples, annotations, _candidate_review_data([100])
    )
    assert result["aggregate"]["tp"] == 0
    assert result["aggregate"]["fp"] == 0
    assert result["aggregate"]["fn"] == 0


def test_gate_diagnostics_baseline_matches_production_and_is_deterministic() -> None:
    samples = _kick_sample()
    first = analyze_samples(samples, [400, 1400])
    second = analyze_samples(samples, [400, 1400])
    assert first == second
    assert first["detectedEventsMs"] == detect_kicks(samples)[0]
    assert first["metrics"]["tp"] == 2
    assert first["metrics"]["fp"] == 0
    assert first["metrics"]["fn"] == 0
    assert [item["status"] for item in first["truthGateDiagnostics"]] == [
        "detected",
        "detected",
    ]
    assert set(first["singleGateAblations"]) == {
        "adaptive_score_threshold",
        "low_band_floor",
        "local_maximum",
        "sub_body_ratio",
        "decay_80ms",
        "merge_120ms",
    }


def test_gate_diagnostics_baseline_matches_negative_synthetic_signals() -> None:
    rate = 44_100
    silence = np.zeros((rate, 2), dtype=np.float64)
    rng = np.random.default_rng(7)
    noise_mono = rng.normal(0, 0.005, rate)
    noise = np.column_stack((noise_mono, noise_mono))
    tom_mono = np.zeros(rate, dtype=np.float64)
    start = round(0.25 * rate)
    local = np.arange(round(0.14 * rate)) / rate
    tom_mono[start : start + len(local)] = (
        0.55 * np.sin(2 * np.pi * 115 * local) * np.exp(-local / 0.085)
    )
    tom = np.column_stack((tom_mono, tom_mono))
    for samples in (silence, noise, tom):
        evaluated = analyze_samples(samples, [])
        assert evaluated["detectedEventsMs"] == detect_kicks(samples)[0]


def test_manifest_evaluation_reads_local_wav_and_records_metadata(tmp_path: Path) -> None:
    wav_path = tmp_path / "drums.wav"
    samples = _kick_sample()
    _write_pcm16_wav(wav_path, samples)
    manifest = tmp_path / "labels.json"
    manifest.write_text(
        '{"recordings":[{"id":"local-test","wav":"drums.wav",'
        '"sourceType":"synthetic","license":"test fixture",'
        '"kickOnsetsMs":[400,1400]}]}',
        encoding="utf-8",
    )
    first = evaluate_manifest(manifest)
    second = evaluate_manifest(manifest)
    assert first == second
    assert first["detectorModified"] is False
    assert first["recordings"][0]["recording"]["sourceType"] == "synthetic"
    assert first["aggregate"]["tp"] == 2


def test_manifest_rejects_wrong_sample_rate(tmp_path: Path) -> None:
    wav_path = tmp_path / "wrong-rate.wav"
    _write_pcm16_wav(wav_path, np.zeros((1000, 1)), sample_rate=48_000)
    manifest = tmp_path / "labels.json"
    manifest.write_text(
        '{"recordings":[{"wav":"wrong-rate.wav","kickOnsetsMs":[]}]}', encoding="utf-8"
    )
    with pytest.raises(AnalysisError, match="44100 Hz"):
        evaluate_manifest(manifest)


def test_merge_interval_diagnostic_is_independent_of_other_gates() -> None:
    def candidate(frame: int, score: float) -> Candidate:
        return Candidate(
            frame=frame,
            time_ms=frame * 10,
            score=score,
            ratio=0.8,
            decay_ratio=0.2,
            low_energy=1.0,
            is_local_peak=True,
            passes_score=True,
            passes_low=True,
            passes_ratio=True,
            passes_decay=True,
        )

    candidates = [candidate(10, 0.7), candidate(20, 0.9)]
    assert _events_for_gates(candidates) == [200]
    assert _events_for_gates(candidates, disabled_gate="merge_120ms") == [100, 200]


@pytest.mark.parametrize(
    ("field", "gate"),
    [
        ("passes_score", "adaptive_score_threshold"),
        ("passes_low", "low_band_floor"),
        ("is_local_peak", "local_maximum"),
        ("passes_ratio", "sub_body_ratio"),
        ("passes_decay", "decay_80ms"),
    ],
)
def test_each_candidate_gate_can_be_abated_independently(field: str, gate: str) -> None:
    passing = Candidate(
        frame=20,
        time_ms=200,
        score=0.9,
        ratio=0.8,
        decay_ratio=0.2,
        low_energy=1.0,
        is_local_peak=True,
        passes_score=True,
        passes_low=True,
        passes_ratio=True,
        passes_decay=True,
    )
    blocked = replace(passing, **{field: False})
    assert _events_for_gates([blocked]) == []
    assert _events_for_gates([blocked], disabled_gate=gate) == [200]
