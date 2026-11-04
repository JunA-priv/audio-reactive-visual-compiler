# Step 7k-26 — Kick検出とBinding応答の調査

**状態: 部分完了。** データから描画までの経路を調べて根本原因を特定し、新規Kick Bindingの既定値を調整しました。自動確認は成功しました。アコースティック音源の正解ラベルとブラウザーで見える応答は未検証です。

## 調査結果

### Gate ModeとTimelineの流れ

既存のGate Mode経路は引き続き接続されています。Editorは次のAnalyzeリクエストで選択した`kickGateMode`を送信し、Goが検証してPythonへ渡し、`extract_features()`が`detect_kicks()`に伝えます。省略時は引き続きHardです。モード選択によって既存Timelineが再処理されることはありません。解析成功時、`VisualEditor.tsx`は返却された`featureTimeline`でTimelineを置き換え、通常の新規解析用Blueprintを初期化します。このBlueprintではSpectrum BarsとInk Diffusionの入力を意図的に`music.energy`にしているため、Audio SourceをKickに変更するまではKickイベントで既定Effectが駆動されません。解析失敗時は、既存の成功済みTimeline/Blueprintを置き換えません。

### 検出器の出力とstrength

変更していない検出器を`demo-assets/stems/demo4-kick-evaluation/drums.wav`（189.960秒、44.1kHz、ステレオPCM16）で再実行しました。以下は検出器の診断値であり、ラベルに基づく精度ではありません。

| ゲート | イベント数 | Strength ≤ 0.1 | Strength > 0.1 | 最小 | 中央値 | p90 | 最大 | イベント間隔の最小/中央値 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Off | 994 | 429 | 565 | 0.000094 | 0.223223 | 0.689112 | 1.000000 | 120 / 160ms |
| Soft | 647 | 102 | 545 | 0.018141 | 0.369472 | 0.748848 | 1.000000 | 120 / 240ms |
| Middle | 395 | 91 | 304 | 0.028778 | 0.351253 | 0.801916 | 1.000000 | 120 / 300ms |
| Hard | 138 | 69 | 69 | 0.043280 | 0.099156 | 0.389254 | 1.000000 | 140 / 580ms |

検出器は従来どおり候補を120msで統合するため、厳しいゲートによって残る局所最大値が変わる場合を除き、イベント間隔は120ms未満になりません。Offで増えたイベントが実際のKickだとは仮定しません。Strengthは採用候補スコアを解析ごとに正規化した値であり、選択したモードとクリップに対する相対値です。音響上の信頼度スコアではありません。Step 7k-25の既存証拠では、Hardのイベント時刻は保存済みHardベースラインと完全一致しています。

### BindingとEffectの経路

`renderer.ts`は対応する`kickEvents` / `kickEventStrengths`を読み取り（`rawSourceValue()`）、`evaluateBinding()`でBindingの閾値とAttack/Releaseを適用した後、Binding strengthを掛けます。Rippleはこの連続的に平滑化された値で不透明度とサイズを変化させます。リング位相は経過時間と`periodMs`に基づき、個々のKickオンセットには同期しません。一方、イベント駆動のShockwave / Particle BurstはイベントごとのStrengthに`boundFeature()`を適用します。Strengthが閾値以下なら不透明度はゼロになります。これらの経路は検出器によるイベント採用とは別です。

閾値による遮断を再現しました。閾値0.1ではStrength 0.05と0.1の出力はゼロです。Strength 0.2の場合、Attack適用前の正規化値は`(0.2 - 0.1) / (1 - 0.1) = 0.1111`です。Binding strength 0.9、Attack 60msでは、20ms時点の値は約0.02835です。Strength 0.2で閾値を0.05または0にすると、Attack前の出力はそれぞれ0.1579、0.2です。閾値0、Binding strength 1ではAttack 60ms/20ms/0msのサンプル値は約0.0567/0.1264/0.2で、strength 0.9では0.0510/0.1138/0.18です。Strength 1.0では正規化出力が上限まで増えます。同じ0.1の閾値により、demo4のうちその値以下のイベントは完全に抑制されます（Off 429件、Soft 102件、Middle 91件、Hard 69件）。Rendererテストでも、閾値0ではStrength 0.05のイベントがRippleとShockwaveの描画コマンドに届き、閾値0.1では抑制されることを確認しました。

Audio Reactiveが有効で、Effectの入力が`kick.events`であり、Visibility/OpacityとEffect固有の設定が描画を許可している必要があります。特に解析後の既定値はSong入力で、Rippleは位相が連続的に進みます。そのため、Kick以外のAudio Sourceや位相・低不透明度の瞬間だけでは、検出器の失敗とは判断できません。ユーザーが無音と報告した正確な時刻と、その時点で有効だったBlueprint設定が得られていないため、報告事象の原因を単一のものに断定できません。

## 変更内容

**入力が`kick.events`の新規Bindingに限り**、`bindingFor()`の既定値をStrength 1、Threshold 0、Attack 0msとし、Release 260msは維持します。これにより、検出器の出力に保守的な閾値やスルー制御を重ねて適用しません。検出器側の感度調整は引き続きGate Modeで行います。他のAudio Sourceの既定値は変更しません。既存Binding、読み込み済みProject、手動編集されたRipple設定、デモフィクスチャの既存Binding、保存済み値は書き換えません。別の入力からKickに変更したRippleも、現在のユーザー設定を維持します。保存済みRippleで弱い検出イベントを表示するには、Thresholdを0、Strengthを1にし、素早く反応させる場合はAttackを0msにしてください。

検出条件、正規化、統合、Timeline、API、Blueprintスキーマ、保存済みProject、Effect描画式、Renderer/WebMコードは変更していません。人手ラベルがないため、検出精度の改善は主張しません。

## テストと確認

- Frontend: **163件成功**。`npm run typecheck`、`npm run lint`、`npm run build`: 成功。
- Python Island: **65件成功**。`mypy --strict src`: 成功。Ruff `src tests --ignore E501`: 成功。
- Go Audio Analyze: `go test ./internal/audioanalysis`および`go vet ./...`: 成功。
- `git diff --check`と変更した7ファイルの行末空白チェック: 成功。
- Rendererテストを追加し、Strength 0.05/0.1/0.2/0.5/1、Threshold 0.1/0.05/0、Binding strength 0.9/1、Attack 60/20/0、オンセット後の減衰、Ripple/Shockwaveへの伝達を網羅しました。
- 新規ShockwaveのKick BindingがThreshold 0、Strength 1、Attack 0、Release 260となることを確認するUI回帰テストを追加しました。
- 実ブラウザー/Windows Chromeでの画面確認、および画素上で見える音響応答: この環境では未検証です。

## 変更内容d files

- `frontend/src/VisualEditor.tsx` — 新規Kick Bindingに対するKick固有の既定値。
- `frontend/src/editor-renderer.test.ts` — Bindingパラメーターの網羅確認と、弱いイベントのEffect伝達テスト。
- `frontend/src/visual-editor.test.tsx` — Kick入力Effectの既定値に関する回帰テスト。
- `docs/reports/2026-11-02-step7k-26-kick-response-investigation.md` — 調査結果と証拠。
- `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `CURRENT_TASK.md` — 状態と未取得の証拠。

## 残る検証

- Offで増えるイベントが実際のKickか誤検出か判断するには、人が注釈したKick/非Kickイベントが必要です。
- ユーザーの実際の保存済みBlueprintと無音とされた時刻でテストし、Audio Source、Bindingのthreshold/strength/attack、Audio Reactive、Visibility、Effect Opacity、および該当時刻のrenderer command opacityを確認してください。
- 実ブラウザーでRippleとイベント駆動Effectを目視確認してください。この環境ではブラウザー/GPUでの受け入れ確認は行っていません。
