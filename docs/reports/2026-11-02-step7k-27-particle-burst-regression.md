# Step 7k-27 — Particle BurstのDemo/Audio Analyze比較

**状態: 部分完了。** 既存DemoとアコースティックstemのTimeline strengthを用いて、Renderer側の減衰を再現しました。新しく生成されたKick連動Particle Burstには、Editor適用時に既存の応答性を高めるKick Binding既定値が設定されます。Frontend自動確認は成功しました。ユーザーの保存済みEffectパラメーターと修正後のブラウザー表示は検証できていません。

## Demoと解析済み音声の比較

Demo EditorはParticle Burstを含まない`initialEditorBlueprint`から開始します。Demo Editorで追加すると`addEffect()`が`kick.events`を選び、Step 7k-26の`bindingFor()`がStrength 1 / Threshold 0 / Attack 0ms / Release 260msを設定します。新規Burstの既定値はStage、opacity 1、triggered visibility、Audio Reactive ON、count 32、size 7px、lifetime 1,500ms、speed 420px/s、origin (0.5, 0.5)、direction 0°、spread 90°、glow 1.6、opacity boost 1.6、core brightness 1.1、swirl 0.55、audio influence 1です。これらはコード上の既定値であり、ユーザーの実際のDemo設定を示す証拠ではありません。

Audio Analyze後、`VisualEditor`は`newEditorBlueprint`（`music.energy`を使うSpectrum BarsとInk Diffusion）を設定します。Blueprint生成は別操作です。モデル応答が独自のEffectおよびBinding値を返し、OpenAIスキーマには固定Binding既定値がありません。ユーザーが生成/保存したParticle Burstの値は共有されていないため、スクリーンショットから実際のsource、Binding、count、size、lifetime、movement、glow値を断定できません。一方、スクリーンショットでtriggered visibility、Audio Reactive ON、opacity 1は確認できます。

| 項目 | Demo経路（コード/アセットで確認） | Audio Analyze/生成経路 | Burstへの影響 | 確度 |
|---|---|---|---|---|
| Effect種別 | 手動追加時に`particle-burst`。Demo開始時のBlueprintには含まれない | ユーザーはParticle Burstと確認。生成Blueprintの実物は未入手 | 保存/生成値が表示どおりなら同じRenderer種別 | Demoコード/ユーザー報告 |
| Audio Source | `addEffect()`由来の`kick.events` | Kick Binding生成に対応するが実際の値は不明 | Kick以外のsourceはイベント専用Effectに不適合 | Demoコード/実値不明 |
| Binding Strength / Threshold | Step 7k-26以後にUI追加したKick Bindingでは`1 / 0` | API生成応答値は不明。スキーマでは0〜1 | Threshold以下のイベント値を除き、Strengthが残りを倍率調整 | Demoコード/実値不明 |
| Attack / Release | UIで追加した新規Kick Bindingでは`0 / 260ms` | 生成値不明 | Particle Burstはイベントごとに`boundFeature()`を使うため、Attack/Releaseはイベント粒子計算に影響しない | Demoコード/Renderer仕様 |
| Visibility / Audio Reactive / Effect opacity | 新規Burstの既定値はtriggered / on / 1 | スクリーンショット: triggered / on / 1 | Bindingを通過するイベントがないとtriggeredモードは代替粒子を出さない | Demoコード/スクリーンショット |
| Count / Size / Lifetime / Speed / Origin / Spread | 新規Burstの既定値: 32 / 7px / 1,500ms / 420px/s / center / 90° | 生成/カスタム値不明 | Countは出力コマンド数、lifetimeはイベント有効時間、size/speedは視認性と移動に影響 | Demoコード/実値不明 |
| Timeline Kick Strength | demo1: 217件、最小0.2510、中央値1.0、0.1以下なし | 既存demo4アコースティックstemのHard Timeline: 138件、最小0.0433、中央値0.0992、69件が0.1以下。Step 7k-25 Middle診断: 395件、91件が0.1以下 | 一般的な閾値0.1ではDemoのstrengthは通る一方、弱いアコースティックstrengthは除外またはほぼゼロまで低下 | 既存ファイル/報告。ユーザーの実際の切り出しではない |

これらのstrength分布は検出器出力を正規化したもので、ラベルに基づくKick信頼度ではありません。demo4 Timelineはアコースティックstemによる代用データであり、ユーザーの実際の60秒クリップや選択Gate Modeだとは主張しません。

## 根本原因と再現

原因はイベント/クロック/表示の回帰ではなく、Timeline strength分布と新BlueprintのBinding既定値の組み合わせです。

1. Demoイベントのstrengthは、保存済みアコースティックstem Timelineの弱いイベントより大幅に高い。
2. Particle Burstは各イベントを`boundFeature(eventStrength, binding)`で直接評価します。閾値は一度適用され、連続値を返す`evaluateBinding()`の結果も併用するわけではありません。イベントがThreshold以下なら粒子を生成しません。
3. 閾値をわずかに上回るstrengthでは`boundFeature()`の値も小さくなります。粒子数は`ceil(count × (0.32 + response × 0.68))`で、不透明度はイベントstrengthと`opacityBoost`に比例します。そのため閾値付近のイベントでは、一般的な0.9/0.1 BindingでStrength 1のイベントが30個生成するのに対し、薄い粒子が約11個だけ出る場合があります。
4. 固定テストBlueprint（count 32、opacity boost 1.6）では、demo1相当のStrength 1とBinding 0.9/0.1で描画コマンド30件を生成しました。同じBindingでは既存demo4値0.052458は何も生成しません。demo4値0.108810は0.1をわずかに超えるだけで、正規化とBinding strength適用後は非常に低い不透明度の粒子を約11個駆動します。
5. 同じ弱いイベント0.052458にStrength 1 / Threshold 0を適用すると、不透明度0.08超のコマンドが12件生成されました。これはRendererコマンド上の具体的な改善ですが、実ブラウザーでの視認性は別途確認が必要です。

Visibilityがイベントを二重にゲートしているわけではありません。triggeredモードはBurstがイベントコマンドを返さない場合にalwaysモードの代替表示を抑えるだけです。`audioReactive=false`なら応答は止まりますが、ユーザーのスクリーンショットでは有効です。粒子イベント時刻はRendererフレーム時刻と比較され、任意のシーク位置でも再構築されます。イベントは設定されたlifetimeの間有効です。この経路にフレーム状態やPreview/WebMの差は見つかりませんでした。Particle Burstのイベント単位描画経路はAttackとReleaseを読みません。

## 最小修正

新たに生成した応答の検証後、Editor状態に設定する前にのみ`prepareGeneratedBlueprint()`を実行するようにしました。`kick.events`を使う各`particle-burst`について、既存Binding値のStrengthを1、Thresholdを0にします。Attack、Release、すべてのEffectパラメーター、Timeline、その他のBindingは変更しません。

Project復元と保存済みBlueprintではこの準備関数を使わず、値も書き換えません。生成BindingはEditorに反映後もユーザーが編集できます。検出ゲート、イベントアルゴリズム、API契約、スキーマ、永続化、Renderer式は変更していません。

## 回帰テスト範囲

- Same Particle Burst Blueprint compared on a Demo-strength event and exact weak Strength `0.05245834928566786` taken from the existing demo4 Timeline.
- Generic 0.9 / 0.1 Binding reproduces 30 Demo commands versus no commands for the weak acoustic event.
- Kick defaults reproduce 12 commands for that weak event, with command opacity above 0.08.
- UI integration loads a generated Blueprint containing a Particle Burst with generic Binding values and verifies that only its Kick Binding is normalized; Attack and Release remain 60ms / 260ms.
- Existing renderer tests cover triggered/always behavior, source compatibility, lifetime, count limits, opacity, deterministic seeking, and Preview/WebM shared rendering.

## 検証

- Frontend: **13ファイル、164件成功**。
- `npm run typecheck`: 成功。
- `npm run lint`: 成功。
- `npm run build`: 成功。
- `git diff --check`: 成功。変更ファイルすべての行末空白も確認。
- Python/Goは変更していないため、Frontendのみの変更に際して各テスト一式を再実行していません。
- OpenAIリクエストやHosted環境への操作は行っていません。

## 変更ファイル

- `frontend/src/VisualEditor.tsx` — 生成されたKick連動Particle BurstのBinding strength/thresholdのみを正規化。
- `frontend/src/editor-renderer.test.ts` — Demo/アコースティックTimelineのstrength差を再現し、描画コマンド回復を検証。
- `frontend/src/visual-editor.test.tsx` — 生成Blueprint適用と無関係なBindingパラメーターの保持を検証。
- `docs/reports/2026-11-02-step7k-27-particle-burst-regression.md` — 調査結果と検証。
- `CURRENT_TASK.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md` — 現在の状態と残る受け入れ確認。

## 残る検証

ユーザーの実際の生成Blueprintとソース切り出しは共有されておらず、元のBindingとEffectパラメーターは不明です。この修正後のWindows Chromeでの視覚的受け入れ確認は未実施です。低Strengthイベントでも描画コマンドは生成されますが、実際に見えるかは生成/保存されたsize、color、glow、region、opacity設定によります。既存の保存済みProjectは意図的に変更していないため、弱いKickイベントを表示するにはBindingを手動調整する場合があります。
