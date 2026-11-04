# Step 7k-25 — Kick検出ゲートモード

**状態: 部分完了。** ゲートモード、リクエストへの値の伝達、UI、自動検証は完了しています。Windows版Chromeでの目視受け入れと、ラベル付き音響データによる精度評価は未検証です。

## 検出モード

検出器は従来と同じ2048サンプルのFFT帯域・特徴量を10msホップで抽出し、同じスコア式を使用します。変更されるのは既存の4つの採用ゲートだけです。以下の値は（適応スコア倍率、適応スコア絶対下限、低域p65倍率、sub/body最小比、80ms減衰比の最大値）です。

| モード | 値 |
|---|---|
| Off | `(0, 0, 0, 0, 1)`。4つのゲートを迂回します |
| Soft | `(0.08, 0.035, 0.04, 0.40, 0.90)` |
| Middle | `(0.13, 0.055, 0.08, 0.55, 0.70)` |
| Hard | `(0.18, 0.08, 0.12, 0.70, 0.50)`。従来の検出条件を維持します |

Offでもスコアが正でゼロ以外であることを要求し、局所最大値の選択と120msの候補統合を維持します。そのため無音からイベントは発生せず、重複ピークも統合されます。ゲート閾値は緩いものから厳しいものの順です。全モードで同じ検出器を使い、新しい検出式、依存関係、Demucsパスは追加していません。

## Audio Analyze APIとUI

`POST /api/v1/audio/analyze` は任意のmultipartテキストフィールド `kickGateMode=off|soft|middle|hard` を受け付けます。省略時は既存クライアントとの互換性のためHardになります。不明値、重複値、想定外のmultipartフィールドは拒否されます。選択値は固定のPython CLI引数としてGo runner経由で渡されます。CLI側も独立してHardを既定値とし、同じ値集合を検証します。これは追加フィールドであり、成功レスポンス形式、Feature Timeline v1、`kickEvents`、`kickEventStrengths`は変更されません。

Editorで新規解析を行う際の既定値はMiddleです。セレクターは「4 · エフェクト」セクション内のCommon Colorの下、Effect一覧の上に配置されています。状態は個々のEffectではなくEditorに属します。Effectの追加・削除・種類変更をしても選択値は維持されます。選択値を変更しただけではリクエストは送信されず、既存Timelineも変更されません。値は次回のAudio Analyzeリクエストでのみ送られます。既に解析済み、または読み込み済みのProjectは再解析されません。

## Demo4比較

既存の `demo-assets/stems/demo4-kick-evaluation/drums.wav`（189.960秒、44.1kHz、ステレオPCM16）に各モードを適用しました。ソース、候補フィクスチャ、保存済み評価データは変更していません。提供されたラベルは未検証のため、以下は検出数であり精度評価ではありません。

| モード | イベント数 / 対応するStrength数 | Strength最小 | 中央値 | p90 | 最大 |
|---|---:|---:|---:|---:|---:|
| Off | 994 | 0.000094 | 0.223223 | 0.689112 | 1.000000 |
| Soft | 647 | 0.018141 | 0.369472 | 0.748848 | 1.000000 |
| Middle | 395 | 0.028778 | 0.351253 | 0.801916 | 1.000000 |
| Hard | 138 | 0.043280 | 0.099156 | 0.389254 | 1.000000 |

件数は意図した厳しさの順に単調です。共通の120ms統合処理では、一方のモードが追加ピークを許容すると異なる局所最大値が選ばれることがあるため、各モードのオンセットは厳密な部分集合にはなりません。Hardのイベント時刻は保存済みベースラインTimelineの138件すべてと完全一致します。量子化済みPCM16ステムから再計算した場合、以前のTimeline（量子化前のDemucs浮動小数点値から生成）とのStrength最大絶対差は `0.00003147` です。これは既知のPCM量子化差であり、ゲート条件の変更によるものではありません。同一入力サンプルでは、モード省略時と明示的なHardはイベント・Strengthの組が一致します。

人が確認した正解ラベルがないため、Precision、Recall、F1、または弱いKickの改善については主張しません。

## テストと検証

- Python Islandテスト: **65件成功**。
- Python `mypy --strict src`: 成功。
- PythonソースとテストのRuff（既存プロジェクト規約により `--ignore E501`）: 成功。
- Frontend: **161件成功**、typecheck、lint、本番build成功。
- Go `internal/audioanalysis`テスト: 成功。省略時のHard既定値、4値すべて、不正値拒否、runnerへの伝達、CLI引数を検証。
- `go vet ./...`: 成功。
- `git diff --check`: 成功。

FrontendテストではMiddle既定値、セレクターの配置、設定変更時に再解析しないこと、Effectの種類変更・追加・削除後も状態が維持されること、選択モードがAnalyzeのmultipartリクエストに含まれることを検証します。PythonテストではHard既定値との互換性、閾値の順序、モード伝達、Offでの無音処理、局所最大値・統合結果の不変条件、イベントStrengthの整列を検証します。

## 変更ファイル

- `python-island/src/python_island/features.py`、`pipeline.py`、`cli.py` — 共通ゲート設定とモード伝達。
- `python-island/tests/test_features.py`、`test_cli.py` — 検出器とCLIの回帰テスト。
- `api/internal/audioanalysis/handler.go`、`handler_test.go` — 任意multipartフィールドの検証とPython argvへの伝達。
- `frontend/src/audio-analysis.ts`、`VisualEditor.tsx` — リクエスト項目、Middle既定値、全体設定コントロールの移設。
- `frontend/src/audio-analysis.test.ts`、`visual-editor.test.tsx` — ペイロードとUI状態・配置のテスト。
- `docs/API_CONTRACTS.md`、`docs/ARCHITECTURE.md`、`docs/TEST_STRATEGY.md`、`docs/CURRENT_STATE.md`、`docs/OPEN_ISSUES.md`、`CURRENT_TASK.md`、`python-island/README.md` — 契約、設計、状態の文書。

Blueprint、Timeline、Project、Cloud、Renderer、WebM、Auth、DB、Migration、Demucsモデル、保存済み解析データは変更していません。

## 残っている検証

実際のWindows Chrome環境でUIを受け入れ確認していません。demo4比較には人手で確認した正解ラベルがないため、弱い音響Kickへの有効性や誤検出の変化は未確定です。選択モードを変更しても既存データは自動再解析されません。
