# Step 7k-49 — Environment profile、起動スクリプト、運用ガイド

**状態：一部完了 — WSL2 profile/config/launcherの実装とローカルlifecycle検証は完了。専用Test Auth/DBおよびProduction設定は未準備。Windows batchのdispatchは試したが、Windows経由でDevelopmentのcheck/start/stopを正常完了できていない。**

## 実装前の確認事項

- Go APIの既定値は`BLUEPRINT_MODE=fixture`、`AUTH_ENV=local`、AI/Projects/Audio Analyze無効、`127.0.0.1:8080`です。空でない`PORT`を指定すると`0.0.0.0:$PORT`でbindします。Audio Analyzeには専用`SUPABASE_AUDIO_ANALYSIS_DSN`、local Auth issuer/JWKS、Python Island、FFprobeが必要です。
- `api/run-local.sh`は、起動時override後にGit対象外の`api/.env`を読み込んでいました。そのためprofileのAuth/issuer/URL設定が確実に反映されませんでした。現在は明示的な空値を含むprocess環境値をすべて優先し、`api/.env`は未設定値だけの既定値として扱います。このfileは単純なKEY=VALUEとして解析し、shell codeとして実行しません。
- Viteの`/api`先は`ARVC_API_PROXY_TARGET`で、既定は`http://127.0.0.1:8080`です。Vite process環境変数はdotenv fileより優先されます。`VITE_SUPABASE_URL`と公開anon keyは、exportされていなければmode別のGit対象外Frontend dotenv fileから読み込みます。
- `AUTH_ENV=hosted`、HTTPS API URL routing、完全一致のHTTPS CORSはコードにありますが、確認済みProduction domain、Hosted project ID/signing設定、quota、secret manager接続先、deployment承認はありません。
- 作業時、既存のlocal Supabase Auth/PostgreSQLは54321/54322で接続できました。local/Hosted DB、Auth identity、quota、credential、schema、Storage、service設定は変更していません。Testはアプリprocess/profileだけを分離し、Developmentの既存local Supabase Auth、DB、schema、Storage、quota tableを共有します。

## 変更内容

- `scripts/arvc.sh`を追加し、`setup`、Development/Testの`start|stop|status|check`、Productionの`check`を実装しました。
  - Development：Vite 5173、API 8080。
  - Test：既定でVite 5174、API 8081。Test portはloopbackかつDevelopmentと重複せず、proxy先と一致する範囲でGit対象外profileから変更できます。
  - Productionの起動/停止/statusは拒否します。設定checkはネットワーク要求を送りません。
  - 優先順位はshell process環境 > 選択したprofile file > component dotenvです。profileは単純なKEY=VALUE形式です。setupは存在しないfileだけをコピーし、permissionを600にします。
  - local checkはHosted Supabase endpoint、公開API base URL、wildcard/空でないCORS、loopback以外のAPI bind、空でない`PORT`、Vite proxy不一致、共有/既定service DSN、無効なAudio Analyze DSNを拒否します。Audio Analyzeには専用local `arvc_audio_analysis` role DSNが必要で、Test profileでのみ有効化できます。
  - 必要tool/file、Auth health、TCP portの空きを確認してから起動します。検査に失敗した場合、portが空いているとは扱いません。
  - APIとViteは別の`setsid` process groupで起動します。`.run/<profile>`にpermission 600のlogとPID/start-time記録を置きます。stopはPID fingerprintとprocess groupを検証し、このprofileが起動したprocessだけにsignalを送ります。
- `api/run-local.sh`を更新し、継承したすべてのprocess変数を一貫して`api/.env`より優先するようにしました。
- `arvc.bat`を追加しました。引数検証後にWSL経由で`scripts/arvc.sh`へ渡す薄いWindows dispatcherです。
- Development/Test/Production environment templateとFrontend local/test dotenv templateを追加しました。既存ファイルがない場合のみ、`setup all`でGit対象外profileを作成します。既存の`frontend/.env.local`は保持しました。実credentialを追跡対象fileには追加していません。
- `docs/ENVIRONMENT_GUIDE.md`を追加し、root README、docs index、既存の環境構築手順から参照できるようにしました。
- `scripts/tests/environment-profiles.sh`にmockを用いた安全なcheckを追加しました。

## 検証結果

### Shell/profile test

`./scripts/tests/environment-profiles.sh`：成功。使い捨てのfake `curl`/`ss`と一時`api/.env` copyを使い、以下を確認しました。

- 継承した空/非空process値が`.env`より優先され、未設定値はfileから補われる。
- Development/Testの設定解決とTest port変更。
- Frontend key不足、remote Supabase、remote API proxy、使用中または検査不能なport、remote/wrong-role Audio Analyze DSN、Production startが安全に失敗する。
- Productionの設定形式checkは合成HTTPS値のみで成功し、`curl`を呼び出さない。

`bash -n scripts/arvc.sh api/run-local.sh scripts/tests/environment-profiles.sh`：成功。`git diff --check`：成功。profile copyとFrontend local env fileはGit対象外、profile fileのmodeは600であることを確認しました。

### ローカル統合/lifecycle

- 読み取り専用のSupabase Auth `/auth/v1/health`：HTTP 200。既存Auth/PostgreSQL listenerはloopbackの54321/54322。
- `development check`と`test check`：成功。local Auth healthは200、アプリport 5173/8080、5174/8081は空き。
- Developmentの`start` → `status` → API `/healthz` → Vite `/`を確認し、両方がhealthy、HTTP 200でした。`stop`は記録済みlauncher process groupだけにsignalを送り、後のstatusでは両サービスが未所有/非healthy、5173/8080にlistenerがないことを確認しました。
- Testでも同様のlifecycleを8081/5174で実施し、両方HTTP 200、停止後にportが解放されました。
- Test browserのlifecycle probeでは、既存local anon keyをprocess環境だけで一時使用しました。Test env fileへcopyせず、値も表示していません。これはlocal endpointの共有確認であり、独立Test Auth tenantがあることを示すものではありません。
- lifecycle probeのlogはpermission 600で作成し、検証後に削除しました。Supabase containerの起動/停止はしていません。

### 回帰検査

- Frontend：15 file / 191 testが成功。typecheck、lint、production buildも成功。
- Go：最初のsandbox内`go test ./...`は、既存`httptest.NewServer`がIPv6 loopbackでbindできず（`operation not permitted`）失敗しました。loopback test bindingを許可して再実行した結果、9 packageすべて成功。

## 未解決の制約

- TestはAuth、PostgreSQL、Storage、schema、quotaをDevelopmentから分離しません。独立Test Supabase instance、test専用user/entitlement provisioning、自動DB cleanupはありません。明示的なDB変更除外指示に従い、DB fixtureは作成していません。TestのAudio Analyze routeは、専用local test role/entitlementが設定されない限り無効です。
- Production値はplaceholderです。`production check`は形式だけを検査し、Hosted JWT signing/JWKS、DB接続/権限、quota、secret manager binding、Cloudflare Pages/Cloud Runの挙動、課金、release準備を証明しません。deploy/public releaseは対象外です。
- `arvc.bat`はWindows `cmd.exe`経由で呼び出しました。Production checkはWSL scriptまで到達し、想定どおりplaceholder Supabase URLを拒否しました。WSLからUNC current-directory/mount警告が出ました。Windows経由のDevelopment checkはPATH fallback後launcherまで到達し、port 5173使用中を安全に拒否しました。read-onlyの正確なport確認で一時的に`MainThread` listenerを見つけましたが、parent/start-time確認前に終了しました。停止はしていません。したがってbatchのpath dispatchは確認しましたが、Windows経由のDevelopment start/stop成功は未確認です。browser Auth/E2Eは実施せず、API/Vite HTTP healthをWSLから直接確認しました。
- 既存の`api/.env`は読み戻しも変更もしていません。Step 7k-47の専用role secret fileは削除済みです。有効なDSNが残っていると仮定しないでください。
