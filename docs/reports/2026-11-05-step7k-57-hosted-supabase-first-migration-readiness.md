# Step 7k-57 — Hosted Supabase Free初回移行・実環境検証準備

**Status: partial / Hosted適用前の承認待ち。Hosted projectは未特定・未作成、Hosted/GCP/GitHubへの変更なし。**

## 作業開始時のGit状態

- Worktreeはclean。
- 現在のbranchは`feature/step7k56-beta-entitlements`、HEADは`13f7f5f`（upstream同branchと一致）。
- `main`と`origin/main`は`2ddd35f`。step 7k-56のfeature HEADは`main`のancestorではなく、ローカル参照ではPR #5がmainへmergeされた状態を確認できない。
- `gh pr view` / `gh run list`はGitHub API接続エラーで確認不可。利用者の「PR #5 merge許可・CI成功確認済み」という前提とローカルGitの状態が異なるため、報告はfeature branch上の候補を基準にした。Hosted apply前にGitHub上のmerge commit/headとmain CIを再確認する。
- この作業ではbranch切替、fetch、push、PR操作をしていない。

## Hosted projectと初期構成

**Project ref、組織、作成済みprojectの有無は不明。** 認証済みSupabase Management API/Hosted接続はなく、既存secretや環境変数も調査・表示していない。したがって現在のprojectを対象にしたread-only検査はできなかった。作成・設定変更は未実施。

- 候補: Supabase Free、Tokyo `ap-northeast-1`、PostgreSQL 17。2026-11-05にSupabase公式region一覧でTokyoがspecific regionとして掲載されていることを確認。PostgreSQL 17は候補のままで、project作成画面/APIで選択可能かは未確認。
- Free公式表示: projectあたりDB 500MB、Storage 1GB、egress 5GB、automatic backupなし。Free projectは1週間低活動でpauseされる可能性がある。利用料はFree quota内で$0だが、超過後に仕様を保つためProへ移行する場合は公式表示$25/monthが現状の¥1,000/月目標を超える可能性が高く、費用条件は未確定。
- Tokyoは候補に進めるが、作成直前に実際の選択肢・利用条件・DB versionを画面で確認して確定する。Freeの利用可能project数も組織横断制限があるため空きを確認する。
- Project作成後の確定値としてproject ref / region / plan / PostgreSQL `server_version` / project URL / issuer / JWKS URL / Pooler hostを保全記録へ記載する。作成されていない現時点で値を推測しない。

## Migration inventoryと適用順

- 候補ブランチの`supabase/migrations/`にはtimestamp順に24件（`20261101000100`〜`20261105000500`）がある。
- `deploy/hosted-migrations.sha256`の24 entryを`sha256sum -c`で照合し、全件一致。
- `supabase/` CLIはこの環境に見つからず、CLI 2.121.0実行、Hosted migration履歴照会、`db push --dry-run`は未実施。Hosted側の履歴・empty状態・適用対象は**未確認**であり、24件を現在の承認済み適用集合と断定しない。
- PR #5がmerge済みであることと、Hosted projectにユーザーデータ/独自schemaがなく新規空であることを個別に確認できた後に限り、24件全てをtimestamp順にfresh baselineとして適用する方針。017/018だけを抜く、履歴をrepairする、SQLを書き換える、適用済みmigrationを再適用する方法は禁止。
- 017はAI local fixture quota exemption RPCを含むがHostedアプリは`AUTH_ENV=hosted`でその経路を拒否する。018はAI model/pricing snapshotであり、初回empty baseline内のみ適用する。Audio beta entitlementは024（`20261105000500`）で追加される。
- 初期依存: Supabase管理の`auth`/`storage` schemaと`anon`/`authenticated`/`service_role`等が存在するHosted projectが前提。`extensions.digest` (pgcrypto由来)を呼ぶjob SQLがあり、schema/関数利用可否をdry-runだけに頼らず適用後検証する。Migrationは`postgres`管理role相当のSession Pooler接続を要求する: 最初のProject migrationはrole作成・一時grant/revoke、複数migrationは`postgres`へのfunction owner変更を含む。これらの実効権限はHostedで未確認。runtime用専用roleにmigration権限を付与して代用しない。
- supabase/config.tomlはlocal stack設定でありHosted設定の証明ではない。設定上はDB major 17、anonymous sign-in falseだがsignup true。HostedはDashboardでsignupとanonymous sign-inを両方disableし、invite-only、ES256 signing key、canonical issuer/JWKS、redirect allowlistを設定・検証する。local configをHostedへpushしてはならない。

## DB、Auth、Storage、β entitlement

- Runtime DB: `arvc_audio_analysis` / `arvc_ai_budget`の専用roleと各1 connection poolを維持。Free IPv4 Session Pooler session modeのhost `aws-<n>-<region>.pooler.supabase.com`, port 5432、username `<role>.<project-ref>`、database `postgres`、`sslmode=verify-full`とhostname検証をコード/guardが要求する。transaction pooler、postgres owner credentialをruntime利用、role権限拡大は不可。Managed migration workflow自体は専用`postgres.<project-ref>` DSNを要求し、専用runtime roleとは分離する。
- Auth: Hosted Go trust modeはHTTPS canonical Supabase issuer/JWKSおよびES256を使う設計。audience、role、expiry、UUID subjectを検証する。invite送信設定と実メール配送、bad/expired JWT、cross-user拒否はHostedで未検証。実管理者アカウント作成は別承認。約10名のβ利用者は全実環境検証完了まで作らない。
- Storage: `arvc-project-assets`と`arvc-audio-analysis`をPrivateに保つ。既存owner-read/RLS、server-only audio upload/delete、object-key/job/user照合、terminal cleanupを維持する。新`sb_secret_…`は`apikey` headerのみ、legacy service-role JWTならrole claimを検証して`apikey`+Bearer。Hosted PUT/GET/DELETE、owner/cross-user/anonymous policyは未確認。secretをfrontend/log/gitへ置かない。
- Audio beta: Hosted deployment scopeは`hosted`。control singletonのenvironmentを`hosted`に明示し、同scopeの有限expiry付きbeta entitlementを個別に付与するまでdenyを維持。betaはuser日次/月次回数だけ迂回し、全体quota/burst/concurrency、2 queued/1 running per user、20 job/320MiB queue、16MiB/60秒、lease/fencing/settlement/cleanup/kill switchを維持。AI generationはdisabledを維持。
- Free容量の明確な懸念: project-assets migrationのアカウント上限は880,803,840 bytes（約840MiB）、Audio queue/storage上限は335,544,320 bytes（320MiB）。合計1,216,348,160 bytes（約1,160MiB）でFree Storage 1GBを超える。DB migrationだけで総容量を使い切るわけではないが、仕様上限同士は同時成立しない。実使用量を監視し、超過前に受付停止する運用では仕様を維持できる規模を保証できない。β招待/Audio受付を有効化する前に、容量見積と縮小/制限/有料planいずれかの別決定が必要。今回は設定を変更しない。

## Backup・停止・復旧

Freeに自動DB backup/PITRがないため、初回適用前後はoperatorが保管するlogical archiveを基準とする。Project作成・Migration適用の承認後、まずempty状態とidentityをDashboard/CLI/DBから記録し、`pg_dump -Fc`を実行する（空状態の基準backup）。24件適用後は別のcustom-format archiveを採取し、両方のnon-zero size、pg_dump exit code、file size、SHA-256、PostgreSQL client/server versionsを記録する。保管先はGit外のaccess-controlled encrypted storage、file mode 0600相当とする。Archive list/restoreはHostedと隔離した同じmajor PostgreSQLの一時DBで検証する。managed `auth`/`storage` schema、role/ACL/event trigger、extension、JWT signing keysやproject configがlogical dumpだけで全復元可能とは見なさない。

Storage object/media backupはDB dumpと別工程。empty baseline時はbucket inventoryが0であることを記録し、user dataを許可する前にStorage object enumeration/download/checksumとrestore試験・保持先を定義する。DB rowとobjectの整合、private metadata、`storage.objects` owner、error-case cleanupを復元確認する。Bucket dataが非zeroならbackup/restore手段が確認できるまで停止する。

Migration失敗、不明な履歴、unexpected object/schema, hash/dry-run mismatch, privilege error, partial apply, backup/checksum/restore failureのいずれかでworkflow/deployを止め、secretとSQLを収集せずsafe error、CLI出力をredactして保存。再実行、history repair、SQL edit、project削除・再作成、無断restoreは禁止。schema stateとmigration tableをread-onlyで採取し、原因/forward correctionまたはreviewed isolated restoreを決めて別承認を得る。新規empty projectでも自動破棄しない。

## Workflowと適用後検証計画

既存`.github/workflows/hosted-release-approved.yml`は`production` Environment、明示workflow_dispatch、project ref/Pooler host照合、full-baseline empty confirmation、24 SQL hash・CLI history・dry-runのexact set照合をguardする。Hosted migration後には履歴収束を検査する。しかし同workflowはmigration適用後にGoogle認証し、API/WorkerをCloud Runへ`--no-traffic`でdeployするため、migration-only操作ではない。Cloud Run deploymentは今回の検証範囲外であり、このworkflowを承認なしに実行しない。承認後もmigration-only経路とCloud/GitHub操作権限を分離し、該当操作ごとの明示承認を取る。

Hosted変更の個別承認を得た後、project identity・backup・migration dry-run・24件apply・schema/history・RLS/ACL/RPC invariants・ES256/JWKS・Storage owner/deny・専用runtime role TCP/TLS・Hosted beta scope・軽量API/DB/Storage smokeの順で行う。entitlement付与前はAudioがdenyされることを確認する。SCNet実推論、Cloud Run deploy、一般公開、β user作成は行わない。DB smokeでは`SELECT 1`と最小権限RPC確認を分け、書込みtest fixtureを使う場合は事前に対象/cleanupを承認された後に限る。

## 検証実施結果

- Read-only: Git refs/status/log、指定資料、全migration一覧・hash manifest、Hosted release workflow、Go DB/Auth/Storage、Cloud Run template、Supabase local configを確認。
- `git diff --check`: PASS。
- `sha256sum -c deploy/hosted-migrations.sha256`: 24/24 PASS。
- Supabase CLI 2.121.0: 未導入。Hosted dry-run/migration history/project region/version/auth/storage/role/backupは未検証。
- GitHub API: 接続不可。PR merge/main CIの再確認未完了。
- Hosted Supabase、GCP、Production workflow、外部resourceへの書込み・接続なし。

## 承認前に埋める事項

1. PR #5のmerge commit、main head、required CI成功をGitHubで確認する。
2. 対象organization/projectの有無とref、Free plan、Tokyo region、PostgreSQL 17の実選択可否をread-only確認。projectがなければ、上記容量懸念を含む構成作成承認を得る。
3. Empty project/schema/role/auth/storage状態、migration history、CLI 2.121.0 dry-run、project version/extension、migration権限を確認する。
4. Free容量の総量不一致、DB/Storage backup restore、月額¥1,000目標との整合を解決する。
5. Protected migration DSN、runtime専用role credentials、Storage secret、Auth/JWKS/redirect、private buckets、β environment scopeの作業順とSecret Manager保管を決める（secret値を報告書に記録しない）。
6. 操作直前に対象ref/region/plan/hash集合/backup/費用/停止条件を再報告し、project作成、Auth/DB/Storage設定、migration apply、runtime role/credential変更など該当する各外部操作の明示承認を得る。

## 変更ファイル

- `docs/reports/2026-11-05-step7k-57-hosted-supabase-first-migration-readiness.md`（新規）
- `CURRENT_TASK.md`
- `docs/CURRENT_STATE.md`

ローカル設定・migration・アプリコード・GitHub/GCP/Supabase resourceは変更していない。
