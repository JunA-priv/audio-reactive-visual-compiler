# Windows 11 + WSL2 環境ガイド

## 状態と安全上の境界

DevelopmentとTestはローカル専用プロファイルです。起動スクリプトは両アプリサーバーを`127.0.0.1`にbindし、リモートAuth/DB接続先を拒否し、起動前にportの競合を確認します。Supabaseの起動・停止は行いません。Testではアプリのプロセスとportを分けていますが、**現在はDevelopmentと既存のローカルSupabase Auth、PostgreSQL、schema、Storageを共有しています**。このrepositoryには分離されたTest用Supabase project/databaseはありません。専用のテストユーザーを使用し、テストで作成した行だけを扱ってください。quota/entitlement連携には、別途承認されたローカルfixtureの準備が必要です。Step 7k-47で使ったDB password/DSNが現在も有効だとは限りません。

Productionは設定形式のチェックリストにすぎません。`production check`はネットワーク要求を送らず、起動、deploy、migration、更新を行いません。Production endpoint、Cloudflare Pages/Cloud Run設定、Hosted Supabase plan/signing設定、quota、secret managerとの接続は未確認です。placeholderのProduction設定は、Git対象外のローカルprofileを運用者が編集し、別途release reviewで承認されるまで意図的に検証失敗します。

## 1. 前提条件

WSL2のUbuntu distribution内に以下をインストール、確認してください。

- Gitと、このrepositoryをWSL filesystem上に置くこと。
- `go.mod`またはproject toolchain設定が求めるGo version。
- `frontend/package.json`が求めるNode.js/npm version（`node >=24.22.2 <25`、`npm >=11.19.1 <12`）。
- Audio Analyzeを有効にする場合のみ、Python Island virtual environment、`ffprobe`、固定SCNet checkpoint。
- 起動スクリプトのhealth/port/process所有確認に使う`curl`、`iproute2`（`ss`）、`setsid`。
- Auth付き処理を行う場合のみ、repository既存のローカルSupabase CLI stack。起動スクリプトはAuth healthを確認しますが、`supabase start`は実行しません。

初期project設定（DBには触れません）：

```bash
cd ~/work/myapp/audio-reactive-visual-compiler
npm --prefix frontend ci
./scripts/arvc.sh setup all
```

`setup`は宛先ファイルが存在しない場合だけtemplateをコピーします。`api/.env`、`frontend/.env.local`、既存environment profileは上書きしません。ローカルコピーのpermissionは600で、Git対象外です。既存ローカルstackのanon/publishable keyを`frontend/.env.local`に設定してください。これは公開されるローカルclient keyであり、`service_role` keyは使わないでください。Testで別のローカルproject keyを使う場合は、Test用keyを`frontend/.env.test.local`に設定します。credentialをcommand、terminal transcript、issue、Gitへ貼り付けないでください。

機能ごとのPython設定は[ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md)、Supabase stackとmigrationの手順は[SUPABASE_SETUP_AND_MIGRATION.md](SUPABASE_SETUP_AND_MIGRATION.md)にあります。この起動スクリプトは、それらの手順を実行しません。

## 2. Profileとendpoint

| Profile | 用途 | Frontend | Go API | Supabase/Auth/DB | 機能の既定値 |
|---|---|---:|---:|---|---|
| Development | 日常開発、HMR、UI作業 | `0.0.0.0:5173`（待受。WindowsからはWSL2 IPで接続） | `127.0.0.1:8080` | 既存ローカルstack：Auth/API `54321`、PostgreSQL `54322`、Studio `54323` | Fixture、AI/Projects無効、専用ローカルquota DSNと承認済みentitlement/control fixtureがあればAudio Analyzeを選択可能 |
| Test | 別プロセスでの統合/E2E/再現試験 | `127.0.0.1:5174`（変更可能） | `127.0.0.1:8081`（変更可能） | 既定では既存のローカルstackを共有 | Fixture、ローカルfixtureを明示設定しない限りAI/Projects/Audio Analyze無効 |
| Production | 将来のHosted設定確認 | 起動しない | 起動しない | Hosted値は未確認のplaceholder | 機能flag無効、checkのみ |

Developmentでは既存のVite proxyを使い、`5173/api`からAPI `8080`へ接続します。Testは`5174/api`を選択したloopback APIへ接続します。profile checkはproxy先の不一致、Hosted Vite API base URL、loopback以外のAPI bind、ローカル以外のSupabase URL/issuer、空でない`PORT`（Go serverが`0.0.0.0:$PORT`でbindするため）を拒否します。Developmentのportは固定です。Vite bind先は`ARVC_VITE_HOST`で設定でき、既定の`0.0.0.0`はWSL2 IP経由のWindowsアクセス用です。Testは常に`127.0.0.1`です。Testのportは`config/environments/test.env`で変更できますが、有効範囲内でDevelopmentと重複せず、APIとFrontendでも異なる値にしてください。使用中のportがあれば安全に失敗し、その所有者を停止しません。

`0.0.0.0`はWSL2内の全ネットワークinterfaceでViteを待ち受けるため、Windowsからの接続だけでなく、WSL2の仮想ネットワークへ到達できる他の端末からも接続可能になる場合があります。これはLAN公開を意図した設定ではありません。信頼できるローカル開発環境でのみ使用し、LANや公開ネットワークに公開しないでください。loopbackだけに戻す場合はGit対象外のDevelopment profileで`ARVC_VITE_HOST=127.0.0.1`にします。Go APIは引き続き`127.0.0.1:8080`に限定されます。

## 3. Environment変数の読み込みと優先順位

対応するprofile fileはGit対象外のローカルファイルです。

- `config/environments/development.env`
- `config/environments/test.env`
- `config/environments/production.env`

Gitで管理するtemplateは対応する`*.env.example`です。形式は単純な`KEY=VALUE`です。profile内容がコードとして実行されないよう、shell展開、`source`、引用符、行末commentは意図的にサポートしていません。

優先順位は次のとおりです。

1. 呼び出し元がexportした変数（最優先。ただし選択profileと安全チェックに整合する必要があります）。
2. 呼び出し元が設定していない変数について、選択した`config/environments/<profile>.env`の値。
3. Go APIでは、process環境にまだない変数だけ、Git対象外の`api/.env`から読み込みます。`api/run-local.sh`はこのfileをshellとして実行せず、process値を上書きしません。
4. Viteではexport済みprocess値がVite dotenv fileより優先されます。Viteは通常のルールに従って`.env.<mode>.local`、`.env.local`などを読み込みます。DevelopmentのVite modeは`development`、Testは`test`です。

実credentialをprofile templateやViteの`VITE_*`変数に置かないでください。管理対象のローカルprofileはOpenAI/project/service-role DSNを無効化し、空にします。Audio Analyzeは、専用ローカルquota DSNと明示承認済みのentitlement/control fixtureを用意するまで既定で無効です。DevelopmentまたはTestで有効にする場合、起動スクリプトが受け付けるのはloopbackのPostgreSQL `127.0.0.1:54322`にある`arvc_audio_analysis` roleと`sslmode=disable`だけです。この確認はentitlementを作成・検証しません。

重要な設定：

| 変数 | 用途 | Development/Testでの規則 |
|---|---|---|
| `ARVC_ENV` | 選択profileの識別 | `development`または`test`と一致すること |
| `ARVC_FRONTEND_PORT` | Vite待受port | Developmentは5173、Testは変更可能 |
| `ARVC_VITE_HOST` | Development Vite待受address | `0.0.0.0`（WSL2 IP接続用）または`127.0.0.1`。Testは常にloopback |
| `API_ADDR` | Go API待受address | loopbackのみ。Developmentは8080、Testは変更可能 |
| `PORT` | container形式のGo bind override | ローカルでは空であること。空でない場合は`0.0.0.0`でbind |
| `ARVC_API_PROXY_TARGET` | Vite `/api`の接続先 | profileのloopback Go APIと一致すること |
| `AUTH_ENV` | JWT信頼mode | `local`。Production checkでは`hosted`が必要 |
| `SUPABASE_URL`、`SUPABASE_ISSUER` | Go Auth/Data API endpointとJWT issuer | loopback。issuerは`${SUPABASE_URL}/auth/v1`と完全一致 |
| `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY` | Frontend Auth endpointと公開key | 対応するVite modeのGit対象外env fileに、ローカルURLとanon keyを設定 |
| `VITE_API_BASE_URL` | 公開APIへの直接接続origin | ローカルでは空。ProductionはHTTPS originが必要 |
| `BLUEPRINT_MODE` | Blueprint生成mode | `fixture`。AI callは行いません |
| `AI_GENERATION_ENABLED`、`PROJECTS_ENABLED` | 任意のAPI機能 | 管理対象profileでは無効 |
| `OPENAI_MODEL`、`OPENAI_API_KEY` | AI modelの許可リストとserver credential | Development/TestではAIを無効にし、keyは空にする。Production secretは承認済みsecret managerへ置く |
| `SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY` | Go APIの公開Supabase client keyと特権server key | launcherはDevelopment/Testでclearする。service-role keyをprofile fileに置かない |
| `AI_FIXTURE_UNLIMITED_LOCAL`、`AI_FIXTURE_UNLIMITED_USER_ID` | ローカルfixture専用の限定quota bypass | 管理対象profileでは無効/空 |
| `SUPABASE_AI_BUDGET_DSN`、`SUPABASE_ASSET_VERIFIER_DSN` | server専用quota/upload-verifier DB role | Development/Testでは空。roleを使い回したりcredentialが有効だと仮定したりしない |
| `AUDIO_ANALYSIS_ENABLED` | Audio Analyze route | 既定は無効。専用loopback quota DSNと承認済みfixtureがある場合だけDevelopment/Testで有効化可能 |
| `SUPABASE_AUDIO_ANALYSIS_DSN` | quota専用role接続 | 既定は空。fixtureを明示的に準備した後でGit対象外ローカルprofileにのみ設定。推測したcredentialを使わない |
| `AUDIO_ANALYSIS_THREADS` | 音声workerのthread数 | API既定値を使用。指定時は1〜16を受け付ける |
| `PYTHON_ISLAND_EXECUTABLE`、`PYTHON_ISLAND_DIRECTORY`、`FFPROBE_EXECUTABLE` | 音声workerの実行設定 | API既定値を使用。Audio Analyzeが有効な場合に検査 |
| `ARVC_SCNET_CHECKPOINT` | 固定checkpoint pathの任意override | 任意。Pythonが固定size/hashを検証し、自動downloadはしない |
| `CORS_ALLOWED_ORIGINS` | Goの完全一致HTTPS CORS許可リスト | ローカルでは空。Production checkではFrontend originと完全一致が必要 |

`api/.env.example`はplaceholderを含むtemplateです。実際の`api/.env`はGit対象外で、この手順では変更していません。

## 4. Windows batchとWSL command

Command Prompt/PowerShellでrepositoryを開き、薄いdispatcherを呼び出します。

```bat
arvc.bat development start
arvc.bat development status
arvc.bat development stop
arvc.bat test start
arvc.bat test status
arvc.bat test stop
arvc.bat production check
```

batch fileは引数をWSL内の`scripts/arvc.sh`へ渡すだけです。environment設定やprocess管理ロジックは含みません。WSLが利用可能で、repository pathを解決できる必要があります。repositoryがWindows mount drive上にある場合や、WSL UNC pathを`wslpath`で変換できない場合は、WSLから同等のcommandを実行してください。

## 5. WSL/Linux command

```bash
./scripts/arvc.sh setup all                  # 存在しないtemplateだけコピー
./scripts/arvc.sh development check          # 設定、ローカルAuth、空きportを確認
./scripts/arvc.sh development start
./scripts/arvc.sh development status
./scripts/arvc.sh development stop

./scripts/arvc.sh test check
./scripts/arvc.sh test start
./scripts/arvc.sh test status
./scripts/arvc.sh test stop

./scripts/arvc.sh production check           # 静的検証のみ
```

APIを先に起動し、両サービスのHTTP health checkが成功してから`start`を成功として報告します。logとPID所有記録はGit対象外の`.run/<profile>/`に置かれます。directory/fileはprivate permissionです。起動途中で失敗した場合、このlauncherが起動したprocess groupだけを停止します。記録済みprocess identity/groupが一致しない場合、stopはkillを拒否します。既存で所有者が分からないlistenerには触れません。`api/run-local.sh`はAPI単体の手動開発用として引き続き利用でき、process環境は一貫して`api/.env`より優先されます。

Developmentで既定設定を使う場合、WSL内で`hostname -I`を実行し、Windowsブラウザから`http://<WSL2-IP>:5173/`を開きます。`http://127.0.0.1:5173`もWSL内のhealth checkとloopbackアクセスに使えます。Testは設定したport（既定`http://127.0.0.1:5174`）を開きます。API healthは`http://127.0.0.1:8080/healthz`または選択したTest API portです。ローカルSupabase Auth healthは`http://127.0.0.1:54321/auth/v1/health`です。launcherは起動前にAuthを確認しますが、Supabase containerは起動しません。

## 6. Testの分離、quota fixture、cleanup

TestではVite/Goのprocess lifecycle、environment profile、log、PID記録、アプリportを分離します。**Auth user、database、Storage、schema、quota tableはDevelopmentと共有します。**共有stackに対して破壊的test、migration、DB reset/seed、広範囲のcleanupを実行しないでください。launcherはこれらを実行しません。

認証付きbrowser/E2Eには、指定されたローカルaccountとそのAuth sessionを使います。Audio Analyzeでは、別のローカルdatabase/projectまたは明示承認済みのローカルentitlement/control fixtureがあることを先に確認します。専用のローカル`arvc_audio_analysis` DSNだけをGit対象外のDevelopmentまたはTest profileに設定し、`AUDIO_ANALYSIS_ENABLED=true`にして、AI/Projectsは無効のままにします。profile validatorはloopback以外のDB endpointを拒否し、Go APIはrequest時にもuser entitlement/quotaを検査します。entitlementの自動設定機能はありません。明示的な許可なくProduction Auth/DB/Storage値や開発者の日常利用accountを代わりに使用しないでください。

test後のcleanup：

1. 対象profileに限って`./scripts/arvc.sh test stop`（または`arvc.bat test stop`）を実行します。
2. `./scripts/arvc.sh test status`でlauncher所有processがhealthyでないことを確認します。`.run/test/*.log`はローカルで確認し、共有する抜粋からtoken、email、filename、credentialをredactします。
3. 別途reviewされたローカルfixture cleanup手順で、test所有のAuth user/asset/rowだけを正確なIDで削除します。tableのtruncateや共有DBのresetはしないでください。
4. 承認済みfixtureを作成していた場合のみ、Audio Analyze controlを無効・上限0に戻し、そのtestのentitlement/usage recordだけを削除します。有効leaseがなく、無関係なrowが変わっていないことを確認します。
5. ローカルprofileはGit対象外のまま保持します。不要になった場合のみ削除してください。Auth/DB/Storageを共有しているため、このcleanupは自動化されていません。

Step 7k-47の最終受け入れでは、ローカルAudio Analyze controlを無効・上限0に戻し、entitlement/usage rowを削除し、test専用API/Vite processを停止しました。当時使ったpassword secret fileは削除済みです。現在のGit対象外`api/.env` DSNは、有効だと仮定せず、API startup checkで検証してください。

## 7. Production設定の確認

Git管理下のexampleを編集せず、Production checklistをコピーします。

```bash
./scripts/arvc.sh setup production
$EDITOR config/environments/production.env
./scripts/arvc.sh production check
```

hosting/Auth担当者が値を確認し、別途release reviewで承認した後に限り、正確なcanonical Hosted Supabase HTTPS URL/issuer、Frontend build用の対応する公開anon/publishable key、公開Frontend HTTPS origin、API HTTPS origin、完全一致するCORS originを設定します。publishable keyはbrowserから見える値です。`service_role`/secret keyを使ってはいけません。checkは設定形式を検証し、Hosted auth modeを要求し、未reviewのAI/Projects/Audio Analyze flag有効化とserver secretのprofile格納を拒否します。実server secretはこのfileではなく、承認済みdeployment secret managerに置きます。現行architectureではCloudflare Pages、Cloud Run、Hosted Supabaseを候補として挙げていますが、Production project ID、domain、plan、signing mode、quota、secret接続先は未確認です。sampleの`YOUR_*` placeholderは意図的に検証失敗します。

このガイドのcommandはdeploy、DB変更、credential rotation、Hosted service更新を行いません。これらの作業には別途承認とProduction release/rollback計画が必要です。ローカルHTTP origin、ローカルissuer、loopback DSN、anon key、quota row、ローカルAPI設定をProductionで再利用しないでください。

## 8. よくある問題

| メッセージ/症状 | 考えられる原因と安全な対応 |
|---|---|
| profileがない | `setup <profile>`を実行します。存在するfileはコピーされません。起動前にGit対象外のローカルfileを確認してください。 |
| Supabase Auth health check失敗 | 既存のローカルSupabase停止/異常、またはURL誤りです。既存stackを別途調査してください。launcherは起動/停止していません。 |
| port使用中 | 既存appの可能性があります。profile `status`を実行してから`ss -ltnp`でlistenerを調べ、所有者不明のprocessはkillしないでください。 |
| profile identityまたはtarget不一致 | shell overrideが選択profileと競合しています。環境変数を解除するか、一致するprofileを選択してください。process環境が優先される仕様です。 |
| Testが8080/5173を使おうとする | Test profileの設定誤り、またはprocess overrideの漏れです。Test専用のloopback portと一致するproxy先に戻してください。 |
| Vite Auth設定なし | Git対象外の`frontend/.env.local`（Development）または`frontend/.env.test.local`（Test）に、対応するローカルURLと公開anon keyを設定してください。 |
| Audio Analyze quota store失敗 | 専用DSN/passwordがない/古い、DB migration/role未設定、またはuser entitlementがない可能性があります。調査目的でrole passwordを再発行したりDB権限を変えたりしないでください。 |
| Audio Analyze modelを利用できない | Python Island venv、`ffprobe`、checkpoint path、固定checkpoint hash、API logを確認します。modelは自動downloadされません。 |
| 起動時にAPI/Vite health check失敗 | 起動したprocessのうち所有が確認できるものだけrollbackされます。対応するGit対象外logを確認してください。launcherはlog全文やenvironment値を表示しません。 |
| `production check`失敗 | 確認済みHTTPS origin/Hosted issuer/CORS値だけを設定します。exampleは意図的に未完成です。確認目的でdeployしないでください。 |
| `.bat`からWSL pathを見つけられない | WSL内でrepository pathに対して`wslpath -u`を実行し、WSL commandを直接使います。path解決失敗時にserviceは起動していません。 |

## 9. Step 7k-49で実施した検証

実行したshell構文検査、profile検証、port/health check、Frontend回帰確認、environment上の制約は[Step 7k-49 report](reports/2026-11-05-step7k-49-environment-profiles.md)に記録されています。静的な`production check`はHosted接続やdeploy準備完了の証拠ではありません。
