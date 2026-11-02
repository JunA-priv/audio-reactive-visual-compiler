# Step 7k-11b — Kick Event検出精度改善

**status: partial**

## 結果

既存Demucs `drums` stemを使うKick detectorを更新しました。Timeline v1の`kickEvents`（整数ms）と`kickEventStrengths`（対応する0..1配列）の構造・順序・範囲契約は変更していません。Decode、Demucs、Frontend、Go validatorを変更せず、新しい依存も追加していません。

### 現行方式からの変更

- FFT frame size 2048、hop 10ms。
- 35–120Hzのriseを直前500msの局所中央値と比較。
- 35–80Hzのsub/body energyを100–250Hz帯と比較し、ratio 0.70以上を要求。
- 80ms後に低域energyがpeakの50%以下へ減衰する候補を優先し、持続Bassを除外。
- 120msのrefractory periodでpeakをまとめる。以前の180msから短縮し、140msのdouble Kickを2発として維持。
- strengthは候補scoreを全候補p99で正規化して0..1にする。

低域の短い立ち上がりと減衰を組み合わせるため、長時間の低域エネルギーだけでは発火しません。Demucs drumsは混合stemなので、Kick分離や確定ラベルではありません。

## ラベル付き合成音源の評価

時刻照合はtruth eventごとに一対一、許容差±80ms。既存Kick fixture、低い背景ノイズ中の弱いKick、Kick/Snare/Tom混合を含む正例ケースの合算では次の結果でした。

| Detector | TP | FP | FN | Precision | Recall | F1 |
|---|---:|---:|---:|---:|---:|---:|
| Legacy | 9 | 9* | 1 | 0.50 | 0.90 | 0.643 |
| Updated | 10 | 0 | 0 | 1.00 | 1.00 | 1.00 |

`*` FP 9件には、Kickを含む混合音でのTom-like誤検出3件と、negative-only Snare/Tom fixtureの6件を含みます。

- Snare-only: legacy 3件、updated 0件。
- 115Hz Tom-only: legacy 3件、updated 0件。
- 持続Bass / silence: 両方式とも0件。
- 140ms double Kick: legacy 1件、updated 2件。
- 既存Kick fixture 3件と弱いKick 2件は両方式とも3/3・2/2検出。Updatedのonsetずれはfixture上30ms以内。
- 同時Kick+Snare、再現性、低い背景ノイズ、終端、有限値・強度整合のテストを追加。

この限定された合成データではfalse positiveが減り、double Kickのrecallが改善したためupdated detectorを採用しました。特定のデモ曲へ合わせた閾値最適化はしていません。

## 既存demo比較・リソース

同じ3つの既存drums stemを両方式へ入力しました。旧方式のBaseline時刻・strength分布も別のJSONに保存し、既存生成物は上書きしていません。

| Stem | Legacy events | Updated events | Legacy feature time | Updated feature time | Peak RSS legacy / updated |
|---|---:|---:|---:|---:|---:|
| demo1 (180.2s) | 217 | 191 | 0.542s | 1.020s | 274.17 / 274.46 MiB |
| demo2 (166.0s) | 259 | 116 | 0.455s | 0.986s | 255.07 / 255.30 MiB |
| demo3 (118.1s) | 220 | 104 | 0.398s | 0.699s | 190.54 / 190.85 MiB |

各数値は新規Python processで5回実行したmedian時間と`ru_maxrss`です。更新方式はCPU時間が約1.5〜1.9倍になり、Peak RSS差は約0.3MiB以内でした。Demo曲に正解onsetラベルはないため、件数が減ったことを実曲精度の改善とは見なしません。イベント分布とstrength値は[比較JSON](2026-11-01-step7k-11b-kick-comparison.json)を参照してください。

## 変更ファイル

- `python-island/src/python_island/features.py`: 新detector、比較用legacy detector、抽出経路を更新。
- `python-island/src/python_island/pipeline.py`: Music SummaryのKick検出説明とstrength unit記述を実方式に同期。
- `python-island/tests/test_features.py`: Synthetic labeled regressionsを追加。
- `docs/reports/2026-11-01-step7k-11b-kick-comparison.json`: 旧Baseline、demo同一stem比較、合成評価結果を別保存。
- `CURRENT_TASK.md`、`docs/CURRENT_STATE.md`、`docs/OPEN_ISSUES.md`、`docs/ARCHITECTURE.md`、`docs/BLUEPRINT_SPEC.md`、`docs/TEST_STRATEGY.md`: 実装・評価・既知の実曲精度制限を記録。

## 検証

- `.venv/bin/python -m pytest -q`: **27 passed**。
- `.venv/bin/mypy --strict`: passed。
- `.venv/bin/ruff check src tests --ignore E501`: passed。
- 標準`ruff check src tests`: failed on pre-existing E501 line-length findings outside new changed lines. 新規行のE501は解消済み。
- Go Project/Cloud Timeline v1 testsと該当Service Timeline v1 validator tests: passed。Go/Frontend契約コードは変更なし。
- `git diff --check`: passed。

## 互換性・残件

Blueprint/Feature Timeline/Project/Cloud v1を維持し、`kickEvents`・`kickEventStrengths`の型と並びも変更していません。Go/Frontend validatorの変更はありません。追加CPUコストはdemo解析時間で測定済みです。

実曲に正解onsetラベルがないため、実曲Precision/Recall、低音Tomや他の低域楽器との混同、ジャンルをまたぐ一般化は未確認です。新方式は合成データでの改善を根拠に有効化しましたが、実曲の聴感レビューとラベル付き実音源評価は残ります。
