export type AuthSession = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email: string;
  requiresPasswordSetup?: boolean;
};

const SESSION_KEY = 'arvc.local.auth.session.v1';
const HOSTED_SUPABASE_HOST = /^[a-z0-9]{20}\.supabase\.co$/;

function settings() {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim().replace(/\/$/, '');
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!url || !key) throw new Error('SupabaseのFrontend設定がありません。frontend/.env.localを確認してください。');
  const parsed = new URL(url);
  const local = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) && (parsed.port === '' || parsed.port === '54321');
  const hosted = parsed.protocol === 'https:' && HOSTED_SUPABASE_HOST.test(parsed.hostname) && !parsed.port;
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || (!local && !hosted)) {
    throw new Error('Supabase URLはlocal loopbackまたはcanonical Hosted HTTPS project URLを指定してください。');
  }
  return { url, key };
}

function persist(session: AuthSession | null) {
  if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else sessionStorage.removeItem(SESSION_KEY);
  window.dispatchEvent(new Event('arvc-auth-change'));
}

function fromAuthResponse(value: unknown): AuthSession {
  if (!value || typeof value !== 'object') throw new Error('認証応答を確認できません。');
  const row = value as Record<string, unknown>;
  const user = row.user as Record<string, unknown> | undefined;
  if (typeof row.access_token !== 'string' || row.access_token.length === 0 || typeof row.refresh_token !== 'string' || row.refresh_token.length === 0 || typeof row.expires_in !== 'number' || !Number.isFinite(row.expires_in) || row.expires_in <= 0) {
    throw new Error('認証応答の形式が不正です。');
  }
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: Date.now() + row.expires_in * 1000,
    email: typeof user?.email === 'string' ? user.email : '',
    requiresPasswordSetup: false,
  };
}

function authFailureMessage(status: number, action: 'invite' | 'password'): string {
  if (action === 'invite') {
    return status === 400 || status === 401
      ? '招待リンクが無効または期限切れです。管理者に再招待を依頼してください。'
      : '招待を確認できませんでした。時間をおいて再度お試しください。';
  }
  return status === 401
    ? '認証セッションの有効期限が切れました。管理者に再招待を依頼してください。'
    : status === 400
      ? 'パスワードを設定できませんでした。入力内容と認証側のポリシーを確認してください。'
      : 'パスワードを更新できませんでした。時間をおいて再度お試しください。';
}

export async function acceptInvite(tokenHash: string, type: string): Promise<AuthSession> {
  // Never carry a different user's session into the invite verification request.
  persist(null);
  if (type !== 'invite' || typeof tokenHash !== 'string' || tokenHash.trim().length === 0 || tokenHash.length > 4096) {
    throw new Error('招待リンクの形式が不正です。管理者に再招待を依頼してください。');
  }
  const { url, key } = settings();
  let response: Response;
  try {
    response = await fetch(`${url}/auth/v1/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key },
      body: JSON.stringify({ token_hash: tokenHash, type: 'invite' }),
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new Error('招待を確認できませんでした。リンクは一度だけ使用できるため、状態を確認してから再招待を依頼してください。');
  }
  if (!response.ok) throw new Error(authFailureMessage(response.status, 'invite'));
  let session: AuthSession;
  try {
    session = fromAuthResponse(await response.json());
  } catch {
    throw new Error('招待応答を確認できませんでした。管理者に再招待を依頼してください。');
  }
  session.requiresPasswordSetup = true;
  persist(session);
  return session;
}

export async function updateInitialPassword(password: string): Promise<AuthSession> {
  let session = readSession();
  if (!session || !session.requiresPasswordSetup || !password) {
    throw new Error('招待セッションを確認できません。招待リンクからやり直してください。');
  }
  if (session.expiresAt <= Date.now() + 30_000) {
    let refreshed: AuthSession | null;
    try {
      refreshed = await authRequest('token?grant_type=refresh_token', { refresh_token: session.refreshToken });
    } catch {
      persist(null);
      throw new Error('認証セッションの有効期限が切れました。管理者に再招待を依頼してください。');
    }
    if (!refreshed) {
      persist(null);
      throw new Error('認証セッションの有効期限が切れました。管理者に再招待を依頼してください。');
    }
    session = { ...refreshed, requiresPasswordSetup: true };
    persist(session);
  }
  const { url, key } = settings();
  let response: Response;
  try {
    response = await fetch(`${url}/auth/v1/user`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ password }),
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new Error('パスワードを更新できませんでした。入力内容を再確認して再度お試しください。');
  }
  if (!response.ok) {
    if (response.status === 401) persist(null);
    throw new Error(authFailureMessage(response.status, 'password'));
  }
  const completed = { ...session, requiresPasswordSetup: false };
  persist(completed);
  return completed;
}

async function authRequest(path: string, body: Record<string, string>): Promise<AuthSession | null> {
  const { url, key } = settings();
  const response = await fetch(`${url}/auth/v1/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(response.status === 400 || response.status === 401 ? 'メールアドレスまたはパスワードを確認してください。' : 'Supabase Authに接続できません。');
  if (path === 'logout') return null;
  return fromAuthResponse(await response.json());
}

export async function signIn(email: string, password: string): Promise<AuthSession> {
  const session = await authRequest('token?grant_type=password', { email, password });
  if (!session) throw new Error('ログインできませんでした。');
  persist(session);
  return session;
}

export function readSession(): AuthSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthSession;
    if (typeof parsed.accessToken !== 'string' || typeof parsed.refreshToken !== 'string' || typeof parsed.expiresAt !== 'number' || typeof parsed.email !== 'string') {
      persist(null); return null;
    }
    return parsed;
  } catch { return null; }
}

export async function validSession(): Promise<AuthSession | null> {
  const session = readSession();
  if (!session) return null;
  if (session.expiresAt > Date.now() + 30_000) return session;
  try {
    const refreshed = await authRequest('token?grant_type=refresh_token', { refresh_token: session.refreshToken });
    const next = refreshed ? { ...refreshed, requiresPasswordSetup: session.requiresPasswordSetup === true } : null;
    persist(next);
    return next;
  } catch { persist(null); return null; }
}

export async function signOut(): Promise<void> {
  const session = readSession();
  if (session && session.expiresAt > Date.now()) {
    try {
      const { url, key } = settings();
      await fetch(`${url}/auth/v1/logout`, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${session.accessToken}` } });
    } catch { /* Local logout still clears the browser session. */ }
  }
  persist(null);
}

export function subscribeAuth(listener: () => void): () => void {
  window.addEventListener('arvc-auth-change', listener);
  window.addEventListener('storage', listener);
  const expired = () => { void signOut(); };
  window.addEventListener('arvc-auth-expired', expired);
  return () => { window.removeEventListener('arvc-auth-change', listener); window.removeEventListener('storage', listener); window.removeEventListener('arvc-auth-expired', expired); };
}
