# Step 7k-43 — SIGTERM・Python Island終了処理と一時ファイルcleanup

実施日：2026-11-04  
Status：**completed（ローカル実装・自動検証）**  
公開判定：**NO-GOを維持**  
範囲：Go API shutdown、request cancellation、Python process group、request temp cleanup。Docker / Cloud Runは操作していない。

## 実装

### Go API shutdown lifecycle

- `main`でSIGTERM / SIGINTを受けるroot contextを作成。
- Echoを`http.Server`でserveし、各request contextをroot contextと連動。signal受信時はroot cancellationを先に伝播して解析・upload等を中断し、その後`http.Server.Shutdown`で新規受付を閉じてin-flight requestの終了を待つ。
- graceful shutdownの上限は8秒。deadline超過時は`Server.Close`で接続を閉じて終了する。通常のserve errorと`http.ErrServerClosed`を区別する。
- DB pool / JWT validatorの既存defer closeはserver lifecycle完了後に実行される。

### Python Island process groupとcleanup順序

- ffprobeとPython Islandの両方を新しいprocess groupで起動。
- request context cancellation時にprocess groupへSIGTERMを送り、500ms後も残るprocess/descendantへSIGKILL。`cmd.Run()`が直接childをwait/reapし、process group kill完了も待ってからrunnerをreturnする。
- Handler既存のrequest temp directory `defer RemoveAll`はrunner return後に実行される。したがって正常終了、client cancel、timeout、SIGTERM経由では解析process groupが終了してから一時ファイルを削除する。
- 解析開始前の中断は既存Reservation Release、SCNet開始後はrequest context cancelを`canceled` settlementへ反映。Settlementは既存どおり独立background contextで最大3秒試行し、DB障害時は既存lease recoveryに委ねる。schema/RPC/quota仕様は変更なし。

Goは直接child（Python/ffprobe）をwait/reapする。子孫processのwait/reapはOSのinit/subreaperに委ねられるが、cleanup前にprocess groupへSIGKILLを送り、ファイルを引き続き利用するprocessが残らないようにする。SIGKILLによるアプリ即時終了、kernel stuck/uninterruptible task、shutdown deadline超過後のOS強制終了ではapplication cleanupを保証しない。

## 変更ファイル

- `api/cmd/server/main.go`：SIGTERM/SIGINT、listener、HTTP lifecycle統合
- `api/cmd/server/lifecycle.go`：root request contextと期限付きserve/shutdown helper
- `api/cmd/server/lifecycle_test.go`：in-flight request cancellation、新規accept停止、graceful response test（in-memory listener）
- `api/internal/audioanalysis/handler.go`：ffprobe/Python process groupのTERM→KILL、直接child wait、kill完了待ち
- `api/internal/audioanalysis/process_linux_test.go`：descendant終了、direct child reap、cancellation bound test
- `docs/CURRENT_STATE.md`, `CURRENT_TASK.md`, 本報告

Python Island解析アルゴリズム・source、JWT/Hosted CORS、Audio quota schema/RPC、API request/response contract、SCNet/Timeline v1/Blueprint v1/Effectsは変更していない。依存追加なし。Step 7k-43開始時点から存在する他の未コミット変更は保持した。

## 検証

- `go test ./internal/audioanalysis ./cmd/server`：成功。
- `go test -race ./internal/audioanalysis ./cmd/server`：成功。
- 対象handler testsで通常成功、client cancellation、timeout、charged cancellation settlementとtemp directory削除を確認。
- 新規process testでprocess group cancellation、direct childの`ProcessState`（`Wait`完了）、descendantが実行中でないことを確認。
- 新規lifecycle testsでSIGTERM / SIGINT受信、root context cancellationのin-flight requestへの伝播、listener closeとgraceful response、shutdown deadline時のforced closeを確認。
- `go vet ./...`：成功。
- `go test ./...`：serverを含む全packageは成功したが、既存`internal/service/TestOpenAIResponsesRequestUsesStrictStructuredOutput`が`httptest.NewServer`のIPv6 loopback bind (`listen tcp6 [::1]:0: socket: operation not permitted`) でpanicしsuite全体は完走しなかった。Step 7k-41/42と同一のsandbox制約。
- `git diff --check`：成功。

## 未確認事項・引き継ぎ

- Go test process内でSIGTERM/SIGINTのsignal deliveryを確認した。server binaryを別processとして起動して送るintegration test、実SCNetと長時間解析中のsignal、Docker/Cloud Runの10秒termination windowは未実施。
- DB settlementが3秒超の障害時、started reservationはchargedのまま残りlease recovery対象となる。graceful shutdown deadline超過でもOSが強制終了する場合のtemp cleanupは保証外。
- GoはPython direct childをwaitする。descendantのOS-level reap完了までは保証せず、process group killによりfile accessを止めてからcleanupする。
- sandbox外で `go test ./...` を再実行し、その後別工程で既存containerに影響しないDocker stop検証、承認済みCloud Run test revisionのSIGTERM試験を行う。

Step 7k-43 local completionはCloud Run保証・公開許可を意味しない。公開判定は**NO-GO**。
