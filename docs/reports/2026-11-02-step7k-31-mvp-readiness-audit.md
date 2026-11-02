# Step 7k-31 — MVP公開前 Readiness Audit

監査日：2026-11-02
Status：**completed（Read-only audit）**
公開判定：**現行の対話型MVPは公開不可（NO-GO）**。限定的な静的ポートフォリオ公開は、使用素材の権利確認と実際の公開物確認を条件に検討可能。

## 1. Executive Summary

Frontend Editor、Go API、Python Island、Blueprint/Timeline v1、Renderer、ローカル`.arvproj`、動画Exportは実装されている。一方、リポジトリのデプロイ方針は候補サービスを挙げるだけで、Hosted向けビルド・環境設定・認証・DB/Storage・ジョブ実行の構成はない。Go API、JWT issuer、CORS、Frontend Auth URL、Asset URL検証はloopback限定であり、APIをインターネットへ公開する構成ではない。

最も大きな公開ゲートはDemucs htdemucs重みの権利である。既存の一次資料レビューはmaintainerの「重みはMIT対象外、scientific purposes only」という説明を記録しており、公開サービスでの推論許諾がない。コードのMIT表示は重みの許諾を解決しない。加えて、デモ音源・モデル由来Timeline等の公開条件、Hosted Auth/DB/Storage/AI予算、保存期間・運用・監視が未確定。

ユーザー入力ではStep 7k-30のMP4をWindows Chromeで実動作確認済みとされている。本監査はこの新しい利用者確認を受け入れる。ただしStep 7k-30リポジトリ報告と`docs/OPEN_ISSUES.md`は実ブラウザ未確認と記録しており、音声付き/なし双方、再生、duration、同期、codec情報の試験証跡をこの作業環境では照合できなかった。監査結果ではこの記録不整合と追加で保存すべき証跡を明示する。

**推奨する次工程：** まず公開形態を選ぶ。短期ポートフォリオなら、音源解析・ログイン・保存を提供しない静的な紹介ページと、権利確認済みの事前生成サンプルだけに限定する。対話型解析を公開するなら、Demucs重みの利用許諾を先に解決し、その後にHosted API/Auth/DB/ジョブ・コスト・セキュリティ設計を別L3で行う。

## 2. 現在の実装状態

| 機能 | 状態 | 根拠・公開時の注意 |
|---|---|---|
| 音声選択・範囲選択・試聴 | 実装済み、ブラウザ/実音源の全操作検証は不足 | `/app`の波形モーダル、WAV crop、60秒上限。Step 7k-16b〜16d報告は実ブラウザ未確認。 |
| Audio Analyze | ローカル実装済み、Hosted未実装 | 60秒・16 MiB・600秒timeout・process内同時1件。ユーザー提供の実MP3でローカルHTTP 200の記録あり。CPU htdemucs・loopback Auth/APIに依存。 |
| Kick Gate Mode | 実装済み、精度評価は未完 | Off/Soft/Middle/Hard伝播と件数は確認済み。demo4の正解ラベルがなく精度指標なし。解析結果の品質保証とは異なる。 |
| Timeline生成 | 実装済み・契約検証あり | Feature Timeline v1、0ms origin等。実音源60秒Timelineの生成記録あり。Hosted処理・多重実行負荷は未検証。 |
| Blueprint生成・適用 | Fixture経路実装済み、Hosted未検証 | Fixtureが既定。OpenAIはサーバー側・認証/DB budget付きだが、実API呼出し・Hosted migration・実請求未検証。解析成功後の自動生成ではなく明示操作。 |
| Effect編集・Preview | 実装済み・一部手動受入済み | 20 Effect、Region編集、位置操作、Preview/Renderer共通経路。自動テストあり。全ブラウザ/解像度/各Effectの視覚受入れは未完。 |
| `.arvproj`保存・復元 | 実装済み・互換テストあり、最新音声入りケースの実ブラウザ証跡不足 | v1にBlueprint/Timeline/Summary/crop WAVを保存・復元。ファイルは暗号化されず、音声/背景データを含み得る。ローカル保存でありHosted backupではない。 |
| WebM Export | 実装済み、出力の完全検証不足 | 過去のChromeでファイル作成とEBML headerを確認。再生・track metadata・duration・同期をその検証では確認していない。 |
| MP4 Export | 実装済み、ユーザーによるWindows Chrome実動作確認あり | Step 7k-30でH.264と、音声時AAC LCを要求する実装・mock tests。利用者はChrome実動作を確認したと報告。`ffprobe`等のcodec/duration証跡と各音声モードの範囲は未照合。過去報告は古い未確認状態。 |
| Cloud Project | 意図的にUI非表示、バックエンド保持 | Step 7k-19。Cloud API/DB契約は残るがHosted運用は未確認。通常ユーザー向け公開機能としては現在提供しない。 |
| 商用化・課金・AI素材生成 | MVP対象外 | `docs/PROJECT_CONTEXT.md`の決定事項。今回の監査でも対象外。 |

## 3. 公開可否と阻害要因

### Critical

1. **Demucs重みの一般公開推論許諾がない。** `python-island/src/python_island/pipeline.py`はhtdemucsを使い、`docs/reports/2026-10-31-separation-model-weights-license-review.md`は重みがMIT対象外でscientific-purpose onlyというmaintainer説明を記録する。Hostedでユーザー音源を処理する公開サービスは、権利者から別途明確な許諾を得るまで停止すべきである。コードライセンス、checkpoint、派生stem/Timelineの扱いを分けて確認する。一次資料：[Demucs Issue #327](https://github.com/facebookresearch/demucs/issues/327)。法律判断ではない。

### High

1. **現在のAPI/AuthはHosted接続を拒否する。** `api/cmd/server/main.go`はAPI bindをloopbackに制限し、`api/internal/authn/jwt.go`はHTTP loopback issuerだけを受け入れる。`api/internal/service/http.go`のCORSもlocalhost:5173だけ。`frontend/src/auth-client.ts`はloopback HTTP Supabase URLを要求し、`api/internal/assets/service.go`もloopback URLを制限する。単にクラウドへ配置しても認証/APIは成立しない。これらの制限を公開用に変更することは今回のRead-only範囲外であり、CORS/HTTPS/origin/issuer/JWKS/DB資格情報を含む別設計が必要。
2. **Python Islandの公開ジョブ実行・分離境界がない。** Goは固定ローカルPython executable/pathを実行する。Hosted用コンテナ、キュー、job lifecycle、キャンセル/再試行、分離tenant、一時ファイル・モデルcache管理は未実装。現行の同時実行1件は単一Go process内だけで、scale-outした複数instanceでは全体上限にならない。非信頼ファイルの公開処理には、メモリ/CPU/time limit、patched ffmpeg/ffprobe、隔離と濫用防御の実測が必要。
3. **DemucsのCPU/RAM要件は無料Frontend/API枠に収まらない。** 既存実測は60秒解析でpeak RSS約1.28 GiB、別の約118〜180秒音源で約1.46〜1.60 GiB、約62〜95秒の解析処理時間を記録する（ローカル測定でありCloud実測ではない）。Koyeb free instanceは512 MiB / 0.1 vCPU / 2 GB diskで、資料上production用途を推奨していない。Cloudflare Workers Freeは128 MB・invocation CPU 10msであり、Demucsを実行できない。Cloud Run/Jobsなら技術候補だが、このrepositoryからのjob運用は存在せず実測もない。
4. **デモ素材の公開権利が未確定。** `docs/reports/2026-11-01-step7h-3-5-demo-audio-assets.md`は3曲をユーザー提供のSuno有料プラン生成物として記録するが、第三者が閲覧できる公開配信・派生Timelineの条件を証明するライセンス文書は見当たらない。demo assetはproduction buildで既定除外され、`ARVC_DEMO_ASSETS_PUBLICATION_APPROVED=true`時だけ同梱される。opt-inを権利承認の代替にしてはならない。MP4/スクリーンショットや別の音源・画像にも公開許可を確認する。
5. **Hosted Auth/DB/Storage/AI budgetは実装・検証されていない。** Migrations/roles/provider budgetはlocal Supabaseで検証され、Hostedへは適用されていない。Cloud UIも隠れている。Hosted JWT issuer/JWKS、role provision、RLS/Storage、signed access、migration handoff/rollback、signup/invite/abuse control、AI entitlement、billing kill switch、data retentionを公開前に決めて実環境で検証する必要がある。
6. **公開時のresource/費用制御は保証されない。** 解析制限はper-process semaphore、AI budgetはローカルDBでのadmission controlであり外部provider請求のhard capではない。OpenAI project spend cap/鍵制限は未確認、実APIも未試験。公開する場合、無制限signupや公開fixture経路を含む脅威モデル・全体制限を検証する。
7. **実行環境FFmpegのセキュリティ保守が未完。** `docs/SECURITY.md`は現WSL Ubuntu 24.04のFFmpegに修正未適用のSecurity Noticeを記録し、未信頼音声の本番処理へ採用しないよう明記する。新しい本番イメージでパッチ状態・FFmpeg build・OS lifecycleを確認する必要がある。FFmpegを含むlockfileだけでOS実行ファイルのパッチ状態は決まらない。

### Medium

1. **CIはFrontendだけ。** `.github/workflows/frontend.yml`はFrontendのnpm ci/typecheck/lint/test/buildを実行する。Go/Python test/vet/mypy/Ruff、dependency/license scan、container build、E2E、デプロイ前承認workflowはない。Workflow実行自体も`docs/OPEN_ISSUES.md`で未確認。
2. **データ保持・削除・復旧・監視が未定。** 一時解析fileはrequest終了時に削除する実装だが、公開用の保存期間・account削除・backup削除・ログ保持・障害通知・migration rollback/backup restore runbookは確立していない。Cloud Asset APIは維持されるがUIはhidden。`.arvproj`は平文JSONでaudio/imageを含み得るので安全なローカル保管・共有が必要。
3. **ブラウザ互換・負荷・動画検証に残りがある。** MP4は利用者によるWindows Chrome確認という新しい前提を受け入れるが、保存済みstep報告に証跡なし。無音MP4/音声付きMP4それぞれのH.264/AAC codec、duration/再生、同期差、WebM parity、各ブラウザ/GPU、全20 Effect、狭幅UIは統合試験未了。WebGL2/Canvas memory、frame drop、RAM/CPU peak、複数利用者同時解析も公開想定値なし。
4. **依存・OS監査は公開直前の再確認が必要。** 2026-10-31のnpm/pip auditは当時の固定依存について0件と報告されたが、現在の再監査ではない。PythonのTorchは通常のPyPI監査対象外として別確認が必要。lockfilesはあるがGo/Python CIでの継続監査がない。
5. **MP4受け入れ記録が矛盾。** 利用者による新しいChrome確認の申告と、Step7k-30報告/OPEN_ISSUESの古い未確認記録が一致しない。どのブラウザ/codec/出力mode/fileを検証したかを残し、記録を同期する。

### Low

1. **一部候補サービスは現在の設計と直接互換ではない。** Koyeb/Neonへの具体的な選定・repository設定は見つからない。NeonはDBサービス候補で、Supabase Auth/Storage/Data APIや既存Migrationをそのまま置換できることは確認していない。採用決定前に互換性試験・移行設計が必要。

## 4. デプロイ候補と構成

| 層 | repositoryで確認したもの | 公開時の未実装/条件 |
|---|---|---|
| Frontend | React/Vite、production build成功、`.github/workflows/frontend.yml` | static Pages候補。build時のdemo assetsは既定で除外。API/Auth URLs・CORSがlocal-only。Pagesへ置くだけではAnalyze/AI/Authは動かない。 |
| Go API | Echo API、local fixture/OpenAI generator、Project/Asset/Audio Analyze routes | Loopback bindとlocal issuer固定。Hostable image/service、TLS ingress、CORS allowlist、secret bindings、health/readiness/observability、global throttlingなし。 |
| Python Island | Python 3.14 + Torch CPU + Demucs 4.1.0、local CLI、cached weightsのみ | Hosted CPU image/job/queue/cache deploymentなし。weight license blocker。CPU/ram/latency/load hosted benchmarkなし。 |
| Auth | Supabase Auth JWT ES256/JWKS validation、local Auth tests | Hosted issuer/JWKS, signup policy, email deliverability, reset/abuse, origin/session/CSP, operator access未検証。 |
| Database | Supabase migrations/RLS/budget roles local | Hosted migrations/role provisioning/rollback/backup/restore未検証。Cloud UI hidden。 |
| Storage | private Supabase bucketとowner RLS/API local | Hosted bucket/quotas/retention/object deletion/egress/ownership復旧未検証。R2 adapter未実装。 |
| AI | OpenAI Responses server mode + Fixture mode | 実API未呼び出し。Hosted key, project restrictions, billing cap, data policy/region, quota operate/kill switch未検証。 |

既存資料にCloudflare Pages/R2、Cloud Run Services/Jobs、Supabaseが**候補**として記載される。Dockerfile/compose、Pages/Koyeb/Neon/Cloud Run deploy manifestは見つからない。Koyeb/Neonはコスト比較候補としてのみ扱い、採用済みとはしない。

技術的に候補を分けるなら、Pagesは静的Frontendのみ、Cloud Run serviceはGo API、Cloud Run job/別workerはCPU解析、SupabaseはAuth/Postgres/Storageという構成になる。しかしこの分割は既存APIのloopback/local assumptionsを変えるため、そのままデプロイできる構成図ではない。

## 5. セキュリティ・データ取扱い

- **Secrets:** `OPENAI_API_KEY`/DB verifier DSNはserver-side想定で、VITEへsecretを置かない規則がある。Hosted Secret Manager連携は未設定。`.env.example`だけを確認し、実Secret値は開示・出力していない。
- **API/Auth:** local JWT署名/issuer/audience/expiry/subject検証、owner-scoped DB/Storage/RLS、入力上限はlocal testsで確認済み。Hosted issuerへ許可するための公開変更はまだない。
- **CORS/origin/TLS:** local Vite originsだけ許可。Hosted TLS/CSP/security headers/custom domain/redirect URIは未設定。
- **Media inputs:** Audio AnalyzeはWAVに限定、multipart総量16MiB、clip最大60s、600s timeout、private temp directory、cleanup、単一process内1件。公開時には大容量/壊れたfile、decode CVE、同時instance、queue exhaustion、egressを追加評価する。
- **Data retention:** 未確定。Analysis tempは一時的。一方 `.arvproj`は平文ローカルファイル、ユーザーが共有する場合は内容に音源/画像を含み得る。Cloud storageのUIが隠れてもAPIとdata contractは残り、Hosted実装時は保存期限・削除処理・account deletionを規定する。
- **Logging/errors:** local code avoids logging keys/JWT/request bodies in reviewed auth/AI/audio flows and returns classified errors. Hosted log access, redaction review, PII policy, log retention and incident response are not configured.
- **Abuse/cost:** per-process controls do not provide global quotas behind horizontal scaling. App-side AI reservation is not provider billing cap. signup/invite and operator shutoff are not deployed/verified.
- **Scope:** static `/demo` is intended not to call Go/Auth/Cloud/AI. This is safer as a portfolio slice, but its media/publication rights and build inclusion still need explicit review.

## 6. ライセンス

既存レビューでは、Demucs model weightsはMIT code licenseに含まれずscientific useのみというmaintainer statementが記録される。SpleeterのJOSS論文とREADMEの書き方の齟齬、UMX-HQ weightsのlicense欄未記入も既知で、解決済みとして扱えない。対象本番pipelineはDemucs htdemucsなので、Demucsの個別明示許諾が最優先。

デモ曲についてはStep 7h-3.5報告がSuno有料プランで作成されたユーザー提供曲と記録するが、公開サイト・広告/ポートフォリオ配信・派生Timeline/波形・MP4への利用権を確定するライセンス記録は監査で確認できなかった。画像、フォント、アイコン、UIスクリーンショットにも同様の権利一覧は見つからない。公開可否は推測せず、権利者/提供者の明示確認と、利用サービスの現行規約確認が必要。

## 7. 運用コスト

調査日現在、以下は**公開ベンダー価格**であり、利用量の見積・為替/税を含む請求予測とは異なる。

| サービス/構成 | 公開価格・枠（調査時） | このMVPへの評価 |
|---|---|---|
| Cloudflare Pages static | Freeのstatic asset requestsは無料/無制限。Pages Functions FreeはWorkers quotaへ計上。Workers Freeは100,000 requests/day、10ms CPU/invocation、128MB。 | 静的portfolio配信に適合候補。音声解析・Go/Python実行には不適。 [Pages static pricing](https://developers.cloudflare.com/pages/functions/pricing/), [Pages limits](https://developers.cloudflare.com/pages/platform/limits/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Cloud Run | 料金ページにinstance CPU/RAMのfree tier（CPU 240,000 vCPU-second/月、RAM 450,000 GiB-second/月、us-central1基準）と従量課金を表示。Jobsはinstance lifetimeで課金、Artifact Registry/build/egress等は別料金。 | 低トラフィックならfree quota内の可能性はあるが、実際の2vCPU/4GiB Job/container、Tokyo region、storage/build/egress、連続Go serviceを含む試算と測定がないため0円保証ではない。 [Cloud Run pricing](https://cloud.google.com/run/pricing) |
| Koyeb | Free Web Service 512MB RAM / 0.1 vCPU / 2GB disk、1組織1個、文書上production用途を推奨せず。Eco large 2vCPU/4GBは$10.71/月、標準large 4vCPU/4GBは$42.85/月の掲載。 | Freeは既存実測RAMを下回りCPUも非常に小さい。適切な4GB instanceは無償枠ではない。地域/利用状況/税/追加DB/storageは別途。 [Koyeb instances](https://www.koyeb.com/docs/reference/instances), [Koyeb pricing](https://www.koyeb.com/pricing) |
| Supabase | Free $0: 2 active projects上限、500MB DB、1GB file storage、5GB egress、1週非活動後pause。Proは$25/月から。 | Freeはprototype候補だがpause・容量条件がある。Pro base priceだけで¥1,000目標への余裕がなく、Storage/egress/computeも含む必要。 [Supabase pricing](https://supabase.com/pricing) |
| Neon | Free $0: 100 CU-hours/project/月、1GB storage。Launchは典型例$15/月。 | DB価格候補だがSupabase Auth/Storage/API/RLS/migrationsを置換する既存接続がなく、価格だけで移行候補確定は不可。 [Neon pricing](https://neon.com/pricing) |
| OpenAI GPT-6 Luna | Standard価格ページはinput $0.10/M tokens、output $0.50/M tokens（別処理tier/cachingで変動）。 | 変動費。実API usageは未検証。ローカルDBの月次予算値やtoken予約はprovider hard spend capではない。 [Official model page](https://developers.openai.com/api/docs/models/gpt-6-luna), [pricing](https://developers.openai.com/api/docs/pricing) |

### A. 現行MVPをそのまま公開

**公開不可。** Demucsの公開推論権利が未解決で、現APIはlocalhost-only。仮にpermissionを得ても、Hosted API/worker、Auth/DB/Storage setup、upload isolation、global quota、abuse monitoring、provider spend controlが必要。¥1,000以内の総額は現資料から算出不能。Supabase ProまたはKoyebの常時runtimeを使う構成では掲載base/monthly価格が予算を押し上げる。Cloud Run無料枠の範囲で収まるかも、deployment/usage/egressを実測していないため未確定。

### B. 機能を制限したポートフォリオ公開

**相対的に実現しやすい候補。** ユーザー音源upload、Audio Analyze、ログイン、Cloud save、OpenAI generationを出さず、静的説明・画面キャプチャ・権利確認済みの事前生成動画だけを配る。Pages staticのhosting request費用はFree枠に収まり得るが、domain、media transfer、利用素材許諾は別。現Frontend production buildは`public/`を既定除外するため、demoを含めるなら`ARVC_DEMO_ASSETS_PUBLICATION_APPROVED=true` opt-inを安易に設定せず、個別素材の権利承認と配布物監査が必須。このrepository自体はlanding portfolioを持たず、static buildだけで動作する製品demoになる保証もない。

料金はUSDで記録し、JPY換算は実際の支払い方法/税/為替レートで公開直前に再計算する。Free tierの変更・休眠停止・課金発生条件も変わり得る。事業者のfree quotaを月額上限として扱わない。

## 8. 品質・CI・実行検証

### この監査で実行したローカル検証

- Frontend `npm test -- --run`: **177 tests / 13 files passed**。
- `npm run typecheck`: passed。
- `npm run lint`: passed。
- `npm run build`: passed。
- Go `go test ./...`: server/cmd, aibudget, assets, audioanalysis, authn, blueprint, projects packages passed. `internal/service` test process panicked in `httptest.NewServer` because sandbox disallows IPv6 loopback bind (`listen tcp6 [::1]:0: operation not permitted`); therefore full Go suite is **not fully verified**.
- Go `go vet ./...`: passed.
- Python direct local venv `pytest`: **65 passed**, including Demucs integration test.
- Python `mypy --strict src`: passed (9 source files).
- Python `ruff check src tests`: **failed with 14 E501 line-length findings** in existing `features.py`, `pipeline.py`, and `tests/test_features.py`; no source changes were made. Existing OPEN_ISSUES had recorded Ruff E501 violations; current run count is 14.
- `uv run --locked pytest` could not start because uv attempted to open `/home/raric/.cache/uv/sdists-v9/.git` in a read-only location; tests were run with existing project `.venv` executables instead.
- `git diff --check`: passed for tracked diff; report has no trailing whitespace. No browser or Playwright/Puppeteer runtime was found by prior Step 7k-30 inspection; no browser was installed or run during this read-only audit.

### CI / runtime gaps

Only `.github/workflows/frontend.yml` exists. It runs frontend quality on frontend/workflow paths with pinned action SHAs and `contents: read`; there are no Go/Python jobs. No GitHub Actions result was retrieved. Local Go loopback restriction and Python Ruff findings mean the project does not currently have a verified all-stack green CI baseline. No hosted container build, migration rehearsal, rollback, SLO, backup restore, cross-browser upload/analysis, or multi-user/load test was run.

## 9. 最小限の残作業と推奨順序

1. **公開範囲を決める（人の判断）。** 静的portfolioのみか、ログイン・音源解析を持つinteractive appか。商用化は対象外でも公開運営/一般利用の許諾確認は必要。
2. **権利ゲート。** Demucs checkpointの公開service inference許諾を権利者/法務等で確定するか、公開版ではその推論を提供しない。各demo音源、派生データ、画像、動画、フォントの出典・許諾表を作る。
3. **限定portfolioなら安全なartifactを決める。** 権利処理済みのsynthetic/authorized素材で作成した説明動画・静止画だけを配信し、build outputを検査。`publicDir` opt-inを使用する場合は含まれる全ファイルを個別承認し、音源・Timeline・metadata/stemの同梱有無を再確認する。
4. **interactiveを選ぶ場合はHosted設計を別L3で承認。** HTTPS/origin/CORS、Hosted Supabase projectとroles/migrations/RLS/Storage、Go API、隔離CPU job/queue、scaleを跨ぐquota、upload retention/deletion、logging/privacy、kill switchとrollbackを設計し、権利問題が解決するまで推論機能はoffにする。
5. **実測ベースのcost model。** Cloud Run job/service、Supabase/Neon、storage/egress、logging/build、OpenAIの呼出回数と外部spend capを利用者数/解析数の複数シナリオで試算。USD→JPY、税、budget alerts/kill手順を含める。課金resource作成は別の明示承認まで行わない。
6. **セキュリティ/運用レビュー。** Patched FFmpeg/base image、lockfile/OS/CVE/license SBOM、CSP/TLS/CORS/CSRF/XSS/session、rate limits、file fuzz/oversize、account deletion、backup/restore、monitoring/incident/rollbackを確認。
7. **CIを整備しHosted前に合格。** Frontendに加えてGo test/vet、Python pytest/mypy/Ruffとdependency auditをCIで回す。現在のE501は対象範囲を決めて解消。GitHub Actionsの実行結果を確認する。
8. **ブラウザ受入れとリリース証跡。** Windows ChromeでMP4音声なし/ありをそれぞれ保存し、ffprobe container/video/audio codec、duration、再生・同期を記録。WebM、Chrome以外、upload/60秒解析、Effect/Region/Project、responsive UI、再読込、error recoveryを対象ブラウザで確認。既に利用者が行ったChrome MP4確認は、その条件と証跡をStep7k-30記録へ反映する。

## 10. 公開前に人間の判断が必要な事項

- 公開するものは「静的ポートフォリオ」か「誰でも音源を解析できるHostedアプリ」か。
- Demucs htdemucs weightsの一般公開サービス利用を許諾する権利者確認をどう得るか。許諾が得られない場合の非Demucs公開範囲。
- Suno生成音源/派生Timeline/MP4の公開許可、提供者との合意、公開素材の選択。
- Login/signupを一般公開するか、招待制か。個人データ・音源の地域、保持期間、削除依頼、Privacy/Terms/Contactの責任者。
- Cloud Projectは引き続き非公開でよいか。保存データとretention/backup責務を誰が負うか。
- OpenAI Blueprint生成を公開するか。API key/project hard capと課金、実送信するSummary/feature情報に対するユーザー通知。
- 予算¥1,000以内の厳密な支出上限に含むもの（domain、tax、egress、backup、AI API、support）。Free tier停止/変更を許容するか。
- サービス地域、運用/障害連絡、データ削除/復旧、公開サイト上の免責・ライセンス表示。

## 11. 調査範囲と対象外

- 参照：`docs/PROJECT_CONTEXT.md`、`docs/DEVELOPMENT_RULES.md`、`docs/CURRENT_STATE.md`、`CURRENT_TASK.md`、`docs/ARCHITECTURE.md`、`docs/DEPLOYMENT.md`、`docs/OPEN_ISSUES.md`、`docs/SECURITY.md`、`docs/COST_MANAGEMENT.md`、`docs/TEST_STRATEGY.md`、Step 7k-30/各種license・runtime報告、Frontend/API/Python設定と実装、CI。
- 料金は2026-11-02に各社公式pricing/limits pageを参照。変動価格でありJPY換算・使用量別の請求値は算出していない。
- 秘密値の出力、外部のプロジェクトAPI実行、Hosted操作、resource作成、公開、ソース/設定の修正、pushは行っていない。
- 変更ファイルは本報告書のみ。
