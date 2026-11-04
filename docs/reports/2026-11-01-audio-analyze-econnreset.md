# Audio Analyze ECONNRESETの調査

**状態: 部分完了。** ローカルのキャンセル処理不具合を修正し、観測性を改善しました。報告されたECONNRESETは再現できておらず、発端となった原因は未確定です。

## 調査結果

### リクエスト経路

1. `trimAudioToWav`はWeb Audioでユーザーファイルをデコードし、`OfflineAudioContext`で選択したサンプルフレームを切り出し、44.1kHzステレオPCM16 WAVにエンコードします。
2. `analyzeAudioClip`は`FormData`で`audio`パート1つをBearer token付きで送信します。multipartの`Content-Type`/boundary生成はブラウザーに任せ、呼び出し元の`AbortSignal`を使います。Frontend側に解析timeoutはありません。
3. Viteは`/api`を`http://127.0.0.1:8080`へ転送します。proxy timeoutは設定されていません。
4. Goはmultipart/WAVを検証し、ffprobeで調べた後、600秒のrequest context内で設定済みPython Island実行ファイルを起動します。Goの既定`http.Server`を使い、write timeoutは設定していません。
5. Python Islandはffmpegでデコードし、既存のCPU Demucs経路を実行します。GoはPython stdout/stderrを破棄し、JSON出力を検証します。従来のログは大まかな失敗分類のみでした。

### サイズと時間

60秒の44.1kHzステレオPCM16 WAVは、小さなmultipart envelopeを除き`44 + 60 * 44100 * 2 * 2 = 10,584,044` bytesです。既存のリクエスト全体上限16MiB未満です。`trimAudioToWav`は16MiB超のWAVを拒否し、60秒の切り出し制限により通常生成されるclipはこの上限を十分下回ります。制限は引き上げていません。

Vite Proxyにtimeout設定はなく、Frontend fetchにもrequest deadlineはありません。Goの解析timeoutは600秒です。したがって、確認したコードから設定timeoutの不一致は裏付けられません。ユーザーの該当clip、Vite/Goログ、HTTP応答、process exit/OOMの証拠は入手できず、このworkspaceでVite/APIの稼働ペアもありませんでした。これらの確認では報告事象の発端原因を特定できません。

2秒PCM WAVを使う既存Go-to-Python CPU統合テストはhandlerを通って正常完了し、検証済み応答を返しました（最終実行7.2秒）。これは短い正常経路のみ確認するもので、60秒またはユーザー提供clipの検証ではありません。

## 修正したローカル不具合

multipart WAV読み込み中にclientが切断すると、`receiveSingleWAV`はbody-read errorを返します。以前のhandlerはrequest contextが既にcancel済みでも、その種のエラーをすべて音声形式不正とみなしHTTP 422を送ろうとしていました。現在のhandlerはcancel済みrequest bodyを認識し、キャンセル段階を記録し、一時ディレクトリをcleanupしたうえで、切断済み接続へ応答を試みずにreturnします。clientキャンセルの誤分類は防ぎますが、ユーザーの障害原因がキャンセルだったことを証明するものではありません。

Go診断ログにrequest Content-Length、stage（`receive_audio`、`probe`、`python`）、取得可能な場合はアップロードbyte数、子プロセスexit code/signalを記録するようにしました。音声データ、ファイル名/path、認証情報、stderrは記録しません。既存の秘匿化HTTPエラーと各種制限は維持します。

## レイヤー別の再現評価

| ケース | 結果 |
|---|---|
| Middle-range crop (Frontend unit fixture) | Existing test passes; sample offset/duration checked |
| Beginning/end/short crop | Added fixture checks pass |
| Invalid range | Added rejection tests pass before creating AudioContext |
| Go valid WAV response and temp cleanup | Existing unit test passes |
| Invalid format/duration and oversized request | Existing Go unit tests pass |
| Timeout/cancel/Python failure/invalid output | Existing Go unit tests pass |
| CPU Python Island integration | 2-second synthetic PCM clip passes through Go handler |
| Vite → live Go server request | Not run; API/Vite were not running and sandbox disallows general network access |
| User's failing clip and its Content-Length | Not available |
| OOM/process restart evidence | Not available |

根本エラーは未確定です。ブラウザーrequestのキャンセルによりupstream proxyのwrite resetが発生する場合や、upstream requestの拒否/切断がproxyの`ECONNRESET`として現れる場合がありますが、今回どちらが原因かは示されていません。

## 変更ファイル

- `api/internal/audioanalysis/handler.go` — safe stage/size/process diagnostics and canceled-body handling.
- `api/internal/audioanalysis/handler_test.go` — cancellation-during-upload regression and exit-code diagnostic test.
- `frontend/src/audio-analysis.test.ts` — beginning, middle, end, short-range, and invalid-range coverage.
- `CURRENT_TASK.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md` — investigation status and remaining root-cause uncertainty.

API応答、認証、quota、timeout、サイズ制限、Blueprint/Timeline/Project/Cloudのversion、依存関係、Pythonアルゴリズムは変更していません。Hosted操作、OpenAI call、GitHub pushも行っていません。

## 検証

- `npm test -- --run` — 12ファイル、138件成功。
- `npm run typecheck` — 成功。
- `npm run lint` — 成功。
- `npm run build` — 成功。
- `go test -count=1 ./internal/audioanalysis` — 成功。
- `ARVC_AUDIO_ANALYSIS_INTEGRATION=1 go test -count=1 -run TestAnalyzeThroughLocalPythonIslandCPU -v ./internal/audioanalysis` — 成功（2秒PCM clip）。
- `go vet ./internal/audioanalysis` — 成功。
- `python -m pytest -q` — 27件成功。
- `mypy --strict` — 成功。
- `ruff check src tests` — 未変更ファイルにE501違反を16件報告。`ruff check --ignore E501 src tests`は成功。
- `git diff --check` — 成功。

## 残作業

ユーザーの正確な根本原因を特定するには、失敗試行1回分の秘匿化済みGo request/stageログとVite proxyログを取得してください。request Content-Length、返却された場合のHTTP status、経過時間、ユーザーがcancel/画面遷移したかを含めます。Python process failureが記録された場合はexit code/signalとローカルOOM/systemログを使い、音声や認証情報は記録しないでください。同じclipをまずGo直結、次にVite経由でローカル環境のみで再試行します。この証拠が得られるまでは部分完了のままです。

## 追跡調査: reset再発の報告と60秒再現（2026-11-01）

**状態: 部分完了。** ローカル設定から解析routeが無効だった可能性が高く、これとは独立した60秒結果ファイル上限の問題も再現して修正しました。この環境ではブラウザー→Vite→TCP Goの実障害を取得できませんでした。

### Proxy resetの有力原因

ローカル`api/.env`には`API_ADDR=127.0.0.1:8080`がありましたが、`AUDIO_ANALYSIS_ENABLED`はありませんでした。Go serverはこの設定を既定falseとし、明示的に有効化された場合のみ`/api/v1/audio/analyze`を登録します。ローカル起動手順でも`AUDIO_ANALYSIS_ENABLED=true`が必要です。この設定欠落は、大きなmultipart bodyを読み込まずに稼働中APIが即時404を返し、bodyを書き込み中のproxyでsocket resetが起こる状況と整合します。ローカルのignore対象`.env`を`AUDIO_ANALYSIS_ENABLED=true`に更新しました。反映には`api/run-local.sh`を再起動してください。

これは設定に基づく有力な説明であり、20:20:20の事象そのものの証明ではありません。旧Go process環境とrequestログを入手できず、ここでは稼働中のVite/APIペアも起動できませんでした。Goは起動時に`addr`と`audio_analysis_enabled`をログ出力し、route有効性を明示するようになりました。秘匿化request lifecycleログはauth handler外側から開始し、audio、credentials、path、stderrを記録せずにstatus、Content-Length、経過時間、cancel状態を記録します。

### アップロードとCPU解析の再現

| ケース | 結果 |
|---|---|
| Generated 60-second 44.1kHz stereo PCM16 WAV | 10,584,044 bytes |
| Multipart request to Go/Echo handler with fake runner | 10,584,294 bytes received; exact WAV bytes observed by runner; HTTP 200 |
| Real CPU Demucs through Go handler, before output-cap fix | Upload and ffprobe succeeded; Python completed in about 34.7s; HTTP 502 because `feature-timeline.json` was 4,348,728 bytes, above the internal 4MiB result-file cap |
| Real CPU Demucs through Go handler, after fix | HTTP 200; 60,000ms Timeline / 6,000 points; about 36.2s total |
| Direct live TCP Go / Vite proxy / actual browser-created MP3 crop | Not run; loopback bind is denied in this execution environment and no live process/browser incident logs were available |

有効な60秒出力の実測サイズ4,348,728 bytesに基づき、内部JSON出力ファイル上限を4MiBから8MiBへ引き上げました。外部リクエスト全体の上限は16MiB、解析timeoutは600秒のままです。Auth、quota、request/response schema、Python処理に変更はありません。この502は再現により判明した別個の問題であり、観測されたVite `write ECONNRESET`そのものを説明するものではありません。

### 追跡コードと検証

- `api/cmd/server/main.go`: startup diagnostic records listen address and route enable flag.
- `api/internal/audioanalysis/handler.go`: sanitized outer request lifecycle logging; internal Timeline JSON output cap is 8MiB; canceled multipart receive remains treated as cancellation, not malformed audio.
- `api/internal/audioanalysis/handler_test.go`: 10.6MB-class request/byte-integrity test and auth-rejected request lifecycle logging test.
- `api/internal/audioanalysis/handler_integration_test.go`: configurable real CPU integration duration, bounded to 1–60 seconds.
- Local ignored `api/.env`: enabled the analysis route; no secret values were printed or added to version control.

検証:

- `go test -count=1 -v ./internal/audioanalysis` — passed, including 10,584,294-byte multipart upload test.
- `ARVC_AUDIO_ANALYSIS_INTEGRATION=1 ARVC_AUDIO_ANALYSIS_INTEGRATION_DURATION_SECONDS=60 go test -count=1 -run TestAnalyzeThroughLocalPythonIslandCPU -v ./internal/audioanalysis` — passed after the 8MiB internal output cap adjustment; real CPU path completed in about 36s.
- `npm test -- --run` — passed, 138 tests; typecheck, lint, build passed.
- `python -m pytest -q` — passed, 27 tests; `mypy --strict` passed. Ruff reports 16 pre-existing E501 findings in unchanged files; `ruff check --ignore E501 src tests` passed.
- `/usr/local/go/bin/go test -count=1 ./internal/audioanalysis ./cmd/server` — passed after all code changes.
- `GOCACHE=/tmp/arvc-go-cache /usr/local/go/bin/go vet ./...` — passed after all code changes.
- Live TCP/Vite/browser reproduction remains unavailable; the user's source MP3 and 20:20 process diagnostics were not present.

### 推奨するローカル確認

ローカル`.env`設定を適用してGo APIを再起動し、起動ログに`audio_analysis_enabled=true`があることを確認してください。秘匿化Go request lifecycleログとVite出力を見ながら、ローカルブラウザーで1回再試行します。resetが続く場合は同じローカルclipをGo直結とVite経由で比較してください。新しい証拠なしにrequest上限やtimeoutを増やさないでください。

## 追跡調査: 60秒解析が3分後も実行中との報告（2026-11-01）

**状態: 部分完了。** この実行環境からユーザーの稼働中API、ブラウザー、requestログを確認できませんでした。そのため現在のrequest段階を特定できず、実ソース60秒解析の完了も確認できませんでした。process停止やruntime設定/timeoutの変更はしていません。

### 読み取り専用runtime状況

- `ps -eo pid,ppid,etimes,%cpu,%mem,rss,comm` showed only the current Codex/shell/tool processes in this process namespace; no Go API, Vite, Python, ffmpeg, or Demucs process was visible.
- No API `.log`, stdout, or stderr log files were found under the local `api/` tree.
- `journalctl -k --since '15 minutes ago'` had no matching OOM/Kill/Python/ffmpeg entries. This says nothing about logs outside this isolated environment.
- `ss -ltnp` could not read sockets because netlink access was denied. It does not establish whether the user's API is listening.
- No request-start log, Content-Length, active stage, HTTP response, Python exit code, CPU, or RSS for the user's 3-minute wait was available. The current request's receive/ffprobe/Python/Frontend stage is **unknown**.

このworkspaceでは、報告されたブラウザー操作が進行中だったか停止していたか判断できません。以前このサンドボックスにVite/APIが見つからなかったことを、ユーザー側の別ローカルprocessが停止している証拠と解釈してはいけません。

### 既存の時間計測値と処理段階の可視性

The existing synthetic 60-second WAV and its Python metadata were available for read-only inspection:

| Stage/measurement | Measured value |
|---|---:|
| WAV | 10,584,044 bytes; PCM16, 2-channel, 44,100Hz; 2,646,000 frames; exactly 60s |
| Python total | 33.781s |
| ffmpeg decode | 0.339s |
| Demucs CPU separation | 31.610s |
| Feature extraction | 1.632s |
| Peak RSS | 1,283.8 MiB |
| Output JSON total | 4,350,737 bytes (Timeline 4,348,728; Summary 613; metadata 1,396) |

The earlier Go-handler CPU integration for the same class of 60-second synthetic fixture completed with HTTP 200 in about 36.2s. These values do not characterize the actual MP3 or its browser-generated WAV.

Frontend調査によると、`trimAudioToWav`はまず`file.arrayBuffer()`と`AudioContext.decodeAudioData()`でソースMP3全体を読み込み、次に`OfflineAudioContext`で選択した60秒範囲を描画してからWAVを組み立てます。UIはこれらの処理前に「切り出し中・ローカルDemucs解析中」という汎用状態へ切り替わり、HTTP requestとEditor state確定まで維持します。MP3デコード、WAV描画、uploadそれぞれの進捗/時間は個別表示されません。アプリコードにfetch timeoutはなく、Go APIの解析timeoutは600秒です。

Goはrequest受信イベントを記録しますが、受信成功とffprobe段階は個別にログ出力しません。Python `analysis-metadata.json`にはdecode、separation、feature、合計時間、ピークRSSの指標がありますが、GoはPython終了後にしか読まないため、実行中の段階時間を報告できません。この調査では600秒timeoutやdeadlock到達の証拠はありません。

### 結論と次に必要な証拠

この3分待機の根本原因は確定していません。前回の合成fixtureは約36秒で完了しましたが、CPU音源分離だけでピークRSS約1.28 GiBを使用しました。異なるマシン負荷や実入力では時間がかかる可能性があり、Frontendの汎用statusではブラウザーデコードや停止状態と区別できません。これは仮説にすぎず、ユーザーrequestについての調査結果ではありません。

実際の試行を停止せず分類するには、実行している同じマシンで次を取得してください。

1. Go startup record confirming `addr` and `audio_analysis_enabled=true`.
2. Request start and eventual finish record with Content-Length, status, elapsed time, and cancellation field.
3. While active, process names/elapsed/CPU/RSS for Go and its Python/ffmpeg child tree; do not include command arguments, environment, audio, or tokens.
4. After completion, sanitized `analysis-metadata.json` timing fields (decode, separation, feature extraction, total, peak RSS) or equivalent values from the response.
5. Browser timing boundaries for source decode, offline render, fetch start, and fetch completion, plus generated WAV metadata (size/rate/channels/bit depth/frames), with no audio samples.

現在の処理段階と失敗機序を確定できなかったため、コード変更は行っていません。測定済み入力は60秒WAV fixtureのみです。報告されたMP3からブラウザーが生成したWAVと、実ソース解析の完了結果は入手できませんでした。

### 追跡検証

- `GOCACHE=/tmp/arvc-go-cache /usr/local/go/bin/go test -count=1 ./internal/audioanalysis` — passed.
- `git diff --check` — 成功。
- Existing earlier 60-second real CPU synthetic integration — passed at HTTP 200 (~36.2s); not rerun in this follow-up because no code changed.
- 実ブラウザー/API runtimeとユーザーのMP3切り出し — 入手できず、部分完了のまま。
