# Step 7k-58f-2 — 招待URL Fragment化・明示操作による認証

**実施日:** 2026-11-05 JST  
**status：completed**（ローカルFrontend実装・検証完了。Hosted invite / JWT / dashboard設定は未実施）

## 変更概要

- Invite callbackは`location.hash`だけから`token_hash`と`type=invite`を取得する。query-only旧リンク、query/fragment混在、未知parameterを拒否する。
- `useLayoutEffect`でcallbackを処理し、component上の招待UIが表示される前にquery/fragmentを`history.replaceState`で消す。トークンはcallback componentの一時stateにのみ保持し、永続storageやsessionStorageには保存しない。
- Tokenを受け取っただけではAuth APIを呼ばず、「招待を受け入れる」ボタンを表示する。ユーザー操作後、既存`acceptInvite()`を一度だけ呼び、成功時に既存の初回パスワード画面へ遷移する。
- 送信中は二重操作を抑止し、tokenを直ちにcomponent stateから除く。verify失敗時はsessionを成立させず、tokenを再送せず再招待を案内する。
- `auth-client.ts`のREST verify、既存セッションの分離・保存、session refresh、password setup、ログイン・logoutは変更なし。一般signup禁止、固定遷移、`Referrer-Policy: no-referrer`を維持。

## Fragment parsing / 安全性

受理形式：

```text
<origin>/auth/callback#token_hash=<token>&type=invite
```

Hosted Invite Email Template案：

```html
<a href="{{ .SiteURL }}/auth/callback#token_hash={{ .TokenHash }}&amp;type=invite">招待を受け入れる</a>
```

- hash fragmentを`&`単位で分解し、各key/valueを`decodeURIComponent`でstrict decodeする。malformed percent escape、空・重複token/type、不正type、4096文字超、空白つきtoken、未知parameterを拒否する。
- `location.search`が空でないcallbackは拒否し、query形式の旧招待tokenを利用しない。queryやhashを常に固定`/auth/callback`へscrubし、`redirect_to`を遷移先として扱わない。
- Supabase verifyへのtoken hashは既存どおりHTTPS POST JSON bodyに限り、Authorization Bearerには入れない。応答本文は失敗時に表示せず、ログ出力もしない。
- 既存sessionは確認画面表示中には変更しない。明示クリック後に既存`acceptInvite()`がverify開始前にclearするため、異なるユーザーsessionと招待sessionを混在させない。verifyエラー後は空のまま。
- URLをscrub後に再読み込みするとfragmentは復元されず、verificationも再実行しない。ユーザーに招待メールを再度開くよう表示する。
- callback内にAnalytics等の第三者scriptはなく、tokenを外部redirectへ渡す経路もない。
- Fragmentは標準HTTP request targetに含まれず、通常GET/HEADのhost/CDN request URIへ送られない。ただしメールクライアントがlinkを書換える可能性、ブラウザー表示、JavaScriptを動かすscannerがUI操作相当を行う可能性は残る。ユーザー明示クリックは自動prefetchを抑えるが、全scanner対策を保証しない。

## テスト・検証結果

- 関連`App.test.tsx` / `auth-client.test.ts`：2 files / 34 tests PASS。
- Frontend全体：15 files / 218 tests PASS。
- Typecheck PASS。
- Lint PASS。
- Production build PASS（Vite 8.3.5）。
- `git diff --check` PASS。

主な追加ケース：

- 有効fragmentの即時scrub、確認UI、クリック前のfetchなし、クリック後の正確なPOST body、session成立とpassword setup遷移。
- query-only旧リンク、query/fragment混在、duplicate/empty token、duplicate/不一致type、malformed encoding、4097文字token、未知のredirect parameterを拒否。
- StrictMode再実行と二重clickでもverify一度のみ。
- HTTP 400/401/500の失敗時にsessionなし・token非表示・再送buttonなし。
- token scrub後のreloadでは再verifyなし。
- 既存password update/refresh/logout等のAuth testsとFrontend全回帰を含む。

今回ローカルに実ブラウザーや実メールを使っていない。メールクライアントがfragmentを保持すること、Supabase Hosted Invite Templateとcallbackの結合、scanner製品のJavaScript・操作挙動、配信環境のlogsを未確認。

## Hosted設定・次工程契約

Hosted Supabase、Cloudflare Pages、GCPは変更なし。Invite Email Templateは今回更新していない。設定前に以下を確認する。

1. 正式Frontend originとHTTPS、`.SiteURL`が末尾slashなしのorigin-onlyであること。
2. `/auth/callback`がSPA entryへ直接fallbackすること。
3. 上記Fragment templateをDashboardのInvite user templateへ適用すること。実ProjectがFreeで、2026-06-03以降作成の新規Free projectに該当し、Supabase標準SMTPを利用中なら、Auth email template customizationが制限される。Hosted projectのSMTP設定は未確認なので、custom SMTPまたはSend Email Hookの状態をDashboardで確認してからtemplate変更可否を判断する。
4. Email providerのtracking/link rewritingを無効化。テスト用mailboxで受信したhrefのfragmentが保持され、リンクを開くだけではAuth verifyが起きず、ボタン操作後に一度だけ起きることを確認する。
5. Authentication URL ConfigurationのSite URL、必要なRedirect URL allowlistを正確な配信originから決める。実origin未確定のため現時点で値を作らない。
6. test mailbox一件のinvite、初回password設定、実JWTのGo API検証は、それぞれHosted変更・ユーザー作成/メール送信を含むため個別承認後に実行する。

現行templateが`.SiteURL`直指定のため、Hosted Admin Dashboardからのinvite linkはそのSite URLへ向かう。ローカルloopbackでHosted inviteを試す場合、allowlist追加のみではlink先が変わらず、Site URL一時変更かinvite redirect設計が必要になる。これは本工程では行わない。

## 変更ファイル

- `frontend/src/App.tsx`
- `frontend/src/App.test.tsx`
- `docs/reports/2026-11-05-step7k-58f-2-invite-fragment-confirmation.md`
- `CURRENT_TASK.md`
- `docs/CURRENT_STATE.md`

Step 58eで既に作業ツリーにあった`frontend/index.html`、`frontend/src/auth-client.ts`、`frontend/src/auth-client.test.ts`の変更は保全し、本工程では編集していない。

## 残存リスク

- Fragmentは最初のHTTP requestに載らないが、メールproviderやclient-side scannerがURL全体を処理する可能性がある。第三者のJavaScript-enabled scannerが人間の操作に類似したclickをする場合、verifyを起動できる可能性が残る。
- URL scrub前の短時間はfragmentがbrowser location/historyに存在する。JavaScriptを無効化した環境ではcallbackはtokenを処理できず、再招待が必要となる。
- `requiresPasswordSetup`は既存どおりsessionStorageのUI gateでありserver enforcedではない。
- Hosted template customization可否、メールリンク書換え、Site/Redirect URL、SMTP配信、実ブラウザー動作は未確認。

## 公式仕様

- Supabase [Email Templates / `.TokenHash` / email link prefetching](https://supabase.com/docs/guides/auth/auth-email-templates)
- Supabase [Email Templates Free tier customization change (2026-06-03)](https://supabase.com/changelog/46599-changes-to-email-template-customisation-on-free-tier)
- Supabase [Auth invite users](https://supabase.com/docs/guides/auth/users)
- Supabase [Auth verifyOtp](https://supabase.com/docs/reference/javascript/auth-verifyotp)
- Supabase [Auth updateUser](https://supabase.com/docs/reference/javascript/auth-updateuser)
- Supabase [Auth redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
- Supabase [Implicit flow / browser fragment behavior](https://supabase.com/docs/guides/auth/sessions/implicit-flow)

Supabaseの現行email template docsは、セキュリティ製品がリンクをprefetchしてone-time verification URLを消費するケースを説明している。今回の明示操作は自動verifyを避ける構成だが、Hosted templateやメール製品を使った実証は行っていない。
