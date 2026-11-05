# Step 7k-56 — Hosted移行前統合・招待制β版アカウント制御

**Status: partial（ローカル実装・隔離検証PASS、PR #5のBackend migration CIで検出した適用順序不整合を修正し、再実行待ち）**

## 実装

新forward migration `20261105000500_step7k56_beta_audio_entitlements.sql`を追加した。既存`audio_analysis_entitlements`には`standard`/`beta` tier、`local`/`hosted` scopeを追加し、β entitlementには有限expiryを要求する。既存利用者は`standard`/`local`のまま。Audio Analyze APIはDB環境scopeとJWT trust modeが一致しないと起動時にfail-closedする。

日次/月次のユーザー別利用数判定だけはβtierで迂回する。サービス全体の日次/月次quota、burst、user/global concurrency、1ユーザー2 queued/1 running、20 job/320 MiB global queue、50 MiB/user Storage上限、16 MiB/60秒入力、lease/attempt fencing、usage ledger、kill switchは維持した。通常tierは従来のuser quotaを継続する。全てのβ解析も既存usage tableで追跡・settlementする。RLS、role、RPC grantsは拡張していない。

新しいproduction APIやAuth実ユーザーは追加していない。signup無効化、管理者招待、entitlement付与/停止はHosted Dashboard/SQL Editorによる運用手順とする。βユーザーはAuthentication → Users → Add user → Send invitationで招待し、本人が利用開始した後にAuth user IDを確認する。migration適用後、Hosted SQL Editorでcontrolの`deployment_environment='hosted'`を一度明示し、user単位に有限期限つき`access_tier='beta', deployment_environment='hosted', enabled=true, concurrent_limit=1`を付与する。既存CHECKを満たす正の`daily_limit`/`monthly_limit`値も保存するが、beta tierの判定では使用しない。Hosted API/Workerを`AUTH_ENV=hosted`で起動する前に、このDB scope更新と`audio_analysis_environment_matches('hosted')`の確認が必要。初期状態はfail-closedなのでscope更新前にβ利用はできない。対象ID、期限、変更理由を管理記録へ残す。

## β開始・終了・正式版への運用

- 開始前にHosted Authで一般sign-upとanonymous sign-inを無効にする。sign-up無効状態でも既存userはsign-inできる。[Supabase Auth general configuration](https://supabase.com/docs/guides/auth/general-configuration)
- 招待はDashboardまたは信頼済みserver-side Admin APIのみ。secret keyはFrontendやActions logへ置かない。[Supabase Auth users/invitations](https://supabase.com/docs/guides/auth/users)
- 初回10人程度を個別に確認し、招待ログイン、解析60秒以下、60秒超拒否、所有者境界、期限切れ、無効資格を確認する。解析1回ごとのquotaは適用しないが、global quota/rate/concurrency/queue/storage制御は適用する。
- β終了時はまずentitlementを無効化し、新規受付を止める。queued jobをcancelし、running jobはcancel requestと既存lease/attempt fencingに従って終端化する。開始前reservationをreleaseし、started usageは一度だけsettleする。terminal cleanup outboxの完了とStorage残量を確認後にAuth userをbanする。今回、実user/既存データは変更していない。
- Supabase access tokenはstateless JWTであり、Auth banはすでに発行されたJWTをexpiry前に無効化しない。Audio Analyzeは各予約・開始でDB entitlementを照合するため拒否が即時反映される。その他のAPI/RLSデータはtoken期限まで通り得るため、βで有効にするendpointは最小限に留める。Projects等を有効化する場合はsession revocation方式を別途実装・検証する。[Supabase user management: JWT and bans](https://supabase.com/docs/guides/auth/managing-user-data)
- 正式版では既存Auth identityを保ったまま`standard`へ切り替え、正式なquotaを設定する方法を推奨する。同じemailで新Auth userを作り直すと既存identityと競合しうる。IDを作り直す場合はStorage所有権、関連job/usage、保持義務を確認し、不可逆削除の明示承認を得る別作業にする。今回はAuth/user/job/usage/Storageを削除・匿名化しない。

## Migration 017 / 018

既存SQLは変更していない。017のfixture exemptionはAI generation専用でAudio Analyze beta entitlementとは別。`AUTH_ENV=hosted`ではアプリがfixture経路を拒否し、017はHosted初回migration履歴に正規順序で含める。018はAI model/pricing snapshotのみで、AI entitlementを作らない。AI runtimeは`AI_GENERATION_ENABLED=false`、secret未設定の既存Cloud Run templateを維持する。Hosted baselineは017/018を除外せず全timestamp migrationを適用する。manifestは24件になりhash更新済み。

## Supabase Free heartbeat

Step 7k-55の8時間ごとのread-only `SELECT 1`、dispatch recoveryと別identity/endpoint、failure通知、費用発生resource作成前の停止条件を維持する。Free自動pause回避を保証しない。Hosted/GCP/Scheduler設定は変更していない。

## ローカル検証結果

- 使い捨てDB`arvc_step7k56_disposable`に、23 migrationのschema/historyを再現して24番目を単一transactionで適用。test DBのみのsynthetic fixtureをrollback。Fresh empty Supabaseから24件全件適用はGitHub Backend/Database CIで確認する。
- βSQL検証：ユーザーdaily/monthly count超過後のβ受付・開始・settlement、standard上限、uninvited/disabled/expired拒否、service quota拒否、environment mismatchとStorage intent拒否、kill switch、RPC/ACL境界PASS。
- 既存`step7k50b`/`50d`/`50e`/`52` rollback SQL、3種のRLS/privilege invariant PASS。
- Go全package `go test -race -p 1 ./...` PASS（default sandboxのIPv6 loopback拒否後、承認済み権限昇格で完了）。`go vet -p 1 ./...`、`go build -p 1 ./...`、β変更package race再実行PASS。
- 24件migration manifest/hash、Hosted migration target guards、shell構文、全GitHub Actions YAML parse、changed-file secret pattern scan、`git diff --check` PASS。
- Frontendコードは未変更。GitHub Frontend CIはPRで実行する。
- Supabase CLIがWSLに未導入のため、ローカル`supabase migration up`/`db lint`は未実施。PR CIのsupabase CLI 2.121.0 fresh stackで補完する。

## CI適用順序修正

初回PR CIで、`supabase db start`がmigration 050001–050004を一時退避している間に新しい005 migrationまで先行適用し、参照先の`audio_analysis_jobs`がない状態で失敗することを確認。CI手順を更新し、beta entitlement migrationも一時退避してpreservation sentinelを作成した後、先行4 migrationとともに復元してから`supabase migration up --local`で正しい順序に適用する。失敗時のtrapでも全5ファイルを復元する。YAML parse、migration job shell `bash -n`、`git diff --check`は更新後PASS。修正後のGitHub CIは再実行待ち。

## 保全・適用制約

開始時の実worktreeはcleanでStep 7k-54/55成果はmain `2ddd35f`に統合済み。従って開始時に伝えられた「未コミット変更」は実際には存在しなかった。ローカル開発Supabaseはmigration/dataを変更していない。従来のStep7k52隔離Supabase DBも23 migration/0 job/0 usage/0 Auth userのままで変更していない。追加した使い捨てDBはテスト後に削除し、生成したSQL dump/temp cacheも削除する。

Hosted Supabase・GCP・Production workflow・GitHub mainは未変更。merge/deployは禁止。GitHub feature PR/CI完了後もmain mergeは人の最終承認待ち。

## 残存事項

- PRのBackend/Database CI（全24 migration fresh apply、`db lint`）とFrontend CIは未実行。
- Hosted sign-up/invite settings、Free project/DB role/Storage、real JWT/SCNetは未接続・未試験。管理者が設定後、Hosted適用承認とsmoke testが必要。
- Auth banのみでは既発行JWTは即失効しない。Audio entitlementで解析は止まるが、他endpointを有効にする場合はsession revoke gateを別途必要とする。
- 017/018 Hosted初回baseline判断はStep7k-55方針を維持し、Hosted実CLI/実projectでのdry-runはHosted接続許可後に確認する。
