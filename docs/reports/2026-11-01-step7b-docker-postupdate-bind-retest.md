# Step 7b：Docker更新後のlocalhost bind再検証

日付：2026-11-01  
状態：**completed（隔離検証）**

## 結論

Docker Desktop 4.97.0 / Engine 29.9.2環境でも、`arvc-supabase-loopback`上のHostIP省略publishはlocalhost限定にならなかった。自動割当port `54127`は`0.0.0.0`と`::`にbindした。wildcardを検出後、該当probeを直ちに停止し削除した。

比較用の明示`127.0.0.1`publishは、自動割当port `51493`で`127.0.0.1`のみとなった。したがって、Docker自身の明示loopback bindingは動作するが、今回検証したnetwork option `host_binding_ipv4=127.0.0.1`はIP省略publishを制限しなかった。Supabase CLI v2.122.0がHostIPを省略する既知の構成を踏まえ、**Supabase Stackは再開不可のまま**とする。Desktopのglobal port binding設定値をこの検証時にGUIから確認・変更していないため、その設定が適用されていたかは未確認。

## 検証内容

- Docker client/server: 29.9.2 / 29.9.2。Operating System: Docker Desktop。WSL kernel: `6.6.87.2-microsoft-standard-WSL2`。
- Docker Desktop 4.97.0は依頼者提示値で、GUIから独立確認していない。
- `arvc-supabase-loopback`: bridge。`host_binding_ipv4=127.0.0.1`、IPv4 enabled、IPv6 disabled。試験前は接続containerなし。
- 既存の`redis:7-alpine`を再利用し、`/data`はtmpfsでmount。自動割当portを使い、volumeを作らなかった。

| 試験 | Docker publish指定 | 実効`HostIp` | HostPort | 判定 |
|---|---|---|---:|---|
| 既定bind | `6379`（HostIP省略） | `0.0.0.0`, `::` | 54127 | wildcard。即時停止 |
| 明示bind比較 | `127.0.0.1::6379` | `127.0.0.1`のみ | 51493 | loopback限定 |

この判定はDocker `inspect`の実効metadataに基づく。LAN端末など別ホストから接続できるかの実通信試験はしていない。

## 既存資源の保全

probe前後で既存containerは`tunescout-redis-1`と`tunescout-db-1`の停止状態のまま一致。volumeは既存4件（tunescout Postgres、Redis anonymous、Supabase DB、Supabase Storage）で一致。image一覧も一致。network `arvc-supabase-loopback`のoptionは維持され、試験後の接続container数は0。新規probe containerは両方停止・削除済み。Supabase Stack、tunescout container、既存volume/network、Docker Desktop設定への変更はなし。

## 判断と次の手順

1. 現状ではSupabase Stackを起動しない。CLIのHostIP省略publishでwildcardになることを確認したため。
2. 別途承認後、Windows側Docker Desktopのport binding設定でlocalhost defaultが実際に有効か確認し、設定変更をする場合は影響範囲を確認する。
3. 設定後に同じ隔離probeを繰り返し、IP省略時にIPv4/IPv6ともloopback addressだけになることを先に確認する。wildcardなら即停止する。
4. bind試験合格後もRealtime除外問題は独立した停止事項として扱う。両方の停止事項が解消し、別途許可を得るまでSupabase Stackを再開しない。

## 作業境界

Docker version/info、container/volume/network/image一覧とinspectをread-only取得。専用networkで一時Redis probeを2つ順番に起動し、IP省略probeはwildcard検出直後に停止、両probeを削除した。DB接続、Supabase起動、tunescout起動、Docker Desktop/daemon/Firewall設定変更、既存volume削除、Hosted Supabase接続、GitHub pushは行っていない。
