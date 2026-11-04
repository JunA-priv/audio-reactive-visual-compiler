from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

import numpy as np

from python_island.audio import TARGET_SAMPLE_RATE
from python_island.errors import AnalysisError
from python_island.separation_types import STEM_NAMES

SCNET_COMMIT = "5d95bf96b19c3eede63248d171efeca8e3abb948"
SCNET_CHECKPOINT_SHA256 = "f8aff3bc8dd816aad392800d9d69519add719a2fbd22550af6f8cb2138d25ff5"
SCNET_CHECKPOINT_BYTES = 42_434_545
SCNET_UPSTREAM_CONFIG_SHA256 = "bc16895f69551cd8becbba384ae33e6e615a4792649b866036884f4a9a4bb4b0"
SCNET_CONFIG_SHA256 = "8a322c3ac40507b8e7515062ee4f7d5644c1540c1ce134eb250d5382ac02cd24"
SCNET_CHECKPOINT_NAME = "scnet-standard-f8aff3bc.th"
SCNET_REPOSITORY_URL = "https://github.com/starrytong/SCNet"
_INTEROP_THREADS_CONFIGURED = False
SCNET_MODEL_CONFIG: dict[str, Any] = {
    "sources": ["drums", "bass", "other", "vocals"],
    "audio_channels": 2,
    "dims": [4, 32, 64, 128],
    "nfft": 4096,
    "hop_size": 1024,
    "win_size": 4096,
    "normalized": True,
    "band_SR": [0.175, 0.392, 0.433],
    "band_stride": [1, 4, 16],
    "band_kernel": [3, 4, 16],
    "conv_depths": [3, 2, 1],
    "compress": 4,
    "conv_kernel": 3,
    "num_dplayer": 6,
    "expand": 1,
}


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def scnet_checkpoint_path() -> Path:
    override = os.environ.get("ARVC_SCNET_CHECKPOINT")
    if override:
        path = Path(override).expanduser().resolve()
    else:
        import torch

        path = Path(torch.hub.get_dir()) / "checkpoints" / SCNET_CHECKPOINT_NAME
    if not path.is_file():
        raise AnalysisError(
            "Verified SCNet standard checkpoint is missing; install it at "
            f"{path} or set ARVC_SCNET_CHECKPOINT. No model is downloaded automatically."
        )
    if path.stat().st_size != SCNET_CHECKPOINT_BYTES:
        raise AnalysisError("SCNet checkpoint size does not match the pinned standard model")
    if _sha256_file(path) != SCNET_CHECKPOINT_SHA256:
        raise AnalysisError("SCNet checkpoint SHA-256 does not match the pinned standard model")
    return path


def _read_model_config() -> dict[str, Any]:
    config_bytes = json.dumps(
        SCNET_MODEL_CONFIG, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    if hashlib.sha256(config_bytes).hexdigest() != SCNET_CONFIG_SHA256:
        raise AnalysisError("Bundled SCNet model config does not match the pinned config")
    return SCNET_MODEL_CONFIG


def _load_scnet(checkpoint: Path, threads: int) -> Any:
    global _INTEROP_THREADS_CONFIGURED
    import torch

    torch.set_num_threads(threads)
    if not _INTEROP_THREADS_CONFIGURED:
        if torch.get_num_interop_threads() != 1:
            torch.set_num_interop_threads(1)
        _INTEROP_THREADS_CONFIGURED = True

    from python_island._scnet.SCNet import SCNet

    model = SCNet(**_read_model_config())  # type: ignore[no-untyped-call]
    state_file = torch.load(checkpoint, map_location="cpu", weights_only=True)
    if not isinstance(state_file, dict) or not isinstance(state_file.get("best_state"), dict):
        raise AnalysisError("SCNet checkpoint must contain a tensor best_state mapping")
    state = state_file["best_state"]
    if not state or any(not isinstance(value, torch.Tensor) for value in state.values()):
        raise AnalysisError("SCNet checkpoint best_state must contain only tensors")
    state = {
        key[7:] if key.startswith("module.") else key: value for key, value in state.items()
    }
    model.load_state_dict(state, strict=True)
    model.eval()
    model.to(torch.device("cpu"))
    torch.use_deterministic_algorithms(True)
    torch.manual_seed(0)
    return model


def separate_scnet_stems(audio: np.ndarray, *, threads: int) -> dict[str, np.ndarray]:
    if audio.ndim != 2 or audio.shape[1] != 2 or audio.size == 0 or not np.isfinite(audio).all():
        raise AnalysisError("Model input must be finite stereo PCM")
    checkpoint = scnet_checkpoint_path()
    try:
        import torch

        model = _load_scnet(checkpoint, threads)
        from python_island._scnet import apply as scnet_apply

        waveform = torch.from_numpy(audio.T.copy()).to(dtype=torch.float32)
        mono = waveform.mean(0)
        mean = mono.mean()
        std = mono.std()
        if not torch.isfinite(std) or float(std) <= torch.finfo(waveform.dtype).eps:
            return {name: np.zeros_like(audio) for name in STEM_NAMES}
        normalized = ((waveform - mean) / std).unsqueeze(0)
        with torch.inference_mode():
            separated = scnet_apply.apply_model(
                model,
                normalized,
                shifts=0,
                split=True,
                segment=20,
                samplerate=TARGET_SAMPLE_RATE,
                overlap=0.5,
                progress=False,
                device=torch.device("cpu"),
                num_workers=0,
            )[0]  # type: ignore[no-untyped-call]
        separated = separated * std + mean
        array = separated.detach().cpu().numpy()
        sources = list(getattr(model, "sources", ()))
        if array.ndim != 3 or array.shape[1] != 2 or array.shape[2] != len(audio):
            raise AnalysisError("SCNet returned an unexpected stem tensor shape")
        if len(sources) != array.shape[0]:
            raise AnalysisError("SCNet returned unexpected stem identifiers")
        result = {
            name: array[sources.index(name)].T.copy() for name in STEM_NAMES if name in sources
        }
        if set(result) != set(STEM_NAMES) or any(
            stem.shape != audio.shape or not np.isfinite(stem).all() for stem in result.values()
        ):
            raise AnalysisError("SCNet did not return all finite 4-stem outputs")
        return result
    except AnalysisError:
        raise
    except Exception as error:
        raise AnalysisError(
            f"SCNet CPU separation failed: {type(error).__name__}: {error}"
        ) from error


def scnet_checkpoint_metadata(path: Path) -> dict[str, object]:
    return {
        "model": "scnet_standard",
        "sourceRepository": SCNET_REPOSITORY_URL,
        "sourceCommit": SCNET_COMMIT,
        "configSha256": SCNET_CONFIG_SHA256,
        "upstreamConfigSha256": SCNET_UPSTREAM_CONFIG_SHA256,
        "checkpointCache": f"torch.hub/checkpoints/{SCNET_CHECKPOINT_NAME}",
        "checkpointBytes": path.stat().st_size,
        "checkpointSha256": _sha256_file(path),
        "device": "cpu",
        "sampleRateHz": TARGET_SAMPLE_RATE,
        "stems": list(STEM_NAMES),
        "weightsOnly": True,
        "strictStateLoad": True,
    }
