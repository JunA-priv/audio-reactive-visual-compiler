# Audio Analysis output validation 調査・修正

日付：2026-11-11

状態：partial（具体的原因を修正しPR #20 merge、Worker 100%切替完了。失敗音源の再解析は未確認）

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
- 修正branch commit `20550e9`をPR #20へpush
- `python-island/tests/test_features.py` と `test_cli.py`：30 tests PASS。over-range stem peakのclippingと20ms境界の切り上げを回帰確認。
- `git diff --check`：PASS

Go testsは書込み可能な`/tmp` build cacheを指定して実行しPASSした。`service` packageはsandbox内localhost socket拒否で一度失敗したが、通常権限で再実行してPASS。

## デプロイ結果と残作業

固定SCNet checkpointは`python-island/tools/scnet-poc/external/checkpoints/checkpoint.th`にあり、42,434,545 bytes / SHA-256一致を確認した。Docker Buildxで`linux/amd64`イメージを構築し、private Artifact Registryへpushした。

- Image tag: `audio-waveform-clip-20261111-20550e9`
- Image index digest: `sha256:33aa2d57c0c13955a9ad51c10f85858f4503e2d1637611aa1ab6e3a470aabb5a`
- Cloud Run resolved image digest: `sha256:9b9c5effbf908b07e6d23e989e2e47ebb54acad5c6cb4a57b23d7e170d49230e`
- Worker revision: `arvc-audio-worker-00017-wot`
- Region: `asia-northeast1`
- PR #20 merge commit: `5fbb2a24a3d365377e7d13bb0843a6c6354687c3`

最初に作成したrevision `00011-wdr`は0% trafficでRetiredとなり、traffic切替を試みた際は自動レビューにより停止リスクを理由に拒否された。その後、ユーザーから明示的な切替依頼を受け、Retired revisionを直接有効化せず、同一image digestを新しいcanary revision `00017-wot`として配置した。Cloud RunでReady / ContainerHealthyを確認後、traffic 100%を`00017-wot`へ切り替えた。旧revision `00010-cfj`は0% traffic。`00017-wot`の切替後ERRORログは確認されていない。

前回の`GET /healthz`はinvoke権限不足で404となったため、IAMは変更していない。Container startup readinessは成功。Workerへ実タスクを再送せず、失敗音源の再解析もしていないため、次の確認はユーザーが同じ音源を再解析すること。新たに失敗する場合は`validation_reason`と`validation_detail`を確認する。

Hosted Supabase、DB/Auth/Storage、Cloud Tasks、GCP IAM、API serviceは変更していない。Githubへの更新はPR #20のmergeまで。