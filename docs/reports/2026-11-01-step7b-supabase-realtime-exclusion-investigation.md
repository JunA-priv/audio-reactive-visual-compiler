# Step 7b：Supabase Realtime除外問題の調査

日付：2026-11-01  
状態：**partial（安全な無効化方法を確認。過去の起動原因は確定できず）**

## 要約

Supabase CLIの公式仕様では`supabase start --exclude realtime`でRealtime containerを除外でき、`[realtime].enabled = false`もローカルRealtime serviceを無効化する正式なconfig optionである。今回の`supabase/config.toml`は現在`[realtime] enabled = true`。次の起動検証では両方の指定を併用するのが最も明確である。

一方、過去の起動観測は「Realtime image/containerも起動していた」とだけ記録し、container名、running/exited状態、port、start時刻、CLIの実引数と出力が残っていない。従って、長時間稼働するRealtime serviceが除外を破って起動したのか、DB初期化用の一時containerだったのか、image pullをcontainer起動と取り違えたのかを現在のread-only証拠だけでは特定できない。Stack起動は禁止されているため原因確定のための再現はしていない。

Port bindingのLocal only確認は済んでいるが、Realtimeの実測memoryと、Auth/Data API/Storage/PostgreSQL healthへの影響はStack未起動のため未検証。**現時点ではRealtimeを許容してStackを再開する案は推奨しない。** 支持済みconfigで無効化する方向を推奨し、別途許可された最小起動検証で確認する。

## 一次資料・ローカル状態で確認した事実

### `--exclude`とRealtime config

- Supabase CLI command referenceは`start --exclude`を「起動しないcontainer名の指定」と定義し、許容名に`realtime`を明記する。また複数名をカンマ区切りまたはflag複数回で指定できる。[Supabase CLI start reference](https://supabase.com/docs/reference/cli/supabase-start)
- 固定CLI v2.122.0は2026-10-23 releaseで、Go CLIの`--exclude`名には`realtime`が含まれる。[Supabase CLI v2.122.0 release](https://github.com/supabase/cli/releases/tag/v2.122.0)、[公式Go CLI reference（旧Go CLI help parity）](https://github.com/supabase/cli/blob/develop/apps/cli/docs/go-cli-reference.md)
- Supabase CLI config referenceは`realtime.enabled`を「Enable the local Realtime service」と定義し、設定変更後は`supabase stop`→`supabase start`で反映すると説明する。[CLI config reference](https://supabase.com/docs/guides/local-development/cli/config)
- ローカルの`supabase/config.toml`は`[realtime] enabled = true`。値を変更していない。
- v2.122.0のrelease notesにRealtime excludeの仕様変更は記載されていない。[v2.122.0 release](https://github.com/supabase/cli/releases/tag/v2.122.0)

### 現在のDocker状態

- Docker Engine 29.9.2、Docker報告memory 7,925,329,920 bytes（約7.38 GiB）、16 CPUs。
- `arvc-supabase-loopback`は空で、network optionは`host_binding_ipv4=127.0.0.1`、IPv6 disabled。
- tunescoutの2 containerは停止中。Supabase service containerは存在しない。Supabase DB/Storage volumesは保持されている。
- Local only設定後の隔離Redis probeで、HostIP省略publishは`127.0.0.1`と`::1`のみになることを確認済み。ただし個々のSupabase serviceのHostConfigはまだ確認していない。
- 現在のEngine memory値は割当上限であり、空きmemoryやRealtime稼働時の安定性を示す値ではない。

## 過去の観測と原因評価

前回の環境構築報告は、`--exclude studio,realtime,imgproxy,postgres-meta,edge-runtime,logflare,vector,supavisor`を指定した起動時にRealtime imageのcontainerも起動したと記録する。しかし、container ID/name、image digest、state、exit code、published ports、時系列や完全な安全化済みCLI invocationは記録されていない。[Step 7b local environment report](2026-10-31-step7b-supabase-local-env.md)

| 区分 | 判断 |
|---|---|
| 確認済み | configでRealtimeがenabled。除外対象にもRealtimeが列挙された。起動試行の際にRealtime関連container/imageを見たという当時の記録がある。 |
| 高確度の候補 | 正式な`realtime.enabled=false`を使わずenabled=trueのままにしていたため、Exclude listの受け渡し・適用に問題があると長期起動サービスが作成された可能性。 |
| 代替候補 | DB初期化がRealtime用一時migration/bootstrap containerを起動した可能性。ただし、確認できたCLI issueは主に`db reset`の初期化処理であり、当時の`start`で同じcontainerが作られたとは断定できない。[CLI issue #6915](https://github.com/supabase/cli/issues/6915) |
| 代替候補 | Image pullまたはimage list上の存在をcontainer起動と解釈した可能性。過去の報告では「container」と記載されているが、一次のinspect出力が保存されておらず排除できない。過去のissueではexclude指定中もimageがpullされる事例が報告され、その後CLI v2.48.3で再現しないとしてcloseされた。これはv2.122.0におけるcontainer起動を証明しない。[CLI issue #4194](https://github.com/supabase/cli/issues/4194) |
| 結論 | `--exclude`の公式契約に対する不具合か、長期serviceではなく一時jobなのか、過去の証跡だけでは根本原因を確定できない。 |

従って「CLI v2.122.0のexclude機能が壊れている」とは結論しない。公式契約上はexclude指定が有効であるはずだが、このリポジトリでの実効性は未検証。より明示的なproject configでRealtimeを無効化するのが支持済みの対応である。

## Realtimeの責務・影響

- RealtimeはBroadcast、Presence、Postgres ChangesをWebSocket等で配信する任意serviceである。Supabase CLIが明示的にexcludeを提供し、公式configも個別にdisableできるため、Realtime機能を使わない通常のAuth、PostgREST Data API、Storage、PostgreSQL起動に必須のruntime dependencyではない。[Supabase local CLI reference](https://supabase.com/docs/reference/cli/supabase-start)
- RealtimeはAuth/RLSの代替ではない。Realtimeを使う場合はRealtime channel authorizationに`realtime.messages`のRLS policyやJWTを使用する。Data APIの認可は引き続きPostgreSQL grants/RLSで行う。[Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization)、[Securing your API](https://supabase.com/docs/guides/api/securing-your-api)
- Realtimeを動かすと、WebSocket/Broadcast/Presence/DB changeの追加攻撃面とDB connection/migration/loadが発生する。Local onlyのDocker default bindは一般的なhost-IP省略publishをloopbackに制限することを実測済みだが、実際のSupabase container port全件は起動後に個別inspectする必要がある。loopback bindはローカルユーザー間の認可を提供しない。
- Supabase CLI referenceは全service起動に少なくとも7 GB RAMを推奨する。現行Docker割当は約7.38 GiBで推奨値をわずかに上回る。これは使用可能な余裕量ではなく、Realtime単体のmemory要求/実測はないため、稼働安定の根拠にはならない。
- Step 7bではRealtimeを使わない前提なので、Realtimeを許容して得る機能上の利益はない。

## 推奨設定と次回の安全な検証手順

本調査中はconfigを変更しない。次の起動を別途許可する前に`supabase/config.toml`の`[realtime] enabled = false`を適用し、起動時にも`--exclude realtime`を指定することを推奨する。これは正式config optionと正式flagの重複指定である。変更後の起動には別途許可が必要。

### 起動前

1. 適用対象project/workdirとCLI実版がv2.122.0であることを確認。Hosted login/linkを使用しない。
2. Realtimeが不要であることを再確認し、config falseと`--exclude realtime`を使う。
3. `arvc-supabase-loopback`のLocal only bind設定、既存container/volume/network baselineを確認する。Realtimeに関連しないvolumeの削除・resetは行わない。
4. Docker memory割当は約7.38 GiBで、全service推奨7 GBをわずかに上回るのみであることを認識し、他の重いcontainerが停止していることを確認する。

### 起動と診断

1. 起動は別途許可された後に限る。`supabase start --network-id arvc-supabase-loopback --exclude realtime`を対象workdirで実行し、`--ignore-health-check`は使用しない。
2. CLI出力にはlocal API keys/DB connection informationが含まれ得る。ログ保存・共有をせず秘密値を記録しない。`supabase status -o env`も使わない。
3. 起動直後に`docker ps -a`でRealtime関連containerを確認する。name、image、state、created/started/finished時刻、portsだけを記録し、envやログ本文は出力しない。`docker inspect`は`.NetworkSettings.Ports`、`.State`、`.HostConfig.RestartPolicy`だけを選択して表示し、envは採取しない。
4. 直ちに終了する短命jobなら、長期serviceと区別する。そのjobにhost portがあるかを確認する。`running`状態のRealtime serviceがあれば、`realtime.enabled=false`とCLI実引数を再確認して成功扱いにしない。
5. Auth/PostgREST/Storage/Postgresのhealthは各サービスを個別確認する。個別の全published HostIpが`127.0.0.1`または`::1`であることをhealth requestより先に確認し、wildcardや予期しないportが一つでもあれば公開を使わず停止する。
6. Docker `stats --no-stream`等で起動直後および安定後のmemoryを測る。OOM/restart/health failureまたは低いmemory headroomがあれば停止し、Realtimeを含む全stackの安定性を推定しない。

### 停止

停止の個別許可後、対象workdirで`supabase stop`のみを使う。`--all`、`--no-backup`を付けず、`docker volume rm`、`docker volume prune`、`docker compose down -v`は実行しない。停止後にcontainer状態とSupabase DB/Storage volumeの存在を確認する。

## 起動を許容するか

**推奨：Realtimeは無効にし、起動しない。** 正式設定で止められる可能性が高く、今回必要なAuth/DB/Data API/StorageにRealtime機能は不要。現memory割当がCLI推奨値に近く、Realtime稼働時のメモリや他サービス正常性も実測されていない。

Local only port settingはDocker一般probeで成功済みだが、Supabase全container port binding確認は未実施。このため、仮にRealtimeを許容する案も、port conditionとmemory conditionが実際のStackで満たされるまでは成立しない。条件を満たしても、Realtime serviceを不要とする現要件では無効化が単純である。

## 今回の作業境界と未確認

Supabase公式資料、release notes、過去報告、`supabase/config.toml`、Docker info/ps/volume/networkをread-onlyで確認した。Docker Engineは29.9.2、memory 7,925,329,920 bytes、16 CPUs。Supabase Stack/containerは停止状態のまま。config、container、volume、network、tunescout、Hosted Supabaseには変更なし。

未確認：過去Realtime containerの完全な識別と生存時間、v2.122.0の当時の実CLI argv/安全化済み出力、v2.122.0 `start`の初期化過程における一時Realtime jobの有無、config falseとflagの実効挙動、実stackの全公開ports、Auth/Data API/Storage health、Realtimeを含めた実memory、Auth RLS等の具体的な機能回帰。
