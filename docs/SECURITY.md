# セキュリティ方針

## 現行AI provider（Step 7i更新）

実AI生成はOpenAI Responses APIの`gpt-6-luna`をサーバー側から呼び出す。`OPENAI_API_KEY`はAPIサーバー環境だけに置き、Frontendへ渡さず、値やAuthorization headerをログへ出さない。Fixture modeは既定で外部AI通信なし。AI生成時も検証済みJWT、DB entitlement、Idempotency-Key、原子的budget予約、user/service quota、concurrency制御、二重kill switchをprovider呼び出し前に維持する。Migration 018はlocal DBへ適用済み、Hostedには未適用。アプリ内budgetは請求上限を保証せず、provider側spend capと鍵のproject restrictionは公開前に別途設定・検証が必要。

OpenAIにはMusic Summary、短縮Feature要約、Blueprint schema/promptだけを送る。音源、Stem、画像、個人情報は送らない。拒否、不完全応答、不正JSON、HTTP error、timeout、usage欠落を成功扱いしない。曖昧なusageでは予約を保持する。今回、実API requestは未実施。

DECIDED：JWTの署名とissuer/audience/期限等を検証し、APIと保存先で所有者を照合する。未認証デモは固定素材のみとし、有料解析を開放しない。

DECIDED：形式・サイズ・長さ・展開後容量を検査する。メディア処理は最小権限・時間/メモリ制限で隔離する。AI応答はスキーマ検証し、任意コードを実行しない。

DECIDED：SecretはGo/ジョブ側で管理し、VITE_変数へ秘密を入れない。署名URL、DB管理キー、JWT、音源をログへ不用意に出さない。

FACT（Step 7b local only）：Go APIは明示有効化時だけSupabase user access tokenをES256/JWKSで検証し、loopback issuer、audience/role=`authenticated`、exp、UUID subを要求する。CRUDは検証済み利用者JWTとanon/publishable keyだけでData APIへ接続し、通常処理にservice_roleを使わない。PostgreSQL FORCE RLS、owner predicate、DB trigger/RPCで所有者、20件、1 MiB、revision制約を適用する。JWT、API key、DB response bodyはログしない。local Auth/Data API integrationでA/B分離・anon拒否・直接REST制約を確認。これはHosted Supabase用設定ではない。

FACT（Step 7c-1 local only）：Go APIのAsset ready確定だけは`SUPABASE_ASSET_VERIFIER_DSN`でPostgreSQLへ直接接続する。接続role `arvc_asset_verifier`はLOGIN、NOBYPASSRLS、NOINHERIT、非superuser、membershipなし、projects/project_assets表権限なしで、非公開`arvc_internal.project_asset_mark_ready`だけEXECUTEできる。通常Project CRUDとStorage APIは引き続き利用者JWT + Data API/Storage RLS。service_roleはアプリ実行経路に使わない。DSNはGit除外のサーバー側`api/.env`にのみ置き、Frontend/VITE設定、ログ、API応答へ含めない。remote DSNは`sslmode=verify-full`を必須にする。専用関数は`search_path=''`、完全修飾名を使い、owner/Asset/pending状態/object key/Storage ownerを再確認する。関数ownerはSupabaseの`postgres`でSECURITY DEFINERとなるため、内部関数本体は高権限境界としてレビュー対象にする。Hostedへの接続・実効role挙動は未検証。

FACT（Step 7d local-only）：Frontend Supabase URLはloopback HTTPだけ許可。`VITE_SUPABASE_ANON_KEY`は公開クライアントkeyであり、service_role/secret/DB verifier DSNは禁止。JWTはtab-scoped sessionStorageに置き、console/status/errorへ出さない。Go API 401ではFrontend sessionを破棄する。Cloud素材はGo Asset API経由とし、FrontendはStorage RLSを迂回しない。download時はAsset metadataのbyte sizeとSHA-256を再検証してからEnvelope hydrateを完了する。XSS耐性をsessionStorageで保証するものではなく、Hosted配信時のCSP/origin/TLSは別途設計が必要。

FACT（Step 7j local-only）：`/app`は未確定の元音源をブラウザ内に保持し、ユーザー確定後に最大60秒のcrop PCM WAVだけをloopback Go解析APIへ送る。Go endpointは既存local Supabase JWTを要求し、multipart 16 MiB、WAV実測形式/duration、global concurrency 1、600秒timeoutを強制する。解析用一時fileはprivate directory・restricted modeで保持し、成功/失敗/timeout/cancelで削除する。元音源全体は解析APIへ送らない。解析結果のSummary/Timelineを別のBlueprint APIへ渡すが、Stem/音源はAI providerへ送らない。確定clipは明示操作によりCloud Asset APIへ保存できる。`.arvproj`にはEditorの現在のaudio fileを埋め込むため、source fileを選択直後にProjectを保存するケースではそのfileが含まれる。`/demo`は固定素材のみで解析/API要求なし。ローカルAPIのsingle-process semaphoreはHosted/複数instance用のDoS防御ではない。

PROPOSED：.arvbは圧縮後AES-256-GCM、Go側鍵管理。nonce再利用防止、形式ヘッダー、key ID、鍵ローテーション、復号後サイズ制限、失効・復旧は未設計。元音源は原則含めず、音声出力時に再選択する。クライアントの完全秘匿は保証しない。

DECIDED：依存は公式アドバイザリと監査で確認し、版と根拠を記録する。audit結果ゼロだけで安全を断定しない。

FACT（2026-10-31）：Python依存のuv.lock固定環境をpip-auditで監査し、照会可能なPyPI依存に既知脆弱性なし。Torch `2.14.1+cpu`はPyPI監査照会不可のため公式PyTorch advisoryを別途確認。Frontend `npm audit`は0 vulnerabilities。

FACT / OPEN：WSL標準FFmpeg `6.1.1-3ubuntu5`にはUbuntu 24.04向け既知security noticesの修正が未適用（複数修正はESM提供）。任意のローカルメディアはFFmpeg処理を経るため、信頼できない入力の本番処理にこの環境を採用しない。更新済み保守版または検証済み限定buildの導入が必要。

FACT：Demucs softwareはMIT表記だが、Demucs maintainerによる説明ではmodel weightsはMIT license対象外でscientific purposesのみ提供。公開・商用処理には個別の権利確認を要する。

FACT（Step 5）：Go APIはloopback `127.0.0.1:8080`でのみlistenする。Gemini keyはGo processの`GEMINI_API_KEY`または`GOOGLE_API_KEY`から読み、Frontendへ渡さず、ログおよび外部向けエラーにも含めない。Fixture modeは既定。Gemini modeでは音源/stem/imageではなくSummaryとTimelineから抽出したcompact feature summaryのみを外部送信する。Gemini応答はコードとして扱わず、宣言的JSONを独立検証してから返す。実通信は未実施。

FACT（Step 5.5、Google Gemini API Additional Terms確認）：Unpaid/Free quotaでは入力/出力がGoogle製品・サービス・機械学習技術の改善/開発に利用され、reviewerが確認する場合がある。Free試験は合成データに限定し、機密/個人情報を送信しない。有料APIでは製品改善に使用しないが、ポリシー違反検出等のための限定期間prompt/response loggingが記載される。Gemini Developer APIでzero retentionを前提にしない。詳細・参照先はStep 5.5報告書。

FACT（Step 7g、local-only）：AI generation routeは`AI_GENERATION_ENABLED=true`の場合にSupabase JWT middlewareを通し、DB `ai_entitlements`を別に確認する。資格はJWT metadataやFrontend状態から導出しない。専用`arvc_ai_budget` DB roleはNOBYPASSRLS/NOSUPERUSER/NOINHERIT、membershipなし、表の直接ACLなしで、private reserve/settle RPCだけEXECUTEできる。入力/出力token上限、ユーザー/service request上限、global/user concurrency、推定費用枠をPostgreSQL singleton row lockで原子的に予約する。同じIdempotency-Keyは409で再実行しない。usage不明時は最大費用予約を保持する。process flagとDB controlの双方で全体停止でき、DB不通時は503 fail-closed。Fixtureも認証・資格・quotaを通るがGeminiへ接続しない。未認証`/demo`は同一originの合成WAVだけを使用し、Go/Auth/Cloud/Asset/Gemini APIを呼ばない。初期quota/価格はローカル検証設定であり公開時の料金上限保証ではない。Hosted issuer、DB role、pricing、signup/招待運用は未検証。

FACT（Step 7k-42、ローカル実装・DB未適用）：Audio Analyzeは検証済みJWT subjectから専用`arvc_audio_analysis`のreservation RPCを呼び、AI budget role/テーブル/RPCを共有しない。専用roleはNOBYPASSRLS/NOSUPERUSER/NOINHERIT、membershipなし、table ACLなしで4つのprivate SECURITY DEFINER RPCだけを実行する。RPCは固定`search_path=''`、singleton row lockでglobal quota/kill switch、ユーザー資格/quota、burst、concurrencyを原子的に確認する。media/JWT/filenameをusage ledgerへ保存しない。Migration 019はdefault-disabledでquotaの固定初期値なし。まだDB適用・role login credential設定をしていないため実DB動作は未確認。

FACT（Step 7g-3、local-only）：Migration 017で既定falseの`quota_exempt`列とprivateなFixture予約RPCを追加。通常予約RPCは、明示的に免除指定された行だけをuser/service回数、月次費用、user/global同時実行の集計から除き、通常行は引き続き集計する。新RPCは専用DB roleのみ実行可能で、アプリrole/PUBLICは実行できない。RPCはDB kill switch、有効かつ期限内のentitlement、一意なIdempotency-Keyを引き続き検証する。Go APIはFixture modeで、検証済みJWT subjectと設定されたローカル開発者UUIDが完全一致するときだけこの経路を使う。起動時にAI認証、UUID形式、既存loopback API/Auth制約を要求し、Gemini modeでは特例設定を拒否する。開発者entitlementはlocal DBに限り`expires_at = NULL`へ変更したが、enabled状態と資格確認は毎回維持される。実Fixture usage/idempotency ledgerは蓄積し、保持期限・cleanup方式は未設計。Hosted・本番向けのquota方針ではない。
# ローカルProject／出力の取り扱い（Step 6）

`.arvproj`は暗号化されていないJSONファイルである。ローカル音源全体や埋め込み背景画像を含む場合があるため、利用者はその内容に応じて保存・共有する。ファイルはサイズを制限し、Editor状態を変更する前に検証する。`/app`のAudio Analyzeでは確定した最大60秒clipだけを解析APIへ送る。quota admission有効時はJWT検証とDB reservationの後にbodyを読む。クラウドProject保存時は選択済み音源・画像をGo Asset API経由でStorageへ送る。未選択の元音源全体を解析APIへ送らない。`.arvb`暗号化は未実装であり、鍵の生成／保存、復旧、所有者、rotation、暗号化コンテナの詳細は未確定である。固定鍵や同梱鍵は使用しない。
