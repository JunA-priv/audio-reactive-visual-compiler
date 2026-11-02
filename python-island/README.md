# Python Island

ローカルMP3/WAVをFFmpegでPCMへ変換し、Demucs htdemucsをCPUで実行して音響Feature TimelineとMusic Summaryを生成します。音源は外部送信せず、Stemは既定で一時メモリ上だけに保持します。

セットアップと正確な依存版は `../docs/ENVIRONMENT_SETUP.md` を参照してください。

```bash
cd python-island
uv sync --locked --extra dev
uv run python-island /path/to/audio.wav --output-dir ./output --kick-gate-mode hard
uv run pytest -m 'not integration'
uv run pytest -m integration
```

CLIは `feature-timeline.json`、`music-summary.json`、`analysis-metadata.json` を出力します。Kick検出には`--kick-gate-mode off|soft|middle|hard`を指定でき、省略時は従来互換の`hard`です。既存Frontend必須フィールドは `durationMs`、`bassEnvelope`、`kickEvents` です。詳細版・検出強度・Drum Energy等は追加JSONフィールドで提供します。出力先に同名ファイルが既にある場合は上書きしません。

Kick検出のローカル評価は、現行処理の入力に合わせたDemucs混合`drums` stemのPCM16/44.1kHz mono/stereo WAVと手動注釈manifestを使います。評価CLIはDemucs分離を実行しません。音源は外部送信されません。

```bash
uv run kick-evaluation ./kick-labels.json --tolerance-ms 80 --output ./kick-evaluation.json
```

Manifestのパスはmanifestファイルからの相対パスです。録音ごとに`sourceType`、`license`、Kick onsetのミリ秒配列を記録し、任意で`negativeEvents`へSnare/Tom/Bass等の負例注釈を記録します。例:

```json
{
  "recordings": [
    {
      "id": "acoustic-kit-01",
      "wav": "stems/kit-01-drums.wav",
      "sourceType": "acoustic",
      "license": "local evaluation permission",
      "kickOnsetsMs": [520, 1040, 1560],
      "negativeEvents": [{"timeMs": 780, "kind": "snare"}]
    }
  ]
}
```

このCLIは現行`detect_kicks()`をそのまま呼び、TP/FP/FN・onset誤差・ゲート別の除外候補・条件単独のオフラインablationを出力します。評価音声と注釈はリポジトリへ追加せず、ユーザーのローカル作業領域に保管してください。入力形式制約はDemucs混合`drums` stemの44.1kHz PCM16 WAVです。正解ラベルがない音源からPrecision/Recallを推定しないでください。

実モデルの結合テストは、事前に検証済みの `htdemucs` checkpoint cacheが必要です。設定YAMLは固定したDemucsパッケージ内のものを使い、キャッシュ重みを一時repoから読み込むため、CLIはモデル設定や重みをネットワーク経由で暗黙取得しません。キャッシュがない場合はエラーにします。
# Local Kick annotation tool

From the repository root, start the review UI with the existing Python Island
environment:

```bash
python-island/.venv/bin/python -m python_island.kick_annotation_server
```

Then open `http://127.0.0.1:8765/`. The server binds only to loopback. It reads
the existing `demo-assets/stems/demo4-kick-evaluation/drums.wav`, the source MP3,
and the generated candidate/timeline JSON. Save files are written locally to
`demo-assets/generated/demo4-kick-evaluation/kick-annotations.json`; evaluation
results go to `kick-evaluation-results.json`. The unverified candidate file is
read-only. Only intervals marked complete are evaluated, and completion requires
full interval playback, review of every candidate in that interval, and an
explicit no-Kick confirmation when no Kick was labeled.

To begin, Shift-drag across the waveform to mark an interval, add it, listen to
its full duration, and classify every candidate. Add missed Kick labels at the
playhead. Save annotations, then request evaluation. Detector output is computed
on the full stem to preserve the detector's clip-global adaptive thresholds;
only predictions and labels in completed intervals are scored, with the
documented ±80ms boundary context. No accuracy metric is available before at
least one complete interval exists. Candidate predictions are a provisional
initial view only; they are stored separately from human candidate reviews and
are never used as evaluation truth.

Each candidate row includes an audition control that plays from that candidate
onset to the next strictly later candidate (or to the audio end for the last
candidate), a one-click Kick toggle, and direct `rejected`, `ambiguous`, and
`unverified` controls. Equal-time candidates do not create a zero-length audition. Drag the visible playhead to seek; Shift-drag remains the
interval selection gesture. Audio responses support byte ranges and stream in
bounded chunks; a browser canceling an obsolete read during seek is logged as a
client disconnect without a traceback.
