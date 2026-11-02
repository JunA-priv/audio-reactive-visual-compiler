# Step 7b：Local only設定後のDocker bind最終検証

日付：2026-11-01  
状態：**completed（隔離Docker検証）**

## 結果

Docker Client/Serverは29.9.2 / 29.9.2で接続成功。依頼者提示のDocker Desktop 4.97.0へ更新後、Port binding behaviorをLocal onlyに設定した環境で、HostIP省略publishがlocalhost限定になることを確認した。

`arvc-supabase-loopback`にて既存`redis:7-alpine`を使い、`--publish 6379`相当の動的port指定で一時probeを起動した。`docker inspect`の`NetworkSettings.Ports`は次のとおり。

| HostIp | HostPort | 判定 |
|---|---:|---|
| `127.0.0.1` | `32768` | IPv4 loopback |
| `::1` | `32768` | IPv6 loopback |

wildcard `0.0.0.0` / `::`はなく、localhost限定として合格。これはDockerの実効bind metadata確認であり、別ホストから到達できないことをネットワーク越しに実接続して検証したものではない。

## 既存資源の保全

試験前後で既存containerは停止中の`tunescout-redis-1`と`tunescout-db-1`のまま一致。volume一覧（tunescout DB/Redis、Supabase DB/Storageの計4件）、image一覧も一致。`arvc-supabase-loopback`の`host_binding_ipv4=127.0.0.1`等のoptionは維持され、試験後の接続container数は0。一時probeは停止・削除済みで、`/data`をtmpfsにしたためvolume追加もない。

Supabase Stack、tunescout container、既存volume/network、Docker設定への変更はない。

## Supabase Stack再開判断

DockerのHostIP省略時bind条件は合格したため、このport-binding確認だけを理由とする停止は解除できる。ただし、既知の`supabase start --exclude realtime`でもRealtimeが起動した独立問題が未解決であり、今回その挙動は検証していない。したがってSupabase Stack全体の再開準備完了とは判定しない。Realtime除外の検証と、別途明示された起動許可が得られるまではStackを起動しない。

## 手順・境界

1. Docker client/server、container、volume、network、image一覧をread-only取得。
2. 専用network上に一時Redis probeを起動し、実効HostIp/HostPortをinspect。
3. probeだけ停止・削除。
4. 既存container/volume/network/image一覧を再取得し、基準状態との一致を確認。

Docker Desktop設定変更、daemon/Firewall変更、既存volume削除、Supabase/tunescout起動、Hosted Supabase接続、GitHub pushは行っていない。
