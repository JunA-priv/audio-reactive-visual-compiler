import json

import numpy as np

from python_island import cli


def test_cli_success_writes_frontend_compatible_contract(tmp_path, monkeypatch, capsys):
    source = tmp_path / "input.wav"
    source.write_bytes(b"fixture")
    output = tmp_path / "output"
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        cli,
        "run_analysis",
        lambda *_args, **kwargs: (captured.update(kwargs) or {"outputDir": str(output)}),
    )
    assert cli.main([str(source), "--output-dir", str(output)]) == 0
    assert json.loads(capsys.readouterr().out)["outputDir"] == str(output)
    assert captured["kick_gate_mode"] == "hard"


def test_cli_accepts_explicit_kick_gate_mode(tmp_path, monkeypatch, capsys):
    source = tmp_path / "input.wav"
    source.write_bytes(b"fixture")
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        cli,
        "run_analysis",
        lambda *_args, **kwargs: (captured.update(kwargs) or {"outputDir": "out"}),
    )
    assert cli.main([str(source), "--output-dir", "out", "--kick-gate-mode", "middle"]) == 0
    capsys.readouterr()
    assert captured["kick_gate_mode"] == "middle"


def test_run_analysis_keeps_frontend_required_fields_and_refuses_overwrite(
    tmp_path, monkeypatch, write_wav
):
    from python_island import pipeline

    source = write_wav(tmp_path / "source.wav", duration=1.0)
    output = tmp_path / "result"
    stems_dir = tmp_path / "stems"
    audio = np.ones((44_100, 2), dtype=np.float32) * 0.1
    stems = {name: audio.copy() for name in ("drums", "bass", "vocals", "other")}
    monkeypatch.setattr(pipeline, "separate_stems", lambda *_args, **_kwargs: stems)
    monkeypatch.setattr(pipeline, "checkpoint_path", lambda: tmp_path / "model.th")
    monkeypatch.setattr(pipeline, "checkpoint_metadata", lambda _path: {"model": "htdemucs"})
    model = tmp_path / "model.th"
    model.write_bytes(b"model")
    result = pipeline.run_analysis(
        source, output, separator=lambda *_args, **_kwargs: stems, stems_dir=stems_dir
    )
    assert result["outputBytes"] > 0
    timeline = json.loads((output / "feature-timeline.json").read_text())
    assert isinstance(timeline["durationMs"], int)
    assert all(set(point) == {"timeMs", "value"} for point in timeline["bassEnvelope"])
    assert all(isinstance(event, int) for event in timeline["kickEvents"])
    assert "schemaVersion" in timeline and "analysisVersion" in timeline
    summary = json.loads((output / "music-summary.json").read_text())
    assert summary["analysis"]["model"] == "htdemucs"
    metadata_path = output / "analysis-metadata.json"
    metadata = json.loads(metadata_path.read_text())
    assert metadata["outputBytes"]["analysis-metadata.json"] == metadata_path.stat().st_size
    assert set(metadata["stemOutputs"]) == {"drums", "bass", "vocals", "other"}
    import wave

    for name in ("drums", "bass", "vocals", "other"):
        with wave.open(str(stems_dir / f"{name}.wav"), "rb") as stem_file:
            assert stem_file.getnchannels() == 2
            assert stem_file.getframerate() == 44_100
            assert stem_file.getnframes() == 44_100
    try:
        pipeline.run_analysis(source, output, separator=lambda *_args, **_kwargs: stems)
    except Exception as error:
        assert "Refusing to overwrite" in str(error)
    else:
        raise AssertionError("existing output should not be overwritten")


def test_cli_returns_nonzero_for_analysis_error(monkeypatch, capsys):
    from python_island.errors import AnalysisError

    monkeypatch.setattr(
        cli,
        "run_analysis",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AnalysisError("bad input")),
    )
    assert cli.main(["bad.wav", "--output-dir", "out"]) == 2
    assert "bad input" in capsys.readouterr().err
