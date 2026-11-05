import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { acceptInvite, readSession, signIn, subscribeAuth, updateInitialPassword, validSession } from './auth-client';
import type { AuthSession } from './auth-client';
import { VisualEditor } from './VisualEditor';

function LoginForm({ onAuthenticated }: { onAuthenticated: (session: AuthSession) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try { onAuthenticated(await signIn(email.trim(), password)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'ログインできませんでした。'); }
    finally { setBusy(false); setPassword(''); }
  }

  return <>
    <form className="landing-login-form" onSubmit={(event) => void submit(event)}>
      <label className="field" htmlFor="login-user-id">ユーザーID<input id="login-user-id" aria-label="ユーザーID" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label className="field" htmlFor="login-password">パスワード<input id="login-password" aria-label="パスワード" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button className="primary-button" disabled={busy || !email || !password}>{busy ? 'ログイン中…' : 'ログイン'}</button>
    </form>
    <a className="registration-link" href="/register">新規ユーザー登録</a>
    {error && <p role="alert">{error}</p>}
  </>;
}

function Landing({ onAuthenticated, onNavigate }: { onAuthenticated: (session: AuthSession) => void; onNavigate: (path: string) => void }) {
  return <main className="landing-shell">
    <header className="landing-header">
      <p className="eyebrow">音に反応する映像コンパイラー</p>
      <h1>音響から、映像の設計へ。</h1>
      <p>固定サンプルのデモを試すか、ログインしてエディターとクラウド保存を利用できます。</p>
    </header>
    <div className="landing-columns">
      <section className="landing-card" aria-labelledby="landing-login-heading">
        <h2 id="landing-login-heading">ログイン</h2>
        <LoginForm onAuthenticated={onAuthenticated} />
      </section>
      <section className="landing-card guest-card" aria-labelledby="landing-guest-heading">
        <h2 id="landing-guest-heading">ゲストユーザーとして使用</h2>
        <p>ログインせずに、固定サンプル音源を使ったデモ機能を試せます。保存機能やAI生成機能は利用できません。</p>
        <button className="primary-button" type="button" onClick={() => onNavigate('/demo')}>ゲストで試す</button>
      </section>
    </div>
  </main>;
}

function LoginPage({ onAuthenticated, required = false }: { onAuthenticated: (session: AuthSession) => void; required?: boolean }) {
  return <main className="login-shell"><a href="/">トップへ戻る</a><h1>ログイン</h1>{required && <p>エディターのすべての機能を使うにはログインしてください。</p>}<LoginForm onAuthenticated={onAuthenticated} /></main>;
}

function RegistrationPage() {
  return <main className="login-shell"><a href="/">トップへ戻る</a><h1>新規ユーザー登録</h1><p>このアプリでは新規アカウントの登録手続きを受け付けていません。すでにアカウントをお持ちの場合はログインしてください。新規登録については管理者にお問い合わせください。</p><a className="primary-button registration-return" href="/login">ログインへ</a></main>;
}

function InviteCallbackPage({ onAccepted }: { onAccepted: () => void }) {
  const started = useRef(false);
  const submitting = useRef(false);
  const [tokenHash, setTokenHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useLayoutEffect(() => {
    if (started.current) return;
    started.current = true;

    const rawFragment = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    const pairs: Array<[string, string]> = [];
    let malformed = window.location.search.length > 0 || rawFragment.length === 0;
    if (!malformed) {
      try {
        for (const part of rawFragment.split('&')) {
          const separator = part.indexOf('=');
          if (separator <= 0) { malformed = true; break; }
          pairs.push([
            decodeURIComponent(part.slice(0, separator).replace(/\+/g, ' ')),
            decodeURIComponent(part.slice(separator + 1).replace(/\+/g, ' ')),
          ]);
        }
      } catch {
        malformed = true;
      }
    }

    // Clear query and fragment before showing UI or making a network request.
    history.replaceState(null, '', '/auth/callback');

    const hashes = pairs.filter(([key]) => key === 'token_hash').map(([, value]) => value);
    const types = pairs.filter(([key]) => key === 'type').map(([, value]) => value);
    const unknownKeys = pairs.some(([key]) => key !== 'token_hash' && key !== 'type');
    const candidate = hashes.length === 1 ? hashes[0] ?? '' : '';
    if (malformed || unknownKeys || hashes.length !== 1 || types.length !== 1 || types[0] !== 'invite' || !candidate || candidate.trim() !== candidate || candidate.length > 4096) {
      setError('招待リンクを確認できません。招待メールのリンクをもう一度開いてください。');
      return;
    }
    setTokenHash(candidate);
  }, []);

  async function confirmInvite() {
    if (submitting.current || !tokenHash) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    const oneTimeToken = tokenHash;
    setTokenHash(null);
    try {
      await acceptInvite(oneTimeToken, 'invite');
      onAccepted();
    } catch {
      setError('招待リンクを確認できませんでした。期限切れ、使用済み、または無効な可能性があります。管理者に再招待を依頼してください。');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  if (error) return <main className="login-shell"><h1>招待を確認できません</h1><p role="alert">{error}</p><a className="primary-button registration-return" href="/login">ログインへ</a></main>;
  if (busy) return <main className="route-status" role="status">招待を確認しています…</main>;
  if (!tokenHash) return <main className="route-status" role="status">招待リンクを確認しています…</main>;
  return <main className="login-shell">
    <h1>招待の確認</h1>
    <p>招待を受け入れる場合は、次のボタンを押してください。</p>
    <button className="primary-button" type="button" disabled={busy} onClick={() => void confirmInvite()}>招待を受け入れる</button>
  </main>;
}

function InitialPasswordPage({ onComplete }: { onComplete: () => void }) {
  const [session, setSession] = useState<AuthSession | null | undefined>(undefined);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);

  useEffect(() => {
    let active = true;
    const sync = async () => {
      const next = await validSession();
      if (active) setSession(next);
    };
    void sync();
    const unsubscribe = subscribeAuth(() => { void sync(); });
    return () => { active = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (session && !session.requiresPasswordSetup) onComplete();
  }, [session, onComplete]);

  if (session === undefined) return <main className="route-status" role="status">招待セッションを確認しています…</main>;
  if (!session) return <main className="login-shell"><h1>セッションを確認できません</h1><p role="alert">招待セッションが無効または期限切れです。管理者に再招待を依頼してください。</p><a className="primary-button registration-return" href="/login">ログインへ</a></main>;
  if (!session.requiresPasswordSetup) return <main className="route-status" role="status">ログイン画面へ移動しています…</main>;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    if (password !== confirmation) { setError('入力したパスワードが一致しません。'); return; }
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await updateInitialPassword(password);
      setPassword('');
      setConfirmation('');
      onComplete();
    } catch (cause) {
      setPassword('');
      setConfirmation('');
      setError(cause instanceof Error ? cause.message : 'パスワードを設定できませんでした。');
      if (!readSession()) setSession(null);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return <main className="login-shell">
    <a href="/">トップへ戻る</a>
    <h1>初回パスワード設定</h1>
    <p>招待を受け入れるため、新しいパスワードを設定してください。</p>
    <form className="landing-login-form" onSubmit={(event) => void submit(event)}>
      <label className="field" htmlFor="invite-password">新しいパスワード<input id="invite-password" type="password" autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <label className="field" htmlFor="invite-password-confirm">パスワード（確認）<input id="invite-password-confirm" type="password" autoComplete="new-password" required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
      <button className="primary-button" disabled={busy || !password || !confirmation}>{busy ? '設定中…' : 'パスワードを設定'}</button>
    </form>
    {error && <p role="alert">{error}</p>}
  </main>;
}

function ProtectedEditor() {
  const [session, setSession] = useState<AuthSession | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    const sync = async () => { const next = await validSession(); if (active) setSession(next); };
    void sync();
    const unsubscribe = subscribeAuth(() => { void sync(); });
    return () => { active = false; unsubscribe(); };
  }, []);

  if (session === undefined) return <main className="route-status" role="status">セッションを確認しています…</main>;
  if (!session) return <LoginPage required onAuthenticated={(next) => { setSession(next); history.replaceState(null, '', '/app'); }} />;
  if (session.requiresPasswordSetup) return <InitialPasswordPage onComplete={() => { setSession({ ...session, requiresPasswordSetup: false }); history.replaceState(null, '', '/app'); }} />;
  return <VisualEditor variant="app" />;
}

export function App() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const pop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  const navigate = (to: string) => { history.pushState(null, '', to); setPath(to); };

  if (path === '/demo') return <VisualEditor variant="demo" />;
  if (path === '/login') return <LoginPage onAuthenticated={() => navigate('/app')} />;
  if (path === '/register') return <RegistrationPage />;
  if (path === '/auth/callback') return <InviteCallbackPage onAccepted={() => navigate('/auth/set-password')} />;
  if (path === '/auth/set-password') return <InitialPasswordPage onComplete={() => navigate('/app')} />;
  if (path === '/app') return <ProtectedEditor />;
  if (path === '/local' && import.meta.env.DEV) return <VisualEditor variant="local" />;
  return <Landing onAuthenticated={() => navigate('/app')} onNavigate={navigate} />;
}
