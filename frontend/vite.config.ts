import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { assertSafeDemoAssetPath, demoPublicationAllowlist } from './scripts/demo-publication-allowlist.mjs';

function localApiProxyTarget(): string {
  const target = process.env.ARVC_API_PROXY_TARGET?.trim() || 'http://127.0.0.1:8080';
  try {
    const url = new URL(target);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new Error('ARVC_API_PROXY_TARGET must be a local loopback HTTP origin.');
  }
}

type LocalApiRequest = {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
};

export function stripLocalApiProxyOrigin(request: LocalApiRequest): void {
  const pathname = request.url?.split('?', 1)[0] ?? '';
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    delete request.headers.origin;
  }
}

function localApiProxyOriginPlugin(): Plugin {
  return {
    name: 'arvc-local-api-proxy-origin',
    configureServer(server) {
      // Vite invokes configureServer before installing its proxy middleware.
      // Strip the browser-only Origin from the incoming request, before the
      // upstream ClientRequest exists and can flush its headers.
      server.middlewares.use((request, _response, next) => {
        stripLocalApiProxyOrigin(request);
        next();
      });
    },
  };
}

function cloudflarePagesHeadersPlugin(): Plugin {
  return {
    name: 'arvc-cloudflare-pages-headers',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: '_headers',
        source: '/*\n  Referrer-Policy: no-referrer\n',
      });
    },
  };
}

function approvedDemoAssetsPlugin(): Plugin {
  const publicDirectory = resolve(import.meta.dirname, 'public');
  return {
    name: 'arvc-approved-demo-assets',
    apply: 'build',
    async generateBundle() {
      for (const assetPath of demoPublicationAllowlist) {
        const safePath = assertSafeDemoAssetPath(assetPath);
        const sourcePath = resolve(publicDirectory, safePath);
        const resolvedPath = await realpath(sourcePath);
        const relativePath = relative(publicDirectory, resolvedPath);
        if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || resolve(publicDirectory, relativePath) !== resolvedPath) {
          throw new Error(`Allowlisted demo asset escapes public/: ${safePath}`);
        }
        const stats = await lstat(sourcePath);
        if (!stats.isFile()) throw new Error(`Allowlisted demo asset is not a regular file: public/${safePath}`);
        let source: Buffer;
        try {
          source = await readFile(sourcePath);
        } catch (error) {
          throw new Error(`Allowlisted demo asset is missing: public/${safePath}`, { cause: error });
        }
        this.emitFile({ type: 'asset', fileName: safePath, source });
      }
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), localApiProxyOriginPlugin(), cloudflarePagesHeadersPlugin(), approvedDemoAssetsPlugin()],
  // Serve local public assets during development; production copies only the explicit allowlist.
  publicDir: command === 'serve' ? 'public' : false,
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: localApiProxyTarget(),
      },
    },
  },
  test: {
    environment: 'happy-dom',
  },
}));
