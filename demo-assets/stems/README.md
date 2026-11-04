# ローカル分離stem

分離stemは容量と音源由来の権利を考慮し、Git管理・アプリ配信をしません。

Python Island CLIの`--stems-dir`を指定すると、Timeline抽出に使った同一のSCNet標準推論結果からdrums / bass / vocals / otherのPCM16 stereo WAVを保存します。開発用Demucs比較はCLIへ`--engine htdemucs`を明示します。StemはGit管理・Frontend配信対象にしません。

`demo4-kick-evaluation/`はStep 7k-23のローカル評価用stemです。音源の権利とアコースティック録音かどうかは未確認のため、公開・配信しません。

SCNet standard is the selected model for published builds. Its checkpoint remains external to Git and package artifacts. Demucs and its official weights are retained for local development only and are excluded from standard dependencies and published deliverables. Demucs-derived training examples must retain their pseudo, unverified origin; do not mark them human-verified.
