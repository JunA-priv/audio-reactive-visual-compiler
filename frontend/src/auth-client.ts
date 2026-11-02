export type AuthSession = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email: string;
};

const SESSION_KEY = 'arvc.local.auth.session.v1';

function settings() {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim().replace(/\/$/, '');
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!url || !key) throw new Error('ローカルSupabaseのFrontend設定がありません。frontend/.env.localを確認してください。');
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('Frontendはloopback上のローカルSupabaseだけに接続できます。');
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
  if (typeof row.access_token !== 'string' || typeof row.refresh_token !== 'string' || typeof row.expires_in !== 'number') {
    throw new Error('認証応答の形式が不正です。');
  }
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: Date.now() + row.expires_in * 1000,
    email: typeof user?.email === 'string' ? user.email : '',
  };
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
    persist(refreshed);
    return refreshed;
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
