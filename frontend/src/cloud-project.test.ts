import { describe, expect, it } from 'vitest';
import { demoTimeline, initialEditorBlueprint } from './editor-model';
import { envelopeFromProjectDocumentV1, hydrateCloudEnvelopeV1, toCloudEnvelopeV1 } from './cloud-project';

const metadata = {
  blueprintSchemaVersion: 1 as const,
  featureTimelineSchemaVersion: 1 as const,
  rendererVersion: 'editor-renderer/1' as const,
  analysisVersion: 'fixture/1',
  seed: initialEditorBlueprint.seed,
};

describe('Cloud Document Envelope v1', () => {
  it('keeps editor and timeline v1 data and resolves image/audio refs back to local assets', async () => {
    const imageBlueprint = structuredClone(initialEditorBlueprint);
    imageBlueprint.background = { kind: 'image', src: 'data:image/png;base64,iVBORw0KGgo=' };
    imageBlueprint.effects.push({ id: 'cloud-particles', kind: 'particles', regionId: 'region-stage', color: '#ffd070', count: 64, sizePx: 4, cycleMs: 2200, spread: 0.78, speedInfluence: 0.9, glowIntensity: 1.1, baselineOpacity: 0.14 });
    imageBlueprint.effects.push({ id: 'cloud-burst', kind: 'particle-burst', regionId: 'region-stage', color: '#ff70d0', originX: 0.5, originY: 0.5, directionDeg: 0, spreadDeg: 90, speedPxPerSec: 420, lifetimeMs: 1500, count: 64, sizePx: 7, swirl: 0.55, audioInfluence: 1, baselineOpacity: 0.12 });
    imageBlueprint.effects.push({ id: 'cloud-spectrum-bars', kind: 'spectrum-bars', regionId: 'region-stage', color: '#ffffff', barWidth: 0.7, spacing: 0.1, amplitudeScale: 1.2, glowIntensity: 0.8, segmented: true, segmentsPerBar: 10, attackMs: 40, releaseMs: 200 });
    imageBlueprint.effects.push({ id: 'cloud-ink', kind: 'ink-diffusion', regionId: 'region-stage', color: '#8855cc', diffusionSpeed: 0.25, flowStrength: 0.4, turbulence: 0.3, inkDensity: 0.65, cloudScale: 0.5, responseTime: 3 });
    imageBlueprint.effects.push({ id: 'cloud-ink-flow', kind: 'ink-flow', regionId: 'region-stage', color: '#38bdf8', flowStrength: 0.95 });
    imageBlueprint.effects.push({ id: 'cloud-color-mixing', kind: 'color-mixing', regionId: 'region-stage', color: '#8b5cf6', colorMode: 'custom', customPalette: ['#22d3ee', '#8b5cf6', '#ec4899'], cloudScale: 0.9 });
    imageBlueprint.bindings.push({ id: 'cloud-particles-binding', effectId: 'cloud-particles', source: 'drums.energy', strength: 1, threshold: 0, attackMs: 30, releaseMs: 120 });
    imageBlueprint.bindings.push({ id: 'cloud-burst-binding', effectId: 'cloud-burst', source: 'snare.events', strength: 1, threshold: 0, attackMs: 10, releaseMs: 250 });
    imageBlueprint.bindings.push({ id: 'cloud-spectrum-binding', effectId: 'cloud-spectrum-bars', source: 'music.energy', strength: 0.8, threshold: 0.1, attackMs: 20, releaseMs: 180 });
    imageBlueprint.bindings.push({ id: 'cloud-ink-binding', effectId: 'cloud-ink', source: 'music.energy', strength: 0.8, threshold: 0.1, attackMs: 20, releaseMs: 180 });
    imageBlueprint.bindings.push({ id: 'cloud-ink-flow-binding', effectId: 'cloud-ink-flow', source: 'music.energy', strength: 0.8, threshold: 0.1, attackMs: 20, releaseMs: 180 });
    imageBlueprint.bindings.push({ id: 'cloud-color-mixing-binding', effectId: 'cloud-color-mixing', source: 'vocals.envelope', strength: 0.8, threshold: 0.1, attackMs: 20, releaseMs: 180 });
    const peaks = Array.from({ length: 600 }, () => ({ min: -0.25, max: 0.6 }));
    const extendedTimeline = { ...demoTimeline, bpm: 120, bpmSource: 'fallback' as const, snareEvents: [200], snareEventStrengths: [0.7], vocalsEnvelope: demoTimeline.bassEnvelope, otherEnvelope: demoTimeline.bassEnvelope, musicEnergy: demoTimeline.bassEnvelope, waveformPeaks: { sampleIntervalMs: 20 as const, windowSamples: 882 as const, normalization: 'signed-full-scale' as const, music: peaks, drums: peaks, bass: peaks, vocals: peaks, other: peaks }, frequencySpectrum: { hopMs: 20 as const, fftSize: 4096 as const, bandCount: 32 as const, sampleRateHz: 44100, minHz: 40, maxHz: 16000, normalization: 'whole-clip-p99-log-rms' as const, encoding: 'uint8-linear-0-255' as const, values: Array.from({ length: 600 * 32 }, (_, index) => index % 256) } };
    const envelope = toCloudEnvelopeV1(imageBlueprint, extendedTimeline, metadata, {
      backgroundAssetId: '00000000-0000-4000-8000-000000000001',
      audioAssetId: '00000000-0000-4000-8000-000000000002',
    });
    expect(envelope.cloudDocumentVersion).toBe(1);
    expect(envelope.featureTimeline).toMatchObject({ schemaVersion: 1, timeUnit: 'ms' });
    expect(envelope.editorState.blueprint.background).toEqual({ kind: 'solid', color: '#000000' });
    expect(JSON.stringify(envelope)).not.toContain('data:image');

    const loaded = await hydrateCloudEnvelopeV1(envelope, async (id) => id === envelope.editorState.backgroundAssetId
      ? { id, kind: 'background_image', contentType: 'image/png', file: new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'background.png', { type: 'image/png' }) }
      : { id, kind: 'source_audio', contentType: 'audio/wav', file: new File([new Uint8Array([1, 2, 3])], 'audio.wav', { type: 'audio/wav' }) });
    expect(loaded.blueprint.background.kind).toBe('image');
    if (loaded.blueprint.background.kind !== 'image') throw new Error('expected hydrated image background');
    expect(loaded.blueprint.background.src).toMatch(/^data:image\/png;base64,/);
    expect(loaded.audioFile?.name).toBe('audio.wav');
    expect(loaded.featureTimeline).toEqual({ ...extendedTimeline, schemaVersion: 1, timeUnit: 'ms' });
  });

  it('wraps a legacy ProjectDocument v1 without changing its Blueprint or Timeline contract', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects[0] = { ...blueprint.effects[0]!, opacity: 0.65, visibilityMode: 'always', audioReactive: false };
    const legacy = {
      documentVersion: 1 as const,
      metadata,
      blueprint,
      featureTimeline: { ...structuredClone(demoTimeline), schemaVersion: 1 as const, timeUnit: 'ms' as const },
    };
    const envelope = envelopeFromProjectDocumentV1(legacy);
    expect(envelope.cloudDocumentVersion).toBe(1);
    expect(envelope.editorState.blueprint).toEqual(legacy.blueprint);
    expect(envelope.featureTimeline).toEqual(legacy.featureTimeline);
    expect(envelope.assetRefs.audioAssetId).toBeNull();
  });

  it('keeps legacy Always Particles readable and saves them as Triggered/reactive', async () => {
    const legacy = structuredClone(initialEditorBlueprint);
    legacy.effects.push({ id: 'legacy-particles', kind: 'particles', regionId: 'region-stage', color: '#ffe39b', count: 32, sizePx: 4, cycleMs: 2200, visibilityMode: 'always', audioReactive: false });
    legacy.bindings.push({ id: 'binding-legacy-particles', effectId: 'legacy-particles', source: 'bass.envelope', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 });
    const legacyEnvelope = toCloudEnvelopeV1(legacy, demoTimeline, metadata);
    const storedParticle = legacyEnvelope.editorState.blueprint.effects.at(-1)!;
    expect(storedParticle).toMatchObject({ kind: 'particles', visibilityMode: 'triggered', audioReactive: true });

    const olderEnvelope = structuredClone(legacyEnvelope);
    const olderParticle = olderEnvelope.editorState.blueprint.effects.at(-1)!;
    olderParticle.visibilityMode = 'always';
    olderParticle.audioReactive = false;
    const restored = await hydrateCloudEnvelopeV1(olderEnvelope, async () => { throw new Error('no external assets expected'); });
    expect(restored.blueprint.effects.at(-1)).toMatchObject({ kind: 'particles', visibilityMode: 'always', audioReactive: false });
    const resaved = toCloudEnvelopeV1(restored.blueprint, restored.featureTimeline, metadata);
    expect(resaved.editorState.blueprint.effects.at(-1)).toMatchObject({ kind: 'particles', visibilityMode: 'triggered', audioReactive: true });
  });

  it('rejects an image background without a separately uploaded asset', () => {
    const imageBlueprint = structuredClone(initialEditorBlueprint);
    imageBlueprint.background = { kind: 'image', src: 'data:image/png;base64,iVBORw0KGgo=' };
    expect(() => toCloudEnvelopeV1(imageBlueprint, demoTimeline, metadata)).toThrow(/uploaded as an asset/);
  });

  it('rejects corrupt asset metadata during hydration', async () => {
    const envelope = toCloudEnvelopeV1(initialEditorBlueprint, demoTimeline, metadata, { audioAssetId: '00000000-0000-4000-8000-000000000002' });
    await expect(hydrateCloudEnvelopeV1(envelope, async (id) => ({ id, kind: 'background_image', contentType: 'image/png', file: new File([], 'wrong.png') }))).rejects.toThrow(/audio asset metadata/);
  });
});
