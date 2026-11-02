# 判断履歴

| 日付 | 状態 | 判断 | 理由・根拠 |
|---|---|---|---|
| 2026-10-31 | DECIDED | AIは演出設計、Rendererは決定論的描画 | 引き継ぎメモ。制御・再編集・再現性を重視 |
| 2026-10-31 | DECIDED | CPU第一候補 | GPU必須にせず性能を測定して判断 |
| 2026-10-31 | DECIDED | WSLを開発・検証基準 | ユーザーの開発環境指定 |
| 2026-10-31 | DECIDED | 公式情報で安定版と脆弱性を照合 | ユーザーの依存選定要件 |
| 2026-10-31 | DECIDED | Node 24.22.2 / npm 11.19.1 | WSL2上で実測し、公式リリース版と照合 |
| 2026-10-31 | DECIDED | docsで事実と計画を区別 | 未実装を完了と扱わない |
| 2026-10-31 | DECIDED | 初期Rendererは固定矩形と線形補間featureで構成 | 単体検証可能な純粋な命令評価を先に作り、正式schemaは後続で確定 |
| 2026-10-31 | DECIDED | Visual Editor schema v1を既存Renderer APIへ追加し、旧APIを維持 | 背景/Region/Effect/Bindingを分離し、region clip後に決定論的なCanvas命令を描く。Project/APIの正式契約とは分離 |
| 2026-10-31 | DECIDED | Python IslandはPython 3.14.10 / Torch 2.14.1+cpu / Demucs 4.1.0 / NumPy 2.3.4を固定し、10ms feature hopで出力 | 実モデルCPU推論と既存Editor timeline形状を維持した固定間隔のFeature Timelineを実測 |
| 2026-10-31 | DECIDED | Python runtimeは既存checkpoint cacheからのみmodel weightsを読み込み、暗黙network取得をしない | 実行時外部アクセスを避け、checkpoint hashを検証。weight licenseはコードライセンスと別途確認 |
| 2026-10-31 | OPEN | system FFmpeg 6.1.1-3ubuntu5を安全な配布版として承認しない | Ubuntu 24.04の複数FFmpeg advisory修正版がESMで案内され、WSL apt candidateも未修正版。より安全な保守版/限定buildを確定する |
| 2026-11-01 | DECIDED (local code only) | Visual Blueprint生成providerをGeminiからOpenAI Responses API `gpt-6-luna`へ移行 | 既存Blueprint v1、JWT/entitlement、quota/budget、Fixture経路を維持し、公式Strict Structured OutputsとGo validatorを併用。実API未試験。Migration 018はprice/model切替用に作成したが未適用 |

重要な変更時は、代替案・影響・移行方法を追記する。新しい決定が原典と異なる場合は理由を残す。
