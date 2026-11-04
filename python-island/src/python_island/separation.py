from __future__ import annotations

from pathlib import Path

import numpy as np

from python_island.errors import AnalysisError
from python_island.scnet_separation import (
    scnet_checkpoint_metadata,
    scnet_checkpoint_path,
    separate_scnet_stems,
)
from python_island.separation_types import (
    ENGINE_DEMUCS_HTDEMUCS,
    ENGINE_SCNET_STANDARD,
    SEPARATION_ENGINES,
    STEM_NAMES,
)


def separate_stems(
    audio: np.ndarray, *, threads: int, engine: str = ENGINE_SCNET_STANDARD
) -> dict[str, np.ndarray]:
    if engine == ENGINE_SCNET_STANDARD:
        return separate_scnet_stems(audio, threads=threads)
    if engine == ENGINE_DEMUCS_HTDEMUCS:
        from python_island.demucs_separation import separate_stems as separate_demucs_stems

        return separate_demucs_stems(audio, threads=threads)
    raise AnalysisError(f"Unsupported separation engine: {engine}")


def checkpoint_path(engine: str = ENGINE_SCNET_STANDARD) -> Path:
    if engine == ENGINE_SCNET_STANDARD:
        return scnet_checkpoint_path()
    if engine == ENGINE_DEMUCS_HTDEMUCS:
        from python_island.demucs_separation import checkpoint_path as demucs_checkpoint_path

        return demucs_checkpoint_path()
    raise AnalysisError(f"Unsupported separation engine: {engine}")


def checkpoint_metadata(path: Path, engine: str = ENGINE_SCNET_STANDARD) -> dict[str, object]:
    if engine == ENGINE_SCNET_STANDARD:
        return scnet_checkpoint_metadata(path)
    if engine == ENGINE_DEMUCS_HTDEMUCS:
        from python_island.demucs_separation import checkpoint_metadata as demucs_metadata

        return demucs_metadata(path)
    raise AnalysisError(f"Unsupported separation engine: {engine}")


def model_info(engine: str = ENGINE_SCNET_STANDARD) -> dict[str, object]:
    path = checkpoint_path(engine)
    return checkpoint_metadata(path, engine)


__all__ = [
    "ENGINE_DEMUCS_HTDEMUCS",
    "ENGINE_SCNET_STANDARD",
    "SEPARATION_ENGINES",
    "STEM_NAMES",
    "checkpoint_metadata",
    "checkpoint_path",
    "model_info",
    "separate_stems",
]
