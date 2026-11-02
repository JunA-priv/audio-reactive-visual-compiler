#!/usr/bin/env python3
"""Local SCNet-vs-Demucs comparison; production dependencies stay untouched."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import random
import resource
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

STEMS = ("drums", "bass", "vocals", "other")
GATE_MODES = ("off", "soft", "middle", "hard")
EXPECTED_SCNET_SHA256 = "1bc0d1abb20bfdf966dcd07637bafd03e4bc13653d09ef18bc9b3e342eafe2aa"
EXPECTED_SCNET_BYTES = 42_434_986


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_checkpoint(
    path: Path, expected_sha256: str, expected_bytes: int = EXPECTED_SCNET_BYTES
) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(f"SCNet checkpoint does not exist: {path}")
    actual = sha256_file(path)
    if actual != expected_sha256:
        raise ValueError(f"SCNet checkpoint SHA-256 mismatch: {actual}")
    size = path.stat().st_size
    if size != expected_bytes:
        raise ValueError(f"SCNet checkpoint size mismatch: {size}")
    return {"bytes": size, "sha256": actual}


def frame_interval(
    total_frames: int, sample_rate: int, start_seconds: float, duration_seconds: float | None
) -> tuple[int, int]:
    if total_frames <= 0 or sample_rate <= 0 or not math.isfinite(start_seconds):
        raise ValueError("Source frame count, sample rate, and start time must be valid")
    if start_seconds < 0:
        raise ValueError("Start time must be non-negative")
    start = round(start_seconds * sample_rate)
    if start >= total_frames:
        raise ValueError("Start time must be within the source audio")
    end = total_frames
    if duration_seconds is not None:
        if not math.isfinite(duration_seconds) or duration_seconds <= 0:
            raise ValueError("Duration must be finite and positive")
        end = min(total_frames, round((start_seconds + duration_seconds) * sample_rate))
    if end <= start:
        raise ValueError("The selected comparison interval is empty")
    return start, end


def validate_stems(stems: dict[str, np.ndarray], reference: np.ndarray) -> None:
    if set(stems) != set(STEMS):
        raise ValueError(f"Expected exactly {STEMS}, got {tuple(sorted(stems))}")
    if reference.ndim != 2 or reference.shape[1] != 2 or reference.size == 0:
        raise ValueError("Reference audio must be non-empty stereo [frames, channels]")
    for name, samples in stems.items():
        if samples.ndim != 2 or samples.shape[1] != 2 or samples.shape != reference.shape:
            raise ValueError(f"{name} stem must match reference stereo shape {reference.shape}")
        if not np.isfinite(samples).all():
            raise ValueError(f"{name} stem contains NaN or Infinity")


def _series_stats(values: np.ndarray) -> dict[str, float | int]:
    if values.size == 0:
        return {"count": 0, "min": 0.0, "median": 0.0, "p90": 0.0, "max": 0.0, "mean": 0.0}
    return {
        "count": int(values.size),
        "min": float(np.min(values)),
        "median": float(np.median(values)),
        "p90": float(np.percentile(values, 90)),
        "max": float(np.max(values)),
        "mean": float(np.mean(values)),
    }


def stem_metrics(stems: dict[str, np.ndarray], mix: np.ndarray) -> dict[str, Any]:
    validate_stems(stems, mix)
    details: dict[str, Any] = {}
    for name, samples in stems.items():
        window_frames = 882
        window_rms = np.asarray(
            [
                np.sqrt(
                    np.mean(np.square(samples[start : start + window_frames], dtype=np.float64))
                )
                for start in range(0, len(samples), window_frames)
            ],
            dtype=np.float64,
        )
        silent_windows = int(np.count_nonzero(window_rms <= 1e-7))
        details[name] = {
            "frames": int(len(samples)),
            "channels": int(samples.shape[1]),
            "peakAbs": float(np.max(np.abs(samples))),
            "rms": float(np.sqrt(np.mean(np.square(samples, dtype=np.float64)))),
            "clippedSamples": int(np.count_nonzero(np.abs(samples) >= 0.999969)),
            "silent20msWindows": silent_windows,
            "silent20msWindowRatio": silent_windows / max(1, len(window_rms)),
        }
    reconstruction = np.sum(np.stack([stems[name] for name in STEMS]), axis=0, dtype=np.float64)
    residual = reconstruction - mix.astype(np.float64)
    mix_rms = float(np.sqrt(np.mean(np.square(mix, dtype=np.float64))))
    residual_rms = float(np.sqrt(np.mean(np.square(residual))))
    return {
        "sampleRateHz": 44_100,
        "channels": 2,
        "frames": int(len(mix)),
        "durationSeconds": len(mix) / 44_100,
        "stems": details,
        "recomposition": {
            "residualRms": residual_rms,
            "residualToMixRms": residual_rms / max(mix_rms, 1e-12),
            "residualPeak": float(np.max(np.abs(residual))),
        },
    }


def match_events(left: list[int], right: list[int], tolerance_ms: int = 80) -> dict[str, Any]:
    """One-to-one time-near comparison; outputs no accuracy/ground-truth metrics."""
    if tolerance_ms < 0:
        raise ValueError("tolerance_ms must be non-negative")
    a, b = sorted(left), sorted(right)
    i = j = 0
    offsets: list[int] = []
    while i < len(a) and j < len(b):
        delta = b[j] - a[i]
        if abs(delta) <= tolerance_ms:
            offsets.append(delta)
            i += 1
            j += 1
        elif delta < 0:
            j += 1
        else:
            i += 1
    errors = np.abs(np.asarray(offsets, dtype=np.float64))
    return {
        "toleranceMs": tolerance_ms,
        "matched": len(offsets),
        "leftOnly": len(a) - len(offsets),
        "rightOnly": len(b) - len(offsets),
        "signedOffsetsMs": offsets,
        "absoluteErrorMs": _series_stats(errors),
        "interpretation": "model-to-model descriptive comparison; not accuracy",
    }


def timeline_summary(timeline: dict[str, Any]) -> dict[str, Any]:
    event_summary: dict[str, Any] = {}
    for event_key, strength_key in (
        ("kickEvents", "kickEventStrengths"),
        ("snareEvents", "snareEventStrengths"),
    ):
        events = [int(value) for value in timeline.get(event_key, [])]
        strengths = np.asarray(timeline.get(strength_key, []), dtype=np.float64)
        event_summary[event_key] = {"count": len(events), "strength": _series_stats(strengths)}
        if len(strengths) != len(events):
            raise ValueError(f"{strength_key} is not aligned with {event_key}")
    series_summary: dict[str, Any] = {}
    for key in ("bassEnvelope", "drumEnergy", "vocalsEnvelope", "otherEnvelope", "musicEnergy"):
        values = np.asarray(
            [float(point["value"]) for point in timeline.get(key, [])], dtype=np.float64
        )
        series_summary[key] = _series_stats(values)
    return {"events": event_summary, "series": series_summary}


def _load_existing_features(repo_root: Path) -> tuple[Any, Any, Any]:
    src = repo_root / "python-island" / "src"
    sys.path.insert(0, str(src))
    from python_island.audio import decode_audio, probe_audio
    from python_island.features import extract_features

    return decode_audio, probe_audio, extract_features


def _peak_rss_mib() -> float:
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return float(peak / 1024 if sys.platform.startswith("linux") else peak / (1024 * 1024))


def _load_official_separator(
    repo: Path, config: Path, checkpoint: Path, threads: int
) -> tuple[Any, str]:
    repo = repo.expanduser().resolve(strict=True)
    if not (repo / "scnet" / "SCNet.py").is_file() or not (repo / ".git").exists():
        raise ValueError("--scnet-repo must be a Git checkout of the official SCNet repository")
    import subprocess

    origin = (
        subprocess.run(
            ["git", "-C", str(repo), "remote", "get-url", "origin"],
            check=True,
            capture_output=True,
            text=True,
        )
        .stdout.strip()
        .lower()
    )
    if origin.rstrip("/") not in (
        "https://github.com/starrytong/scnet",
        "git@github.com:starrytong/scnet.git",
    ):
        raise ValueError(f"Unexpected SCNet source origin: {origin}")
    commit = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    sys.path.insert(0, str(repo))
    # Force the CPU branch in the upstream Seperator before torch import.
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    import torch

    torch.set_num_threads(threads)
    torch.set_num_interop_threads(1)

    import yaml
    from ml_collections import ConfigDict
    from scnet.inference import Seperator
    from scnet.SCNet import SCNet

    config_path = config.expanduser().resolve(strict=True)
    checkpoint_path = checkpoint.expanduser().resolve(strict=True)
    with config_path.open(encoding="utf-8") as stream:
        config_data = yaml.safe_load(stream)
    model = SCNet(**ConfigDict(config_data["model"]))
    model.eval()
    separator = Seperator(model, str(checkpoint_path))
    if separator.device.type != "cpu":
        raise RuntimeError("SCNet inference did not select CPU")
    return separator, commit


def run(args: argparse.Namespace) -> dict[str, Any]:
    repo_root = Path(__file__).resolve().parents[3]
    output_dir = args.output_dir.expanduser().resolve()
    checkpoint_info = verify_checkpoint(args.checkpoint, args.expected_sha256)
    if output_dir.exists() and any(output_dir.iterdir()):
        raise ValueError(f"Refusing to overwrite non-empty output directory: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)

    decode_audio, probe_audio, extract_features = _load_existing_features(repo_root)
    source_info = probe_audio(args.source)
    full_mix = decode_audio(args.source, source_info)
    if full_mix.shape[1] != 2:
        raise ValueError("Existing decoder did not return stereo audio")

    import soundfile as sf

    full_reference_stems: dict[str, np.ndarray] = {}
    for name in STEMS:
        values, sample_rate = sf.read(
            args.demucs_stems / f"{name}.wav", dtype="float32", always_2d=True
        )
        if sample_rate != 44_100:
            raise ValueError(f"Demucs {name} stem sample rate is {sample_rate}, expected 44100")
        full_reference_stems[name] = values
    validate_stems(full_reference_stems, full_mix)

    start_frame, end_frame = frame_interval(
        len(full_mix), 44_100, args.start_seconds, args.duration_seconds
    )
    mix = full_mix[start_frame:end_frame]
    reference_stems = {
        name: samples[start_frame:end_frame] for name, samples in full_reference_stems.items()
    }
    validate_stems(reference_stems, mix)
    duration_ms = round(len(mix) * 1000 / 44_100)

    load_started = time.perf_counter()
    separator, source_commit = _load_official_separator(
        args.scnet_repo, args.config, args.checkpoint, args.threads
    )
    load_seconds = time.perf_counter() - load_started
    import torch

    random.seed(args.seed)
    torch.manual_seed(args.seed)

    def infer() -> tuple[dict[str, np.ndarray], float, float]:
        random.seed(args.seed)
        torch.manual_seed(args.seed)
        cpu_before = time.process_time()
        wall_before = time.perf_counter()
        separated, rates = separator.separate_music_file(mix, 44_100)
        cpu_seconds = time.process_time() - cpu_before
        wall_seconds = time.perf_counter() - wall_before
        if set(separated) != set(STEMS) or set(rates.values()) != {44_100}:
            raise ValueError("Official SCNet returned an unexpected stem set or sample rate")
        return separated, wall_seconds, cpu_seconds

    scnet_stems, first_wall, first_cpu = infer()
    repeated, warm_wall, warm_cpu = infer()
    validate_stems(scnet_stems, mix)
    validate_stems(repeated, mix)
    repeat_max_delta = max(
        float(np.max(np.abs(scnet_stems[name] - repeated[name]))) for name in STEMS
    )

    for name in STEMS:
        sf.write(
            output_dir / f"{name}.wav", scnet_stems[name], 44_100, subtype="PCM_16", format="WAV"
        )
        scnet_stems[name], sr = sf.read(output_dir / f"{name}.wav", dtype="float32", always_2d=True)
        if sr != 44_100:
            raise ValueError(f"Saved SCNet {name} WAV has unexpected sample rate {sr}")
    validate_stems(scnet_stems, mix)

    feature_rows: list[dict[str, Any]] = []
    summaries: dict[str, dict[str, Any]] = {"demucs": {}, "scnet": {}}
    all_timelines: dict[str, dict[str, dict[str, Any]]] = {"demucs": {}, "scnet": {}}
    for model_name, stems in (("demucs", reference_stems), ("scnet", scnet_stems)):
        for gate in GATE_MODES:
            timeline = extract_features(stems, duration_ms, mix, kick_gate_mode=gate)
            summary = timeline_summary(timeline)
            summaries[model_name][gate] = summary
            all_timelines[model_name][gate] = timeline
    for gate in GATE_MODES:
        kick_compare = match_events(
            all_timelines["demucs"][gate].get("kickEvents", []),
            all_timelines["scnet"][gate].get("kickEvents", []),
        )
        snare_compare = match_events(
            all_timelines["demucs"][gate].get("snareEvents", []),
            all_timelines["scnet"][gate].get("snareEvents", []),
        )
        for event_name, event_compare in (
            ("kickEvents", kick_compare),
            ("snareEvents", snare_compare),
        ):
            feature_rows.append(
                {
                    "gateMode": gate,
                    "feature": event_name,
                    "demucsCount": summaries["demucs"][gate]["events"][event_name]["count"],
                    "scnetCount": summaries["scnet"][gate]["events"][event_name]["count"],
                    "matchedWithin80ms": event_compare["matched"],
                    "demucsOnly": event_compare["leftOnly"],
                    "scnetOnly": event_compare["rightOnly"],
                    "medianAbsOffsetMs": event_compare["absoluteErrorMs"]["median"],
                }
            )
        for feature in (
            "bassEnvelope",
            "drumEnergy",
            "vocalsEnvelope",
            "otherEnvelope",
            "musicEnergy",
        ):
            feature_rows.append(
                {
                    "gateMode": gate,
                    "feature": feature,
                    "demucsCount": summaries["demucs"][gate]["series"][feature]["count"],
                    "scnetCount": summaries["scnet"][gate]["series"][feature]["count"],
                    "demucsMean": summaries["demucs"][gate]["series"][feature]["mean"],
                    "scnetMean": summaries["scnet"][gate]["series"][feature]["mean"],
                    "meanAbsoluteDifference": _mean_series_difference(
                        all_timelines["demucs"][gate].get(feature, []),
                        all_timelines["scnet"][gate].get(feature, []),
                    ),
                }
            )

    result = {
        "schemaVersion": 1,
        "source": str(args.source.resolve()),
        "sourceSha256": sha256_file(args.source),
        "sourceLicense": "unknown; local evaluation only",
        "input": {
            "sampleRateHz": 44_100,
            "channels": 2,
            "sourceFrames": len(full_mix),
            "sourceDurationSeconds": len(full_mix) / 44_100,
            "startSeconds": start_frame / 44_100,
            "frames": len(mix),
            "durationMs": duration_ms,
        },
        "separator": {
            "scnet": {
                "upstream": "https://github.com/starrytong/SCNet",
                "commit": source_commit,
                "checkpoint": checkpoint_info,
                "config": str(args.config.resolve()),
                "device": "cpu",
                "threads": args.threads,
                "seed": args.seed,
                "modelLoadSeconds": load_seconds,
                "firstInferenceWallSeconds": first_wall,
                "firstInferenceCpuSeconds": first_cpu,
                "firstInferenceCpuToWallRatio": first_cpu / max(first_wall, 1e-12),
                "warmInferenceWallSeconds": warm_wall,
                "warmInferenceCpuSeconds": warm_cpu,
                "warmInferenceCpuToWallRatio": warm_cpu / max(warm_wall, 1e-12),
                "peakRssMiB": _peak_rss_mib(),
                "dependencyEnvironmentBytes": _directory_size(Path(sys.prefix)),
                "repeatMaxAbsDelta": repeat_max_delta,
            },
            "demucs": {"implementation": "existing Python Island outputs; no rerun"},
        },
        "stemMetricsPcm16": {
            "demucs": stem_metrics(reference_stems, mix),
            "scnet": stem_metrics(scnet_stems, mix),
        },
        "featureTimelines": summaries,
        "eventComparisons": {
            gate: {
                "kickEvents": match_events(
                    all_timelines["demucs"][gate].get("kickEvents", []),
                    all_timelines["scnet"][gate].get("kickEvents", []),
                ),
                "snareEvents": match_events(
                    all_timelines["demucs"][gate].get("snareEvents", []),
                    all_timelines["scnet"][gate].get("snareEvents", []),
                ),
            }
            for gate in GATE_MODES
        },
        "accuracyMetrics": None,
        "accuracyReason": (
            "No confirmed human onset labels are supplied by this model-to-model comparison."
        ),
    }
    (output_dir / "comparison.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    with (output_dir / "features.csv").open("w", newline="", encoding="utf-8") as stream:
        columns = list(feature_rows[0]) if feature_rows else []
        writer = csv.DictWriter(stream, fieldnames=columns)
        writer.writeheader()
        writer.writerows(feature_rows)
    return result


def _mean_series_difference(
    left: list[dict[str, Any]], right: list[dict[str, Any]]
) -> float | None:
    if len(left) != len(right) or not left:
        return None
    if any(int(a["timeMs"]) != int(b["timeMs"]) for a, b in zip(left, right, strict=True)):
        return None
    a = np.asarray([float(point["value"]) for point in left], dtype=np.float64)
    b = np.asarray([float(point["value"]) for point in right], dtype=np.float64)
    return float(np.mean(np.abs(a - b)))


def _directory_size(path: Path) -> int:
    total = 0
    for root, _directories, files in os.walk(path):
        for name in files:
            try:
                total += (Path(root) / name).stat().st_size
            except OSError:
                continue
    return total


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--demucs-stems", type=Path, required=True)
    parser.add_argument("--scnet-repo", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--expected-sha256", default=EXPECTED_SCNET_SHA256)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--start-seconds", type=float, default=0.0)
    parser.add_argument("--duration-seconds", type=float)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if not 1 <= args.threads <= 16:
        raise SystemExit("--threads must be in range 1..16")
    if args.expected_sha256 != EXPECTED_SCNET_SHA256:
        raise SystemExit("This PoC only accepts the pre-recorded official standard SCNet digest")
    try:
        result = run(args)
    except (OSError, ValueError, RuntimeError, ImportError, KeyError) as error:
        print(f"scnet-poc: {error}", file=sys.stderr)
        return 2
    print(
        json.dumps(
            {"outputDir": str(args.output_dir.resolve()), "timing": result["separator"]["scnet"]},
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
