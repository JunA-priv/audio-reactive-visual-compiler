import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

afterEach(() => {
  document.body.replaceChildren();
  sessionStorage.clear();
  history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function mountAt(path: string) {
  history.replaceState({}, '', path);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<App />));
  return { host, root };
}

describe('application routes', () => {
  it('shows the two-column login and guest entry points and routes guests to the fixed demo', () => {
    const { host, root } = mountAt('/');
    expect(host.querySelectorAll('.landing-columns > section')).toHaveLength(2);
    expect(host.querySelector('#landing-login-heading')?.textContent).toBe('ログイン');
    expect(host.querySelector('#landing-guest-heading')?.textContent).toBe('ゲストユーザーとして使用');
    expect(host.querySelector('label[for="login-user-id"] input')?.getAttribute('type')).toBe('email');
    expect(host.querySelector('label[for="login-password"] input')?.getAttribute('type')).toBe('password');
    expect(host.querySelector('.landing-login-form')).not.toBeNull();
    expect(host.querySelector('a[href="/register"]')?.textContent).toBe('新規ユーザー登録');
    const guest = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'ゲストで試す')!;
    act(() => guest.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(host.querySelector('h1')?.textContent).toBe('サンプルデモ');
    act(() => root.unmount());
  });

  it('logs in from the landing form and routes to the authenticated editor', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'local-public-key');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/v1/token?grant_type=password')) {
        return new Response(JSON.stringify({ access_token: 'local-jwt', refresh_token: 'refresh', expires_in: 3600, user: { email: 'user@example.test' } }), { status: 200 });
      }
      if (url.endsWith('/api/v1/projects?limit=20')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      throw new Error('unexpected request');
    }));
    const { host, root } = mountAt('/');
    const user = host.querySelector<HTMLInputElement>('#login-user-id')!;
    const password = host.querySelector<HTMLInputElement>('#login-password')!;
    const set = (input: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set(user, 'user@example.test'); set(password, 'local-password');
    await act(async () => {
      host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(host.querySelector('[aria-label="編集設定"]')).not.toBeNull();
    expect(sessionStorage.getItem('arvc.local.auth.session.v1')).toContain('local-jwt');
    act(() => root.unmount());
  });

  it('provides a registration destination without changing the current auth flow', () => {
    const { host, root } = mountAt('/register');
    expect(host.querySelector('h1')?.textContent).toBe('新規ユーザー登録');
    expect(host.textContent).toContain('新規アカウントの登録手続きを受け付けていません');
    expect(host.querySelector('a[href="/login"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it('scrubs the fragment token, waits for explicit confirmation, then routes a valid invite session to password setup', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'publishable-test-key');
    const request = vi.fn(async () => new Response(JSON.stringify({ access_token: 'invite-access', refresh_token: 'invite-refresh', expires_in: 3600, user: { email: 'invitee@example.test' } }), { status: 200 }));
    vi.stubGlobal('fetch', request);
    sessionStorage.setItem('arvc.local.auth.session.v1', JSON.stringify({ accessToken: 'other-user-access', refreshToken: 'other-user-refresh', expiresAt: Date.now() + 3600000, email: 'other@example.test' }));
    const { host, root } = mountAt('/auth/callback#token_hash=one-time-secret&type=invite');
    expect(window.location.pathname).toBe('/auth/callback');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('');
    expect(host.querySelector('h1')?.textContent).toBe('招待の確認');
    expect(request).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('arvc.local.auth.session.v1')).toContain('other-user-access');
    const confirm = host.querySelector<HTMLButtonElement>('button')!;
    await act(async () => {
      confirm.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(host.querySelector('h1')?.textContent).toBe('初回パスワード設定');
    expect(window.location.pathname).toBe('/auth/set-password');
    expect(sessionStorage.getItem('arvc.local.auth.session.v1')).toContain('requiresPasswordSetup');
    expect(sessionStorage.getItem('arvc.local.auth.session.v1')).not.toContain('one-time-secret');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('https://abcdefghijklmnopqrst.supabase.co/auth/v1/verify', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ token_hash: 'one-time-secret', type: 'invite' }), referrerPolicy: 'no-referrer',
    }));
    act(() => root.unmount());
  });

  it('rejects duplicate or non-invite callback parameters without calling Auth', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'publishable-test-key');
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    const { host, root } = mountAt('/auth/callback#token_hash=first&token_hash=second&type=recovery');
    expect(window.location.search).toBe('');
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(request).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('もう一度開いてください');
    expect(sessionStorage.getItem('arvc.local.auth.session.v1')).toBeNull();
    act(() => root.unmount());
  });

  it('does not replay a callback after reload when the one-time token is absent', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'publishable-test-key');
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    const { host, root } = mountAt('/auth/callback');
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(request).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('もう一度開いてください');
    act(() => root.unmount());
  });

  it.each([
    ['/auth/callback?token_hash=legacy&type=invite', 'query-only legacy link'],
    ['/auth/callback?next=%2Fapp#token_hash=fragment&type=invite', 'query and fragment mixture'],
    ['/auth/callback#token_hash=first&token_hash=second&type=invite', 'duplicate token'],
    ['/auth/callback#token_hash=token&type=invite&type=recovery', 'duplicate type'],
    ['/auth/callback#token_hash=%E0%A4%A&type=invite', 'malformed percent encoding'],
    ['/auth/callback#token_hash=token&type=recovery', 'unsupported type'],
    ['/auth/callback#token_hash=&type=invite', 'empty token'],
    [`/auth/callback#token_hash=${'x'.repeat(4097)}&type=invite`, 'oversized token'],
    ['/auth/callback#token_hash=token&type=invite&redirect_to=https%3A%2F%2Fevil.example', 'unknown redirect parameter'],
  ])('rejects unsafe callback input without verifying (%s)', async (url) => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'publishable-test-key');
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    const { host, root } = mountAt(url);
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('');
    expect(request).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('もう一度開いてください');
    expect(sessionStorage.getItem('arvc.local.auth.session.v1')).toBeNull();
    act(() => root.unmount());
  });

  it('verifies only once under StrictMode and double click while a request is pending', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'publishable-test-key');
    let finish!: (response: Response) => void;
    const request = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', request);
    history.replaceState({}, '', '/auth/callback#token_hash=one-time-secret&type=invite');
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<StrictMode><App /></StrictMode>));
    expect(host.querySelector('h1')?.textContent).toBe('招待の確認');
    expect(request).not.toHaveBeenCalled();
    await act(async () => {
      const button = host.querySelector<HTMLButtonElement>('button')!;
      button.click(); button.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('確認しています');
    await act(async () => {
      finish(new Response(JSON.stringify({ access_token: 'invite-access', refresh_token: 'invite-refresh', expires_in: 3600, user: { email: 'invitee@example.test' } }), { status: 200 }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(window.location.pathname).toBe('/auth/set-password');
    act(() => root.unmount());
  });

  it.each([400, 401, 500])('keeps failed invitation verification unauthenticated for HTTP %i and consumes no retry token', async (status) => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'publishable-test-key');
    const request = vi.fn(async () => new Response(JSON.stringify({ message: 'token_hash=do-not-display' }), { status }));
    vi.stubGlobal('fetch', request);
    const { host, root } = mountAt('/auth/callback#token_hash=one-time-secret&type=invite');
    expect(request).not.toHaveBeenCalled();
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button')!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/auth/callback');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('再招待');
    expect(host.textContent).not.toContain('one-time-secret');
    expect(host.textContent).not.toContain('do-not-display');
    expect(sessionStorage.getItem('arvc.local.auth.session.v1')).toBeNull();
    expect(host.querySelector('button')).toBeNull();
    act(() => root.unmount());
  });

  it('shows the first-password form only for an invite session and prevents duplicate submission', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'publishable-test-key');
    sessionStorage.setItem('arvc.local.auth.session.v1', JSON.stringify({ accessToken: 'invite-access', refreshToken: 'invite-refresh', expiresAt: Date.now() + 3600000, email: 'invitee@example.test', requiresPasswordSetup: true }));
    let finish!: (response: Response) => void;
    const request = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })); vi.stubGlobal('fetch', request);
    const { host, root } = mountAt('/auth/set-password');
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    const password = host.querySelector<HTMLInputElement>('#invite-password')!;
    const confirmation = host.querySelector<HTMLInputElement>('#invite-password-confirm')!;
    const set = (input: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set(password, 'New-password-123'); set(confirmation, 'different-password');
    await act(async () => {
      host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(request).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('一致しません');
    set(confirmation, 'New-password-123');
    await act(async () => {
      const form = host.querySelector('form')!;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('https://abcdefghijklmnopqrst.supabase.co/auth/v1/user', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ password: 'New-password-123' }) }));
    await act(async () => { finish(new Response('{}', { status: 200 })); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(window.location.pathname).toBe('/app');
    expect(sessionStorage.getItem('arvc.local.auth.session.v1')).not.toContain('New-password-123');
    expect(JSON.parse(sessionStorage.getItem('arvc.local.auth.session.v1')!).requiresPasswordSetup).toBe(false);
    act(() => root.unmount());
  });

  it('does not expose first-password setup to a non-invite session', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'publishable-test-key');
    sessionStorage.setItem('arvc.local.auth.session.v1', JSON.stringify({ accessToken: 'normal-access', refreshToken: 'normal-refresh', expiresAt: Date.now() + 3600000, email: 'user@example.test' }));
    const { host, root } = mountAt('/auth/set-password');
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(host.querySelector('#invite-password')).toBeNull();
    expect(window.location.pathname).toBe('/app');
    act(() => root.unmount());
  });

  it('keeps an invite session in password setup even when the user opens the protected editor route directly', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'publishable-test-key');
    sessionStorage.setItem('arvc.local.auth.session.v1', JSON.stringify({ accessToken: 'invite-access', refreshToken: 'invite-refresh', expiresAt: Date.now() + 3600000, email: 'invitee@example.test', requiresPasswordSetup: true }));
    const { host, root } = mountAt('/app');
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(host.querySelector('h1')?.textContent).toBe('初回パスワード設定');
    expect(host.querySelector('#invite-password')).not.toBeNull();
    act(() => root.unmount());
  });

  it('keeps the demo route open and asks anonymous users to authenticate for /app', async () => {
    const demo = mountAt('/demo');
    expect(demo.host.querySelector('h1')?.textContent).toBe('サンプルデモ');
    act(() => demo.root.unmount());

    const app = mountAt('/app');
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(app.host.querySelector('h1')?.textContent).toBe('ログイン');
    expect(app.host.querySelector('[aria-label="ユーザーID"]')).not.toBeNull();
    expect(app.host.querySelector('canvas')).toBeNull();
    act(() => app.root.unmount());
  });
});
