# Step 7h-3.5 — Suno生成楽曲3曲のDemucs解析・デモ統合

実施日：2026-11-01

## 結果

**status: partial（ローカル機能 completed、公開準備 pending）**。ユーザー指定の3曲を既存CPU `htdemucs`で各1回解析し、4 stem WAV・Feature Timeline v1・Music Summary・analysis metadataを曲ごとに生成した。匿名`/demo`へ選曲、音源/TL対応、フル尺の再生・停止・シークを統合した。Python 13 tests、Frontend 75 tests/typecheck/lint/build成功。Windows Chrome実機確認とモデル重みの公開・商用条件は未確認のため、ローカル実装の完了と公開準備を分けて記録する。

## 音源・分離結果

対象3曲はSuno有料プランでユーザーが作成し、デモ利用目的で提供された。元音源は削除・変更していない。元MP3はいずれも48kHz stereo、240秒以内。cached checkpointを使い、ネットワーク取得なしでCPU `htdemucs`、4 threads、shifts=0、split=true、overlap=0.25で分離した。

| Demo ID / source | MP3長 | Timeline / stem長 | Kick events | Bass / Drum samples | 分離時間 / 総時間 | peak RSS |
|---|---:|---:|---:|---:|---:|---:|
| demo1 / `audio-reactive-silent-demo1.mp3` | 180.240秒 | 180.200秒 | 217 | 18,020 / 18,020 | 95.220秒 / 100.143秒 | 1,603.9 MiB |
| demo2 / `audio-reactive-silent-demo2.mp3` | 166.080秒 | 166.040秒 | 259 | 16,604 / 16,604 | 83.450秒 / 85.812秒 | 1,502.7 MiB |
| demo3 / `audio-reactive-silent-demo3.mp3` | 118.080秒 | 118.054秒 | 220 | 11,806 / 11,806 | 62.316秒 / 64.131秒 | 1,455.5 MiB |

音源とTimelineのduration差は40ms、40ms、26msで、Frontend runtime checkの100ms許容範囲内。4 stemとも44.1kHz / stereo / PCM16。曲ごとにdrums / bass / vocals / otherの4ファイルを保存し、それぞれTimelineと同じsample frame数であることを確認した。stem WAVはdemo1あたり31,787,324 bytes/file、demo2は29,289,500、demo3は20,824,684。

すべての解析でcheckpoint SHA-256は`8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4`。checkpointは既存`~/.cache/torch/hub/checkpoints/955717e8-8726e21a.th`からのみ使用し、取得・配信・Git登録していない。

## 生成物

- `demo-assets/stems/demo1..demo3/{drums,bass,vocals,other}.wav`
- `demo-assets/generated/demo1..demo3/feature-timeline.json`
- `demo-assets/generated/demo1..demo3/music-summary.json`
- `demo-assets/generated/demo1..demo3/analysis-metadata.json`

Timelineは各曲でschemaVersion 1、`timeUnit: ms`、`sampleRateHz: 44100`、Python Island analysis versionを確認。bassEnvelope/drumEnergyは0ms起点・昇順・有限値・0..1、kickEventsは昇順・duration範囲内、kickEventStrengthsは有限値かつeventsと同数。Summary v1、metadata v1、4 stemのfile/sample metadataと実WAVの一致を検証した。Frontend配信物は各MP3と対応Timeline JSONのみ。Summary、metadata、stem、元音源作業コピー、モデル重みは含めていない。

## 実装・ファイル

- `python-island/src/python_island/cli.py`、`pipeline.py`：後方互換の任意`--stems-dir`を追加。空ディレクトリだけ受け付け、Timeline処理に使った同一Demucs出力からPCM16 stereo WAVを書き出す。stem形状/finite/durationを検査。
- `python-island/tests/test_cli.py`：CLIのstem保存、channels/sample rate/frame count、metadataを検証。
- `frontend/src/demo-assets.ts`、`demo-assets.test.ts`：3デモID/音源/TL URLの対応表、Timeline v1/schema/version/duration/finite/order/required features/array caps validator、静的読込adapter。
- `frontend/src/VisualEditor.tsx`、`visual-editor.test.tsx`：選曲UI、静的Timeline fetch、音源metadata照合（100ms以内）、曲切替時のstop/0秒seek/Blueprintリセット、play/stop/seekとaudio clock同期、欠落/不正データのエラー表示。demoでは静的Timeline GET以外のAPIを呼ばない。
- `frontend/vite.config.ts`：ローカル`vite dev`では`public/` assetsを提供し、production buildは既定で`publicDir`を無効化。配信権利確認後の明示opt-in `ARVC_DEMO_ASSETS_PUBLICATION_APPROVED=true`でのみpublic assetsをbuildへ含める。
- `frontend/public/demo/`：3つのMP3と`demo1..3.feature-timeline.json`を配置。既存`sample.wav`は維持。
- `.gitignore`、source/stems/generated README：音源コピー、4 stem、内部解析JSON、配信複製をGit除外し、公開対象と保存手順を説明。
- `CURRENT_TASK.md`、`docs/CURRENT_STATE.md`、`docs/OPEN_ISSUES.md`、`docs/ARCHITECTURE.md`、`docs/TEST_STRATEGY.md`：実装と公開保留を反映。

Blueprint v1、既存11 Effect、Renderer、Binding/Region、Go API、DB/Auth/AI quota、Hosted環境は変更なし。ユーザー向け60秒trim UIは追加していない。

## Asset / Git / 公開範囲

- `demo-assets/source/`の元MP3、`demo-assets/stems/`のWAV、`demo-assets/generated/`の内部JSON、`frontend/public/demo/`内のMP3/TL複製はいずれもGit除外を確認。
- Vite production buildは既定では`public/`を一切含めない。`ARVC_DEMO_ASSETS_PUBLICATION_APPROVED=true`を設定しない限り、demo音源/TLはproduction buildへ混入しない。ローカル開発serverでは`frontend/public/demo/`の3曲とTimelineを利用できる。opt-in build後でもmodel weight、stem、Summary、metadataは配置していない。
- この作業でHosted操作、公開、push、deployはしていない。
- ユーザーのデモ用途提供に基づきローカルで音源を処理・ビルドした。一方、htdemucs重みの公開・商用利用条件は既存ライセンス調査でも未解決。Frontend buildが音源を含むため、実公開/deploy前に音源とmodel由来データの公開条件を確認する。現時点では公開準備完了とは扱わない。

## 検証

- 3曲すべてCPU Demucs分離、4 stem保存、Timeline/Summary/metadata生成成功。各楽曲を一度だけ推論。
- Python：`pytest` — **13 passed**（Demucs CPU integrationを含む）。
- Frontend：`npm test -- --run` — **11 files / 75 tests passed**。`npm run typecheck`、`npm run lint`、`npm run build`成功。
- Runtime data audit：Timeline有限値、配列長、時刻、duration、4 stem WAV仕様、metadata fileBytes、配信用Timeline同一性を全曲で確認。
- production buildはpublicDir無効化により音源、Timeline、既存`sample.wav`を含めない。stem/summary/metadata/model weightも含まれない。
- Vite local dev smoke：demo1 MP3とTimeline JSONのGETがHTTP 200、Content-Type `audio/mpeg` / `application/json`。
- `git check-ignore`でsource/stem/generated/publicコピーを除外確認。
- Go変更なし。Windows Chrome実機再生・描画品質は未実施のためStep 7h-4に引き継ぐ。
