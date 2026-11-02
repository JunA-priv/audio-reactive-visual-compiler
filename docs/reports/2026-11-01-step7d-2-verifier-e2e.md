# Step 7d-2：ローカルAsset Verifier接続・Cloud Project E2E再開

実施日：2026年11月1日  
状態：**completed（ローカル接続、ブラウザE2E、権限・回帰検証）**

## Verifier roleと接続情報

Step 7d-1時点の`api/.env`は`PROJECTS_ENABLED=false`、`SUPABASE_ASSET_VERIFIER_DSN`空だった。Step 7c-1報告は以前local verifier passwordを生成して同ファイルにDSNを保存したと記録しているが、今回参照した現在のignored env fileにDSNはなかった。ファイルはGit履歴にないため、値が失われた具体的経緯は確認できない。PostgreSQL catalogではrole password hashの存在だけを確認できたが、既存passwordを安全に復元する方法はなく、入力用DSNもなかった。

作業前にDocker inspectで対象DB containerの5432/tcpがhostの`127.0.0.1:54322`と`::1:54322`だけへpublishされていることを確認した。`arvc_asset_verifier`は既に`LOGIN`。`NOSUPERUSER`、`NOBYPASSRLS`、`NOINHERIT`、`NOCREATEDB`、`NOCREATEROLE`、role membershipなし、Project/Asset表の直接権限なし、private ready RPCだけEXECUTE可を確認した。既存権限と一致したため、role属性・grant・RLS policyは変更せず、明示許可されたランダムpassword設定のみ実施した。

生成値はsubprocess memory内で扱い、local role passwordを設定後、専用DSNと`PROJECTS_ENABLED=true`をGit除外された`api/.env`へ保存した。modeは`0600`、`git check-ignore`も成功。DSNはlocal host `127.0.0.1:54322`、database `postgres`、TLS mode `disable`。値は出力・記録していない。Goの`NewPostgresVerifier`は起動時に`PingContext`を行うため、Projects-enabled APIの起動成功が専用roleの実接続確認となる。

## 認可境界

- Step 7c-1 verification SQL：15/15 pass。Verifier roleはLOGIN/NOBYPASSRLS/NOINHERITでmembership・table ACLなし。private `arvc_internal.project_asset_mark_ready`だけEXECUTE可。`authenticated`、`anon`、`service_role`はprivate/legacy ready RPCを実行できず、Project Asset表はFORCE RLSを維持。
- Step 7b verification SQL：9/9 pass。Project owner RLS、制限role、revision helper ACL等に変更なし。
- ローカルSupabase Auth発行JWTでGo Project listはHTTP 200。未認証`GET /api/v1/projects`はHTTP 401 / `unauthorized`。
- Goの実Auth/Data API/Storage/verifier integration testsも実行し、Project owner境界、Asset upload/実byte hash検証/ready遷移/削除の既存負例・正例が成功した。

## Windows Chrome E2E

隔離したChromeプロファイルからloopbackのVite、Auth、Go APIへ接続した。合成テストアカウントは専用email prefixで生成し、終了時に削除した。合成素材は12秒のWAVと2×2 PNGのみ。

- Auth signup/login、session保持、ページreload後の認証済みCloud UI復元、logoutによるsession消去を確認。
- owner Projectのcreate、list、load/hydrate、update、deleteを確認。
- 12秒WAVとPNG背景をCloud Assetとして保存し、Cloud Project復元後もaudio filenameと画像背景状態が戻ることを確認。Frontend download処理はサイズ/SHA-256を照合し、Go APIは保存object bytesを検証してready化した。
- Projectを別更新した後にstale editorから保存し、409競合表示を確認。HTTP 409分類自体は既存Go Project integration testsでも確認済み。
- 無効access tokenでProject一覧を更新し、401後にsessionが消去されログインformへ戻ることを確認。ブラウザ内の1回限りfetch failureでも通信エラー表示とsession維持を確認。
- 音源付き`.arvproj`をChromeでdownloadし、同ファイルを読み込み直して音源が復元することを確認。
- 12秒timelineと同じdurationのWAVを選択して音声付きWebMを生成。Chromeのdownloadに2,269,523 bytesのWebMができ、先頭EBML magicを確認。UI完了statusの自動待機はtimeout扱いとなったが、download artifactと形式headerは確認した。WebMの再生、audio track metadata、同期品質は今回独立に聴取・解析していない。

Asset付きProjectのUI delete scriptは完了結果を取得できなかったため、残った合成Projectは認証済みowner sessionから通常のGo `DELETE /api/v1/projects/{id}`で削除しHTTP 204を確認した。その後、read-only catalog countで専用prefixのProject/Asset/Storage objectを0件確認し、合成Auth usersも削除した。

## テスト・静的検査

- ローカルSupabase integration：`go test -count=1 ./internal/projects ./internal/assets` 成功。実Auth/Data API/Storage/verifierを使用。
- Go全体：`go test -count=1 ./...` 成功。
- `go vet ./...` 成功。
- Frontend：8 test files / 45 tests成功。
- `npm run typecheck`、`npm run lint`、`npm run build` 成功。
- `git diff --check` 成功。
- E2E後はGo/Viteの試験serverとisolated Chromeを終了。既存Supabase Stackは維持。

## 変更・未確認事項

- 実ファイル変更はignored `api/.env`のみ（verifier DSN設定、Projects有効化、mode 0600）。Migration 001–015、認証/RLS/grants、Go/Frontend/Pythonコード、依存関係は変更していない。
- `api/.env`のDSN消失原因はignored fileの履歴がなく特定不能。新しいlocal-only passwordに置換している。
- Hosted Supabase、Hosted role provisioning/rotation、外部ネットワーク運用は未検証・禁止範囲。
- WebM artifactは生成・EBML headerまで確認。実再生、audio track metadata/同期を独立検証していない。
- `.arvproj`復元後の音声ファイルはUIで復元を確認。再出力WebMのブラウザ再生は未確認。
- pending_uploadを跨いだページreload復旧は既知の未実装事項として維持。
