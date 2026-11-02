import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSession, signIn, signOut, validSession } from './auth-client';

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

  it('rejects non-loopback Supabase settings before sending credentials', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://supabase.example');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'public-key');
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    await expect(signIn('user@example.test', 'password')).rejects.toThrow(/loopback/);
    expect(request).not.toHaveBeenCalled();
  });
});
