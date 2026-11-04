from __future__ import annotations

import csv
import tempfile
import unittest
from pathlib import Path

import numpy as np
from compare import (
    CSV_FIELDS,
    GATE_MODES,
    SERIES_FEATURES,
    build_feature_rows,
    build_series_comparisons,
    frame_interval,
    is_official_scnet_origin,
    match_events,
    stem_metrics,
    timeline_summary,
    validate_stems,
    verify_checkpoint,
    write_feature_csv,
)


class CompareTests(unittest.TestCase):
    def test_feature_csv_has_all_gate_event_and_series_records(self) -> None:
        summaries = {"demucs": {}, "scnet": {}}
        comparisons = {}
        timelines = {"demucs": {}, "scnet": {}}
        for gate in GATE_MODES:
            summaries["demucs"][gate] = {
                "events": {name: {"count": 2} for name in ("kickEvents", "snareEvents")},
            }
            summaries["scnet"][gate] = {
                "events": {name: {"count": 1} for name in ("kickEvents", "snareEvents")},
            }
            comparisons[gate] = {
                name: match_events([100, 200], [110])
                for name in ("kickEvents", "snareEvents")
            }
            timelines["demucs"][gate] = {}
            timelines["scnet"][gate] = {}
            for feature in SERIES_FEATURES:
                summaries["demucs"][gate].setdefault("series", {})[feature] = {"count": 2}
                summaries["scnet"][gate].setdefault("series", {})[feature] = {"count": 2}
                timelines["demucs"][gate][feature] = [
                    {"timeMs": 0, "value": 0.0}, {"timeMs": 10, "value": 1.0}
                ]
                timelines["scnet"][gate][feature] = [
                    {"timeMs": 0, "value": 0.0}, {"timeMs": 10, "value": 0.5}
                ]

        series_comparisons = build_series_comparisons(timelines)
        rows = build_feature_rows(summaries, comparisons, series_comparisons)
        self.assertEqual(len(rows), 28)
        self.assertEqual({row["gateMode"] for row in rows}, set(GATE_MODES))
        event_rows = [row for row in rows if row["feature"].endswith("Events")]
        series_rows = [row for row in rows if row["feature"] in SERIES_FEATURES]
        self.assertEqual(len(event_rows), 8)
        self.assertEqual(len(series_rows), 20)
        self.assertEqual(event_rows[0]["matchedWithin80ms"], 1)
        self.assertEqual(event_rows[0]["medianAbsOffsetMs"], 10.0)
        self.assertEqual(event_rows[0]["p90AbsOffsetMs"], 10.0)
        self.assertEqual(event_rows[0]["maxAbsOffsetMs"], 10.0)
        self.assertEqual(event_rows[0]["matchRate"], 0.5)
        self.assertEqual(series_rows[0]["meanAbsoluteDifference"], 0.25)
        self.assertEqual(series_rows[0]["normalizedMeanAbsoluteDifference"], 0.5)
        self.assertAlmostEqual(series_rows[0]["pearsonCorrelation"], 1.0)
        self.assertEqual(series_rows[0]["peakTimeDeltaMs"], 0)
        json_comparison = series_comparisons["off"]["bassEnvelope"]
        self.assertEqual(
            series_rows[0]["meanAbsoluteDifference"],
            json_comparison["meanAbsoluteDifference"],
        )
        self.assertEqual(
            series_rows[0]["pearsonCorrelation"],
            json_comparison["pearsonCorrelation"],
        )

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "features.csv"
            write_feature_csv(path, rows)
            with path.open(encoding="utf-8", newline="") as stream:
                reader = csv.DictReader(stream)
                persisted = list(reader)
                self.assertEqual(tuple(reader.fieldnames or ()), CSV_FIELDS)
            self.assertEqual(len(persisted), 28)
            self.assertEqual(persisted[0]["demucsCount"], "2")
            self.assertEqual(persisted[0]["matchedWithin80ms"], "1")
            self.assertEqual(persisted[2]["pearsonCorrelation"], "1.0")
            self.assertEqual(persisted[0]["pearsonCorrelation"], "")

    def test_feature_series_missing_misaligned_empty_and_non_finite(self) -> None:
        from compare import _compare_series

        empty = _compare_series([], [])
        self.assertEqual(empty["comparisonStatus"], "empty")
        self.assertIsNone(empty["pearsonCorrelation"])
        misaligned = _compare_series(
            [{"timeMs": 0, "value": 1.0}], [{"timeMs": 10, "value": 1.0}]
        )
        self.assertEqual(misaligned["comparisonStatus"], "misaligned")
        self.assertIsNone(misaligned["meanAbsoluteDifference"])
        different_lengths = _compare_series(
            [{"timeMs": 0, "value": 1.0}],
            [{"timeMs": 0, "value": 1.0}, {"timeMs": 10, "value": 0.5}],
        )
        self.assertEqual(different_lengths["comparisonStatus"], "misaligned")
        missing = _compare_series([{"timeMs": 0}], [{"timeMs": 0, "value": 0.0}])
        self.assertEqual(missing["comparisonStatus"], "missing_or_invalid_values")
        zero_baseline = _compare_series(
            [{"timeMs": 0, "value": 0.0}, {"timeMs": 10, "value": 0.0}],
            [{"timeMs": 0, "value": 0.0}, {"timeMs": 10, "value": 0.0}],
        )
        self.assertEqual(zero_baseline["comparisonStatus"], "ok")
        self.assertIsNone(zero_baseline["normalizedMeanAbsoluteDifference"])
        self.assertIsNone(zero_baseline["pearsonCorrelation"])
        with self.assertRaises(ValueError):
            _compare_series(
                [{"timeMs": 0, "value": float("nan")}],
                [{"timeMs": 0, "value": 0.0}],
            )

    def test_empty_feature_csv_still_has_compatible_header(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "features.csv"
            write_feature_csv(path, [])
            with path.open(encoding="utf-8", newline="") as stream:
                reader = csv.reader(stream)
                self.assertEqual(tuple(next(reader)), CSV_FIELDS)
                self.assertEqual(list(reader), [])

    def test_official_scnet_origin_allows_case_variants(self) -> None:
        for origin in (
            "https://github.com/starrytong/SCNet.git",
            "HTTPS://GITHUB.COM/StarryTong/scnet",
            "git@github.com:StarryTong/SCNET.git",
        ):
            with self.subTest(origin=origin):
                self.assertTrue(is_official_scnet_origin(origin))

    def test_scnet_origin_rejects_other_or_malformed_repositories(self) -> None:
        for origin in (
            "https://github.com/other/SCNet.git",
            "https://github.com/starrytong/SCNet-fork.git",
            "https://github.com.evil.example/starrytong/SCNet.git",
            "https://github.com/starrytong/SCNet/extra.git",
            "https://github.com//starrytong/SCNet.git",
            "http://github.com/starrytong/SCNet.git",
            "https://user@github.com/starrytong/SCNet.git",
            "git@github.com:starrytong/SCNet-evil.git",
        ):
            with self.subTest(origin=origin):
                self.assertFalse(is_official_scnet_origin(origin))

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
