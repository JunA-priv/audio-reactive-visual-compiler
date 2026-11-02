import { describe, expect, it } from 'vitest';
import { demoTimeline, initialEditorBlueprint } from './editor-model';
import type { MusicSummary } from './audio-analysis';
import {
  MAX_PROJECT_FILE_BYTES,
  PROJECT_FILE_FORMAT,
  parseProjectFile,
  serializeProject,
} from './project-file';

function projectFile(value: unknown): File {
  return new File([JSON.stringify(value)], 'test.arvproj', { type: 'application/json' });
}

function summary(durationMs: number, fileBytes: number): MusicSummary {
  return {
    summaryVersion: 1, durationMs,
    sourceAudio: { format: 'wav', codec: 'pcm_s16le', sampleRateHz: 44_100, channels: 2, fileBytes },
    analysis: { model: 'htdemucs', device: 'cpu', stemRms: { drums: 0.1, bass: 0.2, vocals: 0.1, other: 0.1 }, estimatedKickCount: 54, featureSampleRateHz: 100, kickDetection: 'fixture' },
  };
}

function pcmWav(frames: number): Uint8Array {
  const bytes = new Uint8Array(44 + frames * 4);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string) => { for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index)); };
  ascii(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true); view.setUint32(24, 44_100, true);
  view.setUint32(28, 176_400, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, frames * 4, true);
  return bytes;
}

describe('local project format', () => {
  it('round-trips Blueprint, full Feature Timeline metadata, background and embedded audio', async () => {
    const timeline = {
      ...structuredClone(demoTimeline),
      schemaVersion: 1,
      timeUnit: 'ms',
      analysisVersion: 'python-island/test-fixture',
      featureHopMs: 10,
      drumEnergy: [{ timeMs: 0, value: 0.1 }, { timeMs: 12000, value: 0.5 }],
      snareEvents: [250, 900], snareEventStrengths: [0.8, 0.5],
      vocalsEnvelope: [{ timeMs: 0, value: 0.3 }, { timeMs: 12000, value: 0.6 }],
      otherEnvelope: [{ timeMs: 0, value: 0.2 }, { timeMs: 12000, value: 0.4 }],
      musicEnergy: [{ timeMs: 0, value: 0.1 }, { timeMs: 12000, value: 0.7 }],
    };
    const audio = new File([new Uint8Array([0, 1, 2, 3, 4, 5])], 'synthetic.wav', { type: 'audio/wav' });
    const blob = await serializeProject(initialEditorBlueprint, timeline, audio, new Date('2026-10-31T00:00:00.000Z'));
    const project = JSON.parse(await blob.text()) as { format: string; metadata: { rendererVersion: string }; blueprint: unknown };
    expect(project.format).toBe(PROJECT_FILE_FORMAT);
    expect(project.metadata.rendererVersion).toBe('editor-renderer/1');
    const restored = await parseProjectFile(new File([blob], 'roundtrip.arvproj'));
    expect(restored.blueprint).toEqual(initialEditorBlueprint);
    expect(restored.featureTimeline).toEqual(timeline);
    expect(restored.audioFile?.name).toBe('synthetic.wav');
    expect(restored.audioFile?.type).toBe('audio/wav');
    expect([...new Uint8Array(await restored.audioFile!.arrayBuffer())]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(restored.musicSummary).toBeNull();
  });

  it('round-trips a project without audio as audio-free', async () => {
    const blob = await serializeProject(initialEditorBlueprint, demoTimeline, null);
    const restored = await parseProjectFile(new File([blob], 'silent-project.arvproj'));
    expect(restored.audioFile).toBeNull();
    expect(restored.musicSummary).toBeNull();
    expect(restored.blueprint).toEqual(initialEditorBlueprint);
    expect(restored.featureTimeline).toEqual(demoTimeline);
  });

  it('loads legacy Always Particles and normalizes them to Triggered/reactive on resave', async () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects.push({ id: 'legacy-particles', kind: 'particles', regionId: 'region-stage', color: '#ffe39b', count: 32, sizePx: 4, cycleMs: 2200, visibilityMode: 'always', audioReactive: false });
    blueprint.bindings.push({ id: 'binding-legacy-particles', effectId: 'legacy-particles', source: 'bass.envelope', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 });
    const initial = JSON.parse(await (await serializeProject(blueprint, demoTimeline, null)).text()) as Record<string, unknown>;
    const storedBlueprint = initial.blueprint as typeof blueprint;
    storedBlueprint.effects.at(-1)!.visibilityMode = 'always';
    storedBlueprint.effects.at(-1)!.audioReactive = false;
    const restored = await parseProjectFile(projectFile(initial));
    const legacyParticle = restored.blueprint.effects.at(-1)!;
    expect(legacyParticle.visibilityMode).toBe('always');
    expect(legacyParticle.audioReactive).toBe(false);

    const resaved = JSON.parse(await (await serializeProject(restored.blueprint, demoTimeline, null)).text()) as { blueprint: typeof blueprint };
    expect(resaved.blueprint.effects.at(-1)).toMatchObject({ kind: 'particles', visibilityMode: 'triggered', audioReactive: true });
  });

  it('round-trips Phase A effects without changing the .arvproj v1 container', async () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.globalGradient = { startColor: '#102030', middleColor: '#405060', endColor: '#708090', angleDeg: 135 };
    blueprint.effects.push(
      { id: 'radial-new', kind: 'radial-bars', regionId: 'region-stage', color: '#91e8ff', colorMode: 'global-gradient', centerX: 0.5, centerY: 0.5, radius: 0.22, bars: 40, barLength: 0.16, lineWidth: 0.55 },
      { id: 'ring-new', kind: 'wave-ring', regionId: 'region-accent', color: '#ff9bd1', opacity: 0.65, centerX: 0.5, centerY: 0.5, radius: 0.24, amplitude: 0.08, points: 64, lineWidth: 0.012, layerCount: 4, layerRadiusStep: 0.018, layerAngleOffsetDeg: 0, layerAmplitudeDecay: 0.9 },
    );
    blueprint.bindings.push(
      { id: 'binding-radial-new', effectId: 'radial-new', source: 'bass.envelope', strength: 0.9, threshold: 0.1, attackMs: 60, releaseMs: 260 },
      { id: 'binding-ring-new', effectId: 'ring-new', source: 'bass.envelope', strength: 0.9, threshold: 0.1, attackMs: 60, releaseMs: 260 },
    );
    const blob = await serializeProject(blueprint, demoTimeline, null);
    const restored = await parseProjectFile(new File([blob], 'phase-a.arvproj'));
    expect(restored.blueprint).toEqual(blueprint);
    expect(JSON.parse(await blob.text())).toMatchObject({ formatVersion: 1, metadata: { blueprintSchemaVersion: 1 } });
  });

  it('round-trips Phase A particles, Ripple, Shockwave and Glow extension in the unchanged .arvproj v1 container', async () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects.push(
      { id: 'particles-v1', kind: 'particles', regionId: 'region-stage', color: '#ffe39b', count: 64, sizePx: 4, cycleMs: 2200, spread: 0.78, speedInfluence: 0.9, glowIntensity: 1.1, baselineOpacity: 0.14 },
      { id: 'burst-v1', kind: 'particle-burst', regionId: 'region-stage', color: '#ffe39b', originX: 0.5, originY: 0.5, directionDeg: 0, spreadDeg: 90, speedPxPerSec: 420, lifetimeMs: 1500, count: 64, sizePx: 7, swirl: 0.55, audioInfluence: 1, baselineOpacity: 0.12 },
      { id: 'trail-v1', kind: 'particle-trail', regionId: 'region-accent', color: '#91e8ff', samples: 48, trailMs: 1800, sizePx: 7, amplitude: 0.28 },
      { id: 'ripple-v1', kind: 'ripple', regionId: 'region-stage', color: '#88ddff', centerX: 0.5, centerY: 0.5, waves: 3, periodMs: 1600, radius: 0.34, amplitude: 0.08, lineWidth: 0.012 },
      { id: 'shock-v1', kind: 'shockwave', regionId: 'region-accent', color: '#ff88cc', centerX: 0.5, centerY: 0.5, maxRadius: 0.42, lifetimeMs: 1000, lineWidth: 0.018 },
      { id: 'glow-upgraded', kind: 'glow-brightness', regionId: 'region-stage', color: '#91e8ff', blurPx: 26, brightness: 1.2, glowIntensity: 1.3 },
      { id: 'osc-v1', kind: 'oscilloscope-line', regionId: 'region-stage', color: '#45f3ff', orientation: 'radial', lineWidth: 0.012, sampleCount: 256, amplitudeScale: 0.9, glowIntensity: 1.6 },
    );
    blueprint.bindings.push(
      { id: 'binding-particles-v1', effectId: 'particles-v1', source: 'bass.envelope', strength: 0.9, threshold: 0.1, attackMs: 60, releaseMs: 260 },
      { id: 'binding-burst-v1', effectId: 'burst-v1', source: 'kick.events', strength: 0.9, threshold: 0.1, attackMs: 60, releaseMs: 260 },
      { id: 'binding-trail-v1', effectId: 'trail-v1', source: 'bass.envelope', strength: 0.9, threshold: 0.1, attackMs: 60, releaseMs: 260 },
      { id: 'binding-ripple-v1', effectId: 'ripple-v1', source: 'bass.envelope', strength: 0.9, threshold: 0.1, attackMs: 60, releaseMs: 260 },
      { id: 'binding-shock-v1', effectId: 'shock-v1', source: 'kick.events', strength: 0.9, threshold: 0.1, attackMs: 60, releaseMs: 260 },
      { id: 'binding-glow-upgraded', effectId: 'glow-upgraded', source: 'bass.envelope', strength: 0.9, threshold: 0.1, attackMs: 60, releaseMs: 260 },
      { id: 'binding-osc-v1', effectId: 'osc-v1', source: 'bass.envelope', strength: 0.9, threshold: 0.1, attackMs: 60, releaseMs: 260 },
    );
    const blob = await serializeProject(blueprint, demoTimeline, null);
    const restored = await parseProjectFile(new File([blob], 'particles.arvproj'));
    const canonicalBlueprint = structuredClone(blueprint);
    const canonicalParticles = canonicalBlueprint.effects.find((effect) => effect.kind === 'particles');
    if (canonicalParticles?.kind === 'particles') {
      canonicalParticles.visibilityMode = 'triggered';
      canonicalParticles.audioReactive = true;
    }
    expect(restored.blueprint).toEqual(canonicalBlueprint);
    expect(JSON.parse(await blob.text())).toMatchObject({ formatVersion: 1, metadata: { blueprintSchemaVersion: 1 } });
  });

  it('round-trips additive Spectrum Effects, BPM, peaks, and quantized Timeline v1 bands', async () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects.push(
      { id: 'spectrum-bars-v1', kind: 'spectrum-bars', regionId: 'region-stage', color: '#ffffff', barWidth: 0.7, spacing: 0.1, amplitudeScale: 1.2, glowIntensity: 0.8, segmented: true, segmentsPerBar: 10, attackMs: 40, releaseMs: 200 },
      { id: 'spectrum-line-v1', kind: 'spectrum-line', regionId: 'region-stage', color: '#ffffff', amplitudeScale: 1.4, lineWidth: 0.01, smoothing: 0.4, glowIntensity: 0.7, attackMs: 45, releaseMs: 210 },
    );
    blueprint.bindings.push(
      { id: 'binding-spectrum-bars-v1', effectId: 'spectrum-bars-v1', source: 'music.energy', strength: 0.9, threshold: 0.1, attackMs: 20, releaseMs: 150 },
      { id: 'binding-spectrum-line-v1', effectId: 'spectrum-line-v1', source: 'kick.events', strength: 0.9, threshold: 0.1, attackMs: 20, releaseMs: 150 },
    );
    const sourcePeaks = Array.from({ length: 600 }, () => ({ min: -0.4, max: 0.7 }));
    const timeline = { ...structuredClone(demoTimeline), bpm: 120, bpmSource: 'fallback' as const, waveformPeaks: { sampleIntervalMs: 20 as const, windowSamples: 882 as const, normalization: 'signed-full-scale' as const, music: sourcePeaks, drums: sourcePeaks, bass: sourcePeaks, vocals: sourcePeaks, other: sourcePeaks }, frequencySpectrum: { hopMs: 20 as const, fftSize: 4096 as const, bandCount: 32 as const, sampleRateHz: 44100, minHz: 40, maxHz: 16000, normalization: 'whole-clip-p99-log-rms' as const, encoding: 'uint8-linear-0-255' as const, values: Array.from({ length: 600 * 32 }, (_, index) => index % 256) } };
    const blob = await serializeProject(blueprint, timeline, null);
    const restored = await parseProjectFile(new File([blob], 'waveform-project.arvproj'));
    expect(restored.blueprint).toEqual(blueprint);
    expect(restored.featureTimeline).toEqual(timeline);
    expect(JSON.parse(await blob.text())).toMatchObject({ formatVersion: 1, metadata: { blueprintSchemaVersion: 1, featureTimelineSchemaVersion: 1 } });
  });

  it('round-trips Ink Diffusion in arvproj v1 without adding a category field', async () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects.push({ id: 'ink-v1', kind: 'ink-diffusion', regionId: 'region-stage', color: '#8955cc', colorMode: 'global-gradient', opacity: 0.75, visibilityMode: 'always', audioReactive: true, diffusionSpeed: 0.25, flowStrength: 0.4, turbulence: 0.3, inkDensity: 0.65, cloudScale: 0.5, responseTime: 3 });
    blueprint.bindings.push({ id: 'binding-ink-v1', effectId: 'ink-v1', source: 'music.energy', strength: 0.9, threshold: 0.1, attackMs: 60, releaseMs: 260 });
    blueprint.effects.push({ id: 'ink-flow-v1', kind: 'ink-flow', regionId: 'region-stage', color: '#38bdf8', flowStrength: 0.95 });
    blueprint.effects.push({ id: 'color-mixing-v1', kind: 'color-mixing', regionId: 'region-stage', color: '#8b5cf6', colorMode: 'custom', customPalette: ['#22d3ee', '#8b5cf6', '#ec4899', '#f59e0b'], cloudScale: 0.9 });
    blueprint.bindings.push({ id: 'binding-ink-flow-v1', effectId: 'ink-flow-v1', source: 'music.energy', strength: 0.8, threshold: 0.1, attackMs: 60, releaseMs: 260 }, { id: 'binding-color-mixing-v1', effectId: 'color-mixing-v1', source: 'vocals.envelope', strength: 0.7, threshold: 0.1, attackMs: 60, releaseMs: 260 });
    const blob = await serializeProject(blueprint, demoTimeline, null);
    const restored = await parseProjectFile(new File([blob], 'ink.arvproj'));
    expect(restored.blueprint).toEqual(blueprint);
    expect(restored.blueprint.effects.slice(-3).every((effect) => !('category' in effect))).toBe(true);
    expect(JSON.parse(await blob.text())).toMatchObject({ formatVersion: 1, metadata: { blueprintSchemaVersion: 1, featureTimelineSchemaVersion: 1 } });
  });

  it('preserves audio bytes and Feature Timeline through repeated save/restore cycles', async () => {
    const audioBytes = new Uint8Array([31, 41, 59, 26, 53, 58]);
    let currentAudio: File | null = new File([audioBytes], 'cycle.wav', { type: 'audio/wav' });
    let currentTimeline = structuredClone(demoTimeline);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const project = await serializeProject(initialEditorBlueprint, currentTimeline, currentAudio);
      const restored = await parseProjectFile(new File([project], `cycle-${cycle}.arvproj`));
      expect(restored.featureTimeline).toEqual(demoTimeline);
      expect(restored.audioFile).not.toBeNull();
      expect(new Uint8Array(await restored.audioFile!.arrayBuffer())).toEqual(audioBytes);
      currentAudio = restored.audioFile;
      currentTimeline = restored.featureTimeline;
    }
  });

  it('rejects version, missing data, malformed JSON and corrupted embedded audio', async () => {
    await expect(parseProjectFile(projectFile({ format: PROJECT_FILE_FORMAT, formatVersion: 9 }))).rejects.toThrow(/version/);
    await expect(parseProjectFile(new File(['{'], 'broken.arvproj'))).rejects.toThrow(/JSON/);
    const blob = await serializeProject(initialEditorBlueprint, demoTimeline, new File([new Uint8Array([1, 2, 3])], 'audio.mp3', { type: 'audio/mpeg' }));
    const value = JSON.parse(await blob.text()) as { assets: { audio: { sha256: string } } };
    value.assets.audio.sha256 = '0'.repeat(64);
    await expect(parseProjectFile(projectFile(value))).rejects.toThrow(/integrity/);
  });

  it('rejects an oversized project before reading it', async () => {
    const oversized = { size: MAX_PROJECT_FILE_BYTES + 1, text: () => Promise.reject(new Error('must not read')) } as File;
    await expect(parseProjectFile(oversized)).rejects.toThrow(/64 MiB/);
  });

  it('rejects invalid Feature Timeline references and unsupported schema version', async () => {
    const valid = JSON.parse(await (await serializeProject(initialEditorBlueprint, demoTimeline, null)).text()) as Record<string, unknown>;
    const wrongTimeline = { ...demoTimeline, schemaVersion: 2 };
    await expect(serializeProject(initialEditorBlueprint, wrongTimeline, null)).rejects.toThrow(/schema version/);
    valid.featureTimeline = { ...demoTimeline, bassEnvelope: [{ timeMs: 20_000, value: 0.2 }] };
    await expect(parseProjectFile(projectFile(valid))).rejects.toThrow(/Feature Timeline/);
  });

  it('round-trips a 60-second crop with its analysis summary without expanding bytes into argument lists', async () => {
    const durationMs = 60_000;
    const audioBytes = pcmWav(2_646_000);
    const audio = new File([audioBytes.buffer as ArrayBuffer], 'crop.wav', { type: 'audio/wav' });
    const timeline = { ...structuredClone(demoTimeline), durationMs };
    const musicSummary = summary(durationMs, audio.size);
    const blob = await serializeProject(initialEditorBlueprint, timeline, audio, new Date(), musicSummary);
    const restored = await parseProjectFile(new File([blob], 'sixty-seconds.arvproj'));
    expect(restored.featureTimeline.durationMs).toBe(durationMs);
    expect(restored.musicSummary).toEqual(musicSummary);
    const restoredBytes = new Uint8Array(await restored.audioFile!.arrayBuffer());
    expect(restoredBytes).toHaveLength(audioBytes.length);
    expect(restoredBytes[0]).toBe(0x52);
    expect(restoredBytes.at(-1)).toBe(0);
  });

  it('rejects missing audio or mismatched summary metadata instead of restoring incomplete analysis', async () => {
    const audioBytes = pcmWav(2_646_000);
    const audio = new File([audioBytes.buffer as ArrayBuffer], 'crop.wav', { type: 'audio/wav' });
    await expect(serializeProject(initialEditorBlueprint, demoTimeline, null, new Date(), summary(demoTimeline.durationMs, audio.size))).rejects.toThrow(/requires its analyzed audio clip/);
    const blob = await serializeProject(initialEditorBlueprint, { ...demoTimeline, durationMs: 60_000 }, audio);
    const value = JSON.parse(await blob.text()) as Record<string, unknown>;
    const metadata = value.metadata as Record<string, unknown>;
    metadata.musicSummary = summary(59_999, audio.size);
    await expect(parseProjectFile(projectFile(value))).rejects.toThrow(/Music Summary/);
    const brokenWav = new File([new Uint8Array(45)], 'broken.wav', { type: 'audio/wav' });
    await expect(serializeProject(initialEditorBlueprint, { ...demoTimeline, durationMs: 60_000 }, brokenWav, new Date(), summary(60_000, brokenWav.size))).rejects.toThrow(/WAV/);
  });
});
