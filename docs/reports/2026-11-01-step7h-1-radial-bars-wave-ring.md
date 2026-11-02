# Step 7h-1：Radial Bars・Wave Ring

実施日：2026年11月1日  
状態：**completed（実装・自動検証）**

## 実装

- Editor Blueprint v1に`radial-bars`と`wave-ring`を追加。既存5種類は変更・削除していない。
- Radial Barsは正規化されたregion bounds内の中心・半径を基準に、Bass/Kick値の時刻サンプルから高さを求めた回転矩形を生成する。
- Wave Ringは同じ中心・半径に対し、Feature Timelineの過去1秒分を各角度で参照する閉pathを生成する。Amplitudeは基本radiusに対する変形率。乱数や前フレーム状態を保持しない。
- 両Effectは既存Bindingを各1つ使い、Editorで色・Region・Effect固有パラメータ・Bindingを編集可能。描画は既存`renderEditorFrame`とRegion clipを共有するため、PreviewとWebMで同じ評価経路を使う。
- Frontend/Go Blueprint validator、Gemini Structured Output schema enum/propertiesを更新し、Cloud Project v1検証で新Effectを許可する。
- `.arvproj v1`、Cloud Envelope v1、Editor Blueprint/schema version 1を維持。旧ソフトウェアが新Effectを認識・編集する前方互換性は保証しない。

## 検証結果

- Frontend: 9 files / 52 tests passed。
- `npm run typecheck`: passed。
- `npm run lint`: passed。
- `npm run build`: passed。
- Go `go test ./...`: passed。
- Go `go vet ./...`: passed。
- Tests cover valid/invalid parameter bounds, Binding source response, Region clip, arbitrary-order time re-evaluation, `.arvproj v1` roundtrip, Go ProjectDocument v1 acceptance, and Gemini Structured Output schema support.
- Preview and WebM both call the same `renderEditorFrame`; frame equality is evaluated from the same Blueprint/Timeline/time inputs. Actual WebM playback with the new effects was not browser-tested.
- Browser pixel rendering, visual quality, and human assessment of musical/aesthetic fit were not performed.

## 変更ファイル

- `frontend/src/editor-model.ts` — Effect型とパラメータ検証。
- `frontend/src/renderer.ts` — radial geometry、timeline-sampled ring path、Canvas path stroke。
- `frontend/src/VisualEditor.tsx` — add-effect choices, defaults, parameter controls.
- `frontend/src/editor-renderer.test.ts`, `frontend/src/visual-editor.test.tsx`, `frontend/src/project-file.test.ts` — rendering, UI, save/restore tests.
- `api/internal/blueprint/blueprint.go`, `api/internal/blueprint/blueprint_test.go` — server validation and bounds tests.
- `api/internal/projects/document_test.go` — Cloud/local Project v1 acceptance tests.
- `api/internal/service/gemini.go`, `api/internal/service/http_test.go` — Structured Outputs effect schema and test.
- `docs/VISUAL_EFFECT_ROADMAP.md`, `docs/BLUEPRINT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/TEST_STRATEGY.md` — implemented Phase A details and contract.
- `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `CURRENT_TASK.md` — status and remaining visual review.

## 制約・未解決事項

- 実Gemini API、Hosted環境、DB/Migration、auth/AI quota制御、Python Island、既存Effect、Renderer/WebM encoder方式は変更していない。
- 視覚品質の最終確認と、新Effectを含む実ブラウザWebM再生は手動確認が必要。
- Phase AのParticle Burst/Trail等、Phase B/Cは未実装。
