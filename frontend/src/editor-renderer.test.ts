import { describe, expect, it, vi } from 'vitest';
import { demoTimeline, initialEditorBlueprint, validateBlueprint } from './editor-model';
import type { BindingSource, EditorBlueprint, Effect } from './editor-model';
import { evaluateBinding, evaluateEditorFrame, renderEditorFrame } from './renderer';

const { renderInkMock } = vi.hoisted(() => ({ renderInkMock: vi.fn(() => false) }));
vi.mock('./ink-webgl', () => ({ renderInkDiffusion: renderInkMock }));

function fakeContext() {
  const fills: Array<{ style: string | CanvasGradient | CanvasPattern; alpha: number }> = [];
  let draws = 0;
  const clips: string[] = [];
  const paintedClipPaths: Array<string | null> = [];
  const imageClipPaths: Array<string | null> = [];
  const imageDrawArgs: unknown[][] = [];
  const ellipses: Array<{ x: number; y: number; radiusX: number; radiusY: number; alpha: number }> = [];
  const stateStack: Array<string | null> = [];
  let path = '';
  let activeClip: string | null = null;
  let fillStyle: string | CanvasGradient | CanvasPattern = '';
  let globalAlpha = 1;
  const context = {
    get fillStyle() { return fillStyle; }, set fillStyle(value: string | CanvasGradient | CanvasPattern) { fillStyle = value; },
    get globalAlpha() { return globalAlpha; }, set globalAlpha(value: number) { globalAlpha = value; },
    shadowColor: '', shadowBlur: 0,
    clearRect() {}, fillRect() { draws += 1; fills.push({ style: fillStyle, alpha: globalAlpha }); if (activeClip) paintedClipPaths.push(activeClip); },
    createLinearGradient() { return { addColorStop() {} } as CanvasGradient; },
    drawImage(...args: unknown[]) { fills.push({ style: 'image', alpha: globalAlpha }); imageClipPaths.push(activeClip); imageDrawArgs.push(args); },
    beginPath() { path = ''; }, rect(x: number, y: number, width: number, height: number) { path += `rect:${x},${y},${width},${height}`; },
    moveTo(x: number, y: number) { path += `move:${x},${y}`; }, lineTo(x: number, y: number) { path += `line:${x},${y}`; }, bezierCurveTo() { path += ':curve'; }, closePath() { path += ':close'; },
    clip() { clips.push(path); activeClip = path; }, save() { stateStack.push(activeClip); }, restore() { activeClip = stateStack.pop() ?? null; }, translate() {}, rotate() {}, scale() {}, ellipse(x: number, y: number, radiusX: number, radiusY: number) { ellipses.push({ x, y, radiusX, radiusY, alpha: globalAlpha }); }, fill() { draws += 1; if (activeClip) paintedClipPaths.push(activeClip); }, stroke() { draws += 1; if (activeClip) paintedClipPaths.push(activeClip); }, strokeRect() {}, setLineDash() {},
  } as unknown as CanvasRenderingContext2D;
  return { context, fills, clips, paintedClipPaths, imageClipPaths, imageDrawArgs, ellipses, get draws() { return draws; } };
}

function allEffectsBlueprint(): EditorBlueprint {
  const blueprint = structuredClone(initialEditorBlueprint);
  blueprint.effects = [
    { id: 'pulse', kind: 'pulse-scale', regionId: 'region-stage', color: '#ffffff', baseScale: 0.2, maxScale: 1 },
    { id: 'glow', kind: 'glow-brightness', regionId: 'region-stage', color: '#ffccaa', blurPx: 20, brightness: 1.4 },
    { id: 'move', kind: 'rotation-movement', regionId: 'region-stage', color: '#aabbcc', rotationDeg: 30, moveX: 0.1, moveY: -0.1 },
    { id: 'particles', kind: 'particles', regionId: 'region-stage', color: '#ccddff', count: 8, sizePx: 5, cycleMs: 1000 },
    { id: 'bars', kind: 'waveform-bars', regionId: 'region-accent', color: '#aaffcc', bars: 12, lineWidth: 0.5 },
    { id: 'radial', kind: 'radial-bars', regionId: 'region-accent', color: '#88ddff', centerX: 0.5, centerY: 0.5, radius: 0.2, bars: 32, barLength: 0.18, lineWidth: 0.6 },
    { id: 'ring', kind: 'wave-ring', regionId: 'region-stage', color: '#ff88cc', centerX: 0.5, centerY: 0.5, radius: 0.28, amplitude: 0.1, points: 64, lineWidth: 0.012 },
  ];
  blueprint.bindings = blueprint.effects.map((effect, index) => ({
    id: `binding-${effect.id}`, effectId: effect.id,
    source: index === 0 ? 'kick.events' as const : 'bass.envelope' as const,
    strength: 0.8, threshold: 0.05, attackMs: 40, releaseMs: 220,
  }));
  return blueprint;
}

describe('editor renderer', () => {
  it('renders all three Ink effects independently in order with deterministic mode payloads', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects = [
      { id: 'ink-cloud', kind: 'ink-diffusion', regionId: 'region-stage', color: '#8855cc', opacity: 0.5, visibilityMode: 'always' },
      { id: 'ink-stream', kind: 'ink-flow', regionId: 'region-stage', color: '#38bdf8', opacity: 0.7, visibilityMode: 'always', flowStrength: 0.95 },
      { id: 'ink-pigment', kind: 'color-mixing', regionId: 'region-stage', color: '#8b5cf6', colorMode: 'custom', customPalette: ['#12aacc', '#8855cc', '#ee5588', '#ffaa33'], opacity: 0.9, visibilityMode: 'always', cloudScale: 0.9 },
    ];
    blueprint.bindings = blueprint.effects.map((effect, index) => ({ id: `binding-${effect.id}`, effectId: effect.id, source: index === 1 ? 'vocals.envelope' as const : 'music.energy' as const, strength: 0.8, threshold: 0, attackMs: 0, releaseMs: 100 }));
    const first = evaluateEditorFrame(blueprint, demoTimeline, 2500);
    expect(first.map((command) => command.kind)).toEqual(['ink-diffusion', 'ink-flow', 'color-mixing']);
    expect(first.map((command) => command.inkPayload?.effectKind)).toEqual(['ink-diffusion', 'ink-flow', 'color-mixing']);
    expect(first[2]?.inkPayload?.paletteColors).toEqual(['#12aacc', '#8855cc', '#ee5588', '#ffaa33']);
    expect(new Set(first[2]?.fallbackCommands?.map((command) => command.color))).toEqual(new Set(['#12aacc', '#8855cc', '#ee5588', '#ffaa33']));
    expect(first.map((command) => command.opacity)).toEqual([0.5, 0.7, 0.9]);
    evaluateEditorFrame(blueprint, demoTimeline, 8100);
    expect(evaluateEditorFrame(blueprint, demoTimeline, 2500)).toEqual(first);
    const surface = fakeContext();
    renderInkMock.mockReturnValue(false);
    renderEditorFrame(surface.context, blueprint, demoTimeline, 2500);
    expect(surface.paintedClipPaths.length).toBeGreaterThan(0);
    expect(surface.paintedClipPaths.every((path) => path?.includes('rect:'))).toBe(true);
  });

  it('rejects invalid Color Mixing palettes and leaves legacy single-color Ink valid', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    const mixing: Extract<Effect, { kind: 'color-mixing' }> = { id: 'palette', kind: 'color-mixing', regionId: 'region-stage', color: '#8855cc', customPalette: ['#12aacc', '#8855cc'] };
    blueprint.effects = [mixing];
    blueprint.bindings = [{ id: 'palette-binding', effectId: mixing.id, source: 'music.energy', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 }];
    expect(() => validateBlueprint(blueprint)).not.toThrow();
    for (const customPalette of [['#ffffff'], ['#ffffff', '#000000', '#123456', '#abcdef', '#00ff00'], ['red', '#ffffff']]) {
      const invalid = structuredClone(blueprint);
      (invalid.effects[0] as Extract<Effect, { kind: 'color-mixing' }>).customPalette = customPalette;
      expect(() => validateBlueprint(invalid)).toThrow(/custom palette/i);
    }
    delete mixing.customPalette;
    expect(() => validateBlueprint(blueprint)).not.toThrow();
  });

  it('keeps WebGL Ink compositing inside the assigned Polygon or Rectangle Region', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    const ink = { id: 'clip-ink', kind: 'ink-diffusion' as const, regionId: 'ink-region', color: '#8855cc', diffusionSpeed: 0.25, flowStrength: 0.4, turbulence: 0.3, inkDensity: 0.65, cloudScale: 0.5, responseTime: 3, opacity: 0.5, visibilityMode: 'always' as const };
    blueprint.effects = [ink];
    blueprint.bindings = [{ id: 'clip-ink-binding', effectId: ink.id, source: 'music.energy', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 }];
    const regions = [
      { kind: 'polygon' as const, points: [{ x: 0.5, y: 0.12 }, { x: 0.88, y: 0.5 }, { x: 0.5, y: 0.88 }, { x: 0.12, y: 0.5 }] },
      { kind: 'rect' as const, x: 0.2, y: 0.25, width: 0.6, height: 0.5 },
    ];
    for (const geometry of regions) {
      blueprint.regions = [{ id: 'ink-region', name: 'Ink Region', geometry }];
      const surface = fakeContext();
      renderInkMock.mockImplementation((context?: CanvasRenderingContext2D) => {
        context?.drawImage({} as CanvasImageSource, 0, 0);
        return true;
      });
      try {
        const commands = renderEditorFrame(surface.context, blueprint, demoTimeline, 1200);
        expect(commands).toHaveLength(1);
        const webglArguments = renderInkMock.mock.calls.at(-1) as unknown as [unknown, unknown, number, number, number, number, number, number, number];
        expect(webglArguments.slice(2, 8)).toEqual([commands[0]!.x, commands[0]!.y, commands[0]!.width, commands[0]!.height, blueprint.width, blueprint.height]);
        expect(surface.imageClipPaths).toHaveLength(1);
        expect(surface.imageClipPaths[0]).toContain(geometry.kind === 'polygon' ? 'move:' : 'rect:');
        if (geometry.kind === 'polygon') expect(surface.imageClipPaths[0]).toContain(':close');
        const fallbackSurface = fakeContext();
        renderInkMock.mockReturnValue(false);
        const fallbackCommands = renderEditorFrame(fallbackSurface.context, blueprint, demoTimeline, 1200);
        expect(fallbackCommands[0]?.fallbackCommands?.length).toBeGreaterThan(0);
        expect(fallbackSurface.paintedClipPaths.length).toBeGreaterThan(0);
        expect(fallbackSurface.paintedClipPaths.every((path) => path?.includes(geometry.kind === 'polygon' ? 'move:' : 'rect:'))).toBe(true);
      } finally {
        renderInkMock.mockReturnValue(false);
      }
    }
  });

  it('uses complete Stage and Rectangle bounds for Ink render commands', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    const ink = { id: 'bounds-ink', kind: 'ink-diffusion' as const, regionId: 'region-stage', color: '#8855cc', visibilityMode: 'always' as const };
    blueprint.effects = [ink];
    blueprint.bindings = [{ id: 'bounds-ink-binding', effectId: ink.id, source: 'music.energy', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 }];
    const stage = evaluateEditorFrame(blueprint, demoTimeline, 1200)[0]!;
    expect([stage.x, stage.y, stage.width, stage.height]).toEqual([0.12 * blueprint.width, 0.14 * blueprint.height, 0.76 * blueprint.width, 0.72 * blueprint.height]);

    const rectangles = [
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    ];
    for (const geometry of rectangles) {
      blueprint.regions = [{ id: 'region-stage', name: 'Test Rectangle', geometry: { kind: 'rect', ...geometry } }];
      const command = evaluateEditorFrame(blueprint, demoTimeline, 1200)[0]!;
      expect([command.x, command.y, command.width, command.height]).toEqual([geometry.x * blueprint.width, geometry.y * blueprint.height, geometry.width * blueprint.width, geometry.height * blueprint.height]);
    }
  });

  it('expands a seeded central Ink core across its Region with deterministic response and Canvas fallback', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    const ink = { id: 'ink', kind: 'ink-diffusion' as const, regionId: 'region-stage', color: '#8855cc', colorMode: 'global-gradient' as const, diffusionSpeed: 0.25, flowStrength: 0.4, turbulence: 0.3, inkDensity: 0.65, cloudScale: 0.5, responseTime: 3, opacity: 0.8, visibilityMode: 'always' as const, audioReactive: true };
    blueprint.effects = [ink];
    blueprint.bindings = [{ id: 'ink-binding', effectId: ink.id, source: 'music.energy', strength: 1, threshold: 0, attackMs: 0, releaseMs: 100 }];
    const timeline = { durationMs: 10000, bassEnvelope: [{ timeMs: 0, value: 0 }], kickEvents: [], musicEnergy: [{ timeMs: 0, value: 0 }, { timeMs: 1000, value: 1 }, { timeMs: 10000, value: 0.7 }] };
    const still = evaluateEditorFrame(blueprint, timeline, 1200);
    expect(still).toHaveLength(1);
    expect(still[0]?.kind).toBe('ink-diffusion');
    expect(still[0]?.inkPayload).toMatchObject({ diffusionSpeed: 0.25, flowStrength: 0.4, turbulence: 0.3, inkDensity: 0.65, cloudScale: 0.5, response: expect.any(Number), diffusion: expect.any(Number) });
    expect(still[0]?.inkPayload?.gradient).toEqual(blueprint.globalGradient);
    expect(still[0]?.fallbackCommands).toHaveLength(13);
    expect(still[0]?.fallbackCommands?.slice(0, 8).every((command) => command.pathPoints?.length === 48)).toBe(true);
    expect(still[0]?.fallbackCommands?.slice(8).every((command) => command.pathPoints?.length === 36)).toBe(true);
    expect(still[0]?.opacity).toBeCloseTo(0.8);
    expect(still[0]?.fallbackCommands?.every((command) => command.opacity > 0 && command.opacity < 0.3)).toBe(true);
    const later = evaluateEditorFrame(blueprint, timeline, 4200);
    expect(later).not.toEqual(still);
    const quietTimeline = { ...timeline, musicEnergy: [{ timeMs: 0, value: 0 }, { timeMs: 10000, value: 0 }] };
    const loudCommands = evaluateEditorFrame(blueprint, timeline, 5000);
    const quietCommands = evaluateEditorFrame(blueprint, quietTimeline, 5000);
    expect(loudCommands[0]!.inkPayload?.response).toBeGreaterThan(quietCommands[0]!.inkPayload?.response ?? 0);
    const canvas = fakeContext();
    renderEditorFrame(canvas.context, blueprint, timeline, 1200);
    expect(canvas.clips).toHaveLength(14);
    expect(canvas.paintedClipPaths).toHaveLength(13);
    const bounds = (commands: typeof still) => {
      const points = commands.flatMap((command) => command.fallbackCommands ?? []).flatMap((command) => command.pathPoints ?? []);
      return { width: Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x)), height: Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y)) };
    };
    const atStart = bounds(evaluateEditorFrame(blueprint, quietTimeline, 0));
    const atThreeSeconds = bounds(evaluateEditorFrame(blueprint, quietTimeline, 3000));
    const atEightSeconds = bounds(evaluateEditorFrame(blueprint, quietTimeline, 8000));
    expect(atThreeSeconds.width).toBeGreaterThan(atStart.width);
    expect(atEightSeconds.width).toBeGreaterThan(atThreeSeconds.width);
    const regionBounds = blueprint.regions.find((region) => region.id === ink.regionId)!.geometry;
    if (regionBounds.kind !== 'rect') throw new Error('expected ink Region rect');
    const regionWidth = regionBounds.width * blueprint.width;
    expect(atEightSeconds.width).toBeGreaterThan(regionWidth * 0.6);
    const loudBounds = bounds(evaluateEditorFrame(blueprint, timeline, 5000));
    const quietBounds = bounds(evaluateEditorFrame(blueprint, quietTimeline, 5000));
    expect(loudBounds.width).toBeGreaterThan(quietBounds.width);
    expect(loudBounds.height).toBeGreaterThan(quietBounds.height);
    evaluateEditorFrame(blueprint, timeline, 2000);
    expect(evaluateEditorFrame(blueprint, timeline, 1200)).toEqual(still);
    const triggered = structuredClone(blueprint);
    triggered.effects[0]!.visibilityMode = 'triggered';
    expect(evaluateEditorFrame(triggered, timeline, 0)).toHaveLength(0);
    const earlyTrigger = evaluateEditorFrame(triggered, timeline, 2000);
    const establishedTrigger = evaluateEditorFrame(triggered, timeline, 5000);
    expect(establishedTrigger).toHaveLength(1);
    expect(establishedTrigger[0]!.opacity).toBeGreaterThan(earlyTrigger[0]!.opacity);
    (triggered.effects[0] as Extract<Effect, { kind: 'ink-diffusion' }>).audioReactive = false;
    (triggered.effects[0] as Extract<Effect, { kind: 'ink-diffusion' }>).visibilityMode = 'always';
    expect(evaluateEditorFrame(triggered, timeline, 5000)).toHaveLength(1);
    (triggered.effects[0] as Extract<Effect, { kind: 'ink-diffusion' }>).responseTime = 10;
    expect(() => validateBlueprint(triggered)).not.toThrow();
    (triggered.effects[0] as Extract<Effect, { kind: 'ink-diffusion' }>).responseTime = 10.1;
    expect(() => validateBlueprint(triggered)).toThrow(/ink diffusion/i);
  });

  it('uses each assigned rectangular and polygon Region as the primary geometry bounds', () => {
    const kinds: Effect[] = [
      { id: 'pulse', kind: 'pulse-scale', regionId: 'coverage', color: '#ffffff', baseScale: 0.8, maxScale: 1.2 },
      { id: 'glow', kind: 'glow-brightness', regionId: 'coverage', color: '#ffffff', blurPx: 12, brightness: 1.2, glowIntensity: 0.8 },
      { id: 'movement', kind: 'rotation-movement', regionId: 'coverage', color: '#ffffff', rotationDeg: 25, moveX: 0, moveY: 0 },
      { id: 'particles', kind: 'particles', regionId: 'coverage', color: '#ffffff', count: 32, sizePx: 4, cycleMs: 900, spread: 0.92 },
      { id: 'wave-bars', kind: 'waveform-bars', regionId: 'coverage', color: '#ffffff', bars: 16, lineWidth: 0.82 },
      { id: 'wave-line', kind: 'waveform-line', regionId: 'coverage', color: '#ffffff', orientation: 'horizontal', sampleCount: 64, amplitudeScale: 1.8, lineWidth: 0.01, glowIntensity: 0.4 },
      { id: 'peak-bars', kind: 'waveform-peak-bars', regionId: 'coverage', color: '#ffffff', bars: 16, barWidth: 0.8, spacing: 0.08, amplitudeScale: 1.8, glowIntensity: 0.4 },
      { id: 'spectrum-bars', kind: 'spectrum-bars', regionId: 'coverage', color: '#ffffff', barWidth: 0.9, spacing: 0.08, amplitudeScale: 1.8, glowIntensity: 0.4, segmented: false },
      { id: 'spectrum-line', kind: 'spectrum-line', regionId: 'coverage', color: '#ffffff', amplitudeScale: 1.8, lineWidth: 0.01, smoothing: 0.4, glowIntensity: 0.4 },
      { id: 'waveform-ring', kind: 'waveform-ring', regionId: 'coverage', color: '#ffffff', radius: 0.4, sampleCount: 96, amplitudeScale: 1.8, lineWidth: 0.01, smoothing: 0.5, glowIntensity: 0.4 },
      { id: 'radial', kind: 'radial-bars', regionId: 'coverage', color: '#ffffff', centerX: 0.5, centerY: 0.5, radius: 0.35, bars: 32, barLength: 0.2, lineWidth: 0.4, barWidth: 0.4, spikeSharpness: 0.6, innerRadius: 0.12, amplitudeScale: 1.6, glowIntensity: 0.4 },
      { id: 'wave-ring', kind: 'wave-ring', regionId: 'coverage', color: '#ffffff', centerX: 0.5, centerY: 0.5, radius: 0.35, amplitude: 0.15, points: 64, sampleCount: 96, lineWidth: 0.01, amplitudeScale: 2, layerCount: 1 },
      { id: 'burst', kind: 'particle-burst', regionId: 'coverage', color: '#ffffff', originX: 0.5, originY: 0.5, directionDeg: 0, spreadDeg: 360, speedPxPerSec: 500, lifetimeMs: 1200, count: 32, sizePx: 4, swirl: 0.55 },
      { id: 'trail', kind: 'particle-trail', regionId: 'coverage', color: '#ffffff', samples: 32, trailMs: 1000, sizePx: 4, amplitude: 0.4, lengthScale: 1 },
      { id: 'ripple', kind: 'ripple', regionId: 'coverage', color: '#ffffff', centerX: 0.5, centerY: 0.5, waves: 3, periodMs: 1200, radius: 0.45, amplitude: 0.1, lineWidth: 0.01, visibilityMode: 'always' },
      { id: 'shockwave', kind: 'shockwave', regionId: 'coverage', color: '#ffffff', centerX: 0.5, centerY: 0.5, maxRadius: 0.5, lifetimeMs: 1200, lineWidth: 0.01 },
      { id: 'oscilloscope', kind: 'oscilloscope-line', regionId: 'coverage', color: '#ffffff', orientation: 'horizontal', lineWidth: 0.01, sampleCount: 96, amplitudeScale: 1, glowIntensity: 0.4 },
      { id: 'ink', kind: 'ink-diffusion', regionId: 'coverage', color: '#ffffff', visibilityMode: 'always', diffusionSpeed: 0.25, flowStrength: 0.4, turbulence: 0.3, inkDensity: 0.65, cloudScale: 0.5, responseTime: 3 },
      { id: 'flow', kind: 'ink-flow', regionId: 'coverage', color: '#ffffff', visibilityMode: 'always', flowStrength: 0.95 },
      { id: 'mixing', kind: 'color-mixing', regionId: 'coverage', color: '#ffffff', visibilityMode: 'always', cloudScale: 0.9 },
    ];
    const timeline = {
      durationMs: 3000,
      bassEnvelope: Array.from({ length: 151 }, (_, index) => ({ timeMs: index * 20, value: 0.5 + 0.5 * Math.sin(index * 0.19) })),
      kickEvents: [0], kickEventStrengths: [1],
      musicEnergy: Array.from({ length: 151 }, (_, index) => ({ timeMs: index * 20, value: 0.8 })),
      waveformPeaks: { sampleIntervalMs: 20 as const, windowSamples: 882 as const, normalization: 'signed-full-scale' as const, music: Array.from({ length: 150 }, () => ({ min: -0.4, max: 0.4 })), drums: Array.from({ length: 150 }, () => ({ min: -0.5, max: 0.5 })), bass: Array.from({ length: 150 }, (_, index) => ({ min: -0.85 + 0.06 * Math.sin(index), max: 0.85 + 0.06 * Math.cos(index) })), vocals: Array.from({ length: 150 }, () => ({ min: -0.3, max: 0.3 })), other: Array.from({ length: 150 }, () => ({ min: -0.2, max: 0.2 })) },
      frequencySpectrum: { hopMs: 20 as const, fftSize: 4096 as const, bandCount: 32 as const, sampleRateHz: 44100, minHz: 40, maxHz: 16000, normalization: 'whole-clip-p99-log-rms' as const, encoding: 'uint8-linear-0-255' as const, values: Array.from({ length: 150 * 32 }, (_, index) => Math.round((index % 32) / 31 * 200)) },
    };
    const geometries = [
      { kind: 'rect' as const, x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
      { kind: 'polygon' as const, points: [{ x: 0.5, y: 0.2 }, { x: 0.8, y: 0.5 }, { x: 0.5, y: 0.8 }, { x: 0.2, y: 0.5 }] },
    ];
    for (const geometry of geometries) {
      const width = geometry.kind === 'rect' ? geometry.width : 0.6;
      const height = geometry.kind === 'rect' ? geometry.height : 0.6;
      for (const effect of kinds) {
        const blueprint = structuredClone(initialEditorBlueprint);
        blueprint.regions = [{ id: 'coverage', name: 'Coverage', geometry }];
        blueprint.effects = [effect];
        const source = effect.kind === 'particle-burst' || effect.kind === 'shockwave' ? 'kick.events' as const : ['ink-diffusion', 'ink-flow', 'color-mixing'].includes(effect.kind) ? 'music.energy' as const : 'bass.envelope' as const;
        blueprint.bindings = [{ id: `binding-${effect.id}`, effectId: effect.id, source, strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 }];
        const commands = evaluateEditorFrame(blueprint, timeline, 750);
        evaluateEditorFrame(blueprint, timeline, 1750);
        expect(evaluateEditorFrame(blueprint, timeline, 750), `${geometry.kind} ${effect.kind} deterministic seek`).toEqual(commands);
        const paths = commands.flatMap((command) => ['ink-diffusion', 'ink-flow', 'color-mixing'].includes(command.kind) ? command.fallbackCommands ?? [] : [command]);
        expect(paths.length, `${geometry.kind} ${effect.kind} should produce geometry`).toBeGreaterThan(0);
        const points = paths.flatMap((command) => command.pathPoints ?? []);
        const xMin = Math.min(...paths.map((command) => command.pathPoints?.length ? Infinity : command.x), ...points.map((point) => point.x));
        const xMax = Math.max(...paths.map((command) => command.pathPoints?.length ? -Infinity : command.x + command.width), ...points.map((point) => point.x));
        const yMin = Math.min(...paths.map((command) => command.pathPoints?.length ? Infinity : command.y), ...points.map((point) => point.y));
        const yMax = Math.max(...paths.map((command) => command.pathPoints?.length ? -Infinity : command.y + command.height), ...points.map((point) => point.y));
        expect(xMax - xMin, `${geometry.kind} ${effect.kind} width`).toBeGreaterThan(blueprint.width * width * 0.42);
        expect(yMax - yMin, `${geometry.kind} ${effect.kind} height`).toBeGreaterThan(blueprint.height * height * 0.24);
        const canvas = fakeContext();
        renderEditorFrame(canvas.context, blueprint, timeline, 750);
        expect(canvas.clips.length, `${geometry.kind} ${effect.kind} clip`).toBeGreaterThan(0);
      }
    }
  });

  it('applies common opacity and renders layered Wave Ring with deterministic phase offsets', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    const ring = { id: 'layered-ring', kind: 'wave-ring' as const, regionId: 'region-stage', color: '#ffffff', centerX: 0.5, centerY: 0.5, radius: 0.24, amplitude: 0.1, points: 64, sampleCount: 48, lineWidth: 0.01, layerCount: 4, layerRadiusStep: 0.02, layerAngleOffsetDeg: 0, layerAmplitudeDecay: 0.8, opacity: 0.5 };
    blueprint.effects = [ring];
    blueprint.bindings = [{ id: 'layered-binding', effectId: ring.id, source: 'bass.envelope', strength: 0.8, threshold: 0, attackMs: 0, releaseMs: 0 }];
    const first = evaluateEditorFrame(blueprint, demoTimeline, 1200);
    expect(first).toHaveLength(4);
    expect(first.every((command) => command.opacity <= 0.5)).toBe(true);
    expect(first.every((command) => command.opacity >= 0)).toBe(true);
    expect(first[0]?.pathPoints).not.toEqual(first[1]?.pathPoints);
    evaluateEditorFrame(blueprint, demoTimeline, 4000);
    expect(evaluateEditorFrame(blueprint, demoTimeline, 1200)).toEqual(first);
    ring.layerCount = 1;
    expect(evaluateEditorFrame(blueprint, demoTimeline, 1200)).toHaveLength(1);
    ring.opacity = 0;
    expect(evaluateEditorFrame(blueprint, demoTimeline, 1200).every((command) => command.opacity === 0)).toBe(true);
    ring.opacity = 1.1;
    expect(() => validateBlueprint(blueprint)).toThrow(/opacity/i);
  });

  it('uses 360/layerCount automatic offsets, ignores legacy radius steps, and honors manual offsets', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    const ring: Extract<Effect, { kind: 'wave-ring' }> = { id: 'offset-ring', kind: 'wave-ring', regionId: 'region-stage', color: '#ffffff', centerX: 0.5, centerY: 0.5, radius: 0.2, amplitude: 0, points: 16, sampleCount: 32, lineWidth: 0.01, layerCount: 1, layerRadiusStep: 0, layerAngleOffsetDeg: 0, layerAmplitudeDecay: 1 };
    blueprint.effects = [ring];
    blueprint.bindings = [{ id: 'offset-binding', effectId: ring.id, source: 'bass.envelope', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 }];
    const stageRect = blueprint.regions.find((region) => region.id === ring.regionId)!.geometry;
    if (stageRect.kind !== 'rect') throw new Error('expected stage rect');
    const stageCenterX = (stageRect.x + stageRect.width / 2) * blueprint.width;
    const stageCenterY = (stageRect.y + stageRect.height / 2) * blueprint.height;
    const offsetAt = (count: number, index: number) => {
      ring.layerCount = count;
      const path = evaluateEditorFrame(blueprint, demoTimeline, 900)[index]!.pathPoints![0]!;
      return (Math.atan2(path.y - stageCenterY, path.x - stageCenterX) * 180 / Math.PI + 360) % 360;
    };
    for (const count of [3, 4, 6, 10]) {
      ring.layerCount = count;
      expect(evaluateEditorFrame(blueprint, demoTimeline, 900)).toHaveLength(count);
      const step = 360 / count;
      expect(offsetAt(count, 1) - offsetAt(count, 0)).toBeCloseTo(step, 4);
    }
    ring.radius = 0.45;
    ring.layerRadiusStep = 0.1;
    const legacyStepLayers = evaluateEditorFrame(blueprint, demoTimeline, 900);
    const layerRadii = legacyStepLayers.map((command) => Math.hypot(command.pathPoints![0]!.x - stageCenterX, command.pathPoints![0]!.y - stageCenterY));
    expect(layerRadii.every((radius) => Math.abs(radius - layerRadii[0]!) < 1e-8)).toBe(true);
    ring.layerAngleOffsetDeg = 13;
    expect(offsetAt(4, 1) - offsetAt(4, 0)).toBeCloseTo(13, 4);
    ring.layerAngleOffsetDeg = 0;
    ring.layerCount = 10;
    ring.sampleCount = 256;
    const maximum = evaluateEditorFrame(blueprint, demoTimeline, 900);
    expect(maximum).toHaveLength(10);
    expect(maximum.every((command) => command.pathPoints?.length === 256)).toBe(true);
    ring.layerCount = 11;
    expect(() => validateBlueprint(blueprint)).toThrow(/wave ring/i);
  });

  it('rotates an asymmetric signal peak in final smoothed Canvas coordinates without phase cancellation', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    const ring = { id: 'asymmetric-ring', kind: 'wave-ring' as const, regionId: 'region-stage', color: '#ffffff', colorMode: 'global-gradient' as const, opacity: 0.7, centerX: 0.5, centerY: 0.5, radius: 0.2, amplitude: 0.2, points: 32, sampleCount: 32, lineWidth: 0.01, smoothing: 0.8, layerCount: 4, layerRadiusStep: 0.04, layerAngleOffsetDeg: 0, layerAmplitudeDecay: 1, rotationMode: 'continuous' as const, beatsPerRevolution: 8 as const, rotationDirection: 'clockwise' as const, initialAngleDeg: 19 };
    blueprint.effects = [ring];
    blueprint.bindings = [{ id: 'asymmetric-binding', effectId: ring.id, source: 'bass.envelope', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 }];
    const timeline = { durationMs: 1400, bpm: 120, bpmSource: 'fallback' as const, bassEnvelope: Array.from({ length: 141 }, (_, index) => ({ timeMs: index * 10, value: index === 95 ? 0.1 : 0.8 })), kickEvents: [] };
    const stage = blueprint.regions.find((region) => region.id === ring.regionId)!;
    if (stage.geometry.kind !== 'rect') throw new Error('expected stage rect');
    const centerX = (stage.geometry.x + stage.geometry.width / 2) * blueprint.width;
    const centerY = (stage.geometry.y + stage.geometry.height / 2) * blueprint.height;
    const canvasPathsAt = (timeMs: number) => {
      const paths: Array<Array<{ x: number; y: number }>> = [];
      let current: Array<{ x: number; y: number }> = [];
      const context = {
        globalAlpha: 1, shadowColor: '', shadowBlur: 0, fillStyle: '',
        clearRect() {}, fillRect() {}, createLinearGradient() { return { addColorStop() {} }; },
        save() {}, restore() {}, beginPath() { current = []; }, rect() {}, closePath() {}, clip() {},
        moveTo(x: number, y: number) { current.push({ x, y }); }, lineTo(x: number, y: number) { current.push({ x, y }); },
        bezierCurveTo(_x1: number, _y1: number, _x2: number, _y2: number, x: number, y: number) { current.push({ x, y }); },
        stroke() { if (current.length > 4) paths.push(current); }, fill() {}, translate() {}, rotate() {}, scale() {}, ellipse() {}, strokeRect() {}, setLineDash() {}, drawImage() {},
      } as unknown as CanvasRenderingContext2D;
      renderEditorFrame(context, blueprint, timeline, timeMs);
      return paths;
    };
    const anglesAt = (timeMs: number) => canvasPathsAt(timeMs).map((path) => {
      const featurePoint = path.reduce((minimum, point) => Math.hypot(point.x - centerX, point.y - centerY) < Math.hypot(minimum.x - centerX, minimum.y - centerY) ? point : minimum);
      return (Math.atan2(featurePoint.y - centerY, featurePoint.x - centerX) * 180 / Math.PI + 360) % 360;
    });
    const expectedBase = (90 + 19 + (120 * 360 / (60 * 8)) * 1.2) % 360;
    for (const [count, step] of [[3, 120], [4, 90], [6, 60], [10, 36]] as const) {
      ring.layerCount = count;
      const angles = anglesAt(1200);
      expect(angles).toHaveLength(count);
      angles.forEach((angle, index) => expect(angle).toBeCloseTo((expectedBase + index * step) % 360, 2));
      const commands = evaluateEditorFrame(blueprint, timeline, 1200);
      const radii = commands.map((command) => Math.hypot(command.pathPoints![0]!.x - centerX, command.pathPoints![0]!.y - centerY));
      radii.forEach((radius) => expect(radius).toBeCloseTo(radii[0]!, 8));
      expect(anglesAt(1200)).toEqual(angles);
      anglesAt(1900);
      expect(anglesAt(1200)).toEqual(angles);
    }
    ring.layerCount = 4;
    ring.layerAngleOffsetDeg = 13;
    const manual = anglesAt(1200);
    expect(manual[1]! - manual[0]!).toBeCloseTo(13, 2);
  });

  it('keeps basic forms visible in Always mode, disables Binding response when requested, and retains BPM rotation', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    const pulse = { id: 'always-pulse', kind: 'pulse-scale' as const, regionId: 'region-stage', color: '#ffffff', baseScale: 0.4, maxScale: 1, visibilityMode: 'always' as const, audioReactive: true };
    blueprint.effects = [pulse];
    blueprint.bindings = [{ id: 'always-pulse-binding', effectId: pulse.id, source: 'bass.envelope', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 }];
    const silent = { ...demoTimeline, bassEnvelope: demoTimeline.bassEnvelope.map((point) => ({ ...point, value: 0 })) };
    const silenceCommand = evaluateEditorFrame(blueprint, silent, 500)[0]!;
    const reactiveCommand = evaluateEditorFrame(blueprint, demoTimeline, 500)[0]!;
    expect(silenceCommand.opacity).toBeGreaterThan(0);
    expect(reactiveCommand.width).not.toBe(silenceCommand.width);
    pulse.audioReactive = false;
    expect(evaluateEditorFrame(blueprint, demoTimeline, 500)[0]).toEqual(silenceCommand);
    const invalid = structuredClone(blueprint);
    invalid.effects[0] = { ...pulse, visibilityMode: 'triggered' } as Effect;
    expect(() => validateBlueprint(invalid)).toThrow(/non-reactive/i);
    const radial = { id: 'always-rotating', kind: 'radial-bars' as const, regionId: 'region-stage', color: '#ffffff', centerX: 0.5, centerY: 0.5, radius: 0.2, bars: 16, barLength: 0.1, lineWidth: 0.4, rotationMode: 'continuous' as const, beatsPerRevolution: 8 as const, rotationDirection: 'clockwise' as const, initialAngleDeg: 0, visibilityMode: 'always' as const, audioReactive: false };
    blueprint.effects = [radial];
    blueprint.bindings = [{ id: 'always-rotating-binding', effectId: radial.id, source: 'bass.envelope', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 }];
    const angleAt = (time: number) => evaluateEditorFrame(blueprint, demoTimeline, time)[0]!.rotationRad;
    expect(angleAt(500)).not.toBe(angleAt(0));
  });

  it('uses static Always baselines for event Effects without inventing events or waveform peaks', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects = [
      { id: 'static-burst', kind: 'particle-burst', regionId: 'region-stage', color: '#ffffff', originX: 0.5, originY: 0.5, directionDeg: -90, spreadDeg: 120, speedPxPerSec: 100, lifetimeMs: 800, count: 8, sizePx: 5, visibilityMode: 'always' },
      { id: 'static-shock', kind: 'shockwave', regionId: 'region-stage', color: '#ffffff', centerX: 0.5, centerY: 0.5, maxRadius: 0.4, lifetimeMs: 800, lineWidth: 0.01, visibilityMode: 'always' },
      { id: 'missing-peak', kind: 'waveform-line', regionId: 'region-stage', color: '#ffffff', orientation: 'horizontal', sampleCount: 32, amplitudeScale: 1, lineWidth: 0.01, glowIntensity: 0, visibilityMode: 'always' },
    ];
    blueprint.bindings = blueprint.effects.map((effect) => ({ id: `bind-${effect.id}`, effectId: effect.id, source: 'kick.events' as const, strength: 1, threshold: 0.1, attackMs: 0, releaseMs: 100 }));
    const commands = evaluateEditorFrame(blueprint, { durationMs: 1000, bassEnvelope: [], kickEvents: [] }, 500);
    expect(commands).toHaveLength(10);
    expect(commands.slice(0, 8).every((command) => command.kind === 'circle' && command.opacity > 0)).toBe(true);
    expect(commands[8]?.strokeOnly).toBe(true);
    expect(commands[9]?.kind).toBe('path');
  });

  it('maps Waveform / Bars to the rectangular Stage and Pulse / Scale to the polygon Accent', () => {
    const blueprint = initialEditorBlueprint;
    const bars = blueprint.effects.find((effect) => effect.id === 'effect-bars');
    const pulse = blueprint.effects.find((effect) => effect.id === 'effect-pulse');
    const barsRegion = blueprint.regions.find((region) => region.id === bars?.regionId);
    const pulseRegion = blueprint.regions.find((region) => region.id === pulse?.regionId);
    expect(barsRegion?.geometry.kind).toBe('rect');
    expect(pulseRegion?.geometry.kind).toBe('polygon');
  });

  it('resolves shared gradient for opted-in effects and preserves legacy/custom colors', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    const effect = blueprint.effects[0]!;
    effect.colorMode = 'global-gradient';
    blueprint.effects = [effect];
    blueprint.bindings = blueprint.bindings.filter((binding) => binding.effectId === effect.id);
    const commands = evaluateEditorFrame(blueprint, demoTimeline, 500);
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((command) => command.colorGradient?.startColor === '#22d3ee')).toBe(true);
    effect.colorMode = 'custom';
    const custom = evaluateEditorFrame(blueprint, demoTimeline, 500);
    expect(custom.every((command) => command.colorGradient === undefined)).toBe(true);
    expect(custom.every((command) => command.color === effect.color)).toBe(true);
  });

  it('renders the three peak visualizers from signed source peaks and stays inactive without them', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects = [
      { id: 'wave-line-peak', kind: 'waveform-line', regionId: 'region-stage', color: '#ffffff', orientation: 'horizontal', sampleCount: 32, amplitudeScale: 1, lineWidth: 0.01, glowIntensity: 0 },
      { id: 'wave-bars-peak', kind: 'waveform-peak-bars', regionId: 'region-stage', color: '#ffffff', bars: 12, barWidth: 0.8, spacing: 0.1, amplitudeScale: 1, glowIntensity: 0 },
      { id: 'wave-ring-peak', kind: 'waveform-ring', regionId: 'region-stage', color: '#ffffff', radius: 0.25, sampleCount: 48, amplitudeScale: 1, lineWidth: 0.01, smoothing: 0.7, glowIntensity: 0 },
    ];
    blueprint.bindings = blueprint.effects.map((effect) => ({ id: `bind-${effect.id}`, effectId: effect.id, source: 'music.energy' as const, strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 }));
    const peaks = Array.from({ length: 600 }, (_, index) => ({ min: index % 2 ? -0.8 : -0.2, max: index % 2 ? 0.4 : 0.9 }));
    const timeline = { ...demoTimeline, waveformPeaks: { sampleIntervalMs: 20 as const, windowSamples: 882 as const, normalization: 'signed-full-scale' as const, music: peaks, drums: peaks, bass: peaks, vocals: peaks, other: peaks } };
    const commands = evaluateEditorFrame(blueprint, timeline, 1800);
    expect(commands).toHaveLength(14);
    const line = commands.find((command) => command.kind === 'path' && command.fillPath);
    const ring = commands.find((command) => command.kind === 'path' && command.smoothness === 0.7);
    expect(line?.pathPoints?.length).toBe(64);
    expect(ring?.pathPoints).toHaveLength(48);
    expect(evaluateEditorFrame(blueprint, timeline, 1800)).toEqual(commands);
    expect(evaluateEditorFrame(blueprint, demoTimeline, 1800)).toHaveLength(0);
    blueprint.effects = blueprint.effects.map((effect) => ({ ...effect, visibilityMode: 'always', audioReactive: false } as Effect));
    const fixedPeakFrame = evaluateEditorFrame(blueprint, timeline, 1000);
    expect(evaluateEditorFrame(blueprint, timeline, 5000)).toEqual(fixedPeakFrame);
  });

  it('renders FFT Spectrum Bars and Line from interpolated 32-band rows deterministically', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    const values = Array(3 * 32).fill(0) as number[];
    values[0] = 255;
    values[32 + 31] = 255;
    values[64 + 15] = 128;
    const timeline = {
      durationMs: 60, bassEnvelope: [{ timeMs: 0, value: 0 }, { timeMs: 60, value: 0 }], kickEvents: [],
      frequencySpectrum: { hopMs: 20 as const, fftSize: 4096 as const, bandCount: 32 as const, sampleRateHz: 44100, minHz: 40, maxHz: 16000, normalization: 'whole-clip-p99-log-rms' as const, encoding: 'uint8-linear-0-255' as const, values },
    };
    const bars = { id: 'spectrum-bars', kind: 'spectrum-bars' as const, regionId: 'region-stage', color: '#ffffff', barWidth: 0.8, spacing: 0.1, amplitudeScale: 1, glowIntensity: 0, segmented: false, attackMs: 0, releaseMs: 0, visibilityMode: 'always' as const, audioReactive: false };
    const line = { id: 'spectrum-line', kind: 'spectrum-line' as const, regionId: 'region-stage', color: '#ffffff', amplitudeScale: 1, lineWidth: 0.01, smoothing: 0.4, glowIntensity: 0, attackMs: 0, releaseMs: 0, visibilityMode: 'always' as const, audioReactive: false };
    blueprint.effects = [bars, line];
    blueprint.bindings = [bars, line].map((effect) => ({ id: `binding-${effect.id}`, effectId: effect.id, source: 'music.energy' as const, strength: 0.8, threshold: 0.1, attackMs: 50, releaseMs: 150 }));
    const commandsAt = (time: number) => evaluateEditorFrame(blueprint, timeline, time);
    const atZero = commandsAt(0);
    expect(atZero.filter((command) => command.kind === 'rect')).toHaveLength(32);
    expect(atZero.at(0)?.height).toBeGreaterThan(0);
    expect(atZero.at(31)?.height).toBe(0);
    const atTwenty = commandsAt(20);
    expect(atTwenty.at(0)?.height).toBe(0);
    expect(atTwenty.at(31)?.height).toBeGreaterThan(0);
    const lineCommand = atTwenty.find((command) => command.kind === 'path')!;
    expect(lineCommand.pathPoints).toHaveLength(32);
    expect(lineCommand.pathPoints![0]!.x).toBeLessThan(lineCommand.pathPoints![31]!.x);
    expect(commandsAt(40)).toEqual(commandsAt(40));
    commandsAt(0);
    expect(commandsAt(20)).toEqual(atTwenty);
    const missing = { ...timeline, frequencySpectrum: undefined };
    expect(evaluateEditorFrame(blueprint, missing, 20)).toEqual([]);
    expect(() => validateBlueprint({ ...blueprint, effects: [{ ...bars, segmented: 'yes' } as unknown as Effect] })).toThrow(/spectrum bars/i);
  });

  it('applies Spectrum attack and release envelopes without depending on seek order', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    const values = Array(3 * 32).fill(0) as number[];
    values[32 + 8] = 255;
    const timeline = { durationMs: 60, bassEnvelope: [{ timeMs: 0, value: 0 }, { timeMs: 60, value: 0 }], kickEvents: [], frequencySpectrum: { hopMs: 20 as const, fftSize: 4096 as const, bandCount: 32 as const, sampleRateHz: 44100, minHz: 40, maxHz: 16000, normalization: 'whole-clip-p99-log-rms' as const, encoding: 'uint8-linear-0-255' as const, values } };
    const effect = { id: 'smoothed-spectrum', kind: 'spectrum-line' as const, regionId: 'region-stage', color: '#ffffff', amplitudeScale: 1, lineWidth: 0.01, smoothing: 0, glowIntensity: 0, attackMs: 100, releaseMs: 500, visibilityMode: 'always' as const, audioReactive: false };
    blueprint.effects = [effect];
    blueprint.bindings = [{ id: 'smooth-binding', effectId: effect.id, source: 'bass.envelope', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 }];
    const at20 = evaluateEditorFrame(blueprint, timeline, 20);
    const at40 = evaluateEditorFrame(blueprint, timeline, 40);
    expect(at20).not.toEqual(at40);
    evaluateEditorFrame(blueprint, timeline, 60);
    expect(evaluateEditorFrame(blueprint, timeline, 20)).toEqual(at20);
  });

  it('converts continuous threshold crossings into bounded deterministic events', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects = [{ id: 'continuous-shock', kind: 'shockwave', regionId: 'region-stage', color: '#ffffff', centerX: 0.5, centerY: 0.5, maxRadius: 0.4, lifetimeMs: 1000, lineWidth: 0.01 }];
    blueprint.bindings = [{ id: 'continuous-shock-binding', effectId: 'continuous-shock', source: 'music.energy', strength: 1, threshold: 0.2, attackMs: 0, releaseMs: 0 }];
    const timeline = { durationMs: 1000, bassEnvelope: [{ timeMs: 0, value: 0 }], kickEvents: [], musicEnergy: [{ timeMs: 0, value: 0 }, { timeMs: 100, value: 0.8 }, { timeMs: 130, value: 0 }, { timeMs: 160, value: 0.9 }, { timeMs: 180, value: 0 }, { timeMs: 600, value: 0.7 }] };
    const frame = evaluateEditorFrame(blueprint, timeline, 650);
    expect(frame.filter((command) => command.kind === 'circle' && command.strokeOnly)).toHaveLength(2);
    evaluateEditorFrame(blueprint, timeline, 40);
    expect(evaluateEditorFrame(blueprint, timeline, 650)).toEqual(frame);
  });

  it.each([60, 120, 180].flatMap((bpm) => [4, 8, 16, 32].map((beats) => [bpm, beats] as const)))('synchronizes circular rotation at %i BPM per %i beats', (bpm, beats) => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects = [{ id: 'bpm-ring', kind: 'wave-ring', regionId: 'region-stage', color: '#ffffff', centerX: 0.5, centerY: 0.5, radius: 0.25, amplitude: 0, points: 16, lineWidth: 0.01, rotationMode: 'continuous', beatsPerRevolution: beats as 4 | 8 | 16 | 32, rotationDirection: 'clockwise', initialAngleDeg: 13 }];
    blueprint.bindings = [{ id: 'bpm-binding', effectId: 'bpm-ring', source: 'bass.envelope', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 }];
    const durationMs = Math.ceil(60_000 * beats / bpm) + 100;
    const timeline = { durationMs, bpm, bpmSource: 'kick-estimated' as const, bassEnvelope: [{ timeMs: 0, value: 0.5 }, { timeMs: durationMs, value: 0.5 }], kickEvents: [] };
    const periodMs = 60_000 * beats / bpm;
    const commandsAt = (time: number) => evaluateEditorFrame(blueprint, timeline, time)[0]!.pathPoints![0]!;
    const start = commandsAt(0);
    const half = commandsAt(periodMs / 2);
    const end = commandsAt(periodMs);
    expect(half.x).toBeCloseTo(2 * 320 - start.x, 4);
    expect(half.y).toBeCloseTo(2 * 180 - start.y, 4);
    expect(end.x).toBeCloseTo(start.x, 4);
    expect(end.y).toBeCloseTo(start.y, 4);
  });

  it('integrates triggered rotation deterministically across pause and arbitrary seek order', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects = [{ id: 'triggered-ring', kind: 'radial-bars', regionId: 'region-stage', color: '#ffffff', centerX: 0.5, centerY: 0.5, radius: 0.2, bars: 8, barLength: 0.1, lineWidth: 0.5, rotationMode: 'triggered', beatsPerRevolution: 8, rotationDirection: 'counterclockwise', initialAngleDeg: 27 }];
    blueprint.bindings = [{ id: 'triggered-binding', effectId: 'triggered-ring', source: 'bass.envelope', strength: 1, threshold: 0, attackMs: 40, releaseMs: 100 }];
    const timeline = { durationMs: 5000, bpm: 120, bpmSource: 'kick-estimated' as const, bassEnvelope: [{ timeMs: 0, value: 0 }, { timeMs: 1000, value: 1 }, { timeMs: 2500, value: 0.2 }, { timeMs: 5000, value: 0.8 }], kickEvents: [] };
    const angleAt = (time: number) => evaluateEditorFrame(blueprint, timeline, time)[0]!.rotationRad!;
    const atThreeSeconds = angleAt(3000);
    angleAt(1000); angleAt(4500); angleAt(0);
    expect(angleAt(3000)).toBe(atThreeSeconds);
    expect(angleAt(3000)).toBeLessThan((-27 * Math.PI) / 180 - Math.PI / 2);
  });

  it('renders all effect types inside their assigned normalized regions deterministically', () => {
    const blueprint = allEffectsBlueprint();
    const first = evaluateEditorFrame(blueprint, demoTimeline, 1450);
    evaluateEditorFrame(blueprint, demoTimeline, 9700);
    expect(evaluateEditorFrame(blueprint, demoTimeline, 1450)).toEqual(first);
    expect(first.filter((command) => command.kind === 'circle').length).toBeGreaterThan(0);
    expect(first.filter((command) => command.kind === 'circle').length).toBeLessThanOrEqual(8);
    expect(first.filter((command) => command.kind === 'rect').length).toBe(46);
    const ring = first.find((command) => command.kind === 'path');
    expect(ring?.pathPoints).toHaveLength(64);
    expect(new Set(ring?.pathPoints?.map((point) => `${point.x.toFixed(3)},${point.y.toFixed(3)}`)).size).toBeGreaterThan(16);
    expect(first.every((command) => command.region.kind === 'rect' || command.region.kind === 'polygon')).toBe(true);
    expect(first.some((command) => command.rotationRad !== undefined)).toBe(true);
    expect(first.some((command) => command.shadowBlur !== undefined)).toBe(true);
  });

  it('evaluates Bass and Kick bindings with deterministic attack, threshold, strength and release', () => {
    const bass = initialEditorBlueprint.bindings[0];
    const kick = initialEditorBlueprint.bindings[1];
    expect(bass).toBeDefined();
    expect(kick).toBeDefined();
    const bassValue = evaluateBinding(bass, demoTimeline, 1500);
    const kickValue = evaluateBinding(kick, demoTimeline, 1020);
    expect(bassValue).toBeGreaterThan(0);
    expect(bassValue).toBeLessThanOrEqual(0.9);
    expect(kickValue).toBeGreaterThan(0);
    expect(kickValue).toBeLessThanOrEqual(1);
    expect(evaluateBinding(kick, demoTimeline, 1020)).toBe(kickValue);
    expect(evaluateBinding(kick, demoTimeline, 5000)).toBeLessThan(kickValue);
  });

  it('separates Kick event strength loss in Binding threshold and strength controls', () => {
    const timeline = {
      ...demoTimeline,
      durationMs: 1000,
      kickEvents: [200],
      kickEventStrengths: [0.2],
    };
    const binding = {
      id: 'binding-kick-measure', effectId: 'effect-bars', source: 'kick.events' as const,
      strength: 0.9, threshold: 0.1, attackMs: 0, releaseMs: 260,
    };
    const normal = evaluateBinding(binding, timeline, 200);
    const aboveThreshold = evaluateBinding({ ...binding, threshold: 0.25 }, timeline, 200);
    const belowThreshold = evaluateBinding({ ...binding, threshold: 0.2 }, timeline, 200);
    const lowerStrength = evaluateBinding({ ...binding, strength: 0.45 }, timeline, 200);
    expect(normal).toBeGreaterThan(0);
    expect(aboveThreshold).toBe(0);
    expect(belowThreshold).toBe(0);
    expect(lowerStrength).toBeCloseTo(normal / 2, 6);
  });

  it('keeps weak Kick events measurable across Binding thresholds, strengths and attacks', () => {
    const timeline = { ...demoTimeline, kickEvents: [200], kickEventStrengths: [0.05] };
    const binding = {
      id: 'binding-kick-sweep', effectId: 'effect-bars', source: 'kick.events' as const,
      strength: 0.9, threshold: 0.1, attackMs: 60, releaseMs: 260,
    };
    expect(evaluateBinding(binding, { ...timeline, kickEventStrengths: [0.2] }, 200)).toBeCloseTo(0.0283468, 6);

    for (const strength of [0.05, 0.1, 0.2, 0.5, 1]) {
      const values = [0.1, 0.05, 0].map((threshold) =>
        evaluateBinding({ ...binding, threshold, attackMs: 0, strength: 1 }, {
          ...timeline, kickEventStrengths: [strength],
        }, 200));
      expect(values[0]).toBe(strength <= 0.1 ? 0 : (strength - 0.1) / 0.9);
      expect(values[1]).toBe(strength <= 0.05 ? 0 : (strength - 0.05) / 0.95);
      expect(values[2]).toBe(strength);

      const attackValues = [60, 20, 0].map((attackMs) => evaluateBinding(
        { ...binding, threshold: 0, attackMs, strength: 1 },
        { ...timeline, kickEventStrengths: [strength] },
        200,
      ));
      expect(attackValues[0]).toBeLessThan(attackValues[1]!);
      expect(attackValues[1]).toBeLessThan(attackValues[2]!);
      expect(attackValues[2]).toBe(strength);
      expect(evaluateBinding({ ...binding, threshold: 0, attackMs: 0, strength: 1 }, {
        ...timeline, kickEventStrengths: [strength],
      }, 260)).toBeGreaterThan(0);
      expect(evaluateBinding({ ...binding, threshold: 0, attackMs: 0, strength: 1 }, {
        ...timeline, kickEventStrengths: [strength],
      }, 600)).toBeLessThan(attackValues[2]!);
    }
  });

  it('propagates a weak Kick through Ripple and event-driven Effect rendering when threshold is zero', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects = [
      { id: 'ripple-kick-test', kind: 'ripple', regionId: 'region-stage', color: '#ffffff', centerX: 0.5, centerY: 0.5, waves: 3, periodMs: 1200, radius: 0.3, amplitude: 0.1, lineWidth: 0.01 },
      { id: 'shock-kick-test', kind: 'shockwave', regionId: 'region-stage', color: '#ffffff', centerX: 0.5, centerY: 0.5, maxRadius: 0.4, lifetimeMs: 1200, lineWidth: 0.02 },
    ];
    blueprint.bindings = blueprint.effects.map((effect) => ({
      id: `binding-${effect.id}`, effectId: effect.id, source: 'kick.events' as const,
      strength: 1, threshold: 0, attackMs: 0, releaseMs: 260,
    }));
    const timeline = { ...demoTimeline, kickEvents: [200], kickEventStrengths: [0.05] };
    const frame = evaluateEditorFrame(blueprint, timeline, 300);
    expect(frame.slice(0, 3).some((command) => command.opacity > 0)).toBe(true);
    expect(frame[3]?.opacity).toBeGreaterThan(0);
    blueprint.bindings.forEach((binding) => { binding.threshold = 0.1; });
    const gatedFrame = evaluateEditorFrame(blueprint, timeline, 300);
    expect(gatedFrame).toHaveLength(1);
    expect(gatedFrame[0]?.opacity).toBe(0);
  });

  it('reproduces Demo-strength versus acoustic-strength Particle Burst attenuation and the Kick defaults', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects = [{
      id: 'burst-timeline-compare', kind: 'particle-burst', regionId: 'region-stage', color: '#ffffff',
      originX: 0.5, originY: 0.5, directionDeg: 0, spreadDeg: 90, speedPxPerSec: 420,
      lifetimeMs: 1500, count: 32, sizePx: 7, opacityBoost: 1.6, coreBrightness: 0,
      audioReactive: true, visibilityMode: 'triggered', opacity: 1,
    }];
    blueprint.bindings = [{ id: 'binding-burst-compare', effectId: 'burst-timeline-compare', source: 'kick.events', strength: 0.9, threshold: 0.1, attackMs: 60, releaseMs: 260 }];
    // Representative measured values: demo1 has Kick strengths >=0.251 (median 1.0);
    // the saved demo4 acoustic-stem Timeline includes 0.052458 and 0.083798.
    const demoTimeline = { durationMs: 1000, bassEnvelope: [], kickEvents: [100], kickEventStrengths: [1] };
    const acousticTimeline = { ...demoTimeline, kickEventStrengths: [0.05245834928566786] };
    expect(evaluateEditorFrame(blueprint, demoTimeline, 100)).toHaveLength(30);
    expect(evaluateEditorFrame(blueprint, acousticTimeline, 100)).toHaveLength(0);

    blueprint.bindings[0] = { ...blueprint.bindings[0]!, strength: 1, threshold: 0, attackMs: 0, releaseMs: 260 };
    const restored = evaluateEditorFrame(blueprint, acousticTimeline, 100);
    expect(restored).toHaveLength(12);
    expect(restored.every((command) => command.opacity > 0.08)).toBe(true);
  });

  it('validates additive BPM metadata and rejects inconsistent or extreme values', () => {
    const valid = { ...demoTimeline, bpm: 120, bpmSource: 'kick-estimated' as const };
    expect(evaluateEditorFrame(initialEditorBlueprint, valid, 100)).toBeDefined();
    expect(() => evaluateEditorFrame(initialEditorBlueprint, { ...valid, bpm: 241 }, 100)).toThrow(/BPM/);
    expect(() => evaluateEditorFrame(initialEditorBlueprint, { ...valid, bpm: 100, bpmSource: 'fallback' }, 100)).toThrow(/BPM/);
    expect(() => evaluateEditorFrame(initialEditorBlueprint, { ...demoTimeline, bpmSource: 'fallback' }, 100)).toThrow(/BPM/);
  });

  it('keeps a new source inactive when an older Timeline does not contain it', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.bindings.find((binding) => binding.effectId === 'effect-bars')!.source = 'music.energy';
    expect(evaluateBinding(blueprint.bindings.find((binding) => binding.effectId === 'effect-bars'), demoTimeline, 900)).toBe(0);
    expect(() => evaluateEditorFrame(initialEditorBlueprint, demoTimeline, 900)).not.toThrow();
  });

  it('uses the selected Binding source for the Waveform / Bars effect', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.bindings.find((binding) => binding.effectId === 'effect-bars')!.source = 'drums.energy';
    const timeline = { ...demoTimeline, drumEnergy: [{ timeMs: 0, value: 0 }, { timeMs: 2000, value: 1 }, { timeMs: 12000, value: 0 }] };
    const bars = evaluateEditorFrame(blueprint, timeline, 1020).filter((command) => command.kind === 'rect');
    expect(new Set(bars.map((bar) => bar.height)).size).toBeGreaterThan(1);
    blueprint.bindings.find((binding) => binding.effectId === 'effect-bars')!.source = 'kick.events';
    expect(() => validateBlueprint(blueprint)).not.toThrow();
  });

  it('responds to binding source changes with stable radial bars and a time-seekable wave ring', () => {
    const blueprint = allEffectsBlueprint();
    const atTime = evaluateEditorFrame(blueprint, demoTimeline, 2300);
    const radial = atTime.filter((command) => command.region.kind === 'polygon' && command.kind === 'rect').slice(-32);
    expect(radial).toHaveLength(32);
    expect(new Set(radial.map((command) => command.height.toFixed(3))).size).toBeGreaterThan(1);
    const firstRing = atTime.find((command) => command.kind === 'path');
    evaluateEditorFrame(blueprint, demoTimeline, 9000);
    expect(evaluateEditorFrame(blueprint, demoTimeline, 2300).find((command) => command.kind === 'path')).toEqual(firstRing);
    blueprint.bindings.find((binding) => binding.effectId === 'ring')!.source = 'music.energy';
    const timeline = { ...demoTimeline, musicEnergy: [{ timeMs: 0, value: 0 }, { timeMs: 12000, value: 1 }] };
    expect(evaluateEditorFrame(blueprint, timeline, 2300).find((command) => command.kind === 'path')).not.toEqual(firstRing);
  });

  it('recomputes bounded burst and trail particles deterministically after arbitrary seeks', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects.push(
      { id: 'burst', kind: 'particle-burst', regionId: 'region-stage', color: '#ffffff', originX: 0.5, originY: 0.5, directionDeg: -90, spreadDeg: 80, speedPxPerSec: 100, lifetimeMs: 1200, count: 12, sizePx: 6 },
      { id: 'trail', kind: 'particle-trail', regionId: 'region-accent', color: '#ffffff', samples: 32, trailMs: 1000, sizePx: 5, amplitude: 0.4 },
    );
    blueprint.bindings.push(
      { id: 'binding-burst', effectId: 'burst', source: 'kick.events', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 },
      { id: 'binding-trail', effectId: 'trail', source: 'bass.envelope', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 },
    );
    const timeline = { durationMs: 3000, bassEnvelope: [{ timeMs: 0, value: 0.2 }, { timeMs: 1000, value: 0.9 }, { timeMs: 3000, value: 0.2 }], kickEvents: [1000] };
    const before = evaluateEditorFrame(blueprint, timeline, 999);
    expect(before.filter((command) => command.color === '#ffffff' && command.region === blueprint.regions[0]?.geometry)).toHaveLength(0);
    const atEvent = evaluateEditorFrame(blueprint, timeline, 1000);
    expect(atEvent.filter((command) => command.color === '#ffffff' && command.region === blueprint.regions[0]?.geometry)).toHaveLength(12);
    const trailCommands = atEvent.filter((command) => command.color === '#ffffff' && command.region === blueprint.regions[1]?.geometry);
    expect(trailCommands.length).toBeGreaterThan(0);
    expect(trailCommands.length).toBeLessThanOrEqual(32);
    const afterLifetime = evaluateEditorFrame(blueprint, timeline, 2500);
    expect(afterLifetime.filter((command) => command.color === '#ffffff' && command.region === blueprint.regions[0]?.geometry)).toHaveLength(0);
    const atFive = evaluateEditorFrame(blueprint, timeline, 2200);
    evaluateEditorFrame(blueprint, timeline, 500);
    expect(evaluateEditorFrame(blueprint, timeline, 2200)).toEqual(atFive);
    const changed = evaluateEditorFrame(blueprint, { ...timeline, bassEnvelope: [{ timeMs: 0, value: 0.8 }, { timeMs: 1000, value: 0.1 }, { timeMs: 3000, value: 0.8 }] }, 1000);
    expect(changed.filter((command) => command.region === blueprint.regions[1]?.geometry)).not.toEqual(atEvent.filter((command) => command.region === blueprint.regions[1]?.geometry));
    expect(atEvent.every((command) => command.region.kind === 'rect' || command.region.kind === 'polygon')).toBe(true);
  });

  it('renders a distributed rising particle field with audio-driven count, flow, spread, and glow', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects.push({ id: 'particle-field', kind: 'particles', regionId: 'region-stage', color: '#ab12ef', count: 64, sizePx: 5, cycleMs: 2200, spread: 0.92, speedInfluence: 1, glowIntensity: 1.2, baselineOpacity: 0.26, visibilityMode: 'triggered' });
    blueprint.bindings.push({ id: 'binding-particle-field', effectId: 'particle-field', source: 'bass.envelope', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 });
    const region = blueprint.regions[0]!.geometry;
    const lowTimeline = { durationMs: 5000, bassEnvelope: [{ timeMs: 0, value: 0.15 }, { timeMs: 5000, value: 0.15 }], kickEvents: [] };
    const highTimeline = { ...lowTimeline, bassEnvelope: [{ timeMs: 0, value: 1 }, { timeMs: 5000, value: 1 }] };
    const pick = (timeline: typeof lowTimeline, timeMs: number) => evaluateEditorFrame(blueprint, timeline, timeMs).filter((command) => command.color === '#ab12ef' && command.region === region);
    const baseline = pick({ ...lowTimeline, bassEnvelope: [{ timeMs: 0, value: 0 }, { timeMs: 5000, value: 0 }] }, 0);
    const low = pick(lowTimeline, 200);
    const high = pick(highTimeline, 200);
    expect(baseline).toHaveLength(0);
    expect(low.length).toBeGreaterThan(0);
    expect(high).toHaveLength(64);
    const rangeX = (commands: typeof high) => Math.max(...commands.map((command) => command.x)) - Math.min(...commands.map((command) => command.x));
    const stageWidth = blueprint.regions[0]!.geometry.kind === 'rect' ? blueprint.regions[0]!.geometry.width * blueprint.width : 0;
    expect(rangeX(high)).toBeGreaterThan(stageWidth * 0.7);
    expect(rangeX(high)).toBeGreaterThan(rangeX(low));
    expect(high.reduce((sum, command) => sum + (command.shadowBlur ?? 0), 0) / high.length).toBeGreaterThan(low.reduce((sum, command) => sum + (command.shadowBlur ?? 0), 0) / low.length);
    expect(high.every((command) => command.region === region && command.opacity <= 1)).toBe(true);
    expect(new Set(high.map((command) => `${command.x.toFixed(2)}:${command.y.toFixed(2)}`)).size).toBe(high.length);
    expect(new Set(high.map((command) => command.x.toFixed(2))).size).toBe(high.length);
    const maxLocalCluster = Math.max(...high.map((command) => high.filter((other) => Math.abs(other.x - command.x) < 12 && Math.abs(other.y - command.y) < 12).length));
    expect(maxLocalCluster).toBeLessThan(6);
    const stageTop = region.kind === 'rect' ? region.y * blueprint.height : 0;
    const stageHeight = region.kind === 'rect' ? region.height * blueprint.height : 0;
    const particleDiagnostics = high.map((command, particleIndex) => {
      const renderX = command.x + command.width / 2;
      const renderY = command.y + command.height / 2;
      const phase = Math.min(1, Math.max(0, 1 - (renderY - stageTop) / Math.max(1, stageHeight - command.height)));
      return { particleIndex, spawnX: renderX, spawnY: stageTop + stageHeight - command.height / 2, renderX, renderY, size: command.width, alpha: command.opacity, lifetimeMs: 1100, phase };
    });
    expect(particleDiagnostics).toHaveLength(64);
    expect(particleDiagnostics.every((particle) => particle.alpha > 0 && particle.size >= 3.5 && particle.lifetimeMs > 0 && particle.phase >= 0 && particle.phase <= 1)).toBe(true);
    const start = pick(highTimeline, 20);
    const later = pick(highTimeline, 200);
    const rising = later.map((command, index) => command.y < (start[index]?.y ?? command.y));
    expect(rising.filter(Boolean).length).toBeGreaterThan(rising.length * 0.7);
    expect(pick(highTimeline, 200)).toEqual(high);
    pick(highTimeline, 20);
    expect(pick(highTimeline, 200)).toEqual(high);

    const polygonBlueprint = structuredClone(blueprint);
    const stage = polygonBlueprint.regions[0]!;
    stage.geometry = { kind: 'polygon', points: [{ x: 0.1, y: 0.2 }, { x: 0.9, y: 0.2 }, { x: 0.7, y: 0.9 }, { x: 0.3, y: 0.9 }] };
    const polygonField = evaluateEditorFrame(polygonBlueprint, highTimeline, 200).filter((command) => command.color === '#ab12ef');
    expect(polygonField.length).toBeGreaterThan(1);
    expect(polygonField.every((command) => command.region === stage.geometry && command.x >= 0.1 * blueprint.width && command.x < 0.9 * blueprint.width)).toBe(true);
    const polygonRender = fakeContext();
    renderEditorFrame(polygonRender.context, polygonBlueprint, highTimeline, 200);
    const polygonClip = polygonRender.clips.find((path) => path.startsWith('move:') && path.includes(':close'));
    expect(polygonClip).toBeDefined();
    expect(polygonRender.paintedClipPaths).toContain(polygonClip);
    const canvasBlueprint = structuredClone(blueprint);
    canvasBlueprint.effects = [canvasBlueprint.effects.at(-1)!];
    canvasBlueprint.bindings = [canvasBlueprint.bindings.at(-1)!];
    const canvasRender = fakeContext();
    renderEditorFrame(canvasRender.context, canvasBlueprint, highTimeline, 200);
    expect(canvasRender.ellipses).toHaveLength(64);
    expect(canvasRender.ellipses.every((ellipse) => ellipse.alpha > 0 && ellipse.radiusX > 1)).toBe(true);
    expect(new Set(canvasRender.ellipses.map(({ x }) => x.toFixed(2))).size).toBe(64);
    const triggeredBlueprint = structuredClone(blueprint);
    (triggeredBlueprint.effects.at(-1) as Extract<EditorBlueprint['effects'][number], { kind: 'particles' }>).visibilityMode = 'triggered';
    expect(evaluateEditorFrame(triggeredBlueprint, { ...lowTimeline, bassEnvelope: [{ timeMs: 0, value: 0 }, { timeMs: 5000, value: 0 }] }, 200).filter((command) => command.color === '#ab12ef')).toHaveLength(0);
  });

  it('forces legacy Always Particles to audio-triggered behavior for all seven Binding sources', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects = [{ id: 'legacy-always-field', kind: 'particles', regionId: 'region-stage', color: '#ab12ef', count: 64, sizePx: 5, cycleMs: 2200, visibilityMode: 'always', audioReactive: false }];
    blueprint.bindings = [{ id: 'legacy-always-binding', effectId: 'legacy-always-field', source: 'bass.envelope', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 }];
    const silence = { durationMs: 1000, bassEnvelope: [{ timeMs: 0, value: 0 }, { timeMs: 1000, value: 0 }], drumEnergy: [{ timeMs: 0, value: 0 }, { timeMs: 1000, value: 0 }], vocalsEnvelope: [{ timeMs: 0, value: 0 }, { timeMs: 1000, value: 0 }], otherEnvelope: [{ timeMs: 0, value: 0 }, { timeMs: 1000, value: 0 }], musicEnergy: [{ timeMs: 0, value: 0 }, { timeMs: 1000, value: 0 }], kickEvents: [], kickEventStrengths: [], snareEvents: [], snareEventStrengths: [] };
    const active = { ...silence, bassEnvelope: [{ timeMs: 0, value: 1 }, { timeMs: 1000, value: 1 }], drumEnergy: [{ timeMs: 0, value: 1 }, { timeMs: 1000, value: 1 }], vocalsEnvelope: [{ timeMs: 0, value: 1 }, { timeMs: 1000, value: 1 }], otherEnvelope: [{ timeMs: 0, value: 1 }, { timeMs: 1000, value: 1 }], musicEnergy: [{ timeMs: 0, value: 1 }, { timeMs: 1000, value: 1 }], kickEvents: [100], kickEventStrengths: [1], snareEvents: [100], snareEventStrengths: [1] };
    const sources: BindingSource[] = ['bass.envelope', 'drums.energy', 'vocals.envelope', 'other.envelope', 'music.energy', 'kick.events', 'snare.events'];
    for (const source of sources) {
      blueprint.bindings[0]!.source = source;
      expect(evaluateEditorFrame(blueprint, silence, 150)).toHaveLength(0);
      const triggered = evaluateEditorFrame(blueprint, active, 150);
      expect(triggered.length).toBeGreaterThan(0);
      expect(triggered.length).toBeLessThanOrEqual(64);
      evaluateEditorFrame(blueprint, silence, 400);
      expect(evaluateEditorFrame(blueprint, active, 150)).toEqual(triggered);
    }
  });

  it('fires deterministic full-circle swirling bursts whose count, distance, and glow follow event strength', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects.push({ id: 'radial-burst', kind: 'particle-burst', regionId: 'region-stage', color: '#ef12ab', originX: 0.5, originY: 0.5, directionDeg: 0, spreadDeg: 90, speedPxPerSec: 420, lifetimeMs: 1500, count: 32, sizePx: 7, glowIntensity: 1.5, swirl: 0.7, audioInfluence: 1, baselineOpacity: 0.12 });
    blueprint.bindings.push({ id: 'binding-radial-burst', effectId: 'radial-burst', source: 'kick.events', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 });
    const timeline = (strength: number) => ({ durationMs: 4000, bassEnvelope: [], kickEvents: [1000], kickEventStrengths: [strength] });
    const low = evaluateEditorFrame(blueprint, timeline(0.25), 1200).filter((command) => command.color === '#ef12ab');
    const high = evaluateEditorFrame(blueprint, timeline(1), 1200).filter((command) => command.color === '#ef12ab');
    expect(low).toHaveLength(16);
    expect(high).toHaveLength(32);
    const region = blueprint.regions[0]!.geometry;
    const bounds = region.kind === 'rect' ? region : { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
    const originX = (bounds.x + bounds.width / 2) * blueprint.width;
    const originY = (bounds.y + bounds.height / 2) * blueprint.height;
    const quadrants = new Set(high.map((command) => {
      const dx = command.x + command.width / 2 - originX;
      const dy = command.y + command.height / 2 - originY;
      return `${dx >= 0 ? 'R' : 'L'}${dy >= 0 ? 'D' : 'U'}`;
    }));
    expect(quadrants.size).toBe(4);
    const radialDistances = (commands: typeof high) => commands.map((command) => Math.hypot(command.x + command.width / 2 - originX, command.y + command.height / 2 - originY));
    expect(radialDistances(high)[0]).toBeGreaterThan(radialDistances(low)[0]!);
    expect(high.reduce((sum, command) => sum + (command.shadowBlur ?? 0), 0) / high.length).toBeGreaterThan(low.reduce((sum, command) => sum + (command.shadowBlur ?? 0), 0) / low.length);
    const rotated = evaluateEditorFrame(blueprint, timeline(1), 1500).filter((command) => command.color === '#ef12ab');
    const angle = (command: (typeof high)[number]) => Math.atan2(command.y + command.height / 2 - originY, command.x + command.width / 2 - originX);
    const rawRotationDelta = angle(rotated[0]!) - angle(high[0]!);
    const rotationDelta = Math.atan2(Math.sin(rawRotationDelta), Math.cos(rawRotationDelta));
    expect(Math.abs(rotationDelta)).toBeGreaterThan(0.2);
    expect(evaluateEditorFrame(blueprint, timeline(1), 1200).filter((command) => command.color === '#ef12ab')).toEqual(high);
    evaluateEditorFrame(blueprint, timeline(1), 300);
    expect(evaluateEditorFrame(blueprint, timeline(1), 1200).filter((command) => command.color === '#ef12ab')).toEqual(high);

    const continuousBlueprint = structuredClone(blueprint);
    continuousBlueprint.bindings.at(-1)!.source = 'music.energy';
    const continuous = evaluateEditorFrame(continuousBlueprint, { durationMs: 4000, bassEnvelope: [], kickEvents: [], musicEnergy: [{ timeMs: 0, value: 0 }, { timeMs: 900, value: 0.9 }, { timeMs: 3000, value: 0.9 }] }, 1200).filter((command) => command.color === '#ef12ab');
    expect(continuous.length).toBeGreaterThan(0);

    const always = structuredClone(blueprint);
    (always.effects.at(-1) as Extract<EditorBlueprint['effects'][number], { kind: 'particle-burst' }>).visibilityMode = 'always';
    const idleTimeline = { durationMs: 4000, bassEnvelope: [], kickEvents: [] };
    const idleAtOne = evaluateEditorFrame(always, idleTimeline, 1000).filter((command) => command.color === '#ef12ab');
    const idleAtTwo = evaluateEditorFrame(always, idleTimeline, 2500).filter((command) => command.color === '#ef12ab');
    expect(idleAtOne).toHaveLength(32);
    expect(idleAtOne.every((command) => command.opacity === 0.12)).toBe(true);
    expect(idleAtTwo).toEqual(idleAtOne);
  });

  it('rejects invalid particle parameters while accepting cross-signal bindings', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects.push({ id: 'burst', kind: 'particle-burst', regionId: 'region-stage', color: '#ffffff', originX: 0.5, originY: 0.5, directionDeg: 0, spreadDeg: 90, speedPxPerSec: 100, lifetimeMs: 1000, count: 8, sizePx: 5 });
    blueprint.bindings.push({ id: 'binding-burst', effectId: 'burst', source: 'bass.envelope', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 });
    expect(() => validateBlueprint(blueprint)).not.toThrow();
    (blueprint.effects.at(-1) as Extract<EditorBlueprint['effects'][number], { kind: 'particle-burst' }>).count = 65;
    expect(() => validateBlueprint(blueprint)).toThrow(/invalid particle burst/);
    const unknown = structuredClone(initialEditorBlueprint);
    unknown.effects.push({ id: 'trail', kind: 'particle-trail', regionId: 'region-stage', color: '#ffffff', samples: 16, trailMs: 1000, sizePx: 5, amplitude: 0.2 });
    unknown.bindings.push({ id: 'binding-trail', effectId: 'trail', source: 'bass.envelope', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 });
    (unknown.effects.at(-1) as unknown as Record<string, unknown>).script = 'should not be accepted';
    expect(() => validateBlueprint(unknown)).toThrow(/unexpected particle-trail parameter/);
  });

  it('supports particle counts 1, 32, and 64 while capping overlapping burst events at 64', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    for (const count of [1, 32, 64]) {
      blueprint.effects = [{ id: 'counted-particles', kind: 'particles', regionId: 'region-stage', color: '#ffffff', count, sizePx: 4, cycleMs: 1000, visibilityMode: 'triggered' }];
      blueprint.bindings = [{ id: 'binding-counted-particles', effectId: 'counted-particles', source: 'bass.envelope', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 }];
      const particles = evaluateEditorFrame(blueprint, { durationMs: 1000, bassEnvelope: [{ timeMs: 0, value: 1 }, { timeMs: 1000, value: 1 }], kickEvents: [] }, 200);
      expect(particles).toHaveLength(count);

      blueprint.effects = [{ id: 'counted-burst', kind: 'particle-burst', regionId: 'region-stage', color: '#ff00ff', originX: 0.5, originY: 0.5, directionDeg: 0, spreadDeg: 90, speedPxPerSec: 100, lifetimeMs: 1000, count, sizePx: 5, coreBrightness: 0 }];
      blueprint.bindings = [{ id: 'binding-counted-burst', effectId: 'counted-burst', source: 'kick.events', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 }];
      const burst = evaluateEditorFrame(blueprint, { durationMs: 1000, bassEnvelope: [], kickEvents: [100], kickEventStrengths: [1] }, 200);
      expect(burst).toHaveLength(count);
    }
    blueprint.effects = [{ id: 'counted-burst', kind: 'particle-burst', regionId: 'region-stage', color: '#ff00ff', originX: 0.5, originY: 0.5, directionDeg: 0, spreadDeg: 90, speedPxPerSec: 100, lifetimeMs: 1000, count: 64, sizePx: 5, coreBrightness: 0 }];
    blueprint.bindings = [{ id: 'binding-counted-burst', effectId: 'counted-burst', source: 'kick.events', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 }];
    const overlapping = evaluateEditorFrame(blueprint, { durationMs: 1000, bassEnvelope: [], kickEvents: Array.from({ length: 12 }, (_, index) => index * 10), kickEventStrengths: Array.from({ length: 12 }, () => 1) }, 120);
    expect(overlapping).toHaveLength(64);
  });

  it('validates additive particle presentation parameters and rejects unknown keys', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects.push(
      { id: 'field-validated', kind: 'particles', regionId: 'region-stage', color: '#ffffff', count: 64, sizePx: 4, cycleMs: 2200, spread: 0.8, speedInfluence: 1, glowIntensity: 1.2, baselineOpacity: 0.14 },
      { id: 'burst-validated', kind: 'particle-burst', regionId: 'region-stage', color: '#ffccaa', originX: 0.5, originY: 0.5, directionDeg: 0, spreadDeg: 90, speedPxPerSec: 420, lifetimeMs: 1500, count: 32, sizePx: 7, swirl: 0.55, audioInfluence: 1, baselineOpacity: 0.12 },
    );
    blueprint.bindings.push(
      { id: 'binding-field-validated', effectId: 'field-validated', source: 'music.energy', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 },
      { id: 'binding-burst-validated', effectId: 'burst-validated', source: 'snare.events', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 },
    );
    expect(() => validateBlueprint(blueprint)).not.toThrow();
    const badSpread = structuredClone(blueprint);
    (badSpread.effects.at(-2) as Extract<EditorBlueprint['effects'][number], { kind: 'particles' }>).spread = 1.1;
    expect(() => validateBlueprint(badSpread)).toThrow(/invalid particle settings/);
    const badSwirl = structuredClone(blueprint);
    (badSwirl.effects.at(-1) as Extract<EditorBlueprint['effects'][number], { kind: 'particle-burst' }>).swirl = 2.1;
    expect(() => validateBlueprint(badSwirl)).toThrow(/invalid particle burst/);
    const overParticles = structuredClone(blueprint);
    (overParticles.effects.at(-2) as Extract<EditorBlueprint['effects'][number], { kind: 'particles' }>).count = 65;
    expect(() => validateBlueprint(overParticles)).toThrow(/invalid particles/);
    const overBurst = structuredClone(blueprint);
    (overBurst.effects.at(-1) as Extract<EditorBlueprint['effects'][number], { kind: 'particle-burst' }>).count = 65;
    expect(() => validateBlueprint(overBurst)).toThrow(/invalid particle burst/);
    const unknown = structuredClone(blueprint);
    (unknown.effects.at(-1) as unknown as Record<string, unknown>).randomSeed = 1;
    expect(() => validateBlueprint(unknown)).toThrow(/unexpected particle-burst parameter/);
  });

  it('evaluates Bass ripples and Kick shockwaves as bounded deterministic rings', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects.push(
      { id: 'ripple', kind: 'ripple', regionId: 'region-stage', color: '#88ddff', centerX: 0.5, centerY: 0.5, waves: 3, periodMs: 1600, radius: 0.34, amplitude: 0.08, lineWidth: 0.012 },
      { id: 'shock', kind: 'shockwave', regionId: 'region-accent', color: '#ff88cc', centerX: 0.5, centerY: 0.5, maxRadius: 0.42, lifetimeMs: 1000, lineWidth: 0.018 },
    );
    blueprint.bindings.push(
      { id: 'binding-ripple', effectId: 'ripple', source: 'bass.envelope', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 },
      { id: 'binding-shock', effectId: 'shock', source: 'kick.events', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 },
    );
    const timeline = { durationMs: 4000, bassEnvelope: [{ timeMs: 0, value: 0.2 }, { timeMs: 2000, value: 0.9 }, { timeMs: 4000, value: 0.3 }], kickEvents: [1000, 1500] };
    const first = evaluateEditorFrame(blueprint, timeline, 1400);
    const ripples = first.filter((command) => command.region === blueprint.regions[0]?.geometry && command.kind === 'circle' && command.strokeOnly);
    const shocks = first.filter((command) => command.region === blueprint.regions[1]?.geometry && command.kind === 'circle' && command.strokeOnly && command.color === '#ff88cc');
    expect(ripples).toHaveLength(3);
    expect(ripples.every((command) => Math.abs(command.width - command.height) < 1e-8 && command.lineWidth !== undefined)).toBe(true);
    expect(shocks).toHaveLength(1);
    evaluateEditorFrame(blueprint, timeline, 20);
    expect(evaluateEditorFrame(blueprint, timeline, 1400)).toEqual(first);
    const changed = evaluateEditorFrame(blueprint, { ...timeline, bassEnvelope: [{ timeMs: 0, value: 0.95 }, { timeMs: 2000, value: 0.95 }, { timeMs: 4000, value: 0.95 }] }, 1400);
    expect(changed.filter((command) => command.region === blueprint.regions[0]?.geometry && command.kind === 'circle' && command.strokeOnly)).not.toEqual(ripples);
    expect(evaluateEditorFrame(blueprint, timeline, 999).filter((command) => command.region === blueprint.regions[1]?.geometry && command.kind === 'circle' && command.strokeOnly && command.color === '#ff88cc')).toHaveLength(0);
    expect(evaluateEditorFrame(blueprint, timeline, 2700).filter((command) => command.region === blueprint.regions[1]?.geometry && command.kind === 'circle' && command.strokeOnly && command.color === '#ff88cc')).toHaveLength(0);
    const manyEvents = { ...timeline, durationMs: 6000, kickEvents: Array.from({ length: 50 }, (_, index) => (index + 1) * 100) };
    (blueprint.effects.find((effect) => effect.id === 'shock') as Extract<EditorBlueprint['effects'][number], { kind: 'shockwave' }>).lifetimeMs = 5000;
    const cappedTimeline = { ...manyEvents, durationMs: 10000 };
    expect(evaluateEditorFrame(blueprint, cappedTimeline, 5000).filter((command) => command.region === blueprint.regions[1]?.geometry && command.kind === 'circle' && command.strokeOnly && command.color === '#ff88cc')).toHaveLength(32);
    expect(evaluateEditorFrame(blueprint, cappedTimeline, 10000).filter((command) => command.region === blueprint.regions[1]?.geometry && command.kind === 'circle' && command.strokeOnly && command.color === '#ff88cc')).toHaveLength(0);
    const fake = fakeContext();
    const clippedCommands = renderEditorFrame(fake.context, blueprint, timeline, 1400);
    expect(fake.clips).toHaveLength(clippedCommands.length);
    expect(fake.paintedClipPaths).toHaveLength(clippedCommands.length);
  });

  it('keeps circular Effect geometry circular across Stage and Region aspect ratios while preserving centers and clipping', () => {
    const regions: Array<{ id: string; name: string; geometry: EditorBlueprint['regions'][number]['geometry'] }> = [
      { id: 'region-test', name: 'Stage', geometry: { kind: 'rect', x: 0, y: 0, width: 1, height: 1 } },
      { id: 'region-test', name: 'Wide', geometry: { kind: 'rect', x: 0.1, y: 0.2, width: 0.75, height: 0.35 } },
      { id: 'region-test', name: 'Tall', geometry: { kind: 'rect', x: 0.3, y: 0.1, width: 0.3, height: 0.8 } },
      { id: 'region-test', name: 'Polygon', geometry: { kind: 'polygon', points: [{ x: 0.1, y: 0.3 }, { x: 0.85, y: 0.2 }, { x: 0.75, y: 0.55 }, { x: 0.2, y: 0.6 }] } },
    ];
    const effects: Effect[] = [
      { id: 'pulse-circle', kind: 'pulse-scale', regionId: 'region-test', color: '#ffffff', baseScale: 0.4, maxScale: 0.8, visibilityMode: 'always', audioReactive: false },
      { id: 'wave-circle', kind: 'wave-ring', regionId: 'region-test', color: '#ffffff', centerX: 0.25, centerY: 0.7, radius: 0.2, amplitude: 0.05, points: 32, lineWidth: 0.01, visibilityMode: 'always', audioReactive: false },
      { id: 'waveform-circle', kind: 'waveform-ring', regionId: 'region-test', color: '#ffffff', radius: 0.2, sampleCount: 32, amplitudeScale: 1, lineWidth: 0.01, smoothing: 0, glowIntensity: 0, visibilityMode: 'always', audioReactive: false },
      { id: 'ripple-circle', kind: 'ripple', regionId: 'region-test', color: '#ffffff', centerX: 0.25, centerY: 0.7, waves: 2, periodMs: 1000, radius: 0.2, amplitude: 0.05, lineWidth: 0.01, visibilityMode: 'always', audioReactive: false },
      { id: 'shock-circle', kind: 'shockwave', regionId: 'region-test', color: '#ffffff', centerX: 0.25, centerY: 0.7, maxRadius: 0.35, lifetimeMs: 1000, lineWidth: 0.01, visibilityMode: 'always', audioReactive: false },
      { id: 'radial-circle', kind: 'radial-bars', regionId: 'region-test', color: '#ffffff', centerX: 0.25, centerY: 0.7, radius: 0.2, bars: 16, barLength: 0.1, lineWidth: 0.4, innerRadius: 0.1, amplitudeScale: 1, visibilityMode: 'always', audioReactive: false },
      { id: 'scope-circle', kind: 'oscilloscope-line', regionId: 'region-test', color: '#ffffff', orientation: 'radial', lineWidth: 0.01, sampleCount: 64, amplitudeScale: 1, glowIntensity: 0, visibilityMode: 'always', audioReactive: false },
    ];
    for (const dimensions of [{ width: 640, height: 360 }, { width: 360, height: 360 }]) {
      for (const region of regions) {
        const blueprint = structuredClone(initialEditorBlueprint);
        blueprint.width = dimensions.width;
        blueprint.height = dimensions.height;
        blueprint.regions = [region];
        for (const effect of effects) {
          const currentEffect = structuredClone(effect);
          blueprint.effects = [currentEffect];
          blueprint.bindings = [{ id: `binding-${effect.id}`, effectId: effect.id, source: 'music.energy', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 }];
          const commands = evaluateEditorFrame(blueprint, demoTimeline, 0).filter((command) => command.color === '#ffffff' && command.region === region.geometry);
          expect(commands.length, `${dimensions.width}x${dimensions.height} ${region.name} ${effect.kind}`).toBeGreaterThan(0);
          expect(commands.every((command) => command.region === region.geometry)).toBe(true);
          const rendered = fakeContext();
          const drawn = renderEditorFrame(rendered.context, blueprint, demoTimeline, 0);
          const circleCommands = drawn.filter((command) => command.color === '#ffffff' && command.region === region.geometry && command.kind === 'circle');
          for (const command of circleCommands) expect(command.width).toBeCloseTo(command.height, 8);
          for (const ellipse of rendered.ellipses) expect(ellipse.radiusX).toBeCloseTo(ellipse.radiusY, 8);
          const bounds = region.geometry.kind === 'rect' ? region.geometry : {
            x: Math.min(...region.geometry.points.map((point) => point.x)),
            y: Math.min(...region.geometry.points.map((point) => point.y)),
            width: Math.max(...region.geometry.points.map((point) => point.x)) - Math.min(...region.geometry.points.map((point) => point.x)),
            height: Math.max(...region.geometry.points.map((point) => point.y)) - Math.min(...region.geometry.points.map((point) => point.y)),
          };
          const effectCenterX = 'centerX' in currentEffect ? currentEffect.centerX : 0.5;
          const effectCenterY = 'centerY' in currentEffect ? currentEffect.centerY : 0.5;
          const expectedCenterX = (bounds.x + effectCenterX * bounds.width) * dimensions.width;
          const expectedCenterY = (bounds.y + effectCenterY * bounds.height) * dimensions.height;
          if (commands[0]?.kind === 'circle') {
            expect(commands[0].x + commands[0].width / 2).toBeCloseTo(expectedCenterX, 6);
            expect(commands[0].y + commands[0].height / 2).toBeCloseTo(expectedCenterY, 6);
          } else if (commands[0]) {
            expect(commands[0].x).toBeCloseTo(expectedCenterX, 6);
            expect(commands[0].y).toBeCloseTo(expectedCenterY, 6);
          }
          if (currentEffect.kind === 'wave-ring' || currentEffect.kind === 'waveform-ring') {
            const points = commands[0]?.pathPoints ?? [];
            const radii = points.map((point) => Math.hypot(point.x - expectedCenterX, point.y - expectedCenterY));
            expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(1e-6);
            const expectedRadius = currentEffect.radius * Math.min(bounds.width * dimensions.width, bounds.height * dimensions.height);
            radii.forEach((radius) => expect(radius).toBeCloseTo(expectedRadius, 6));
          }
          expect(rendered.clips.length).toBeGreaterThan(0);
          if (region.geometry.kind === 'polygon') expect(rendered.clips.some((clip) => clip.includes(':close'))).toBe(true);
          if (currentEffect.kind === 'radial-bars') {
            const bars = commands.filter((command) => command.kind === 'path');
            const centerX = (region.geometry.kind === 'rect' ? region.geometry.x : 0.1) * dimensions.width + (region.geometry.kind === 'rect' ? region.geometry.width : 0.75) * dimensions.width * currentEffect.centerX;
            const centerY = (region.geometry.kind === 'rect' ? region.geometry.y : 0.2) * dimensions.height + (region.geometry.kind === 'rect' ? region.geometry.height : 0.4) * dimensions.height * currentEffect.centerY;
            const first = bars[0]?.pathPoints?.[0];
            if (first) expect(Math.hypot(first.x - centerX, first.y - centerY)).toBeCloseTo(0.1 * Math.min(region.geometry.kind === 'rect' ? region.geometry.width * dimensions.width : 0.75 * dimensions.width, region.geometry.kind === 'rect' ? region.geometry.height * dimensions.height : 0.4 * dimensions.height), 6);
          }
        }
      }
    }
  });

  it('keeps omitted legacy Glow rendering and improves Glow only when intensity is present', () => {
    const legacy = structuredClone(initialEditorBlueprint);
    legacy.effects = [{ id: 'glow-legacy', kind: 'glow-brightness', regionId: 'region-stage', color: '#ffffff', blurPx: 20, brightness: 1.2 }];
    legacy.bindings = [{ id: 'binding-glow', effectId: 'glow-legacy', source: 'bass.envelope', strength: 0.8, threshold: 0, attackMs: 0, releaseMs: 0 }];
    const oldCommands = evaluateEditorFrame(legacy, demoTimeline, 1000);
    expect(oldCommands).toHaveLength(1);
    expect(oldCommands[0]?.shadowBlur).toBeGreaterThan(0);
    const improved = structuredClone(legacy);
    (improved.effects[0] as Extract<EditorBlueprint['effects'][number], { kind: 'glow-brightness' }>).glowIntensity = 1.5;
    const newCommands = evaluateEditorFrame(improved, demoTimeline, 1000);
    expect(newCommands).toHaveLength(2);
    expect(newCommands[0]?.shadowBlur).toBe((oldCommands[0]?.shadowBlur ?? 0) * 1.5);
    expect(newCommands[1]?.shadowBlur).toBeUndefined();
    (improved.effects[0] as Extract<EditorBlueprint['effects'][number], { kind: 'glow-brightness' }>).glowIntensity = 2.1;
    expect(() => validateBlueprint(improved)).toThrow(/invalid glow/);
    (improved.effects[0] as Extract<EditorBlueprint['effects'][number], { kind: 'glow-brightness' }>).glowIntensity = 0;
    expect(evaluateEditorFrame(improved, demoTimeline, 1000)).toHaveLength(1);
    expect(evaluateEditorFrame(improved, demoTimeline, 1000)[0]?.shadowBlur).toBeUndefined();
  });

  it('renders jagged radial/wave shapes and a seek-stable pseudo oscilloscope line', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects = [
      { id: 'spikes', kind: 'radial-bars', regionId: 'region-stage', color: '#3ef3ff', centerX: 0.5, centerY: 0.5, radius: 0.22, bars: 48, barLength: 0.22, lineWidth: 0.4, barWidth: 0.4, spikeSharpness: 0.9, innerRadius: 0.12, amplitudeScale: 1.8, glowIntensity: 1.4 },
      { id: 'jagged-ring', kind: 'wave-ring', regionId: 'region-accent', color: '#ef45ff', centerX: 0.5, centerY: 0.5, radius: 0.28, amplitude: 0.14, points: 64, lineWidth: 0.018, sampleCount: 192, amplitudeScale: 2.4, jaggedness: 0.9, glowIntensity: 1.5 },
      { id: 'scope', kind: 'oscilloscope-line', regionId: 'region-stage', color: '#72f6ff', orientation: 'horizontal', lineWidth: 0.012, sampleCount: 256, amplitudeScale: 0.8, glowIntensity: 1.5 },
    ];
    blueprint.bindings = blueprint.effects.map((effect) => ({ id: `binding-${effect.id}`, effectId: effect.id, source: 'bass.envelope' as const, strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 }));
    const timeline = { durationMs: 4000, bassEnvelope: [{ timeMs: 0, value: 0.05 }, { timeMs: 1000, value: 0.95 }, { timeMs: 2000, value: 0.1 }, { timeMs: 4000, value: 0.8 }], kickEvents: [] };
    const commands = evaluateEditorFrame(blueprint, timeline, 1250);
    const spikes = commands.filter((command) => command.region === blueprint.regions[0]?.geometry && command.fillPath);
    const ring = commands.find((command) => command.region === blueprint.regions[1]?.geometry && command.kind === 'path');
    const scope = commands.find((command) => command.kind === 'path' && command.closed === false);
    expect(spikes).toHaveLength(48);
    expect(spikes.every((command) => command.pathPoints?.length === 5 && (command.shadowBlur ?? 0) > 0)).toBe(true);
    expect(ring?.pathPoints).toHaveLength(192);
    expect((ring?.shadowBlur ?? 0)).toBeGreaterThan(0);
    expect(scope?.pathPoints).toHaveLength(256);
    expect(scope?.closed).toBe(false);
    evaluateEditorFrame(blueprint, timeline, 3000);
    expect(evaluateEditorFrame(blueprint, timeline, 1250)).toEqual(commands);
    const altered = evaluateEditorFrame(blueprint, { ...timeline, bassEnvelope: [{ timeMs: 0, value: 0.9 }, { timeMs: 2000, value: 0.9 }, { timeMs: 4000, value: 0.9 }] }, 1250);
    expect(altered.find((command) => command.closed === false)?.pathPoints).not.toEqual(scope?.pathPoints);
    const clipped = fakeContext();
    expect(renderEditorFrame(clipped.context, blueprint, timeline, 1250)).toHaveLength(commands.length);
    expect(clipped.clips).toHaveLength(commands.length);
  });

  it('rejects Ripple and Shockwave out-of-range parameters while accepting converted sources', () => {
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects.push(
      { id: 'ripple-check', kind: 'ripple', regionId: 'region-stage', color: '#ffffff', centerX: 0.5, centerY: 0.5, waves: 3, periodMs: 1000, radius: 0.3, amplitude: 0.1, lineWidth: 0.01 },
      { id: 'shock-check', kind: 'shockwave', regionId: 'region-stage', color: '#ffffff', centerX: 0.5, centerY: 0.5, maxRadius: 0.4, lifetimeMs: 1000, lineWidth: 0.01 },
    );
    blueprint.bindings.push(
      { id: 'binding-ripple-check', effectId: 'ripple-check', source: 'kick.events', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 },
      { id: 'binding-shock-check', effectId: 'shock-check', source: 'bass.envelope', strength: 1, threshold: 0, attackMs: 0, releaseMs: 0 },
    );
    expect(() => validateBlueprint(blueprint)).not.toThrow();
    (blueprint.effects.at(-2) as Extract<EditorBlueprint['effects'][number], { kind: 'ripple' }>).waves = 7;
    expect(() => validateBlueprint(blueprint)).toThrow(/invalid ripple/);
  });

  it('clips rectangular and polygon regions and applies each background mode', () => {
    const blueprint = allEffectsBlueprint();
    const solid = fakeContext();
    renderEditorFrame(solid.context, { ...blueprint, background: { kind: 'solid', color: '#123456' } }, demoTimeline, 500);
    expect(solid.fills[0]?.style).toBe('#123456');
    expect(solid.clips.some((clip) => clip.includes('rect:'))).toBe(true);
    expect(solid.clips.some((clip) => clip.includes('move:') && clip.includes(':close'))).toBe(true);

    const gradient = fakeContext();
    renderEditorFrame(gradient.context, { ...blueprint, background: { kind: 'gradient', from: '#112233', to: '#ddeeff', angleDeg: 45 } }, demoTimeline, 500);
    expect(typeof gradient.fills[0]?.style).toBe('object');

    const src = 'data:image/png;base64,abc';
    const image = fakeContext();
    renderEditorFrame(image.context, { ...blueprint, background: { kind: 'image', src } }, demoTimeline, 500, { [src]: {} as CanvasImageSource });
    expect(image.fills.some((fill) => fill.style === 'image')).toBe(true);
    expect(image.imageDrawArgs[0]).toHaveLength(5); // contain uses source ratio and leaves canvas background visible

    const layers = fakeContext();
    const src2 = 'data:image/jpeg;base64,def';
    renderEditorFrame(layers.context, { ...blueprint, background: { kind: 'solid', color: '#123456' }, imageLayers: [
      { id: 'portrait', src, x: 10, y: 20, width: 100, height: 200, sourceWidth: 400, sourceHeight: 800, fit: 'contain' },
      { id: 'landscape', src: src2, x: 150, y: 20, width: 200, height: 100, sourceWidth: 800, sourceHeight: 400, fit: 'cover' },
    ] }, demoTimeline, 500, { [src]: {} as CanvasImageSource, [src2]: {} as CanvasImageSource });
    expect(layers.imageDrawArgs).toHaveLength(2);
    expect(layers.imageClipPaths).toHaveLength(2);
  });

  it('rejects invalid references, out-of-bounds polygons, non-finite values and unordered timelines', () => {
    const missingRegion = structuredClone(initialEditorBlueprint);
    missingRegion.effects[0]!.regionId = 'missing';
    expect(() => validateBlueprint(missingRegion)).toThrow(/missing region/);

    const invalidPolygon = structuredClone(initialEditorBlueprint);
    const polygon = invalidPolygon.regions.find((region) => region.geometry.kind === 'polygon');
    if (polygon?.geometry.kind === 'polygon') polygon.geometry.points[0]!.x = 1.2;
    expect(() => evaluateEditorFrame(invalidPolygon, demoTimeline, 0)).toThrow(/invalid polygon/);

    const nonFinite = structuredClone(initialEditorBlueprint);
    nonFinite.bindings[0]!.attackMs = Number.NaN;
    expect(() => validateBlueprint(nonFinite)).toThrow(/invalid binding timing/);
    const missingBinding = structuredClone(initialEditorBlueprint);
    missingBinding.bindings.pop();
    expect(() => validateBlueprint(missingBinding)).toThrow(/exactly one binding/);
    expect(() => evaluateEditorFrame(initialEditorBlueprint, { ...demoTimeline, bassEnvelope: [...demoTimeline.bassEnvelope].reverse() }, 100)).toThrow(/Feature Timeline/);
  });

  it('rejects effect and Binding parameters outside their supported boundaries', () => {
    const mutations: Array<(blueprint: EditorBlueprint) => void> = [
      (blueprint) => { (blueprint.effects[0] as Extract<EditorBlueprint['effects'][number], { kind: 'pulse-scale' }>).maxScale = 5; },
      (blueprint) => { (blueprint.effects[0] as Extract<EditorBlueprint['effects'][number], { kind: 'glow-brightness' }>).blurPx = 101; },
      (blueprint) => { (blueprint.effects[0] as Extract<EditorBlueprint['effects'][number], { kind: 'rotation-movement' }>).rotationDeg = 361; },
      (blueprint) => { (blueprint.effects[0] as Extract<EditorBlueprint['effects'][number], { kind: 'particles' }>).count = 65; },
      (blueprint) => { (blueprint.effects[0] as Extract<EditorBlueprint['effects'][number], { kind: 'waveform-bars' }>).bars = 129; },
      (blueprint) => { (blueprint.effects[0] as Extract<EditorBlueprint['effects'][number], { kind: 'radial-bars' }>).radius = 0.5; },
      (blueprint) => { (blueprint.effects[0] as Extract<EditorBlueprint['effects'][number], { kind: 'wave-ring' }>).points = 15; },
      (blueprint) => { blueprint.bindings[0]!.strength = 1.1; },
    ];
    const kinds: EditorBlueprint['effects'][number]['kind'][] = ['pulse-scale', 'glow-brightness', 'rotation-movement', 'particles', 'waveform-bars', 'radial-bars', 'wave-ring'];
    mutations.forEach((mutate, index) => {
      const blueprint = structuredClone(initialEditorBlueprint);
      const kind = kinds[index];
      if (kind) blueprint.effects[0] = allEffectsBlueprint().effects.find((effect) => effect.kind === kind)!;
      if (index < 7) blueprint.bindings[0]!.effectId = blueprint.effects[0]!.id;
      mutate(blueprint);
      expect(() => validateBlueprint(blueprint)).toThrow(/Invalid Blueprint/);
    });
  });
});

describe('Canvas integration', () => {
  it('clips every effect draw to its assigned region', () => {
    const fake = fakeContext();
    const commands = renderEditorFrame(fake.context, initialEditorBlueprint, demoTimeline, 1200);
    expect(fake.draws - 1).toBeGreaterThan(0);
    expect(fake.clips).toHaveLength(fake.draws - 1);
    const expectedPaths = commands.map((command) => command.region.kind === 'rect'
      ? `rect:${command.region.x * initialEditorBlueprint.width},${command.region.y * initialEditorBlueprint.height},${command.region.width * initialEditorBlueprint.width},${command.region.height * initialEditorBlueprint.height}`
      : `${command.region.points.map((point, index) => `${index === 0 ? 'move' : 'line'}:${point.x * initialEditorBlueprint.width},${point.y * initialEditorBlueprint.height}`).join('')}:close`);
    expect(fake.clips).toEqual(expectedPaths);
    expect(fake.paintedClipPaths).toEqual(expectedPaths);

    const polygonBlueprint = allEffectsBlueprint();
    const polygonFake = fakeContext();
    const polygonCommands = renderEditorFrame(polygonFake.context, polygonBlueprint, demoTimeline, 1200);
    expect(polygonCommands.filter((command) => command.region.kind === 'polygon' && command.kind === 'rect')).toHaveLength(44);
    expect(polygonFake.paintedClipPaths).toEqual(polygonCommands.map((command) => command.region.kind === 'rect'
      ? `rect:${command.region.x * polygonBlueprint.width},${command.region.y * polygonBlueprint.height},${command.region.width * polygonBlueprint.width},${command.region.height * polygonBlueprint.height}`
      : `${command.region.points.map((point, index) => `${index === 0 ? 'move' : 'line'}:${point.x * polygonBlueprint.width},${point.y * polygonBlueprint.height}`).join('')}:close`));
  });
});
