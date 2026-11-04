# Step 7k-11a — 周波数Spectrum Effect

**状態：一部完了**

## 結果

既にdecode済みの音楽PCMから生成する任意のTimeline v1 field `frequencySpectrum`を追加しました。4096 sampleのHann STFT、20ms hop、40Hzから`min(16kHz, Nyquist)`までを対数分割した32 band、正の`log1p(32 * bandRMS)`値に対する全clip p99 normalizationを使います。出力はrow-majorのuint8値（0〜255）です。無音は0になります。44.1kHz decode音声で最大384,000値です（Python Islandの4分duration制限に基づく）。

`spectrum-bars`（32本の分割barまたは連続bar）と`spectrum-line`を追加しました。描画時にFFT band間を補間して形状を求めます。既存7種類のBindingが追加のresponse strengthを与えます。attack/releaseは決定的で、Timeline開始位置からcacheし、前frameの状態は使いません。Spectrum dataがない場合はcommandを出力しません。どちらのEffectも既存のcolor、opacity、visibility、Region clip、`renderEditorFrame`経路を共有します。

UI専用Category `EQ / Spectrum`には新しいEffectを2種類だけ含めます。従来のWaveform membershipは変更しません。CategoryはEffect kindから導出され、Blueprint/Project storageには含まれません。

## 容量と処理

- 既存のwaveform peaks、stem feature、Spectrumを含む合成60秒Feature Timeline：compact JSONで**1,595,177 bytes**。API上限は引き続き2 MiB。
- 60秒、quantize済みSpectrum、5種類すべてのsigned peak arrayを含むGo request test：**688,599 bytes**。同じ2 MiB上限以内で検証。
- compact JSONとして生成したDemo Spectrum sidecar：
  - demo1、180,200ms / 9,010 frame：**906,995 bytes**、FFT抽出**2.485s**。
  - demo2、166,040ms / 8,302 frame：**826,015 bytes**、FFT抽出**2.283s**。
  - demo3、118,054ms / 5,903 frame：**588,371 bytes**、FFT抽出**1.566s**。
- Demo処理では既存音声fileだけを再decodeしてFFTを計算しました。Demucs separationは行っていません。既存音声、stem、Timeline、peakは保持し、新しいsidecarを新規generated/public pathに追加しました。新しいDemo sidecarはGit対象外で、Vite公開gateは変更していません。

## 変更ファイル

- `python-island/src/python_island/features.py`：Spectrum抽出とTimeline field。
- `python-island/tests/test_features.py`：tone、silence、Nyquist、size、serialization test。
- `frontend/src/editor-model.ts`、`frontend/src/renderer.ts`：Spectrum型、検証、決定的補間/follower、描画command。
- `frontend/src/VisualEditor.tsx`：独立Category、既定値、controls、data欠落時の状態表示。
- `frontend/src/demo-assets.ts`：version付きsidecarの任意読み込み。
- `frontend/src/editor-renderer.test.ts`、`frontend/src/visual-editor.test.tsx`、`frontend/src/demo-assets.test.ts`、`frontend/src/project-file.test.ts`、`frontend/src/cloud-project.test.ts`：描画、Category、data欠落、Project/Cloud v1、読み込み範囲。
- `api/internal/service/input.go`、`input_spectrum_test.go`：strictな任意Timeline検証と固定API上限。
- `api/internal/blueprint/blueprint.go`、`blueprint_test.go`：Effect parameterと検証。
- `api/internal/service/openai.go`、`openai_test.go`：Structured Output schemaとcompact prompt確認。API callは行っていません。
- `.gitignore`：新規生成するpublic Spectrum sidecarを除外し、既存Demo公開制御は維持。
- `demo-assets/generated/demo{1,2,3}-step7k11/spectrum.json`、`frontend/public/demo/demo{1,2,3}.frequency-spectrum-v1.json`：sidecarのみ新規追加。
- `docs/API_CONTRACTS.md`、`docs/ARCHITECTURE.md`、`docs/BLUEPRINT_SPEC.md`、`docs/CURRENT_STATE.md`、`docs/OPEN_ISSUES.md`、`docs/TEST_STRATEGY.md`、`docs/VISUAL_EFFECT_ROADMAP.md`、`demo-assets/generated/README.md`、`CURRENT_TASK.md`：contractと現状を更新。

## Test

- Python `python -m pytest -q`：**24 test成功**。`mypy --strict`成功。`ruff check src tests --ignore E501`成功。通常のRuffは既存source/testのE501行長違反を報告しました。新規行はprojectの行長基準内に整形しました。
- Frontend `npm test -- --run`：**115 test成功**。`npm run typecheck`、`npm run lint`、`npm run build`成功。
- Python `.venv/bin/python -m pytest -q`：**24 test成功**。`mypy --strict`成功。`ruff check src tests --ignore E501`成功。通常のRuffでは既存fileのE501違反が残ります。
- Go Spectrum/Blueprint/schema/prompt対象test成功。`go vet ./...`成功。
- Go全suiteを試しましたが、既存`TestOpenAIResponsesRequestUsesStrictStructuredOutput`がsandbox内IPv6 loopbackの`httptest` listenerをbindできず（`operation not permitted`）、service suite全体は確認できませんでした。
- `git diff --check`成功。

## 互換性と未確認事項

Blueprint v1、Feature Timeline v1、`.arvproj v1`、Cloud Envelope/Project v1、7種類すべてのBinding source、Preview/WebM renderer経路は維持しています。旧Timelineでは`frequencySpectrum`を省略でき、従来どおり検証を通ります。raw matrix値は`CompactFeatures`やOpenAI prompt contentに含めません。dependency、DB、migration、Auth、quota、Hosted環境、API size limitは変更していません。

Go suite全体は既存のsandbox IPv6 listener制限で阻まれています。また、実ブラウザーのpixel/合成品質とWebM再生は視覚確認できていません。
