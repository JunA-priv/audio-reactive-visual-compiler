# Step 7b：Docker Desktopポート公開設定の最終調査

日付：2026-10-31  
状態：**completed（read-only調査）**

## 結論

**現行構成のまま、Supabase CLIからPostgres portを確実にloopbackへbindするサポート済みper-project設定は確認できない。** 固定版Supabase CLI v2.122.0はDocker HostIPを省略し、既定bindingに委ねる。公式`config.toml`の`db.port`はポート番号のみで、bind IP項目はない。専用networkの`host_binding_ipv4=127.0.0.1`も、前回のDocker Desktop 4.44.2実測では効かず、IP省略publishは`0.0.0.0`と`::`へbindした。

Docker Desktopのport binding settingsは**4.52.0で追加**された。現行4.44.2にその設定はないとrelease historyから判断できる。既定publish addressをlocalhostへ変える設定はDesktop側の設定で可能と現行公式Network docsにある。[Docker Desktop release notes](https://docs.docker.com/desktop/release-notes/)、[Networking on Docker Desktop](https://docs.docker.com/desktop/features/networking/)

したがって推奨する次の操作は、Supabaseを起動することではなく、別途許可を得てDocker Desktopを、port binding settingsを備える現在利用可能な安定版へ更新し、公開portの既定値をlocalhostへ設定して、使い捨てcontainerで再検証すること。調査日現在のrelease notes掲載版は4.97.0（2026-10-26）。4.52.0はport binding settings導入版だが、同版はEngine v29.0.0を含み、現在の4.44.2 / Engine 28.3.2からEngine major versionも変わる。4.52.0自体は現行版ではない。[Docker Desktop release notes](https://docs.docker.com/desktop/release-notes/)

## 確認した事実

### Docker Desktop・Engine状態

| 確認項目 | 結果 |
|---|---|
| Docker Desktop | 4.44.2（ユーザー確認値。WSLからGUI版番号を独立取得していない） |
| Engine | 28.3.2、Docker Desktop、WSL2 kernel `6.6.87.2-microsoft-standard-WSL2` |
| 現在の有効なdefault bridge | `com.docker.network.bridge.host_binding_ipv4=0.0.0.0` |
| Supabase専用network | `com.docker.network.bridge.host_binding_ipv4=127.0.0.1`, IPv6 disabled, containerなし |
| Docker Engine API info | `DefaultAddressPools=null`; `docker info`はdaemonの全起動引数/Engine JSONを公開しない |
| WSL内daemon設定ファイル | `/etc/docker/daemon.json`、`~/.docker/daemon.json`とも不在 |
| Desktop settings store | Windows側`settings-store.json`にport/bind/HostIP/default-IP/engine名を含む設定キーなし。Docker Desktop GUIのEngine JSON全体は今回読めておらず、そこに独自`ip`設定があるかは未確認 |

前回の隔離試験では、専用networkのoptionが`127.0.0.1`である状態でIP省略publishがIPv4/IPv6 wildcardになり、IPを明示すると`127.0.0.1`になった。これはmetadata上のbind結果であり、外部interfaceから実接続した結果ではない。[隔離検証報告](2026-10-31-step7b-docker-bind-isolated-test.md)

**原因の確定範囲：** CLIのHostIP明示ではなく、Docker Engine/DesktopのIP省略時の既定公開処理がwildcard結果を返すところまでは確定。Desktop backend、Engine API、custom bridge optionのどこでloopback optionが失われるかは未確定。Docker release notesはGUIが`0.0.0.0`を強制しbridge optionを無視する不具合を4.38.0で修正したと記す。4.44.2は修正後の版なので、その既知bugだけを根拠に今回の症状を説明できない。4.52.0ではport binding settingsが追加されるが、同じbugの修正との明記はない。[Docker Desktop release notes](https://docs.docker.com/desktop/release-notes/)

Docker Engineの`--ip`は、公式仕様上default bridge network向けの既定publish IPであり、Supabase CLIが使うcustom bridgeのnetwork optionとは対象が異なる。Engine設定の`ip`を変えるだけでは、このcustom networkでの実測を解決できる保証がない。さらにdaemon-wide変更なら他のDocker projectにも影響する。[dockerd reference](https://docs.docker.com/reference/cli/dockerd)、[bridge network options](https://docs.docker.com/reference/cli/docker/network/create/)

### Supabase CLI v2.122.0

GitHub release v2.122.0はcommit `5afad87`として署名確認済みである。[v2.122.0 release](https://github.com/supabase/cli/releases/tag/v2.122.0)

固定版の`apps/cli-go/internal/db/start/start.go`では、Postgres containerのHostConfigを次の形で組み立てる。

```go
PortBindings: nat.PortMap{"5432/tcp": []nat.PortBinding{{HostPort: hostPort}}},
```

`HostIP`は指定していない。`supabase start --network-id`は使用networkを指定するもので、HostIPを渡すオプションではない。公式CLI設定表にある`db.port`もhost port numberのみである。従って今回のwildcard結果は、CLIが`0.0.0.0`を明示したためではなく、Desktop/Engineの既定publish addressへ委ねた結果と整合する。[v2.122.0 Postgres start source](https://github.com/supabase/cli/blob/5afad87/apps/cli-go/internal/db/start/start.go#L117-L140)、[Supabase CLI config](https://supabase.com/docs/guides/local-development/cli/config)

CLIの`--help`をローカル実行しようとした際、npm shimが`~/.supabase/telemetry.json`へ書き込もうとしてread-only filesystem errorになった。`start`処理は実行していない。実装判断は公式releaseの固定ソースとDocker API実測に基づく。

## 対応案の比較

| 案 | loopback保証の評価 | 影響 / 判断 |
|---|---|---|
| 既存custom networkの`host_binding_ipv4` | 不十分。Docker単体probeでwildcardとなった | 既に設定済みだが現環境では安全策として信用できない |
| Supabase CLI `db.port` / `--network-id` | bind IPを指定できない | port番号/ネットワーク選択の設定であり、loopback解決ではない |
| Docker Engine `--ip` / daemon `ip` | 今回のcustom bridgeへの適用は保証されない。公式仕様ではdefault bridge向け | daemon-wideで他projectにも影響し得るため、現状では推奨しない |
| Docker Desktop 4.52+ port binding settingをlocalhostにする | Desktop公式のglobal既定設定として解決可能性が最も高い | 4.44.2から更新が必要。全Docker publishの挙動に波及するので、update後に既存projectも確認する |
| Supabase CLI fork/直接Docker API patch | loopback IPを明示すれば理論上可能 | 保守負担・未サポート変更。今回の安全な最小対応ではない |

**現行4.44.2で確認済みの安全なSupabase専用回避策はない。** Desktopを更新しない場合、Supabase stackは停止状態のまま維持するのが安全。明示IPを使う自作wrapper・CLI patch・firewall調整は今回の範囲外かつ未検証。

## tunescoutへの影響

- Desktop更新は共有Docker daemonを再起動し、実行中containerを止める可能性がある。今回確認時は`tunescout-db-1`と`tunescout-redis-1`ともExitedだった。
- 両containerの保存PortBindingsはHostIP空欄、host port 5432/6379。新しいlocalhost-default設定は、これらの公開address/到達範囲にも影響する可能性がある。localhost接続は継続できる見込みだが、LANからアクセスしている用途があれば利用できなくなる。用途は未確認。
- `tunescout_postgres_data`およびSupabase volumesは保持されている。更新時にvolumeを削除・resetしない。Docker Desktop/Engine更新後の既存container metadata/data disk互換性は今回実証していないため、必要DBの論理backupとDocker Desktop data diskの復旧計画を更新前に用意する。
- 更新でEngine 28から29系へ変わる可能性があり、tunescout image、既存container起動、Compose互換性も再検証が必要。

## 推奨する次の操作

1. 本調査では環境変更しない。Supabase Stackは停止状態を保つ。
2. 別途L3変更許可を得た後、更新候補の公式release notes、Windows/WSL要件、Engine/Compose同梱版、tunescout backup/復旧方法をレビューする。調査日現在の候補はDocker Desktop 4.97.0。更新時はDocker Desktop設定でport binding defaultをlocalhostにする。
3. Desktop更新後、Engine/WSL接続、port binding settingの反映を確認する。自動port割当の使い捨てcontainerでHostConfig/NetworkSettingsと`docker ps`を照合し、`127.0.0.1`/`::1` loopbackのみを確認する。wildcardなら即停止しSupabaseを開始しない。
4. `tunescout_postgres_data`など既存volume、停止container、アプリが必要とするlocalhost接続をread-onlyで確認する。tunescoutを起動する必要があれば別途許可を得る。
5. bind試験合格後、さらに別途許可を得て初めてSupabaseを起動し、全published portをhealth testより先に確認する。Realtime除外問題は独立に検証する。

## 作業境界

Docker info/network inspect、settings-storeのkey名確認、固定版CLIソース、Docker/Supabase公式資料のread-only調査のみ。Docker設定変更、Desktop更新、Stack起動、container/network/volume変更、Hosted Supabase、GitHub pushは実施していない。
