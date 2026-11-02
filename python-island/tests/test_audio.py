import pytest

from python_island.audio import decode_audio, probe_audio
from python_island.errors import AnalysisError


def test_wav_and_mp3_decode(tmp_path, write_wav, write_mp3):
    wav = write_wav(tmp_path / "regular.wav", duration=1.25)
    mp3 = write_mp3(duration=1.25)
    for path in (wav, mp3):
        info = probe_audio(path)
        samples = decode_audio(path, info)
        assert info.duration_seconds == pytest.approx(1.25, abs=0.08)
        assert info.source_channels == 2
        assert samples.ndim == 2 and samples.shape[1] == 2
        assert samples.shape[0] > 0


def test_invalid_format_corrupt_file_and_missing_input_are_rejected(tmp_path):
    unsupported = tmp_path / "audio.ogg"
    unsupported.write_bytes(b"not audio")
    corrupt = tmp_path / "broken.mp3"
    corrupt.write_bytes(b"not an mp3")
    with pytest.raises(AnalysisError, match="Only"):
        probe_audio(unsupported)
    with pytest.raises(AnalysisError, match="corrupt"):
        probe_audio(corrupt)
    with pytest.raises(FileNotFoundError):
        probe_audio(tmp_path / "missing.wav")


def test_mismatched_extension_is_rejected(tmp_path, write_mp3):
    source = write_mp3()
    mislabeled = tmp_path / "audio.wav"
    mislabeled.write_bytes(source.read_bytes())
    with pytest.raises(AnalysisError, match="extension"):
        probe_audio(mislabeled)


def test_silence_and_duration_limit_are_rejected(tmp_path, write_wav):
    silent = write_wav(tmp_path / "silence.wav", duration=1.0, silence=True)
    with pytest.raises(AnalysisError, match="Silent"):
        decode_audio(silent, probe_audio(silent))
    long_path = write_wav(tmp_path / "long.wav", duration=1.1)
    with pytest.raises(AnalysisError, match="duration"):
        probe_audio(long_path, max_duration=1.0)


def test_input_size_guard_is_enforced(tmp_path, write_wav, monkeypatch):
    from python_island import audio

    source = write_wav(tmp_path / "large.wav")
    monkeypatch.setattr(audio, "MAX_FILE_BYTES", 100)
    with pytest.raises(AnalysisError, match="local limit"):
        probe_audio(source)
