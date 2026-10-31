# CodexからWSL内のリポジトリへ接続

確認日：2026年10月31日。公式資料に基づく推奨手順。ユーザー環境での切替は未検証。

## 方法A：デスクトップアプリのエージェントをWSLへ切り替える

1. アプリのSettingsを開き、Agent environmentをWindows nativeからWSLへ変更する。
2. アプリを終了して再起動する。ターミナル設定だけをWSLに変えても、エージェント環境の変更にはならない。
3. Add new projectまたはCtrl+Oでフォルダー選択を開く。
4. パス欄に `\\wsl$\` を入力し、使用中ディストリビューション→home→raric→work→myapp→audio-reactive-visual-compilerを選択する。
5. そのプロジェクトで作業を再開し、下記確認を依頼する。設定名や配置はアプリ版で異なる可能性がある。

[公式：WindowsアプリのWSL設定](https://learn.chatgpt.com/docs/app/windows)

## 方法B：WSL内でCodex CLIを起動する

既存のWSLターミナルを開き、次を実行する。

~~~bash
cd /home/raric/work/myapp/audio-reactive-visual-compiler
command -v codex
codex --version
~~~

見つからなければ公式CLI導入ページを開き、掲載のLinuxインストーラーを確認して導入する。プロジェクト依存とは別の開発ツールとして、取得元と導入版を記録する。インストーラーの取得例：

~~~bash
mkdir -p /tmp/arvc-setup
curl --fail --location https://chatgpt.com/codex/install.sh --output /tmp/arvc-setup/codex-install.sh
less /tmp/arvc-setup/codex-install.sh
sh /tmp/arvc-setup/codex-install.sh
~~~

新しいターミナルでPATHと版を確認し、対象フォルダーでcodexを起動する。初回は画面の案内に従って認証する。

~~~bash
cd /home/raric/work/myapp/audio-reactive-visual-compiler
codex
~~~

WindowsアプリとWSL CLIの履歴・認証・設定は自動共有されるとは限らない。本プロジェクトでは認証ファイルの手動コピーを必須にしない。

[公式：WSL](https://learn.chatgpt.com/docs/windows/wsl)、[公式：CLI](https://learn.chatgpt.com/docs/codex/cli)

## 接続後の確認

Codexに以下を実行させ、Linux上の対象リポジトリであることを確認する。

~~~bash
pwd
uname -s
printf '%s\n' "$WSL_DISTRO_NAME"
git rev-parse --show-toplevel
git status --short
node --version
npm --version
~~~

期待値：pwdとGitルートが /home/raric/work/myapp/audio-reactive-visual-compiler、unameはLinux。書き込み権限とネットワークは別途設定に従う。安全機構の無効化や管理者起動を前提にしない。

## 接続できないとき

Windowsの通常PowerShellでwsl --list --verboseを確認する。通常ターミナルでも失敗する場合はWSL自体を調査する。通常ターミナルでは成功しエージェントだけ拒否される場合は、エージェントの実行環境・権限を確認する。

このチャットでのWsl/E_ACCESSDENIEDは観測結果であり、WSL故障を断定するものではない。CLIを別途起動しても、この既存チャットの実行環境が自動で切り替わるわけではない。
