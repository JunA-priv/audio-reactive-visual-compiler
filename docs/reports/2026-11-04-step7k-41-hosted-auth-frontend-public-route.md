# Step 7k-41 — Hosted Supabase JWT・Frontend公開経路対応

実施日：2026-11-04  
Status：**completed（ローカル実装・自動検証）**  
公開判定：**NO-GOを維持**  
範囲：Step 7k-40 Phase 1のみ。ローカルコード、テスト、設定例、報告書を更新。

## 実装

- Go認証に明示モード`AUTH_ENV=local|hosted`を追加。互換API `NewValidator`はlocal modeを維持し、従来どおりloopback HTTPの任意portを受理。hostedはcanonical `https://<20文字project-ref>.supabase.co/auth/v1`のみ受理し、issuerからJWKS URLを固定導出する。TLS標準検証を保ち、redirectを拒否。初回JWKS取得に失敗すると初期化を拒否し、refresh error後はvalidatorをfail-closedにする。issuer/audience/exp/role/UUID subject、ES256、token size制限は維持。
- Frontend Authはloopback local URLとcanonical Hosted Supabase HTTPS URLに対応。`apiUrl()`を追加し、Audio Analyze、Cloud API全経路、Blueprint Generateを共通`VITE_API_BASE_URL`へ統一。未設定なら相対`/api`のままなのでVite proxy経路を維持。Bearer token、既存request options、Audio AnalyzeのAbortSignalを維持。
- Go CORSに`CORS_ALLOWED_ORIGINS`の完全一致allowlistを追加。Hosted originはbare HTTPS DNS originとして検証し、wildcard、HTTP、userinfo、path/query/fragment、無効host/portを拒否。不許可または重複Origin headerは403。CORS middlewareは認証middlewareを置換せず、認証経路は引き続き必須。
- API/Frontendの`.env.example`に公開設定名とsecret禁止コメントを追加。secretや実値は記載していない。

## 変更ファイル

- `api/internal/authn/jwt.go`, `api/internal/authn/jwt_test.go`
- `api/cmd/server/main.go`, `api/cmd/server/main_test.go`
- `api/internal/service/http.go`, `api/internal/service/http_test.go`
- `api/.env.example`
- `frontend/src/api-connection.ts`, `frontend/src/api-connection.test.ts`
- `frontend/src/auth-client.ts`, `frontend/src/auth-client.test.ts`
- `frontend/src/audio-analysis.ts`, `frontend/src/cloud-api.ts`, `frontend/src/VisualEditor.tsx`
- `frontend/.env.example`
- `CURRENT_TASK.md`, `docs/CURRENT_STATE.md`, 本報告

既存作業ツリーにはStep 7k-41着手前から多数の未コミット変更があった。上記以外の変更を本Stepの成果として扱わず、既存差分を戻していない。

## 検証結果

- Frontend全テスト：14 files / 188 tests passed。
- Frontend typecheck、lint、production build：成功。
- Go authn、server config、Hosted/local CORS focused tests：成功。
- `go vet ./...`：成功。
- `go test ./...`：authn、server、aibudget、assets、audioanalysis、blueprint、projectsは成功。service packageの既存`httptest.NewServer`がsandboxの`listen tcp6 [::1]:0: socket: operation not permitted`でpanicし、全suiteは完了できなかった。Hosted/local CORS focused testsは別実行で成功。
- Go cacheの既定場所がsandboxでread-onlyだったため`GOCACHE=/tmp/arvc-go-cache`を使用。
- `git diff --check`：成功。

異常系テストではHosted issuer誤信頼形式、local/hosted mode不一致、HTTP/任意host/credentials/path/query/fragment、CORS wildcard/不正origin/完全一致不一致/重複Origin、API URLのHTTP/credentials/path/query/非API pathを拒否。Hosted形式issuerのES256署名・既存claim受理、JWKS refresh failure後のfail-closed、HTTPS CORS preflight、認証経路維持も確認。既存local loopbackの任意port（IPv4/IPv6を含む）もvalidator初期化前の設定検査で受理する。

## 未確認事項・制約

- Hosted Supabaseへの実接続、実JWKS取得/rotation、Hosted signing keyがES256であること、Auth policy、実ブラウザからのHTTPS/CORS flowは未確認。
- Hosted DNS/証明書/Cloud Run HTTPS endpointを操作・照会していない。Frontend API endpoint設定は形式検査のみで、実ホストの到達性は未確認。
- keyfuncのrefresh errorは安全側に倒してvalidator process lifetime中latched fail-closedとなる。復旧にはAPI再初期化が必要。Hosted運用時のrotation/temporary outage手順で確認する。
- 全Go test suiteはsandbox IPv6 loopback bind制約でserviceの既存HTTP testを完走できなかった。通常環境での再実行が必要。

## 対象外変更

SCNet、Timeline v1、Blueprint v1、Effects、API payload契約、quota、DB migration、SIGTERM処理は変更していない。GCP、Hosted Supabase、Docker、本番環境への操作なし。依存追加なし。秘密情報・JWT・key material・実URLを追加/記録していない。

## 次工程への引き継ぎ

Step 7k-40 Phase 2のAudio Analyze専用quota/entitlement/kill switchと専用DB制御を、local migration/testから別工程で扱う。Hostedへ進む前にoperatorがproject ref、ES256設定、Frontend/API origin、CORS allowlist、signup/invite policy、費用上限を確認する。続いてSIGTERM/child/temp cleanupを実装・検証し、承認済みHosted test projectでintegrationを行う。Cloud Run/private revisionと公開は別承認工程とする。

Step 7k-41のローカル実装完了によって公開判定は変わらず**NO-GO**。
