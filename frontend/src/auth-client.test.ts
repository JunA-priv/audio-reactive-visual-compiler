import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptInvite, readSession, signIn, signOut, updateInitialPassword, validSession } from './auth-client';

afterEach(() => { sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('local Supabase auth client', () => {
  it('signs in and persists a session without exposing its bearer token in status text', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'local-public-test-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600, user: { email: 'user@example.test' } }), { status: 200 })));
    const session = await signIn('user@example.test', 'password');
    expect(session.accessToken).toBe('access-secret');
    expect(readSession()?.email).toBe('user@example.test');
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('http://127.0.0.1:54321/auth/v1/token?grant_type=password', expect.objectContaining({ method: 'POST' }));
  });

  it('refreshes an expired session and clears it on logout', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'local-public-test-key');
    sessionStorage.setItem('arvc.local.auth.session.v1', JSON.stringify({ accessToken: 'old', refreshToken: 'refresh', expiresAt: Date.now() - 1, email: 'user@example.test' }));
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL) => {
      if (String(_input).includes('grant_type=refresh_token')) return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'next', expires_in: 3600, user: { email: 'user@example.test' } }), { status: 200 });
      return new Response(null, { status: 204 });
    }));
    expect((await validSession())?.accessToken).toBe('new');
    await signOut();
    expect(readSession()).toBeNull();
  });

  it('rejects arbitrary hosted Supabase settings before sending credentials', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://supabase.example');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'public-key');
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    await expect(signIn('user@example.test', 'password')).rejects.toThrow(/canonical Hosted/);
    expect(request).not.toHaveBeenCalled();
  });

  it('uses canonical Hosted Supabase HTTPS auth endpoints', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'publishable-test-key');
    const request = vi.fn(async () => new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }), { status: 200 }));
    vi.stubGlobal('fetch', request);
    await signIn('user@example.test', 'password');
    expect(request).toHaveBeenCalledWith('https://abcdefghijklmnopqrst.supabase.co/auth/v1/token?grant_type=password', expect.any(Object));
  });

  it('verifies only invite token hashes, clears a competing session, and stores the verified session for password setup', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'publishable-test-key');
    sessionStorage.setItem('arvc.local.auth.session.v1', JSON.stringify({ accessToken: 'old-user-access', refreshToken: 'old-user-refresh', expiresAt: Date.now() + 3600000, email: 'old@example.test' }));
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input; void init;
      return new Response(JSON.stringify({ access_token: 'invite-access', refresh_token: 'invite-refresh', expires_in: 3600, user: { email: 'invitee@example.test' } }), { status: 200 });
    });
    vi.stubGlobal('fetch', request);

    const session = await acceptInvite('one-time-hash', 'invite');
    expect(request).toHaveBeenCalledWith('https://abcdefghijklmnopqrst.supabase.co/auth/v1/verify', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: 'publishable-test-key' },
      body: JSON.stringify({ token_hash: 'one-time-hash', type: 'invite' }),
      referrerPolicy: 'no-referrer',
    }));
    expect((request.mock.lastCall?.[1]?.headers as Record<string, string> | undefined)).not.toHaveProperty('Authorization');
    expect(session).toMatchObject({ email: 'invitee@example.test', requiresPasswordSetup: true });
    expect(readSession()).toMatchObject({ accessToken: 'invite-access', requiresPasswordSetup: true });
    expect(sessionStorage.getItem('arvc.local.auth.session.v1')).not.toContain('one-time-hash');
    expect(sessionStorage.getItem('arvc.local.auth.session.v1')).not.toContain('old-user-access');
  });

  it('rejects missing or unexpected invite parameters without making a request', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'publishable-test-key');
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    await expect(acceptInvite('', 'invite')).rejects.toThrow(/形式が不正/);
    await expect(acceptInvite('hash', 'recovery')).rejects.toThrow(/形式が不正/);
    expect(request).not.toHaveBeenCalled();
    expect(readSession()).toBeNull();
  });

  it('does not persist a session for an invalid or consumed invite token', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'publishable-test-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'token_hash=secret-detail' }), { status: 400 })));
    await expect(acceptInvite('one-time-hash', 'invite')).rejects.toThrow(/無効または期限切れ/);
    expect(readSession()).toBeNull();
  });

  it('keeps invite verification failures generic and does not accept malformed session responses', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'publishable-test-key');
    for (const status of [401, 500]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'token_hash=private-provider-detail' }), { status })));
      await expect(acceptInvite('one-time-hash', 'invite')).rejects.toThrow(status === 401 ? /無効または期限切れ/ : /時間をおいて/);
      expect(readSession()).toBeNull();
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'only-one-token' }), { status: 200 })));
    await expect(acceptInvite('one-time-hash', 'invite')).rejects.toThrow(/応答を確認できません/);
    expect(readSession()).toBeNull();
  });

  it('updates the password through the authenticated Auth endpoint and clears the setup gate', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'publishable-test-key');
    sessionStorage.setItem('arvc.local.auth.session.v1', JSON.stringify({ accessToken: 'invite-access', refreshToken: 'invite-refresh', expiresAt: Date.now() + 3600000, email: 'invitee@example.test', requiresPasswordSetup: true }));
    const request = vi.fn(async () => new Response('{}', { status: 200 })); vi.stubGlobal('fetch', request);

    await updateInitialPassword('new-password-value');
    expect(request).toHaveBeenCalledWith('https://abcdefghijklmnopqrst.supabase.co/auth/v1/user', expect.objectContaining({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', apikey: 'publishable-test-key', Authorization: 'Bearer invite-access' },
      body: JSON.stringify({ password: 'new-password-value' }),
      referrerPolicy: 'no-referrer',
    }));
    expect(readSession()).toMatchObject({ accessToken: 'invite-access', requiresPasswordSetup: false });
    expect(sessionStorage.getItem('arvc.local.auth.session.v1')).not.toContain('new-password-value');
  });

  it('preserves the password-setup gate across refresh and hides Auth error bodies', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'publishable-test-key');
    sessionStorage.setItem('arvc.local.auth.session.v1', JSON.stringify({ accessToken: 'old-access', refreshToken: 'refresh', expiresAt: Date.now() - 1, email: 'invitee@example.test', requiresPasswordSetup: true }));
    const request = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('grant_type=refresh_token')) return new Response(JSON.stringify({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600, user: { email: 'invitee@example.test' } }), { status: 200 });
      return new Response(JSON.stringify({ message: 'password=secret-policy-detail' }), { status: 400 });
    }); vi.stubGlobal('fetch', request);

    await expect(updateInitialPassword('rejected-password')).rejects.toThrow(/入力内容と認証側のポリシー/);
    expect(readSession()).toMatchObject({ accessToken: 'fresh-access', requiresPasswordSetup: true });
    expect(sessionStorage.getItem('arvc.local.auth.session.v1')).not.toContain('secret-policy-detail');
    expect(sessionStorage.getItem('arvc.local.auth.session.v1')).not.toContain('rejected-password');
  });

  it('does not allow a normal login session to use the invite-only password setup operation', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'publishable-test-key');
    sessionStorage.setItem('arvc.local.auth.session.v1', JSON.stringify({ accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3600000, email: 'user@example.test' }));
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    await expect(updateInitialPassword('password')).rejects.toThrow(/招待セッション/);
    expect(request).not.toHaveBeenCalled();
  });
});
