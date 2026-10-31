# 技術構成と選定状況

DECIDED：React/TypeScript/Vite、Canvas 2D、Go/Echo、Python/Demucs CPU、Gemini、Supabase Auth/PostgreSQL、Cloud Run、Cloudflare Pages/R2、GitHub Actions。クラウドは実装済みではない。

PROPOSED：Node 24.22.1 LTS。2026年10月21日の公式修正版を根拠とする。npmは同梱版の実測とアドバイザリ照合後に固定。その他の依存は版未確定。

導入・公式URL・未検証区分は[ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md)。同資料にあるnvm版も導入手順の候補であり、全依存の安全性監査完了を意味しない。

DECIDED：採用時に確認日・公式advisory・互換性・完全版番号・lock・検証結果を記録する。Demucsは元リポジトリがアーカイブ済みのため、PyTorch/torchaudioとの互換性と既知の脆弱性を別環境で評価する。
