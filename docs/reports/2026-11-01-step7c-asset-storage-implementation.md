# Step 7c：Supabase Storage素材管理 実装報告

日付：2026-11-01  
状態：**partial（ローカル実装・統合テスト完了、権限境界の確認事項あり）**

追補（Step 7c-1、2026-11-01）：本報告作成時に残していたready RPCの利用者直実行問題は、追加Migration 012–015と専用NOBYPASSRLS PostgreSQL roleでlocal環境に限り解消した。現行状態・検証結果は[Step 7c-1報告](2026-11-01-step7c-1-asset-ready-authorization.md)を参照。Hosted接続/運用は引き続き未検証。

## 概要

Step 7cのローカルSupabase向けAsset管理を実装した。音源・背景画像をprivate bucketへ保存し、Projectの所有者・Asset metadata・object keyを結び付ける。既存Migration 001–008、ProjectDocument v1、`.arvproj` v1、Blueprint/Feature Timeline v1のデータ形式は変更していない。FrontendはCloud Envelope変換adapterだけを追加し、ログイン・クラウド保存UIはStep 7dに残した。

ローカルSupabase実JWTによるowner分離、Storage/RLS、upload、hash不一致拒否、download、参照整合性、Asset/Project削除を統合試験した。テストで作成したユーザー・Project・Asset metadata・Storage objectsは全件後片付け済み。

## 変更内容

### MigrationとDB

- `20261101000900_step7c_project_assets.sql`：Asset registry、owner/project composite FK、one-per-kind unique constraint、RLS/GRANT、quota trigger、状態遷移RPC、private bucket、Cloud Envelope v1を受け入れる既存Project JSON shape constraintの拡張を追加。
- `20261101001000_step7c_storage_policy_runtime_compat.sql`：Storage実装のobject metadata表現に依存しないowner/path/pending RLSへ調整。Go APIが受信byte streamの実サイズ・MIME・SHA-256を検証してからready化する。
- `20261101001100_step7c_delete_pending_owner_select.sql`：Storage removeがRLS下で対象objectを確認できるよう、同じownerの`delete_pending` objectに限りSELECTを許可。

001–008は変更していない。最初の009適用はCHECK式の構文エラーでtransaction rollbackされ、table/bucket/ledger entryが作成されていないことを確認した後、修正版を適用した。続いて010/011を適用し、local migration ledgerに009–011があることを確認した。

bucket `arvc-project-assets`はprivate、音源32 MiB、画像10 MiB。許可MIMEはaudio MPEG/WAV/OGG/Opus/MP4/AAC/WebM/FLACとimage PNG/JPEG。DBは各Projectにつきkindごと1件、userあたり40 Assets/840 MiBを制約する。object keyは`owner/project/asset` UUID構造。

### Go / API

`api/internal/assets/`にAsset予約、一覧/metadata取得、binary upload、完了検証、download、削除処理を追加した。全endpointは検証済みSupabase user JWTを要求し、ownerは`sub`から導出する。JSON metadataは64 KiBまで、binaryはHTTP hard limitと一時ファイルでbounded stream処理し、Storageへ送る前にSHA-256・size・signatureを確認する。API key、JWT、file bytesはログへ出さない。HTTP client timeoutは2分。

状態遷移は`pending_upload`→`ready`、削除時は先に`delete_pending`へ記録し、Storage削除後にDB rowをfinalizeする。Storage成功後にDB finalizeが失敗した場合、再試行が対象objectの不存在を確認してmetadata削除を完了できる。Project DELETEはStorage objectを先に削除し、どれか失敗した場合はProject rowを維持する。AssetがEnvelopeから参照されている間の単独削除は409。

実装endpointは`docs/API_CONTRACTS.md`に記載した。Asset APIのエラーは既存の`{"error":{"code":"...","message":"..."}}`形式。

### Cloud Document Envelope

`api/internal/projects/document.go`にcloud専用Envelope v1 validation/reference extractionを追加した。ProjectDocument v1の形状制約は維持し、MigrationでEnvelope v1を追加許可する。Frontend adapterは既存Editor Blueprint/Feature Timelineをcloneし、background imageはcanonical `#000000` placeholder + Asset IDとして保存、読み込み時は参照画像をdata URLへ戻す。audio referenceは復元時にFileへ渡す。Rendererと描画処理は変更していない。

### Frontend

`frontend/src/cloud-project.ts`とテストを追加。変換時は既存Blueprint/Timeline validatorを使用し、hydrate時には参照asset ID/kind/MIMEを検証する。クラウドAPI接続、認証UI、クラウド保存UIは未実装。

## 重要な未解決権限事項

Go upload endpointは受信したbyte streamのSHA-256を再計算してからStorageへuploadし、complete endpointも保存物を再読込して照合する。一方、現在のmigrationは`project_asset_mark_ready` RPCをauthenticated roleに許可し、RPC自体はStorage objectの存在とownerを見てreadyにする。従って、利用者がStorage APIを直接呼び、予約keyに任意byteを置いた後RPCを直接呼べば、Go stream検証を迂回できる。

これは外部所有者の読み取りを許すものではないが、サーバー検証済みデータだけをreadyとする完全性要件を満たさない。Step 7c設計案の「Go APIはservice_roleを保持しない」と、「Goだけがhash検証後に状態を遷移させる」要件が両立していない。今回、無断でservice_roleをGoへ導入することはせず、この制約を認識した状態でコードを残した。Hosted/public useを有効化してはならない。

安全な解決には、少なくとも次のいずれかを決める必要がある。

1. hash-verified transitionだけに限定されたserver-only capabilityを導入し、通常CRUDは引き続きuser JWT/RLSとする。Supabase Data APIで実現可能な認証方法・key保管を検証し、service_roleを使う場合は範囲を当該RPCに限定した脅威評価を行う。
2. Storage uploadをGo API内だけに閉じ、Storage直接upload権限を一般利用者から分離できる正式なStorage/API設計へ変更する。

この判断はセキュリティ境界を変更するため、後続で設計承認が必要。

## 検証結果

- local DB ledger：009、010、011を適用済み。
- bucket：`arvc-project-assets`がprivateで1件。
- 試験後の合成test users、Asset rows、bucket objects：0件。
- Local Auth JWT A：Project作成、Asset予約、音源/画像upload、complete、owner download、Cloud Envelope参照、削除成功。
- upload byte hash不一致：422で拒否。
- owner B/anon：API/Storage cross-owner read拒否。
- 未登録asset参照：422、参照中Asset削除：409。
- Project DELETE：Storage objectとAsset rowを削除し、Project lookupは404。
- `go test -p 1 ./...`：成功（local Auth/Storage integration testを含む）。
- `go vet ./...`：成功。`gofmt -l cmd internal`：出力なし。
- Frontend tests：6 files / 35 tests成功。
- Frontend typecheck、lint、build：成功。
- `git diff --check`：成功。
- Gemini request、Hosted Supabase操作、GitHub push、Python Island/Renderer/WebM変更：なし。

統合テストはローカルSupabase APIとGo/Frontend testsで行った。ブラウザのログイン・クラウドUIを実装していないため、実ブラウザでのcloud upload/edit roundtripは未確認で、Step 7dで検証する。

## 次工程への引き継ぎ

1. `project_asset_mark_ready`を利用者が直接実行できないserver-only verification handoffを設計・実装する。
2. その境界をlocal JWT/Data API/Storage direct callのnegative integration testで証明する。
3. 修正後に同じhash mismatch/owner/Project deletion回帰を再実行する。
4. その後Step 7dのlogin/cloud save/load UIと実ブラウザ検証へ進む。

Hosted issuer/Storage configuration、global CORS/容量/課金上限、resume/partial cleanup worker、クラウド運用費は未検証。今回のローカル統合結果をHosted保証として扱わない。
