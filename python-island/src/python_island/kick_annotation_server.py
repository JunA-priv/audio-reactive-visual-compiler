"""Loopback-only annotation UI for the local acoustic Kick evaluation dataset."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

MAX_BODY_BYTES = 8 * 1024 * 1024
AUDIO_CHUNK_BYTES = 64 * 1024
SCHEMA_VERSION = 1
NEGATIVE_KINDS = {"snare", "tom", "bass", "other", "unknown"}
REVIEW_STATUSES = {"confirmed", "rejected", "ambiguous", "unverified"}
INTERVAL_STATUSES = {"unreviewed", "in_progress", "complete"}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _atomic_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _write_audio_range(path: Path, output: Any, start: int, length: int) -> bool:
    """Stream a response body; return False only when the browser closed its socket."""
    with path.open("rb") as stream:
        stream.seek(start)
        remaining = length
        while remaining:
            chunk = stream.read(min(AUDIO_CHUNK_BYTES, remaining))
            if not chunk:
                raise OSError("Audio file ended before the advertised Content-Length")
            try:
                output.write(chunk)
                output.flush()
            except (BrokenPipeError, ConnectionResetError):
                return False
            remaining -= len(chunk)
    return True


def _parse_byte_range(range_header: str, size: int) -> tuple[int, int, int]:
    """Return (status, start, end) for one HTTP byte range or an unsatisfied range."""
    if not range_header:
        return 200, 0, size - 1
    if not range_header:
        return 200, 0, size - 1
    if size <= 0:
        return 416, 0, -1
    if not range_header.startswith("bytes=") or "," in range_header:
        return 200, 0, size - 1
    try:
        first, last = range_header[6:].split("-", 1)
        if first:
            start = int(first)
            end = min(size - 1, int(last)) if last else size - 1
        else:
            suffix_length = int(last)
            if suffix_length <= 0:
                raise ValueError
            start = max(0, size - suffix_length)
            end = size - 1
        if start >= size:
            return 416, 0, -1
        if start < 0 or start > end:
            return 200, 0, size - 1
    except ValueError:
        return 200, 0, size - 1
    return 206, start, end


def _initial_annotations(hashes: dict[str, str], stem_id: str) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "source": "audio-reactive-silent-demo4.mp3",
        "stemId": stem_id,
        "assetHashes": hashes,
        "intervals": [],
        "candidateReviews": [],
        "kickOnsets": [],
        "negativeEvents": [],
        "ambiguousEvents": [],
        "notes": "",
    }


def synchronize_candidate_predictions(
    annotations: dict[str, Any], candidates: list[dict[str, Any]]
) -> dict[str, int]:
    """Derive non-ground-truth predictions and overlay only explicit human reviews."""
    human_reviews = {
        int(review["candidateTimeMs"]): review
        for review in annotations.get("candidateReviews", [])
    }
    predictions: list[dict[str, Any]] = []
    for candidate in candidates:
        time_ms = int(candidate["timeMs"])
        review = human_reviews.get(time_ms)
        status = review.get("status") if review else None
        reviewed = status in {"confirmed", "rejected", "ambiguous"}
        if status == "confirmed":
            final_label = "kick"
        elif status == "rejected":
            final_label = "non_kick"
        elif status == "ambiguous":
            final_label = "ambiguous"
        else:
            final_label = None
        predictions.append(
            {
                "candidateTimeMs": time_ms,
                "predictedKick": candidate.get("detectorDisposition") == "accepted",
                "reviewed": reviewed,
                "finalLabel": final_label,
                "predictionMethod": "detector_disposition_v1",
            }
        )
    annotations["candidatePredictions"] = predictions
    return {
        "predictedKick": sum(item["predictedKick"] for item in predictions),
        "predictedNonKick": sum(not item["predictedKick"] for item in predictions),
        "humanReviewed": sum(item["reviewed"] for item in predictions),
    }


def validate_annotations(
    data: dict[str, Any], hashes: dict[str, str], duration_ms: int, candidates: list[dict[str, Any]]
) -> None:
    if data.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError("注釈ファイルのバージョンに対応していません")
    if data.get("assetHashes") != hashes:
        raise ValueError("音源または候補データが保存時と異なります")
    candidate_times = {int(row["timeMs"]) for row in candidates}
    reviews: dict[int, dict[str, Any]] = {}
    for review in data.get("candidateReviews", []):
        time_ms = int(review["candidateTimeMs"])
        if time_ms not in candidate_times or time_ms in reviews:
            raise ValueError("候補レビューに未知または重複した時刻があります")
        if review.get("status") not in REVIEW_STATUSES:
            raise ValueError("候補レビューの状態が不正です")
        reviews[time_ms] = review
    for collection in ("kickOnsets", "negativeEvents", "ambiguousEvents"):
        seen: set[tuple[int, str]] = set()
        for event in data.get(collection, []):
            time_ms = int(event["timeMs"])
            if not 0 <= time_ms < duration_ms:
                raise ValueError("イベント時刻が音源の範囲外です")
            status = event.get("reviewStatus")
            if status not in {"confirmed", "ambiguous"}:
                raise ValueError("手動イベントの確認状態が不正です")
            if collection == "negativeEvents" and event.get("kind") not in NEGATIVE_KINDS:
                raise ValueError("非Kickイベントの種類が不正です")
            key = (time_ms, str(event.get("kind", "kick")))
            if key in seen:
                raise ValueError("同じ時刻のラベルが重複しています")
            seen.add(key)
    intervals = sorted(data.get("intervals", []), key=lambda row: int(row["startMs"]))
    for index, interval in enumerate(intervals):
        start, end = int(interval["startMs"]), int(interval["endMs"])
        if start < 0 or end <= start or end > duration_ms:
            raise ValueError("評価区間の開始・終了時刻が不正です")
        if interval.get("reviewStatus") not in INTERVAL_STATUSES:
            raise ValueError("評価区間の状態が不正です")
        if index and start < int(intervals[index - 1]["endMs"]):
            raise ValueError("評価区間を重複させることはできません")
        if interval.get("reviewStatus") == "complete":
            if not interval.get("playedThrough"):
                raise ValueError("完了にする前に区間全体を再生してください")
            if any(
                start <= time < end
                and reviews.get(time, {}).get("status", "unverified")
                in {"unverified", "ambiguous"}
                for time in candidate_times
            ):
                raise ValueError("未確認または曖昧な候補が区間内に残っています")
            if any(
                start <= int(event["timeMs"]) < end
                for event in data.get("ambiguousEvents", [])
            ):
                raise ValueError("曖昧な手動イベントが区間内に残っています")
            kicks = [
                event
                for event in data.get("kickOnsets", [])
                if start <= int(event["timeMs"]) < end
                and event.get("reviewStatus") == "confirmed"
            ]
            if not kicks and not interval.get("noKickConfirmed"):
                raise ValueError("Kickがない区間は「Kickなし」を明示確認してください")
            if kicks and interval.get("noKickConfirmed"):
                raise ValueError("KickラベルとKickなし確認は併用できません")


def build_handler(
    root: Path,
    source_path: Path,
    stem_path: Path,
    candidates_path: Path,
    timeline_path: Path,
    annotations_path: Path,
    results_path: Path,
    ui_path: Path,
) -> type[BaseHTTPRequestHandler]:
    candidates_data = _read_json(candidates_path)
    candidates = candidates_data["candidates"]
    timeline = _read_json(timeline_path)
    hashes = {
        "sourceSha256": _sha256(source_path),
        "stemSha256": _sha256(stem_path),
        "candidateSha256": _sha256(candidates_path),
    }
    if candidates_data.get("source", {}).get("sha256") != hashes["sourceSha256"]:
        raise ValueError("Candidate file source hash does not match the local audio")
    duration_ms = round(int(timeline["durationMs"]))

    class Handler(BaseHTTPRequestHandler):
        server_version = "KickAnnotationLocal/1"

        def _send(self, status: int, body: bytes, content_type: str = "application/json") -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, data: dict[str, Any]) -> None:
            self._send(status, json.dumps(data, ensure_ascii=False).encode("utf-8"))

        def _close_after_disconnect(self) -> None:
            self.close_connection = True
            try:
                self.wfile.close()
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self) -> None:  # noqa: N802
            route = urlparse(self.path).path
            if route == "/":
                self._send(200, ui_path.read_bytes(), "text/html; charset=utf-8")
            elif route == "/api/session":
                annotations = (
                    _read_json(annotations_path)
                    if annotations_path.exists()
                    else _initial_annotations(hashes, "demo4-drums")
                )
                try:
                    prediction_summary = synchronize_candidate_predictions(
                        annotations, candidates
                    )
                    validate_annotations(annotations, hashes, duration_ms, candidates)
                except (ValueError, KeyError, TypeError) as error:
                    self._json(409, {"error": str(error)})
                    return
                peaks = timeline["waveformPeaks"]["drums"]
                self._json(
                    200,
                    {
                        "durationMs": duration_ms,
                        "sampleRate": timeline.get("sampleRateHz", 44100),
                        "hashes": hashes,
                        "candidates": candidates,
                        "annotations": annotations,
                        "predictionSummary": prediction_summary,
                        "waveformPeaks": peaks,
                    },
                )
            elif route == "/api/audio":
                self._serve_audio()
            elif route.startswith("/assets/"):
                path = (ui_path.parent / route.removeprefix("/assets/")).resolve()
                if path.parent != ui_path.parent.resolve() or not path.is_file():
                    self._json(404, {"error": "見つかりません"})
                    return
                kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
                self._send(200, path.read_bytes(), kind)
            else:
                self._json(404, {"error": "見つかりません"})

        def _serve_audio(self) -> None:
            size = stem_path.stat().st_size
            status, start, end = _parse_byte_range(self.headers.get("Range", ""), size)
            if status == 416:
                try:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                except (BrokenPipeError, ConnectionResetError):
                    self._close_after_disconnect()
                    print(
                        "Kick annotation audio response interrupted by client disconnect",
                        file=sys.stderr,
                    )
                return
            try:
                self.send_response(status)
                self.send_header(
                    "Content-Type", mimetypes.guess_type(stem_path.name)[0] or "audio/wav"
                )
                self.send_header("Accept-Ranges", "bytes")
                if status == 206:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.send_header("Content-Length", str(end - start + 1))
                self.end_headers()
            except (BrokenPipeError, ConnectionResetError):
                self._close_after_disconnect()
                print(
                    "Kick annotation audio response interrupted by client disconnect",
                    file=sys.stderr,
                )
                return
            if not _write_audio_range(stem_path, self.wfile, start, end - start + 1):
                self._close_after_disconnect()
                print(
                    "Kick annotation audio response interrupted by client disconnect",
                    file=sys.stderr,
                )

        def do_POST(self) -> None:  # noqa: N802
            route = urlparse(self.path).path
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 1 or length > MAX_BODY_BYTES:
                    raise ValueError("リクエストサイズが不正です")
                data = json.loads(self.rfile.read(length))
                if route == "/api/annotations":
                    synchronize_candidate_predictions(data, candidates)
                    validate_annotations(data, hashes, duration_ms, candidates)
                    _atomic_json(annotations_path, data)
                    self._json(200, {"saved": True})
                elif route == "/api/evaluate":
                    saved = _read_json(annotations_path) if annotations_path.exists() else data
                    synchronize_candidate_predictions(saved, candidates)
                    validate_annotations(saved, hashes, duration_ms, candidates)
                    if not any(row.get("reviewStatus") == "complete" for row in saved["intervals"]):
                        raise ValueError("評価できる完了済み区間がありません")
                    _atomic_json(annotations_path, saved)
                    command = [
                        sys.executable,
                        "-m",
                        "python_island.kick_evaluation",
                        "--annotations",
                        str(annotations_path),
                        "--source",
                        str(source_path),
                        "--stem",
                        str(stem_path),
                        "--candidates",
                        str(candidates_path),
                        "--output",
                        str(results_path),
                    ]
                    process = subprocess.run(
                        command,
                        cwd=root / "python-island",
                        check=False,
                        capture_output=True,
                        text=True,
                        timeout=180,
                    )
                    if process.returncode:
                        self._json(422, {"error": process.stderr.strip() or "評価に失敗しました"})
                    else:
                        self._json(200, _read_json(results_path))
                else:
                    self._json(404, {"error": "見つかりません"})
            except (
                ValueError,
                KeyError,
                TypeError,
                json.JSONDecodeError,
                OSError,
                subprocess.TimeoutExpired,
            ) as error:
                self._json(400, {"error": str(error)})

        def log_message(self, _format: str, *_args: object) -> None:
            return

    return Handler


def main() -> int:
    project_root = Path(__file__).resolve().parents[3]
    dataset_dir = project_root / "demo-assets/generated/demo4-kick-evaluation"
    source_path = project_root / "demo-assets/source/audio-reactive-silent-demo4.mp3"
    stem_path = project_root / "demo-assets/stems/demo4-kick-evaluation/drums.wav"
    handler = build_handler(
        project_root,
        source_path,
        stem_path,
        dataset_dir / "kick-candidates-unverified.json",
        dataset_dir / "feature-timeline.json",
        dataset_dir / "kick-annotations.json",
        dataset_dir / "kick-evaluation-results.json",
        project_root / "python-island/tools/kick-annotator/index.html",
    )
    server = ThreadingHTTPServer(("127.0.0.1", 8765), handler)
    print("Kick annotation UI: http://127.0.0.1:8765/ (local only)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
