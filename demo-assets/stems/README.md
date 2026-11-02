# ローカル分離stem

分離stemは容量と音源由来の権利を考慮し、Git管理・アプリ配信をしません。

Python Island CLIの`--stems-dir`を指定すると、Timeline抽出に使った同一のDemucs推論結果からdrums / bass / vocals / otherのPCM16 stereo WAVを保存します。StemはGit管理・Frontend配信対象にしません。

`demo4-kick-evaluation/`はStep 7k-23のローカル評価用stemです。音源の権利とアコースティック録音かどうかは未確認のため、公開・配信しません。

重みの利用条件はコードのライセンスと別に確認が必要です。現行`htdemucs`の公開・商用利用条件は未解決で、詳細は[音源分離モデル重みの調査](../../docs/reports/2026-10-31-separation-model-weights-license-review.md)を参照してください。
