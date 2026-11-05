export type FeaturePoint = {
  timeMs: number;
  value: number;
};

export type FixedBlueprint = {
  width: number;
  height: number;
  background: string;
  layer: {
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
    feature: string;
    minOpacity: number;
    maxOpacity: number;
  };
};

export type DrawCommand = {
  kind: 'fill-rect';
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  opacity: number;
};

import { validateBlueprint } from './editor-model';
import { DEFAULT_GLOBAL_GRADIENT } from './editor-model';
import type { Binding, EditorBlueprint, Effect, FeatureTimeline, GlobalGradient, RegionGeometry, WaveformPeak } from './editor-model';
import { renderInkDiffusion } from './ink-webgl';
import type { InkRenderPayload } from './ink-webgl';

export type EditorDrawCommand = {
  kind: 'rect' | 'circle' | 'path' | 'ink-diffusion' | 'ink-flow' | 'color-mixing';
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  colorGradient?: GlobalGradient;
  opacity: number;
  region: RegionGeometry;
  rotationRad?: number;
  scale?: number;
  moveX?: number;
  moveY?: number;
  shadowBlur?: number;
  pathPoints?: Array<{ x: number; y: number }>;
  lineWidth?: number;
  closed?: boolean;
  fillPath?: boolean;
  smoothness?: number;
  strokeOnly?: boolean;
  inkPayload?: InkRenderPayload;
  fallbackCommands?: EditorDrawCommand[];
};

export type RenderAssets = Record<string, CanvasImageSource>;

export const demoBlueprint: FixedBlueprint = {
  width: 640,
  height: 360,
  background: '#10131c',
  layer: {
    x: 120,
    y: 90,
    width: 400,
    height: 180,
    color: '#9b8cff',
    feature: 'bass.rms',
    minOpacity: 0.15,
    maxOpacity: 0.9,
  },
};

export const demoFeatures: Record<string, FeaturePoint[]> = {
  'bass.rms': [
    { timeMs: 0, value: 0.2 },
    { timeMs: 1000, value: 0.85 },
    { timeMs: 2000, value: 0.4 },
  ],
};

function sampleFeature(points: FeaturePoint[], timeMs: number): number {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return 0;
  if (timeMs <= first.timeMs) return first.value;

  for (let index = 1; index < points.length; index += 1) {
    const right = points[index];
    const left = points[index - 1];
    if (!right || !left) continue;
    if (timeMs <= right.timeMs) {
      const span = right.timeMs - left.timeMs;
      if (span <= 0) return right.value;
      const progress = (timeMs - left.timeMs) / span;
      return left.value + (right.value - left.value) * progress;
    }
  }

  return last.value;
}

export function evaluateFrame(
  blueprint: FixedBlueprint,
  features: Record<string, FeaturePoint[]>,
  timeMs: number,
): DrawCommand[] {
  const points = features[blueprint.layer.feature] ?? [];
  const value = Math.min(1, Math.max(0, sampleFeature(points, timeMs)));
  const opacity = blueprint.layer.minOpacity +
    value * (blueprint.layer.maxOpacity - blueprint.layer.minOpacity);

  return [{
    kind: 'fill-rect',
    x: blueprint.layer.x,
    y: blueprint.layer.y,
    width: blueprint.layer.width,
    height: blueprint.layer.height,
    color: blueprint.layer.color,
    opacity,
  }];
}

export function renderFrame(
  context: CanvasRenderingContext2D,
  blueprint: FixedBlueprint,
  features: Record<string, FeaturePoint[]>,
  timeMs: number,
): void {
  context.clearRect(0, 0, blueprint.width, blueprint.height);
  context.fillStyle = blueprint.background;
  context.fillRect(0, 0, blueprint.width, blueprint.height);

  for (const command of evaluateFrame(blueprint, features, timeMs)) {
    context.globalAlpha = command.opacity;
    context.fillStyle = command.color;
    context.fillRect(command.x, command.y, command.width, command.height);
  }
  context.globalAlpha = 1;
}

function interpolate(points: FeaturePoint[], timeMs: number): number {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return 0;
  if (timeMs <= first.timeMs) return first.value;
  let low = 1;
  let high = points.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const right = points[middle];
    if (!right) break;
    if (timeMs <= right.timeMs) high = middle - 1;
    else low = middle + 1;
  }
  const left = points[Math.max(0, high)];
  const right = points[Math.min(points.length - 1, low)];
  if (left && right) {
    const span = right.timeMs - left.timeMs;
    return span <= 0 ? right.value : left.value + (right.value - left.value) * ((timeMs - left.timeMs) / span);
  }
  return last.value;
}

function continuousPoints(source: Binding['source'], timeline: FeatureTimeline): FeaturePoint[] | undefined {
  const continuous: Partial<Record<Binding['source'], FeaturePoint[] | undefined>> = {
    'bass.envelope': timeline.bassEnvelope, 'drums.energy': timeline.drumEnergy,
    'vocals.envelope': timeline.vocalsEnvelope, 'other.envelope': timeline.otherEnvelope,
    'music.energy': timeline.musicEnergy,
  };
  return continuous[source];
}

function baseEvents(source: Binding['source'], timeline: FeatureTimeline): { times: number[]; strengths: number[] } | null {
  if (source === 'kick.events') return { times: timeline.kickEvents, strengths: timeline.kickEventStrengths ?? timeline.kickEvents.map(() => 1) };
  if (source === 'snare.events') return timeline.snareEvents && timeline.snareEventStrengths ? { times: timeline.snareEvents, strengths: timeline.snareEventStrengths } : { times: [], strengths: [] };
  return null;
}

function eventSource(binding: Binding, timeline: FeatureTimeline, timeMs: number, lookbackMs: number): { times: number[]; strengths: number[] } {
  const existing = baseEvents(binding.source, timeline);
  if (existing) return existing;
  const points = continuousPoints(binding.source, timeline);
  if (!points?.length) return { times: [], strengths: [] };
  const times: number[] = [];
  const strengths: number[] = [];
  const startTime = Math.max(0, timeMs - lookbackMs);
  let low = 0;
  let high = points.length;
  while (low < high) { const middle = (low + high) >>> 1; if (points[middle]!.timeMs < startTime - 120) low = middle + 1; else high = middle; }
  const first = Math.max(0, low - 1);
  let previous = points[first]!;
  let lastAccepted = previous.value > binding.threshold ? previous.timeMs : -Infinity;
  if (first === 0 && previous.value > binding.threshold && previous.timeMs >= startTime && previous.timeMs <= timeMs) { times.push(previous.timeMs); strengths.push(previous.value); }
  for (let index = first + 1; index < points.length; index += 1) {
    const current = points[index]!;
    if (current.timeMs > timeMs) break;
    if (previous.value <= binding.threshold && current.value > binding.threshold) {
      const fraction = (binding.threshold - previous.value) / (current.value - previous.value);
      const crossing = previous.timeMs + (current.timeMs - previous.timeMs) * fraction;
      if (crossing - lastAccepted >= 120) {
        lastAccepted = crossing;
        if (crossing >= startTime) { times.push(crossing); strengths.push(current.value); }
      }
    }
    previous = current;
  }
  return { times, strengths };
}

function rawSourceValue(binding: Binding, timeline: FeatureTimeline, timeMs: number): number {
  const points = continuousPoints(binding.source, timeline);
  if (points !== undefined) return points.length ? interpolate(points, timeMs) : 0;
  const events = baseEvents(binding.source, timeline);
  if (!events) return 0;
  const decayMs = Math.max(60, binding.releaseMs || 120);
  let value = 0;
  let low = 0;
  let high = events.times.length;
  while (low < high) { const middle = (low + high) >>> 1; if (events.times[middle]! <= timeMs) low = middle + 1; else high = middle; }
  for (let index = low - 1; index >= 0; index -= 1) {
    const eventTime = events.times[index]!;
    const age = timeMs - eventTime;
    if (age > decayMs * 6) break;
    value = Math.max(value, events.strengths[index]! * Math.exp(-age / decayMs));
  }
  return value;
}

type BindingIntegral = { follower: Float64Array; integral: Float64Array };
const bindingIntegralCache = new WeakMap<FeatureTimeline, Map<string, BindingIntegral>>();

function integratedBindingSignal(binding: Binding, timeline: FeatureTimeline, timeMs: number): number {
  const stepMs = 20;
  const end = Math.max(0, Math.min(timeMs, timeline.durationMs));
  const steps = Math.floor(timeline.durationMs / stepMs);
  let cache = bindingIntegralCache.get(timeline);
  if (!cache) { cache = new Map(); bindingIntegralCache.set(timeline, cache); }
  const key = `${binding.source}|${binding.threshold}|${binding.attackMs}|${binding.releaseMs}|${binding.strength}`;
  let table = cache.get(key);
  if (!table) {
    const follower = new Float64Array(steps + 1);
    const integral = new Float64Array(steps + 1);
    for (let index = 1; index <= steps; index += 1) {
      const previous = follower[index - 1]!;
      const target = rawSourceValue(binding, timeline, index * stepMs);
      const thresholded = target <= binding.threshold ? 0 : (target - binding.threshold) / (1 - binding.threshold || 1);
      const tau = thresholded > previous ? binding.attackMs : binding.releaseMs;
      const next = tau === 0 ? thresholded : previous + (thresholded - previous) * (1 - Math.exp(-stepMs / tau));
      follower[index] = next;
      integral[index] = integral[index - 1]! + (previous + next) * 0.5 * stepMs * binding.strength;
    }
    table = { follower, integral };
    // Bound per-Timeline parameter variants; source arrays themselves remain weakly held.
    if (cache.size >= 32) cache.delete(cache.keys().next().value as string);
    cache.set(key, table);
  }
  const whole = Math.floor(end / stepMs);
  let result = table.integral[Math.min(whole, steps)] ?? 0;
  const remainder = end - whole * stepMs;
  if (remainder > 0 && whole < steps) {
    const previous = table.follower[whole]!;
    const target = rawSourceValue(binding, timeline, end);
    const thresholded = target <= binding.threshold ? 0 : (target - binding.threshold) / (1 - binding.threshold || 1);
    const tau = thresholded > previous ? binding.attackMs : binding.releaseMs;
    const next = tau === 0 ? thresholded : previous + (thresholded - previous) * (1 - Math.exp(-remainder / tau));
    result += (previous + next) * 0.5 * remainder * binding.strength;
  }
  return result / 1000;
}

function circularRotation(effect: Effect, binding: Binding, timeline: FeatureTimeline, timeMs: number): number {
  if (!('rotationMode' in effect) || effect.rotationMode === undefined) return 0;
  const beats = effect.beatsPerRevolution ?? 8;
  const direction = effect.rotationDirection === 'counterclockwise' ? -1 : 1;
  const initial = effect.initialAngleDeg ?? 0;
  const bpm = timeline.bpm ?? 120;
  const degreesPerSecond = bpm * 360 / (60 * beats);
  const progressSeconds = effect.rotationMode === 'continuous'
    ? timeMs / 1000
    : integratedBindingSignal(binding, timeline, timeMs);
  return (initial + direction * degreesPerSecond * progressSeconds) * Math.PI / 180;
}

export function evaluateBinding(
  binding: EditorBlueprint['bindings'][number] | undefined,
  timeline: FeatureTimeline,
  timeMs: number,
): number {
  if (!binding) return 0;
  const end = Math.min(Math.max(timeMs, 0), timeline.durationMs);
  const stepMs = 20;
  let value = 0;
  let previousTime = 0;
  const follow = (target: number, dt: number) => {
    const thresholded = target <= binding.threshold ? 0 : (target - binding.threshold) / (1 - binding.threshold || 1);
    const tau = thresholded > value ? binding.attackMs : binding.releaseMs;
    if (tau === 0) value = thresholded;
    else value += (thresholded - value) * (1 - Math.exp(-dt / tau));
  };
  for (let current = stepMs; current <= end; current += stepMs) {
    follow(rawSourceValue(binding, timeline, current), current - previousTime);
    previousTime = current;
  }
  if (end > previousTime) follow(rawSourceValue(binding, timeline, end), end - previousTime);
  return Math.min(1, Math.max(0, value * binding.strength));
}

function normalizedBounds(region: RegionGeometry): { x: number; y: number; width: number; height: number } {
  if (region.kind === 'rect') return region;
  const xs = region.points.map((point) => point.x);
  const ys = region.points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function deterministicUnit(seed: number): number {
  let value = seed >>> 0;
  value = (value * 1664525 + 1013904223) >>> 0;
  return value / 4294967296;
}

function stableHash(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0;
  return hash;
}

function boundFeature(value: number, binding: Binding): number {
  if (!Number.isFinite(value) || value <= binding.threshold) return 0;
  return Math.min(1, ((value - binding.threshold) / (1 - binding.threshold || 1)) * binding.strength);
}

const inkResponseCache = new WeakMap<FeatureTimeline, Map<string, Float64Array>>();

function inkSourceAvailable(source: Binding['source'], timeline: FeatureTimeline): boolean {
  if (source === 'bass.envelope') return true;
  if (source === 'kick.events') return true;
  if (source === 'snare.events') return Boolean(timeline.snareEvents && timeline.snareEventStrengths);
  if (source === 'drums.energy') return Boolean(timeline.drumEnergy);
  if (source === 'vocals.envelope') return Boolean(timeline.vocalsEnvelope);
  if (source === 'other.envelope') return Boolean(timeline.otherEnvelope);
  return Boolean(timeline.musicEnergy);
}

// A deterministic two-stage follower: first the normal Binding attack/release,
// then the slower Ink response. Its time table is derived only from the Timeline.
function smoothedInkResponse(binding: Binding, timeline: FeatureTimeline, timeMs: number, responseTimeSeconds: number): number {
  let cache = inkResponseCache.get(timeline);
  if (!cache) { cache = new Map(); inkResponseCache.set(timeline, cache); }
  const key = `${binding.source}|${binding.threshold}|${binding.attackMs}|${binding.releaseMs}|${binding.strength}|${responseTimeSeconds}`;
  let values = cache.get(key);
  if (!values) {
    const stepMs = 20;
    const count = Math.ceil(timeline.durationMs / stepMs);
    values = new Float64Array(count + 1);
    let bindingFollower = 0;
    let response = 0;
    for (let index = 1; index <= count; index += 1) {
      const currentTime = Math.min(timeline.durationMs, index * stepMs);
      const dt = currentTime - Math.min(timeline.durationMs, (index - 1) * stepMs);
      const raw = rawSourceValue(binding, timeline, currentTime);
      const target = raw <= binding.threshold ? 0 : Math.min(1, ((raw - binding.threshold) / (1 - binding.threshold || 1)) * binding.strength);
      const attackOrRelease = target > bindingFollower ? binding.attackMs : binding.releaseMs;
      bindingFollower = attackOrRelease === 0 ? target : bindingFollower + (target - bindingFollower) * (1 - Math.exp(-dt / attackOrRelease));
      const tau = responseTimeSeconds * 1000;
      response += (bindingFollower - response) * (1 - Math.exp(-dt / tau));
      values[index] = response;
    }
    if (cache.size >= 16) cache.delete(cache.keys().next().value as string);
    cache.set(key, values);
  }
  const position = Math.max(0, Math.min(timeline.durationMs, timeMs)) / 20;
  const left = Math.floor(position);
  const fraction = position - left;
  return (values[left] ?? 0) + ((values[Math.min(values.length - 1, left + 1)] ?? 0) - (values[left] ?? 0)) * fraction;
}

function waveformPeaksFor(source: Binding['source'], timeline: FeatureTimeline): WaveformPeak[] | undefined {
  if (!timeline.waveformPeaks) return undefined;
  if (source === 'kick.events') return timeline.kickEvents ? timeline.waveformPeaks.drums : undefined;
  if (source === 'snare.events') return timeline.snareEvents && timeline.snareEventStrengths ? timeline.waveformPeaks.drums : undefined;
  const sourceKey = source.split('.')[0] as 'bass' | 'drums' | 'music' | 'other' | 'vocals';
  return timeline.waveformPeaks[sourceKey];
}

const spectrumFollowerCache = new WeakMap<FeatureTimeline, Map<string, Float32Array>>();

function spectrumAt(timeline: FeatureTimeline, timeMs: number, attackMs: number, releaseMs: number): number[] | undefined {
  const spectrum = timeline.frequencySpectrum;
  if (!spectrum) return undefined;
  const frames = spectrum.values.length / spectrum.bandCount;
  if (!Number.isInteger(frames) || frames < 1) return undefined;
  let bySettings = spectrumFollowerCache.get(timeline);
  if (!bySettings) { bySettings = new Map(); spectrumFollowerCache.set(timeline, bySettings); }
  const key = `${attackMs}:${releaseMs}`;
  let follower = bySettings.get(key);
  if (!follower) {
    follower = new Float32Array(spectrum.values.length);
    const bands = spectrum.bandCount;
    for (let band = 0; band < bands; band += 1) follower[band] = (spectrum.values[band] ?? 0) / 255;
    for (let frame = 1; frame < frames; frame += 1) {
      const offset = frame * bands;
      const previousOffset = offset - bands;
      for (let band = 0; band < bands; band += 1) {
        const previous = follower[previousOffset + band] ?? 0;
        const target = (spectrum.values[offset + band] ?? 0) / 255;
        const tau = target > previous ? attackMs : releaseMs;
        follower[offset + band] = tau === 0 ? target : previous + (target - previous) * (1 - Math.exp(-spectrum.hopMs / tau));
      }
    }
    if (bySettings.size >= 16) bySettings.delete(bySettings.keys().next().value as string);
    bySettings.set(key, follower);
  }
  const position = Math.max(0, Math.min(frames - 1, timeMs / spectrum.hopMs));
  const leftFrame = Math.floor(position);
  const rightFrame = Math.min(frames - 1, leftFrame + 1);
  const fraction = position - leftFrame;
  return Array.from({ length: spectrum.bandCount }, (_, band) => {
    const left = follower![leftFrame * spectrum.bandCount + band] ?? 0;
    const right = follower![rightFrame * spectrum.bandCount + band] ?? left;
    return left + (right - left) * fraction;
  });
}

function sampleWaveformPeak(peaks: WaveformPeak[], timeMs: number): WaveformPeak | undefined {
  if (!peaks.length || timeMs < 0) return undefined;
  const index = Math.min(peaks.length - 1, Math.floor(timeMs / 20));
  return peaks[index];
}

function effectCommandLayers(
  blueprint: EditorBlueprint,
  effect: Effect,
  region: RegionGeometry,
  binding: Binding,
  strength: number,
  timeMs: number,
  timeline: FeatureTimeline,
): EditorDrawCommand[] {
  const bounds = normalizedBounds(region);
  const x = bounds.x * blueprint.width;
  const y = bounds.y * blueprint.height;
  const width = bounds.width * blueprint.width;
  const height = bounds.height * blueprint.height;
  const common = {
    region, color: effect.color, opacity: Math.min(1, strength),
    ...(effect.colorMode === 'global-gradient' ? { colorGradient: blueprint.globalGradient ?? DEFAULT_GLOBAL_GRADIENT } : {}),
  };

  switch (effect.kind) {
    case 'ink-diffusion':
    case 'ink-flow':
    case 'color-mixing': {
      const reactive = effect.audioReactive !== false;
      if (effect.visibilityMode !== 'always' && (!reactive || !inkSourceAvailable(binding.source, timeline))) return [];
      const response = reactive ? smoothedInkResponse(binding, timeline, timeMs, effect.responseTime ?? 3) : 0;
      if (effect.visibilityMode !== 'always' && response < 0.008) return [];
      const visibility = effect.visibilityMode === 'always' ? 1 : Math.min(1, response * 2.5);
      const time = timeMs / 1000;
      const speed = effect.diffusionSpeed ?? (effect.kind === 'ink-flow' ? 0.45 : 0.25);
      const flow = effect.flowStrength ?? (effect.kind === 'ink-flow' ? 0.95 : 0.4);
      const turbulence = effect.turbulence ?? (effect.kind === 'ink-flow' ? 0.65 : effect.kind === 'color-mixing' ? 0.55 : 0.3);
      const density = effect.inkDensity ?? (effect.kind === 'ink-flow' ? 0.5 : 0.65);
      const cloudScale = effect.cloudScale ?? (effect.kind === 'color-mixing' ? 0.9 : 0.5);
      const minDimension = Math.min(width, height);
      const seed = stableHash(effect.id, blueprint.seed);
      const diffusion = 1 - Math.exp(-time * (0.06 + speed * 0.3 + response * 0.24));
      const reach = Math.min(1.3, (0.2 + diffusion * 0.68 + response * 0.45) * (0.78 + cloudScale * 0.44));
      const phase = time * speed * (0.7 + response * 1.4) + deterministicUnit(seed) * Math.PI * 2;
      const centers = [{ x: 0.5, y: 0.5, radius: 0 }];
      for (let index = 0; index < 3; index += 1) {
        const angle = phase * (index % 2 === 0 ? 0.37 : -0.29) + index * Math.PI * 2 / 3;
        const orbit = reach * (0.34 + 0.1 * Math.sin(phase * 0.61 + index));
        centers.push({ x: 0.5 + Math.cos(angle) * orbit, y: 0.5 + Math.sin(angle * 1.13) * orbit * width / height, radius: index + 1 });
      }
      const fallback: EditorDrawCommand[] = [];
      const contour = (cx: number, cy: number, radius: number, lane: number, inner: boolean) => {
        const points: Array<{ x: number; y: number }> = [];
        const layerScale = inner ? 0.63 : 1;
        const phaseOffset = deterministicUnit(seed ^ Math.imul(lane + 1, 0x9e3779b1)) * Math.PI * 2;
        for (let index = 0; index < 48; index += 1) {
          const angle = index / 48 * Math.PI * 2;
          const broad = Math.sin(angle * (2 + lane % 3) + phaseOffset + time * speed * 0.31);
          const detail = Math.sin(angle * 5 + phaseOffset * 1.7 - time * speed * 0.47);
          const fine = Math.sin(angle * 9 - phaseOffset + time * speed * 0.23);
          const radial = radius * layerScale * (1 + turbulence * (0.12 * broad + 0.055 * detail + 0.025 * fine));
          points.push({ x: x + cx * width + Math.cos(angle) * radial, y: y + cy * height + Math.sin(angle) * radial });
        }
        return points;
      };
      centers.forEach((center, index) => {
        if (effect.kind === 'ink-flow') return;
        const centerScale = index === 0 ? 0.62 : 0.5 + deterministicUnit(seed ^ index) * 0.1;
        const radius = minDimension * reach * centerScale;
        for (const inner of [false, true]) {
          const points = contour(center.x, center.y, radius, index, inner);
          fallback.push({ ...common, kind: 'path', x, y, width, height, opacity: Math.min(0.34, density * (inner ? 0.2 + response * 0.12 : 0.12 + response * 0.1) * visibility), pathPoints: points, closed: true, fillPath: true, smoothness: inner ? 0.76 : 0.68, shadowBlur: minDimension * (inner ? 0.018 : 0.03) * density });
        }
      });
      for (let index = 0; index < 5; index += 1) {
        const angle = phase * (index % 2 === 0 ? 0.23 : -0.19) + deterministicUnit(seed ^ Math.imul(index + 19, 0x85ebca6b)) * Math.PI * 2;
        const length = minDimension * reach * (1.45 + deterministicUnit(seed ^ (index + 101)) * 0.25);
        const side = index % 2 === 0 ? -1 : 1;
        const spine: Array<{ x: number; y: number }> = [];
        for (let point = 0; point < 18; point += 1) {
          const progress = point / 17;
          const bend = side * Math.sin(progress * Math.PI) * length * (0.08 + flow * 0.12) * Math.sin(phase * 0.42 + index);
          const radius = progress * length;
          spine.push({ x: x + width * 0.5 + Math.cos(angle) * radius - Math.sin(angle) * bend, y: y + height * 0.5 + Math.sin(angle) * radius + Math.cos(angle) * bend });
        }
        const left: Array<{ x: number; y: number }> = [];
        const right: Array<{ x: number; y: number }> = [];
        spine.forEach((point, pointIndex) => {
          const before = spine[Math.max(0, pointIndex - 1)]!;
          const after = spine[Math.min(spine.length - 1, pointIndex + 1)]!;
          const dx = after.x - before.x, dy = after.y - before.y;
          const norm = Math.hypot(dx, dy) || 1;
          const widthAt = minDimension * (0.004 + density * 0.008) * (1 - pointIndex / 18) * (1 + response * 0.6);
          left.push({ x: point.x - dy / norm * widthAt, y: point.y + dx / norm * widthAt });
          right.push({ x: point.x + dy / norm * widthAt, y: point.y - dx / norm * widthAt });
        });
        fallback.push(effect.kind === 'ink-flow'
          ? { ...common, kind: 'path', x, y, width, height, opacity: Math.min(0.42, density * (0.22 + response * 0.3) * visibility), pathPoints: spine, closed: false, strokeOnly: true, lineWidth: minDimension * (0.004 + response * 0.003), smoothness: 0.68, shadowBlur: minDimension * 0.018 * density }
          : { ...common, kind: 'path', x, y, width, height, opacity: Math.min(0.3, density * (0.12 + response * 0.2) * visibility), pathPoints: [...left, ...right.reverse()], closed: true, fillPath: true, smoothness: 0.58, shadowBlur: minDimension * 0.012 * density });
      }
      return [{
        ...common,
        kind: effect.kind,
        x, y, width, height,
        opacity: visibility,
        inkPayload: {
          timeSeconds: time,
          effectKind: effect.kind,
          diffusionSpeed: speed,
          flowStrength: flow,
          turbulence,
          inkDensity: density,
          cloudScale,
          response,
          diffusion,
          seed,
          color: effect.color,
          ...(effect.kind === 'color-mixing' && effect.colorMode !== 'global-gradient' && effect.customPalette ? { paletteColors: effect.customPalette } : {}),
          ...(effect.colorMode === 'global-gradient' ? { gradient: blueprint.globalGradient ?? DEFAULT_GLOBAL_GRADIENT } : {}),
        },
        fallbackCommands: effect.kind === 'color-mixing' && effect.colorMode !== 'global-gradient' && effect.customPalette
          ? fallback.map((command, index) => ({ ...command, color: effect.customPalette![index % effect.customPalette!.length]!, colorGradient: undefined }))
          : fallback,
      }];
    }
    case 'pulse-scale': {
      const scale = effect.baseScale + (effect.maxScale - effect.baseScale) * strength;
      const diameter = Math.min(width, height) * 0.78 * scale;
      return [{ ...common, kind: 'circle', x: x + (width - diameter) / 2, y: y + (height - diameter) / 2, width: diameter, height: diameter }];
    }
    case 'glow-brightness':
      if (effect.glowIntensity === undefined) return [{ ...common, kind: 'rect', x, y, width, height, opacity: Math.min(1, strength * effect.brightness), shadowBlur: effect.blurPx * strength }];
      if (effect.glowIntensity === 0) return [{ ...common, kind: 'rect', x, y, width, height, opacity: Math.min(1, strength * effect.brightness) }];
      return [
        { ...common, kind: 'rect', x, y, width, height, opacity: Math.min(1, strength * effect.brightness * 0.45), shadowBlur: effect.blurPx * strength * effect.glowIntensity },
        { ...common, kind: 'rect', x, y, width, height, opacity: Math.min(1, strength * effect.brightness) },
      ];
    case 'rotation-movement': {
      const drawWidth = width * 0.78;
      const drawHeight = Math.max(8, height * 0.28);
      return [{ ...common, kind: 'rect', x: x + (width - drawWidth) / 2, y: y + (height - drawHeight) / 2, width: drawWidth, height: drawHeight, rotationRad: effect.rotationDeg * strength * Math.PI / 180, moveX: effect.moveX * strength * blueprint.width, moveY: effect.moveY * strength * blueprint.height }];
    }
    case 'particles': {
      // Particles are intrinsically audio-triggered. Legacy `always`/non-reactive
      // values remain readable but cannot make the field visible without signal.
      const reactive = true;
      const always = false;
      const response = Math.min(1, Math.max(0, strength));
      if (!always && response <= 0) return [];
      const countScale = always ? 0.36 + response * 0.64 : 0.2 + response * 0.8;
      const particleCount = Math.max(1, Math.min(64, effect.count, Math.ceil(effect.count * countScale)));
      const cycle = effect.cycleMs / (1 + response * (effect.speedInfluence ?? 0.9));
      const phase = !reactive ? 0 : ((timeMs % cycle) + cycle) % cycle / cycle;
      const nameSeed = stableHash(effect.id, blueprint.seed);
      // Spread particles across the emitter width even at silence. Audio expands
      // the field toward the Region edges instead of collapsing it around center.
      const baseSpread = effect.spread ?? 0.92;
      const spread = Math.min(1, baseSpread + response * (1 - baseSpread));
      const baselineOpacity = always ? effect.baselineOpacity ?? 0.26 : 0;
      return Array.from({ length: particleCount }, (_, index) => {
        const horizontalJitter = deterministicUnit(nameSeed ^ (index * 0x9e3779b1 + 0x51ed));
        const verticalJitter = deterministicUnit(nameSeed ^ (index * 0x85ebca6b + 0x9e37));
        // Stratified positions avoid random clumping while keeping each effect
        // reproducible. Independent hashes prevent correlated x/y/size patterns.
        const slotX = (index + 0.15 + horizontalJitter * 0.7) / particleCount;
        const verticalOffset = (index * 0.6180339887498949 + verticalJitter * 0.24) % 1;
        const particlePhase = (phase + verticalOffset) % 1;
        const size = effect.sizePx * (0.7 + horizontalJitter * 0.6);
        const sway = reactive ? Math.sin((timeMs / cycle + verticalJitter) * Math.PI * 2) * width * 0.025 * response : 0;
        const particleX = x + width * (0.5 + (slotX - 0.5) * spread) + sway - size / 2;
        const particleY = y + (1 - particlePhase) * Math.max(0, height - size);
        const pulse = reactive ? response * (0.48 + horizontalJitter * 0.42) * Math.sin(Math.PI * particlePhase) : 0;
        const glow = (effect.glowIntensity ?? 1.1) * size * (0.45 + verticalJitter * 0.55) * (0.6 + response * 1.1);
        return { ...common, kind: 'circle' as const, x: particleX, y: particleY, width: size, height: size, opacity: Math.min(1, baselineOpacity + pulse), shadowBlur: glow > 0 ? glow : undefined };
      });
    }
    case 'waveform-bars': {
      const barWidth = width / effect.bars;
      return Array.from({ length: effect.bars }, (_, index) => {
        const sampleTime = Math.max(0, timeMs - (index / effect.bars) * 600);
        const amplitude = Math.min(1, Math.max(0, rawSourceValue(binding, timeline, sampleTime)));
        const barHeight = Math.max(2, amplitude * height * 0.82);
        return { ...common, kind: 'rect' as const, x: x + index * barWidth + barWidth * (1 - effect.lineWidth) / 2, y: y + (height - barHeight) / 2, width: barWidth * effect.lineWidth, height: barHeight, opacity: Math.min(1, strength) };
      });
    }
    case 'waveform-line': {
      const peaks = waveformPeaksFor(binding.source, timeline);
      if (!peaks) {
        if (effect.visibilityMode !== 'always') return [];
        const center = effect.orientation === 'horizontal' ? y + height / 2 : x + width / 2;
        const pathPoints = effect.orientation === 'horizontal' ? [{ x, y: center }, { x: x + width, y: center }] : [{ x: center, y }, { x: center, y: y + height }];
        return [{ ...common, kind: 'path', x, y, width, height, opacity: 0, pathPoints, closed: false, lineWidth: Math.min(width, height) * effect.lineWidth }];
      }
      const points: Array<{ x: number; y: number }> = [];
      const spanMs = effect.sampleCount * 20;
      const peakTimeMs = effect.audioReactive === false ? Math.min(timeline.durationMs, spanMs) : timeMs;
      const center = effect.orientation === 'horizontal' ? y + height / 2 : x + width / 2;
      for (let index = 0; index < effect.sampleCount; index += 1) {
        const time = peakTimeMs - spanMs + (index / (effect.sampleCount - 1)) * spanMs;
        const peak = sampleWaveformPeak(peaks, time) ?? { min: 0, max: 0 };
        const max = Math.max(-1, Math.min(1, peak.max * effect.amplitudeScale));
        const px = effect.orientation === 'horizontal' ? x + (index / (effect.sampleCount - 1)) * width : center + max * width / 2;
        const py = effect.orientation === 'horizontal' ? center - max * height / 2 : y + (index / (effect.sampleCount - 1)) * height;
        points.push({ x: px, y: py });
      }
      for (let index = effect.sampleCount - 1; index >= 0; index -= 1) {
        const time = peakTimeMs - spanMs + (index / (effect.sampleCount - 1)) * spanMs;
        const peak = sampleWaveformPeak(peaks, time) ?? { min: 0, max: 0 };
        const min = Math.max(-1, Math.min(1, peak.min * effect.amplitudeScale));
        const px = effect.orientation === 'horizontal' ? x + (index / (effect.sampleCount - 1)) * width : center + min * width / 2;
        const py = effect.orientation === 'horizontal' ? center - min * height / 2 : y + (index / (effect.sampleCount - 1)) * height;
        points.push({ x: px, y: py });
      }
      return [{ ...common, kind: 'path', x, y, width, height, opacity: strength, pathPoints: points, fillPath: true, lineWidth: Math.min(width, height) * effect.lineWidth, shadowBlur: effect.glowIntensity > 0 ? Math.min(width, height) * 0.02 * effect.glowIntensity : undefined }];
    }
    case 'waveform-peak-bars': {
      const peaks = waveformPeaksFor(binding.source, timeline);
      if (!peaks) {
        if (effect.visibilityMode !== 'always') return [];
        return [{ ...common, kind: 'path', x, y: y + height / 2, width, height: 0, opacity: 0, pathPoints: [{ x, y: y + height / 2 }, { x: x + width, y: y + height / 2 }], closed: false, lineWidth: Math.max(1, Math.min(width, height) * 0.003) }];
      }
      const slot = width / effect.bars;
      const gap = slot * effect.spacing;
      const barWidth = (slot - gap) * effect.barWidth;
      const spanMs = effect.bars * 20;
      const peakTimeMs = effect.audioReactive === false ? Math.min(timeline.durationMs, spanMs) : timeMs;
      return Array.from({ length: effect.bars }, (_, index) => {
        const peak = sampleWaveformPeak(peaks, peakTimeMs - spanMs + index * 20) ?? { min: 0, max: 0 };
        const min = Math.max(-1, Math.min(1, peak.min * effect.amplitudeScale));
        const max = Math.max(-1, Math.min(1, peak.max * effect.amplitudeScale));
        const upper = y + height / 2 - max * height / 2;
        const lower = y + height / 2 - min * height / 2;
        return { ...common, kind: 'rect' as const, x: x + index * slot + (slot - barWidth) / 2, y: upper, width: barWidth, height: Math.max(0, lower - upper), opacity: strength, shadowBlur: effect.glowIntensity > 0 ? effect.glowIntensity * 4 : undefined };
      });
    }
    case 'spectrum-bars': {
      const spectrum = spectrumAt(timeline, timeMs, effect.attackMs ?? binding.attackMs, effect.releaseMs ?? binding.releaseMs);
      if (!spectrum) return [];
      const reactiveScale = effect.audioReactive === false ? 1 : 0.4 + strength * 0.6;
      const slot = width / spectrum.length;
      const segments = effect.segmented === false ? 1 : effect.segmentsPerBar ?? 12;
      const commands: EditorDrawCommand[] = [];
      for (let band = 0; band < spectrum.length; band += 1) {
        const amplitude = Math.min(1, (spectrum[band] ?? 0) * effect.amplitudeScale * reactiveScale);
        const barWidth = slot * effect.barWidth * (1 - effect.spacing);
        const barX = x + band * slot + (slot - barWidth) / 2;
        if (segments === 1) {
          const barHeight = height * amplitude;
          commands.push({ ...common, kind: 'rect', x: barX, y: y + height - barHeight, width: barWidth, height: barHeight, opacity: strength, shadowBlur: effect.glowIntensity > 0 ? effect.glowIntensity * 5 : undefined });
          continue;
        }
        const segmentGap = Math.max(1, height * 0.006);
        const segmentHeight = Math.max(1, (height - (segments - 1) * segmentGap) / segments);
        const active = Math.ceil(amplitude * segments);
        for (let segment = 0; segment < active; segment += 1) {
          const segmentY = y + height - segmentHeight - segment * (segmentHeight + segmentGap);
          commands.push({ ...common, kind: 'rect', x: barX, y: segmentY, width: barWidth, height: segmentHeight, opacity: strength, shadowBlur: effect.glowIntensity > 0 ? effect.glowIntensity * 5 : undefined });
        }
      }
      return commands;
    }
    case 'spectrum-line': {
      const spectrum = spectrumAt(timeline, timeMs, effect.attackMs ?? binding.attackMs, effect.releaseMs ?? binding.releaseMs);
      if (!spectrum) return [];
      const reactiveScale = effect.audioReactive === false ? 1 : 0.4 + strength * 0.6;
      const pathPoints = spectrum.map((value, index) => ({
        x: x + index / (spectrum.length - 1) * width,
        y: y + height - Math.min(1, value * effect.amplitudeScale * reactiveScale) * height,
      }));
      return [{ ...common, kind: 'path', x, y, width, height, opacity: strength, pathPoints, closed: false, smoothness: effect.smoothing, lineWidth: Math.min(width, height) * effect.lineWidth, shadowBlur: effect.glowIntensity > 0 ? Math.min(width, height) * 0.02 * effect.glowIntensity : undefined }];
    }
    case 'waveform-ring': {
      const minDimension = Math.min(width, height);
      const peaks = waveformPeaksFor(binding.source, timeline);
      if (!peaks) {
        if (effect.visibilityMode !== 'always') return [];
        const centerX = x + width / 2; const centerY = y + height / 2;
        const radius = effect.radius * minDimension;
        const rotation = circularRotation(effect, binding, timeline, timeMs);
        const pathPoints = Array.from({ length: effect.sampleCount }, (_, index) => {
          const angle = (index / effect.sampleCount) * Math.PI * 2 - Math.PI / 2 + rotation;
          return { x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius };
        });
        return [{ ...common, kind: 'path', x: centerX, y: centerY, width: 0, height: 0, opacity: 0, pathPoints, smoothness: effect.smoothing, lineWidth: minDimension * effect.lineWidth }];
      }
      const centerX = x + width / 2;
      const centerY = y + height / 2;
      const baseRadius = effect.radius * minDimension;
      const rotation = circularRotation(effect, binding, timeline, timeMs);
      const amplitude = minDimension * 0.12 * effect.amplitudeScale;
      const spanMs = effect.sampleCount * 20;
      const peakTimeMs = effect.audioReactive === false ? Math.min(timeline.durationMs, spanMs) : timeMs;
      const pathPoints = Array.from({ length: effect.sampleCount }, (_, index) => {
        const time = peakTimeMs - spanMs + (index / effect.sampleCount) * spanMs;
        const peak = sampleWaveformPeak(peaks, time) ?? { min: 0, max: 0 };
        const signed = Math.abs(peak.max) >= Math.abs(peak.min) ? peak.max : peak.min;
        const deviation = Math.max(-1, Math.min(1, signed * effect.amplitudeScale));
        const angle = (index / effect.sampleCount) * Math.PI * 2 - Math.PI / 2 + rotation;
        return { x: centerX + Math.cos(angle) * (baseRadius + deviation * amplitude), y: centerY + Math.sin(angle) * (baseRadius + deviation * amplitude) };
      });
      return [{ ...common, kind: 'path', x: centerX, y: centerY, width: 0, height: 0, opacity: strength, pathPoints, smoothness: effect.smoothing, lineWidth: minDimension * effect.lineWidth, shadowBlur: effect.glowIntensity > 0 ? minDimension * 0.02 * effect.glowIntensity : undefined }];
    }
    case 'radial-bars': {
      const minDimension = Math.min(width, height);
      const centerX = x + effect.centerX * width;
      const centerY = y + effect.centerY * height;
      const rotation = circularRotation(effect, binding, timeline, timeMs);
      if (effect.spikeSharpness !== undefined || effect.innerRadius !== undefined || effect.amplitudeScale !== undefined || effect.glowIntensity !== undefined || effect.barWidth !== undefined) {
        const innerRadius = Math.min(effect.radius, effect.innerRadius ?? effect.radius * 0.56);
        const barWidth = effect.barWidth ?? 0.42;
        const amplitudeScale = effect.amplitudeScale ?? 1.7;
        const sharpness = effect.spikeSharpness ?? 0.85;
        const halfAngle = (Math.PI / effect.bars) * barWidth * (1 - sharpness * 0.72);
        const shadowBlur = minDimension * 0.018 * (effect.glowIntensity ?? 0);
        return Array.from({ length: effect.bars }, (_, index) => {
          const angle = (index / effect.bars) * Math.PI * 2 - Math.PI / 2 + rotation;
          const sampleTime = Math.max(0, timeMs - (index / effect.bars) * 260);
          const amplitude = Math.min(1, Math.max(0, rawSourceValue(binding, timeline, sampleTime) * strength));
          const tipRadius = effect.radius + effect.barLength * amplitude * amplitudeScale;
          const shoulderRadius = effect.radius + (tipRadius - effect.radius) * (0.5 + sharpness * 0.42);
          const point = (radius: number, theta: number) => ({ x: centerX + Math.cos(theta) * radius * minDimension, y: centerY + Math.sin(theta) * radius * minDimension });
          return {
            ...common, kind: 'path' as const, x: centerX, y: centerY, width: 0, height: 0,
            opacity: Math.min(1, strength), pathPoints: [
              point(innerRadius, angle - halfAngle), point(shoulderRadius, angle - halfAngle * 0.28),
              point(tipRadius, angle), point(shoulderRadius, angle + halfAngle * 0.28), point(innerRadius, angle + halfAngle),
            ], fillPath: true, lineWidth: 0.5, shadowBlur: shadowBlur || undefined,
          };
        });
      }
      return Array.from({ length: effect.bars }, (_, index) => {
        const angle = (index / effect.bars) * Math.PI * 2 - Math.PI / 2 + rotation;
        const sampleTime = Math.max(0, timeMs - (index / effect.bars) * 600);
        const amplitude = Math.min(1, Math.max(0, rawSourceValue(binding, timeline, sampleTime) * strength));
        const barHeight = Math.max(2, effect.barLength * minDimension * amplitude);
        const barWidth = Math.max(1, (Math.PI * (effect.radius * minDimension) / effect.bars) * effect.lineWidth);
        const radialCenter = effect.radius + barHeight / (2 * minDimension);
        const barCenterX = centerX + Math.cos(angle) * radialCenter * minDimension;
        const barCenterY = centerY + Math.sin(angle) * radialCenter * minDimension;
        return { ...common, kind: 'rect' as const, x: barCenterX - barWidth / 2, y: barCenterY - barHeight / 2, width: barWidth, height: barHeight, opacity: Math.min(1, strength), rotationRad: angle - Math.PI / 2 };
      });
    }
    case 'wave-ring': {
      const minDimension = Math.min(width, height);
      const centerX = x + effect.centerX * width;
      const centerY = y + effect.centerY * height;
      const rotation = circularRotation(effect, binding, timeline, timeMs);
      const baseRadius = effect.radius * minDimension;
      const sampleCount = effect.sampleCount ?? effect.points;
      const jaggedness = effect.jaggedness ?? 0;
      const amplitude = minDimension * effect.amplitude * strength * (effect.amplitudeScale ?? 1) * (1 + jaggedness * 0.5);
      const sampleWindowMs = 1000 - jaggedness * 850;
      const features = Array.from({ length: sampleCount }, (_, index) => {
        const sampleTime = Math.max(0, timeMs - (index / sampleCount) * sampleWindowMs);
        return Math.min(1, Math.max(0, rawSourceValue(binding, timeline, sampleTime)));
      });
      const glowIntensity = effect.glowIntensity ?? 0;
      const layerCount = effect.layerCount ?? 1;
      const layerStep = effect.layerAngleOffsetDeg ?? 0;
      const decay = effect.layerAmplitudeDecay ?? 0.9;
      return Array.from({ length: layerCount }, (_, layerIndex) => {
        const angleStepDeg = layerStep > 0 ? layerStep : layerCount === 1 ? 0 : 360 / layerCount;
        const layerOffsetDeg = layerIndex * angleStepDeg;
        const pathPoints = Array.from({ length: sampleCount }, (_, index) => {
          const feature = features[index] ?? 0;
          const angle = (index / sampleCount) * Math.PI * 2 + rotation + (layerOffsetDeg * Math.PI) / 180;
          const deviation = (feature * 2 - 1) * decay ** layerIndex;
          return { x: centerX + Math.cos(angle) * (baseRadius + deviation * amplitude), y: centerY + Math.sin(angle) * (baseRadius + deviation * amplitude) };
        });
        return { ...common, kind: 'path' as const, x: centerX, y: centerY, width: 0, height: 0, opacity: Math.min(1, strength), pathPoints, smoothness: effect.smoothing ?? 0.55, lineWidth: minDimension * effect.lineWidth, shadowBlur: glowIntensity > 0 ? minDimension * 0.02 * glowIntensity : undefined };
      });
    }
    case 'oscilloscope-line': {
      const phaseOffset = deterministicUnit(stableHash(effect.id, blueprint.seed));
      const cycles = 12;
      const centerX = x + width * 0.5;
      const centerY = y + height * 0.5;
      const pathPoints = Array.from({ length: effect.sampleCount }, (_, index) => {
        const progress = index / (effect.sampleCount - 1);
        const sampleTime = Math.max(0, timeMs - (1 - progress) * 180);
        const envelope = Math.min(1, Math.max(0, rawSourceValue(binding, timeline, sampleTime)));
        const phase = (((progress * cycles + (effect.audioReactive === false ? 0 : timeMs / 240) + phaseOffset) % 1) + 1) % 1;
        const saw = phase * 2 - 1;
        const amplitudeY = Math.min(height * 0.48, height * 0.44 * effect.amplitudeScale) * (0.12 + envelope * 0.88);
        if (effect.orientation === 'horizontal') return { x: x + progress * width, y: centerY + saw * amplitudeY };
        const angle = progress * Math.PI * 2 - Math.PI / 2;
        const radiusFactor = Math.min(0.48, Math.max(0.12, 0.34 + saw * 0.14 * effect.amplitudeScale));
        const radius = Math.min(width, height) * radiusFactor;
        return { x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius };
      });
      const minDimension = Math.min(width, height);
      return [{ ...common, kind: 'path', x: centerX, y: centerY, width: 0, height: 0, opacity: Math.min(1, strength), pathPoints, closed: false, lineWidth: minDimension * effect.lineWidth, shadowBlur: effect.glowIntensity > 0 ? minDimension * 0.022 * effect.glowIntensity : undefined }];
    }
    case 'particle-burst': {
      const originX = x + effect.originX * width;
      const originY = y + effect.originY * height;
      const hash = stableHash(effect.id, blueprint.seed);
      const output: EditorDrawCommand[] = [];
      let particleTotal = 0;
      const events = eventSource(binding, timeline, timeMs, effect.lifetimeMs);
      let low = 0;
      let high = events.times.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if ((events.times[middle] ?? Infinity) <= timeMs) low = middle + 1;
        else high = middle;
      }
      let activeEvents = 0;
      for (let eventIndex = low - 1; eventIndex >= 0 && activeEvents < 32 && particleTotal < 64; eventIndex -= 1) {
        const eventTime = events.times[eventIndex];
        if (eventTime === undefined || eventTime > timeMs) continue;
        const ageMs = timeMs - eventTime;
        if (ageMs >= effect.lifetimeMs) break;
        activeEvents += 1;
        const eventStrength = boundFeature(events.strengths[eventIndex] ?? 0, binding);
        if (eventStrength <= 0) continue;
        const influence = effect.audioReactive === false ? 0 : effect.audioInfluence ?? 1;
        const response = Math.min(1, Math.max(0, eventStrength * influence));
        const progress = ageMs / effect.lifetimeMs;
        const particleCount = Math.min(64 - particleTotal, Math.max(1, Math.min(64, effect.count, Math.ceil(effect.count * (0.32 + response * 0.68)))));
        if ((effect.coreBrightness ?? 0) > 0) {
          const coreSize = effect.sizePx * (1.5 + response * 2 + (effect.coreBrightness ?? 0));
          output.push({ ...common, kind: 'circle', x: originX - coreSize / 2, y: originY - coreSize / 2, width: coreSize, height: coreSize, opacity: Math.min(1, eventStrength * (effect.opacityBoost ?? 1) * (effect.coreBrightness ?? 0.5) * (1 - progress)), shadowBlur: effect.sizePx * (effect.glowIntensity ?? 0) });
        }
        const eventRotation = eventIndex * 137.507764 + progress * (effect.swirl ?? 0.55) * 360;
        for (let index = 0; index < particleCount; index += 1) {
          const particleSeed = hash ^ stableHash(String(eventTime), 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca6b);
          const jitter = (deterministicUnit(particleSeed) - 0.5) * effect.spreadDeg * (0.12 + response * 0.88);
          const angle = (effect.directionDeg + eventRotation + index * 360 / particleCount + jitter) * Math.PI / 180;
          const speed = effect.speedPxPerSec * (0.55 + deterministicUnit(particleSeed ^ 0x27d4eb2d) * 0.9) * (0.45 + response * 1.55);
          const lifeScale = 0.78 + deterministicUnit(particleSeed ^ 0x165667b1) * 0.44;
          const particleProgress = Math.min(1, progress / lifeScale);
          const size = effect.sizePx * (0.5 + deterministicUnit(particleSeed ^ 0xd3a2646c) * 0.9) * (1 - particleProgress * 0.58);
          const distance = speed * ageMs / 1000;
          const opacity = Math.min(1, eventStrength * (1 - particleProgress) * (effect.opacityBoost ?? 1));
          const glow = size * (effect.glowIntensity ?? 0) * (0.35 + response * 0.9) * (0.5 + deterministicUnit(particleSeed ^ 0x9e3779b9));
          output.push({ ...common, kind: 'circle', x: originX + Math.cos(angle) * distance - size / 2, y: originY + Math.sin(angle) * distance - size / 2, width: size, height: size, opacity, shadowBlur: glow > 0 ? glow : undefined });
          particleTotal += 1;
        }
      }
      return output;
    }
    case 'particle-trail': {
      const output: EditorDrawCommand[] = [];
      for (let index = 0; index < effect.samples; index += 1) {
        const progress = index / (effect.samples - 1);
        const ageMs = progress * effect.trailMs;
        const sampleTime = Math.max(0, timeMs - ageMs);
        const feature = boundFeature(rawSourceValue(binding, timeline, sampleTime), binding);
        const size = effect.sizePx * (0.35 + 0.65 * (1 - progress));
        const sampleIndex = effect.samples - 1 - index;
        const particleSeed = stableHash(effect.id, blueprint.seed) ^ Math.imul(sampleIndex + 1, 0x9e3779b1);
        const jitter = (deterministicUnit(particleSeed) - 0.5) * 0.12;
        const px = x + Math.min(1, Math.max(0, progress * (effect.lengthScale ?? 1) + jitter)) * width;
        const verticalReach = Math.min(0.49, effect.amplitude * 1.6);
        const py = y + height * (0.5 - (feature - 0.5) * 2 * verticalReach);
        const opacity = feature * (1 - progress) * strength * (effect.opacityBoost ?? 1);
        if (opacity > 0 || effect.visibilityMode === 'always') output.push({ ...common, kind: 'circle', x: px - size / 2, y: py - size / 2, width: size, height: size, opacity: Math.min(1, opacity), shadowBlur: effect.glowIntensity ? size * effect.glowIntensity : undefined });
      }
      return output;
    }
    case 'ripple': {
      if (strength <= 0 && effect.visibilityMode !== 'always') return [];
      const centerX = x + effect.centerX * width;
      const centerY = y + effect.centerY * height;
      const minDimension = Math.min(width, height);
      const phase = effect.visibilityMode === 'always' && strength <= 0 ? 0 : ((timeMs % effect.periodMs) + effect.periodMs) % effect.periodMs / effect.periodMs;
      return Array.from({ length: effect.waves }, (_, index) => {
        const wavePhase = (phase + index / effect.waves) % 1;
        const eased = 1 - (1 - wavePhase) ** 3;
        const radiusScale = effect.radius * (0.25 + eased * 0.75) * (1 + effect.amplitude * strength);
        const radius = minDimension * radiusScale;
        const glowIntensity = effect.glowIntensity ?? 0;
        return { ...common, kind: 'circle' as const, x: centerX - radius, y: centerY - radius, width: radius * 2, height: radius * 2, opacity: Math.min(1, strength * (1 - wavePhase) ** 1.5 * (effect.opacityBoost ?? 1)), strokeOnly: true, lineWidth: minDimension * effect.lineWidth * (1 + (effect.opacityBoost ?? 1) * 0.18), shadowBlur: glowIntensity > 0 ? minDimension * 0.018 * glowIntensity : undefined };
      });
    }
    case 'shockwave': {
      const centerX = x + effect.centerX * width;
      const centerY = y + effect.centerY * height;
      const minDimension = Math.min(width, height);
      const output: EditorDrawCommand[] = [];
      const events = eventSource(binding, timeline, timeMs, effect.lifetimeMs);
      let low = 0;
      let high = events.times.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if ((events.times[middle] ?? Infinity) <= timeMs) low = middle + 1;
        else high = middle;
      }
      let activeEvents = 0;
      for (let eventIndex = low - 1; eventIndex >= 0 && activeEvents < 32; eventIndex -= 1) {
        const eventTime = events.times[eventIndex];
        if (eventTime === undefined || eventTime > timeMs) continue;
        const ageMs = timeMs - eventTime;
        if (ageMs >= effect.lifetimeMs) break;
        activeEvents += 1;
        const progress = ageMs / effect.lifetimeMs;
        const eased = 1 - (1 - progress) ** 3;
        const radius = effect.maxRadius * minDimension * eased;
        const opacityBoost = effect.opacityBoost ?? 1;
        const glowIntensity = effect.glowIntensity ?? 0;
        output.push({ ...common, kind: 'circle', x: centerX - radius, y: centerY - radius, width: radius * 2, height: radius * 2, opacity: Math.min(1, boundFeature(events.strengths[eventIndex] ?? 0, binding) * (1 - progress) ** 1.5 * opacityBoost), strokeOnly: true, lineWidth: Math.max(0.5, minDimension * effect.lineWidth * (1 - progress * 0.5) * (1 + opacityBoost * 0.25)), shadowBlur: glowIntensity > 0 ? minDimension * 0.025 * glowIntensity * (1 - progress) : undefined });
      }
      return output;
    }
  }
}

const withoutSignalCache = new WeakMap<FeatureTimeline, FeatureTimeline>();

function withoutAudioSignals(timeline: FeatureTimeline): FeatureTimeline {
  const cached = withoutSignalCache.get(timeline);
  if (cached) return cached;
  const silent: FeatureTimeline = {
    ...timeline, bassEnvelope: [], kickEvents: [], kickEventStrengths: [], snareEvents: [], snareEventStrengths: [],
    drumEnergy: [], vocalsEnvelope: [], otherEnvelope: [], musicEnergy: [],
  };
  withoutSignalCache.set(timeline, silent);
  return silent;
}

function alwaysBaselineCommands(blueprint: EditorBlueprint, effect: Effect, region: RegionGeometry): EditorDrawCommand[] {
  const bounds = normalizedBounds(region);
  const x = bounds.x * blueprint.width; const y = bounds.y * blueprint.height;
  const width = bounds.width * blueprint.width; const height = bounds.height * blueprint.height;
  const common = { region, color: effect.color, opacity: 0.22, ...(effect.colorMode === 'global-gradient' ? { colorGradient: blueprint.globalGradient ?? DEFAULT_GLOBAL_GRADIENT } : {}) };
  if (effect.kind === 'shockwave') {
    const radius = Math.max(1, effect.maxRadius * Math.min(width, height) * 0.72);
    return [{ ...common, kind: 'circle', x: x + effect.centerX * width - radius, y: y + effect.centerY * height - radius, width: radius * 2, height: radius * 2, strokeOnly: true, lineWidth: Math.max(0.5, Math.min(width, height) * effect.lineWidth), shadowBlur: effect.glowIntensity ? Math.min(width, height) * 0.025 * effect.glowIntensity : undefined }];
  }
  if (effect.kind === 'particle-burst') {
    const hash = stableHash(effect.id, blueprint.seed);
    return Array.from({ length: Math.min(effect.count, 64) }, (_, index) => {
      const randomX = deterministicUnit(hash ^ (index + 0x51ed));
      const randomY = deterministicUnit(hash ^ (index + 0x9e37));
      const size = effect.sizePx * (0.35 + randomX * 0.55);
      return { ...common, kind: 'circle' as const, x: x + randomX * Math.max(0, width - size), y: y + randomY * Math.max(0, height - size), width: size, height: size, opacity: effect.baselineOpacity ?? 0.12, shadowBlur: effect.glowIntensity ? size * effect.glowIntensity * (0.35 + randomY * 0.65) : undefined };
    });
  }
  return [];
}

function effectCommands(blueprint: EditorBlueprint, effect: Effect, region: RegionGeometry, binding: Binding, strength: number, timeMs: number, timeline: FeatureTimeline): EditorDrawCommand[] {
  const always = effect.kind !== 'particles' && effect.visibilityMode === 'always';
  const reactive = effect.kind === 'particles' || effect.audioReactive !== false;
  const activeTimeline = reactive ? timeline : withoutAudioSignals(timeline);
  const activeBinding = reactive ? binding : { ...binding, strength: 0, threshold: 1 };
  let commands = effectCommandLayers(blueprint, effect, region, activeBinding, reactive ? strength : 0, timeMs, activeTimeline);
  if (always && commands.length === 0) commands = alwaysBaselineCommands(blueprint, effect, region);
  const effectOpacity = effect.opacity ?? 1;
  return commands.map((command) => {
    const particleEffect = effect.kind === 'particles' || effect.kind === 'particle-burst';
    const inkEffect = command.kind === 'ink-diffusion' || command.kind === 'ink-flow' || command.kind === 'color-mixing';
    const opacity = (always && !particleEffect && !inkEffect ? Math.max(command.opacity, 0.22) : command.opacity) * effectOpacity;
    if (inkEffect) {
      return { ...command, opacity, fallbackCommands: (command.fallbackCommands ?? []).map((fallback) => ({ ...fallback, opacity: fallback.opacity * effectOpacity })) };
    }
    return { ...command, opacity };
  });
}

export function validateFeatureTimeline(timeline: FeatureTimeline): void {
  if (!timeline || typeof timeline !== 'object' || !Array.isArray(timeline.bassEnvelope) || !Array.isArray(timeline.kickEvents) || !Number.isSafeInteger(timeline.durationMs) || timeline.durationMs <= 0) throw new Error('Invalid Feature Timeline: durationMs');
  if ((timeline.bpm === undefined) !== (timeline.bpmSource === undefined) || (timeline.bpm !== undefined && (!Number.isFinite(timeline.bpm) || timeline.bpm < 40 || timeline.bpm > 240 || !['kick-estimated', 'fallback'].includes(timeline.bpmSource!) || (timeline.bpmSource === 'fallback' && timeline.bpm !== 120) || (timeline.bpmSource === 'kick-estimated' && (timeline.bpm < 60 || timeline.bpm > 180))))) throw new Error('Invalid Feature Timeline: BPM');
  let previous = -1;
  for (const point of timeline.bassEnvelope) {
    if (!point || !Number.isSafeInteger(point.timeMs) || !Number.isFinite(point.value) || point.value < 0 || point.value > 1 || point.timeMs <= previous || point.timeMs < 0 || point.timeMs > timeline.durationMs) throw new Error('Invalid Feature Timeline: bassEnvelope');
    previous = point.timeMs;
  }
  previous = -1;
  for (const event of timeline.kickEvents) {
    if (!Number.isSafeInteger(event) || event <= previous || event < 0 || event > timeline.durationMs) throw new Error('Invalid Feature Timeline: kickEvents');
    previous = event;
  }
  const checkPoints = (points: FeaturePoint[] | undefined, key: string) => {
    if (points === undefined) return;
    let time = -1;
    for (const point of points) {
      if (!point || !Number.isSafeInteger(point.timeMs) || !Number.isFinite(point.value) || point.timeMs <= time || point.timeMs < 0 || point.timeMs > timeline.durationMs || point.value < 0 || point.value > 1) throw new Error(`Invalid Feature Timeline: ${key}`);
      time = point.timeMs;
    }
  };
  for (const [key, points] of Object.entries({ drumEnergy: timeline.drumEnergy, vocalsEnvelope: timeline.vocalsEnvelope, otherEnvelope: timeline.otherEnvelope, musicEnergy: timeline.musicEnergy })) checkPoints(points, key);
  if (timeline.waveformPeaks !== undefined) {
    const peaks = timeline.waveformPeaks as unknown as Record<string, unknown>;
    const sources = ['music', 'drums', 'bass', 'vocals', 'other'];
    if (!peaks || typeof peaks !== 'object' || Object.keys(peaks).some((key) => !['sampleIntervalMs', 'windowSamples', 'normalization', ...sources].includes(key)) || peaks.sampleIntervalMs !== 20 || peaks.windowSamples !== 882 || peaks.normalization !== 'signed-full-scale' || sources.some((source) => !Array.isArray(peaks[source]))) throw new Error('Invalid Feature Timeline: waveformPeaks');
    const count = Math.ceil(timeline.durationMs / 20);
    for (const source of sources) {
      const values = peaks[source] as unknown[];
      if (values.length !== count || values.length > 12000) throw new Error(`Invalid Feature Timeline: waveformPeaks.${source}`);
      for (const peak of values) {
        if (!peak || typeof peak !== 'object' || Object.keys(peak).some((key) => key !== 'min' && key !== 'max') || !('min' in peak) || !('max' in peak) || !Number.isFinite((peak as Record<string, unknown>).min) || !Number.isFinite((peak as Record<string, unknown>).max) || (peak as WaveformPeak).min < -1 || (peak as WaveformPeak).min > 1 || (peak as WaveformPeak).max < -1 || (peak as WaveformPeak).max > 1 || (peak as WaveformPeak).min > (peak as WaveformPeak).max) throw new Error(`Invalid Feature Timeline: waveformPeaks.${source}`);
      }
    }
  }
  if (timeline.frequencySpectrum !== undefined) {
    const spectrum = timeline.frequencySpectrum as unknown as Record<string, unknown>;
    const frameCount = Math.ceil(timeline.durationMs / 20);
    if (!spectrum || typeof spectrum !== 'object' || Object.keys(spectrum).some((key) => !['hopMs', 'fftSize', 'bandCount', 'minHz', 'maxHz', 'normalization', 'encoding', 'sampleRateHz', 'values'].includes(key)) || Object.keys(spectrum).length !== 9 || spectrum.hopMs !== 20 || spectrum.fftSize !== 4096 || spectrum.bandCount !== 32 || spectrum.normalization !== 'whole-clip-p99-log-rms' || spectrum.encoding !== 'uint8-linear-0-255' || !Number.isSafeInteger(spectrum.sampleRateHz) || (spectrum.sampleRateHz as number) < 1 || !Number.isFinite(spectrum.minHz) || spectrum.minHz !== 40 || !Number.isFinite(spectrum.maxHz) || (spectrum.maxHz as number) <= (spectrum.minHz as number) || (spectrum.maxHz as number) > 16_000 || (spectrum.maxHz as number) > (spectrum.sampleRateHz as number) / 2 || !Array.isArray(spectrum.values) || spectrum.values.length !== frameCount * 32 || spectrum.values.length > 384_000) throw new Error('Invalid Feature Timeline: frequencySpectrum');
    for (const value of spectrum.values as unknown[]) if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 255) throw new Error('Invalid Feature Timeline: frequencySpectrum.values');
  }
  const checkEvents = (events: number[] | undefined, strengths: number[] | undefined, key: string) => {
    if (events === undefined && strengths === undefined) return;
    if (!events || (!strengths && key !== 'kickEvents') || (strengths && events.length !== strengths.length)) throw new Error(`Invalid Feature Timeline: ${key}`);
    let time = -1;
    events.forEach((event, index) => {
      const strength = strengths?.[index] ?? 1;
      if (!Number.isSafeInteger(event) || event <= time || event < 0 || event > timeline.durationMs || !Number.isFinite(strength) || strength! < 0 || strength! > 1) throw new Error(`Invalid Feature Timeline: ${key}`);
      time = event;
    });
  };
  checkEvents(timeline.kickEvents, timeline.kickEventStrengths, 'kickEvents');
  checkEvents(timeline.snareEvents, timeline.snareEventStrengths, 'snareEvents');
}

export function evaluateEditorFrame(blueprint: EditorBlueprint, timeline: FeatureTimeline, timeMs: number): EditorDrawCommand[] {
  validateBlueprint(blueprint);
  validateFeatureTimeline(timeline);
  if (!Number.isFinite(timeMs)) throw new Error('Invalid render time');
  const safeTime = Math.max(0, Math.min(timeline.durationMs, timeMs));
  const regions = new Map(blueprint.regions.map((region) => [region.id, region]));
  const bindings = new Map(blueprint.bindings.map((binding) => [binding.effectId, binding]));
  return blueprint.effects.flatMap((effect) => {
    const region = regions.get(effect.regionId);
    if (!region) throw new Error(`Invalid Blueprint: missing region ${effect.regionId}`);
    const binding = bindings.get(effect.id);
    if (!binding) throw new Error(`Invalid Blueprint: missing binding ${effect.id}`);
    const strength = evaluateBinding(binding, timeline, safeTime);
    return effectCommands(blueprint, effect, region.geometry, binding, strength, safeTime, timeline);
  });
}

function pathRegion(context: CanvasRenderingContext2D, region: RegionGeometry, width: number, height: number): void {
  context.beginPath();
  if (region.kind === 'rect') {
    context.rect(region.x * width, region.y * height, region.width * width, region.height * height);
  } else {
    region.points.forEach((point, index) => {
      const x = point.x * width;
      const y = point.y * height;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.closePath();
  }
  context.clip();
}

function renderBackground(context: CanvasRenderingContext2D, blueprint: EditorBlueprint, assets: RenderAssets): void {
  const background = blueprint.background;
  if (background.kind === 'solid') {
    context.fillStyle = background.color;
    context.fillRect(0, 0, blueprint.width, blueprint.height);
  } else if (background.kind === 'gradient') {
    const angle = background.angleDeg * Math.PI / 180;
    const halfLength = Math.abs(blueprint.width * Math.cos(angle)) / 2 + Math.abs(blueprint.height * Math.sin(angle)) / 2;
    const centerX = blueprint.width / 2;
    const centerY = blueprint.height / 2;
    const gradient = context.createLinearGradient(centerX - Math.cos(angle) * halfLength, centerY - Math.sin(angle) * halfLength, centerX + Math.cos(angle) * halfLength, centerY + Math.sin(angle) * halfLength);
    gradient.addColorStop(0, background.from);
    gradient.addColorStop(1, background.to);
    context.fillStyle = gradient;
    context.fillRect(0, 0, blueprint.width, blueprint.height);
  } else {
    context.fillStyle = '#10131c';
    context.fillRect(0, 0, blueprint.width, blueprint.height);
    const image = assets[background.src];
    if (image) drawFittedImage(context, image, blueprint.width, blueprint.height, background.fit ?? 'contain');
  }
  for (const layer of blueprint.imageLayers ?? []) {
    const image = assets[layer.src];
    if (!image) continue;
    const sourceX = layer.crop?.x ?? 0;
    const sourceY = layer.crop?.y ?? 0;
    const sourceWidth = layer.crop?.width ?? layer.sourceWidth;
    const sourceHeight = layer.crop?.height ?? layer.sourceHeight;
    if (layer.fit === 'stretch') context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, layer.x, layer.y, layer.width, layer.height);
    else {
      const ratio = layer.fit === 'contain' ? Math.min(layer.width / sourceWidth, layer.height / sourceHeight) : Math.max(layer.width / sourceWidth, layer.height / sourceHeight);
      const targetWidth = sourceWidth * ratio;
      const targetHeight = sourceHeight * ratio;
      context.save();
      context.beginPath(); context.rect(layer.x, layer.y, layer.width, layer.height); context.clip();
      context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, layer.x + (layer.width - targetWidth) / 2, layer.y + (layer.height - targetHeight) / 2, targetWidth, targetHeight);
      context.restore();
    }
  }
}

function drawFittedImage(context: CanvasRenderingContext2D, image: CanvasImageSource, width: number, height: number, fit: 'contain' | 'cover' | 'stretch') {
  const sourceWidth = (image as { naturalWidth?: number; width?: number }).naturalWidth || (image as { width?: number }).width || width;
  const sourceHeight = (image as { naturalHeight?: number; height?: number }).naturalHeight || (image as { height?: number }).height || height;
  if (fit === 'stretch') { context.drawImage(image, 0, 0, width, height); return; }
  const ratio = fit === 'contain' ? Math.min(width / sourceWidth, height / sourceHeight) : Math.max(width / sourceWidth, height / sourceHeight);
  const targetWidth = sourceWidth * ratio; const targetHeight = sourceHeight * ratio;
  context.save(); context.beginPath(); context.rect(0, 0, width, height); context.clip();
  context.drawImage(image, (width - targetWidth) / 2, (height - targetHeight) / 2, targetWidth, targetHeight); context.restore();
}

export function renderEditorFrame(
  context: CanvasRenderingContext2D,
  blueprint: EditorBlueprint,
  timeline: FeatureTimeline,
  timeMs: number,
  assets: RenderAssets = {},
): EditorDrawCommand[] {
  validateBlueprint(blueprint);
  context.clearRect(0, 0, blueprint.width, blueprint.height);
  renderBackground(context, blueprint, assets);
  const commands = evaluateEditorFrame(blueprint, timeline, timeMs);
  for (const command of commands) {
    if ((command.kind === 'ink-diffusion' || command.kind === 'ink-flow' || command.kind === 'color-mixing') && command.inkPayload) {
      // WebGL draws into a rectangular offscreen surface, so apply the same
      // Region clip used by Canvas commands while compositing that surface.
      context.save();
      pathRegion(context, command.region, blueprint.width, blueprint.height);
      let rendered: boolean;
      try {
        rendered = renderInkDiffusion(context, command.inkPayload, command.x, command.y, command.width, command.height, blueprint.width, blueprint.height, command.opacity);
      } finally {
        context.restore();
      }
      if (rendered) continue;
      for (const fallback of command.fallbackCommands ?? []) drawCanvasCommand(context, fallback, blueprint.width, blueprint.height);
      continue;
    }
    drawCanvasCommand(context, command, blueprint.width, blueprint.height);
  }
  context.globalAlpha = 1;
  return commands;
}

function drawCanvasCommand(context: CanvasRenderingContext2D, command: EditorDrawCommand, blueprintWidth: number, blueprintHeight: number): void {
    context.save();
    pathRegion(context, command.region, blueprintWidth, blueprintHeight);
    const centerX = command.x + command.width / 2;
    const centerY = command.y + command.height / 2;
    if (command.rotationRad || command.scale !== undefined || command.moveX || command.moveY) {
      context.translate(centerX + (command.moveX ?? 0), centerY + (command.moveY ?? 0));
      if (command.rotationRad) context.rotate(command.rotationRad);
      if (command.scale !== undefined) context.scale(command.scale, command.scale);
      context.translate(-centerX, -centerY);
    }
    context.globalAlpha = command.opacity;
    const colorStyle = command.colorGradient ? createCanvasGradient(context, command.colorGradient, blueprintWidth, blueprintHeight) : command.color;
    context.fillStyle = colorStyle;
    if (command.shadowBlur) {
      context.shadowColor = command.colorGradient?.middleColor ?? command.color;
      context.shadowBlur = command.shadowBlur;
    }
    if (command.kind === 'path') {
      const points = command.pathPoints ?? [];
      const first = points[0];
      if (!first) { context.restore(); return; }
      context.beginPath();
      context.moveTo(first.x, first.y);
      if (command.closed !== false && (command.smoothness ?? 0) > 0 && points.length >= 4) {
        const tension = Math.min(1, Math.max(0, command.smoothness ?? 0));
        for (let index = 0; index < points.length; index += 1) {
          const p0 = points[(index - 1 + points.length) % points.length]!;
          const p1 = points[index]!;
          const p2 = points[(index + 1) % points.length]!;
          const p3 = points[(index + 2) % points.length]!;
          context.bezierCurveTo(p1.x + (p2.x - p0.x) * tension / 6, p1.y + (p2.y - p0.y) * tension / 6, p2.x - (p3.x - p1.x) * tension / 6, p2.y - (p3.y - p1.y) * tension / 6, p2.x, p2.y);
        }
        context.closePath();
      } else {
        points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
        if (command.closed !== false) context.closePath();
      }
      if (command.fillPath) context.fill();
      else {
        context.strokeStyle = colorStyle;
        context.lineWidth = command.lineWidth ?? 1;
        context.stroke();
      }
    } else if (command.kind === 'circle') {
      context.beginPath();
      context.ellipse(command.x + command.width / 2, command.y + command.height / 2, command.width / 2, command.height / 2, 0, 0, Math.PI * 2);
      if (command.strokeOnly) { context.strokeStyle = colorStyle; context.lineWidth = command.lineWidth ?? 1; context.stroke(); }
      else context.fill();
    } else if (command.kind === 'rect') context.fillRect(command.x, command.y, command.width, command.height);
    context.restore();
}

function createCanvasGradient(context: CanvasRenderingContext2D, gradient: GlobalGradient, width: number, height: number): CanvasGradient {
  const angle = gradient.angleDeg * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const halfLength = (Math.abs(width * cosine) + Math.abs(height * sine)) / 2;
  const centerX = width / 2;
  const centerY = height / 2;
  const fill = context.createLinearGradient(centerX - cosine * halfLength, centerY - sine * halfLength, centerX + cosine * halfLength, centerY + sine * halfLength);
  fill.addColorStop(0, gradient.startColor);
  fill.addColorStop(0.5, gradient.middleColor);
  fill.addColorStop(1, gradient.endColor);
  return fill;
}
