# コスト管理

DECIDED：月額1,000円以内、可能なら0円を目標にする。事業者の請求上限保証ではない。最新料金・無料枠は未確認で、無料運用の確約はしない。

FACT（Step 7i-1、2026-11-01）：Migration 018をlocal DBへ適用し、OpenAI GPT-6 Luna Standard rate input $0.10/1M、output $0.50/1Mをbudget snapshotに設定。上限8,000/4,000 token予約時は最大$0.0028。1リクエスト上限・DB月次$1.50はアプリ側admission controlであり、外部請求の絶対上限ではない。OpenAI project hard spend capが設定済みか、実provider請求が設定値と一致するかは未確認。Hostedへは未適用。料金は外部利用を許可する前に再確認する。

PROPOSED：Cloud Run JobsはCPU 2vCPU/4GiB、同時1、30分、初期は自動再試行を抑制。最大4分音源で測定後に決める。6〜12分という過去のCPU処理予測はHYPOTHESISでありCloud Run実測でない。

公開前に確定：ユーザー/全体ジョブ数、音源長/容量、同時実行、OpenAI利用回数、保存期間、R2容量/操作/転送、ログ保持、失敗時の課金、為替と税。予算通知に加え、アプリ側で利用停止できる制御を用意する。

FACT：今回の文書作成で有料クラウドを作成していない。デプロイ前には公式料金の確認日・試算条件・停止手順を記録して明示許可を得る。
