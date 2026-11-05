import { access, readFile, readdir } from 'node:fs/promises';
import { Console } from 'node:console';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { join, relative, resolve, sep } from 'node:path';
import { assertSafeDemoAssetPath, demoPublicationAllowlist } from './demo-publication-allowlist.mjs';

const logger = new Console(process.stdout, process.stderr);
const distDirectory = fileURLToPath(new URL('../dist/', import.meta.url));
const headersPath = join(distDirectory, '_headers');
const expectedHeaders = '/*\n  Referrer-Policy: no-referrer\n';
const expectedDemoAssets = new Set(demoPublicationAllowlist.map(assertSafeDemoAssetPath));

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(fullPath));
    else if (entry.isFile()) files.push(relative(distDirectory, fullPath).split(sep).join('/'));
  }
  return files;
}

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

  const files = await listFiles(distDirectory);
  for (const assetPath of expectedDemoAssets) {
    try {
      await access(resolve(distDirectory, assetPath));
    } catch {
      fail(`allowlisted demo asset is missing: ${assetPath}`);
    }
  }
  for (const assetPath of files) {
    const isRestrictedAsset = /\.(wav|mp3|ogg|flac|m4a|json)$/i.test(assetPath);
    if (isRestrictedAsset && !expectedDemoAssets.has(assetPath)) {
      fail(`dist contains a non-allowlisted audio or JSON asset: ${assetPath}`);
    }
  }
  const emittedDemoAssets = new Set(files.filter((assetPath) => assetPath.startsWith('demo/')));
  if (emittedDemoAssets.size !== expectedDemoAssets.size || [...emittedDemoAssets].some((assetPath) => !expectedDemoAssets.has(assetPath))) {
    fail('dist/demo does not exactly match the demo publication allowlist.');
  }

  const assetsDirectory = join(distDirectory, 'assets');
  const assets = await readdir(assetsDirectory);
  if (!assets.some((name) => name.endsWith('.js'))) fail('dist/assets has no JavaScript bundle.');
  if (!assets.some((name) => name.endsWith('.css'))) fail('dist/assets has no CSS bundle.');
} catch (error) {
  fail(error instanceof Error ? error.message : 'required build output is unavailable.');
}

if (process.exitCode !== 1) logger.log('Cloudflare Pages build verification passed.');
