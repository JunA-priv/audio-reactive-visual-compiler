# Step 7g-1：初期画面ログイン・ゲスト導線

実施日：2026年11月1日  
状態：**completed**

## 実装

- `/`をタイトル・説明文と左右2カラムの導線へ変更。PC幅では横並び、700px以下では縦積み。
- 左側に`ユーザーID`（既存Authのemail/password処理を維持）、パスワード、`ログイン`、`新規ユーザー登録`リンクを追加。
- Login formを`/login`と共有。Enter送信を可能にし、ログイン成功後は`/app`へ遷移。
- 右側にゲスト説明と`ゲストで試す`ボタンを追加。クリックすると`/demo`へ遷移。
- `/register`の案内ページを追加。Supabase Authの新規登録処理は既存実装に存在しないため追加せず、登録処理がないことと既存アカウントでログインする導線を明示。
- AI entitlement、API認証、Cloud Project/Asset、demo機能範囲は変更していない。

## 検証

- Frontend: 9 test files / 50 tests passed.
- `npm run typecheck`, `npm run lint`, `npm run build` passed.
- UI tests cover two sections, accessible labeled inputs, registration link/route, guest navigation to `/demo`, and login success navigation to authenticated `/app`.
- `git diff --check` passed.
- Responsive behavior is implemented by CSS media query; an actual small-screen browser layout measurement was not performed.

## 変更ファイル

- `frontend/src/App.tsx` — shared login form, landing columns, `/register` route.
- `frontend/src/style.css` — desktop two-column layout and mobile stacking.
- `frontend/src/App.test.tsx` — UI, navigation and login regression tests.
- `CURRENT_TASK.md`, `docs/CURRENT_STATE.md` — current work and result.
