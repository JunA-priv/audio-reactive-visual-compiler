# Step 7k-8 — BPM同期回転

状態：partial。実装と自動検証は完了。実ブラウザの視覚比較と実WebM再生比較は未実施。Go serviceの全テストはsandbox loopback制限で一部実行できない。

## 調査・設計

Music Summary v1と既存Feature Timeline v1にはBPMもbeat positionもありませんでした。既存のKick onset配列を再利用し、追加分離や元音源の再デコードはしません。

Kick onset間隔が3区間以上あり、中央値に対するMAD比が0.25以下なら中央値からテンポを推定します。推定値は慣例的な60〜180 BPMへoctave foldし、333ms量子化が180 BPMを半値90 BPMと誤判定しない境界処理を含みます。Kickが4件未満、intervalが少ない、または不規則なら120 BPMを使い、`bpmSource:"fallback"`を明示します。推定はhalf/double-time ambiguityを解消せず、beat phaseも作りません。

## 実装

- Timeline v1にoptional `bpm` / `bpmSource`を加法追加。Estimatedは60..180 BPM、fallbackは厳密に120 BPM。旧Timelineで両方ない場合はRendererとAPI compact promptが120 BPM fallbackを使う。
- `radial-bars`、`wave-ring`、`waveform-ring`にall-or-none optional `rotationMode`、`beatsPerRevolution`、`rotationDirection`、`initialAngleDeg`を追加。新規Effectはcontinuous / 8拍 / clockwise / 0度。
- Continuousは`BPM × 360 / (60 × beatsPerRevolution)`を使いaudio time 0から角度を算出。Triggeredは既存Bindingのattack/release followerを20ms単位で積分し、その積分値へBPM由来の角速度を掛ける。WeakMap timeline cacheとbinding parameter keyed cumulative tableを使い、過去frame角度への加算はしない。
- 旧Blueprintにrotation fieldsがない場合、回転角は0となり従来形状を維持。Blueprint v1、Timeline v1、`.arvproj v1`、Cloud Envelope/Project Document v1を維持。
- Frontend/Go Blueprint validator、AI strict schema/nullable normalization、Go request Timeline validator、Project/Cloud Timeline validatorを同期。AIへ送るcompact promptにBPM/sourceを追加。OpenAI実APIは呼んでいない。
- Editorはrotation mode、4/8/16/32拍、方向、初期角度を表示。BPM値と推定/fallback status、およびbeat phase未推定を示す。
- PreviewとWebMは従来の`renderEditorFrame`共有経路を使い、同じaudio timeで同じ角度を評価する。

## 変更ファイル

- `python-island/src/python_island/features.py`, `python-island/tests/test_features.py`: Kick interval tempo estimate/fallbackとテスト。
- `frontend/src/editor-model.ts`, `renderer.ts`, `VisualEditor.tsx`: Timeline/Blueprint型、検証、決定論的回転積分、UI defaults/controls。
- `frontend/src/editor-renderer.test.ts`, `visual-editor.test.tsx`, `project-file.test.ts`, `cloud-project.test.ts`: BPM periodicity/source/fallback/seek/UI/v1 roundtrip tests。
- `api/internal/service/input.go`, `http_test.go`: BPM metadata validation、AI compact features。
- `api/internal/projects/document.go`, `document_test.go`: Cloud/Project v1 Timeline BPM validation。
- `api/internal/blueprint/blueprint.go`, `blueprint_test.go`: optional rotation contract validation。
- `api/internal/service/openai.go`, `openai_test.go`: strict schema and nullable defaults.
- `CURRENT_TASK.md`, current/spec/architecture/API/test/roadmap/issues docs and this report.

## 検証

- Frontend: 100 tests passed; typecheck, lint, production build passed.
- Python Island: 22 tests passed (cached Demucs integration included), including 60/120/180 BPM, 250/333/500/1000/2000ms intervals, sparse/irregular fallback. Mypy passed. Ruff remains nonzero on 16 pre-existing E501 line-length findings across the Python Island tree; the new BPM test line was wrapped.
- Go: Blueprint and Project package tests passed; focused BPM, OpenAI schema/normalization and Timeline validation tests passed; `go vet ./...` passed.
- Full service test invocation includes `httptest.NewServer`; sandbox denied IPv6 loopback bind (`operation not permitted`). No OpenAI API was called.
- Tests cover 60/120/180 BPM × 4/8/16/32 beats/revolution, full-period return and half-period orientation, repeated-time/seek-order consistency for triggered mode, invalid metadata, and v1 persistence.
- `git diff --check` run after updates.

## 互換性・残存事項

Legacy Timeline without BPM rotates at documented 120 BPM fallback only for newly opted-in circular rotation. Legacy Blueprint without rotation fields keeps its previous geometry. BPM is constant tempo with phase zero at clip start; it does not guarantee real beat-phase lock. Real browser pixels, pause/resume through the actual audio UI, WebM playback frame comparison, and rotation integration performance on maximum-duration projects remain unmeasured.

## Effect Category 追加実装（2026-11-01）

### 原因

Step 7k-8のEditorにCategory state、分類表、Category UIはなく、`Effect type`単一selectが15種類すべてを表示していた。CSSや条件分岐で隠れていたのではなく未実装だった。

### UI分類

| Category | Effect Types |
|---|---|
| Core / Transform | pulse-scale, glow-brightness, rotation-movement |
| Waveform | waveform-bars, waveform-line, waveform-peak-bars, oscilloscope-line |
| Circular / Radial | radial-bars, wave-ring, waveform-ring |
| Particles | particles, particle-burst, particle-trail |
| Impacts | ripple, shockwave |

既存Effect editorでは選択中TypeからCategoryを導出する。Categoryを変えると表示候補のみ切り替わり、現TypeがそのCategoryに含まれなければType selectは未選択表示になる。Type選択時にだけ既存の`changeSelectedEffectType`を呼び出す。Add Effectも同一分類を使用する。Category fieldやProject versionは追加していない。

### 検証・変更

- `frontend/src/VisualEditor.tsx`: shared category map、selected Effect category draft、Add category/Effect selectors、既存Type選択。
- `frontend/src/style.css`: add selector layoutとmobile wrapping。
- `frontend/src/visual-editor.test.tsx`: 15件の分類網羅、Wave RingのCircular / Radial表示、Category変更だけではEffect値が不変、Type確定、Add Effect flow、`.arvproj v1`再読込後のcategory導出・Category非保存を検証。
- Frontend: 104 tests passed; typecheck, lint, build passed; `git diff --check` passed.
- Audio Source/BPM rotation/Gradient preservationは既存UI回帰とProject roundtrip testsを維持。Blueprint v1 / `.arvproj v1` / Cloud v1、Renderer、Python、Goは変更なし。
- 実ブラウザ画面での手動確認はブラウザ実行環境がなく未実施。自動DOM/React testsとproduction buildの成功とは区別する。
