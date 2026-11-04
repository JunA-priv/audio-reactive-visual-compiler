from __future__ import annotations

import hashlib
import shutil
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

from python_island.audio import TARGET_SAMPLE_RATE
from python_island.errors import AnalysisError

CHECKPOINT_NAME = "955717e8-8726e21a.th"
CHECKPOINT_SHA256_PREFIX = "8726e21a"
CHECKPOINT_URL = "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th"
STEM_NAMES = ("drums", "bass", "vocals", "other")
_INTEROP_THREADS_CONFIGURED = False


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as checkpoint:
        for chunk in iter(lambda: checkpoint.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def checkpoint_path() -> Path:
    import torch

    path = Path(torch.hub.get_dir()) / "checkpoints" / CHECKPOINT_NAME
    if not path.is_file():
        raise AnalysisError(
            f"Cached htdemucs model is required; expected {path}. "
            "This CLI does not download model weights implicitly."
        )
    digest = _sha256_file(path)
    if not digest.startswith(CHECKPOINT_SHA256_PREFIX):
        raise AnalysisError(
            "Cached htdemucs checkpoint hash does not match its official hash prefix"
        )
    return path


def separate_stems(audio: np.ndarray, *, threads: int) -> dict[str, np.ndarray]:
    global _INTEROP_THREADS_CONFIGURED
    if audio.ndim != 2 or audio.shape[1] != 2 or audio.size == 0 or not np.isfinite(audio).all():
        raise AnalysisError("Model input must be finite stereo PCM")
    try:
        import torch
        from demucs import pretrained
        from demucs.apply import apply_model
    except ImportError as error:
        raise AnalysisError(f"Demucs/PyTorch dependencies are not installed: {error}") from error

    checkpoint_path()
    torch.set_num_threads(threads)
    if not _INTEROP_THREADS_CONFIGURED:
        torch.set_num_interop_threads(1)
        _INTEROP_THREADS_CONFIGURED = True
    torch.use_deterministic_algorithms(True)
    torch.manual_seed(0)
    try:
        remote_config = Path(pretrained.__file__).parent / "remote" / "htdemucs.yaml"
        if not remote_config.is_file():
            raise AnalysisError(
                "Demucs package does not contain the pinned htdemucs model manifest"
            )
        with tempfile.TemporaryDirectory(prefix="python-island-model-") as temporary_repo:
            local_repo = Path(temporary_repo)
            shutil.copyfile(remote_config, local_repo / "htdemucs.yaml")
            (local_repo / CHECKPOINT_NAME).symlink_to(checkpoint_path())
            model: Any = pretrained.get_model("htdemucs", repo=local_repo)
            model.to(torch.device("cpu"))
            model.eval()
            waveform = torch.from_numpy(audio.T.copy()).to(dtype=torch.float32).unsqueeze(0)
            with torch.inference_mode():
                separated = apply_model(
                    model,
                    waveform,
                    device=torch.device("cpu"),
                    shifts=0,
                    split=True,
                    overlap=0.25,
                    progress=False,
                    num_workers=0,
                )
    except Exception as error:
        raise AnalysisError(
            f"Demucs CPU separation failed: {type(error).__name__}: {error}"
        ) from error
    array = separated.detach().cpu().numpy()
    sources = list(getattr(model, "sources", ()))
    if array.ndim != 4 or array.shape[0] != 1 or len(sources) != array.shape[1]:
        raise AnalysisError("Demucs returned an unexpected stem tensor shape")
    result = {
        name: array[0, sources.index(name)].T.copy() for name in STEM_NAMES if name in sources
    }
    if set(result) != set(STEM_NAMES) or any(
        not np.isfinite(stem).all() for stem in result.values()
    ):
        raise AnalysisError("Demucs did not return all finite 4-stem outputs")
    return result


def checkpoint_metadata(path: Path) -> dict[str, object]:
    return {
        "model": "htdemucs",
        "demucsVersion": "4.1.0",
        "checkpointSource": CHECKPOINT_URL,
        "checkpointCache": "torch.hub/checkpoints/955717e8-8726e21a.th",
        "checkpointBytes": path.stat().st_size,
        "checkpointSha256": _sha256_file(path),
        "device": "cpu",
        "shifts": 0,
        "sampleRateHz": TARGET_SAMPLE_RATE,
        "stems": list(STEM_NAMES),
    }
