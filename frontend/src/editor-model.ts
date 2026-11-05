import type { FeaturePoint } from './renderer';

export type RegionGeometry =
  | { kind: 'rect'; x: number; y: number; width: number; height: number }
  | { kind: 'polygon'; points: Array<{ x: number; y: number }> };

export type Region = { id: string; name: string; geometry: RegionGeometry };
export type EffectColorMode = 'global-gradient' | 'custom';
export type GlobalGradient = { startColor: string; middleColor: string; endColor: string; angleDeg: number };
export type BindingSource = 'bass.envelope' | 'kick.events' | 'snare.events' | 'drums.energy' | 'vocals.envelope' | 'other.envelope' | 'music.energy';
export type EventBindingSource = 'kick.events' | 'snare.events';
export type ContinuousBindingSource = Exclude<BindingSource, EventBindingSource>;
export type WaveformPeak = { min: number; max: number };
export type WaveformPeaks = { sampleIntervalMs: 20; windowSamples: 882; normalization: 'signed-full-scale'; music: WaveformPeak[]; drums: WaveformPeak[]; bass: WaveformPeak[]; vocals: WaveformPeak[]; other: WaveformPeak[] };
export type FrequencySpectrum = { hopMs: 20; fftSize: 4096; bandCount: 32; sampleRateHz: number; minHz: number; maxHz: number; normalization: 'whole-clip-p99-log-rms'; encoding: 'uint8-linear-0-255'; values: number[] };
export type RotationSettings = { rotationMode?: 'continuous' | 'triggered'; beatsPerRevolution?: 4 | 8 | 16 | 32; rotationDirection?: 'clockwise' | 'counterclockwise'; initialAngleDeg?: number };
export type EffectDisplaySettings = { visibilityMode?: 'triggered' | 'always'; audioReactive?: boolean };
export type Binding = {
  id: string;
  effectId: string;
  source: BindingSource;
  strength: number;
  threshold: number;
  attackMs: number;
  releaseMs: number;
};

export type Effect = (
  | { id: string; kind: 'pulse-scale'; regionId: string; color: string; colorMode?: EffectColorMode; baseScale: number; maxScale: number }
  | { id: string; kind: 'glow-brightness'; regionId: string; color: string; colorMode?: EffectColorMode; blurPx: number; brightness: number; glowIntensity?: number }
  | { id: string; kind: 'rotation-movement'; regionId: string; color: string; colorMode?: EffectColorMode; rotationDeg: number; moveX: number; moveY: number }
  | { id: string; kind: 'particles'; regionId: string; color: string; colorMode?: EffectColorMode; count: number; sizePx: number; cycleMs: number; spread?: number; speedInfluence?: number; glowIntensity?: number; baselineOpacity?: number }
  | { id: string; kind: 'waveform-bars'; regionId: string; color: string; colorMode?: EffectColorMode; bars: number; lineWidth: number }
  | { id: string; kind: 'waveform-line'; regionId: string; color: string; colorMode?: EffectColorMode; orientation: 'horizontal' | 'vertical'; sampleCount: number; amplitudeScale: number; lineWidth: number; glowIntensity: number }
  | { id: string; kind: 'waveform-peak-bars'; regionId: string; color: string; colorMode?: EffectColorMode; bars: number; barWidth: number; spacing: number; amplitudeScale: number; glowIntensity: number }
  | { id: string; kind: 'spectrum-bars'; regionId: string; color: string; colorMode?: EffectColorMode; barWidth: number; spacing: number; amplitudeScale: number; glowIntensity: number; segmented?: boolean; segmentsPerBar?: number; attackMs?: number; releaseMs?: number }
  | { id: string; kind: 'spectrum-line'; regionId: string; color: string; colorMode?: EffectColorMode; amplitudeScale: number; lineWidth: number; smoothing: number; glowIntensity: number; attackMs?: number; releaseMs?: number }
  | ({ id: string; kind: 'waveform-ring'; regionId: string; color: string; colorMode?: EffectColorMode; radius: number; sampleCount: number; amplitudeScale: number; lineWidth: number; smoothing: number; glowIntensity: number } & RotationSettings)
  | ({ id: string; kind: 'radial-bars'; regionId: string; color: string; colorMode?: EffectColorMode; centerX: number; centerY: number; radius: number; bars: number; barLength: number; lineWidth: number; barWidth?: number; spikeSharpness?: number; innerRadius?: number; amplitudeScale?: number; glowIntensity?: number } & RotationSettings)
  | ({ id: string; kind: 'wave-ring'; regionId: string; color: string; colorMode?: EffectColorMode; centerX: number; centerY: number; radius: number; amplitude: number; points: number; lineWidth: number; sampleCount?: number; amplitudeScale?: number; jaggedness?: number; smoothing?: number; glowIntensity?: number; layerCount?: number; layerRadiusStep?: number; layerAngleOffsetDeg?: number; layerAmplitudeDecay?: number } & RotationSettings)
  | { id: string; kind: 'particle-burst'; regionId: string; color: string; colorMode?: EffectColorMode; originX: number; originY: number; directionDeg: number; spreadDeg: number; speedPxPerSec: number; lifetimeMs: number; count: number; sizePx: number; glowIntensity?: number; opacityBoost?: number; coreBrightness?: number; swirl?: number; audioInfluence?: number; baselineOpacity?: number }
  | { id: string; kind: 'particle-trail'; regionId: string; color: string; colorMode?: EffectColorMode; samples: number; trailMs: number; sizePx: number; amplitude: number; glowIntensity?: number; opacityBoost?: number; lengthScale?: number }
  | { id: string; kind: 'ripple'; regionId: string; color: string; colorMode?: EffectColorMode; centerX: number; centerY: number; waves: number; periodMs: number; radius: number; amplitude: number; lineWidth: number; glowIntensity?: number; opacityBoost?: number }
  | { id: string; kind: 'shockwave'; regionId: string; color: string; colorMode?: EffectColorMode; centerX: number; centerY: number; maxRadius: number; lifetimeMs: number; lineWidth: number; glowIntensity?: number; opacityBoost?: number }
  | { id: string; kind: 'oscilloscope-line'; regionId: string; color: string; colorMode?: EffectColorMode; orientation: 'horizontal' | 'radial'; lineWidth: number; sampleCount: number; amplitudeScale: number; glowIntensity: number }
  | { id: string; kind: 'ink-diffusion'; regionId: string; color: string; colorMode?: EffectColorMode; diffusionSpeed?: number; flowStrength?: number; turbulence?: number; inkDensity?: number; cloudScale?: number; responseTime?: number }
  | { id: string; kind: 'ink-flow'; regionId: string; color: string; colorMode?: EffectColorMode; diffusionSpeed?: number; flowStrength?: number; turbulence?: number; inkDensity?: number; cloudScale?: number; responseTime?: number }
  | { id: string; kind: 'color-mixing'; regionId: string; color: string; colorMode?: EffectColorMode; customPalette?: string[]; diffusionSpeed?: number; flowStrength?: number; turbulence?: number; inkDensity?: number; cloudScale?: number; responseTime?: number }
) & { opacity?: number } & EffectDisplaySettings;

export type Background =
  | { kind: 'solid'; color: string }
  | { kind: 'gradient'; from: string; to: string; angleDeg: number }
  | { kind: 'image'; src: string; fit?: 'contain' | 'cover' | 'stretch' };

export type ImageLayer = { id: string; src: string; x: number; y: number; width: number; height: number; sourceWidth: number; sourceHeight: number; fit: 'contain' | 'cover' | 'stretch'; crop?: { x: number; y: number; width: number; height: number } };

export type EditorBlueprint = {
  version: 1;
  width: number;
  height: number;
  seed: number;
  background: Background;
  imageLayers?: ImageLayer[];
  globalGradient?: GlobalGradient;
  regions: Region[];
  effects: Effect[];
  bindings: Binding[];
};

export type FeatureTimeline = {
  durationMs: number;
  bpm?: number;
  bpmSource?: 'kick-estimated' | 'fallback';
  bassEnvelope: FeaturePoint[];
  kickEvents: number[];
  kickEventStrengths?: number[];
  snareEvents?: number[];
  snareEventStrengths?: number[];
  drumEnergy?: FeaturePoint[];
  vocalsEnvelope?: FeaturePoint[];
  otherEnvelope?: FeaturePoint[];
  musicEnergy?: FeaturePoint[];
  waveformPeaks?: WaveformPeaks;
  frequencySpectrum?: FrequencySpectrum;
};

export const DEFAULT_GLOBAL_GRADIENT: GlobalGradient = {
  startColor: '#22d3ee', middleColor: '#8b5cf6', endColor: '#ec4899', angleDeg: 0,
};

export const demoTimeline: FeatureTimeline = {
  durationMs: 12000,
  bassEnvelope: Array.from({ length: 121 }, (_, index) => {
    const timeMs = index * 100;
    const phrase = (timeMs % 4000) / 4000;
    return { timeMs, value: 0.12 + 0.72 * (0.5 + 0.5 * Math.sin(phrase * Math.PI * 2)) };
  }),
  kickEvents: Array.from({ length: 12 }, (_, index) => index * 1000),
};

export const initialEditorBlueprint: EditorBlueprint = {
  version: 1,
  width: 640,
  height: 360,
  seed: 137,
  background: { kind: 'gradient', from: '#03050b', to: '#121731', angleDeg: 120 },
  globalGradient: { ...DEFAULT_GLOBAL_GRADIENT },
  regions: [
    { id: 'region-stage', name: 'Stage', geometry: { kind: 'rect', x: 0.12, y: 0.14, width: 0.76, height: 0.72 } },
    { id: 'region-accent', name: 'Accent', geometry: { kind: 'polygon', points: [{ x: 0.5, y: 0.18 }, { x: 0.78, y: 0.5 }, { x: 0.5, y: 0.82 }, { x: 0.22, y: 0.5 }] } },
  ],
  effects: [
    { id: 'effect-bars', kind: 'waveform-bars', regionId: 'region-stage', color: '#46edff', bars: 36, lineWidth: 0.5 },
    { id: 'effect-pulse', kind: 'pulse-scale', regionId: 'region-accent', color: '#ff42d0', baseScale: 0.58, maxScale: 1.16 },
    { id: 'effect-oscilloscope-default', kind: 'oscilloscope-line', regionId: 'region-stage', color: '#70f6ff', orientation: 'horizontal', lineWidth: 0.009, sampleCount: 192, amplitudeScale: 0.72, glowIntensity: 1.45 },
    { id: 'effect-radial-default', kind: 'radial-bars', regionId: 'region-accent', color: '#c584ff', centerX: 0.5, centerY: 0.5, radius: 0.24, bars: 52, barLength: 0.2, lineWidth: 0.35, barWidth: 0.4, spikeSharpness: 0.9, innerRadius: 0.13, amplitudeScale: 1.75, glowIntensity: 1.4 },
    { id: 'effect-glow-default', kind: 'glow-brightness', regionId: 'region-stage', color: '#3beaff', blurPx: 30, brightness: 1.35, glowIntensity: 1.35 },
  ],
  bindings: [
    { id: 'binding-bars', effectId: 'effect-bars', source: 'bass.envelope', strength: 0.9, threshold: 0.08, attackMs: 70, releaseMs: 240 },
    { id: 'binding-kick', effectId: 'effect-pulse', source: 'kick.events', strength: 1, threshold: 0.12, attackMs: 12, releaseMs: 420 },
    { id: 'binding-oscilloscope-default', effectId: 'effect-oscilloscope-default', source: 'bass.envelope', strength: 1, threshold: 0.04, attackMs: 24, releaseMs: 100 },
    { id: 'binding-radial-default', effectId: 'effect-radial-default', source: 'bass.envelope', strength: 1, threshold: 0.04, attackMs: 30, releaseMs: 120 },
    { id: 'binding-glow-default', effectId: 'effect-glow-default', source: 'bass.envelope', strength: 1, threshold: 0.02, attackMs: 40, releaseMs: 180 },
  ],
};

export const newEditorBlueprint: EditorBlueprint = {
  ...initialEditorBlueprint,
  regions: structuredClone(initialEditorBlueprint.regions),
  effects: [
    { id: 'effect-spectrum-bars-default', kind: 'spectrum-bars', regionId: 'region-stage', color: '#91e8ff', colorMode: 'global-gradient', opacity: 1, visibilityMode: 'always', audioReactive: true, barWidth: 0.72, spacing: 0.12, amplitudeScale: 1.35, glowIntensity: 1.15, segmented: true, segmentsPerBar: 12, attackMs: 35, releaseMs: 180 },
    { id: 'effect-ink-diffusion-default', kind: 'ink-diffusion', regionId: 'region-stage', color: '#8b5cf6', colorMode: 'global-gradient', opacity: 1, visibilityMode: 'always', audioReactive: true, diffusionSpeed: 0.25, flowStrength: 0.4, turbulence: 0.3, inkDensity: 0.65, cloudScale: 0.5, responseTime: 3 },
    { id: 'effect-shockwave-default', kind: 'shockwave', regionId: 'region-stage', color: '#ff48d6', colorMode: 'global-gradient', opacity: 1, visibilityMode: 'triggered', audioReactive: true, centerX: 0.5, centerY: 0.5, maxRadius: 0.48, lifetimeMs: 1200, lineWidth: 0.026, glowIntensity: 1.7, opacityBoost: 1.6 },
  ],
  bindings: [
    { id: 'binding-effect-spectrum-bars-default', effectId: 'effect-spectrum-bars-default', source: 'music.energy', strength: 0.9, threshold: 0.1, attackMs: 60, releaseMs: 260 },
    { id: 'binding-effect-ink-diffusion-default', effectId: 'effect-ink-diffusion-default', source: 'music.energy', strength: 0.9, threshold: 0.1, attackMs: 60, releaseMs: 260 },
    { id: 'binding-effect-shockwave-default', effectId: 'effect-shockwave-default', source: 'kick.events', strength: 1, threshold: 0, attackMs: 0, releaseMs: 260 },
  ],
};

export function validateBlueprint(blueprint: EditorBlueprint): void {
  const fail = (message: string): never => { throw new Error(`Invalid Blueprint: ${message}`); };
    if (!blueprint || typeof blueprint !== 'object' || !Array.isArray(blueprint.regions) || !Array.isArray(blueprint.effects) || !Array.isArray(blueprint.bindings)) fail('missing collections');
  if (blueprint.version !== 1 || !Number.isInteger(blueprint.width) || !Number.isInteger(blueprint.height) || blueprint.width < 1 || blueprint.height < 1) fail('unsupported version or canvas size');
  if (!Number.isFinite(blueprint.seed)) fail('seed must be finite');
  const validColor = (value: string) => /^#[\da-f]{6}([\da-f]{2})?$/i.test(value);
  const inBounds = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;
  if (!blueprint.background || !['solid', 'gradient', 'image'].includes(blueprint.background.kind)) fail('invalid background');
  if (blueprint.background.kind === 'solid' && !validColor(blueprint.background.color)) fail('invalid background color');
  if (blueprint.background.kind === 'gradient' && (!validColor(blueprint.background.from) || !validColor(blueprint.background.to) || !Number.isFinite(blueprint.background.angleDeg) || blueprint.background.angleDeg < 0 || blueprint.background.angleDeg > 360)) fail('invalid gradient');
  if (blueprint.background.kind === 'image' && (!/^data:image\/(png|jpeg);base64,/i.test(blueprint.background.src) || blueprint.background.src.length > 14_000_000)) fail('invalid image data');
  if (blueprint.imageLayers !== undefined) {
    if (!Array.isArray(blueprint.imageLayers) || blueprint.imageLayers.length > 12) fail('invalid image layers');
    for (const layer of blueprint.imageLayers) {
      if (!layer || !layer.id || !/^data:image\/(png|jpeg);base64,/i.test(layer.src) || layer.src.length > 14_000_000 || ![layer.x, layer.y, layer.width, layer.height, layer.sourceWidth, layer.sourceHeight].every(Number.isFinite) || layer.width <= 0 || layer.height <= 0 || layer.sourceWidth <= 0 || layer.sourceHeight <= 0 || !['contain', 'cover', 'stretch'].includes(layer.fit)) fail('invalid image layer');
      const crop = layer.crop;
      if (crop && (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > layer.sourceWidth || crop.y + crop.height > layer.sourceHeight)) fail('invalid image crop');
    }
  }
  if (blueprint.globalGradient !== undefined) {
    const gradient = blueprint.globalGradient as unknown as Record<string, unknown>;
    if (!gradient || typeof gradient !== 'object' || Object.keys(gradient).some((key) => !['startColor', 'middleColor', 'endColor', 'angleDeg'].includes(key)) || !['startColor', 'middleColor', 'endColor', 'angleDeg'].every((key) => key in gradient) || ![gradient.startColor, gradient.middleColor, gradient.endColor].every((color) => typeof color === 'string' && validColor(color)) || typeof gradient.angleDeg !== 'number' || !Number.isFinite(gradient.angleDeg) || gradient.angleDeg < 0 || gradient.angleDeg > 360) fail('invalid global gradient');
  }
  const ids = new Set<string>();
  for (const region of blueprint.regions) {
    if (!region || typeof region !== 'object' || !region.geometry || !['rect', 'polygon'].includes(region.geometry.kind)) fail('invalid region geometry');
    if (region.geometry.kind === 'polygon' && !Array.isArray(region.geometry.points)) fail(`invalid polygon: ${region.id}`);
    if (typeof region.id !== 'string' || !region.id || typeof region.name !== 'string' || ids.has(region.id)) fail(`duplicate or invalid region id: ${region.id}`);
    ids.add(region.id);
    if (region.geometry.kind === 'rect') {
      const { x, y, width, height } = region.geometry;
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > 1 || y + height > 1) fail(`region out of bounds: ${region.id}`);
    } else if (region.geometry.points.length < 3 || region.geometry.points.length > 64 || !region.geometry.points.every((point) => Boolean(point) && inBounds(point.x) && inBounds(point.y)) || Math.abs(region.geometry.points.reduce((area, point, index, points) => {
      const next = points[(index + 1) % points.length];
      return area + (next ? point.x * next.y - next.x * point.y : 0);
    }, 0)) < 1e-8) {
      fail(`invalid polygon: ${region.id}`);
    }
  }
  const effectIds = new Set<string>();
  for (const effect of blueprint.effects) {
    if (!effect || typeof effect !== 'object') fail('invalid effect');
    if (!['pulse-scale', 'glow-brightness', 'rotation-movement', 'particles', 'waveform-bars', 'waveform-line', 'waveform-peak-bars', 'waveform-ring', 'spectrum-bars', 'spectrum-line', 'radial-bars', 'wave-ring', 'particle-burst', 'particle-trail', 'ripple', 'shockwave', 'oscilloscope-line', 'ink-diffusion', 'ink-flow', 'color-mixing'].includes(effect.kind)) fail(`unsupported effect: ${effect.id}`);
    if (typeof effect.id !== 'string' || !effect.id || effectIds.has(effect.id)) fail(`duplicate or invalid effect id: ${effect.id}`);
    if (effect.colorMode !== undefined && effect.colorMode !== 'global-gradient' && effect.colorMode !== 'custom') fail(`invalid effect color mode: ${effect.id}`);
    effectIds.add(effect.id);
    if (effect.kind === 'particles' || effect.kind === 'waveform-line' || effect.kind === 'waveform-peak-bars' || effect.kind === 'waveform-ring' || effect.kind === 'spectrum-bars' || effect.kind === 'spectrum-line' || effect.kind === 'particle-burst' || effect.kind === 'particle-trail' || effect.kind === 'ripple' || effect.kind === 'shockwave' || effect.kind === 'oscilloscope-line' || effect.kind === 'radial-bars' || effect.kind === 'wave-ring' || effect.kind === 'ink-diffusion' || effect.kind === 'ink-flow' || effect.kind === 'color-mixing') {
      const fields = effect.kind === 'particles'
        ? ['id', 'kind', 'regionId', 'color', 'count', 'sizePx', 'cycleMs']
        : ['ink-diffusion', 'ink-flow', 'color-mixing'].includes(effect.kind)
          ? ['id', 'kind', 'regionId', 'color']
        : effect.kind === 'waveform-line'
        ? ['id', 'kind', 'regionId', 'color', 'orientation', 'sampleCount', 'amplitudeScale', 'lineWidth', 'glowIntensity']
        : effect.kind === 'waveform-peak-bars'
          ? ['id', 'kind', 'regionId', 'color', 'bars', 'barWidth', 'spacing', 'amplitudeScale', 'glowIntensity']
        : effect.kind === 'spectrum-bars'
          ? ['id', 'kind', 'regionId', 'color', 'barWidth', 'spacing', 'amplitudeScale', 'glowIntensity']
          : effect.kind === 'spectrum-line'
            ? ['id', 'kind', 'regionId', 'color', 'amplitudeScale', 'lineWidth', 'smoothing', 'glowIntensity']
        : effect.kind === 'waveform-ring'
            ? ['id', 'kind', 'regionId', 'color', 'radius', 'sampleCount', 'amplitudeScale', 'lineWidth', 'smoothing', 'glowIntensity']
            : effect.kind === 'particle-burst'
        ? ['id', 'kind', 'regionId', 'color', 'originX', 'originY', 'directionDeg', 'spreadDeg', 'speedPxPerSec', 'lifetimeMs', 'count', 'sizePx']
        : effect.kind === 'particle-trail'
          ? ['id', 'kind', 'regionId', 'color', 'samples', 'trailMs', 'sizePx', 'amplitude']
            : effect.kind === 'ripple'
            ? ['id', 'kind', 'regionId', 'color', 'centerX', 'centerY', 'waves', 'periodMs', 'radius', 'amplitude', 'lineWidth']
            : effect.kind === 'shockwave'
              ? ['id', 'kind', 'regionId', 'color', 'centerX', 'centerY', 'maxRadius', 'lifetimeMs', 'lineWidth']
              : effect.kind === 'oscilloscope-line'
                ? ['id', 'kind', 'regionId', 'color', 'orientation', 'lineWidth', 'sampleCount', 'amplitudeScale', 'glowIntensity']
                : effect.kind === 'radial-bars'
                  ? ['id', 'kind', 'regionId', 'color', 'centerX', 'centerY', 'radius', 'bars', 'barLength', 'lineWidth']
                  : ['id', 'kind', 'regionId', 'color', 'centerX', 'centerY', 'radius', 'amplitude', 'points', 'lineWidth'];
      const optionalFields: Record<string, string[]> = {
        particles: ['colorMode', 'spread', 'speedInfluence', 'glowIntensity', 'baselineOpacity'],
        'particle-burst': ['colorMode', 'glowIntensity', 'opacityBoost', 'coreBrightness', 'swirl', 'audioInfluence', 'baselineOpacity'], 'particle-trail': ['colorMode', 'glowIntensity', 'opacityBoost', 'lengthScale'],
        ripple: ['colorMode', 'glowIntensity', 'opacityBoost'], shockwave: ['colorMode', 'glowIntensity', 'opacityBoost'],
        'radial-bars': ['colorMode', 'barWidth', 'spikeSharpness', 'innerRadius', 'amplitudeScale', 'glowIntensity', 'rotationMode', 'beatsPerRevolution', 'rotationDirection', 'initialAngleDeg'],
        'wave-ring': ['colorMode', 'sampleCount', 'amplitudeScale', 'jaggedness', 'smoothing', 'glowIntensity', 'rotationMode', 'beatsPerRevolution', 'rotationDirection', 'initialAngleDeg', 'layerCount', 'layerRadiusStep', 'layerAngleOffsetDeg', 'layerAmplitudeDecay'],
        'waveform-line': ['colorMode'], 'waveform-peak-bars': ['colorMode'], 'waveform-ring': ['colorMode', 'rotationMode', 'beatsPerRevolution', 'rotationDirection', 'initialAngleDeg'],
        'spectrum-bars': ['colorMode', 'segmented', 'segmentsPerBar', 'attackMs', 'releaseMs'], 'spectrum-line': ['colorMode', 'attackMs', 'releaseMs'],
        'oscilloscope-line': ['colorMode'],
        'ink-diffusion': ['colorMode', 'diffusionSpeed', 'flowStrength', 'turbulence', 'inkDensity', 'cloudScale', 'responseTime'],
        'ink-flow': ['colorMode', 'diffusionSpeed', 'flowStrength', 'turbulence', 'inkDensity', 'cloudScale', 'responseTime'],
        'color-mixing': ['colorMode', 'customPalette', 'diffusionSpeed', 'flowStrength', 'turbulence', 'inkDensity', 'cloudScale', 'responseTime'],
      };
      const allowed = [...fields, 'opacity', 'visibilityMode', 'audioReactive', ...(optionalFields[effect.kind] ?? [])];
      if (Object.keys(effect).some((key) => !allowed.includes(key)) || fields.some((key) => !(key in effect))) fail(`unexpected ${effect.kind} parameter: ${effect.id}`);
    }
    if (!blueprint.regions.some((region) => region.id === effect.regionId)) fail(`missing region: ${effect.regionId}`);
    if (!validColor(effect.color)) fail(`invalid effect color: ${effect.id}`);
    if ('opacity' in effect && (typeof effect.opacity !== 'number' || !Number.isFinite(effect.opacity) || effect.opacity < 0 || effect.opacity > 1)) fail(`invalid effect opacity: ${effect.id}`);
    if (effect.visibilityMode !== undefined && effect.visibilityMode !== 'triggered' && effect.visibilityMode !== 'always') fail(`invalid visibility mode: ${effect.id}`);
    if (effect.audioReactive !== undefined && typeof effect.audioReactive !== 'boolean') fail(`invalid audio reactive setting: ${effect.id}`);
    if (effect.audioReactive === false && effect.visibilityMode !== 'always') fail(`non-reactive effects must use always visibility: ${effect.id}`);
    const numericValues = Object.entries(effect).filter(([, value]) => typeof value === 'number').map(([, value]) => value as number);
    if (!numericValues.every(Number.isFinite)) fail(`non-finite effect parameter: ${effect.id}`);
    if (effect.kind === 'pulse-scale' && (effect.baseScale < 0 || effect.maxScale < effect.baseScale || effect.maxScale > 4)) fail(`invalid scale: ${effect.id}`);
    if (effect.kind === 'particles' && (!Number.isInteger(effect.count) || effect.count < 1 || effect.count > 64 || effect.sizePx <= 0 || effect.cycleMs < 100)) fail(`invalid particles: ${effect.id}`);
    if (effect.kind === 'waveform-bars' && (!Number.isInteger(effect.bars) || effect.bars < 2 || effect.bars > 128 || effect.lineWidth <= 0 || effect.lineWidth > 1)) fail(`invalid bars: ${effect.id}`);
    if (effect.kind === 'waveform-line' && (!['horizontal', 'vertical'].includes(effect.orientation) || !Number.isInteger(effect.sampleCount) || effect.sampleCount < 16 || effect.sampleCount > 512 || effect.amplitudeScale < 0.1 || effect.amplitudeScale > 2 || effect.lineWidth < 0.001 || effect.lineWidth > 0.05 || effect.glowIntensity < 0 || effect.glowIntensity > 2)) fail(`invalid waveform line: ${effect.id}`);
    if (effect.kind === 'waveform-peak-bars' && (!Number.isInteger(effect.bars) || effect.bars < 2 || effect.bars > 256 || effect.barWidth < 0.1 || effect.barWidth > 1 || effect.spacing < 0 || effect.spacing > 0.5 || effect.amplitudeScale < 0.1 || effect.amplitudeScale > 2 || effect.glowIntensity < 0 || effect.glowIntensity > 2)) fail(`invalid waveform peak bars: ${effect.id}`);
    if (effect.kind === 'waveform-ring' && (effect.radius < 0.05 || effect.radius > 0.45 || !Number.isInteger(effect.sampleCount) || effect.sampleCount < 16 || effect.sampleCount > 512 || effect.amplitudeScale < 0.1 || effect.amplitudeScale > 2 || effect.lineWidth < 0.001 || effect.lineWidth > 0.05 || effect.smoothing < 0 || effect.smoothing > 1 || effect.glowIntensity < 0 || effect.glowIntensity > 2)) fail(`invalid waveform ring: ${effect.id}`);
    const optionalRange = (key: string, min: number, max: number) => key in effect && (typeof (effect as unknown as Record<string, unknown>)[key] !== 'number' || !Number.isFinite((effect as unknown as Record<string, number>)[key]) || (effect as unknown as Record<string, number>)[key]! < min || (effect as unknown as Record<string, number>)[key]! > max);
    if (effect.kind === 'particles' && (optionalRange('spread', 0.1, 1) || optionalRange('speedInfluence', 0, 2) || optionalRange('glowIntensity', 0, 2) || optionalRange('baselineOpacity', 0, 0.35))) fail(`invalid particle settings: ${effect.id}`);
    if (['ink-diffusion', 'ink-flow', 'color-mixing'].includes(effect.kind) && (optionalRange('diffusionSpeed', 0, 2) || optionalRange('flowStrength', 0, 2) || optionalRange('turbulence', 0, 2) || optionalRange('inkDensity', 0, 1) || optionalRange('cloudScale', 0.1, 2) || optionalRange('responseTime', 0.5, 10))) fail(`${effect.kind === 'ink-diffusion' ? 'invalid ink diffusion settings' : 'invalid ink settings'}: ${effect.id}`);
    if ('customPalette' in effect && (effect.kind !== 'color-mixing' || !Array.isArray(effect.customPalette) || effect.customPalette.length < 2 || effect.customPalette.length > 4 || !effect.customPalette.every((color) => typeof color === 'string' && /^#[\da-f]{6}$/i.test(color)))) fail(`invalid Color Mixing custom palette: ${effect.id}`);
    if (effect.kind === 'spectrum-bars' && (effect.barWidth < 0.2 || effect.barWidth > 1 || effect.spacing < 0 || effect.spacing > 0.5 || effect.amplitudeScale < 0.1 || effect.amplitudeScale > 3 || effect.glowIntensity < 0 || effect.glowIntensity > 2 || (effect.segmented !== undefined && typeof effect.segmented !== 'boolean') || optionalRange('segmentsPerBar', 1, 24) || (effect.segmentsPerBar !== undefined && !Number.isInteger(effect.segmentsPerBar)) || optionalRange('attackMs', 0, 1000) || optionalRange('releaseMs', 0, 3000))) fail(`invalid spectrum bars: ${effect.id}`);
    if (effect.kind === 'spectrum-line' && (effect.amplitudeScale < 0.1 || effect.amplitudeScale > 3 || effect.lineWidth < 0.001 || effect.lineWidth > 0.05 || effect.smoothing < 0 || effect.smoothing > 1 || effect.glowIntensity < 0 || effect.glowIntensity > 2 || optionalRange('attackMs', 0, 1000) || optionalRange('releaseMs', 0, 3000))) fail(`invalid spectrum line: ${effect.id}`);
    if (effect.kind === 'radial-bars' && (!Number.isFinite(effect.centerX) || effect.centerX < 0 || effect.centerX > 1 || !Number.isFinite(effect.centerY) || effect.centerY < 0 || effect.centerY > 1 || effect.radius < 0.05 || effect.radius > 0.45 || !Number.isInteger(effect.bars) || effect.bars < 8 || effect.bars > 128 || effect.barLength < 0.02 || effect.barLength > 0.3 || effect.lineWidth < 0.05 || effect.lineWidth > 1 || optionalRange('barWidth', 0.05, 1) || optionalRange('spikeSharpness', 0, 1) || optionalRange('innerRadius', 0.02, effect.radius) || optionalRange('amplitudeScale', 0.1, 3) || optionalRange('glowIntensity', 0, 2))) fail(`invalid radial bars: ${effect.id}`);
    if (effect.kind === 'wave-ring' && (!Number.isFinite(effect.centerX) || effect.centerX < 0 || effect.centerX > 1 || !Number.isFinite(effect.centerY) || effect.centerY < 0 || effect.centerY > 1 || effect.radius < 0.05 || effect.radius > 0.45 || effect.amplitude < 0 || effect.amplitude > 0.2 || !Number.isInteger(effect.points) || effect.points < 16 || effect.points > 128 || effect.lineWidth < 0.003 || effect.lineWidth > 0.05 || ('sampleCount' in effect && (!Number.isInteger(effect.sampleCount) || effect.sampleCount! < 24 || effect.sampleCount! > 256)) || optionalRange('amplitudeScale', 0.1, 4) || optionalRange('jaggedness', 0, 1) || optionalRange('smoothing', 0, 1) || optionalRange('glowIntensity', 0, 2) || optionalRange('layerCount', 1, 10) || ('layerCount' in effect && !Number.isInteger(effect.layerCount)) || optionalRange('layerRadiusStep', 0, 0.1) || optionalRange('layerAngleOffsetDeg', 0, 360) || optionalRange('layerAmplitudeDecay', 0.5, 1))) fail(`invalid wave ring: ${effect.id}`);
    if (effect.kind === 'particle-burst' && (![effect.originX, effect.originY].every(inBounds) || Math.abs(effect.directionDeg) > 360 || effect.spreadDeg < 0 || effect.spreadDeg > 360 || effect.speedPxPerSec < 0 || effect.speedPxPerSec > 1000 || effect.lifetimeMs < 100 || effect.lifetimeMs > 5000 || !Number.isInteger(effect.count) || effect.count < 1 || effect.count > 64 || effect.sizePx < 1 || effect.sizePx > 32 || optionalRange('glowIntensity', 0, 2) || optionalRange('opacityBoost', 0.5, 2) || optionalRange('coreBrightness', 0, 2) || optionalRange('swirl', -2, 2) || optionalRange('audioInfluence', 0, 2) || optionalRange('baselineOpacity', 0, 0.35))) fail(`invalid particle burst: ${effect.id}`);
    if (effect.kind === 'particle-trail' && (!Number.isInteger(effect.samples) || effect.samples < 8 || effect.samples > 128 || effect.trailMs < 100 || effect.trailMs > 5000 || effect.sizePx < 1 || effect.sizePx > 32 || effect.amplitude < 0 || effect.amplitude > 0.5 || optionalRange('glowIntensity', 0, 2) || optionalRange('opacityBoost', 0.5, 2) || optionalRange('lengthScale', 0.25, 1.5))) fail(`invalid particle trail: ${effect.id}`);
    if (effect.kind === 'ripple' && (![effect.centerX, effect.centerY].every(inBounds) || !Number.isInteger(effect.waves) || effect.waves < 1 || effect.waves > 6 || effect.periodMs < 250 || effect.periodMs > 4000 || effect.radius < 0.05 || effect.radius > 0.45 || effect.amplitude < 0 || effect.amplitude > 0.2 || effect.lineWidth < 0.003 || effect.lineWidth > 0.05 || optionalRange('glowIntensity', 0, 2) || optionalRange('opacityBoost', 0.5, 2))) fail(`invalid ripple: ${effect.id}`);
    if (effect.kind === 'shockwave' && (![effect.centerX, effect.centerY].every(inBounds) || effect.maxRadius < 0.05 || effect.maxRadius > 0.5 || effect.lifetimeMs < 100 || effect.lifetimeMs > 5000 || effect.lineWidth < 0.003 || effect.lineWidth > 0.05 || optionalRange('glowIntensity', 0, 2) || optionalRange('opacityBoost', 0.5, 2))) fail(`invalid shockwave: ${effect.id}`);
    if (effect.kind === 'oscilloscope-line' && (!['horizontal', 'radial'].includes(effect.orientation) || effect.lineWidth < 0.001 || effect.lineWidth > 0.05 || !Number.isInteger(effect.sampleCount) || effect.sampleCount < 32 || effect.sampleCount > 512 || effect.amplitudeScale < 0.1 || effect.amplitudeScale > 1 || effect.glowIntensity < 0 || effect.glowIntensity > 2)) fail(`invalid oscilloscope line: ${effect.id}`);
    if (effect.kind === 'glow-brightness' && (effect.blurPx < 0 || effect.blurPx > 100 || effect.brightness < 0 || effect.brightness > 3 || (effect.glowIntensity !== undefined && (effect.glowIntensity < 0 || effect.glowIntensity > 2)))) fail(`invalid glow: ${effect.id}`);
    if (effect.kind === 'rotation-movement' && (Math.abs(effect.rotationDeg) > 360 || Math.abs(effect.moveX) > 1 || Math.abs(effect.moveY) > 1)) fail(`invalid movement: ${effect.id}`);
    if (effect.kind === 'radial-bars' || effect.kind === 'wave-ring' || effect.kind === 'waveform-ring') {
      const settings = ['rotationMode', 'beatsPerRevolution', 'rotationDirection', 'initialAngleDeg'] as const;
      const present = settings.filter((key) => key in effect).length;
      if (present !== 0 && present !== settings.length) fail(`incomplete rotation settings: ${effect.id}`);
      if (present && (!['continuous', 'triggered'].includes(effect.rotationMode!) || ![4, 8, 16, 32].includes(effect.beatsPerRevolution!) || !['clockwise', 'counterclockwise'].includes(effect.rotationDirection!) || !Number.isFinite(effect.initialAngleDeg) || Math.abs(effect.initialAngleDeg!) > 360)) fail(`invalid rotation settings: ${effect.id}`);
    }
  }
  const bindingIds = new Set<string>();
  const boundEffects = new Set<string>();
  for (const binding of blueprint.bindings) {
    if (!binding || typeof binding !== 'object') fail('invalid binding');
    if (typeof binding.id !== 'string' || !binding.id || bindingIds.has(binding.id)) fail(`duplicate or invalid binding id: ${binding.id}`);
    bindingIds.add(binding.id);
    if (!effectIds.has(binding.effectId)) fail(`missing effect: ${binding.effectId}`);
    if (!['bass.envelope', 'kick.events', 'snare.events', 'drums.energy', 'vocals.envelope', 'other.envelope', 'music.energy'].includes(binding.source)) fail(`unsupported feature source: ${binding.source}`);
    if (boundEffects.has(binding.effectId)) fail(`multiple bindings for effect: ${binding.effectId}`);
    boundEffects.add(binding.effectId);
    if (![binding.strength, binding.threshold].every(Number.isFinite) || binding.strength < 0 || binding.strength > 1 || binding.threshold < 0 || binding.threshold > 1) fail(`invalid binding range: ${binding.id}`);
    if (![binding.attackMs, binding.releaseMs].every(Number.isFinite) || binding.attackMs < 0 || binding.releaseMs < 0 || binding.attackMs > 5000 || binding.releaseMs > 10000) fail(`invalid binding timing: ${binding.id}`);
  }
  if (boundEffects.size !== effectIds.size) fail('every effect must have exactly one binding');
}

export function normalizeBlueprintForSave(blueprint: EditorBlueprint): EditorBlueprint {
  const normalized = structuredClone(blueprint);
  for (const effect of normalized.effects) {
    if (effect.kind === 'particles') {
      effect.visibilityMode = 'triggered';
      effect.audioReactive = true;
    }
  }
  return normalized;
}
