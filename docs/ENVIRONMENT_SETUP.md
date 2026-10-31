# 開発環境構築マニュアル

対象：AI Audio-Reactive Visual Compiler
作成・情報確認日：2026年10月31日
対象環境：Windows 11 / WSL2 Ubuntu / bashまたはzsh
開発先：`/home/raric/work/myapp/audio-reactive-visual-compiler`

## 1. この手順書の状態

本書は公式資料に基づく導入手順である。作成者の実行環境からWSLへの接続がアクセス拒否となるため、以下のコマンドはユーザーのWSL内では未実行・未検証。実行成功の記録と区別する。

| 区分 | 確認内容 |
|---|---|
| FACT（ユーザー提示） | WSLでリポジトリ取得済み、mainはorigin/mainと一致、変更なし |
| FACT（ユーザー提示） | 取得前のNode.jsは22.18.0、npmは10.9.3 |
| FACT（公式情報） | Node.js 24.22.1は2026年10月21日のLTSセキュリティリリース |
| PROPOSED | 本プロジェクトのNode.jsを24.22.1に固定 |
| PROPOSED | パッケージ管理はnpmに統一 |
| BLOCKED | WSLでの導入・動作・依存監査結果の直接確認 |

Node.js 22.18.0はセキュリティ更新前なので継続採用しない。22系を維持する事情がある場合も、公式情報で修正済み版を再確認する。本書は脆弱性が存在しないことを保証しない。

## 2. 導入する順序とバージョン管理

| 段階 | 対象 | バージョン方針 |
|---|---|---|
| 最初に導入 | Git、curl、証明書、ビルド補助 | サポート中Ubuntuの更新済み配布パッケージ。導入版を記録 |
| 最初に導入 | nvm | 公式README掲載の0.40.8。導入手順確認済み、脆弱性監査は未完了 |
| 最初に導入 | Node.js | 24.22.1 LTSを提案。公式のセキュリティ修正を確認 |
| Node更新時 | npm | Node同梱版で開始し、実バージョンとアドバイザリ確認後に固定 |
| フロントエンド構築時 | React、React DOM、TypeScript、Vite、React用プラグイン、型定義 | 安定版情報・advisory・engines・peerDependencies確認後に完全固定 |
| 品質基盤構築時 | Lint、Formatter、Vitest、必要ならPlaywright | 未選定。初期化テンプレートの選択を無条件に採用しない |
| コンテナ導入時 | Docker Desktop / Compose | Windows側公式安定版。既存導入の有無を優先確認 |
| API工程 | Go、Echo、govulncheck | 未選定。Goのサポート期間とEchoのメジャー互換性を確認 |
| 音響解析工程 | Python、uv、Demucs、PyTorch CPU、torchaudio、FFmpeg | 未選定。互換性と脆弱性を同時に検証して固定 |
| 必要になった時 | GitHub CLI、Google Cloud CLI、Supabase CLI、Wrangler | 未選定。各公式配布元・更新情報を確認して導入 |

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

fnmやVoltaで管理済みなら、その管理ツールで24.22.1を導入する。複数の管理ツールを重ねて導入しない。nvmが既にある場合は次の新規導入を省略できる。

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
nvm install 24.22.1
nvm use 24.22.1
node --version
npm --version
node -p 'process.platform + " " + process.execPath'
```

期待値：Nodeは`v24.22.1`、platformは`linux`。Windows側の`node.exe`や`/mnt/c/`配下の実行ファイルを使っていないこと。

`.nvmrc`が既にある場合は内容を確認し、矛盾を解決してから変更する。新規作成時：

```bash
printf '24.22.1\n' > .nvmrc
nvm use
```

プロジェクト切り替え時は`nvm use`。他プロジェクトも変える`nvm alias default`は今回必須にしない。`sudo npm install`、npmの無条件なグローバル更新は行わない。

npmの同梱版は`npm --version`で記録し、公式更新履歴・セキュリティ情報を照合して採用する。npm自身の安全性は、アプリ側の`npm audit`だけでは確認できない。

公式：[Node 24.22.1](https://nodejs.org/en/blog/release/v24.22.1)、[2026年10月セキュリティ更新](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)、[npm更新履歴](https://github.com/npm/cli/releases)

## 6. フロントエンド依存の選定と導入

目的：ReactでUI、TypeScriptで型検査、Viteで開発サーバーとビルドを提供する。APIキーは不要。

現時点ではWSL側にfrontendが作られていることは未確認。Windows側に作成されたひな形やnode_modulesをコピーしない。

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

## 8. Go・Echo（API工程で導入）

目的：認証・認可、プロジェクト管理、解析ジョブ、Gemini連携、Blueprint検証・暗号化。現在は未導入・版未選定。

Go公式ダウンロードとセキュリティ情報からサポート中の修正済み版を選ぶ。CPUアーキテクチャを`uname -m`で確認し、Linux用アーカイブをダウンロード、公式SHA-256と照合する。公式インストール手順に従う。既存のGoへアーカイブを上書き展開しない。既存導入がある場合は先に管理方法を確認する。

```bash
go version
go env GOOS GOARCH GOPATH GOTOOLCHAIN
```

PATHには採用したGoのbinを追加する。Echoは公式quickstartのメジャーに合わせてimport pathを決め、固定版を`go get モジュールパス@完全な版番号`で導入する。古いメジャーのサンプルと新しい版を混在させない。

backendを作成後の検証：

```bash
go mod verify
go test ./...
go vet ./...
gofmt -l .
```

govulncheckも固定版で導入し`govulncheck ./...`を実行する。Goではgo.mod/go.sum、Go本体、govulncheckの版を記録する。GOTOOLCHAINの自動取得挙動も記録し、CIの版と合わせる。

Secret：GEMINI_API_KEY等はバックエンドのみ。実際の変数名はAPI実装時に.env.exampleで確定する。

公式：[Go導入](https://go.dev/doc/install)、[Goセキュリティ](https://go.dev/doc/security/)、[Echo](https://echo.labstack.com/guide/quickstart/)

## 9. Python・uv・Demucs・PyTorch CPU・FFmpeg（解析工程）

目的：CPUで4 Stem分離・特徴量生成。すべての採用版は未確定。Demucs元リポジトリはアーカイブ済みのため、最新PyTorchと組み合わせれば安全・正常とは判断しない。

1. Pythonのサポート期間、Demucsの依存制約、PyTorch/torchaudioの対応表を確認する。
2. uvを公式の版付きインストーラーから取得し、スクリプトを確認して導入する。版と配布元を記録する。
3. `uv python install 完全なPython版番号`で対応Pythonを導入する。
4. python-islandにpyproject.tomlを作成し、`uv python pin 完全なPython版番号`で固定する。
5. PyTorch公式のLinux / Pip / Python / CPUに合う組み合わせを選ぶ。uvではCPU専用indexと対象パッケージのsourceを明示し、意図しないindexからの取得を防ぐ。
6. Demucs・torch・torchaudioと解析依存を完全固定し、uv.lockを生成する。旧Torchへのダウングレードが必要なら、その版の脆弱性を別途評価する。
7. 固定版pip-audit等でPython依存を監査し、公式advisoryも照合する。

FFmpegはUbuntuのセキュリティ更新が提供される配布パッケージを第一候補とする。

```bash
sudo apt update
sudo apt install ffmpeg
ffmpeg -version
ffprobe -version
```

uv導入・lock生成後の検証：

```bash
uv --version
uv sync --locked
uv run python --version
uv run python -c 'import torch, torchaudio; print(torch.__version__, torchaudio.__version__); print(torch.version.cuda)'
uv run python -m demucs --help
```

CPU向け導入ではCUDA依存を不要にする。試験用の権利を確認した短い音源に対して：

```bash
uv run python -m demucs -n htdemucs -d cpu /absolute/path/to/test.wav
```

初回はモデルダウンロードが発生し得る。公式の信頼できる重みのみ使用する。4 Stemの生成と聴取、処理時間・最大メモリを記録する。CPUの速度・メモリ要件を満たすかは未実測。Kickはdrumsから追加解析して推定するもので、独立Stemとしては生成されない。

異常時：torch/torchaudioの対応、音声I/O依存、FFmpegのPATH、メモリ不足、モデル取得失敗を順に確認する。システムPythonへsudo pipで導入しない。

公式：[uv導入](https://docs.astral.sh/uv/getting-started/installation/)、[PyTorch CPU導入](https://pytorch.org/get-started/locally/)、[Demucs](https://github.com/facebookresearch/demucs)、[FFmpegセキュリティ](https://ffmpeg.org/security.html)

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

目的：ローカルAuth/PostgreSQL検証とマイグレーション。Dockerが必要。公式サポート手段に従い、npmのプロジェクトローカル依存へ固定版を追加する。npmのグローバルインストールは使用しない。

```bash
# 選定した版へ置換：npm install --save-dev --save-exact supabase@VERSION
npx --no-install supabase --version
```

`supabase init`、`start`はDB構成・保存先を決めた後に実施する。リモートへのlinkやdb pushは別作業。ブラウザ用公開キーと管理用Secretを混同せず、管理用キーはフロントへ渡さない。

公式：[Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)

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
- WSLのNode 24.22.1と採用npm版が記録されている。
- フロントの依存版・互換性・既知の脆弱性確認が完了している。
- npm ci、ビルド、Lint、追加した型検査・テストが成功している。
- Windowsブラウザから開発画面を表示できる。
- 成功した項目のみFACTとして記録されている。

Go・Python・クラウドCLIが未導入でも、最小Renderer開発の開始は可能。本書の作成完了は、環境構築や実装の完了を意味しない。
