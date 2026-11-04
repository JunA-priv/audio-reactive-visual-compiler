function validatedBase(): string {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim() ?? '';
  if (!configured) return '';
  let parsed: URL;
  try { parsed = new URL(configured); } catch { throw new Error('公開APIのURL設定が不正です。'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin !== configured) {
    throw new Error('公開APIにはorigin形式のHTTPS URLを指定してください。');
  }
  return parsed.origin;
}

export function apiUrl(path: string): string {
  if (!path.startsWith('/api/v1/')) throw new Error('API path is invalid.');
  return `${validatedBase()}${path}`;
}
