# Step 7k-38 — React Visual EditorへのSCNet統合

**状態: 完了。** 既存の認証付きAudio AnalyzeとEditor統合により、要求されたブラウザーフローを実現しました。Step 7k-37d APIの`127.0.0.1:18084`を対象とする小規模なVite開発proxy上書きを追加し、loopbackのみを許可する検証を設けました。Frontendテストと静的チェックは成功し、ユーザーが通常のローカルブラウザーで一連のフローを確認しました。CodexのサンドボックスからWSL2 APIへの接続とViteサーバーのbindはできませんでしたが、この環境制限はユーザーによるローカルブラウザー受け入れを妨げませんでした。

## 既存実装とデータフロー

既存の`/app`ルートにはローカルSupabaseセッションが必要です。`validSession()`は可能な場合に期限切れセッションを更新し、`currentSession()`は解析前に現在のaccess tokenを取得します。認証済みEditorにはファイル選択、ブラウザー内デコード/波形表示、範囲選択ダイアログが既にあります。ソースは32 MiBまでに制限し、選択範囲だけをブラウザー内で切り出して44.1 kHzステレオPCM16 WAVにリサンプリングし、解析の60秒/16 MiB制限を適用します。元の全音源をAPIへ送信しません。

確定時に`analyzeAudioClip()`は選択WAVをmultipartの`audio`として、`Authorization: Bearer <access token>`付きで同一originの`/api/v1/audio/analyze`へ送信します。選択中のKick Gate Modeも含め、返却されたTimeline v1、長さ、メタデータを検証します。401では既存のセッション期限切れイベントをdispatchし、413、422、429、499、504およびその他のAPI失敗にもUIで対応します。UIは解析の重複を防ぎ、busy/statusを表示し、AbortControllerによるキャンセルを提供します。

成功時、既存Editorは切り出したWAV、返却Timeline、Music Summaryを確定し、Blueprintを新規Editorの既定値に戻してBlueprint生成を有効化します。Blueprintリクエストには解析Summary/Timelineを渡します。切り出しWAVは既存Preview音声要素に設定され、再生時刻、シーク、Renderer時刻が同期します。既存Effectは既存Renderer経由で確定済みTimelineを読み取ります。Demucsやモデルの選択UIはありません。

## 変更内容

- `frontend/vite.config.ts`: 任意の`ARVC_API_PROXY_TARGET`で開発用`/api` proxyを設定できます。既定値は引き続き`http://127.0.0.1:8080`です。ローカルloopbackのHTTP originのみ許可し、path、認証情報、query string、fragment、loopback以外のhostは拒否します。この設定はViteサーバーが使用し、クライアント側変数として公開されません。
- `frontend/src/audio-analysis.test.ts`: 60秒レスポンスfixtureを`scnet_standard`にし、HTTP 401のセッション期限切れイベントとAbortSignal伝播の確認を追加。
- `frontend/src/visual-editor.test.tsx`: 認証済みの切り出しからEditor/BlueprintへのフローでSCNet Summaryを使い、既存のBlueprintリクエストまでモデル識別子が保持されることを検証。

API、Supabase、JWT、Timeline/Blueprint契約、SCNet推論、checkpoint、依存関係、本番動作は変更していません。モデル選択UIも追加していません。

SCNet standardは開発および通常のアプリ利用で引き続き使うエンジンです。Demucsは学習/疑似ラベルデータ生成と性能比較に限定し、ユーザーが実行時に選べるエンジンとしては提供しません。

## ブラウザー受け入れ確認 — ユーザー確認済み

- Supabase Authでのログインに成功。
- SCNetによる音声解析に成功。
- 返却TimelineがVisual Editorに表示。
- 音声再生が同期した状態でEffectが解析結果に反応。
- ブラウザー側からの解析キャンセルに成功。

これらはユーザーが確認したローカルブラウザーでの結果であり、Cloud Runや本番デプロイをテストしたことを意味しません。

## ローカルWSL2での実行

既に稼働中のStep 7k-37d APIとローカルSupabase設定を使います。tokenをshellコマンドに貼り付けたり、auth issuerを変更したりしないでください。`frontend/.env.local`には既存のローカル`VITE_SUPABASE_URL`と公開anon keyが必要です。このタスクでは値を読み取っていません。

```bash
curl --fail http://127.0.0.1:18084/healthz
cd /home/raric/work/myapp/audio-reactive-visual-compiler/frontend
ARVC_API_PROXY_TARGET=http://127.0.0.1:18084 npm run dev -- --host 127.0.0.1
```

ローカルWindows/WSLブラウザーで`http://localhost:5173`を開き、既存のローカルSupabaseログインでサインインし、`/app`を開きます。音声ファイルを選択し、60秒以内の範囲を設定して解析を確定します。通常のUIでは解析中状態の後、選択したクリップと完了状態が表示されます。Editor Previewを再生/シークし、生成TimelineにEffectが反応することを確認します。モーダルの「解析を中断」操作で、再試行可能な状態に戻ることを確認します。期限切れセッションの動作確認ではサインアウトするか既存のローカルセッション期限切れ経路を使い、JWT検証を迂回しないでください。Vite proxy上書きが受け付けるのはloopback HTTP originのみです。

## 検証

- `npm test`: **13ファイル、179件成功**。
- `npm run typecheck`: 成功。
- `npm run lint`: 成功。
- `npm run build`: 成功。
- `ARVC_API_PROXY_TARGET=http://127.0.0.1:18084`指定時のVite設定解決: 要求されたローカルoriginに解決。
- 外部HTTPS host指定時のVite設定解決: loopback限定検証エラーで拒否。
- `git diff --check`: 成功。

## Codex実行環境の制約

- Codex実行環境からの`curl http://127.0.0.1:18084/healthz`はconnection refusedとなりました。これはこの環境についてのみ述べるもので、ユーザーのStep 7k-37d WSL2報告を否定するものではありません。
- サンドボックス内でViteをloopback起動しようとすると`listen EPERM`で失敗しました。この環境にはブラウザー実行ファイルや操作ツールもありません。
- Codex自身はブラウザーログイン、認証付き音声アップロード、SCNet描画、Effectプレビュー、ブラウザーキャンセルを独立して実行していません。実際のJWTや音声ファイルを読み取ったり送信したりしていません。

ユーザー確認済みのブラウザー受け入れによりStep 7k-38は完了です。Vite proxy上書きと今回の検証はローカル開発に限られ、Cloud Run上の動作は未検証です。
