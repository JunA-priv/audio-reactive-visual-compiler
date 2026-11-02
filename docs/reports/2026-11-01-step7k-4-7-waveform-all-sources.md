# Step 7k-4〜7k-7 — 波形ビジュアライザー改善・全Audio Source対応

状態：partial。実装と自動検証は完了。実ブラウザでの画素品質、WebM再生、FPSは未確認。Go全suiteはsandboxのloopback socket制約で1件が失敗した。

## 実装

- Wave Ringを周期的Catmull-Rom補間に変更し、smoothingを設定可能にした。開始角度は既存EffectとTimelineの対応を維持。
- Ripple/Shockwaveを分割polygonからCanvas円へ変更。Shockwaveの成長と減衰に連続easingを使用。
- Python Islandが既存decode PCMとDemucs stemから20ms/882 sample窓のsigned min/max peakを生成。music/drums/bass/vocals/otherの5系列、`signed-full-scale` normalizationをTimeline v1 optional `waveformPeaks`へ追加。再分離なし。
- 3つの実Peak Effectを追加：`waveform-line`、`waveform-peak-bars`、`waveform-ring`。既存`waveform-bars`はenvelope系として保持し、Blueprint v1の意味を壊さないためPeak Barsは別名とした。Peak欠損時に疑似波形を出さず、描画命令なしで非活性。
- Event→Continuousは直近event strengthの決定論的decay envelope、Continuous→Eventはthreshold rising crossingと120ms minimum intervalで評価。評価はTimelineと時刻から行い履歴状態を持たない。
- 全Effectのsource kind制限をFrontend/Goで解除し、7 sourceのenum制約は維持。Editorで全7選択肢を表示し、Effect type/source変更時に他のparametersを保持。
- Go/Frontend Timeline validatorにpeak metadata、件数、finite/range/order/min≤maxを追加。Timeline/Blueprint/`.arvproj`/Cloud v1を維持。OpenAI schema/promptに3 Effect追加。AI requestは既存のcompact Bass/Kick dataのみで、Peak列を含めない。
- Preview/WebMは既存Canvas 2Dの`renderEditorFrame`とRegion clip経路を維持。

## 既存デモ

Demo 3曲の既存MP3、Timeline、stemは変更していない。Step 7k-4で生成済みのPeakを読み取り、metadata追加したsidecarとして`demo-assets/generated/demo{1..3}-step7k7/`と`frontend/public/demo/demo{1..3}.waveform-peaks-v2.json`へ保存した。Demucs再実行なし。

| Demo | duration | 20ms windows | compact peak JSON |
|---|---:|---:|---:|
| demo1 | 180,200ms | 9,010 | 2,249,550 bytes |
| demo2 | 166,040ms | 8,302 | 2,074,658 bytes |
| demo3 | 118,054ms | 5,903 | 1,473,758 bytes |

これらはフル尺の静的Demo sidecarで、2MiB API request上限は変更していない。ユーザー解析は最大60秒、ピークをAI requestへ送らず、PeakはTimelineの任意データとして保持する。60秒合成Timeline size testはPython testsに含む。Production public asset opt-inとgit ignore設定は維持。

追加sidecar抽出は既存生成Peakを使用したため追加解析時間はcopy/JSON metadata serializationのみ。Step 7k-4の元抽出計測はdemo1 2.455s、demo2 1.399s、demo3 1.027s。追加Demucs処理は0秒。

## 主な変更ファイル

- `python-island/src/python_island/features.py`, `python-island/tests/test_features.py` — waveform contractと検証。
- `frontend/src/editor-model.ts`, `renderer.ts`, `VisualEditor.tsx`, `demo-assets.ts` —型、renderer、UI、sidecar loader。
- `frontend/src/*test*` — rendering, validation, source conversion, UI, project/cloud roundtrip。
- `api/internal/service/input.go`, `http_test.go` — Timeline peak validation。
- `api/internal/blueprint/blueprint.go`, `blueprint_test.go`, `service/openai.go`, `openai_test.go` — source/effect schema。
- `demo-assets/generated/demo*-step7k7/`, `frontend/public/demo/demo*.waveform-peaks-v2.json` —新規デモPeak sidecar。
- CURRENT_TASK、CURRENT_STATE、OPEN_ISSUES、Blueprint/Architecture/API/Test/Roadmap仕様を更新。

## 検証

- Frontend: Vitest 85 tests passed; `typecheck`, `lint`, `build` passed.
- Python: `UV_CACHE_DIR=/tmp/arvc-uv-cache uv run --offline pytest` — 16 passed, including cached Demucs integration.
- Go: Blueprint/Audioanalysis/Projects tests passed; Waveform/OpenAI schema tests passed; `go vet ./...` passed.
- `go test ./...`: other packages passed, but `TestOpenAIResponsesRequestUsesStrictStructuredOutput` could not create `httptest.NewServer` because sandbox denies IPv6 loopback bind (`operation not permitted`). No external OpenAI call was made.
- Demo sidecar duration/window alignment and compact byte counts checked. API cap remains 2MiB.
- `git diff --check` checked at final review.

## 互換性・未確認事項

Old Timeline v1 without `waveformPeaks` continues to load; old Blueprint and `.arvproj` v1 remain valid. No DB/API body cap/Hosted/OpenAI call changes. Canvas output is deterministic by time and uses common Preview/WebM code path. Peak Bars has a distinct kind name to preserve the existing `waveform-bars` contract. Actual browser pixels, WebM playback parity, FPS/large peak rendering, and human assessment of waveform fidelity remain unverified.
