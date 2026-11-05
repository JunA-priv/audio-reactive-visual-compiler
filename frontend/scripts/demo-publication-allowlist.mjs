/** Publicly approved demo assets. Keep this list file-specific. */
export const demoPublicationAllowlist = Object.freeze([
  'demo/audio-reactive-silent-demo1.mp3',
  'demo/demo1.feature-timeline-v2.json',
  'demo/demo1.waveform-peaks-v2.json',
  'demo/demo1.frequency-spectrum-v1.json',
  'demo/audio-reactive-silent-demo2.mp3',
  'demo/demo2.feature-timeline-v2.json',
  'demo/demo2.waveform-peaks-v2.json',
  'demo/demo2.frequency-spectrum-v1.json',
  'demo/audio-reactive-silent-demo3.mp3',
  'demo/demo3.feature-timeline-v2.json',
  'demo/demo3.waveform-peaks-v2.json',
  'demo/demo3.frequency-spectrum-v1.json',
]);

export function assertSafeDemoAssetPath(assetPath) {
  if (
    typeof assetPath !== 'string' ||
    assetPath.length === 0 ||
    assetPath.startsWith('/') ||
    assetPath.includes('\\') ||
    assetPath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`Unsafe demo publication path: ${String(assetPath)}`);
  }
  return assetPath;
}

for (const assetPath of demoPublicationAllowlist) assertSafeDemoAssetPath(assetPath);
