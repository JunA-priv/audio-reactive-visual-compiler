# Step 7k-21 — アコースティックドラムのKick検出調査

**状態：一部完了（read-only調査は完了。実アコースティック音源での精度は未検証）**

## 概要

現行Kick detectorは、分離されたKick stemではなくDemucsの混合`drums` stemを処理します。低周波上昇score、sub/body比、速い減衰gateを組み合わせています。Snare、Tom、持続Bassの誤検出を抑えるため、Step 7k-11bで意図的に保守的な設定にしました。利用可能な実曲stemには手作業のKick labelがなく、アコースティックドラム録音であるとの記録もありません。そのため、検出器がアコースティックKickを見逃すことの確認やprecision/recallの推定には使えません。

このread-only調査ではアプリcode、test、fixture、生成解析data、公開contractを変更していません。新規fileは本reportのみです。

## 現行の検出経路

1. Demucsが4 stemを生成し、`extract_features()`は`stems["drums"]`を`detect_kicks()`へ渡します。
2. detectorはchannelをmonoへ平均し、10ms hopで2048 sample FFT frameを計算します（44.1kHzで約46.4ms/frame）。
3. frameごとに35〜80Hz（`sub`）、35〜120Hz（`low`）、100〜250Hz（`mid`）のRMS相当energyを計測します。
4. 0以上の`low`上昇量を、直前500msのmedianとfloorに比較します。scoreは`log1p(rise / baseline) × sub/(sub+mid)`です。
5. 候補peakは以下すべてのgateを通過する必要があります。
   - adaptive score threshold：`max(p85(score) × 0.18, 0.08)`。
   - low-band threshold：`p65(low) × 0.12`。
   - sub/body比が`0.70`以上。
   - 80ms後のlow-band energyが候補frame energyの50%以下。
   - local maximum検査、および候補をまとめる120ms間隔。
6. candidate strengthはcandidate scoreのp99で正規化し、0〜1にclampします。event時刻はframe index × 10msで、明示的なonset時刻補正はありません。
7. `extract_features()`はFeature Timeline v1に、sort済みmillisecond単位の`kickEvents`と対応する`kickEventStrengths`を出力します。

FFT windowは時間的に重なり、event timestampはframe開始時刻ですが、各frameにはその後のsampleも含まれます。そのため時間方向のぼけと量子化はありますが、固定したonset biasがあるとは限りません。実際のoffset分布を測るにはonset label付きdataが必要です。

## 確認済み事項と今後調べる原因

### 確認済み

- 検出にはDemucsの混合`drums` stemだけを使い、codeは専用Kick stemを受け取りません。
- detectorは100〜250Hz帯に対して35〜80Hz帯へ集中したenergy、強い立ち上がり、80msでの速い減衰を要求します。それぞれが強制的な棄却gateです。
- strengthは同じclip内で検出した候補間の相対値であり、普遍的な物理音量には校正されていません。
- Step 7k-11bのsynthetic label付きtestはimpulse/weak/double Kick、Kick+Snare、Snare-only、115Hz Tom-only、持続Bass、無音、時刻を確認します。合成したcaseでの動作を示したもので、アコースティック録音での性能を示すものではありません。
- 既存Demo stemでは現行detectorが191、116、104 event、旧detectorが217、259、220 eventを出しました。この件数は診断用に限られます。source assetには手作業のonset labelがなく、文書上もアコースティック録音とは分類されていません。
- 現行の既定Bindingは`strength=0.9`、`threshold=0.1`、`attackMs=60`、`releaseMs=260`です。これはdetector thresholdとは別設定で、Effectごとに変更できます。

### アコースティック音源では未検証だが可能性のある事項

- 有効なenergyが80Hzより上に集中するアコースティックKickや、drum stemにmid-band漏れが多い場合は、sub/body比0.70を満たさない可能性があります。
- 低周波tailが長いKickは80ms/50%減衰gateを満たさない可能性があります。
- 弱いhitは、特にstem内の別位置に大音量eventがある場合、相対low-band floorまたはadaptive score gateで棄却される可能性があります。
- DemucsがKick energyを減衰させたり複数stemへ分散したりする可能性があります。このdetectorは`drums`入力にない情報を復元できません。

これらは実装済みgateから導いた仮説です。比較用のlabel付きアコースティック録音がないため、具体的な見逃しは確認されていません。

## DetectorとEffect応答の違い

信号経路は次の2段階に分かれます。

1. **Detector：** Pythonが`kickEvents`とeventごとの正規化strengthを生成し、Timeline v1に格納します。
2. **Binding/Effect：** Rendererの`rawSourceValue()`は最新Kick eventを選び、`max(60ms, releaseMs)`を使ってstrengthを指数減衰させます。続いて`evaluateBinding()`がBinding threshold、attack/release follower、Binding strengthを適用します。Particle BurstやShockwaveなどevent-based Effectも各eventへ`boundFeature()`を適用し、`binding.threshold`以下の値は0になります。

したがって、視覚応答が弱いだけではdetectorがeventを見逃した証拠になりません。eventがない、event strengthがBinding threshold以下、設定されたBinding strength/envelope、Effect固有のinfluence/visibility/opacityが原因の可能性があります。 Step 7k-20の初期設定ではSpectrum BarsとInk Diffusionは`music.energy`（`Song`）にBindingされ、既定では`kick.events`を使いません。Kick固有の応答には、Kickを選ぶEffect/source設定が必要です。

次の診断では同じtimestampでTimeline Kick eventの有無、strength、最終Binding値を確認するのが有効です。公開contractを変えず、detector見逃しと視覚応答調整を切り分けられます。

## ラベルのないローカル素材の確認

既存のローカルDemo stem 3つと生成Timelineを、前回Step 7k-11b比較reportとasset metadataで確認しました。Demo目的のユーザー作成Suno trackと記録されており、アコースティックドラム分類、手作業のonset時刻、聴取に基づく受け入れlabelはありません。event件数やstrength分布をrecall/precisionやアコースティックKick性能の証拠として解釈できません。外部data送信や新規解析出力はありません。

**見逃し/誤検出/時刻精度：** これらの曲では定量化できません。synthetic test setにはlabelがあり所定caseに通りますが、アコースティック録音の代わりにはなりません。

## 対応案

| Approach | Fit to current implementation | Main risk / required evidence |
|---|---|---|
| Lower fixed detector gates (ratio, decay, score) | Small code change | Likely trades missed Kicks for low Tom/Bass/Snare bleed; unsupported without labeled acoustic examples. |
| Adaptive thresholds | Some adaptation already exists (preceding median, clip percentiles, p99 strengths) | Existing adaptive values still retain hard ratio/decay gates; adding adaptation can drift by arrangement and clip length. Needs cross-track labels. |
| Low-band spectral flux/onset path | Could complement the existing rise score and capture attacks with different spectra | A second permissive path can increase false positives; it needs a labeled ablation and the same Timeline output contract. |
| Use drum stem plus original mix | Original audio is already available to feature extraction | More bleed and duplicate candidates; requires cross-source matching and labeled tests. It is a broader change than changing a detector gate. |

## 推奨する最小限の次の手順

現状の素材だけを根拠にdetector thresholdを変更しないでください。アコースティック音源でどのgateが見逃しを生むか証拠から特定できず、gateを下げるとStep 7k-11bで導入した誤検出抑制を損なうためです。

次の実装作業では、まずKick onsetを手作業でannotationしsource provenanceを記録した、小規模のローカル保管アコースティックドラム評価setを用意します。弱/強hit、異なる調律/tail長、Kick+Snare/Tom重複、Kick以外の低周波negativeを含めます。現行detectorは変更せず、既存synthetic testと比較できる±80ms規則で1対1 onset matchingを行い、各候補のgate棄却理由も記録します。その後、現在のratio/decay gateをoffline ablationします。Timeline v1 fieldと現行APIを維持しながら、label付きKick recallを改善し、label付き誤検出を大きく増やさない最小限のgate調整または補完onset経路だけを実装します。

これは証拠に基づく最小計画です。具体的な数値threshold変更を行う根拠はまだありません。label付きアコースティック素材を用意できない場合はdetectorを変更せず、labelのないevent件数の減少を精度向上と見なさずに不確実性を報告してください。

## 実装stepのtest計画

- Preserve all current synthetic labeled tests: weak and strong Kick, Kick+Snare, Snare-only, Tom-only, sustained Bass, silence/noise, close double-Kick, deterministic output, terminal boundary, and strength alignment/range.
- Add locally stored acoustic examples with annotated onsets and representative low-frequency negatives; keep samples local and do not upload them.
- Compare current and candidate detectors with one-to-one matching; report TP/FP/FN, precision/recall/F1 per recording and aggregate, plus onset error distribution. Do not tune and report on the same small set without a held-out subset.
- Add threshold-ablation diagnostics showing which condition rejects each labeled positive and negative. Keep diagnostic internals out of the public Timeline/API.
- Verify Timeline v1 schema, integer millisecond ordering/range, event-strength array alignment and 0..1 bounds; run existing Frontend/Go Timeline validation and Binding/Effect regression tests.
- Separately evaluate renderer Binding values at labeled event times for thresholds around the configured values; do not conflate detector metrics with visible Effect response.

## 互換性と範囲

Blueprint、Timeline v1、Project、Cloud、Audio Analyze API、Demucs model/weights、検出code、Frontend Binding挙動、dependencyは変更していません。将来detectorだけを変更する場合も既存`kickEvents`/`kickEventStrengths` contractを維持できます。DB、auth、Hosted、外部serviceの操作はありません。

## 未確認事項

- 報告されたKick応答の弱さがdetector見逃しかBinding/Effect設定によるものか。
- 実アコースティックドラム録音と低いTom/Bassが混ざったKickでの性能。
- 実曲でのprecision、recall、F1、onset offset。
- 対象sourceでDemucsが特定のアコースティックKick transientを減衰させるか。
- 実browserでのEffectごとの知覚応答。このtaskではbrowser変更や視覚受け入れ判断をしていません。

## 参照

- `python-island/src/python_island/features.py`: `detect_kicks()`, `extract_features()`.
- `python-island/tests/test_features.py`: synthetic detector fixtures and regressions.
- `frontend/src/renderer.ts`: `baseEvents()`, `rawSourceValue()`, `evaluateBinding()`, `boundFeature()`.
- `frontend/src/VisualEditor.tsx`: `bindingFor()` defaults and source selection.
- `docs/BLUEPRINT_SPEC.md`: Kick detector and Timeline v1 facts.
- `docs/TEST_STRATEGY.md`: Step 7k-11b detector evaluation coverage.
- `docs/reports/2026-11-01-step7k-11b-kick-detection.md` and `docs/reports/2026-11-01-step7k-11b-kick-comparison.json`: prior synthetic and unlabeled demo comparisons.
- `docs/OPEN_ISSUES.md`: real-song Kick precision/recall remains pending.
