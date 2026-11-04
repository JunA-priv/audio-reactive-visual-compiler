from pathlib import Path

import numpy as np
import pytest

from python_island.errors import AnalysisError
from python_island.scnet_separation import (
    SCNET_CHECKPOINT_BYTES,
    SCNET_CHECKPOINT_SHA256,
    SCNET_CONFIG_SHA256,
    SCNET_MODEL_CONFIG,
    _read_model_config,
    scnet_checkpoint_path,
    separate_scnet_stems,
)


def test_scnet_model_config_is_pinned_and_has_four_sources():
    config = _read_model_config()
    assert config["sources"] == ["drums", "bass", "other", "vocals"]
    import hashlib
    import json

    serialized = json.dumps(SCNET_MODEL_CONFIG, sort_keys=True, separators=(",", ":"))
    assert hashlib.sha256(serialized.encode()).hexdigest() == SCNET_CONFIG_SHA256


def test_scnet_model_config_mismatch_fails_closed(monkeypatch, tmp_path):
    import python_island.scnet_separation as scnet

    monkeypatch.setattr(scnet, "SCNET_CONFIG_SHA256", "0" * 64)
    with pytest.raises(AnalysisError, match="config does not match"):
        _read_model_config()


def test_scnet_checkpoint_missing_and_invalid_size_fail_closed(monkeypatch, tmp_path):
    missing = tmp_path / "missing.th"
    monkeypatch.setenv("ARVC_SCNET_CHECKPOINT", str(missing))
    with pytest.raises(AnalysisError, match="checkpoint is missing"):
        scnet_checkpoint_path()

    invalid = tmp_path / "wrong-size.th"
    invalid.write_bytes(b"checkpoint")
    monkeypatch.setenv("ARVC_SCNET_CHECKPOINT", str(invalid))
    with pytest.raises(AnalysisError, match="size does not match"):
        scnet_checkpoint_path()


def test_scnet_checkpoint_hash_mismatch_fails_closed(monkeypatch, tmp_path):
    invalid = tmp_path / "wrong-hash.th"
    with invalid.open("wb") as checkpoint:
        checkpoint.truncate(SCNET_CHECKPOINT_BYTES)
    monkeypatch.setenv("ARVC_SCNET_CHECKPOINT", str(invalid))
    with pytest.raises(AnalysisError, match="SHA-256 does not match"):
        scnet_checkpoint_path()
    assert SCNET_CHECKPOINT_SHA256 != "0" * 64


@pytest.mark.parametrize(
    "audio",
    [
        np.zeros((0, 2), dtype=np.float32),
        np.zeros((32, 1), dtype=np.float32),
        np.full((32, 2), np.nan, dtype=np.float32),
    ],
)
def test_scnet_rejects_invalid_audio_without_loading_checkpoint(monkeypatch, audio):
    import python_island.scnet_separation as scnet

    monkeypatch.setattr(scnet, "scnet_checkpoint_path", lambda: pytest.fail("loaded checkpoint"))
    with pytest.raises(AnalysisError, match="finite stereo PCM"):
        separate_scnet_stems(audio, threads=2)


def test_scnet_model_load_failure_is_reported_as_analysis_error(monkeypatch, tmp_path):
    import python_island.scnet_separation as scnet

    monkeypatch.setattr(scnet, "scnet_checkpoint_path", lambda: tmp_path / "verified.th")
    def fail_load(*_args):
        raise RuntimeError("load")

    monkeypatch.setattr(scnet, "_load_scnet", fail_load)
    audio = np.ones((32, 2), dtype=np.float32)
    with pytest.raises(AnalysisError, match="SCNet CPU separation failed: RuntimeError"):
        separate_scnet_stems(audio, threads=2)


@pytest.mark.integration
def test_scnet_cpu_four_stems_and_timeline(tmp_path, monkeypatch, write_wav):
    from python_island.audio import decode_audio, probe_audio
    from python_island.features import extract_features
    from python_island.scnet_separation import separate_scnet_stems

    checkpoint = Path(__file__).parents[1] / "tools/scnet-poc/external/checkpoints/checkpoint.th"
    if not checkpoint.is_file():
        import torch

        checkpoint = Path(torch.hub.get_dir()) / "checkpoints/scnet-standard-f8aff3bc.th"
    if not checkpoint.is_file():
        pytest.skip("Pinned SCNet checkpoint is not installed locally")
    monkeypatch.setenv("ARVC_SCNET_CHECKPOINT", str(checkpoint))
    source = write_wav(tmp_path / "scnet-short-test.wav", duration=2.0)
    audio = decode_audio(source, probe_audio(source))
    stems = separate_scnet_stems(audio, threads=2)
    assert set(stems) == {"drums", "bass", "vocals", "other"}
    for stem in stems.values():
        assert stem.shape == audio.shape
        assert np.isfinite(stem).all()
    timeline = extract_features(stems, round(len(audio) * 1000 / 44_100), audio)
    assert timeline["bassEnvelope"] and timeline["drumEnergy"]
