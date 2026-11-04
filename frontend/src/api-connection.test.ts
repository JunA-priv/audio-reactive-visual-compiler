import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiUrl } from './api-connection';

afterEach(() => vi.unstubAllEnvs());

describe('shared API connection', () => {
  it('keeps local relative routing when no public endpoint is configured', () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    expect(apiUrl('/api/v1/audio/analyze')).toBe('/api/v1/audio/analyze');
  });

  it('routes API calls through the configured HTTPS origin', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com');
    expect(apiUrl('/api/v1/blueprints/generate')).toBe('https://api.example.com/api/v1/blueprints/generate');
  });

  it.each(['http://api.example.com', 'https://user@api.example.com', 'https://api.example.com/path', 'javascript:alert(1)', 'https://api.example.com?x=1'])('rejects unsafe API base %s', (base) => {
    vi.stubEnv('VITE_API_BASE_URL', base);
    expect(() => apiUrl('/api/v1/audio/analyze')).toThrow();
  });

  it('rejects paths outside the API contract', () => {
    expect(() => apiUrl('//evil.test/path')).toThrow(/path is invalid/);
  });
});
