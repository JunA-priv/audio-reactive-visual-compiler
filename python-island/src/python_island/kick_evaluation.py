"""Local, offline evaluation helpers for the unchanged Kick detector.

The diagnostic path intentionally mirrors features.detect_kicks. A regression test
compares its baseline events to the production detector so diagnostics cannot silently
drift from the detector contract.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import wave
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np

from python_island.audio import TARGET_SAMPLE_RATE
from python_island.errors import AnalysisError
from python_island.features import HOP_MS, HOP_SAMPLES, detect_kicks


@dataclass(frozen=True)
class EventMatch:
    truth_ms: int
    detected_ms: int
    error_ms: int


def match_events(
    truth_events_ms: list[int], detected_events_ms: list[int], tolerance_ms: int = 80
) -> dict[str, Any]:
    """Greedily one-to-one match sorted event streams within an inclusive tolerance."""
    if tolerance_ms < 0:
        raise ValueError("tolerance_ms must be nonnegative")
    truth = sorted(truth_events_ms)
    detected = sorted(detected_events_ms)
    truth_index = 0
    detected_index = 0
    matches: list[EventMatch] = []
    false_positives: list[int] = []
    false_negatives: list[int] = []
    while truth_index < len(truth) and detected_index < len(detected):
        truth_time = truth[truth_index]
        detected_time = detected[detected_index]
        if detected_time < truth_time - tolerance_ms:
            false_positives.append(detected_time)
            detected_index += 1
        elif truth_time < detected_time - tolerance_ms:
            false_negatives.append(truth_time)
            truth_index += 1
        else:
            matches.append(EventMatch(truth_time, detected_time, detected_time - truth_time))
            truth_index += 1
            detected_index += 1
    false_negatives.extend(truth[truth_index:])
    false_positives.extend(detected[detected_index:])

    tp = len(matches)
    fp = len(false_positives)
    fn = len(false_negatives)
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision is not None and recall is not None and precision + recall
        else None
    )
    errors = [match.error_ms for match in matches]
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "matches": [asdict(match) for match in matches],
        "falsePositiveMs": false_positives,
        "falseNegativeMs": false_negatives,
        "onsetErrorMs": {
            "mean": float(np.mean(errors)) if errors else None,
            "meanAbsolute": float(np.mean(np.abs(errors))) if errors else None,
            "medianAbsolute": float(np.median(np.abs(errors))) if errors else None,
            "maxAbsolute": max((abs(value) for value in errors), default=None),
        },
    }


@dataclass(frozen=True)
class Candidate:
    frame: int
    time_ms: int
    score: float
    ratio: float
    decay_ratio: float
    low_energy: float
    is_local_peak: bool
    passes_score: bool
    passes_low: bool
    passes_ratio: bool
    passes_decay: bool
    merge_suppressed: bool = False

    def failures(self) -> list[str]:
        checks = (
            ("adaptive_score_threshold", self.passes_score),
            ("low_band_floor", self.passes_low),
            ("local_maximum", self.is_local_peak),
            ("sub_body_ratio", self.passes_ratio),
            ("decay_80ms", self.passes_decay),
            ("merge_120ms", not self.merge_suppressed),
        )
        return [name for name, passed in checks if not passed]


def diagnose_candidates(samples: np.ndarray) -> tuple[list[Candidate], dict[str, float]]:
    """Recompute production detector candidate signals and expose gate outcomes."""
    if samples.ndim != 2 or samples.shape[1] not in (1, 2) or samples.shape[0] == 0:
        raise AnalysisError("Kick evaluation WAV must be non-empty mono or stereo PCM")
    mono = samples.astype(np.float64, copy=False).mean(axis=1)
    frame_size = 2048
    window = np.hanning(frame_size)
    frequencies = np.fft.rfftfreq(frame_size, 1 / TARGET_SAMPLE_RATE)
    masks = (
        (frequencies >= 35) & (frequencies < 80),
        (frequencies >= 35) & (frequencies <= 120),
        (frequencies >= 100) & (frequencies <= 250),
    )
    bands = np.zeros((int(np.ceil(len(mono) / HOP_SAMPLES)), 3), dtype=np.float64)
    for index, start in enumerate(range(0, len(mono), HOP_SAMPLES)):
        frame = mono[start : start + frame_size]
        padded = np.zeros(frame_size, dtype=np.float64)
        padded[: len(frame)] = frame
        power = np.square(np.abs(np.fft.rfft(padded * window)))
        bands[index] = [
            float(np.sqrt(np.mean(power[mask]))) if np.any(mask) else 0.0 for mask in masks
        ]

    sub, low, mid = bands.T
    if low.size < 3 or float(low.max(initial=0.0)) <= 1e-12:
        return [], {"scoreThreshold": 0.08, "lowThreshold": 0.0}
    history = max(1, round(500 / HOP_MS))
    baseline = np.asarray(
        [np.median(low[max(0, i - history) : i]) if i else 0.0 for i in range(len(low))]
    )
    floor = max(float(np.percentile(low, 75)) * 0.03, 1e-9)
    rise = np.maximum(0.0, low - np.concatenate(([0.0], low[:-1])))
    score = np.log1p(rise / (baseline + floor)) * np.clip(sub / (sub + mid + 1e-9), 0.0, 1.0)
    score_threshold = max(float(np.percentile(score, 85)) * 0.18, 0.08)
    low_threshold = float(np.percentile(low, 65)) * 0.12
    decay_frames = round(80 / HOP_MS)
    candidates: list[Candidate] = []
    for index in range(1, len(score) - 1):
        future = min(len(low) - 1, index + decay_frames)
        decay_ratio = low[future] / max(low[index], 1e-9)
        ratio = sub[index] / (sub[index] + mid[index] + 1e-9)
        is_local_peak = score[index] >= score[index - 1] and score[index] > score[index + 1]
        candidates.append(
            Candidate(
                frame=index,
                time_ms=index * HOP_MS,
                score=float(score[index]),
                ratio=float(ratio),
                decay_ratio=float(decay_ratio),
                low_energy=float(low[index]),
                is_local_peak=is_local_peak,
                passes_score=score[index] >= score_threshold,
                passes_low=low[index] >= low_threshold,
                passes_ratio=ratio >= 0.70,
                passes_decay=decay_ratio <= 0.50,
            )
        )
    return candidates, {"scoreThreshold": score_threshold, "lowThreshold": low_threshold}


def _events_for_gates(candidates: list[Candidate], disabled_gate: str | None = None) -> list[int]:
    accepted = []
    for candidate in candidates:
        gates = {
            "adaptive_score_threshold": candidate.passes_score,
            "low_band_floor": candidate.passes_low,
            "local_maximum": candidate.is_local_peak,
            "sub_body_ratio": candidate.passes_ratio,
            "decay_80ms": candidate.passes_decay,
        }
        if any(not passed for name, passed in gates.items() if name != disabled_gate):
            continue
        accepted.append(candidate)
    merged: list[Candidate] = []
    for candidate in accepted:
        if disabled_gate == "merge_120ms":
            merged.append(candidate)
            continue
        if merged and candidate.frame - merged[-1].frame < 12:
            if candidate.score > merged[-1].score:
                merged[-1] = candidate
        else:
            merged.append(candidate)
    return [candidate.time_ms for candidate in merged]


def analyze_samples(
    samples: np.ndarray,
    truth_events_ms: list[int],
    tolerance_ms: int = 80,
    negative_events: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    candidates, thresholds = diagnose_candidates(samples)
    baseline_events, strengths = detect_kicks(samples)
    if baseline_events != _events_for_gates(candidates):
        raise RuntimeError("Diagnostic baseline diverged from features.detect_kicks")
    baseline_indices = set(_events_for_gates(candidates))
    annotated_candidates = [
        Candidate(
            **{
                **asdict(candidate),
                "merge_suppressed": (
                    candidate.is_local_peak
                    and candidate.passes_score
                    and candidate.passes_low
                    and candidate.passes_ratio
                    and candidate.passes_decay
                    and candidate.time_ms not in baseline_indices
                ),
            }
        )
        for candidate in candidates
    ]
    rejected = [candidate for candidate in annotated_candidates if candidate.failures()]
    label_diagnostics = []
    for onset in sorted(truth_events_ms):
        nearby_detections = [
            event for event in baseline_events if abs(event - onset) <= tolerance_ms
        ]
        if nearby_detections:
            detected = min(nearby_detections, key=lambda event: (abs(event - onset), event))
            accepted_candidate = next(
                (candidate for candidate in candidates if candidate.time_ms == detected), None
            )
            label_diagnostics.append(
                {
                    "truthMs": onset,
                    "status": "detected",
                    "detectedMs": detected,
                    "offsetMs": detected - onset,
                    "candidate": None
                    if accepted_candidate is None
                    else {
                        "score": accepted_candidate.score,
                        "subBodyRatio": accepted_candidate.ratio,
                        "decayRatio80ms": accepted_candidate.decay_ratio,
                        "lowEnergy": accepted_candidate.low_energy,
                        "failedGates": [],
                    },
                }
            )
            continue
        nearby = [
            candidate
            for candidate in rejected
            if candidate.is_local_peak
            and candidate.score > 0
            and abs(candidate.time_ms - onset) <= tolerance_ms
        ]
        closest = (
            min(nearby, key=lambda item: (abs(item.time_ms - onset), item.time_ms))
            if nearby
            else None
        )
        label_diagnostics.append(
            {
                "truthMs": onset,
                "status": "missed_candidate_rejected" if closest else "missed_no_candidate",
                "nearestRejectedCandidate": None
                if closest is None
                else {
                    "timeMs": closest.time_ms,
                    "offsetMs": closest.time_ms - onset,
                    "score": closest.score,
                    "subBodyRatio": closest.ratio,
                    "decayRatio80ms": closest.decay_ratio,
                    "lowEnergy": closest.low_energy,
                    "failedGates": closest.failures(),
                },
            }
        )
    baseline_metrics = match_events(truth_events_ms, baseline_events, tolerance_ms)
    false_positive_kinds: dict[str, int] = {}
    for event in baseline_metrics["falsePositiveMs"]:
        matches = [
            item
            for item in negative_events or []
            if abs(event - int(item["timeMs"])) <= tolerance_ms
        ]
        kind = (
            min(matches, key=lambda item: abs(event - int(item["timeMs"])))["kind"]
            if matches
            else "unlabeled"
        )
        false_positive_kinds[str(kind)] = false_positive_kinds.get(str(kind), 0) + 1
    ablations = {}
    for gate in (
        "adaptive_score_threshold",
        "low_band_floor",
        "local_maximum",
        "sub_body_ratio",
        "decay_80ms",
        "merge_120ms",
    ):
        events = _events_for_gates(candidates, disabled_gate=gate)
        ablations[gate] = {
            "disabledGateEventsMs": events,
            "metrics": match_events(truth_events_ms, events, tolerance_ms),
        }
    return {
        "toleranceMs": tolerance_ms,
        "detectedEventsMs": baseline_events,
        "detectedStrengths": strengths,
        "metrics": baseline_metrics,
        "falsePositiveKinds": false_positive_kinds,
        "thresholds": thresholds,
        "rejectedCandidateCount": len(rejected),
        "truthGateDiagnostics": label_diagnostics,
        "singleGateAblations": ablations,
    }


def _read_pcm16_wav(path: Path) -> np.ndarray:
    try:
        with wave.open(str(path), "rb") as wav:
            channels = wav.getnchannels()
            sample_width = wav.getsampwidth()
            sample_rate = wav.getframerate()
            frames = wav.readframes(wav.getnframes())
    except (OSError, wave.Error) as error:
        raise AnalysisError(f"Unable to read evaluation WAV {path}: {error}") from error
    if channels not in (1, 2) or sample_width != 2 or sample_rate != TARGET_SAMPLE_RATE:
        raise AnalysisError("Evaluation WAV must be mono/stereo PCM16 at 44100 Hz")
    pcm = np.frombuffer(frames, dtype="<i2").astype(np.float64) / 32768.0
    if pcm.size == 0 or pcm.size % channels:
        raise AnalysisError("Evaluation WAV contains no complete PCM frames")
    return pcm.reshape((-1, channels))


def evaluate_manifest(manifest_path: Path, tolerance_ms: int = 80) -> dict[str, Any]:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        recordings = manifest["recordings"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as error:
        raise AnalysisError(f"Invalid evaluation manifest: {error}") from error
    if not isinstance(recordings, list) or not recordings:
        raise AnalysisError("Manifest must contain a non-empty recordings list")
    results = []
    all_truth: list[int] = []
    all_detected: list[int] = []
    offset = 0
    for item in recordings:
        if not isinstance(item, dict) or "wav" not in item or "kickOnsetsMs" not in item:
            raise AnalysisError("Each recording needs wav and kickOnsetsMs fields")
        wav_path = (manifest_path.parent / str(item["wav"])).resolve(strict=True)
        truths = [int(value) for value in item["kickOnsetsMs"]]
        result = analyze_samples(
            _read_pcm16_wav(wav_path), truths, tolerance_ms, item.get("negativeEvents", [])
        )
        result["recording"] = {
            "id": str(item.get("id", wav_path.stem)),
            "wav": str(item["wav"]),
            "sourceType": item.get("sourceType", "unspecified"),
            "license": item.get("license", "unspecified"),
        }
        results.append(result)
        all_truth.extend(time + offset for time in truths)
        all_detected.extend(time + offset for time in result["detectedEventsMs"])
        with wave.open(str(wav_path), "rb") as wav:
            offset += round(wav.getnframes() * 1000 / wav.getframerate()) + tolerance_ms * 2 + 1
    return {
        "detector": "python_island.features.detect_kicks",
        "detectorModified": False,
        "matching": "sorted one-to-one onset pairing; inclusive tolerance",
        "toleranceMs": tolerance_ms,
        "recordingCount": len(results),
        "recordings": results,
        "aggregate": match_events(all_truth, all_detected, tolerance_ms),
    }


def _metrics_for_interval(
    truth_events_ms: list[int],
    all_events_ms: list[int],
    start_ms: int,
    end_ms: int,
    tolerance_ms: int,
) -> dict[str, Any]:
    """Match with full-song context, counting unmatched detections inside the reviewed core."""
    context_events = [
        time_ms
        for time_ms in all_events_ms
        if start_ms - tolerance_ms <= time_ms <= end_ms + tolerance_ms
    ]
    matched = match_events(truth_events_ms, context_events, tolerance_ms)
    core_false_positives = [
        time_ms
        for time_ms in matched["falsePositiveMs"]
        if start_ms <= time_ms < end_ms
    ]
    tp = matched["tp"]
    fp = len(core_false_positives)
    fn = matched["fn"]
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision is not None and recall is not None and precision + recall
        else None
    )
    errors = [pair["error_ms"] for pair in matched["matches"]]
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "matches": [
            {
                "truthMs": pair["truth_ms"],
                "detectedMs": pair["detected_ms"],
                "truthMsRelative": pair["truth_ms"] - start_ms,
                "detectedMsRelative": pair["detected_ms"] - start_ms,
                "errorMs": pair["error_ms"],
                "detectionInInterval": start_ms <= pair["detected_ms"] < end_ms,
            }
            for pair in matched["matches"]
        ],
        "falsePositiveMs": core_false_positives,
        "falseNegativeMs": matched["falseNegativeMs"],
        "onsetErrorMs": {
            "mean": float(np.mean(errors)) if errors else None,
            "meanAbsolute": float(np.mean(np.abs(errors))) if errors else None,
            "medianAbsolute": float(np.median(np.abs(errors))) if errors else None,
            "maxAbsolute": max((abs(value) for value in errors), default=None),
        },
    }


def _aggregate_interval_metrics(interval_results: list[dict[str, Any]]) -> dict[str, Any]:
    matches = [pair for row in interval_results for pair in row["metrics"]["matches"]]
    false_positives = [
        time_ms for row in interval_results for time_ms in row["metrics"]["falsePositiveMs"]
    ]
    false_negatives = [
        time_ms for row in interval_results for time_ms in row["metrics"]["falseNegativeMs"]
    ]
    tp, fp, fn = len(matches), len(false_positives), len(false_negatives)
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision is not None and recall is not None and precision + recall
        else None
    )
    errors = [pair["errorMs"] for pair in matches]
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "matches": matches,
        "falsePositiveMs": false_positives,
        "falseNegativeMs": false_negatives,
        "onsetErrorMs": {
            "mean": float(np.mean(errors)) if errors else None,
            "meanAbsolute": float(np.mean(np.abs(errors))) if errors else None,
            "medianAbsolute": float(np.median(np.abs(errors))) if errors else None,
            "maxAbsolute": max((abs(value) for value in errors), default=None),
        },
    }


def evaluate_confirmed_intervals(
    samples: np.ndarray,
    annotations: dict[str, Any],
    candidate_data: dict[str, Any],
    tolerance_ms: int = 80,
) -> dict[str, Any]:
    """Evaluate complete intervals against detections computed on the full source.

    Full-source detection preserves clip-global adaptive percentiles and detector context.
    Boundary-context detections may match labels within tolerance; unmatched detections
    outside a reviewed interval are not counted as false positives.
    """
    if tolerance_ms < 0:
        raise ValueError("tolerance_ms must be nonnegative")
    duration_ms = round(len(samples) * 1000 / TARGET_SAMPLE_RATE)
    complete = sorted(
        (
            interval
            for interval in annotations.get("intervals", [])
            if interval.get("reviewStatus") == "complete"
        ),
        key=lambda interval: int(interval["startMs"]),
    )
    if not complete:
        raise AnalysisError("No complete review intervals are available for evaluation")
    candidates_rows = candidate_data.get("candidates", [])
    candidate_times = [int(candidate["timeMs"]) for candidate in candidates_rows]
    review_by_time = {
        int(review["candidateTimeMs"]): review
        for review in annotations.get("candidateReviews", [])
    }
    confirmed_kicks = [
        int(item["timeMs"])
        for item in annotations.get("kickOnsets", [])
        if item.get("reviewStatus") == "confirmed"
    ]
    negative_events = [
        item
        for item in annotations.get("negativeEvents", [])
        if item.get("reviewStatus") == "confirmed"
    ]
    ambiguous_events = annotations.get("ambiguousEvents", [])
    previous_end: int | None = None
    for interval in complete:
        start_ms, end_ms = int(interval["startMs"]), int(interval["endMs"])
        if start_ms < 0 or end_ms <= start_ms or end_ms > duration_ms:
            raise AnalysisError("A complete interval has invalid time bounds")
        if previous_end is not None and start_ms < previous_end + 2 * tolerance_ms:
            raise AnalysisError("Complete intervals must be separated by at least 2× tolerance")
        previous_end = end_ms
        if not interval.get("playedThrough", False):
            raise AnalysisError("A complete interval must be played through before evaluation")
        kicks_in_interval = [time for time in confirmed_kicks if start_ms <= time < end_ms]
        if not kicks_in_interval and not interval.get("noKickConfirmed", False):
            raise AnalysisError("An empty Kick label set needs explicit no-Kick confirmation")
        if kicks_in_interval and interval.get("noKickConfirmed", False):
            raise AnalysisError("Interval cannot confirm both Kick labels and no Kicks")
        unreviewed = [
            time
            for time in candidate_times
            if start_ms <= time < end_ms
            and review_by_time.get(time, {}).get("status", "unverified")
            in {"unverified", "ambiguous"}
        ]
        if unreviewed:
            raise AnalysisError(
                f"Complete interval has {len(unreviewed)} unverified or ambiguous candidates"
            )
        if any(start_ms <= int(item["timeMs"]) < end_ms for item in ambiguous_events):
            raise AnalysisError("Complete interval contains unresolved ambiguous events")

    events, strengths = detect_kicks(samples)
    candidates, thresholds = diagnose_candidates(samples)
    if events != _events_for_gates(candidates):
        raise RuntimeError("Diagnostic baseline diverged from features.detect_kicks")
    baseline_set = set(events)
    trace = [
        Candidate(
            **{
                **asdict(candidate),
                "merge_suppressed": (
                    candidate.is_local_peak
                    and candidate.passes_score
                    and candidate.passes_low
                    and candidate.passes_ratio
                    and candidate.passes_decay
                    and candidate.time_ms not in baseline_set
                ),
            }
        )
        for candidate in candidates
    ]
    interval_results: list[dict[str, Any]] = []
    gate_names = (
        "adaptive_score_threshold",
        "low_band_floor",
        "local_maximum",
        "sub_body_ratio",
        "decay_80ms",
        "merge_120ms",
    )
    for interval in complete:
        start_ms, end_ms = int(interval["startMs"]), int(interval["endMs"])
        truths = [time for time in confirmed_kicks if start_ms <= time < end_ms]
        metrics = _metrics_for_interval(truths, events, start_ms, end_ms, tolerance_ms)
        false_positive_kinds: dict[str, int] = {}
        for event_ms in metrics["falsePositiveMs"]:
            nearby_negative = [
                item
                for item in negative_events
                if abs(int(item["timeMs"]) - event_ms) <= tolerance_ms
            ]
            kind = (
                min(nearby_negative, key=lambda item: abs(int(item["timeMs"]) - event_ms))[
                    "kind"
                ]
                if nearby_negative
                else "unlabeled"
            )
            false_positive_kinds[str(kind)] = false_positive_kinds.get(str(kind), 0) + 1
        gate_misses = []
        for truth in metrics["falseNegativeMs"]:
            nearby = [
                candidate
                for candidate in trace
                if candidate.is_local_peak
                and candidate.score > 0
                and candidate.failures()
                and abs(candidate.time_ms - truth) <= tolerance_ms
            ]
            closest = min(
                nearby,
                key=lambda candidate: (abs(candidate.time_ms - truth), candidate.time_ms),
                default=None,
            )
            gate_misses.append(
                {
                    "truthMs": truth,
                    "nearestRejectedCandidate": None
                    if closest is None
                    else {
                        "timeMs": closest.time_ms,
                        "failedGates": closest.failures(),
                        "score": closest.score,
                        "subBodyRatio": closest.ratio,
                        "decayRatio80ms": closest.decay_ratio,
                    },
                }
            )
        ablations = {
            gate: _metrics_for_interval(
                truths,
                _events_for_gates(candidates, disabled_gate=gate),
                start_ms,
                end_ms,
                tolerance_ms,
            )
            for gate in gate_names
        }
        interval_results.append(
            {
                "intervalId": interval.get("id"),
                "startMs": start_ms,
                "endMs": end_ms,
                "durationMs": end_ms - start_ms,
                "metrics": metrics,
                "falsePositiveKinds": false_positive_kinds,
                "gateMisses": gate_misses,
                "singleGateAblations": ablations,
            }
        )
    return {
        "status": "evaluated_complete_intervals",
        "detector": "python_island.features.detect_kicks",
        "detectorModified": False,
        "detectionContext": (
            "full_source; complete intervals only; full-clip adaptive percentiles preserved"
        ),
        "boundaryPolicy": (
            "A detection up to toleranceMs outside an interval may match a label inside. "
            "Unmatched outside detections are excluded from FP. Complete intervals must be "
            "separated by at least 2× tolerance."
        ),
        "toleranceMs": tolerance_ms,
        "detectedEventCountFullSource": len(events),
        "detectedStrengthsAligned": len(events) == len(strengths),
        "thresholdsFullSource": thresholds,
        "intervals": interval_results,
        "aggregate": _aggregate_interval_metrics(interval_results),
    }


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source_file:
        for block in iter(lambda: source_file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def evaluate_annotation_files(
    annotation_path: Path,
    source_path: Path,
    stem_path: Path,
    candidate_path: Path,
    tolerance_ms: int = 80,
) -> dict[str, Any]:
    try:
        annotations = json.loads(annotation_path.read_text(encoding="utf-8"))
        candidate_data = json.loads(candidate_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AnalysisError(f"Unable to read annotations or candidate data: {error}") from error
    if annotations.get("schemaVersion") != 1:
        raise AnalysisError("Unsupported annotation schema version")
    actual_hashes = {
        "sourceSha256": _sha256_file(source_path),
        "stemSha256": _sha256_file(stem_path),
        "candidateSha256": _sha256_file(candidate_path),
    }
    if annotations.get("assetHashes") != actual_hashes:
        raise AnalysisError("Source, stem, or candidate file hash does not match annotations")
    if candidate_data.get("source", {}).get("sha256") != actual_hashes["sourceSha256"]:
        raise AnalysisError("Candidate data refers to a different source audio file")
    result = evaluate_confirmed_intervals(
        _read_pcm16_wav(stem_path), annotations, candidate_data, tolerance_ms
    )
    result["assetHashes"] = actual_hashes
    result["sourceType"] = candidate_data.get("source", {}).get("sourceType", "unknown")
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Evaluate the current Kick detector on a local Demucs drums stem."
    )
    parser.add_argument(
        "manifest",
        type=Path,
        nargs="?",
        help="Existing Step 7k-22 JSON manifest with WAV paths and Kick onset labels",
    )
    parser.add_argument("--tolerance-ms", type=int, default=80)
    parser.add_argument("--output", type=Path, help="Optional local JSON result path")
    parser.add_argument("--annotations", type=Path, help="Complete-interval annotation JSON")
    parser.add_argument("--source", type=Path, help="Original source audio for hash verification")
    parser.add_argument("--stem", type=Path, help="PCM16/44.1kHz Demucs drums stem")
    parser.add_argument("--candidates", type=Path, help="Unverified candidate review JSON")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        annotation_mode = any(
            value is not None
            for value in (args.annotations, args.source, args.stem, args.candidates)
        )
        if annotation_mode:
            if args.manifest is not None or any(
                value is None
                for value in (args.annotations, args.source, args.stem, args.candidates)
            ):
                raise AnalysisError(
                    "Annotation mode requires --annotations, --source, --stem, and "
                    "--candidates, without a manifest"
                )
            result = evaluate_annotation_files(
                args.annotations,
                args.source,
                args.stem,
                args.candidates,
                args.tolerance_ms,
            )
        else:
            if args.manifest is None:
                raise AnalysisError(
                    "Provide the existing manifest or complete-interval annotation inputs"
                )
            result = evaluate_manifest(args.manifest, args.tolerance_ms)
        encoded = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        if args.output:
            args.output.write_text(encoded, encoding="utf-8")
        else:
            print(encoded, end="")
    except (AnalysisError, OSError, ValueError, RuntimeError) as error:
        print(f"kick-evaluation: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
