# Step 7j — 音声範囲選択・Demucs解析・Blueprint連携

実施日：2026-11-01

## 結果

**status: completed（local-only）**。以前のread-only調査はAPI/子プロセス実行契約が未承認のためblockedだった。本作業では、ユーザーが承認したlocal-only契約に従って範囲選択、WAV crop、認証付きGo解析API、既存Python Island実行、Blueprint生成・保存・WebM経路接続を実装した。Hosted環境は未実装・未検証。実OpenAI APIは呼び出していない。

## 実装・データフロー

1. `/app`は既存32 MiB source limitと対応音声形式を維持し、音源選択後にブラウザ内previewと開始/終了range sliderを表示する。30秒/60秒音源では全尺を初期選択、60秒超では初期60秒を選び開始位置を変更できる。範囲確定までは解析・Blueprint生成を行わず、範囲選択中はCloud save/local save/WebMを無効化する。
2. `audio-analysis.ts`はWeb Audioでdecodeし、選択区間を44.1 kHz stereo PCM16 WAVへsample frame単位でcropする。元音源ファイル自体はAPIへ送らない。multipartにはcrop WAV一つだけを入れ、Bearer JWTでGo APIへ送信する。AudioContextはfinallyで閉じる。
3. 有効化されたGo routeは既存local Supabase JWT middlewareを要求する。request全体16 MiB、WAV part一つ、実測PCM signed16/44.1kHz/stereo、0超〜60秒、global同時1件、600秒timeoutを検証する。ファイル名はpathとして使用しない。
4. Goは0700 private temp directoryと0600入力fileを使い、shellを介さずに設定済みPython Island executableへ`input --output-dir output --threads 4`を渡す。既存CPU htdemucs CLIを変更せず再利用する。context cancel/timeoutではchild process groupを終了し、全終了経路でtempを削除する。process stdout/stderrや認証情報はログしない。
5. GoはPython Islandの3 JSON出力を個別byte上限付きで読み、既存Summary/Timeline validator、schema/metadata version、analysis version、44.1kHz、htdemucs/CPU、clip実byte数、duration一致を検証してからJSON応答する。拒否エラーには内部path/stderrを含めない。
6. Frontendは解析成功後だけcrop WAVを`audioFile`、clip先頭0msのFeature TimelineをEditorへcommitする。そのSummary/Timelineを既存Blueprint generation endpointへ送信する。Project/Asset saveとWebM exportはcommit済みcrop WAVと同じTimelineを使用する。selection offsetは保存しない。既存Project loadは既存状態を維持し、新しい分析Summaryを仮定しない。

## API契約

| 項目 | 実装 |
|---|---|
| Endpoint | `POST /api/v1/audio/analyze` |
| 有効化 | `AUDIO_ANALYSIS_ENABLED=true`（既定false） |
| 認証 | local Supabase Bearer JWT必須 |
| Request | multipart `audio` file一つ。WAV PCM16LE、44.1kHz、2 channel |
| 上限 | request 16 MiB、clip 60秒、全体同時実行1件、600秒 |
| Response | `{featureTimeline, musicSummary, analysisMetadata}` |
| エラー | 401/413/415/422/429/499/500/502/504、既存の`{error:{code,message}}`形式 |
| 実行 | 固定argvの既存Python Island CLI、CPU htdemucs、4 threads |

`api/run-local.sh`は`.env`読込後もprocess-level `AUDIO_ANALYSIS_ENABLED` overrideを保持する。`api/.env.example`に無効既定値とlocal executable/workdir設定を記載した。Go APIは既存のloopback bind制約下にあり、分析routeだけでHosted利用可能にはならない。

## 変更ファイル

- `frontend/src/audio-analysis.ts`：WAV crop、解析API adapter、response検証。
- `frontend/src/audio-analysis.test.ts`：WAV header/sample境界、decode context cleanup、clip-only multipart/auth/responseテスト。
- `frontend/src/VisualEditor.tsx`：`/app` range selection、解析/生成ゲート、crop commit、Project/WebM連携、競合operation cleanup。
- `frontend/src/visual-editor.test.tsx`：30/60/90秒初期範囲、確定前に要求しないこと、解析結果からBlueprint要求・WebMへ同じduration/audioを渡すテスト。既存`/demo` no-network testを維持。
- `api/internal/audioanalysis/handler.go`：認証付き解析handler、上限、ffprobe、private temp、CLI起動、output validation、安全なエラー、cleanup。
- `api/internal/audioanalysis/handler_test.go`：認証、無効WAV、60秒超、16 MiB超、single-flight 429、timeout/cancel cleanup、CLI失敗、Python出力不正。
- `api/internal/audioanalysis/handler_integration_test.go`：既存CLIを実際にGo handler経由で起動する任意CPU integration test。
- `api/cmd/server/main.go`：無効既定のlocal analysis configとJWT middleware付きroute登録。
- `api/.env.example`：解析機能flagと既存Python Island executable/workdir/ffprobe設定。
- `api/run-local.sh`：明示process envによる解析機能enableを保持。
- `CURRENT_TASK.md`、`docs/CURRENT_STATE.md`、`docs/OPEN_ISSUES.md`：blocked状態を承認後のlocal実装状態へ反映。
- `docs/API_CONTRACTS.md`、`docs/ARCHITECTURE.md`、`docs/ENVIRONMENT_SETUP.md`、`docs/TEST_STRATEGY.md`：local API、起動条件、データフロー、検証契約を記録。

DB/Migration、Project/Blueprint/Feature Timeline/Cloud Envelope/`.arvproj` version、Auth/RLS/quota、Python Islandアルゴリズム、Renderer、`/demo`のデータは変更していない。依存関係追加なし。

## 検証

- Frontend: `npm test` — **10 test files / 66 tests passed**。`npm run typecheck`、`npm run lint`、`npm run build`成功。
- Go: `go test -count=1 ./...`、`go vet ./...`成功。既存`httptest`がlocal listenerを使うため、実行にはlocal socket permissionが必要だった。
- Go + 実Python CPU統合: `ARVC_AUDIO_ANALYSIS_INTEGRATION=1 go test -count=1 -run TestAnalyzeThroughLocalPythonIslandCPU ./internal/audioanalysis`成功。合成2秒WAVをGo handlerへ渡し、local既存`python-island` htdemucs CPU実行後、HTTP応答・Timeline/Summary/metadataを検証。モデルは既存cacheを利用しdownloadなし。temp directory cleanupもhandler testで確認。
- Python Island: `UV_CACHE_DIR=.uv-cache UV_PYTHON_INSTALL_DIR=.python uv run --locked pytest` — **13 passed**。うち既存実Demucs CPU repeatability integrationも成功。
- `/demo`回帰: 固定合成音源とRenderer clock test成功、外部/API requestなし。
- `git diff --check`成功。

HTTP handler testではJWT middleware装着点をmock middlewareで検証し、既存`authn`パッケージのJWT validator testも回帰した。実ローカルSupabase発行JWTを使ったブラウザからの音源解析E2Eは今回実施していない。

## 未確認事項・残存リスク

- Windows Chromeの実ブラウザでrange slider、ブラウザ固有decode/resampling、CPU負荷、実Project/Asset roundtrip、実WebM再生を一連操作するE2Eは未実施。Editor/API adapter/Go→Python処理は自動testで分割検証した。
- 解析APIは**local-only**。本番・Hosted利用の認証issuer、rate limits、CPU/memory/process isolation、複数instance制御、upload DoS対策は未設計。ループバックGo APIと1プロセス内global semaphoreでのみ制限する。
- Web Audioでのsource decodeは最大32 MiB fileに対して行うため、長時間圧縮音源ではbrowser memoryを多く使い得る。実機メモリ計測・UI progress表示は未実施。
- htdemucs重みの再配布/商用利用許諾は既存OPEN_ISSUESの未解決事項のまま。今回音源は合成テスト音のみで、音楽素材は使用していない。
- OpenAI実API、Cloud/Hosted DB/Storage、Gemini/OpenAIへの音声送信はなし。

## 次工程

ローカルユーザーによる実ブラウザE2Eで音源形式ごとのdecode互換、区間確認、Cloud save/hydrate、音声付きWebM再生を確認する。Hosted deploymentにこの解析APIを持ち込む場合は、別設計で認証・分散CPU枠・rate limit・storage/retention・privacy reviewを行う。
