from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

from python_island.errors import AnalysisError
from python_island.features import KICK_GATE_MODES
from python_island.pipeline import run_analysis
from python_island.separation import ENGINE_SCNET_STANDARD


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Separate a local audio file and create a Feature Timeline."
    )
    parser.add_argument("input", type=Path, help="Local .wav or .mp3 file (maximum 4 minutes)")
    parser.add_argument(
        "--output-dir", required=True, type=Path, help="New or empty local output directory"
    )
    parser.add_argument(
        "--threads", type=int, default=4, help="CPU inference threads (1..16, default: 4)"
    )
    parser.add_argument(
        "--stems-dir", type=Path,
        help="Optional empty directory for 4 PCM16 stereo stem WAVs (same inference)",
    )
    parser.add_argument(
        "--kick-gate-mode",
        choices=KICK_GATE_MODES,
        default="hard",
        help="Kick candidate gate strictness (default: hard)",
    )
    engine_choices = [ENGINE_SCNET_STANDARD]
    if importlib.util.find_spec("demucs") is not None:
        engine_choices.append("htdemucs")
    parser.add_argument(
        "--engine",
        choices=engine_choices,
        default=ENGINE_SCNET_STANDARD,
        help="Separation engine (SCNet standard by default; Demucs is development-only)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = run_analysis(
            args.input,
            args.output_dir,
            threads=args.threads,
            stems_dir=args.stems_dir,
            kick_gate_mode=args.kick_gate_mode,
            engine=args.engine,
        )
    except (AnalysisError, OSError, ValueError) as error:
        print(f"python-island: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
