import { act } from 'react';
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
