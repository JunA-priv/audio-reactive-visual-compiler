import numpy as np
import pytest

from python_island.audio import decode_audio, probe_audio
from python_island.features import extract_features
from python_island.separation import checkpoint_path, separate_stems


@pytest.mark.integration
def test_real_htdemucs_cpu_four_stems_and_repeatability(tmp_path, write_wav):
    try:
        checkpoint_path()
    except Exception as error:
        pytest.skip(str(error))
    source = write_wav(tmp_path / "synthetic short test.wav", duration=2.0)
    audio = decode_audio(source, probe_audio(source))
    first = separate_stems(audio, threads=4)
    second = separate_stems(audio, threads=4)
    assert set(first) == {"drums", "bass", "vocals", "other"}
    for name in first:
        assert first[name].shape == audio.shape
        assert np.isfinite(first[name]).all()
        np.testing.assert_array_equal(first[name], second[name])
    timeline = extract_features(first, round(len(audio) * 1000 / 44_100), audio)
    assert timeline["bassEnvelope"] and timeline["drumEnergy"]
