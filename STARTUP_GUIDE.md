# ローカル開発環境 起動ガイド

対象環境は Windows 11 / WSL2 Ubuntu です。コマンドは、特に記載がない限りWSL内のターミナルで実行します。

## 1. 前提環境

実測・固定されている版は次のとおりです。既存のロックファイルや設定に従ってください。

| 用途 | 前提 |
|---|---|
| OS | Windows 11、WSL2 Ubuntu（確認環境はUbuntu 24.04、x86_64） |
| Node.js / npm | Node.js 24.22.2、npm 11.19.1（`frontend/package.json`のenginesと`.nvmrc`） |
| Go | Go 1.27.3（`api/go.mod`はGo 1.27.0、toolchain 1.27.3） |
| Python Island | Python 3.14.10、uv 0.8.12。依存は`python-island/uv.lock`で固定 |
| 音声処理 | FFmpeg / ffprobe。既存環境資料の実測版は6.1.1-3ubuntu5 |
| 音声解析モデル | CPU版PyTorch 2.14.1、Demucs 4.1.0、および事前に検証済みの`htdemucs` checkpoint |

通常のFixture APIとFrontend表示だけならPython Island・FFmpeg・Demucsモデルは不要です。音声解析を使う場合に必要です。ローカル音声解析はローカルCPU上で動きます。解析対象の音源を外部AIへ送信しません。

Node/npmの版は[frontend/package.json](frontend/package.json)、Goは[api/go.mod](api/go.mod)、Python/FFmpegの詳細は[開発環境構築マニュアル](docs/ENVIRONMENT_SETUP.md)を参照してください。

## 2. ディレクトリ

リポジトリルート：`/home/raric/work/myapp/audio-reactive-visual-compiler`

```text
audio-reactive-visual-compiler/
├── api/             Go API
├── frontend/        React / Vite
└── python-island/   Go APIから呼び出される音声解析CLI
```

## 3. Go API

### 通常起動

ターミナル1で実行します。

```bash
cd /home/raric/work/myapp/audio-reactive-visual-compiler/api
./run-local.sh
```

`run-local.sh`は`api/.env`があれば読み込み、`go run ./cmd/server`を実行します。`.env`がない場合や必要な設定があれば、[api/.env.example](api/.env.example)を参考に`api/.env`を作成してください。実際の秘密値はこのガイドやGit管理ファイルへ記載しないでください。通常のFixture modeは外部AI APIキー不要です。

APIは`127.0.0.1:8080`で待ち受けます。起動時に次の形式のログを確認します。

```text
API server starting addr=127.0.0.1:8080 audio_analysis_enabled=false
```

音声解析を有効化しない通常起動では`audio_analysis_enabled=false`で正常です。別のWSLターミナルから確認します。

```bash
curl -i http://127.0.0.1:8080/healthz
```

期待値はHTTP 200と`{"status":"ok"}`です。起動失敗時は、Goの版、`api/`から起動したか、8080番ポートの競合、直前のAPIエラーを確認してください。

### 音声解析Routeを有効にする場合

音声解析Routeは既定で無効です。`api/.env`に次を設定します（値は既存のパスに合わせてください）。

```dotenv
AUDIO_ANALYSIS_ENABLED=true
PYTHON_ISLAND_EXECUTABLE=../python-island/.venv/bin/python-island
PYTHON_ISLAND_DIRECTORY=../python-island
FFPROBE_EXECUTABLE=ffprobe
```

`api/run-local.sh`が`api/`へ移動してから起動するため、上記相対パスはそのディレクトリを基準に解決されます。GoはこのRouteを有効にするとローカルSupabase Auth issuerへ接続してJWT validatorを初期化します。既定issuerは`http://127.0.0.1:54321/auth/v1`です。ローカルSupabase Authが起動していない、またはPython実行ファイル・ffprobeが利用できない場合、APIの起動初期化に失敗します。

設定変更後はGo APIを再起動してください。起動ログが次のようになればRouteが有効です。

```text
API server starting addr=127.0.0.1:8080 audio_analysis_enabled=true
```

この状態はRouteの登録を示します。音声解析には有効なSupabase JWT、音声解析環境、利用可能なモデル重みも必要です。Route無効時は`POST /api/v1/audio/analyze`が登録されず、404になります。

## 4. Frontend

ターミナル2で実行します。

```bash
cd /home/raric/work/myapp/audio-reactive-visual-compiler/frontend
npm run dev
```

`npm run dev`はViteを`127.0.0.1`で起動します。標準URLは[http://127.0.0.1:5173/](http://127.0.0.1:5173/)です。起動ログに`Local: http://127.0.0.1:5173/`が出ることを確認し、WindowsブラウザでURLを開きます。

[frontend/vite.config.ts](frontend/vite.config.ts)の`/api` proxy先は`http://127.0.0.1:8080`です。ブラウザからAPIへ直接ではなく、Vite経由で接続します。

## 5. Python Island

Python IslandはHTTPサーバーではありません。音声解析時にGo APIが`PYTHON_ISLAND_EXECUTABLE`で指定されたCLIを子プロセスとして起動するため、通常は独立したターミナルで起動する必要はありません。

初回環境構築または依存再作成時は、既存の手順を使います。

```bash
cd /home/raric/work/myapp/audio-reactive-visual-compiler/python-island
./scripts/setup.sh
```

この手順は固定版Python runtimeとロック済み依存を用意します。別途、FFmpeg/ffprobeと検証済み`htdemucs`モデルcheckpoint cacheが必要です。モデルcacheがない場合、CLIはモデルを暗黙にダウンロードせず失敗します。Python単体CLIの確認手順は[python-island/README.md](python-island/README.md)にあります。手動でCLIを起動するのは環境確認・診断時だけで、APIと並行した常駐起動は不要です。

## 6. 起動順序

1. 必要に応じてローカルSupabase Authを起動します（音声解析Routeを有効化する場合）。
2. ターミナル1でGo APIを起動します。
3. ターミナル2でFrontendを起動します。
4. Windowsブラウザで`http://127.0.0.1:5173/`を開きます。

各サービスは別々のターミナルで起動し、利用中はターミナルを閉じないでください。Vite Proxyの先にGo APIが必要なため、Go APIを先に起動します。

## 7. 正常動作の確認

- Goの起動ログで`addr=127.0.0.1:8080`を確認します。
- 音声解析を使う場合は`audio_analysis_enabled=true`を確認します。Routeを有効にしない通常起動ではfalseが正常です。
- `curl -i http://127.0.0.1:8080/healthz`がHTTP 200を返すことを確認します。
- Viteの起動ログで`127.0.0.1:5173`を確認します。
- Windowsブラウザで`http://127.0.0.1:5173/`が表示されることを確認します。
- 音声解析を行う場合は、認証済みEditorで音源範囲を選択して解析し、Timelineが読み込まれることを確認します。`/demo`は固定デモであり、この解析Routeを呼びません。

音声解析Routeが無効だと解析POSTは404になります。ブラウザやVite側では解析失敗、接続リセットなどとして見える場合があります。まずGoの起動ログの`audio_analysis_enabled`を確認してください。

## 8. 終了

Go API、Viteを起動したそれぞれのターミナルで`Ctrl+C`を押します。Python Islandはリクエスト中にGoが起動する子プロセスで、別途終了操作はありません。`wsl --shutdown`はWSL上の他プロセスも停止するため、通常のアプリ終了手順には含めません。

## 9. トラブルシューティング

### Frontendが開けない

まずViteの起動ログと待受ポートを確認します。WSL内で実行：

```bash
curl -v --max-time 5 http://127.0.0.1:5173/
```

Windows PowerShellで実行：

```powershell
curl.exe --noproxy "*" -v --max-time 5 http://127.0.0.1:5173/
```

WSL内からHTTP 200が返る一方、Windows側ではTCP接続後にTimeoutする場合、WSL2のlocalhost転送経路の問題として切り分けます。WSL内でIPを確認します。

```bash
hostname -I
```

localhost転送の診断・暫定対応としてのみ、Viteを全interfaceで待ち受けます。

```bash
npm run dev -- --host 0.0.0.0
```

表示されたWSL IPを使い、Windowsブラウザから`http://<WSLのIP>:5173/`へアクセスします。`0.0.0.0`は待受範囲を広げる設定なので、ローカル環境の診断・暫定対応に限ってください。通常設定は`127.0.0.1`です。

### 音声解析ができない

順に確認します。

1. Go APIが稼働し、`/healthz`がHTTP 200か。
2. Go起動ログに`audio_analysis_enabled=true`があるか。Route無効時は404です。
3. `.env`変更後にGo APIを再起動したか。
4. ローカルSupabase Authが起動し、ログイン済みの有効なJWTを使っているか。
5. Vite Proxyが`http://127.0.0.1:8080`を指しているか。
6. Goのrequestログに`POST /api/v1/audio/analyze`が到達しているか。ログに出るstage/statusを確認し、音声や認証情報はログへ貼り付けないでください。
7. Python環境、CLI実行パス、ffprobe、Demucs checkpoint cacheが利用可能か。

### 音声解析が長時間終わらない

現行Frontendは、元MP3のデコード、選択範囲のWAV生成、API送信と解析を、ひとつの処理中表示で示します。表示だけではどの段階か判定できません。

Goのrequestログでrequest受信、Content-Length、stage、最終status・所要時間を確認します。requestがPython実行段階にある場合は、WSL側でPython/ffmpegプロセスが動いているか、CPU/RSSが変化しているかを確認します。プロセス確認には引数や環境変数を表示しない方法を使い、秘密値を共有しないでください。解析完了後のmetadataにはdecode、Demucs、feature抽出、total時間とpeak RSSが含まれます。

### ECONNRESET

単一原因と決めつけず、Route無効（404）、接続先切断、Go API停止、クライアント側中断などを候補として確認します。Go起動ログのRoute状態、Goのrequest lifecycleログ、Viteログ、API稼働状態を同じ試行について照合してください。

### Port競合

WSLで5173 / 8080の待受状況を確認します。

```bash
ss -ltnp '( sport = :5173 or sport = :8080 )'
```

出力に対象ポートがあれば、そのサービスを起動したターミナルやプロセスの所有者を確認します。既存プロセスを確認せず強制終了するのを標準手順にしないでください。

## 10. 最小起動チェックリスト

- [ ] Go API起動ログで`addr=127.0.0.1:8080`を確認
- [ ] 音声解析を使う場合、`AUDIO_ANALYSIS_ENABLED=true`と`audio_analysis_enabled=true`を確認
- [ ] Viteを起動し、`127.0.0.1:5173`の起動ログを確認
- [ ] ブラウザで`http://127.0.0.1:5173/`を表示
- [ ] 音声解析を使う場合、ログイン後に音声解析を実行しTimelineが返ることを確認
