import { access, readFile, readdir } from 'node:fs/promises';
import { Console } from 'node:console';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';

const logger = new Console(process.stdout, process.stderr);
const distDirectory = fileURLToPath(new URL('../dist/', import.meta.url));
const headersPath = join(distDirectory, '_headers');
const expectedHeaders = '/*\n  Referrer-Policy: no-referrer\n';

function fail(message) {
  logger.error(`Cloudflare Pages build verification failed: ${message}`);
  process.exitCode = 1;
}

try {
  const headers = await readFile(headersPath, 'utf8');
  if (headers !== expectedHeaders) fail('dist/_headers does not match the required Referrer-Policy rule.');

  await access(join(distDirectory, 'index.html'));
  const entries = await readdir(distDirectory, { withFileTypes: true });
  if (entries.some((entry) => entry.name === '404.html')) fail('dist/404.html would override the Pages SPA fallback.');
  if (entries.some((entry) => entry.name === 'demo')) fail('dist contains unapproved demo assets.');
  if (entries.some((entry) => /\.(wav|mp3)$/i.test(entry.name))) fail('dist contains an unapproved demo audio asset.');

  const assetsDirectory = join(distDirectory, 'assets');
  const assets = await readdir(assetsDirectory);
  if (!assets.some((name) => name.endsWith('.js'))) fail('dist/assets has no JavaScript bundle.');
  if (!assets.some((name) => name.endsWith('.css'))) fail('dist/assets has no CSS bundle.');
} catch (error) {
  fail(error instanceof Error ? error.message : 'required build output is unavailable.');
}

if (process.exitCode !== 1) logger.log('Cloudflare Pages build verification passed.');
