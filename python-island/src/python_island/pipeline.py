from __future__ import annotations

import json
import platform
import resource
import subprocess
import sys
import time
import wave
from collections.abc import Callable
from pathlib import Path

import numpy as np
import torch

from python_island import __version__
from python_island.audio import AudioInfo, decode_audio, probe_audio
from python_island.errors import AnalysisError
from python_island.features import KICK_GATE_MODES, FeatureTimeline, extract_features
from python_island.separation import checkpoint_metadata, checkpoint_path, separate_stems


def _json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def _write_stem_wav(path: Path, samples: np.ndarray) -> None:
    if samples.ndim != 2 or samples.shape[1] != 2 or samples.shape[0] == 0 or not np.isfinite(samples).all():
        raise AnalysisError(f"Stem must be finite, non-empty stereo PCM: {path.name}")
    pcm = np.rint(np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(44_100)
        output.writeframes(pcm.tobytes())


def _peak_rss_mib() -> float:
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return float(peak / 1024 if sys.platform.startswith("linux") else peak / (1024 * 1024))


def _tool_version(name: str) -> str:
    try:
        result = subprocess.run(
            [name, "-version"], check=False, capture_output=True, text=True, timeout=5
        )
    except (OSError, subprocess.TimeoutExpired):
        return "unknown"
    return result.stdout.splitlines()[0] if result.stdout else "unknown"


def run_analysis(
    input_path: Path,
    output_dir: Path,
    *,
    threads: int = 4,
    separator: Callable[..., dict[str, np.ndarray]] | None = None,
    stems_dir: Path | None = None,
    kick_gate_mode: str = "hard",
) -> dict[str, object]:
    if threads < 1 or threads > 16:
        raise AnalysisError("CPU thread count must be between 1 and 16")
    if kick_gate_mode not in KICK_GATE_MODES:
        raise AnalysisError("Kick gate mode must be off, soft, middle, or hard")
    source = input_path.expanduser().resolve(strict=True)
    destination = output_dir.expanduser().resolve()
    names = ("feature-timeline.json", "music-summary.json", "analysis-metadata.json")
    if destination == source or any((destination / name).resolve() == source for name in names):
        raise AnalysisError("Output files must not overwrite the input audio")
    if destination.exists() and not destination.is_dir():
        raise AnalysisError("Output path must be a directory")
    for name in names:
        if (destination / name).exists():
            raise AnalysisError(f"Refusing to overwrite existing output: {destination / name}")
    stem_destination = stems_dir.expanduser().resolve() if stems_dir is not None else None
    if stem_destination is not None:
        if stem_destination == source or source in stem_destination.parents:
            raise AnalysisError("Stem output must not be inside or overwrite the input audio")
        if stem_destination.exists() and (not stem_destination.is_dir() or any(stem_destination.iterdir())):
            raise AnalysisError(f"Refusing to write stems into non-empty output: {stem_destination}")

    started = time.perf_counter()
    input_info: AudioInfo = probe_audio(source)
    decode_started = time.perf_counter()
    audio = decode_audio(source, input_info)
    decode_seconds = time.perf_counter() - decode_started
    duration_ms = round(len(audio) * 1000 / 44_100)

    separation_started = time.perf_counter()
    stems = (separator or separate_stems)(audio, threads=threads)
    separation_seconds = time.perf_counter() - separation_started
    required_stems = {"drums", "bass", "vocals", "other"}
    if set(stems) != required_stems:
        raise AnalysisError("Demucs output must contain exactly drums, bass, vocals, and other")
    if any(stem.shape != audio.shape or not np.isfinite(stem).all() for stem in stems.values()):
        raise AnalysisError("Demucs stems must be finite and match input duration and channels")

    features_started = time.perf_counter()
    timeline: FeatureTimeline = extract_features(
        stems, duration_ms, audio, kick_gate_mode=kick_gate_mode
    )
    feature_seconds = time.perf_counter() - features_started
    timeline.update(
        {
            "schemaVersion": 1,
            "analysisVersion": f"python-island/{__version__}",
            "sampleRateHz": 44_100,
            "timeUnit": "ms",
            "kickEventStrengthsUnit": "p99-normalized low-band onset and decay score, 0..1",
            "snareEventStrengthsUnit": "normalized 700-10000Hz mixed-drum transient peak, 0..1; snare-like estimate, not isolated snare",
        }
    )

    stem_rms = {
        name: float(np.sqrt(np.mean(np.square(values, dtype=np.float64))))
        for name, values in stems.items()
    }
    summary: dict[str, object] = {
        "summaryVersion": 1,
        "durationMs": duration_ms,
        "sourceAudio": {
            "format": source.suffix.lower().lstrip("."),
            "codec": input_info.codec,
            "sampleRateHz": input_info.source_sample_rate,
            "channels": input_info.source_channels,
            "fileBytes": input_info.file_bytes,
        },
        "analysis": {
            "model": "htdemucs",
            "device": "cpu",
            "stemRms": stem_rms,
            "estimatedKickCount": len(timeline["kickEvents"]),
            "featureSampleRateHz": 100,
            "kickDetection": (
                "Estimated from drums-stem 35-120Hz rises, 35-80Hz/body ratio, "
                "and 80ms decay; not labeled truth."
            ),
        },
    }

    model_path = checkpoint_path()
    model_info = checkpoint_metadata(model_path)
    elapsed = time.perf_counter() - started
    metadata: dict[str, object] = {
        "metadataVersion": 1,
        "pythonIslandVersion": __version__,
        "pythonVersion": platform.python_version(),
        "pytorchVersion": torch.__version__,
        "demucsVersion": "4.1.0",
        "numpyVersion": np.__version__,
        "ffmpegVersion": _tool_version("ffmpeg"),
        "ffprobeVersion": _tool_version("ffprobe"),
        "runtime": {
            "platform": platform.platform(),
            "cpu": platform.processor() or platform.machine(),
            "logicalCpuCount": __import__("os").cpu_count(),
            "threads": threads,
            "device": "cpu",
            "inputDurationSeconds": duration_ms / 1000,
            "decodeSeconds": round(decode_seconds, 3),
            "separationSeconds": round(separation_seconds, 3),
            "featureExtractionSeconds": round(feature_seconds, 3),
            "totalSeconds": round(elapsed, 3),
            "peakRssMiB": round(_peak_rss_mib(), 1),
        },
        "model": model_info,
    }
    if stem_destination is not None:
        metadata["stemOutputs"] = {
            name: {
                "file": f"{name}.wav",
                "sampleRateHz": 44_100,
                "channels": 2,
                "sampleFrames": int(samples.shape[0]),
                "fileBytes": 44 + int(samples.shape[0]) * 2 * 2,
            }
            for name, samples in stems.items()
        }

    outputs = {
        "feature-timeline.json": _json_bytes(timeline),
        "music-summary.json": _json_bytes(summary),
    }
    output_sizes = {name: len(contents) for name, contents in outputs.items()}
    output_sizes["analysis-metadata.json"] = 0
    metadata["outputBytes"] = output_sizes
    metadata_bytes = _json_bytes(metadata)
    while output_sizes["analysis-metadata.json"] != len(metadata_bytes):
        output_sizes["analysis-metadata.json"] = len(metadata_bytes)
        metadata_bytes = _json_bytes(metadata)
    outputs["analysis-metadata.json"] = metadata_bytes

    destination.mkdir(parents=True, exist_ok=True)
    if stem_destination is not None:
        stem_destination.mkdir(parents=True, exist_ok=True)
        for name, samples in stems.items():
            _write_stem_wav(stem_destination / f"{name}.wav", samples)
    for name, contents in outputs.items():
        target = destination / name
        if target.exists():
            raise AnalysisError(f"Refusing to overwrite existing output: {target}")
        target.write_bytes(contents)
    del stems, audio
    return {
        "outputDir": str(destination),
        "outputBytes": sum(len(content) for content in outputs.values()),
        "durationMs": duration_ms,
        "separationSeconds": round(separation_seconds, 3),
        "featureExtractionSeconds": round(feature_seconds, 3),
        "totalSeconds": round(elapsed, 3),
        "peakRssMiB": round(_peak_rss_mib(), 1),
        "kickCount": len(timeline["kickEvents"]),
    }
