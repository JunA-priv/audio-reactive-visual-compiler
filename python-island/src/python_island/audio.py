from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from python_island.errors import AnalysisError

TARGET_SAMPLE_RATE = 44_100
MAX_DURATION_SECONDS = 240.0
MAX_FILE_BYTES = 512 * 1024 * 1024


@dataclass(frozen=True)
class AudioInfo:
    duration_seconds: float
    source_sample_rate: int
    source_channels: int
    codec: str
    file_bytes: int


def _program(name: str) -> str:
    path = shutil.which(name)
    if path is None:
        raise AnalysisError(f"Required program not found on PATH: {name}")
    return path


def probe_audio(path: Path, *, max_duration: float = MAX_DURATION_SECONDS) -> AudioInfo:
    resolved = path.expanduser().resolve(strict=True)
    if not resolved.is_file():
        raise AnalysisError("Input must be a regular file")
    if resolved.suffix.lower() not in {".wav", ".mp3"}:
        raise AnalysisError("Only .wav and .mp3 inputs are accepted")
    file_bytes = resolved.stat().st_size
    if file_bytes == 0:
        raise AnalysisError("Input file is empty")
    if file_bytes > MAX_FILE_BYTES:
        raise AnalysisError(f"Input exceeds the local limit of {MAX_FILE_BYTES} bytes")

    command = [
        _program("ffprobe"),
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_name,sample_rate,channels,duration:format=duration,format_name",
        "-of",
        "json",
        str(resolved),
    ]
    try:
        result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise AnalysisError(f"Unable to inspect input with ffprobe: {error}") from error
    if result.returncode != 0:
        raise AnalysisError("Input is corrupt or cannot be decoded by ffprobe")
    try:
        metadata = json.loads(result.stdout)
        streams = metadata["streams"]
        stream = streams[0]
        duration = float(stream.get("duration") or metadata["format"]["duration"])
        sample_rate = int(stream["sample_rate"])
        channels = int(stream["channels"])
        codec = str(stream["codec_name"])
        container = str(metadata["format"]["format_name"])
    except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise AnalysisError("Input has incomplete or invalid audio metadata") from error
    if not np.isfinite(duration) or duration <= 0 or duration > max_duration:
        raise AnalysisError(
            f"Audio duration must be greater than zero and at most {max_duration:g}s"
        )
    if sample_rate <= 0 or channels <= 0:
        raise AnalysisError("Input has invalid channel count or sample rate")
    if (resolved.suffix.lower() == ".wav" and "wav" not in container.split(",")) or (
        resolved.suffix.lower() == ".mp3" and "mp3" not in container.split(",")
    ):
        raise AnalysisError("File extension does not match the detected audio container")
    return AudioInfo(duration, sample_rate, channels, codec, file_bytes)


def decode_audio(path: Path, info: AudioInfo) -> np.ndarray:
    resolved = path.expanduser().resolve(strict=True)
    command = [
        _program("ffmpeg"),
        "-nostdin",
        "-v",
        "error",
        "-i",
        str(resolved),
        "-map",
        "0:a:0",
        "-vn",
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "-ar",
        str(TARGET_SAMPLE_RATE),
        "-ac",
        "2",
        "pipe:1",
    ]
    timeout = max(30.0, info.duration_seconds * 2.0 + 20.0)
    try:
        result = subprocess.run(command, check=False, capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise AnalysisError(f"Unable to decode audio with FFmpeg: {error}") from error
    if result.returncode != 0 or not result.stdout:
        raise AnalysisError("FFmpeg failed to decode the input audio")
    if len(result.stdout) % (2 * 4) != 0:
        raise AnalysisError("Decoded audio has an incomplete PCM frame")
    frames = np.frombuffer(result.stdout, dtype="<f4").reshape((-1, 2)).copy()
    actual_duration = len(frames) / TARGET_SAMPLE_RATE
    if not np.isfinite(frames).all():
        raise AnalysisError("Decoded audio contains NaN or Infinity")
    if actual_duration <= 0 or actual_duration > MAX_DURATION_SECONDS:
        raise AnalysisError("Decoded duration is outside the supported range")
    if float(np.sqrt(np.mean(np.square(frames, dtype=np.float64)))) <= 1e-7:
        raise AnalysisError("Silent audio is not supported")
    return frames
