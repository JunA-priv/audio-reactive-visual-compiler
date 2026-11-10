# Audio Analysis output validation 調査・修正

日付：2026-11-11

状態：partial（ローカル修正・検証・Worker再デプロイ完了。過去のjob固有原因の確定とinvoke可能なsmoke確認は未完）

## 調査結果

Cloud Run Workerの`POST /internal/tasks/audio-analysis`はHTTP 204で終了し、その直後に`invalid_analysis_output`が記録されていた。204はCloud Tasksへの処理応答であり、解析成功を示さない。

実装上、この分類はPython runnerが正常終了した後、Goが`feature-timeline.json`、`music-summary.json`、`analysis-metadata.json`を読み、schema・音源メタデータ・durationを検証したときに発生する。Pythonプロセス起動失敗や期限切れとは異なる経路である。

具体的に見つかった契約不整合は、Pythonが`durationMs`を最近傍ミリ秒へ丸める一方、Waveform PeaksとFrequency Spectrumの最終部分フレームを実サンプル数から出力していた点。実際の長さが20ms境界をわずかに超えても`durationMs`が境界値へ丸められると、Go側は`ceil(durationMs / 20ms)`でフレーム数を1つ少なく期待し、正しい解析出力を拒否し得る。

ただし、過去の警告ログは分類と所要時間しか記録していない。ジョブ終了後に失敗入力のStorage objectはcleanupされ、保存済み情報にも対象WAVのサンプル数・正確なdurationがない。そのため、過去2件がこの境界不整合に該当したかは断定できない。

## 実装

- Pythonの`durationMs`をsample frame数から整数演算で切り上げ、最後の部分20msフレーム数と整合させた。
- Workerの出力拒否ログに`validation_reason`と`validation_detail`を追加した。detailは固定された検証エラー文言とfield indexのみで、音声内容・JSON本文・資格情報を含まない。
- 外部API、DB schema、認証、公開契約、SCNet標準経路は変更していない。

## 検証

- `api/internal/audioanalysis` focused Go tests：PASS
- `python-island/tests/test_cli.py`：7 tests PASS。20ms境界を1 sample超えた時の切り上げも回帰確認。
- `git diff --check`：PASS

Go testは初回、既定のbuild cacheがread-onlyで失敗したため、書込み可能な`/tmp` cacheを指定して実行しPASSした。

## デプロイ結果と残作業

固定SCNet checkpointは`python-island/tools/scnet-poc/external/checkpoints/checkpoint.th`にあり、42,434,545 bytes / SHA-256一致を確認した。Docker Buildxで`linux/amd64`イメージを構築し、private Artifact Registryへ次のtagでpushした。

- Image tag: `audio-validation-20261111-6af7d86`
- Image index digest: `sha256:f80fda76d8331fe43904a444d459b1f98ac416bd613a0d78cea53192a6ec755b`
- Cloud Run resolved image digest: `sha256:263921feac100f5495af6cf44caf8e8344d6719736cc44102db5980060988a06`
- Worker revision: `arvc-audio-worker-00010-cfj`
- Region: `asia-northeast1`

新revisionはCloud RunでReady / Containers healthyとなり、Worker traffic 100%を新revisionへ切り替えた。既存のrevision tagsは保持され、API serviceは変更していない。

`GET /healthz`は404となり、request logも生成されなかった。Cloud Runのprivate invoke権限不足で拒否されたと判断し、IAM bindingは変更していない。revisionのstartup readinessは成功しているが、invoke可能なcallerによるHTTP smokeと実SCNet再解析は未確認。ユーザーが失敗音源を再度解析すると、新しい`validation_reason`/`validation_detail`で理由を確認できる。

既存の`hosted-release-approved.yml`はHosted Supabase migration applyを含むため起動していない。Hosted Supabase、DB/Auth/Storage、Cloud Tasks、GCP IAMに変更なし。GitHubへのpush・PR作成なし。作業変更はローカルのみ。
