from __future__ import annotations

import subprocess
import wave
from pathlib import Path

import numpy as np
import pytest


@pytest.fixture
def write_wav(tmp_path: Path):
    def write(path: Path, *, duration: float = 2.0, silence: bool = False) -> Path:
        rate = 44_100
        count = round(rate * duration)
        time = np.arange(count, dtype=np.float64) / rate
        signal = (
            np.zeros(count, dtype=np.float64) if silence else 0.2 * np.sin(2 * np.pi * 55 * time)
        )
        stereo = np.column_stack((signal, signal))
        pcm = np.clip(stereo * 32767, -32768, 32767).astype("<i2")
        with wave.open(str(path), "wb") as output:
            output.setnchannels(2)
            output.setsampwidth(2)
            output.setframerate(rate)
            output.writeframes(pcm.tobytes())
        return path

    return write


@pytest.fixture
def write_mp3(write_wav, tmp_path: Path):
    def write(*, duration: float = 2.0) -> Path:
        wav = write_wav(tmp_path / "encoded source.wav", duration=duration)
        mp3 = tmp_path / "audio with spaces.mp3"
        subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(wav), str(mp3)],
            check=True,
            capture_output=True,
        )
        return mp3

    return write
