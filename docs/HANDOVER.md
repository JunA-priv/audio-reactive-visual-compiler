> 原典保存（末尾空白・改行形式は整形）：2026年10月31日のユーザー提供メモ。過去時点の状態を含む。現在の状況はCURRENT_STATE.mdを参照。

# AI Audio-Reactive Visual Compiler
# 開発引き継ぎメモ

**作成日：2026年10月31日**
**プロジェクト：AI Audio-Reactive Visual Compiler**
**開発形態：個人開発**
**使用予定：ChatGPT / ChatGPT Work / Codex / Codex CLI**
**現在の状態：要件・基本アーキテクチャ検討済み、実装着手前**

---

## 1. この引き継ぎメモの目的

本メモは、新しいチャットやAI開発エージェントが過去の会話を参照できなくても、同じ前提・判断基準・技術方針で開発を再開できるようにするための資料である。

開発では以下を重視する。

- 要件と責務境界を明確にする
- 実装前の決定事項と実装済みの事実を区別する
- ローカル開発を基本とする
- 初期段階からクラウドデプロイを想定する
- AIには演出設計を担当させ、描画は決定論的に処理する
- 無料〜低額で運用する
- 不要な再実装や過剰な抽象化を避ける
- コード・テスト・設計書の整合性を維持する
- 品質担保の根拠を第三者が追跡できるようにする

**重要：本メモは引き継ぎ時点の設計・計画であり、コードの実装完了を証明するものではない。**

---

## 2. 背景と開発目的

### 2.1 開発目的

Wano株式会社のフルスタックエンジニア職に対しても提示できる、実際に動作するポートフォリオ用Webアプリケーションを個人開発する。

React / TypeScript、Go / Echo、Python、生成AI、クラウド、認証・認可、非同期ジョブ、CI/CDなどを組み合わせ、技術選定・設計・実装・品質検証の能力を示す。

ただし、採用選考だけに依存するプロジェクトではなく、個人開発として継続できる構成とする。

### 2.2 プロダクトの着想

昔のニコニコ動画で公開されていたボーカロイド楽曲などに見られる、1枚絵を主体とした簡易MVがイメージに近い。

音源と1枚絵を入力し、その画像の上に音楽に反応する図形、粒子、グロー、波形、ノイズなどを重ねる。

AIがMV全体を動画生成するのではなく、AIが楽曲に適した演出を設計し、映像描画エンジンが演出を実行する。

### 2.3 プロダクト定義

**AI Audio-Reactive Visual Compiler**

音源と背景画像から、楽器ごとの音響特徴量に同期したビジュアルエフェクトを生成し、ブラウザ上で編集・動画出力できるWebアプリケーション。

中心となる設計原則：

**AIが演出Blueprintを生成し、人間が編集し、決定論的なRendererが映像を描画する。**

---

## 3. 今回の開発で決定した制約

### 3.1 開発環境

- ローカル開発を基本とする
- Windows 11 / WSL2 Ubuntu / Dockerを基本環境として想定
- GitHubでソースコードを管理する
- ChatGPT、ChatGPT Work、Codex、Codex CLIを使用する
- 本番クラウドへのデプロイを前提にアーキテクチャを設計する

### 3.2 費用

**クラウド運用費は月額1,000円以内を目標とし、可能な限り0円を目指す。**

これは目標予算であり、クラウド事業者が請求上限を保証するものではない。

クラウドリソースの利用回数、ジョブ数、同時実行数、音源長、ファイルサイズ、保存期間を制御する。

有料リソースの作成やデプロイは、料金見積もりを確認してから明示的に許可する。

### 3.3 音源分離

MVPではCPUを第一候補とする。

使用候補モデルはDemucs v4の`htdemucs`。

GPUは必須とせず、CPUの処理時間・メモリ・分離精度が要件を満たさない場合に再検討する。

### 3.4 初期ローンチの目的

音源と1枚絵から簡易MVを完成させ、後から演出を編集・復元できること。

商用課金やAI素材生成は今回実装しない。

---

## 4. MVPの機能要件

| ID | 機能 | 初回ローンチ対象 |
|---|---|---|
| M01 | MP3 / WAV音源入力 | 対象 |
| M02 | PNG / JPEG背景画像入力 | 対象 |
| M03 | 単色・グラデーション背景 | 対象 |
| M04 | Demucs 4 Stem音源分離 | 対象 |
| M05 | Kick・Bass等の特徴量抽出 | 対象 |
| M06 | GeminiによるVisual Blueprint生成 | 対象 |
| M07 | Blueprintのスキーマ検証 | 対象 |
| M08 | 音響連動Canvas描画 | 対象 |
| M09 | エフェクトの手動編集 | 対象 |
| M10 | エフェクトの領域選択 | 対象 |
| M11 | 音声付き動画出力 | 対象 |
| M12 | 無音動画出力 | 対象 |
| M13 | 暗号化Blueprint出力 | 対象 |
| M14 | Blueprint再インポート | 対象 |
| M15 | Supabase認証 | 対象 |
| M16 | プロジェクト保存・再編集 | 対象 |
| M17 | 認証不要の固定サンプルデモ | 対象 |

### 4.1 初期エフェクト

次の5種類を初期候補とする。

- Pulse / Scale
- Glow / Brightness
- Rotation / Movement
- Particles
- Waveform / Bars

それぞれのエフェクトについて、音響Source、強度、閾値、Attack、Releaseなどを編集可能にする。

### 4.2 音響解析

Demucsでは原則として以下の4 Stemを分離する。

- Drums
- Bass
- Vocals
- Other

KickはDemucsから直接出力される独立Stemではない。

Drums Stemに対して低周波エネルギーやOnset検出などを適用し、Kick Event Timelineを推定する。

BassはRMSやEnvelopeなどの連続的な特徴量を取得する。

音響特徴量を一定間隔の数値配列、またはイベント時刻と強度のリストとして保存する。

特徴量の初期サンプリング候補は100Hz程度。ただし、分解能・モデル精度・必要容量を検証して確定する。

### 4.3 Geminiによる演出設計

Geminiには音源全体の波形配列を出力させない。

Pythonが生成したMusic Summaryや使用可能なFeature一覧を入力として与え、コンパクトなVisual Blueprintのみを生成させる。

Geminiの応答は定義済みスキーマで検証する。

任意のJavaScript、Python、GLSLコードをAIに生成させて実行する方式は採用しない。

Geminiの使用モデルID、無料枠、料金、利用上限は、実装時に公式仕様を確認して確定する。

---

## 5. 領域選択・マスク機能

今回のプロダクトにとって重要な機能。

ユーザーがアップロードした1枚絵のうち、指定した範囲だけにエフェクトを適用できるようにする。

### 具体例

左側にバンドメンバーの写真、右側に手描きのCDラベルが配置された画像を想定する。

左側の人物写真にだけPulse、Glow、Particlesなどを適用し、右側の手描き領域は静止させる。

### MVP

- 矩形選択
- 多角形選択
- マスクの作成・編集・削除
- エフェクトごとの対象Region設定
- 正規化座標での保存
- プレビューと動画出力で同じマスク処理を使用

### 将来拡張

- ブラシ選択
- Feather
- AIによる人物・背景自動抽出
- 複数レイヤーの高度なマスク
- 画像のAI加工

### 責務

Regionは「どこに適用するか」を定義する。

Effectは「何をするか」を定義する。

Bindingは「どの音響特徴量で、どう制御するか」を定義する。

これらを混在させない。

---

## 6. Blueprint / Renderer設計

### 6.1 基本構造

```text
Visual Project
├── Visual Blueprint
│   ├── Scene
│   ├── Regions
│   ├── Layers
│   ├── Effects
│   ├── Bindings
│   └── Sections
├── Feature Timeline
│   ├── Kick Onset Events
│   ├── Bass RMS
│   ├── Drum Energy
│   └── Other Features
├── Assets
│   └── Background Image
└── Reproduction Metadata
    ├── Schema Version
    ├── Renderer Version
    ├── Analysis Version
    ├── Audio Hash
    └── Random Seed
```

### 6.2 データフロー

```text
Audio Upload
    ↓
Demucs Separation
    ↓
Feature Extraction
    ↓
Feature Timeline + Music Summary
                       ↓
                    Gemini
                       ↓
                 Visual Blueprint
                       ↓
                 Schema Validation
                       ↓
Blueprint + Feature Timeline + Playback Time
                       ↓
                 Visual Renderer
                       ↓
                  Browser Canvas
                       ↓
               Video / .arvb Export
```

### 6.3 Rendererの設計原則

同一のBlueprint、Feature Timeline、再生時刻、Rendererバージョン、Random Seedから同じ描画命令が得られることを目指す。

概念上の処理：

```text
RenderFrame =
  evaluateScene(
    Blueprint,
    FeatureTimeline,
    playbackTime
  )
```

フレームレートや過去のフレーム描画順序に依存してエフェクト結果が変化しないように設計する。

音楽再生時刻を基準として特徴量を参照する。

シーク時のAttack / Release、粒子配置、乱数処理についても再現可能性を考慮する。

なお、動画エンコード後のファイルが異なる環境でバイト単位まで一致することは初期要件にしない。

---

## 7. 出力形式

### 7.1 動画

MVPでは以下を実装する。

1. 音声付き動画
2. 無音動画

ブラウザ側でCanvasを描画し、動画として書き出す。

最初はWebMを基本形式として検証する。

MP4/H.264/AACの安定した出力、およびブラウザ横断的な互換性はPhase 2で扱う。

### 7.2 暗号化Blueprint

専用拡張子の候補：

`.arvb`

保存対象：

- Visual Blueprint
- Feature Timeline
- 背景画像などの再描画に必要な素材
- Schema / Renderer / Analysis Version
- Audio Hash
- Random Seed

圧縮と暗号化を行う。

暗号化方式の候補はAES-256-GCM。

暗号鍵はGo側で管理し、フロントエンドに秘密鍵を埋め込まない。

元音源は原則として`.arvb`に含めない。

そのため、Blueprintから映像表現を復元することはできても、音声付き動画の出力には元音源を再選択する必要がある。

### 7.3 秘匿性の制約

暗号化ファイルを保護できても、ブラウザ上で使用するBlueprintやRenderer内部情報を利用者から完全に秘匿することはできない。

MVPで保証を目指すのは、配布ファイルの暗号化・改ざん検知であり、クライアント側のアルゴリズム完全秘匿ではない。

---

## 8. 技術スタックとクラウド構成

以下は現時点の採用方針・候補であり、デプロイ実績ではない。

| レイヤー | 技術・サービス |
|---|---|
| Portfolio | Astro SSG |
| Portfolio Hosting | Cloudflare Pages |
| Product Frontend | React / TypeScript / Vite |
| Product Hosting | Cloudflare Pages |
| Backend | Go / Echo |
| API Hosting | Google Cloud Run Services |
| Python Island | Python |
| Source Separation | Demucs `htdemucs` |
| Job Hosting | Google Cloud Run Jobs |
| CPU/GPU | MVPではCPU第一候補 |
| Blueprint AI | Gemini API |
| Authentication | Supabase Auth |
| Database | Supabase PostgreSQL |
| Object Storage | Cloudflare R2 |
| Rendering | Browser Canvas 2D |
| CI/CD | GitHub Actions |
| Local Development | WSL2 / Docker |

### 8.1 Go APIの責務

- Supabase JWTの検証
- ユーザー認可
- プロジェクトCRUD
- 解析ジョブ管理
- Cloud Run Jobsの起動・結果管理
- Gemini API呼び出し
- Blueprintの検証
- `.arvb`の暗号化・復号
- 実行回数・ファイルサイズ等の制限

### 8.2 Python Islandの責務

- 音源デコード
- Demucsによる4 Stem分離
- 音響特徴量抽出
- Music Summary生成
- Feature Timelineの生成・保存

Python IslandはGo APIから責務を分離する。

ローカルではPython処理を直接実行し、クラウドではCloud Run Jobsから呼び出す。

### 8.3 Cloud Run Jobsの初期設定候補

- 2 vCPU
- 4 GiB
- CPU実行
- 同時ジョブ数1
- タイムアウト30分
- 自動再試行は初期状態で抑制
- 最大4分音源で性能検証

すべて初期候補であり、実測後に確定する。

過去の議論で4分音源のCPU分離を6〜12分と推定したが、Cloud Runでの実測値ではない。

性能要件の保証値として扱わない。

---

## 9. GitHubリポジトリ方針

### 9.1 リポジトリ分離

ポートフォリオサイトと各プロダクトは別リポジトリで管理する。

想定：

```text
GitHub Account
├── portfolio-site
└── audio-reactive-visual-compiler
```

PortfolioとProductは個別にビルド・テスト・デプロイできる構成とする。

各プロダクト内のフロントエンド・バックエンド・Python Islandは、同じアプリケーションの構成要素なので、原則として1つのリポジトリで管理する。

### 9.2 URL構成

独自ドメインを利用する場合の案：

```text
example.com
audio.example.com
api.audio.example.com
```

独自ドメイン購入前は各ホスティングサービスの標準URLで開発してよい。

### 9.3 リポジトリ構成案

```text
audio-reactive-visual-compiler/
├── frontend/
├── backend/
├── python-island/
├── contracts/
├── infra/
├── tests/
├── docs/
│   ├── PROJECT_CONTEXT.md
│   ├── REQUIREMENTS.md
│   ├── ARCHITECTURE.md
│   ├── TECH_STACK.md
│   ├── API_CONTRACTS.md
│   ├── BLUEPRINT_SPEC.md
│   ├── DEVELOPMENT_RULES.md
│   ├── DEVELOPMENT_WORKFLOW.md
│   ├── ENVIRONMENT_SETUP.md
│   ├── DEPLOYMENT.md
│   ├── TEST_STRATEGY.md
│   ├── SECURITY.md
│   ├── COST_MANAGEMENT.md
│   ├── CURRENT_STATE.md
│   ├── DECISION_LOG.md
│   ├── OPEN_ISSUES.md
│   └── reports/
├── .github/workflows/
├── CURRENT_TASK.md
├── .env.example
├── compose.yaml
└── README.md
```

ディレクトリ・ファイルは役割に応じて作成し、空のファイルを機械的に大量生成する必要はない。

---

## 10. ドキュメント管理の要件

`docs/`を品質管理の根拠として使用する。

単なる設計案の保管場所ではなく、設計、実装、テスト、運用、判断履歴を追跡できるようにする。

### 10.1 記載ステータス

| ステータス | 定義 |
|---|---|
| FACT | コード・設定・テスト・実行結果で確認した事実 |
| DECIDED | 決定済みだが実装済みとは限らない仕様 |
| PROPOSED | 未確定の検討案 |
| HYPOTHESIS | 実測していない性能・費用・効果等の推定 |
| BLOCKED | 実装・検証が阻害されている事項 |

FACTを記載するときは、必ず実装ファイルや検証結果と照合する。

可能な範囲でファイルパス、関数名、テスト名、コマンド、検証結果を根拠として記載する。

コードで確認できないことを実装済みと書かない。

### 10.2 必須ドキュメントの役割

- `PROJECT_CONTEXT.md`：目的・背景・制約・対象範囲
- `REQUIREMENTS.md`：要件・受け入れ条件
- `ARCHITECTURE.md`：責務境界・システム構成・データフロー
- `TECH_STACK.md`：採用技術・バージョン・選定根拠
- `API_CONTRACTS.md`：API入出力・認証・エラー・ジョブ状態
- `BLUEPRINT_SPEC.md`：IR・マスク・Feature Timeline・再現性
- `DEVELOPMENT_RULES.md`：開発規約・禁止事項
- `DEVELOPMENT_WORKFLOW.md`：作業・検証・レビューの流れ
- `ENVIRONMENT_SETUP.md`：開発環境セットアップ
- `DEPLOYMENT.md`：CI/CD・デプロイ・復旧手順
- `TEST_STRATEGY.md`：テスト戦略・検証実績
- `SECURITY.md`：認証・認可・Secret・暗号鍵・入力検証
- `COST_MANAGEMENT.md`：無料枠・単価・予算・実測コスト
- `CURRENT_STATE.md`：実装状況・検証状況・既知の制約
- `DECISION_LOG.md`：重要な技術・仕様判断
- `OPEN_ISSUES.md`：未解決事項・リスク・対応案
- `docs/reports/`：作業単位の完了報告

`CURRENT_TASK.md`はリポジトリ直下に置き、現在のタスクだけを記載する。

過去の作業や長期仕様を重複して記載しない。

---

## 11. 環境セットアップマニュアル

`docs/ENVIRONMENT_SETUP.md`を作成する。

Windows 11 + WSL2 Ubuntuを基本対象とする。

次のツール・ライブラリについて、必要性、採用バージョン、インストール方法、確認方法、異常時の対応を記載する。

- Git
- GitHub CLI
- WSL2
- Docker / Docker Compose
- Node.js
- npm等の採用パッケージマネージャー
- React
- TypeScript
- Vite
- Go
- Echo
- Python
- Python仮想環境・依存管理ツール
- Demucs
- PyTorch CPU
- FFmpeg
- Google Cloud CLI
- Supabase CLI（必要な場合）
- Wrangler（必要な場合）
- Test / Lint / Formatter / Type Checker

### マニュアル記載例

各ツールに以下の構成を適用する。

```text
Tool Name

目的：
使用する機能：

採用バージョン：
選定根拠：

インストール：
<commands>

バージョン確認：
<commands>

動作確認：
<commands>

必要な環境変数：
<variables>

既知のエラー：
<description>

検証状況：
FACT / 未検証
```

コマンドは実際に対象環境で検証する。

未実行の手順は、公式資料に基づく推奨手順として記載し、検証済みと混同しない。

---

## 12. 開発・検証フロー

開発では以下を原則とする。

```text
Requirement
    ↓
Architecture / Contracts
    ↓
Implementation
    ↓
Unit Tests
    ↓
Integration Tests
    ↓
E2E Tests
    ↓
Security / Quality Checks
    ↓
Documentation Verification
    ↓
Human Review
    ↓
Completed
```

実装変更の際は、対象機能に関係する設計書・テスト・CURRENT_STATEを更新する。

ドキュメントを更新しただけで実装済みとしない。

CI/CDはGitHub Actionsを利用する。

テストとデプロイは分離し、本番用Secretを通常のCIに渡さない。

クラウドの自動デプロイ設定によってCIを迂回する経路ができないようにする。

依存パッケージ・アクション・コンテナイメージは、必要に応じてバージョンやダイジェストを固定する。

---

## 13. ChatGPT / Work / Codex / Codex CLIの役割

### ChatGPT

- 目的・要件・制約の整理
- アーキテクチャの判断
- 実装範囲・対象外の確定
- 高リスク操作の判断
- Codexへの作業指示
- 検証結果のレビュー
- 仕様変更時の影響評価

### ChatGPT Work

- GitHub・外部アプリを横断する作業
- リポジトリや資料の調査・整理
- 開発資料・成果物の作成
- 必要に応じた複数ステップの作業支援

### Codex / Codex CLI

- リポジトリ調査
- 既存コード・テスト確認
- 内部設計
- 実装
- テスト作成・実行
- Lint / Type Check
- CI設定
- ドキュメントとの整合性確認
- 作業報告

### 人間

- 重要な設計判断の承認
- 課金・クラウドリソース作成の承認
- 本番操作の承認
- 実行結果・映像品質の評価
- 最終的な受け入れ判断

AIによるコード生成やテスト成功だけを理由に、仕様との整合性が担保されたとみなさない。

---

## 14. Codexの作業リスク分類

### L1：低リスク

UI、文言、局所修正、pure function、テストなど。

Codexが調査・実装・検証まで一括実行してよい。

### L2：設計を伴う変更

複数レイヤー、新機能、内部API、データフロー変更など。

責務境界・入出力・互換性・完了条件を確定したうえで委任する。

### L3：高リスク

認証、DBスキーマ、データ更新、暗号鍵、クラウド課金、本番デプロイ、削除、移行など。

read-only調査を優先し、影響・復旧方法・費用・実行権限を確認する。

明示的に許可されていない外部更新や本番操作を実行しない。

---

## 15. Codexの資料確認順序

原則として次の順で確認する。

1. `docs/PROJECT_CONTEXT.md`
2. `docs/DEVELOPMENT_RULES.md`
3. `docs/CURRENT_STATE.md`
4. 関係する最新の完了報告
5. `CURRENT_TASK.md`
6. 関係する仕様書
7. 対象コード・テスト・類似実装

資料が存在しなければ、その事実を報告する。

コードや設定から判断可能なら、許可範囲内で作業を継続する。

実質的な仕様矛盾がある場合は、該当部分の変更を停止し、根拠と影響を報告する。

---

## 16. MVPの開発順序

### Step 1：リポジトリ・開発基盤

- GitHubリポジトリ作成
- フォルダ構成作成
- 設計書整備
- 環境セットアップマニュアル作成
- React / TypeScript開発基盤
- 基本テスト・Lint・CI

### Step 2：Renderer

- 固定Blueprint
- 固定Feature Timeline
- Canvas描画
- Kick / Bass連動
- 決定論的な描画処理
- 短い動画の試験出力

### Step 3：Visual Editor

- 背景設定
- エフェクト編集
- 矩形・多角形領域選択
- マスク合成
- プレビュー

### Step 4：Python Island

- Demucs CPU実行
- 4 Stem分離
- 特徴量抽出
- Feature Timeline生成
- 実行時間・メモリ測定
- Cloud Run Jobsでの検証

### Step 5：Go / Echo + Gemini

- API定義
- Blueprint生成
- スキーマ検証
- ジョブ管理
- エラー処理
- 利用制限

### Step 6：出力・復元

- 音声付き動画
- 無音動画
- `.arvb`暗号化
- `.arvb`再読込
- 再現性検証

### Step 7：認証・保存

- Supabase Auth
- JWT検証
- 所有者単位の認可
- プロジェクトCRUD
- データ保持・削除ルール

### Step 8：本番公開

- Cloudflare Pages
- Cloud Run Services
- Cloud Run Jobs
- Supabase
- R2
- Gemini
- GitHub Actions
- 固定サンプルデモ

### Step 9：Portfolio掲載

- Astroで自己紹介・制作物紹介
- Productへのリンク
- GitHubへのリンク
- アーキテクチャと技術判断の紹介

上記は作業順序の基本案であり、依存関係や検証結果による調整は可能。

---

## 17. 初回ローンチの完了条件

初回ローンチは、次を満たしたときに完了とする。

1. 実音源をアップロードできる。
2. Demucsで音源分離できる。
3. 音響特徴量を生成できる。
4. GeminiでBlueprintを生成できる。
5. Blueprintをスキーマで検証できる。
6. 音楽と同期して映像をプレビューできる。
7. エフェクトを編集できる。
8. 画像内の指定領域だけにエフェクトを適用できる。
9. 音声付き・無音動画を出力できる。
10. `.arvb`を書き出し、再インポートできる。
11. 認証済みユーザーがプロジェクトを保存できる。
12. 他ユーザーのデータへ不正アクセスできない。
13. 固定サンプルデモを認証なしで利用できる。
14. 公開URLから正常にアクセスできる。
15. 必須テストが成功している。
16. コードとドキュメントの整合性が確認されている。
17. 実行費用が予算に収まるよう、適切な制限と監視が設定されている。

---

## 18. 将来の拡張機能

今回のMVPから除外する。

### Phase 2：制作品質の改善

- MP4/H.264/AACの高い互換性
- 1080p以外の高度な出力設定
- 高度な映像エンコード
- ブラシマスク
- Feather
- 歌詞同期
- 複数素材のタイムライン編集
- 演出テンプレート
- Blueprintを別楽曲へ再バインド
- 複数アスペクト比への自動レイアウト

### Phase 3：AI素材生成・商用化

- AIによる画像加工
- 人物・背景の自動切り抜き
- AI画像生成
- AIエフェクト素材生成
- AI動画生成
- テンプレート共有
- 課金・サブスクリプション
- 共同編集
- TuneCore Japanとの連携

これらは将来の検討案であり、実装を約束したものではない。

---

## 19. 将来の事業仮説

### 19.1 主な顧客

- ボーカロイド楽曲制作者
- インディーズアーティスト
- バンド
- 同人音楽制作者
- 電子音楽制作者
- SNSで新譜告知を行うアーティスト

### 19.2 提供価値

1枚絵と音源から、音楽に同期する簡易MVを短時間・低コストで制作できること。

ユーザーのアートワークや音楽の世界観を維持しつつ、楽器ごとのビジュアル効果を制御できること。

### 19.3 競合

検討済みの競合：

- Neural Frames
- Kaiber
- Rotor Videos
- Videobolt

Neural Framesにはすでに楽器別の音響連動制御があるため、楽器別制御自体を独自の競争優位とは断定できない。

差別化候補：

- 1枚絵MVへの特化
- 明示的で予測可能なエフェクト制御
- 低コストな再編集
- 決定論的なBlueprint描画
- 演出再利用
- 短尺・長尺の複数出力

いずれも実証済みの優位性ではなく、検証対象。

### 19.4 TuneCore Japan / Wano向け構想

将来、TuneCore Japanに登録された音源やジャケット画像を利用し、アーティストがプロモーション用簡易MVを作成できる機能としての展開を検討する。

WanoグループのVideo Kicksなど、既存の動画配信事業への連携可能性もある。

ただし、TuneCoreへの実際の連携仕様、コンテンツ審査、権利処理、商品化条件は未確認。

今回の個人開発では外部連携を実装しない。

---

## 20. 未解決事項・リスク

| 論点 | 現在の状態 |
|---|---|
| Demucs CPU処理時間 | 未実測 |
| CPU実行時の最大メモリ | 未実測 |
| 4 Stem分離精度 | 未検証 |
| Kick検出精度 | 未検証 |
| Cloud Run Jobsでの実行費用 | 未実測 |
| Geminiモデル・無料枠 | 実装時に再確認 |
| Blueprint正式スキーマ | 未確定 |
| Regionマスクの実装方式 | 未実装 |
| 動画と音源の厳密な同期 | 未検証 |
| ブラウザ動画エンコード互換性 | 未検証 |
| `.arvb`暗号鍵のローテーション | 未設計 |
| プロジェクトの保存容量・保持期限 | 未確定 |
| Supabase Freeの停止・再開運用 | 要検証 |
| Cloud Run / R2のアクセス権限 | 未構築 |
| CI/CDのデプロイ経路 | 未構築 |
| GitHubリポジトリ公開範囲 | 未確定 |
| GitHubリポジトリURL | 未作成・未確認 |

未確認事項は、実装やテストで確認できるまでFACTに変更しない。

---

## 21. 現在までの進捗

### 完了済み

- プロダクトの目的整理
- MVPと将来拡張の区分
- 技術構成の基本方針
- CPU優先の判断
- コスト目標の設定
- リポジトリ分離方針
- ドキュメント管理方針
- 開発・品質管理方針
- 初期実装順序の整理

これらは設計上の決定・検討であり、コードの完成を意味しない。

### 実装・検証状況

**現時点の会話から、GitHubリポジトリ作成、ソース実装、CI成功、クラウドデプロイが完了したという証拠は確認されていない。**

コードやファイルが別の環境ですでに作成されている場合は、実際のリポジトリを確認して状態を更新する。

---

## 22. 次の作業

最初のタスクは、リポジトリ作成・開発環境構築・ドキュメント整備・Renderer最小実装とする。

具体的には以下を行う。

1. GitHubの対象アカウント・既存リポジトリを確認する。
2. `audio-reactive-visual-compiler`リポジトリの作成可否を確認する。
3. ローカル作業ディレクトリを用意する。
4. `/docs`構成を整える。
5. `docs/ENVIRONMENT_SETUP.md`を作成する。
6. React / TypeScript / Viteを導入する。
7. 固定BlueprintとFeature Timelineで描画する最小Rendererを実装する。
8. 最小テストとCIを構築する。
9. ソースとドキュメントを照合する。
10. 変更内容と検証結果を報告する。

外部書き込みや課金操作は、必要な権限・承認の範囲内で実行する。

---

# 23. 新しいChatGPT / Workで開発を再開するためのプロンプト

以下を新しい会話に渡す。

---

あなたはAI Audio-Reactive Visual Compilerの開発を支援するシステムアーキテクト兼開発エージェントです。

私は個人開発で、ChatGPT、ChatGPT Work、Codex、Codex CLIを使用します。

添付した引き継ぎメモを正式な初期コンテキストとして扱い、これまでの決定事項・対象範囲・制約を維持してください。

## 重要な条件

- ローカル開発中心
- Windows 11 + WSL2 / Docker
- React / TypeScript / Vite
- Go / Echo
- Python / Demucs
- CPU推論第一候補
- GeminiによるBlueprint生成
- Canvasによる決定論的描画
- Supabase Auth / PostgreSQL
- Cloud Run Services / Jobs
- Cloudflare Pages / R2
- GitHub Actions
- 月額運用費1,000円以内、可能な限り0円
- Portfolio Siteは別リポジトリ
- 商用課金・AI画像生成・TuneCore連携は今回対象外

## 作業方針

実装前に対象・責務・完了条件を確認してください。

存在するコード・テスト・設定を調査してから変更してください。

Codexには許可範囲内の調査、内部設計、実装、テスト、検証、報告を一括委任してください。

`docs/`には設計書、アーキテクチャ、技術構成、環境セットアップ、CI/CD、セキュリティ、コスト、テスト、未解決事項を整理してください。

FACT、DECIDED、PROPOSED、HYPOTHESIS、BLOCKEDを区別してください。

FACTは必ず実装・設定・テスト・実行結果と照合してください。

未実装事項を実装済みと記載しないでください。

作業結果はcompleted / partial / blockedで報告してください。

## 最初に行うこと

GitHubリポジトリとローカル開発環境の現状を確認し、リポジトリ作成、ドキュメント整備、環境セットアップ、最小Renderer実装の作業計画を具体化してください。

必要なGitHub操作や有料クラウド操作は権限を確認して進めてください。

本番クラウドへのデプロイは、ローカルでの動作確認と費用・セキュリティの検証後に実施してください。

---

# 引き継ぎメモ終了
