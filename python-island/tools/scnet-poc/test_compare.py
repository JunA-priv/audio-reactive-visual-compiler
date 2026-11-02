from __future__ import annotations

import unittest

import numpy as np
from compare import (
    frame_interval,
    match_events,
    stem_metrics,
    timeline_summary,
    validate_stems,
    verify_checkpoint,
)


class CompareTests(unittest.TestCase):
    def test_four_stem_shape_and_recomposition_metrics(self) -> None:
        mix = np.ones((64, 2), dtype=np.float32) * 0.4
        stems = {name: mix / 4 for name in ("drums", "bass", "vocals", "other")}
        validate_stems(stems, mix)
        metrics = stem_metrics(stems, mix)
        self.assertEqual(metrics["frames"], 64)
        self.assertLess(metrics["recomposition"]["residualRms"], 1e-8)
        self.assertEqual(metrics["stems"]["drums"]["channels"], 2)

    def test_invalid_shape_and_missing_stem_are_rejected(self) -> None:
        mix = np.ones((64, 2), dtype=np.float32)
        bad = {name: mix for name in ("drums", "bass", "vocals")}
        with self.assertRaises(ValueError):
            validate_stems(bad, mix)
        bad = {name: mix for name in ("drums", "bass", "vocals", "other")}
        bad["other"] = np.ones((63, 2), dtype=np.float32)
        with self.assertRaises(ValueError):
            validate_stems(bad, mix)

    def test_non_finite_stem_is_rejected(self) -> None:
        mix = np.ones((64, 2), dtype=np.float32)
        stems = {name: mix.copy() for name in ("drums", "bass", "vocals", "other")}
        stems["drums"][0, 0] = np.nan
        with self.assertRaises(ValueError):
            validate_stems(stems, mix)

    def test_model_event_comparison_is_one_to_one_and_not_accuracy(self) -> None:
        comparison = match_events([100, 200], [90, 105, 300], tolerance_ms=15)
        self.assertEqual(comparison["matched"], 1)
        self.assertEqual(comparison["leftOnly"], 1)
        self.assertEqual(comparison["rightOnly"], 2)
        self.assertIn("not accuracy", comparison["interpretation"])

    def test_empty_and_misaligned_timeline_values(self) -> None:
        summary = timeline_summary({"kickEvents": [], "kickEventStrengths": []})
        self.assertEqual(summary["events"]["kickEvents"]["count"], 0)
        with self.assertRaises(ValueError):
            timeline_summary({"kickEvents": [10], "kickEventStrengths": []})

    def test_checkpoint_sha_check_precedes_model_loading(self) -> None:
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint"
            path.write_bytes(b"not-a-real-model")
            with self.assertRaises(ValueError):
                verify_checkpoint(path, "0" * 64)

    def test_crop_interval_preserves_60_second_boundary_and_clamps_end(self) -> None:
        sample_rate = 44_100
        source_frames = round(189.96 * sample_rate)
        start, end = frame_interval(source_frames, sample_rate, 43.14, 60.0)
        self.assertEqual(start, round(43.14 * sample_rate))
        self.assertEqual(end - start, 60 * sample_rate)
        start, end = frame_interval(source_frames, sample_rate, 150.0, 60.0)
        self.assertEqual(end, source_frames)


if __name__ == "__main__":
    unittest.main()
