# プロジェクトの背景

DECIDED：音源と1枚絵から音響反応する簡易MVを制作する個人開発。AIが演出Blueprintを設計し、人が編集し、決定論的Rendererが実行する。ポートフォリオへの掲載も目的とする。

DECIDED：Windows 11 / WSL2 Ubuntuを開発基準とする。フロント・Go API・Python Islandを同一リポジトリで管理し、AstroのPortfolioは別リポジトリにする。

DECIDED：MVPは音源・画像入力、分離・解析、演出生成・編集、矩形/多角形Region、動画出力、暗号化Blueprint復元、認証・保存、公開サンプルを含む。課金、AI素材生成、TuneCore連携は対象外。

DECIDED：月額1,000円以内を目標とする。有料リソース作成・デプロイは費用確認と明示許可が必要。これは請求上限の保証ではない。

原典：[初期引き継ぎメモ](HANDOVER.md)。実装状況は[CURRENT_STATE.md](CURRENT_STATE.md)を参照。
