# Blueprint仕様

DECIDED：ProjectはBlueprint、Feature Timeline、背景素材、再現用メタデータを持つ。BlueprintはScene/Regions/Layers/Effects/Bindings/Sectionsを分離する。正式JSONスキーマは未確定。

DECIDED：Regionは正規化座標の矩形または多角形。Effectは表現、Bindingはfeatureと制御方式を定義する。プレビューと動画出力で同一のマスク処理を使う。

DECIDED：DrumsからKickイベントを推定し、BassはRMS等の連続値を生成する。100HzはPROPOSEDであり確定値ではない。

DECIDED：同一Blueprint、特徴量、再生時刻、Renderer版、seedから同じ描画命令を得る。Attack/Releaseや粒子はシーク順序に依存させない。エンコード結果のバイト一致は要件外。

実装前に確定：時間単位、feature補間・範囲外挙動、NaN/Infinity拒否、ID参照検証、座標制約、ポリゴン上限、効果パラメータ範囲、評価順序、版の互換性。再現情報はschema/renderer/analysis版、audio hash、seedを含む。
