# API契約

状態：PROPOSED。正式なパス・JSON・ステータスコード・OpenAPIは未定義。ここで契約済みと扱わない。

DECIDED：GoはSupabase JWTを検証し、プロジェクト・解析ジョブ・素材アクセスを所有者単位で認可する。Gemini応答は検証してから保存・描画へ渡す。

PROPOSED：API群はプロジェクトCRUD、アップロード認可、解析ジョブ作成/状態取得、Blueprint生成、暗号化export/import。ジョブはqueued/running/succeeded/failed/cancelledを候補とし、遷移と再試行・二重実行の扱いを確定する。

実装前の確定事項：認証ヘッダー、リクエスト/レスポンス、所有者照合、ページング、エラー形式、冪等性、タイムアウト、サイズ・回数・同時実行制限、署名URL有効期限。契約はcontractsに置き、Go/Python/TypeScriptで整合性を検証する。
