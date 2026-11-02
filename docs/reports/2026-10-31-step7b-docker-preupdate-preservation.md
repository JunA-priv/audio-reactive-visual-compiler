# Step 7b：Docker Desktop更新前の環境保全調査

日付：2026-10-31  
状態：**completed（read-only調査）**

## 結論

更新前に最低限保全すべきものは、Docker DesktopのWSL2データディスク、tunescoutのPostgreSQL named volume、Redisのanonymous volume、SupabaseのDB/Storage volumes、Compose定義と必要なイメージである。現在コンテナは停止しており、バックアップ作成・復元試験は行っていない。

推奨は、別途許可を得て **(1) tunescout PostgreSQLの論理dump、(2) Docker Desktopを完全停止した状態でデータディスクのcold copy、(3) 必要なら停止状態で各重要volumeの独立アーカイブ** を取得し、別ドライブへ保管すること。Docker Desktopのディスクコピーは全体復旧用、論理dumpはPostgreSQLのEngine/イメージ更新に対する移植性を補う。ユーザー確認なしに更新へ進まず、コピーの容量・ハッシュ・読み取り可能性を確認する。

## 確認した構成

| 項目 | read-only確認結果 |
|---|---|
| Docker Desktop | 4.44.2（過去のユーザー確認値。本調査ではWindows GUIから再確認していない） |
| Docker CLI / Engine | 28.3.2 / 28.3.2、Operating SystemはDocker Desktop |
| Compose | v2.39.1-desktop.1 |
| WSL kernel | `6.6.87.2-microsoft-standard-WSL2` |
| Docker Engine data root | `/var/lib/docker`（Docker Desktop内Linux VM側のパスで、Windows上のdisk image位置ではない） |
| tunescout DB | `tunescout-db-1`, `pgvector/pgvector:pg16`, 停止、再起動policy `no`, HostIP未指定で5432公開。named volume `tunescout_postgres_data` を `/var/lib/postgresql/data` にRW mount |
| tunescout Redis | `tunescout-redis-1`, `redis:7-alpine`, 停止、再起動policy `no`, HostIP未指定で6379公開。imageの`/data` volumeとしてanonymous volume `f1793d690d68e10268c605306d8342dd888535d5abf148d7b226e7ccc0b9b021` をRW mount |
| tunescout Compose | `/home/raric/work/ulmuscraft/TuneScout/compose.yaml`。DB named volumeを定義。RedisはComposeに明示volumeがないが、実containerにはanonymous `/data` volumeが割り当て済み |
| Supabase | Stack containerは存在しない。`supabase_db_audio-reactive-visual-compiler`、`supabase_storage_audio-reactive-visual-compiler`の2 volumesが存在 |
| Docker networks | `tunescout_default`と空の`arvc-supabase-loopback`等が存在。後者のloopback bind optionは維持 |
| Images | `pgvector/pgvector:pg16`、`redis:7-alpine`およびSupabaseのPostgres/Auth/REST/Storage/Realtime/Kong/Mailpit imagesがローカルに存在 |
| 保存先候補 | Docker公式のWSL2既定disk path `%LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx` はWindows側で存在を確認。設定store内にdisk path相当キーは見つからなかったが、Docker Desktop GUIのResources > Advancedに表示される選択済み位置は未確認 |

containerのDB・Redis内容、volumeファイル、認証情報は開いていない。Supabase volumesが今回のlocal DBとして使えることや、volume内容の健全性は確認していない。

Docker Desktopのdata diskが標準位置にあることはGUI未確認のため確定していない。Windows側で **Settings > Resources > Advanced > Disk image location** を確認し、実際の対象ファイルを特定してから保全する。Docker公式はWSL2では標準の`docker_data.vhdx`を、カスタムDisk image location設定時はその場所のファイルを対象とし、コピー前にDocker Desktopを完全停止するよう案内している。[Docker Desktopデータのバックアップと復元](https://docs.docker.com/desktop/settings-and-maintenance/backup-and-restore/)、[Docker Desktop設定](https://docs.docker.com/desktop/settings-and-maintenance/settings/)

## バックアップの有無・復旧可能性

- プロジェクトリポジトリとTuneScoutリポジトリ内を、backup/dump/archiveらしいファイル名で限定検索したが該当するDB dumpやvolume archiveは見つからなかった。
- Windows側の別ドライブ、バックアップソフト、File History、クラウド同期、ユーザー指定ディレクトリは調べていない。したがって「バックアップが存在しない」とは断定できない。
- Docker Desktop disk fileは存在を確認したが、既存コピー・復元用コピーは確認していない。disk fileの存在だけではバックアップにならない。
- Compose定義は再作成用の設定であり、volumeデータのバックアップではない。

Docker公式はvolume dataがcontainer image/commitには含まれないため、named volumeは別に保全するよう説明し、helper containerとtarを使うvolume backup/restore例を示している。[Docker volume backup/restore](https://docs.docker.com/engine/storage/volumes/)

PostgreSQL `pg_dump`は一貫した単一DB dumpを作り、custom archive (`-Fc`) は`pg_restore`で柔軟に戻せる。またdumpは通常より新しいPostgreSQLへロードできるため、Docker Engine・Postgres image更新前の追加保全として有効。ただし今のDB containerは停止しているので、この調査中にdumpすることはできず、起動・DB接続は実施していない。[PostgreSQL 16 pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html)

## 推奨する保全手順（別途許可後）

### 1. 変更前の記録

1. Docker Desktop、Engine、Composeの版を記録する。
2. container/image/volume/network一覧、各containerのmount・port・restart policy、Composeファイルの場所を安全な作業記録へ保存する。環境変数、ログ、DB内容は記録しない。
3. Docker Desktop GUIでbackendがWSL2であること、Disk image locationの実値を確認する。標準位置と異なる場合はGUI表示の位置を正とする。
4. `tunescout_postgres_data`、Redis anonymous volume、2つのSupabase volumeを保全リストとして固定する。volume pruneやCompose downの`-v`は使用しない。

### 2. PostgreSQL論理dump

更新前の個別承認後、tunescout DBを起動して接続可能なことを確認し、適切なDB接続手段で`pg_dump -Fc`を実行する。認証値をコマンドライン、ログ、報告へ出さない。dump成功後にファイルサイズとSHA-256を確認し、必要に応じて別の使い捨てDBへrestore検証する。restore検証はDB作成・書込みを伴うため別途許可対象。Supabase local DBも保持価値のあるデータがあるなら同様に別dumpを検討するが、現状の利用データ有無は未調査。

### 3. Docker Desktop全体のcold copy（Windows側ユーザー作業）

1. すべての必要なDocker workloadを終了し、Compose停止後にDBが正常停止したことを確認する。現在tunescoutはすでにExited、Supabase stackも停止中。
2. WindowsのDocker DesktopメニューからQuitし、Desktop/WSL backendが完全停止したことを確認する。単にウィンドウを閉じただけでコピーしない。
3. GUIで確定したDisk image locationの`docker_data.vhdx`を、Docker disk imageとは別の物理/論理ドライブへコピーする。
4. コピー後にサイズとSHA-256を確認し、コピー元を上書きしない。容量不足・コピー失敗・コピー後検証不一致なら更新しない。
5. WSL2のUbuntu自身に保存されたプロジェクトデータも復旧対象なら、MicrosoftのWSL export手順で該当distributionを別途exportする。Docker disk imageはWSLの各distribution backupを代替しない。[Docker Desktop backup/restore](https://docs.docker.com/desktop/settings-and-maintenance/backup-and-restore/)

## 復元手順

1. Docker Desktopを終了し、復元先DesktopのbackendとDisk image locationを確認する。
2. 失敗時の現在disk fileを別名で退避してから、保全済み`.vhdx`をDocker公式手順どおり同じbackendの同じパスへ復元する。Desktopの異なるbackendや任意の別バージョンへ直接流用できる保証は未確認。
3. Docker Desktopを起動し、Engineが安定した後、先にcontainer/volume/image/network一覧とvolume名を照合する。prune/reset/migrate promptが出たら承認せず停止して原因調査する。
4. 必要ならPostgreSQL論理dumpを互換性のある空DBへ`pg_restore`する。既存volumeへの上書き復元は行わない。
5. Compose定義からtunescoutを再作成する場合、anonymous Redis volumeが再作成・置換される危険を確認し、既存volumeを明示的に紐付ける復旧計画を先に作る。`docker compose down -v`や`docker volume prune`は使わない。
6. Supabaseはbind検証・Realtime除外問題を別途解決するまで起動しない。

## 更新前の停止条件

- 実際のDocker Desktop disk image location / backendを特定できない。
- disk image cold copyと別置き検証済みコピーがない、または容量・hash検証に失敗。
- tunescout PostgreSQLの重要データ有無を判断できず、論理dumpもない。
- Redis anonymous volumeの対応関係を保持できない。
- 更新候補のDesktop/Engine/Compose互換性、リリースノート、rollback方法を確認できない。
- 更新操作中にReset、factory reset、volume削除、データ移行・上書きが要求される。
- 認識されない既存container/volume差分がある。

## 更新後の検証順序

1. Windows側でDesktop version/backend/disk pathを確認し、WSLから`docker version`と`docker compose version`を確認。
2. 変更前インベントリとの間でvolume名、container定義、image存在、networkを照合する。更新直後にはSupabaseを起動しない。
3. 先のDocker bind隔離試験の許可・手順に従い、自動割当portでHostIPがloopbackだけになることを確認する。`0.0.0.0`または`::`ならprobeを停止し、Supabase再開へ進まない。
4. tunescoutはアプリに必要な接続先がlocalhostでよいことを確認後、別途許可を得てDB単体から起動。データベース名/volume接続、読み取り専用の既知データ照合、アプリ接続を確認する。Redisは保存要件に応じて既存volumeへの接続とデータ要否を確認する。
5. Supabaseはloopback bindが合格し、`--exclude realtime`問題が独立して解決した後にのみ別途許可で再開。health checkより先に全port bindingを確認する。

localhost bind defaultは既存tunescoutのHostIP未指定5432/6379にも影響し得る。ローカル接続は維持できる見込みだが、LAN接続を使っていた場合には到達性が変わる。用途は未確認。Docker Desktop更新は共有Engine/WSL環境へ作用するため、tunescoutとSupabase両方を更新後検証する。

## Windows側で行う作業と今回未実施の操作

**Windows側ユーザー作業：** GUIでbackendとdisk image pathの最終確認、Docker DesktopをQuitしてからのcold copy、別ドライブへの保存、SHA-256確認、必要ならWSL distribution export。

**別途許可が必要：** tunescout/Supabase DB起動、`pg_dump`、volume archive用helper container作成、restore試験、Docker Desktop停止・更新・起動、port binding設定変更。

今回これらの停止・起動・コピー・設定変更は一切実施していない。Docker Desktop版4.44.2は過去のユーザー確認値であり、この調査中にWindows GUIで再確認していない。
