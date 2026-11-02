# Step 7b：Docker bind設定の隔離検証

日付：2026-10-31  
状態：**completed**

## 結果

Docker Desktop 4.44.2 / Engine 28.3.2上で、専用network `arvc-supabase-loopback`の`host_binding_ipv4=127.0.0.1`は、ホストIPを省略したDocker publishの既定値としては効きませんでした。Docker単体の一時containerでもワイルドカードbindが再現したため、Supabase CLI固有の原因だけでは説明できません。

| 試験 | Publish指定 | inspect結果 |
|---|---|---|
| 既定bind | `-p 6379`（host IP/portを指定せず、自動port割当） | `HostConfig.PortBindings`: HostIp/HostPort空欄。実効`NetworkSettings.Ports`: `0.0.0.0:52540`と`[::]:52540` → container 6379/tcp |
| 明示bind | `-p 127.0.0.1::6379`（host port自動割当） | `HostConfig.PortBindings`: HostIp `127.0.0.1`。実効`NetworkSettings.Ports`: `127.0.0.1:59560` → container 6379/tcp |

既定bindはIPv4/IPv6 wildcardを検出した直後に停止しました。明示bindはloopback HostIpのみを確認しました。TCP接続試験や外部interfaceからの到達試験は行っていません。

## 実施手順・資源

1. 専用networkをread-only確認：bridge、`com.docker.network.bridge.host_binding_ipv4=127.0.0.1`、IPv4有効、IPv6無効、接続containerなし。
2. ローカルimage一覧を確認。既存の`redis:7-alpine`（image ID `bb186d083732`、約60.6 MB）を再利用。image downloadなし。
3. network上に一意名の一時Redis probeを作成。外部宛bindを検出したdefault probeは即stop。
4. 明示loopbackの比較probeを作成してinspect。
5. 2つのprobeをstop/rm。
6. Redis imageが`/data` volumeを宣言するため、両probeが作ったと作成時刻と事前volume inventoryで識別できた匿名volume 2件だけを削除し、試験前のvolume inventoryへ戻した。
7. 最終一覧で両probeがなく、tunescout DB/Redisが元の停止状態、専用networkのoptionと空のattachment、既存Supabase/tunescout volume、image inventoryが試験前と一致することを確認。

この試験では既存tunescout container、既存Supabase DB/Storage volume、いずれのnetworkも変更していません。Docker Desktop更新、daemon/Firewall変更、Supabase Stack起動も行っていません。

## 判定と残る不確実性

- **FACT：** networkのhost binding optionが設定済みでも、Docker Desktop上のIP省略publishでは実効bindが`0.0.0.0` / `::`だった。
- **FACT：** host IPを明示すれば同じimage・networkで`127.0.0.1` bindとなった。
- **判断：** まずDocker Desktop/Engineのdefault published-port処理、設定適用、またはこの環境での既知動作を調べる。Docker単体でも再現したため、Supabase CLIだけを根因とする説明は不十分。Supabase CLI v2.122.0が別途HostIPを明示している可能性は未確認。
- **未確認：** Windows hostや別LAN interfaceから実際に到達できるか、Docker DesktopのGUIで設定できるlocalhost defaultが4.44.2に存在するか、Engine APIのport bindingに別の既定値があるか、Supabase CLIがHostIPをどう指定するか。

次回はSupabaseを再起動せず、Docker Desktop 4.44.2の設定情報とDocker Engine/CLIへのpublish要求の処理をread-onlyで確認する。明示bindによるSupabase起動を検討する場合は、Supabase CLIがhost bind IPをサポートする設定手段を先に確認し、存在しなければ別途安全な方法の許可を得る。現状のnetwork optionだけで外部bindを防止できると見なさない。
