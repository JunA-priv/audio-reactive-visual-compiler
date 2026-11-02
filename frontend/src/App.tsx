import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { signIn, subscribeAuth, validSession } from './auth-client';
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
  if (path === '/app') return <ProtectedEditor />;
  if (path === '/local' && import.meta.env.DEV) return <VisualEditor variant="local" />;
  return <Landing onAuthenticated={() => navigate('/app')} onNavigate={navigate} />;
}
