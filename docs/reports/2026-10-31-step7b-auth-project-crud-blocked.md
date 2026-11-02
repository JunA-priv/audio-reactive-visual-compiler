# Step 7b — Supabase Auth・Project CRUD実装

日付：2026-10-31
状態：**blocked（ローカルSupabase統合環境を利用できないため未実装）**

## 結果

指定された順序で既存資料、Step 7a設計報告、CURRENT_TASK、現行Frontend Project型・validator、Go API型・validatorを確認した。DockerとSupabase CLIはread-onlyで利用可否を確認した。ローカルSupabase Auth、PostgreSQL、Data API/RLS統合を安全に起動できないため、ユーザー指定の停止条件に従い、migration・JWT/API実装・依存変更を開始せず停止した。

本番/Hosted Supabaseへは接続していない。データ削除・reset、Gemini API、GitHub pushも行っていない。

## 環境確認

| 確認対象 | 結果 |
|---|---|
| `docker` | PATH上にはWindows Docker Desktop配下のCLIがあるが、WSL実行時に「Docker command could not be found in this WSL 2 distro」「activate WSL integration」と返り、daemonへ接続できない |
| `podman` | command not found |
| `supabase` CLI | command not found |
| `psql` / `postgres` / `pg_isready` | PATH上で見つからない |
| local Supabase/PostgreSQL ports | 確認に使った`ss`で5432/54321–54324のlistenerを確認できず |
| Hosted Supabase | 禁止のため接続せず |

従って、Auth発行token、JWKS、PostgREST認証、RLS、Data API直接アクセス遮断の必須統合試験が実行できない。Docker DesktopのWSL integrationを変更することは今回の許可範囲外の環境変更とみなし、実施していない。Supabase CLIのインストールだけでは実行engineが利用できず、この停止条件を解消しない。

## 最小実装契約との照合

### 既存Project/Blueprint/Timeline構造

- `EditorBlueprint`は`version: 1`、`width`、`height`、`seed`、`background`、`regions`、`effects`、`bindings`を持つ。
- Backgroundはsolid/gradient/image。imageの`src`はPNG/JPEG base64 data URLであり、素材を必要とするProjectは拒否する今回契約では受理対象外にする必要がある。
- Regionはrectまたはpolygon。Effectは`pulse-scale`、`glow-brightness`、`rotation-movement`、`particles`、`waveform-bars`。各EffectにはRegion参照と対応するBindingが必要。
- `FeatureTimeline`の必須フィールドは`durationMs`、`bassEnvelope[{timeMs,value}]`、`kickEvents`。Project fileにはschema version等のmetadataや解析側の加算フィールドも存在する。Step 7bは既存v1のBlueprint/Timeline shapeを保持し、`.arvproj` container metadataやembedded assetsをDBへそのまま受け入れない必要がある。
- Frontend validatorは座標、列挙、有限数値、参照整合性、系列上限等を検証する。Go APIの現validatorはMusic Summary/Feature Timeline入力用で、`EditorBlueprint`／Project documentのvalidatorではない。Project CRUD実装にはGo側の独立した厳密validatorが必要になる。

### 契約との境界

- 20 Projects/user、編集データ1 MiB/件、revision競合、5 CRUD endpoints、401/404、hard deleteは本作業でユーザーから確定契約として受領した。
- 素材を必要とするProjectを拒否するため、audio assetを持つ`.arvproj` fileやimage BackgroundのEditorBlueprintをクラウドProject APIへ保存できない。ローカル`.arvproj` v1のimport/export機能自体は変更しない。
- Project JSONのAPI wrapper（metadata / blueprint / featureTimeline）、revision表現、HTTP method/path/bodyの細部は今回の指示で完全指定されていない。Step 7aは案を出したが、ユーザーの確定した「5 endpoints」契約と矛盾しないよう、実装時に最小REST契約を報告書へ明記する必要がある。既存正式API契約の無断改定はしない。

## 実装・検証状況

| 項目 | 状態 |
|---|---|
| Step 7専用migration | 未作成。環境停止のため |
| RLS / GRANT / DB constraints | 未実装・未検証 |
| JWT/JWKS検証 | 未実装・未検証 |
| Go Project CRUD 5 endpoint | 未実装 |
| Project/Blueprint/Timeline validation | 既存Editor validationは確認。Go側Project validatorは未実装 |
| Auth、owner分離、direct Data API、異常系統合試験 | 実行不可 |
| Go / Frontend回帰 | 本作業では未実行。新規コードがなく、必須Supabase統合前提で停止 |
| `.arvproj`、Renderer、Python、Gemini、Hosted環境 | 変更・利用なし |

## 再開に必要な条件

1. WSLでDocker DesktopのWSL integrationを利用できる状態にするか、許可された同等のローカルcontainer runtimeを用意する。
2. Supabase CLIを利用可能にする（versionを固定し、依存/環境変更として記録）。
3. `supabase start`がloopbackのlocal stackとして起動し、Auth、PostgreSQL、Data APIを利用できることを確認する。外部bindやHosted project linkはしない。
4. Auth token/JWKS、Data APIへuser JWTを送る経路、RLS/GRANT deny-by-defaultをUser A/Bおよびanonで検証できることを確認する。
5. これらを確認できた後に限り、新規ローカル環境専用migrationとGo実装へ進む。

## 変更範囲

- `CURRENT_TASK.md`：Step 7bのscopeとblocked理由に更新。
- `docs/CURRENT_STATE.md`：停止した事実と詳細報告への参照を追記。
- 本報告を追加。
- アプリコード、Go/Frontend依存、DB、migration、Supabase設定、Hosted/cloudは変更していない。
