# 開発環境構築マニュアル

対象：AI Audio-Reactive Visual Compiler
作成・情報確認日：2026年10月31日
対象環境：Windows 11 / WSL2 Ubuntu / bashまたはzsh
開発先：`/home/raric/work/myapp/audio-reactive-visual-compiler`

## 1. この手順書の状態

本書は公式資料に基づく導入手順と、完了した初期フロント環境の記録である。初期記述には未実行の手順が含まれる。現在の実測は[環境構築報告](reports/2026-10-31-frontend-bootstrap.md)と区別する。

| 区分 | 確認内容 |
|---|---|
| FACT（Codex実測） | WSL2 Linux x86_64で対象リポジトリを読み書き可能 |
| FACT（Codex実測） | Node.js 24.22.2、npm 11.19.1、Codex CLI 0.166.0 |
| FACT（Codex実測） | npm registry ping成功、frontend lock/install/audit成功 |
| FACT（Step 7b実測） | Docker Desktop 4.97.0、Engine 29.9.2、Compose v2.39.1-desktop.1。Supabase CLI stable v2.122.0を`/tmp`へ一時導入 |
| FACT（Step 7b実測） | Local only Port bindingで起動したSupabase Stackの全published portは`127.0.0.1`/`::1`。Auth・PostgreSQL・Data API・Storage healthy。Realtime containerなし |
| DECIDED | 本プロジェクトのNode.jsを24.22.2、npmを11.19.1に固定 |
| DECIDED | パッケージ管理はnpmに統一 |
| FACT | frontendの依存監査は0 vulnerabilities。手順と報告の対象範囲に限る |

Node.js 24.22.2は公式Node.jsアーカイブ掲載のWSL実測版で、同梱npmは11.19.1。本書はNode/npm自体や全システムパッケージの脆弱性不存在を保証しない。

## 2. 導入する順序とバージョン管理

| 段階 | 対象 | バージョン方針 |
|---|---|---|
| 最初に導入 | Git、curl、証明書、ビルド補助 | サポート中Ubuntuの更新済み配布パッケージ。導入版を記録 |
| 最初に導入 | nvm | 公式README掲載の0.40.8。導入手順確認済み、脆弱性監査は未完了 |
| 最初に導入 | Node.js | 24.22.2 LTSを固定。`.nvmrc`と実測一致 |
| Node更新時 | npm | Node同梱版で開始し、実バージョンとアドバイザリ確認後に固定 |
| フロントエンド構築時 | React、React DOM、TypeScript、Vite、React用プラグイン、型定義 | 安定版情報・advisory・engines・peerDependencies確認後に完全固定 |
| 品質基盤構築時 | ESLint、Vitest、TypeScript | frontendへ固定導入済み。PlaywrightはE2Eが必要な段階で評価 |
| コンテナ導入時 | Docker Desktop / Compose | Windows側公式安定版。既存導入の有無を優先確認 |
| API工程 | Go 1.27.3、Echo v5.4.2、Google Gen AI Go SDK v1.77.0 | WSL2で導入・依存取得・test/vet・Fixture起動を確認済み |
| 音響解析工程 | Python、uv、Demucs、PyTorch CPU、torchaudio、FFmpeg | 未選定。互換性と脆弱性を同時に検証して固定 |
| 必要になった時 | GitHub CLI、Google Cloud CLI、Wrangler | 未選定。各公式配布元・更新情報を確認して導入 |
| Step 7bローカル環境 | Supabase CLI v2.122.0 | stable版を`/tmp`へ一時導入。リポジトリのnpm依存には追加しない。Local only bindとAuth/PostgreSQL/Data API/Storageの起動を確認済み |

未選定の数値を「安全な確定版」として記載しない。以降の`VERSION`等は置換必須の例であり、そのまま実行しない。`latest`での自動導入は採用手順に使わない。

## 3. Windows側でWSLを確認

目的：Linux開発環境がWSL2で動作していることを確認する。新規インストールは既存環境には不要。

Windows PowerShellで実行：

```powershell
wsl --version
wsl --list --verbose
```

対象UbuntuのVERSIONが2であることを確認する。WSL自体の更新が必要な場合：

```powershell
wsl --update
```

WSL停止・再起動は他の作業にも影響するため、作業中プロセスを終了してから行う。新規環境はMicrosoft公式のWSL導入手順に従う。

公式：[WSLコマンド](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)

## 4. WSLの基本ツールとGit

ここからは特記がない限りWSLのターミナルで実行する。

```bash
cd /home/raric/work/myapp/audio-reactive-visual-compiler
cat /etc/os-release
uname -m
printf '%s\n' "$SHELL"
git status --short
git remote -v
sudo apt update
apt list --upgradable
sudo apt install git curl ca-certificates build-essential unzip xz-utils
git --version
```

Ubuntuのバージョンとサポート状況を確認する。`apt update`は一覧更新であり、導入済みパッケージすべてを更新する操作ではない。OSのセキュリティ更新はUbuntuの案内に従い、更新内容を確認して適用する。

Gitの用途：ソース管理、差分確認、ブランチ管理。追加環境変数は不要。

コミットの名前・メールを確認する。未設定の場合にのみ、自分の値でリポジトリ単位に設定する。

```bash
git config user.name
git config user.email
# 未設定の場合の例：自分の値に置換する
# git config --local user.name 'Your Name'
# git config --local user.email 'YOUR_GITHUB_NOREPLY_ADDRESS'
```

動作確認：`git status`が成功し、remoteが対象リポジトリを指すこと。公開リポジトリのcloneに認証は不要だが、pushには認証が必要。

## 5. nvm・Node.js・npm

目的：WSL内のNodeを切り替え、他プロジェクトへの影響を抑える。React等はNodeの実行環境とは別にプロジェクト内へ導入する。

### 5.1 現在の管理方法を確認

```bash
type -a node npm
command -v nvm
command -v fnm
command -v volta
```

fnmやVoltaで管理済みなら、その管理ツールで24.22.2を導入する。複数の管理ツールを重ねて導入しない。nvmが既にある場合は次の新規導入を省略できる。

### 5.2 nvmがない場合

公式タグに固定したスクリプトをダウンロードして内容を確認する。

```bash
mkdir -p /tmp/arvc-setup
curl --fail --location \
  https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh \
  --output /tmp/arvc-setup/nvm-install.sh
less /tmp/arvc-setup/nvm-install.sh
bash /tmp/arvc-setup/nvm-install.sh
```

新しいWSLターミナルを開き、`command -v nvm`で確認する。bashは通常`~/.bashrc`、zshは通常`~/.zshrc`を読み込む。読み込まれない場合はnvm公式の初期化設定を確認する。カスタムのNVM_DIR/XDG_CONFIG_HOMEがある環境では既存設定を維持する。

公式：[nvm導入・シェル設定](https://github.com/nvm-sh/nvm)

### 5.3 Nodeを導入

```bash
cd /home/raric/work/myapp/audio-reactive-visual-compiler
nvm install 24.22.2
nvm use 24.22.2
node --version
npm --version
node -p 'process.platform + " " + process.execPath'
```

期待値：Nodeは`v24.22.2`、platformは`linux`。Windows側の`node.exe`や`/mnt/c/`配下の実行ファイルを使っていないこと。

`.nvmrc`が既にある場合は内容を確認し、矛盾を解決してから変更する。新規作成時：

```bash
printf '24.22.2\n' > .nvmrc
nvm use
```

プロジェクト切り替え時は`nvm use`。他プロジェクトも変える`nvm alias default`は今回必須にしない。`sudo npm install`、npmの無条件なグローバル更新は行わない。

npmの同梱版は`npm --version`で記録し、公式更新履歴・セキュリティ情報を照合して採用する。npm自身の安全性は、アプリ側の`npm audit`だけでは確認できない。

公式：[Node 24.22.2](https://nodejs.org/en/download/archive/v24.22.2)、[2026年10月セキュリティ更新](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)、[npm更新履歴](https://github.com/npm/cli/releases)

## 6. フロントエンド依存の選定と導入

目的：ReactでUI、TypeScriptで型検査、Viteで開発サーバーとビルドを提供する。APIキーは不要。

frontendは作成済み。Windows側のひな形やnode_modulesをコピーせず、WSL内でlockに従って`npm ci`を使う。

### 6.1 導入前に情報を取得

```bash
npm config get registry
npm view create-vite dist-tags --json
npm view react dist-tags --json
npm view react-dom dist-tags --json
npm view typescript dist-tags --json
npm view vite dist-tags --json
npm view @vitejs/plugin-react dist-tags --json
```

registryは通常`https://registry.npmjs.org/`。組織ミラーを使う場合はその管理方針を確認する。dist-tagの最新値は参考情報であり、採用決定ではない。beta、rc、canary、nextを避け、正式版の公開日と公式リリースを確認する。2026年10月31日より後に本書を使う場合、取得情報は実行日現在なので確認日を更新する。

候補ごとに`npm view パッケージ名@完全な版番号 engines peerDependencies dependencies dist.integrity --json`で互換性と配布情報を確認し、公式security/advisoriesと照合する。

確認先：

- [React公式バージョン](https://react.dev/versions) / [Reactセキュリティ情報](https://github.com/facebook/react/security/advisories)
- [Vite導入手順](https://vite.dev/guide/) / [Viteセキュリティ情報](https://github.com/vitejs/vite/security/advisories)
- [TypeScriptリリース](https://github.com/microsoft/TypeScript/releases)
- [npm公式セキュリティ情報](https://github.com/npm/cli/security/advisories)

### 6.2 新規初期化（版番号確定後のみ）

以下は手順の書式。`APPROVED_CREATE_VITE_VERSION`を承認した数値へ置換する。frontendが既存なら初期化せず、そのpackage.jsonとlockを調査する。

```bash
npm create vite@APPROVED_CREATE_VITE_VERSION frontend -- --template react-ts
cd frontend
cat package.json
```

生成された依存をそのままインストールせず、React/React DOMを同じ版でそろえ、型定義・プラグイン・TypeScript・Viteの互換性を確認する。各依存を完全な版番号に変更する。Lintもテンプレート任せにせず選定する。

今後の追加依存を完全固定するため、frontend/.npmrcには`save-exact=true`を設定する。ただし既存のpackage.jsonの範囲指定は自動では変わらない。

```bash
npm install --package-lock-only --ignore-scripts
npm audit --json
```

この段階で脆弱性と依存ツリーをレビューする。必要なインストールスクリプトも確認後、通常の導入と検証へ進む。

```bash
npm ci
npm ls --depth=0
npm audit
npm run build
npm run lint
npm run dev -- --host 127.0.0.1
```

Windowsブラウザから表示された`http://localhost:5173`等を開く。ポートは実際の表示に従う。停止はCtrl+C。`0.0.0.0`への公開は通常不要。

テスト・型検査・Formatterは実装時にスクリプトを追加してから実行する。`npm run`で存在を確認し、未作成の`npm test`成功を前提にしない。

### 6.3 以後の再構築

package.jsonとpackage-lock.jsonを一緒に管理し、clone後は`npm ci`を使う。auditが非ゼロの場合はアドバイザリ、経路、到達可能性、修正版を記録する。高・重大を原則解消し、中・低も確認して対応する。`npm audit fix --force`で互換性を無視した一括更新をしない。

公式：[npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/)

## 7. Docker Desktop・Compose（後続工程）

目的：Go API、解析処理、ローカルDB等をコンテナで起動する。固定サンプルのCanvas開発には必須ではない。

WindowsにDocker Desktopがある場合は起動し、SettingsでWSL2バックエンドと、使用するUbuntuへのWSL Integrationを有効にする。未導入なら公式Windowsインストーラーを利用する。更新履歴とセキュリティ情報を確認し、選んだDesktop版と内蔵Engine/Compose版を記録する。WSL内へ別のDocker Engineを重ねて導入しない。

WSLで確認：

```bash
docker version
docker compose version
docker info
```

`docker info`がサーバー情報を返すこと。小さな試験コンテナはレビュー済みイメージのdigestを指定して実行する。compose.yaml作成後に`docker compose config`で構文確認する。まだ存在しないcompose.yamlを起動しない。

環境変数：通常不要。接続不良時はDesktop起動、WSL Integration、`docker context ls`、意図しないDOCKER_HOST設定を確認する。

公式：[Docker WSL2](https://docs.docker.com/desktop/features/wsl/)

## 8. Go・Echo（ローカルAPI）

### 8.1 確認済み環境

WSL2 Ubuntu 24.04、`uname -m`=`x86_64`（Goの`amd64`に対応）。Go 1.27.3 Linux AMD64を`/usr/local/go`へ導入し、`api/go.mod`のEcho v5.4.2とGoogle Gen AI Go SDK v1.77.0を維持する。Go公式Download表の該当archive SHA-256は`65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40`。

公式：[Go Downloads](https://go.dev/dl/)、[Linux install](https://go.dev/doc/install)。Go 1.27.3の版・配布archive・checksumはGo Downloadsで確認し、別バージョンを使う場合は実行時点の公式表で再照合する。

### 8.2 初回インストール手順

まずUbuntuとCPU architectureを確認する。`uname -m`が`x86_64`でなければ下記AMD64 archiveは使用せず、公式Download表から対応するLinux archiveとSHA-256を選ぶ。

```bash
uname -m
```

公式Go配布元からarchiveを取得し、展開前にSHA-256を照合する。

```bash
cd /tmp
curl --fail --location --output go1.27.3.linux-amd64.tar.gz \
  https://go.dev/dl/go1.27.3.linux-amd64.tar.gz
printf '%s  %s\n' \
  '65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40' \
  'go1.27.3.linux-amd64.tar.gz' | sha256sum --check --strict
```

checksum検証成功後、`/usr/local/go`の既存状態を確認する。既存Goを置き換える場合は、公式手順に従って既存treeを削除してから展開する。既存treeへ重ねて展開しない。sudoはこのシステム領域への操作に限る。

```bash
ls -ld /usr/local/go 2>/dev/null || true
# 新規導入で /usr/local/go が存在しない場合:
sudo tar -C /usr/local -xzf /tmp/go1.27.3.linux-amd64.tar.gz
```

zshではGo binを`~/.zshrc`のPATHへ追加する。

```bash
cat >> ~/.zshrc <<'EOF'
export PATH="/usr/local/go/bin:$PATH"
EOF
source ~/.zshrc
go version
command -v go
go env GOOS GOARCH
```

確認値は`go version go1.27.3 linux/amd64`、`/usr/local/go/bin/go`、`linux amd64`。zsh以外を利用する場合はそのshellの起動設定へ同じPATH entryを設定する。

### 8.3 依存取得・テスト

```bash
cd /home/raric/work/myapp/audio-reactive-visual-compiler/api
go mod download
go test ./...
go vet ./...
```

この環境では3コマンドすべて成功済み。`go.mod`/`go.sum`の依存やGo/Echo/SDKのバージョンは環境構築時に変更しない。

### 8.4 `.env`とFixture APIの起動

```bash
cd /home/raric/work/myapp/audio-reactive-visual-compiler/api
cp -n .env.example .env
git check-ignore -v .env
git check-ignore .env.example
```

`api/.env.example`の既定`BLUEPRINT_MODE=fixture`、`AI_GENERATION_ENABLED=false`を使う。`api/.env`はローカル設定ファイルとしてGit ignoreされ、`.env.example`は管理対象。キー値を表示したり、ターミナル記録・報告へ貼り付けたりしない。`run-local.sh`はplain `KEY=VALUE`行を値のshell評価なしで読み込む。第三者由来の`.env`を実行しない。

Fixture APIを起動し、別のWSLターミナルからhealth endpointを確認する。

```bash
cd /home/raric/work/myapp/audio-reactive-visual-compiler/api
bash ./run-local.sh
```

```bash
curl -i http://127.0.0.1:8080/healthz
```

期待値はHTTP 200と`{"status":"ok"}`。APIは`127.0.0.1:8080`で待ち受ける。Fixture modeはOpenAIへ接続せず、APIキーも不要。公開デモは`/demo`で固定合成WAV・既存Timeline/Blueprintを再生し、Go API・Auth・Cloud・AI providerへ通信しない。`/app`はSupabase session確認後にEditorを表示する。

#### `/app`のローカル音源解析（任意）

Step 7jの解析APIは既定で無効。ローカルSupabase Authが起動し、Python Islandの既存`.venv`とDemucs重みが利用可能な場合だけ、`api/.env`に以下の設定を加える。relative pathは`api/run-local.sh`が`api/`へ移動した後に解決される。

```dotenv
AUDIO_ANALYSIS_ENABLED=true
PYTHON_ISLAND_EXECUTABLE=../python-island/.venv/bin/python-island
PYTHON_ISLAND_DIRECTORY=../python-island
FFPROBE_EXECUTABLE=ffprobe
```

その後`bash ./run-local.sh`で起動する。`AUDIO_ANALYSIS_ENABLED=true`をコマンド環境変数で渡す場合もrun-local.shはこの明示overrideを維持する。解析routeはlocal SupabaseのJWTを必須とする。ブラウザーは最大60秒のPCM16 WAV選択clipだけを`POST /api/v1/audio/analyze`へ送る。上限はmultipart request全体16 MiB、global同時実行1件、600秒。解析処理はローカルCPUを使い、Stemや音源を外部AIへ送らない。完了後、Editorへ入るのはcrop clipと0ms起点のTimelineであり、Project保存/WebMも同じclipを使う。`/demo`はこのAPIを呼ばない。

解析を有効にしない場合は`AUDIO_ANALYSIS_ENABLED=false`のままにする。Hosted公開・外部bindにこのローカルCPU endpointを使わない。実音源の投入前に利用権とDemucs重みの利用条件を確認する。

#### AI生成APIのローカルFixture検証

Migration 016・017適用済みのlocal Supabase、専用`arvc_ai_budget` role、DSN設定がある場合だけ、Fixture生成routeの認証・資格・利用枠を確認できる。OpenAI外部APIは使わない。既定は停止である。

```bash
cd /home/raric/work/myapp/audio-reactive-visual-compiler/api
BLUEPRINT_MODE=fixture AI_GENERATION_ENABLED=true PROJECTS_ENABLED=false bash ./run-local.sh
```

Fixture endpointも有効JWT、DB entitlement、Idempotency-Keyと利用枠予約が必要。資格なしは403、quota/concurrencyは429、DB/全体停止は503、使用済みIdempotency-Keyは409。暫定初期値（user 2/day・10/month、service 5/day・20/month、input 8,000 tokens、output 4,000 tokens、global concurrency 2/user 1、推定$1.50/month）はローカル検証用で、公開時の課金保証ではない。`AI_GENERATION_ENABLED=true`と`BLUEPRINT_MODE=openai`を同時に使うと実外部API requestが起こり得るため、別途明示許可なしに設定しない。`SUPABASE_AI_BUDGET_DSN`はloopback専用server-side secretであり、Frontendへ渡さない。

#### ローカル開発者のFixture制限免除（任意）

Step 7g-3では、local Authの開発者UUIDだけにFixture専用の制限免除を追加した。`api/.env`で`AI_FIXTURE_UNLIMITED_LOCAL=true`と`AI_FIXTURE_UNLIMITED_USER_ID=<local Auth UUID>`を設定すると、そのUUIDのFixture予約は既存の日次/月次request、共有費用、user/global concurrency集計を消費しない。Migration 016にユーザー別・全体累積token予算はなく、既存の入出力token上限はリクエスト単位の上限なので変更しない。`AI_GENERATION_ENABLED=true`と有効なDB entitlementは依然必須。JWT subject一致、入力上限、Blueprint検証、Idempotency-Key、DB kill switchも維持する。ローカル開発者entitlementの`expires_at`はlocal DBでNULLに設定して継続利用可能にしているが、enabled状態の資格確認は毎回行われる。

特例は`BLUEPRINT_MODE=fixture`・loopback API/Authの構成でのみ起動でき、OpenAI modeへ特例設定を持ち込むとGo APIは起動を拒否する。Hosted環境ではloopback制約により使用できない。`.env.example`の既定値は無効・空欄であり、通常ユーザーとOpenAI modeには通常枠を適用する。無効化するには`AI_FIXTURE_UNLIMITED_LOCAL=false`にしてUUID値を削除する。Fixtureの重複防止ledgerは保持されるため、公開向けの濫用防止機能ではない。

### 8.5 Vite Proxy確認

APIを起動したまま別ターミナルでFrontendを起動する。

```bash
cd /home/raric/work/myapp/audio-reactive-visual-compiler/frontend
npm run dev
```

Viteは`/api`を`http://127.0.0.1:8080`へproxyする。ブラウザで表示されたVite originからVisual Editorの**Load API Blueprint**を実行し、Fixture Blueprintが取り込まれることを確認する。実装済み環境では`http://127.0.0.1:5173/api/v1/blueprints/generate`へリクエストされる。Frontend経由でAPI機能を確認し、ブラウザから直接8080へ接続できるかどうかと混同しない。

### 8.5.1 ローカルProject CRUD

Project CRUDはローカルSupabase AuthとData APIを使う。APIの既定は無効。ローカル環境でmigrationを適用済みの場合のみ、`api/.env`で`PROJECTS_ENABLED=true`にする。`SUPABASE_URL`, `SUPABASE_ISSUER`, `SUPABASE_ANON_KEY`はローカル値を設定し、service_role keyをGo APIへ渡さない。値をshell history・ログ・報告へ貼らない。

```bash
cd /home/raric/work/myapp/audio-reactive-visual-compiler/api
```

**Step 7b migration適用は管理者handoffが必要：** 新規local Supabaseの`supabase/config.toml`で`[db.migrations].enabled = false`として起動し、CLIの初期migration失敗でstackが自動停止するのを避ける。起動後は`supabase migration up --local`を手動実行する。001–004は通常runnerで成功し、005はsupabase_admin grantorのrole membershipをrevokeできず停止する。005を対象local containerへschema-owner接続で適用しrepairした後、通常runnerを再開する。006成功後の007も、helper roleへのADMIN optionがなく通常runnerでは失敗する。

以下のcontainer名は実際の`supabase_db_<local-project-id>`に置き換える。既存Stackではなく、対象project ID・port・volumeを確認した新規local Stackだけに実行する。

```bash
docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d postgres --single-transaction -v ON_ERROR_STOP=1 < supabase/migrations/20261101000500_step7b_project_role_grant_cleanup.sql
supabase migration repair 20261101000500 --status applied --local
supabase migration up --local  # 006まで適用し007で停止
{
  printf '%s\n' 'GRANT CREATE ON SCHEMA public TO arvc_project_writer;'
  cat supabase/migrations/20261101000700_step7b_project_rpc_claim_scope.sql
  printf '%s\n' 'REVOKE CREATE ON SCHEMA public FROM arvc_project_writer;'
} | docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d postgres --single-transaction -v ON_ERROR_STOP=1
supabase migration repair 20261101000700 --status applied --local
supabase migration up --local  # 008を適用
```

`DB_CONTAINER`は事前確認した使い捨て/新規local projectの`supabase_db_<local-project-id>`を設定する。SQL失敗時は`--single-transaction`でrole/schema/policy/function変更がrollbackされる想定をカタログで照合する。SQL成功後のみmigration repairし、repairが失敗したらmigration SQLを再実行せずledgerと実体を照合する。migration repairはlocal履歴記録だけでSQLを実行しない。Hosted URLを使わず、DB reset、`--all`、既存volume削除は行わない。最終権限確認には[read-only verification SQL](../supabase/verification/step7b-privilege-invariants.sql)を使う。責務分離、方式比較、停止・復旧条件は[Step 7b-2設計報告](reports/2026-11-01-step7b-2-migration-admin-bootstrap-design.md)と[Migration再現性報告](reports/2026-11-01-step7b-1-migration-reproducibility.md)を参照。Migration SQLは変更していない。

Auth発行ユーザーを使う実統合試験は、認証情報をプロセス環境内だけで渡して実行する。試験用user/projectは終了時に削除される。`api/internal/projects`の通常テストは環境変数なしならlocal integration testをskipする。

```bash
cd /home/raric/work/myapp/audio-reactive-visual-compiler/api
go test ./...
go vet ./...
```

Go APIの5 Project endpointは[API契約](API_CONTRACTS.md#step-7b-ローカルproject-apiこの範囲のみdecided)を参照。音源や背景画像を含むProjectは現時点で拒否し、素材保存・Frontend cloud UIは後続Stepの対象。

### 8.6 よくあるGo/API接続エラー

| 症状 | 原因と対処 |
|---|---|
| `permission denied` | Go archiveの検証、`/usr/local/go`の所有権と実行bit、PATHの参照先を確認する。`sudo go`で回避せず、破損・誤った展開先なら公式archiveからやり直す。 |
| `go: not found` / `command not found: go` | 新しいzshを開くか`source ~/.zshrc`し、`printf '%s\n' "$PATH"`と`command -v go`を確認。`/usr/local/go/bin`をPATHへ追加する。 |
| `curl: (7) ... ECONNREFUSED` | APIが起動していない、異常終了した、または別port/addressを使用している。API terminalのエラーと`API_ADDR`を確認し、loopbackの8080でFixture mode起動後に再確認する。 |
| ViteからAPI requestが失敗 | APIとVite双方の起動状態、Vite起動port、`frontend/vite.config.ts`の`/api` proxy先`127.0.0.1:8080`を確認する。APIを先に起動してからBrowser操作を再試行する。 |
| `address already in use` | 既に8080を利用するAPI processがある。重複起動せず、そのprocessを確認してから利用する。 |

`api/run-local.sh`は作業ツリー上のmode 755。現時点ではAPI一式が未追跡のため`git ls-files -s`のindex entryはなく、Gitへ追加するときは実行可能fileとして100755で記録される。Fixture起動ではOpenAI実API requestを発生させない。OpenAI modeへの変更は明示許可がある別作業に限る。

## 9. Python Island・uv・Demucs・PyTorch CPU・FFmpeg

FACT（2026-10-31）：WSL Ubuntu 24.04.3 / x86_64、uv 0.8.12、Python 3.14.10、PyTorch 2.14.1+cpu、Demucs 4.1.0、NumPy 2.3.4を採用。Python standaloneはAstral python-build-standalone release `20261026`からSHA256検証して`python-island/.python`へ展開し、`uv.lock`で全Python依存を固定する。開発用固定版はpytest 9.0.3、Ruff 0.14.4、mypy 1.18.2、pip-audit 2.9.0。Demucs 4.1.0を選択した理由は旧版のTorch/torchaudio制約を避け、現在のPython/TorchでCPU推論できることを実測したため。torchaudioと別の音響抽出依存は不要。

```bash
cd python-island
uv --version  # 0.8.12
./scripts/setup.sh
uv run --locked python --version
uv run --locked python -c 'import torch, demucs, numpy; print(torch.__version__, demucs.__version__, numpy.__version__, torch.cuda.is_available())'
uv run --locked ruff check src tests
uv run --locked mypy
uv run --locked pytest -m 'not integration'
uv run --locked pip-audit --cache-dir .pip-audit-cache
```

`setup.sh`は検証済みPython archiveのSHA256を照合し、プロジェクト内`.venv`へ依存を同期する。uvは0.8.12を使用する。CPU版Torchは`download.pytorch.org/whl/cpu` indexからのみ解決する。`uv.lock`にある全dependencyは固定版。

FFmpeg/ffprobeは外部実行ファイルでありPython lockには含まれない。今回の測定環境はUbuntu package `7:6.1.1-3ubuntu5`。Ubuntu 24.04向けsecurity noticesの更新版はUbuntu Pro ESM提供と記載され、この環境には更新候補がない。よってこのFFmpeg版を安全な任意メディア処理依存として承認していない。信頼できない入力/本番用途の前に、保守された修正版を選定し、版・取得元・署名を検証して固定する必要がある。system FFmpegを無断で置換・installしない。

CLIは音源を外部送信せず、ローカルMP3/WAVを検査し、`uv run --locked python-island /absolute/path/input.wav --output-dir ./output --threads 4`でTimeline、Summary、metadataを出力する。既定上限は4分、512MiB。実測4分合成音源はDemucs分離119.223秒、特徴量2.000秒、total122.798秒、peak RSS 1,698.7MiB（16 logical CPU中4 thread）。詳細と制限は[Python Island報告](reports/2026-10-31-python-island.md)。

モデルcheckpointは公式Demucs配布元`https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th`、84,141,911 bytes、SHA256 `8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4`。今回ファイルを新規downloadせず、hash検証済み既存cacheから読み込んだ。Demucs maintainer説明ではweightはMIT license対象外でscientific purposesのみ。商用/公開用途は未許諾として扱う。

公式：[Python 3.14.10](https://www.python.org/downloads/release/python-31410/)、[Astral standalone release](https://github.com/astral-sh/python-build-standalone/releases/tag/20261026)、[uv](https://docs.astral.sh/uv/)、[PyTorch](https://pytorch.org/get-started/previous-versions/)、[Demucs](https://github.com/adefossez/demucs)、[Demucs weight license explanation](https://github.com/facebookresearch/demucs/issues/327)、[Ubuntu FFmpeg advisory](https://ubuntu.com/security/notices/USN-8671-1)。

## 10. GitHub CLI（必要時）

目的：認証、PR操作、CI結果の確認。clone済みなので初回フロント開発には必須でない。

公式Linux手順の署名付きaptリポジトリを登録し、候補版・更新内容を確認後、固定版で導入する。Ubuntu標準パッケージの版が古い場合は、そのまま安全な最新版とみなさない。

```bash
apt-cache policy gh
# 公式リポジトリ登録・版選定後：sudo apt install gh=選定したapt版番号
gh --version
gh auth login --hostname github.com --web
gh auth status
```

認証トークンはチャットやGitへ貼らない。通常はGH_TOKENの手動設定不要。認証だけでリポジトリ変更やpushは発生しない。

公式：[GitHub CLI Linux導入](https://github.com/cli/cli/blob/trunk/docs/install_linux.md)

## 11. クラウドCLI（公開工程まで導入不要）

### Google Cloud CLI

目的：Cloud Run Services/Jobsの管理。公式Linux手順の署名付きaptリポジトリを登録し、`apt-cache policy google-cloud-cli`で版を確認後、`sudo apt install google-cloud-cli=選定したapt版番号`で導入する。

検証は`gcloud version`。認証が必要になってから`gcloud auth login`。ローカルAPIがADCを利用する設計の場合のみ`gcloud auth application-default login`を行う。CLI認証とADCは別。Secret JSONはGitへ保存しない。プロジェクト作成、課金紐付け、API有効化、deployは本書の環境構築に含めない。

公式：[Google Cloud CLI](https://docs.cloud.google.com/sdk/docs/install-sdk)

### Supabase CLI

目的：ローカルAuth/PostgreSQL/Data API/Storage検証。Docker Desktop WSL integrationが必要。2026-10-31にGitHub Releasesのstable `v2.122.0`を確認し、アプリの依存関係を変更しないため一時directoryへ固定導入した。v3 betaではなくstableを使う。

```bash
npm install --prefix /tmp/arvc-supabase-cli-2.122.0 --no-save --no-package-lock supabase@2.122.0
/tmp/arvc-supabase-cli-2.122.0/node_modules/.bin/supabase --version
```

`supabase init`は新規ローカル設定が必要な場合だけ実施する。`supabase/config.toml`は追跡可能な設定、`supabase/.temp`はCLIの一時状態で、後者は`supabase/.gitignore`で除外する。Hosted Supabaseへの`login`/`link`/`db push`はローカル環境構築では行わない。

### ローカルSupabase Stack（Step 7b）

Docker Desktop WSL integration、Engine、Composeを確認する。Supabase公式資料は、公開ネットワーク上で使う場合、Docker bridgeを`127.0.0.1`へbindし、そのnetworkを`supabase start --network-id`へ渡す方法を案内している。

```bash
# 以下はDocker DesktopのPort binding behaviorがLocal onlyであり、
# 専用networkのHostIP省略probeがloopback限定であることを確認した環境で実行する。
docker info --format '{{.ServerVersion}}|{{.MemTotal}}'
docker compose version
docker network create --driver bridge \
  --opt com.docker.network.bridge.host_binding_ipv4=127.0.0.1 \
  arvc-supabase-loopback
/tmp/arvc-supabase-cli-2.122.0/node_modules/.bin/supabase init
/tmp/arvc-supabase-cli-2.122.0/node_modules/.bin/supabase start \
  --network-id arvc-supabase-loopback \
  --exclude studio,realtime,imgproxy,postgres-meta,edge-runtime,logflare,vector,supavisor
docker ps --format '{{.Names}}|{{.Status}}|{{.Ports}}'
docker stats --no-stream --format '{{.Name}}|{{.MemUsage}}'
```

**この環境での注意：** Docker Desktop 4.97.0のPort binding behaviorをLocal onlyに設定後、Supabase Stackの全published portは`127.0.0.1`および`::1`に限定されることを確認した。Step 7bでは`[realtime] enabled = false`と`--exclude realtime`を併用して起動し、Auth・PostgreSQL・Data API・Storageのhealthを確認した。起動直後に`docker ps`だけでなく`docker inspect`の`NetworkSettings.Ports`を確認する。`0.0.0.0`または`[::]`ならサービス確認を続けず、対象workdirから`supabase stop`（`--all`/`--no-backup`なし）を実行する。停止はvolumeを保持する。既存の別プロジェクトcontainer/volumeを止めたり削除したりしない。

Docker Desktopが利用可能なmemoryは約7.38 GiB。今回の起動では`--exclude realtime`のみ指定したため、Studio、Edge Runtime、analytics等も起動し、約4分後のcontainer合計は約1.62 GiBだった。Supabase CLIの全サービス起動推奨7 GBに対して余裕は限定的なので、不要サービスは公式`--exclude`で除外する。Realtimeについては`supabase/config.toml`の`[realtime] enabled = false`も設定し、起動時に`--exclude realtime`を併用する。設定後のTOMLを確認し、起動後にRealtime containerが存在しないことを確認する。

Step 7b実測：PostgreSQL `54322`、Kong API `54321`、Studio `54323`、Mailpit `54324`、Analytics `54327`のpublished portはすべて`127.0.0.1`と`::1`のみ。Auth `/auth/v1/health`、Data API `/rest/v1/`、Storage `/storage/v1/status`はHTTP 200、PostgreSQLは`pg_isready`でaccepting connections。起動中のRealtime containerなし。全対象containerの`OOMKilled=false`、restart count 0。Tunescout container状態と既存volumeは維持されたが、Edge Runtime用named volumeが新規作成された。詳細は[Step 7b起動検証報告](reports/2026-11-01-step7b-supabase-local-start-validation.md)。

ローカルAuthをVite dev serverから使う設定では`supabase/config.toml`の`auth.site_url`と`auth.additional_redirect_urls`を`http://127.0.0.1:5173`へ合わせる。Auth emailはlocal Mailpitで受け、外部へ送信しない。CLIのstart/status出力にローカルAPI keyやDB接続情報が含まれることがある。報告書、shell history、Gitへ貼り付けない。認証情報を必要としない検証はHTTP health routeやcontainer healthのみを使い、key値を出力しない。

正常に起動できた後の停止:

```bash
/tmp/arvc-supabase-cli-2.122.0/node_modules/.bin/supabase stop
```

`--no-backup`はvolume dataを削除するため使用しない。`--all`は他のlocal Supabase projectにも影響するため使用しない。既存Docker volume削除コマンドも実行しない。

公式：[Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)
公式：[Local development / loopback Docker network](https://supabase.com/docs/guides/local-development)、[CLI releases](https://github.com/supabase/cli/releases/latest)、[CLI config](https://supabase.com/docs/guides/local-development/cli/config)

### Wrangler

目的：Cloudflare Pages/R2関連操作。公開工程で固定版をプロジェクトローカルへ追加する。

```bash
# 選定した版へ置換：npm install --save-dev --save-exact wrangler@VERSION
npx --no-install wrangler --version
```

Cloudflareへのlogin・deploy・R2作成は公開計画と費用確認後に行う。CLOUDFLARE_API_TOKENは公開フロントへ埋め込まない。

公式：[Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

## 12. 品質ツールと記録

フロント：TypeScript、Lint、Formatter、Vitestを候補とし、E2Eが必要な段階でPlaywrightを追加する。すべて版を選定してdevDependenciesへ固定する。Goはgofmt/go vet/go test/govulncheck、Pythonはpytest/Ruff/型検査/依存監査を工程に合わせて選定する。

CIでは通常テストとデプロイを分離し、通常テストへ本番Secretを渡さない。Actionsの参照もレビューしたコミットSHAへ固定する。

`docs/reports/`に以下を残す。認証情報や環境変数の全一覧は収集しない。

| 記録項目 | 記入例・内容 |
|---|---|
| 確認日・環境 | 日付、Ubuntu版、CPUアーキテクチャ |
| 版・固定場所 | 実バージョン、.nvmrc/package-lock/go.mod/uv.lock等 |
| 選定根拠 | 公式URL、安定版・サポート状況 |
| 脆弱性確認 | advisory/CVE、影響範囲、修正版、監査結果 |
| 動作結果 | 実行コマンド、終了結果、ブラウザでの確認 |
| 制約 | 未検証、保留、互換性問題、対応予定 |

## 13. よくある問題

| 症状 | 確認・対処 |
|---|---|
| nvmが見つからない | シェルの設定ファイルと初期化行を確認。新規ターミナルを開く |
| Nodeの版が戻る | リポジトリ直下でnvm use。Windows Nodeや別管理ツールが優先されていないか確認 |
| npmでEACCES | sudoで回避せず、npmキャッシュや作業先の所有者を確認。共有ディレクトリを一括chownしない |
| lockとpackage.jsonが不一致 | 変更理由を確認してlockを更新。npm ciをnpm installに置き換えて隠さない |
| ViteをWindowsから開けない | WSL内の起動ログ、実ポート、localhost転送、ファイアウォールを確認 |
| Dockerへ接続できない | Desktop起動・WSL Integration・contextを確認 |
| DNS/証明書エラー | VPN、プロキシ、WSLの名前解決、時刻、CAを確認。TLS検証を無効にしない |
| Python externally-managed-environment | uv管理の仮想環境を使用。システムPythonの保護を解除しない |

## 14. 初回環境構築の完了条件

- WSL2/Ubuntuの版と実際のシェルが記録されている。
- 対象リポジトリでGit操作ができる。
- WSLのNode 24.22.2とnpm 11.19.1が記録されている。
- フロントの依存版・互換性・既知の脆弱性確認が完了している。
- npm ci、ビルド、Lint、追加した型検査・テストが成功している。
- Windowsブラウザから開発画面を表示できる。
- 成功した項目のみFACTとして記録されている。

## 15. 現行AI provider：OpenAI Responses API（ローカル・未疎通）

`.env.example`を`api/.env`へコピーする。Fixtureが既定で、外部通信しない。実OpenAI modeを起動する場合は別途明示許可を得た上で、サーバー環境に`OPENAI_API_KEY`、`OPENAI_MODEL=gpt-6-luna`、`AI_GENERATION_ENABLED=true`、`BLUEPRINT_MODE=openai`を設定する。キーはFrontend/VITE変数に置かず、表示・ログ出力しない。本移行作業では実APIを呼ばず、料金設定・外部送信も行っていない。

AI budget DBではMigration 018をlocal Supabaseに適用済みで、model/pricing rowは`gpt-6-luna`になっている。既存quota・usage・entitlementは維持した。Hosted Supabaseには適用しない。適用とFixture検証は[Step 7i-1報告](reports/2026-11-01-step7i-1-openai-budget-migration.md)、provider実装と料金根拠は[Step 7i報告](reports/2026-11-01-openai-gpt-6-luna-provider-migration.md)を参照する。

旧Step 5 Gemini手順は履歴参照専用であり、Geminiを起動する操作として使用しない。

Go導入、Fixture起動、Vite Proxyは前掲「8. Go・Echo（ローカルAPI）」を参照する。

過去Step 5時点のGemini環境設定は廃止済みで、現在のAPIでは使用できない。Fixture実行は外部接続しない。

過去の調査・実装記録は[Step 5報告](reports/2026-10-31-step5-go-echo-gemini-blueprint.md)と[Step 5.5報告](reports/2026-10-31-step5-5-gemini-readiness-blueprint-quality.md)を参照する。秘密鍵を`VITE_`変数やFrontend環境に置かない。

## 16. Step 7c Asset verifierのローカル設定

Project/Asset APIを有効にする場合、Go APIは通常CRUDにSupabase user JWT + Data APIを使い、Assetのready確定だけに`arvc_asset_verifier` PostgreSQL roleのdirect connectionを使う。service_roleをAPI processへ設定しない。verifier roleはMigration 012でNOLOGINとして作成され、RLS bypass・superuser・role membership・Project/Asset table ACLを持たず、非公開schemaのready関数だけを実行できる。

fresh local Supabaseでは、対象project ID・DB container・loopback portを確認してから、既存Step 7b-2のadmin handoffを適用する。Migration 014は通常runnerではgrantor権限不足でfail-closedするのが想定動作。

1. 対象のlocal Supabase DBだけにMigration 012–013を適用する。
2. Migration 014を対象DB containerへ`supabase_admin`接続で適用する。

   ```bash
   docker exec -i supabase_db_<local-project-id> psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 < supabase/migrations/20261101001400_step7c_asset_verifier_membership_assertion.sql
   ```

3. SQLが成功しrole membershipがないことを確認後、local migration historyを記録する。

   ```bash
   supabase migration repair 20261101001400 --status applied --local
   ```

4. psqlのlocal admin sessionでrole loginを有効化し、psqlの隠し入力password commandを使ってpasswordを設定する。

   ```sql
   ALTER ROLE arvc_asset_verifier LOGIN;
   \password arvc_asset_verifier
   ```

   passwordは画面・shell history・SQL fileへ出さない。role grantor不足、migration SQL失敗、ledger状態不一致では止まり、`db reset`や既存volume操作をしない。Migration 015はtrigger-only関数への不要なPUBLIC EXECUTEを撤去する。

5. `api/.env.example`を参考に、ignored `api/.env`へ次を設定する。`<password>`は上の隠しpromptで設定したlocal-only passwordに置換する。DSNはGo serverだけに渡し、Frontendへは設定しない。

   ```dotenv
   PROJECTS_ENABLED=true
   SUPABASE_ASSET_VERIFIER_DSN=postgres://arvc_asset_verifier:<password>@127.0.0.1:54322/postgres?sslmode=disable
   ```

   `.env`はGit対象外に保ち、権限を`0600`にする。Go APIはDedicated verifier DSNがない・不正・接続失敗の場合、Asset API付きで起動しない。値をログや出力へ表示しない。

6. `supabase/verification/step7c-1-privilege-invariants.sql`を対象DBへread-only実行し全項目passを確認する。ローカル統合試験には`ARVC_LOCAL_SUPABASE_ASSET_VERIFIER_DSN`をprocess environmentで渡す。

このrole/接続方式はlocal Supabaseで検証済み。Hosted Supabaseへの接続は行っていない。remote DSNを使う構成ではGo側が`sslmode=verify-full`を必須にする。Supabase公式はpersistent backend向けPostgreSQL direct connection、IPv4-only環境向けsession pooler、およびcustom database role接続を案内しているが、Hostedのrole provisioning、network/pooler、secret storeは別途検証する。

詳細：[Step 7b-2 migration admin handoff](reports/2026-11-01-step7b-2-migration-admin-bootstrap-design.md)、[Step 7c-1認可境界報告](reports/2026-11-01-step7c-1-asset-ready-authorization.md)。

## 17. Step 7d ローカルAuth・Cloud Project UI

Step 7dはローカルSupabaseのみを対象とする。Hosted URLはFrontend側でも拒否する。Supabase CLIでlocal Stackを起動し、Migration 001–015とprivate bucketが適用済みであることを確認する。Go APIの`api/.env`にはStep 7cの`PROJECTS_ENABLED=true`、loopback `SUPABASE_URL`、`SUPABASE_ISSUER`、public anon key、専用verifier DSNが必要。DB password/DSNはFrontendへコピーしない。

1. `frontend/.env.example`を`frontend/.env.local`へコピーする。
2. `VITE_SUPABASE_URL`を`http://127.0.0.1:54321`に設定し、`VITE_SUPABASE_ANON_KEY`には**ローカル**Supabaseのanon/publishable keyを設定する。これはブラウザへ公開される値であり、`service_role`/Secret keyを設定してはならない。key値はGitや報告へ記載しない。
3. ローカルAuthにテストユーザーを用意する（既存のローカルAuth手順を使う。Frontendはアカウント作成画面を提供しない）。
4. APIとFrontendを別terminalで起動する。

   ```bash
   cd /home/raric/work/myapp/audio-reactive-visual-compiler/api
   ./run-local.sh
   ```

   ```bash
   cd /home/raric/work/myapp/audio-reactive-visual-compiler/frontend
   npm run dev
   ```

5. `http://127.0.0.1:5173`を開く。ログインせずにEditor、`.arvproj`、WebMを利用できる。Cloud Projectsはメール/パスワードでログインした後に一覧・保存・読込・削除する。Cloud uploadはGo Asset APIを経由し、ブラウザからStorageへ直接アクセスしない。

FrontのAuth設定とAPI proxyはVite dev serverを再起動後に読み込まれる。Auth/session tokenはtab-scoped `sessionStorage`に保存され、期限が近いsessionはrefreshを試す。refresh/401失敗時はlocal sessionを消去する。ブラウザ開発者ツール、共有スクリーンショット、ログにtokenを記録しない。ローカルE2Eでは合成素材だけを使用し、Hosted Project/API URLを指定しない。
# Visual EditorのWebMとProjectファイル

Canvas 2D、`HTMLCanvasElement.captureStream`、`MediaRecorder`に対応し、音声出力時はWeb Audioにも対応するブラウザーでローカルFrontendを開く。必要ならローカル音源を選び、無音／音声あり、FPS（24/30/60）、Canvas解像度（1x/2x）を指定して出力する。アプリは実行時に対応WebM MIME typeを確認し、ブラウザー／codecの組み合わせが非対応ならエラーを表示する。出力はリアルタイムで処理されるため、負荷が高いとframe dropが起こる場合がある。音声出力では、音源durationとFeature Timelineの長さが出力1 frame以内で一致する必要がある。音源ファイルはアップロードされない。

**Save Project**で自己完結型の`.arvproj` JSONファイルをダウンロードする（最大64 MiB、任意の音源は最大32 MiB）。**Load Project**で復元する。このファイルは暗号化されておらず、平文である。実際のWebM生成と再生はブラウザーで確認する必要があり、自動テストではブラウザーAPIをmockする。
