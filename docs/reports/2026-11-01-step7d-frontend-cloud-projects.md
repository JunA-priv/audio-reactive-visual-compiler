# Step 7d：Frontend認証・Cloud Project保存UI統合

実施日：2026年11月1日  
状態：**partial（Frontend実装・mock検証完了。実ブラウザE2E未確認）**

## 実装結果

既存React Visual EditorにローカルSupabase AuthとStep 7b/7c Go APIを利用するCloud Projects sectionを追加した。追加依存はない。ログインはSupabase Auth RESTのemail/password grant、session更新はrefresh token、logoutはAuth logout endpointを使用する。認証情報はtab-scoped `sessionStorage`へ保存し、status、error、consoleへJWTを出さない。refresh失敗・Go API 401ではsessionを破棄する。Supabase URLはloopback HTTPに制限し、Frontendへ渡すのは公開anon/publishable keyのみ。

認証後は所有者Project一覧、New/Save to Cloud、読込、revision更新、Project削除を提供する。409 revision conflictは最新Projectの再読込を案内する。通信、認証、参照、容量、削除失敗は成功表示に変換しない。Project一覧は既存上限の20件を表示する。

音源FileとEditor内の背景画像data URLはブラウザでSHA-256を計算し、Project作成後に既存Asset reservation/upload APIを使用する。BrowserはSupabase Storageへ直接接続しない。Go APIが受信・保存byteの検証、Storage RLS、ready確定を実施する。Asset reservationとready応答のProject/kind/hash/size/statusをFrontendでも照合する。Download時はbyte sizeとSHA-256を再検証し、Cloud Envelope hydrationと既存Blueprint/Timeline validationが完了してからEditor stateを更新する。

新Projectはまず素材参照なしで作成し、素材をready化後にrevision更新でEnvelopeを保存する。既存素材の削除/置換は参照を外したEnvelopeを先にrevision保存してからAsset DELETEし、uploadと最終Envelope更新を行う。途中失敗はstatusに表示し、部分Project revisionとtab内のpending reservationを保持する。同じ素材の再試行では既存reservationのcomplete確認から続行できる。クラッシュ後にpending reservationを自動列挙・回復するAPIはなく、ページ再読込をまたぐ途中失敗回復は未実装。

既存の素材なしProjectDocument v1はFrontendでCloud Envelope v1へ包み直して表示・編集できる。次回save時にEnvelope v1へ更新する。EditorのFeatureTimeline型にはAPI schema metadataがないため、Cloud Envelope変換時に`schemaVersion: 1`、`timeUnit: "ms"`を追加する。Rendererの編集時型、ProjectDocument v1、Cloud Envelope v1の正式形、`.arvproj` v1、Renderer/WebMは変更していない。

## 変更ファイル

- `frontend/src/auth-client.ts` / `.test.ts`：loopback Supabase Auth login/logout/refresh/session lifecycle。
- `frontend/src/cloud-api.ts` / `.test.ts`：既存Go Project/Asset API adapter、SHA-256、HTTP error mapping、loopback Asset経路。
- `frontend/src/cloud-project.ts` / `.test.ts`：Timeline metadataのwire補完と素材なしProjectDocument v1 compatibility。
- `frontend/src/VisualEditor.tsx` / `.test.tsx`：login、Project list/save/load/delete UIとeditor hydrate。
- `frontend/.env.example`：ローカルSupabase URLと公開anon keyの例。実値なし。
- `docs/API_CONTRACTS.md`, `ARCHITECTURE.md`, `SECURITY.md`, `ENVIRONMENT_SETUP.md`, `TEST_STRATEGY.md`, `CURRENT_STATE.md`, `OPEN_ISSUES.md`, `CURRENT_TASK.md`。

## 検証

- Frontend: 8 files / 45 tests passed（Auth, Project adapter/Cloud Envelope, mock login→new Project save UI, Asset upload and pending reservation retry, existing Editor/.arvproj/WebM testsを含む）。
- `npm run typecheck`：成功。
- `npm run lint`：成功。
- `npm run build`：成功。
- Go API既存回帰：`go test -count=1 ./...`と`go vet ./...`成功。今回のGo testsはunit/mock条件で実行し、local Auth integrationは再実行していない（Step 7dでGo/DB実装を変更していない）。実Auth JWT/RLS/Storage integrationの前回成功はStep 7b/7c/7c-1報告を参照。
- local loopback health smoke：Supabase Auth health HTTP 200、既起動Go API `/healthz` HTTP 200。
- Gemini、Hosted Supabase、DB migration/reset、Frontend Storage直アクセス、GitHub pushなし。

## 未検証・次工程

環境内にChromium/Chrome/Firefoxがなく、実ブラウザからのpassword login、Auth CORS/session refresh、local Supabase JWTでのProject CRUD、音源/背景Asset upload/download/hydrate、revision 409表示を確認できなかった。`frontend/.env.local`も未設定のため、Vite UIをSupabase keyで起動していない（例は`frontend/.env.example`に記載）。API・Storageの実Auth JWT/RLS統合はStep 7b/7c/7c-1で別途成功済みだが、今回のFrontendと結合したE2E成功とはみなさない。よって状態はpartial。

実ブラウザ受入れでは、local Auth test userでlogin→新規音源/画像付きProject保存→refresh→reload/hydrate→編集して更新→2 sessionでstale revision 409→deleteを実行し、既存`.arvproj` v1・音声付きWebMも確認する。途中uploadをページ再読込で中断した場合のpending reservation cleanup/回復は現APIに列挙endpointがないため、手動再試行だけでは対応できず、別途Go API契約の判断が必要。

Hosted Supabase、本番origin/TLS/CSP/session storage threat model、user signup UI、複数ページProject UI、Hosted専用role/DB運用は未対応・未検証。
