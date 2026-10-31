# 開発規約

DECIDED：変更前にPROJECT_CONTEXT、本文書、CURRENT_STATE、最新の関連報告、ルートCURRENT_TASK、関連仕様、コード・テストを順に確認する。仕様矛盾は根拠と影響を示して該当変更を止める。

| 状態 | 意味 |
|---|---|
| FACT | コード・設定・実行結果で確認した事実。根拠を併記 |
| DECIDED | 決定事項。実装済みを意味しない |
| PROPOSED | 未確定の案 |
| HYPOTHESIS | 実測していない推定 |
| BLOCKED | 実行・検証が阻害されている事項 |

DECIDED：実装変更時は関連仕様、テスト、CURRENT_STATEを同期する。完了報告はcompleted / partial / blockedを使い、人の受け入れとAI検証成功を区別する。

DECIDED：AI生成の任意JS/Python/GLSLを実行しない。Secretを公開クライアントに埋め込まない。依存は公式安定版・脆弱性・互換性を確認して固定し、無条件なlatest更新やaudit fix --forceを使わない。

L1の局所変更は調査から検証まで実施可能。L2は責務・入出力・互換性・完了条件を定義する。L3の認証・DB・鍵・削除・移行・本番・課金は影響と復旧を確認し、未許可の本番操作を行わない。
