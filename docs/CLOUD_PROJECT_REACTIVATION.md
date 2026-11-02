# Cloud Project再有効化メモ

更新日：2026-11-02  
状態：一時保留。Cloud Project UIは非表示。既存ローカル実装は保持。

## A. 保留理由

クラウド保存は将来の公開対象として維持するが、現時点ではユーザー向けCloud Project操作を提供しない。今回止めたのはEditorからの表示と、ログイン直後のProject一覧自動取得だけ。API、Auth、DB、Migration、Project/Asset契約、既存テスト、データを削除・変更していない。本番Cloud環境の操作も行っていない。

音声解析とBlueprint生成に認証済みセッションが必要なため、アカウントのログイン/ログアウトUIは残している。

## B. 既存実装

### Frontend

- frontend/src/VisualEditor.tsx — authSession/authEmail/authPassword/authBusy/cloudStatus/cloudBusy/cloudProjects/activeCloudProject/cloudTitle state。Cloud handlers: refreshCloudProjects、loadCloudProject、saveCloudProject、removeCloudProject、blueprintMetadata。Auth handlers: login、currentSession。Cloud state/handlersは再有効化用に保持。
- frontend/src/VisualEditor.tsx — mount時のvalidSession確認とAuth subscriptionを維持。以前のauthSession変更時にlistProjectsを呼ぶeffectは削除した。Cloud操作は現UIから到達できない。
- frontend/src/VisualEditor.tsx — POST /api/v1/blueprints/generateとAudio Analyzeの経路は維持。
- frontend/src/cloud-api.ts — bearer sessionでProject CRUD、Asset一覧/reservation/upload/complete/download/deleteを呼ぶ。
- frontend/src/cloud-project.ts — ProjectDocument v1/Cloud Document Envelope v1変換、Asset参照hydrate、Blueprint/Timeline validation。
- frontend/src/auth-client.ts — Supabase Auth REST password login、refresh、logout、sessionStorage管理、Auth event。loopback URLと公開anon keyのみ許可する。
- Frontend設定名（値は記載しない）: VITE_SUPABASE_URL、VITE_SUPABASE_ANON_KEY。例はfrontend/.env.example。
- frontend/src/cloud-api.test.tsとcloud-project.test.tsはCloud API/Envelope契約test。frontend/src/visual-editor.test.tsxは現行UIのCloud非表示、一覧自動取得なし、Auth操作維持を確認する。Cloud契約testは削除していない。

### Go APIと保存層

- api/cmd/server/main.go — PROJECTS_ENABLED=trueでProject/Asset handlerを登録。Supabase Auth JWT validator、Data API repository、Asset verifier/serviceを初期化する。
- api/internal/service/http.go — projects.Handler.RegisterによりProject routesを接続。
- api/internal/projects/handler.go — authenticated /api/v1/projects list/create/get/update/delete。
- api/internal/projects/repository.go — Supabase Data API repository。
- api/internal/projects/document.go — ProjectDocument v1とCloud Envelope v1 validation、Asset参照抽出。
- api/internal/assets/service.go — authenticated /api/v1/projects/:projectId/assets reserve/list、/:assetId/content upload/download、/:assetId/complete、metadata get、delete。
- api/internal/assets/repository.go、verifier.go — Supabase metadata操作と専用DB verifierによるready状態遷移。
- Project設定名: PROJECTS_ENABLED、SUPABASE_URL、SUPABASE_ISSUER、SUPABASE_ANON_KEY、SUPABASE_ASSET_VERIFIER_DSN。例はapi/.env.example。Secret値をここに保存しない。
- Integration tests: api/internal/projects/local_integration_test.go、api/internal/assets/local_integration_test.go。必要な環境変数はtest冒頭で確認する。Hosted環境では実行しない。

### DB / Migrationと権限

- Project/RLS/CRUD: supabase/migrations/20261101000100_step7b_projects.sqlおよび00200〜00800 Step 7b hardening migrations。
- Asset registry/private Storage bucket/RLS/limits/Cloud Envelope shape: 20261101000900_step7c_project_assets.sql。01000〜01500はStorage policy compatibility、delete pending、verified transition roleと権限hardening。
- DB migration適用状況は環境ごとに異なる。設定値だけで適用済みと判断しない。

### データ契約

- Cloud Project APIのProjectDocument v1はBlueprint/Feature Timelineとversion metadataを保持。
- Cloud Document Envelope v1はBlueprint、Feature Timeline、metadata、背景画像Asset ID、音声Asset IDを保持。素材byteはprivate Storage objectで別管理し、Frontend adapterがupload/downloadして参照を解決。
- Music SummaryはCloud Envelope v1に含まれない。Cloud保存は.arvprojと同じ保存範囲ではない。
- API contractの詳細はdocs/API_CONTRACTS.md、api/internal/projects、api/internal/assetsを参照。

## C. ローカル保存との差異

| 項目 | ローカル .arvproj v1 | Cloud Project v1 |
|---|---|---|
| Blueprint / Timeline | JSON containerに保存 | ProjectDocument/Cloud Envelopeに保存 |
| Music Summary | Step 7k-17から任意metadataとして保存 | Envelopeに含まれず、未保存 |
| 解析済み音声 | crop WAV bytesとSHA-256をcontainerに埋込 | 音声Assetとしてprivate Storageに別保存し、EnvelopeはAsset ID参照 |
| 背景画像 | Blueprintのdata URLに保持 | 画像Assetとして別保存し、EnvelopeはplaceholderとAsset IDを保持 |
| 復元 | ファイル読込でEditor/音声を復元。保存Timelineがあれば再解析しない | Project/Envelope取得後、Assetをdownload/検証/hydrateしてEditorへ復元 |
| 保護 | 平文ファイル | local implementationはowner-scoped JWT/RLS/private bucket。Hosted運用を保証しない |

CloudにMusic Summaryを加える場合はversion/compatibility設計が必要。今回決定しない。

## D. 今回の非表示方法

変更:
- frontend/src/VisualEditor.tsx: Cloud操作の一覧、新規作成、保存/更新、選択読込、削除、Project名、Cloud statusを外し、アカウント欄にログイン状態とlogin/logoutだけを残した。
- 同ファイル: authSession変更時のProject list自動request effectを削除。Cloud endpointsへの通信はUI mount/loginだけでは発生しない。
- frontend/src/style.css: layout classをworkflow-accountへ変更。
- frontend/src/visual-editor.test.tsx: Cloud UI非表示、Project list requestなし、認証UIとローカルProject file操作の維持をtest。
- Cloud handlers/state/imports、cloud-api.ts/cloud-project.ts、契約testsは保持。

維持: local .arvproj save/load、Audio Analyze、Blueprint generation、Editor/Preview、WebM、必要なAuth lifecycle、Go/API/Auth/DB/Migration/Cloud v1契約。

## E. 再有効化手順

1. local onlyから開始し、VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEYとGo側Project/Auth/Asset設定を確認。SecretをFrontendへ置かない。Hostedは現在の実装前提外。
2. 対象DBのMigration 001–015、Project/Asset schema、RLS/policies、private bucket、verifier privilege invariantsをread-only確認。未適用や追加変更が必要なら別途設計する。
3. Supabase Auth login/refresh/logout、Go issuer/JWKS validation、PROJECTS_ENABLED、Project/Asset routesとowner authorizationをlocalで検証。
4. frontend/src/VisualEditor.tsxのcloudProjectUIEnabledを見直してCloud panelを再表示し、保持handlerを再接続。Project list auto-fetchは別途停止中なので、戻すならloading/error/cancellationと取得条件もtestする。
5. no-asset Project、audio/image Asset、revision conflict、pending upload retry、download SHA/size mismatch、delete/failure recovery、legacy ProjectDocument v1、Cloud Envelope v1をlocalでroundtrip testする。Music SummaryがCloudにはない点をUI上も説明する。
6. user A/B分離、JWT expiry、RLS、bucket privacy、verifier role、upload limits/MIME/hash、quotas、error/log redaction、origin restrictionsとsessionStorageを再確認。Step 7c-1 reportの権限条件も参照。
7. Frontend tests/typecheck/lint/build、Go project/asset tests/vet、必要なlocal Supabase integration testsを実行。Hosted testは運用計画なしに行わない。
8. Hosted issuer/JWKS、Data API、DB role provisioning、Storage、quota/cost、monitoring/backup/deletion/privacy/security reviewを完了してから公開可否を判断。再有効化だけでHosted対応完了とはならない。

## F. 注意事項・未決定事項

- 本番Cloud環境操作、Hosted request、DB/Migration/認証方式変更、データ削除は今回行っていない。
- 既存Cloud data/codeは削除していない。
- 現UIのCloud非表示は自動UI testで確認。Windows Chrome手動確認は未実施。
- Cloud Envelope v1へMusic Summaryを加えるか、Cloudと.arvprojの保存範囲を合わせるかは未決定。
- Hosted issuer/role/provisioning、quota/cost/retention、production access policy、signup flowは既存の公開準備課題。
- Cloud-specific handlers are still present in VisualEditor.tsx but unreachable from current UI; reactivation requires code/UI review and tests.
