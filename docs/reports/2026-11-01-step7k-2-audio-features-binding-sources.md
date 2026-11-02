# Step 7k-2 — 音響特徴量・Binding Source拡張

実施日：2026-11-01

## 結果

**status: partial**（実装とPython/Frontend/Goの部分検証は完了。Go全suiteはsandboxのloopback socket制限で既存service mock試験が停止。実ブラウザ評価も未実施。）

## 追加FeatureとTimeline契約

Feature Timeline schemaVersion 1を維持し、旧必須field `durationMs` / `bassEnvelope` / `kickEvents`を変えずに新fieldを加法追加した。

- `snareEvents` / `snareEventStrengths`：Demucs `drums` stemの700–10000Hzエネルギーpeakを検出。ms整数の昇順・重複なし、strengthは0..1。mixed drum stemのsnare-like推定であり、snare単独分離ではない。
- `drumEnergy`：既存系列をそのまま`drums.energy`へBindingする。重複系列は作らない。
- `vocalsEnvelope` / `otherEnvelope`：各stem RMSを10ms hopで算出し、各系列のglobal 95th percentile RMSで正規化。
- `musicEnergy`：pipelineで既にdecode済みの元PCMを同じ10ms/RMS/正規化方式で利用。再デコード・再分離なし。

時間原点は音源先頭0ms。Finite値、0..1、duration範囲、順序、event-strength件数をPython/Frontend/Goで検証する。新fieldは任意なので旧Timeline v1は有効。旧Timelineで選択済みsourceの系列が欠ける場合はRendererで0となり、Editorにsource欠損/非活性を表示する。

## Binding / Effect / Editor

Binding sourceを以下の7種類へ拡張：Event=`kick.events`, `snare.events`。Continuous=`bass.envelope`, `drums.energy`, `vocals.envelope`, `other.envelope`, `music.energy`。閾値・strength・attack/release followerは維持し、Event描画では利用可能なevent strengthを使用（旧Kick strengthなしTimelineは従来の強度1）。

既存UI契約との互換性を保ち、Pulse Scale/Glow/Rotation/Particles/Waveform Bars/Radial Bars/Wave RingはEvent・Continuous両方、Particle Burst/ShockwaveはEventのみ、Particle Trail/Ripple/Oscilloscope LineはContinuousのみを選択できる。Frontend/Go Blueprint validatorとOpenAI Structured Output source enumを同期した。OpenAI実APIは呼び出していない。source変更はBinding.sourceだけを書き換え、Effect parameterを保つ。

12種Effect、Renderer geometry、`renderEditorFrame`、Audio clock、Region clip、Preview/WebM共通経路、任意時刻決定論性は維持。

## 既存demoアセット

`demo-assets/stems/demo1..3`に既存Demucs 4 stemがあることを確認し、元音源・stem・従来生成Timelineを変更せず利用した。3曲すべてでdecoded PCMと4 stemのframe数、従来Timelineのdurationが一致した。新しい解析結果は`demo-assets/generated/demo{1..3}-step7k2/`と`frontend/public/demo/demo{1..3}.feature-timeline-v2.json`へ別名で生成し、Frontend demo参照をv2へ切り替えた。新しいsource/stem/Timeline/publicコピーは従来どおり`.gitignore`対象で、production配信承認flagも変更していない。

既存stemと元音源から追加Timelineを作成した時の計測（Demucs分離なし）：

| Track | decode elapsed | feature elapsed | feature CPU time | Snare-like candidates |
|---|---:|---:|---:|---:|
| demo1 | 6.360 s | 3.148 s | 3.368 s | 460 |
| demo2 | 6.507 s | 2.359 s | 2.556 s | 499 |
| demo3 | 3.790 s | 1.750 s | 1.870 s | 386 |

3曲連続実行process peak RSSは808.1 MiB（decode+feature全体）。追加特徴抽出自体のCPU time合計は7.794 s。Snare候補数は推定結果で、正解ラベルに対するprecision/recallではない。

## 主な変更ファイル

- Python：`python-island/src/python_island/features.py`, `pipeline.py`, `tests/test_features.py` — 特徴抽出、元PCM入力、境界/無音/合成Transient検証。
- Frontend：`editor-model.ts`, `renderer.ts`, `VisualEditor.tsx`, `demo-assets.ts` — source型、Timeline validator、値評価、選択UI、欠損時表示、demo参照切替。
- Go：`api/internal/blueprint/blueprint.go`, `api/internal/projects/document.go`, `api/internal/service/input.go`, `api/internal/service/openai.go` — Blueprint/Project/AI入力source契約、Timeline v1 optional fields、Structured Output enum。
- Tests：Python feature、Frontend renderer/UI/demo/Project/Cloud v1、Go Blueprint/Timeline/Structured Output。
- Docs：`CURRENT_TASK.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `docs/BLUEPRINT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/API_CONTRACTS.md`, `docs/TEST_STRATEGY.md`, `docs/VISUAL_EFFECT_ROADMAP.md`。

DB/Migration/Auth/quota/Hosted/依存変更なし。

## 検証

- Python Island `uv run --locked pytest`：**15 passed**（real cached htdemucs integrationを含む既存suite）。
- Frontend `npm test -- --run`：**11 files / 78 tests passed**。
- Frontend `npm run typecheck`, `npm run lint`, `npm run build`：成功。
- Go Blueprint / Project package tests：成功。
- Go Structured Output source enum testとcompact prompt test：成功。
- Go `go vet ./...`：成功。
- Go `go test ./...`：既存`TestOpenAIResponsesRequestUsesStrictStructuredOutput`が`httptest.NewServer` IPv6 loopback bind時にsandboxから`operation not permitted`となりservice packageで停止。他パッケージは成功。失敗したコード assertionではなくlistener作成制限。
- `git diff --check`：成功。
- `/demo` static timeline mock regressionを含むFrontend suite成功。demo v2のduration/frame consistencyとsource/stem非上書きを確認。

## 互換性と未確認事項

Blueprint v1、`.arvproj v1`、Cloud Envelope/Project v1、Timeline schemaVersion 1を維持。Go ProjectDocument/Cloud Envelope validatorは追加fieldを認識し、未知field拒否を保った。OpenAI APIは未接続。

実ブラウザ画素評価、実WebM playback/FPS、実曲のSnare誤検出・取りこぼし評価は未実施。demucs drums stemには他の打楽器が含まれ得るため、Snare sourceは暫定ヒューリスティックである。Hosted/公開環境でのアセット配信・モデル重み利用条件は従来の未解決事項のまま。
