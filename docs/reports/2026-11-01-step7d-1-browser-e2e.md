# Step 7d-1：ローカル実ブラウザE2E検証

実施日：2026年11月1日  
状態：**partial（ブラウザ接続とAuthの一部確認。Cloud Project E2Eは未完了）**

## 実施結果

- `frontend/.env.example`の`VITE_SUPABASE_URL`と`VITE_SUPABASE_ANON_KEY`を確認し、ローカルSupabaseのloopback URLと公開anon keyを`frontend/.env.local`へ設定した。値は表示・報告せず、ファイルmodeは`0600`。`.gitignore`の`.env.*`規則で`.env.local`が除外され、`.env.example`は除外対象でないことを確認した。
- 既存のViteをWindows Chromeの隔離プロファイルから開き、ページtitle、Visual Editor表示、ログインformを確認した。Windows ChromeからVite、Go `/healthz`、Supabase Auth `/auth/v1/health`はいずれもHTTP 200で到達した。
- Chrome内でローカルAuthの合成テストユーザー登録を1回実行し、HTTP 200を確認した。ログイン後に認証済みCloud UI（`Save to Cloud`）が表示され、Auth状態がFrontendへ反映されるところまで確認した。テストユーザーは専用prefixで照合して2件削除済み（先行試行を含む）。認証のログアウト・reload後session復元は確認していない。
- Go APIのProjects endpointはHTTP 500を返した。対象API processの安全な環境状態確認ではFixture mode、`PROJECTS_ENABLED=false`、Asset verifier DSN未設定だった。既存`api/.env`のProjects設定も無効・verifier DSN空である。試験プロセスだけ`PROJECTS_ENABLED=true`として起動を試したが、serverが必須のAsset verifier DSN設定不足で起動拒否した。DB、role、設定ファイルは変更していない。
- したがってProject CRUD、素材アップロード/復元、revision 409、認証切れ/通信失敗UI、`.arvproj` v1、音声付きWebMは実ブラウザで未検証。Project・AssetのDBデータは作成していない。
- `frontend/.env.local`以外の認証秘密情報を表示・記録していない。Hosted Supabase、Gemini、migration、DB reset、Docker資源削除、Git pushは実施していない。Chromeの隔離プロセスと本作業で使ったVite/API processは終了した。

## 原因と次の前提

この実行環境からWindows Chrome→Vite/Auth/Goまでのloopback接続自体は成立した。Cloud CRUDが止まった直接要因は、Go APIがProjects/Assets有効設定で起動しておらず、必須の専用Asset verifier接続設定も現行`api/.env`にないこと。これはAuth/RLS権限問題とは区別される。専用DSNを新たに発行・保管する権限は今回の依頼に含まれないため、DB role/passwordやAPI実装を変更して回避していない。

続行には、Step 7c-1で定義したローカル専用verifier DSNを安全に`api/.env`へ設定し、値を表示せずProjects-enabled APIが起動することを確認する必要がある。その後、新規ローカルAuthユーザーでChromeからProject CRUD、Asset upload/download/hydrate、409、logout/reloadを行い、テストProject/Asset/userを削除する。音源/画像、`.arvproj`、WebMは個別に実操作記録を残す。

## 自動・静的検証

- Frontend：8 test files / 45 tests passed。
- `npm run typecheck`：成功。
- `npm run lint`：成功。
- `npm run build`：成功。
- Go：`go test -count=1 ./...`成功。`go vet ./...`成功。
- `git diff --check`：成功。
- Git除外：`frontend/.env.local`はignored、`.env.example`はtracked candidate。

pending_uploadのページ再読み込みをまたぐ自動復旧は、既知の対象外制約として維持する。
