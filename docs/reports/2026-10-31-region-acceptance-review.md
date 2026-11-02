# Visual Editor Region / Effect 受け入れ調査

状態：completed（コード追跡と自動検証）。実ブラウザ画素確認は環境がなく未実施。

## 点線・選択・Effectの対応

- Canvasの細い点線はBlueprintにある全Regionの輪郭。`selectedRegionId`と一致するRegionだけ明るい紫・太い点線になる。作成途中の矩形/多角形にも別の点線を出す。
- 初期Blueprintの`effect-bars`（Waveform / Bars）は`region-stage`（矩形）を参照し、`effect-pulse`は`region-accent`（多角形）を参照する。したがって初期画面のBarsがAccent多角形の外、ただしStage矩形内に見えても、割当仕様どおり。
- 選択Regionはアウトラインと座標編集、次に作るEffectの割当先を決める。Effectが現在どこへ描かれるかはEffect自身の`regionId`が決める。Effect一覧には各Effectの割当Region名を表示し、Effect editorのRegion選択から変更できる。
- Region削除時は同Regionを参照するEffectと、それらのBindingも削除する。Bindingは`effectId`を参照する。

## Clipと座標

Rendererは各Effect描画命令について`save()`→Region path作成→`clip()`→変換/描画→`restore()`を行う。矩形pathは`x/y/width/height × BlueprintのCanvas寸法`。多角形pathは各正規化頂点を同じCanvas寸法へ変換して閉じる。Barsが多角形へ割り当てられた場合も各バーは多角形pathのclip下で描かれる。

UI pointer座標はCanvasの`getBoundingClientRect()`で正規化し、描画はBlueprintの内部Canvas寸法へ戻す。Canvasは縦横比を維持してCSS幅に合わせるため、この座標変換とRenderer座標にずれはない。

## Region操作と検証結果

UI結合テストで、矩形RegionをCanvasドラッグで作成し、width入力を編集して削除する操作を確認。多角形は頂点クリックで作成し、頂点xを編集し、削除する操作を確認。矩形に割り当てた追加EffectとBindingもRegion削除時に消えることを確認した。

Renderer/Canvas fake-contextテストで、初期Bars命令にはStage矩形path、Pulse命令にはAccent多角形pathが対応することを検証。またBarsを多角形へ割り当てたfixtureで12本すべてが多角形clip内で描画される命令順とsave/restore状態を検証した。実画素値を確認する実Canvasブラウザは利用できず、outside-region pixel assertionは未実施。

実行：`npm test`（3 files / 14 tests）、`npm run typecheck`、`npm run lint`、`npm run build`はいずれも成功。既存`evaluateFrame` / `renderFrame`回帰テストも維持。Renderer/UIロジックの修正は不要で、調査に必要なRegion操作・clip検証だけを追加した。

## 人によるブラウザ確認

1. Region一覧からStage（rect）を選び、Draw rectでドラッグ作成、座標欄を変更し、削除する。
2. Polygonで3点以上を置いてFinish polygon、頂点座標を変更し、削除する。
3. Waveform / Bars行のRegion表示を確認する。初期値はStage矩形。
4. Effect editorのRegionをAccentへ変え、Barsが多角形内だけにclipされることを確認する。Accentの外側だがStage内に表示される場合は、BarsのRegion割当と選択中Regionの区別を確認する。
