# Step 7b — Supabase CLI・ローカルスタック環境構築

日付：2026-10-31
状態：**partial**

## 結果

WSL2からDocker Desktopへ接続できることを確認し、stable Supabase CLI v2.122.0をリポジトリ依存に追加せず`/tmp`へ導入した。新規`supabase/config.toml`を作成し、Auth redirectをViteの`127.0.0.1:5173`に合わせた。Supabase用Docker networkには公式例どおりhost binding `127.0.0.1`を指定した。

しかしSupabase CLIでlocal stackを起動すると、PostgreSQL portが`0.0.0.0:54322`でpublishされた。ネットワークoptionだけではloopback限定を保証できない実測となったため、外部公開を避けてstackを停止した。Postgres containerが一時的にhealthyであることは見えたが、Auth、PostgREST Data API、Storageの状態を確認する前に停止しており、環境構築完了条件は未達。Hosted Supabase接続、本番DB操作、migration、アプリ実装は行っていない。

## 実施・検証

| 項目 | 結果 |
|---|---|
| Docker Engine | `28.3.2`。`docker info`成功 |
| Docker Compose | `v2.39.1-desktop.1` |
| Docker memory | Docker Engine reported `7,925,329,920` bytes（約7.38 GiB）。Supabase CLIのall-services推奨最低7 GBをわずかに超える |
| 既存Docker状態 | `tunescout_default` networkと停止済み`tunescout` containersを確認。`tunescout_postgres_data` volumeを保持し、操作していない |
| Supabase CLI | stable GitHub release `v2.122.0`を確認し、`/tmp/arvc-supabase-cli-2.122.0`へnpm prefix install。実行`--version`: `2.122.0` |
| app dependencies | `frontend/package.json` / lock変更なし。Go/Python依存も変更なし |
| Supabase config | 既存`supabase/`なしを確認後、`supabase init --yes`。`supabase/config.toml`を作成、local Auth `site_url` / redirectを`http://127.0.0.1:5173`へ設定 |
| Dedicated network | `arvc-supabase-loopback`を作成。inspect optionは`com.docker.network.bridge.host_binding_ipv4=127.0.0.1`, IPv6 disabled |
| Stack attempt | 初回image取得を実施。Postgresは一時的にhealthy。検査時にpublish addressが`0.0.0.0:54322`と確認されたので停止 |
| Optional service exclusion | `--exclude studio,realtime,imgproxy,postgres-meta,edge-runtime,logflare,vector,supavisor`を指定したが、検査時にRealtime imageのcontainerも起動していた。除外指定の実効性は未確認 |
| 停止後 | `supabase stop`（`--all`/`--no-backup`なし）。Supabase DB volumeは残存。Supabase containersは停止・CLI管理対象から除去。既存tunescout volume/containerには変更なし |
| Auth / Data API / Storage | Health未確認。loopback以外へbindされないと確認できるまで起動を継続しない |
| per-container memory | ready状態の統計未測定 |
| Hosted / migration / Gemini / push | 実施なし |

起動出力にはlocal publishable/secret keysやDB接続情報が含まれ得るため、CLI outputは保存・表示しない形でstart/stopを行った。認証情報を報告書へ転記していない。

## 安全なbindの確認と停止理由

Supabase公式Local Development資料は、untrusted network上では`host_binding_ipv4=127.0.0.1`のDocker networkを作り、`supabase start --network-id`へ渡す例を示す。[Official local development](https://supabase.com/docs/guides/local-development)

この手順を使用したにもかかわらず、実際のDocker published portは`0.0.0.0:54322->5432/tcp`と表示された。`127.0.0.1`に限定されたと証明できないためAuthやREST requestを送らず、同リポジトリのローカルstackだけ`supabase stop`した。stopでは`--no-backup`を使わず、Supabase DB volumeは残している。既存の別Docker volumeは変更していない。

Supabase CLIの通常設定でport番号は設定できるが、`config.toml` reference上にpublished host IPを指定する設定は確認できなかった。[CLI config reference](https://supabase.com/docs/guides/local-development/cli/config) Docker Desktop上でloopbackのみへbindする別の公式サポート方法、またはこのCLI版の明示的な回避策を確認する必要がある。port mappingを手作業でpatchする、別の公開proxyを追加する、WSL/Windows firewallを変更する方法は今回採用していない。

## 環境・ファイル変更

- `supabase/config.toml` — 新規local project設定。Auth callbackはVite loopback URLへ設定。
- `supabase/.gitignore` — `supabase init`が生成。CLI一時状態`.temp`、`.branches`、ローカルdotenv系を除外する。
- `docs/ENVIRONMENT_SETUP.md` — CLI固定導入、loopback network、起動・停止、キー非記録、今回のwildcard bind実測を追記。
- `CURRENT_TASK.md` — 今回の環境構築scopeとpartial理由へ更新。
- `docs/CURRENT_STATE.md` — 以前のDocker不可の状態を新しい実測で置き換え、stackが部分設定・停止中であることを追記。
- `/tmp/arvc-supabase-cli-2.122.0` — CLIとnpm package cache。repoの依存関係外。
- Docker `arvc-supabase-loopback` networkとSupabase DB volumeは作成済み。volumeは未削除。Supabase service containersは停止済み。

アプリケーションコード/API、frontend package files、Project migration、既存Supabase設定、Hosted resourceは変更していない。

## 残りの作業

1. Docker Desktopにおいてpublished portsを確実に127.0.0.1へ限定するSupabase CLI v2.122.0のサポート方法を確認する。
2. それが確認できた場合にだけ再起動し、`docker ps`で全published portsを確認する。`0.0.0.0`/`[::]`があれば停止する。
3. `supabase status`のcredential-bearing outputを表示せずにAuth/Postgres/Data API/Storageのhealthを確認する。
4. readiness後にcontainer memory usageを記録し、stop後もvolumeが保持されることを確認する。

## 参照

- [Supabase CLI stable releases](https://github.com/supabase/cli/releases/latest) — v2.122.0（2026-10-23）
- [Supabase CLI getting started](https://supabase.com/docs/guides/local-development/cli/getting-started)
- [Supabase local development and loopback network](https://supabase.com/docs/guides/local-development)
- [Supabase CLI config](https://supabase.com/docs/guides/local-development/cli/config)
- [Supabase CLI start/stop reference](https://supabase.com/docs/reference/cli/global-flags)
