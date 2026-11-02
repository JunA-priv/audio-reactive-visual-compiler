# Step 7k-13 — 実ブラウザE2E・Preview / WebM統合検証

実施日：2026-11-01

## Status

**partial**。既存自動テスト、契約テスト、音声ファイルのprobe/decodeまでは完了。Windows Chromeはファイルとして見えるが、このWSL実行環境から起動できず、実ブラウザ、GPU/WebGL2、MediaRecorderによる実WebM生成・再生受け入れは実施できなかった。新機能追加・コード修正なし。

## 検証環境

- WSL Ubuntu上：Node/Vite test、Go、Python Island、FFmpeg/ffprobeを使用。
- PATH上にLinux Chromium/Chrome/Firefoxはなし。
- 既存Windows Chrome実行ファイル `/mnt/c/Program Files/Google/Chrome/Application/chrome.exe` は存在するが、`--version`起動時にWSL interopの`UtilBindVsockAnyPort: socket failed 1`で失敗。Chromeを追加導入せず終了。
- 利用可能なBrowser/Playwright/Puppeteer操作ツールはなく、`frontend/node_modules`にもPlaywright/Puppeteer packageなし。代替browser harnessは導入していない。
- FFmpeg/ffprobe `6.1.1-3ubuntu5`。
- Go/Vite/API/Supabaseのプロセスは見つからず、local authenticated APIを通すブラウザE2E環境は稼働していなかった。

## 実施結果

### Audio Analyze入力素材

- 実MP3 `audio-reactive-silent-demo1.mp3` をffprobeで確認：MP3、48kHz、stereo、180.240秒。
- 30.000秒地点から10秒の範囲をFFmpegで44.1kHz stereo PCM16 WAVへdecode/cropし、ffprobeでPCM s16le、44.1kHz、2ch、10.000秒を確認。
- これはブラウザRange UI / OfflineAudioContext crop / Go Audio Analyze APIを通したE2Eではない。APIは今回呼んでおらず、実OpenAI/Hosted操作もなし。

### Frontend / Editor / Project / Effects

- `npm test -- --run`: **12 files / 139 tests passed**。既存20 Effect、7 Audio Source、Renderer任意時刻/seek、Project v1保存復元、WebM mock export、およびStep 7k-12の解析結果からFixture Blueprint反映・Preview AudioElement controlを含む。
- `npm run typecheck`、`npm run lint`、`npm run build`: 成功。
- Preview実測のaudio currentTime対Renderer時刻差、Pause/Resume/Stop/Seek/endedとEffect eventの視覚一致はブラウザなしのため計測なし。
- `renderEditorFrame`を共有するPreview/Export実装と既存renderer/export mock testsは維持。Ink WebGL2 compile/context loss、Region clipping/Alpha/Draw Order、Gradient/Custom Paletteの実GPU画素は未評価。

### WebM

- 既存VideoExport mock testsでsilent video、audio track、track/resource cleanup、cancel/error/re-export経路は自動検証対象で、Frontend全suite通過。
- 実MediaRecorder出力ファイルは生成していない。実ブラウザ再生、video/audio duration、音声とEffectの同期、codec選択、Canvas captureStream、20 Effect/Ink画素一致は未確認。ffprobe対象の生成WebMもない。

### Go / Python

- Go `go test ./internal/audioanalysis ./internal/blueprint ./internal/projects`: 成功。
- Go Fixture `TestFixtureEndpointReturnsValidatedBlueprint` / `TestLocalFixtureExemptionIsSubjectAndModeScoped`: 成功。
- Go `go vet ./...`: 成功。
- Python `uv run --locked pytest`: **27 passed**（cached Demucs integrationを含む）。
- Python `mypy --strict src`: 成功、7 source files。
- Requested broader `mypy --strict src tests`: 既存testsの関数annotation不足・TypedDict dynamic key等で失敗。今回Python変更なし。
- `ruff check src tests`: 既知の既存E501 16件。Pythonファイルは今回変更なし。
- `git diff --check`: 成功。

## Effect・性能

実ブラウザ代表組み合わせ（Ink 3種、Wave Ring/Spectrum、Particles/Burst、重なるRegion）とGPU context lifecycleは実行不能。自動Suiteの既存geometry/clip/draw order/opacity/seek/project contract確認は通過。

Browser FPS、平均/p95 frame time、WebM encode時間、CPU/RSS/GPU Context Lossは未計測。既定性能合否基準は追加していない。

## 修正・変更ファイル

Step 7k-13ではコード変更なし。実行で生成した一時10秒WAVは`/tmp/arvc-step7k13-crop.wav`。

この報告書、`CURRENT_TASK.md`、`docs/CURRENT_STATE.md`、`docs/OPEN_ISSUES.md`、`docs/TEST_STRATEGY.md`を今回の検証状態に合わせて更新。

## 残る受け入れ

Windows Chromeが起動可能な端末で、認証済みlocal `/app`を使って実MP3選択、0秒/途中区間crop、Audio Analyze、Fixture生成、Editor Preview controls、60秒boundary、audio/silent WebM生成と再生、Project v1 save/loadを実施する。WebGL2 Ink pixels、Region/Alpha/order、Preview/Export parityと性能値はその実ブラウザ実行時に記録する。
