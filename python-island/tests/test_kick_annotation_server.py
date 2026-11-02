from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from python_island.kick_annotation_server import (
    _atomic_json,
    _parse_byte_range,
    _write_audio_range,
    build_handler,
    synchronize_candidate_predictions,
    validate_annotations,
)


def _annotations() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "assetHashes": {"sourceSha256": "a", "stemSha256": "b", "candidateSha256": "c"},
        "candidateReviews": [],
        "kickOnsets": [],
        "negativeEvents": [],
        "ambiguousEvents": [],
        "intervals": [],
    }


def test_annotation_validation_detects_asset_hash_mismatch() -> None:
    with pytest.raises(ValueError, match="異なります"):
        validate_annotations(_annotations(), {"sourceSha256": "changed"}, 1000, [])


def test_predictions_are_detector_priors_and_never_replace_saved_human_labels() -> None:
    data = _annotations()
    data["candidateReviews"] = [  # type: ignore[assignment]
        {"candidateTimeMs": 100, "status": "rejected", "labelTimeMs": 100}
    ]
    candidates = [
        {"timeMs": 100, "detectorDisposition": "accepted"},
        {"timeMs": 200, "detectorDisposition": "rejected_or_merged"},
    ]
    summary = synchronize_candidate_predictions(data, candidates)
    assert summary == {"predictedKick": 1, "predictedNonKick": 1, "humanReviewed": 1}
    first, second = data["candidatePredictions"]  # type: ignore[misc]
    assert first == {
        "candidateTimeMs": 100,
        "predictedKick": True,
        "reviewed": True,
        "finalLabel": "non_kick",
        "predictionMethod": "detector_disposition_v1",
    }
    assert second["predictedKick"] is False
    assert second["reviewed"] is False
    assert second["finalLabel"] is None


def test_annotations_json_can_be_atomically_saved_and_reloaded(tmp_path: Path) -> None:
    path = tmp_path / "kick-annotations.json"
    data = _annotations()
    data["notes"] = "human review pending"
    _atomic_json(path, data)
    assert json.loads(path.read_text(encoding="utf-8")) == data
    assert not list(tmp_path.glob(".kick-annotations.json.*"))


@pytest.mark.parametrize(
    ("header", "size", "expected"),
    [
        ("", 100, (200, 0, 99)),
        ("bytes=10-19", 100, (206, 10, 19)),
        ("bytes=95-", 100, (206, 95, 99)),
        ("bytes=-8", 100, (206, 92, 99)),
        ("bytes=100-", 100, (416, 0, -1)),
        ("bytes=30-20", 100, (200, 0, 99)),
        ("bytes=0-1,4-5", 100, (200, 0, 99)),
    ],
)
def test_audio_byte_range_parser(header: str, size: int, expected: tuple[int, int, int]) -> None:
    assert _parse_byte_range(header, size) == expected


class _Output:
    def __init__(
        self, failure: OSError | None = None, flush_failure: OSError | None = None
    ) -> None:
        self.failure = failure
        self.flush_failure = flush_failure
        self.body = bytearray()

    def write(self, chunk: bytes) -> int:
        if self.failure:
            raise self.failure
        self.body.extend(chunk)
        return len(chunk)

    def flush(self) -> None:
        if self.flush_failure:
            raise self.flush_failure
        return

    def close(self) -> None:
        return


def _make_audio_handler(tmp_path: Path):
    source = tmp_path / "source.mp3"
    stem = tmp_path / "drums.wav"
    candidate = tmp_path / "candidates.json"
    timeline = tmp_path / "timeline.json"
    annotations = tmp_path / "annotations.json"
    results = tmp_path / "results.json"
    page = tmp_path / "index.html"
    source.write_bytes(b"mp3 source")
    stem.write_bytes(b"0123456789")
    candidate.write_text(
        json.dumps(
            {
                "source": {"sha256": hashlib.sha256(source.read_bytes()).hexdigest()},
                "candidates": [],
            }
        ),
        encoding="utf-8",
    )
    timeline.write_text(
        json.dumps({"durationMs": 1, "waveformPeaks": {"drums": []}}), encoding="utf-8"
    )
    page.write_text("local", encoding="utf-8")
    return build_handler(tmp_path, source, stem, candidate, timeline, annotations, results, page)


def _call_audio(handler_type, range_header: str = "", output: _Output | None = None):
    handler = object.__new__(handler_type)
    handler.headers = {"Range": range_header}
    handler.wfile = output or _Output()
    handler.close_connection = False
    handler.sent_headers = {}
    handler.send_response = lambda status: setattr(handler, "status", status)
    handler.send_header = lambda key, value: handler.sent_headers.__setitem__(key, value)
    handler.end_headers = lambda: None
    handler_type._serve_audio(handler)
    return handler


def test_audio_stream_handles_only_expected_client_disconnects(tmp_path: Path) -> None:
    audio = tmp_path / "drums.wav"
    audio.write_bytes(b"abcdefgh")
    for exception in (BrokenPipeError(), ConnectionResetError()):
        assert _write_audio_range(audio, _Output(exception), 2, 4) is False
        assert _write_audio_range(audio, _Output(flush_failure=exception), 2, 4) is False
    output = _Output()
    assert _write_audio_range(audio, output, 2, 4) is True
    assert output.body == b"cdef"
    with pytest.raises(OSError, match="disk I/O"):
        _write_audio_range(audio, _Output(OSError("disk I/O")), 0, 2)
    audio.write_bytes(b"a")
    with pytest.raises(OSError, match="advertised Content-Length"):
        _write_audio_range(audio, _Output(), 0, 2)


def test_audio_handler_emits_full_and_partial_http_headers(tmp_path: Path) -> None:
    handler_type = _make_audio_handler(tmp_path)
    full = _call_audio(handler_type)
    assert full.status == 200
    assert full.sent_headers["Accept-Ranges"] == "bytes"
    assert full.sent_headers["Content-Length"] == "10"
    assert "Content-Range" not in full.sent_headers
    assert full.wfile.body == b"0123456789"
    partial = _call_audio(handler_type, "bytes=3-6")
    assert partial.status == 206
    assert partial.sent_headers["Content-Range"] == "bytes 3-6/10"
    assert partial.sent_headers["Content-Length"] == "4"
    assert partial.sent_headers["Content-Type"] == "audio/x-wav"
    assert partial.wfile.body == b"3456"
    unsatisfied = _call_audio(handler_type, "bytes=12-")
    assert unsatisfied.status == 416
    assert unsatisfied.sent_headers["Content-Range"] == "bytes */10"
    assert unsatisfied.sent_headers["Content-Length"] == "0"


def test_audio_handler_records_client_abort_without_masking_other_io_errors(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    handler_type = _make_audio_handler(tmp_path)
    output = _Output(flush_failure=ConnectionResetError())
    handler = _call_audio(handler_type, "bytes=0-9", output)
    assert handler.status == 206
    assert handler.close_connection is True
    assert "interrupted by client disconnect" in capsys.readouterr().err


def test_annotation_validation_rejects_duplicate_candidate_review_and_event() -> None:
    data = _annotations()
    data["candidateReviews"] = [  # type: ignore[assignment]
        {"candidateTimeMs": 100, "status": "rejected"},
        {"candidateTimeMs": 100, "status": "confirmed"},
    ]
    with pytest.raises(ValueError, match="未知または重複"):
        validate_annotations(data, data["assetHashes"], 1000, [{"timeMs": 100}])  # type: ignore[arg-type]
    data["candidateReviews"] = []
    data["kickOnsets"] = [  # type: ignore[assignment]
        {"timeMs": 100, "reviewStatus": "confirmed"},
        {"timeMs": 100, "reviewStatus": "confirmed"},
    ]
    with pytest.raises(ValueError, match="重複"):
        validate_annotations(data, data["assetHashes"], 1000, [])  # type: ignore[arg-type]


def test_complete_interval_requires_review_and_explicit_negative_confirmation() -> None:
    data = _annotations()
    data["intervals"] = [  # type: ignore[assignment]
        {
            "id": "segment-a",
            "startMs": 0,
            "endMs": 500,
            "reviewStatus": "complete",
            "playedThrough": False,
            "noKickConfirmed": False,
        }
    ]
    with pytest.raises(ValueError, match="再生してください"):
        validate_annotations(data, data["assetHashes"], 1000, [])  # type: ignore[arg-type]
    data["intervals"][0]["playedThrough"] = True  # type: ignore[index]
    with pytest.raises(ValueError, match="Kickなし"):
        validate_annotations(data, data["assetHashes"], 1000, [])  # type: ignore[arg-type]
    data["intervals"][0]["noKickConfirmed"] = True  # type: ignore[index]
    validate_annotations(data, data["assetHashes"], 1000, [])  # type: ignore[arg-type]


def test_complete_interval_refuses_unreviewed_candidates() -> None:
    data = _annotations()
    data["intervals"] = [  # type: ignore[assignment]
        {
            "id": "segment-a",
            "startMs": 0,
            "endMs": 500,
            "reviewStatus": "complete",
            "playedThrough": True,
            "noKickConfirmed": True,
        }
    ]
    with pytest.raises(ValueError, match="未確認または曖昧"):
        validate_annotations(data, data["assetHashes"], 1000, [{"timeMs": 100}])  # type: ignore[arg-type]
