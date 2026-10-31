# アーキテクチャ

DECIDED：処理の流れは、音源入力→PythonによるDemucs分離→Feature TimelineとMusic Summary→GoからGeminiへ要約を渡す→Blueprintスキーマ検証→ブラウザCanvas描画→動画/暗号化ファイル出力。

| 構成 | 責務 |
|---|---|
| React | 編集、Region操作、再生時刻管理、プレビュー・動画出力 |
| Renderer | Blueprint/特徴量/時刻/seedから描画命令を評価 |
| Go/Echo | JWT検証、所有者認可、CRUD、ジョブ、Gemini、検証、暗号化、利用制限 |
| Python Island | デコード、4 Stem分離、特徴抽出、要約生成 |
| ストレージ/DB | 素材・結果とプロジェクトの保存。所有者単位で隔離 |

DECIDED：Regionは場所、Effectは処理、Bindingは特徴量との対応を担当する。Rendererは過去の描画順やFPSに依存させない。

PROPOSED：Cloudflare Pages/R2、Cloud Run Services/Jobs、Supabase Auth/PostgreSQL、Gemini。未構築。契約・制限・認可方式は実装前に具体化する。
