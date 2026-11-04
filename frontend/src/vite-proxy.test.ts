import { describe, expect, it } from 'vitest';
import { stripLocalApiProxyOrigin } from '../vite.config';

describe('local Vite API proxy', () => {
  it('strips browser Origin before proxying while preserving Authorization and multipart headers', () => {
    const request = {
      url: '/api/v1/audio/analyze?probe=1',
      headers: {
        origin: 'http://172.25.179.49:5174',
        authorization: 'Bearer test-token',
        'content-type': 'multipart/form-data; boundary=test-boundary',
      },
    };

    stripLocalApiProxyOrigin(request);

    expect(request.headers.origin).toBeUndefined();
    expect(request.headers.authorization).toBe('Bearer test-token');
    expect(request.headers['content-type']).toBe('multipart/form-data; boundary=test-boundary');
  });

  it('leaves Origin unchanged for paths outside the local API proxy', () => {
    const request = {
      url: '/app?view=editor',
      headers: { origin: 'http://172.25.179.49:5174' },
    };

    stripLocalApiProxyOrigin(request);

    expect(request.headers.origin).toBe('http://172.25.179.49:5174');
  });
});
