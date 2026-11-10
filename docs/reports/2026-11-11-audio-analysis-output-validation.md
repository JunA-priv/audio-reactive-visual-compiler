# Audio Analysis output validation 調査・修正

日付：2026-11-11

状態：partial（validatorログで具体的原因を特定し、修正・回帰test済み。追加修正版のdeploy待ち）

## 調査結果

Cloud Run Workerの`POST /internal/tasks/audio-analysis`はHTTP 204で終了し、その直後に`invalid_analysis_output`が記録されていた。204はCloud Tasksへの処理応答であり、解析成功を示さない。

実装上、この分類はPython runnerが正常終了した後、Goが`feature-timeline.json`、`music-summary.json`、`analysis-metadata.json`を読み、schema・音源メタデータ・durationを検証したときに発生する。Pythonプロセス起動失敗や期限切れとは異なる経路である。

具体的に見つかった契約不整合は、Pythonが`durationMs`を最近傍ミリ秒へ丸める一方、Waveform PeaksとFrequency Spectrumの最終部分フレームを実サンプル数から出力していた点。実際の長さが20ms境界をわずかに超えても`durationMs`が境界値へ丸められると、Go側は`ceil(durationMs / 20ms)`でフレーム数を1つ少なく期待し、正しい解析出力を拒否し得る。

その後revision `arvc-audio-worker-00010-cfj`から`validation_detail="featureTimeline.waveformPeaks.drums[56] is invalid"`を含むログが得られ、具体的な不整合を特定した。Go validatorは各peakのmin/maxをfiniteで、両方とも`[-1, 1]`、かつmin <= maxであることを要求する。Pythonの`_waveform_peaks`はSCNet stemsのfinite値を確認していたがfull-scale clipしておらず、ステムの過大振幅がtimelineに残り得た。ステムWAV writerは既にPCM出力時にclipしていたため、Timelineピーク生成だけが契約と不一致だった。エラーメッセージ自体は数値を含めない設計なので、正確な超過値はログにはないが、finiteなmin/maxを作る現Producerとvalidator条件から、実際の拒否原因はpeak値のfull-scale範囲超過と特定できる。

## 実装

- Pythonの`durationMs`をsample frame数から整数演算で切り上げ、最後の部分20msフレーム数と整合させた。
- Waveform Peaksの生成前にSCNet stemを`[-1, 1]`へclipし、Go APIのsigned-full-scale契約とPCM WAV出力を一致させた。
- Workerの出力拒否ログに`validation_reason`と`validation_detail`を追加した。detailは固定された検証エラー文言とfield indexのみで、音声内容・JSON本文・資格情報を含まない。
- 外部API、DB schema、認証、公開契約、SCNet標準経路は変更していない。

## 検証

- `api/internal/audioanalysis` と`api/internal/service` focused Go tests：PASS
- `python-island/tests/test_features.py` と `test_cli.py`：30 tests PASS。over-range stem peakのclippingと20ms境界の切り上げを回帰確認。
- `git diff --check`：PASS

Go testsは書込み可能な`/tmp` build cacheを指定して実行しPASSした。`service` packageはsandbox内localhost socket拒否で一度失敗したが、通常権限で再実行してPASS。

## デプロイ結果と残作業

固定SCNet checkpointは`python-island/tools/scnet-poc/external/checkpoints/checkpoint.th`にあり、42,434,545 bytes / SHA-256一致を確認した。Docker Buildxで`linux/amd64`イメージを構築し、private Artifact Registryへ次のtagでpushした。

- Image tag: `audio-validation-20261111-6af7d86`
- Image index digest: `sha256:f80fda76d8331fe43904a444d459b1f98ac416bd613a0d78cea53192a6ec755b`
- Cloud Run resolved image digest: `sha256:263921feac100f5495af6cf44caf8e8344d6719736cc44102db5980060988a06`
- Worker revision: `arvc-audio-worker-00010-cfj`
- Region: `asia-northeast1`

既存のduration/logging修正を含むrevision `arvc-audio-worker-00010-cfj`はCloud RunでReady / Containers healthyとなり、Worker traffic 100%を受けている。今回特定したover-range peak clipping修正は現在のmain/PRに追加作業中で、まだimageへbuild/deployしていない。API serviceは変更していない。

`GET /healthz`は404となり、request logも生成されなかった。Cloud Runのprivate invoke権限不足で拒否されたと判断し、IAM bindingは変更していない。revisionのstartup readinessは成功しているが、invoke可能なcallerによるHTTP smokeと実SCNet再解析は未確認。over-range peak clipping修正を含む新Worker revisionをdeploy後、失敗音源を再解析して成功を確認する。なお外部`GET /healthz`はinvoke権限不足で404となるため、IAMは変更せず、invoke可能なcallerによるsmokeは未実施。

既存の`hosted-release-approved.yml`はHosted Supabase migration applyを含むため起動していない。Hosted Supabase、DB/Auth/Storage、Cloud Tasks、GCP IAMに変更なし。GitHub PR #20はopenで、追加修正は未commit。
