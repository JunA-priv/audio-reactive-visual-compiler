# Step 7b：Docker Desktop bind問題の原因調査

日付：2026-10-31  
状態：**completed（read-only調査）**

## 結論

`host_binding_ipv4=127.0.0.1`を指定したDocker bridge networkでもSupabase PostgreSQLが`0.0.0.0:54322`と表示された症状は、Docker Desktopのport binding既定値が適用されなかった可能性と整合する。ただし、Docker Desktop 4.52.0でこの既知不具合が修正されたという読み方は公式release notesと一致しない。

Docker公式release notesでは、GUIがport mappingのHostIPを`0.0.0.0`に強制し、Engineの`ip`またはbridge option `com.docker.network.bridge.host_binding_ipv4`を無視する不具合の修正は**4.38.0（2025-01-30）**に記載されている。4.52.0（2025-11-20）の記載は新しいport binding settingsの追加であり、同じ不具合の修正とは明記されていない。[Docker Desktop release notes](https://docs.docker.com/desktop/release-notes/)

ユーザー確認のDocker Desktop 4.44.2は4.38.0より後のため、release note上は既知不具合修正を含む版である。一方、4.52.0以降にはport binding設定があるため、既定bindをlocalhostへ寄せる操作をGUIから選ぶ手段が増える。今回の旧Supabase containerは既に削除され、当時のDocker `HostConfig.PortBindings`がない。Supabase CLIが`HostIp=0.0.0.0`を明示したのか、Desktop/Engineがnetwork既定値を無視したのかは確定できない。**原因候補は有力だが、原因確定には至らない。**

## 現在のread-only実測

| 項目 | 結果 |
|---|---|
| Docker Desktop | 4.44.2（ユーザー確認値。WSL CLIからDesktopアプリ版を独立取得できず） |
| Docker CLI / Engine | client 28.3.2 / server 28.3.2 |
| Compose | v2.39.1-desktop.1 |
| Engine | Docker Desktop、kernel `6.6.87.2-microsoft-standard-WSL2`、memory 7,925,329,920 bytes（約7.38 GiB） |
| WSL | 2.5.10.0、Ubuntu distroはWSL 2。現在のWSLからDocker Desktop daemonへ接続できるためWSL連携経路は稼働中 |
| Docker context | `default` |
| Supabase専用network | `arvc-supabase-loopback` / bridge / `com.docker.network.bridge.host_binding_ipv4=127.0.0.1` / IPv6 disabled / 接続containerなし |
| containers | `tunescout-db-1`と`tunescout-redis-1`のみ。どちらもExited。Supabase service containerなし |
| networks | `arvc-supabase-loopback`, `bridge`, `host`, `none`, `tunescout_default` |
| volumes | anonymous volume 1件、`supabase_db_audio-reactive-visual-compiler`、`supabase_storage_audio-reactive-visual-compiler`、`tunescout_postgres_data` |

停止中tunescout containerのinspectでは、DB `5432/tcp`とRedis `6379/tcp`の`HostIp`は空で、HostPortはそれぞれ5432/6379だった。これは特定HostIPがcontainer設定に固定されていないことを示す。`docker ps -a`上の表示は`0.0.0.0:5432`と`0.0.0.0:6379`。再作成・再起動時の既定bind設定が実効動作を左右し得るため、tunescoutも安全確認前に起動しない。

前回のSupabase PostgreSQLは`0.0.0.0:54322->5432/tcp`と観測後にCLIで停止・除去済みであり、今回の一覧にはない。Supabase DB/Storage volumeは引き続き存在する。今回、container、network、volume、daemon設定を変更していない。

## Docker Desktopの既知情報との照合

- 4.38.0 release notesはGUIがport mappingのHostIPを`0.0.0.0`に強制してbridgeの`host_binding_ipv4`を使わせない問題を明示している。この症状との一致度は高い。
- 同じ記載は4.38.0の修正項目にある。4.44.2はそれより後なので、4.44.2固有の継続不具合だとはrelease notesから推定できない。回帰、別のport binding設定、CLIが指定したHostIPなどの可能性は残る。
- 4.52.0は新しいport binding settingsの追加を明示している。現在の公式Network docsも、Desktop設定で既定bindをlocalhostへ変更できると説明している。[Networking on Docker Desktop](https://docs.docker.com/desktop/features/networking/)
- Dockerの通常の公開portは既定でall interfaces（`0.0.0.0` / `::`）をlistenする。loopback限定は`127.0.0.1`などを明示した設定で検証する必要がある。[Publishing and exposing ports](https://docs.docker.com/get-started/docker-concepts/running-containers/publishing-ports/)
- Supabase公式local developmentは、untrusted network上で`host_binding_ipv4=127.0.0.1`のDocker networkを作り、`supabase start --network-id`へ渡す手順を案内している。[Supabase local development](https://supabase.com/docs/guides/local-development)
- `supabase/config.toml`のPostgres設定はcontainer portとhost portを指定するが、host bind IPの設定は見当たらない。従ってCLI側の明示IP指定の有無は、次回起動時にDocker `inspect`の`HostConfig.PortBindings`を採取して確かめる必要がある。

### 4.52.0への更新は必要か

4.52.0はloopback既定設定を選べるDesktop port binding機能の導入版として関連する。安全な既定値をDesktop側で設定できるようにする目的では、4.44.2から更新する合理性がある。しかし、公式資料は4.52.0が4.38.0の不具合を修正したとは述べておらず、更新のみでSupabaseの問題が解決すると保証できない。

また4.52.0はEngine v29.0.0を含み、現環境の28.3.2からEngine major versionも変わる。現在の公式release notesは4.52.0より後の多数の版を公開しているため、次回実行時には更新先候補の対応OS、現行安定版、更新手順と既知問題を改めて確認する。今回、更新先を確定・導入していない。

## tunescoutへの影響

- Docker Desktop更新時は共有daemonの再起動が必要になり、実行中containerは停止し得る。今回の確認時点ではtunescout DB/Redisとも既に停止中。
- Docker Desktop更新はEngine、port forwarder、WSL連携も更新するため、更新後にWSLからCLI接続できるか、containerが起動するか、port mappingが期待どおりかを確認する必要がある。
- tunescoutの保存volume `tunescout_postgres_data`は存在しており、更新による削除は予定・実施していない。Docker Desktopの通常更新後も永続データは保持される想定だが、今回の環境で保証できるものではない。更新前に必要データの論理backupを別工程で計画する。
- tunescoutの保存PortBindingsはHostIp空欄、host ports 5432/6379。Desktopのlocalhost既定設定を有効にするとアクセス可能な範囲が変わる可能性がある。特にLANからtunescoutへ接続する利用があれば、更新前にその依存を確認する。
- `docker ps -a`で0.0.0.0表示されていてもcontainerはExitedで、現時点ではlistenerは稼働していない。今回起動や接続試験はしていない。

## 安全な更新後の検証案（別途許可後）

1. 更新前にDocker Desktop版、Engine/Compose、WSL version、`docker ps -a`、network/volume一覧、使用中portを記録する。必要なtunescout DBは論理backupを行う場合、その内容・保存先・復旧手順を別途承認する。`prune`、factory reset、volume削除は使わない。
2. 更新先の公式release notesとWindows/WSL要件を確認し、変更予定のEngine/Compose版と互換性リスクをレビューしてからDesktopを更新する。更新・再起動自体はその作業時に明示許可を得る。
3. Docker Desktop設定でport binding既定値をlocalhostにする場合は、画面上の実際の選択肢を記録する。管理者ポリシーで固定されている場合は変更しない。
4. `docker version`、`docker compose version`、`docker info`でWSL接続を確認する。既存containers/networks/volumesが残っていることをread-onlyで再確認する。
5. Supabase用とは別の一時テストcontainer/portを用いたbind試験を行い、作成直後に`docker inspect`の`HostConfig.PortBindings`と`docker ps`を照合する。期待値は`127.0.0.1`限定。可能ならWindows host/WSL loopbackから接続し、別interface公開がないことも検証する。テストcontainerの作成は次工程での明示許可事項とし、今回行っていない。
6. 専用bridgeのoptionが127.0.0.1のままか確認する。次にSupabase stackを再開する際は、起動直後、他health checkより先に全containerのHostConfig/portsを検査する。`0.0.0.0`または`[::]`があればAuth/Data API等の検証をせずSupabase projectだけを`supabase stop`し、volumeは保持する。
7. bindが確認できた後にだけ、Postgres/Auth/Data API/Storage healthとcontainerごとのmemoryを別工程で検証する。

## Rollback方針

- 更新後にDocker daemon/WSL連携が不安定、またはtunescout接続に回帰が出た場合、まず新規のSupabase起動を中断する。tunescoutの状態をむやみに変更せず、container/network/volume情報とDesktop診断情報を秘密情報を含めず記録する。
- Desktopの以前の版への戻しが必要なら、公式配布・サポート手順を確認し、アプリ再インストール前にDocker Desktop data diskと必要なDBデータのbackup/復元可能性を確認する。古いEngineへ戻す時の内部データ互換性は保証されないため、data diskをバックアップせずにdowngradeしない。
- Factory reset、Clean/Purge data、`docker system prune`、volume削除、Supabase `stop --no-backup`はrollback手順に含めない。
- 復旧確認はWSLからdaemon接続、既存containerの状態、tunescout DB volumeの保持、アプリが必要とするloopback接続の順で行う。

## 独立した未解決事項：Realtimeの除外

前回のSupabase起動時、`--exclude realtime`を渡したにもかかわらずRealtime image/containerも現れた。今回はstackを起動しておらず再現確認していない。bind問題とは別issueとして扱い、次回の許可された再開でCLI v2.122.0のexclude flag仕様・引数解釈と、実際に作成されるcontainer一覧を個別確認する。原因を確認するまで`--exclude realtime`が有効と前提しない。

## 作業境界

read-onlyのDocker/WSL一覧取得、既存network/container metadata確認、Docker公式資料照合のみ。Desktop更新、daemon再起動、Supabase再起動、Firewall/daemon設定、container/network/volume変更、アプリ実装、Hosted Supabase、GitHub pushはいずれも実施していない。
