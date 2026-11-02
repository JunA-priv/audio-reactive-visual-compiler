# 解析生成物

各曲の`demo-assets/generated/<demo-id>/`へPython Island CLIが次を出力します。

- `feature-timeline.json`
- `music-summary.json`
- `analysis-metadata.json`

Step 7k-23では`demo4-kick-evaluation/`に上記生成物と`kick-candidates-unverified.json`をローカル保存しました。後者は現行detector由来の人手確認待ち候補であり、正解ラベルmanifestではありません。聴取・権利確認が終わるまでPrecision/Recall評価や公開データとして扱わないでください。

出力先は空である必要があり、既存結果を上書きしません。stem保存を同時に行う場合も、同一のDemucs CPU推論結果を再利用します。

```sh
cd python-island
uv run --locked python-island ../demo-assets/source/<authorized-audio.mp3> \
  --output-dir ../demo-assets/generated/<demo-id> \
  --stems-dir ../demo-assets/stems/<demo-id> --threads 4
```

CPU `htdemucs`、最大4分、threads 1〜16（既定4）。checkpointが既存cacheにない場合はCLIが失敗し、implicit downloadは行いません。`--stems-dir`は任意で、空の出力先へ44.1kHz stereo PCM16 WAVを4本保存します。stem形状・Finite値・duration/channelsの不一致を拒否します。

Timeline v1は`schemaVersion: 1`、`timeUnit: ms`、`sampleRateHz: 44100`、`durationMs`、`bassEnvelope`、`kickEvents`、`kickEventStrengths`、`drumEnergy`を含みます。Frontendの`demo-assets.ts`はschema/version、duration、0ms起点、時刻順、有限範囲値、配列上限、Kick event/strength対応をruntime検証します。音源HTML metadataとのduration差は100ms以内を要求します。

`generated/`のJSONと`stems/`のWAVは内部・ローカル解析用です。Step 7k-11aのSpectrum sidecarは`<demo-id>-step7k11/spectrum.json`へ追加し、既存music PCMをdecodeしてFFTだけを計算します（Demucsは再実行しません）。Frontendには再生MP3、対応Timeline JSON、`<demo-id>.frequency-spectrum-v1.json`の別sidecarを置きます。既存Timeline/stem/audioは上書きしません。Summary、metadata、stem、source作業コピー、モデル重みは配信しません。これらのデータとFrontend複製はGit除外です。公開・deploy前には音源とhtdemucs重み由来データの公開条件を確認してください。詳細は[Step 7h-3.5報告](../../docs/reports/2026-11-01-step7h-3-5-demo-audio-assets.md)。

Vite local devは`public/`を配信します。production buildは既定で`publicDir`を無効にしてdemo mediaを除外します。公開権利レビューが終わった後のopt-in方法は`frontend/vite.config.ts`の`ARVC_DEMO_ASSETS_PUBLICATION_APPROVED`を参照してください。
