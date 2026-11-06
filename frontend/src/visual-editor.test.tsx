import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EFFECTS_BY_CATEGORY, effectCategoryFor, VisualEditor } from './VisualEditor';
import { demoTimeline, initialEditorBlueprint, newEditorBlueprint, validateBlueprint } from './editor-model';
import { parseProjectFile, serializeProject } from './project-file';
import { exportMP4, exportWebM, isMP4Supported } from './video-export';

vi.mock('./video-export', () => ({
  exportWebM: vi.fn(async () => new Blob(['mock-webm'], { type: 'video/webm' })),
  exportMP4: vi.fn(async () => new Blob(['mp4'], { type: 'video/mp4;codecs="avc1.42E01E"' })),
  isMP4Supported: vi.fn(() => false),
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

function canvasContext() {
  let fillStyle: string | CanvasGradient | CanvasPattern = '';
  const fills: Array<string | CanvasGradient | CanvasPattern> = [];
  return {
    fills,
    context: {
      get fillStyle() { return fillStyle; }, set fillStyle(value: string | CanvasGradient | CanvasPattern) { fillStyle = value; },
      globalAlpha: 1, shadowColor: '', shadowBlur: 0,
      clearRect() {}, fillRect() { fills.push(fillStyle); },
      createLinearGradient() { return { addColorStop() {} } as CanvasGradient; }, drawImage() {},
      beginPath() {}, rect() {}, moveTo() {}, lineTo() {}, bezierCurveTo() {}, closePath() {}, clip() {},
      save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, ellipse() {}, fill() {}, stroke() {}, strokeRect() {}, setLineDash() {}, setTransform() {},
    } as unknown as CanvasRenderingContext2D,
  };
}

function analyzedWav(durationMs: number): File {
  const frames = Math.round(durationMs * 44_100 / 1000);
  const bytes = new Uint8Array(44 + frames * 4);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string) => { for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index)); };
  ascii(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true); view.setUint32(24, 44_100, true);
  view.setUint32(28, 176_400, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, frames * 4, true);
  return new File([bytes], 'crop.wav', { type: 'audio/wav' });
}

function stubAudioDecoder(duration: number, fail = false) {
  class FakeAudioContext {
    state = 'running';
    async decodeAudioData() { if (fail) throw new Error('decode failure details'); return { duration, length: 8, numberOfChannels: 1, getChannelData: () => new Float32Array([0, 0.2, -0.5, 0, 1, -0.3, 0, 0]) } as unknown as AudioBuffer; }
    async close() { this.state = 'closed'; }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);
}

function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function selectEditorType(host: HTMLElement, kind: import('./editor-model').Effect['kind']) {
  const category = effectCategoryFor(kind);
  act(() => change(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの分類"]')!, category));
  act(() => change(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの種類"]')!, kind));
  act(() => { const details = host.querySelector<HTMLDetailsElement>('.advanced-settings'); if (details) details.open = true; });
}

function addEditorType(host: HTMLElement, category: string, kind: import('./editor-model').Effect['kind']) {
  act(() => change(host.querySelector<HTMLSelectElement>('[aria-label="追加するエフェクトの分類"]')!, category));
  act(() => change(host.querySelector<HTMLSelectElement>('[aria-label="追加するエフェクト"]')!, kind));
  act(() => { const details = host.querySelector<HTMLDetailsElement>('.advanced-settings'); if (details) details.open = true; });
}

afterEach(() => { document.body.replaceChildren(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('VisualEditor interactions', () => {
  it('defaults to WebM, gates MP4 by the selected audio mode, and uses the matching exporter', async () => {
    vi.mocked(isMP4Supported).mockImplementation((withAudio) => !withAudio);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:video');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const fake = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.context);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor />));
    const format = host.querySelector<HTMLSelectElement>('[aria-label="動画形式"]')!;
    expect(format.value).toBe('webm');
    expect(format.querySelector<HTMLOptionElement>('option[value="mp4"]')?.disabled).toBe(false);
    act(() => change(format, 'mp4'));
    expect(format.value).toBe('mp4');
    await act(async () => { host.querySelector<HTMLButtonElement>('.export-actions .primary-button')!.click(); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(exportMP4).toHaveBeenCalledOnce();
    expect(exportWebM).not.toHaveBeenCalled();
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: expect.stringContaining('video/mp4') }));

    const audio = host.querySelector<HTMLSelectElement>('[aria-label="音声"]')!;
    act(() => change(audio, 'with-audio'));
    expect(format.value).toBe('mp4');
    expect(format.querySelector<HTMLOptionElement>('option[value="mp4"]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('.export-actions .primary-button')?.disabled).toBe(true);
    expect(host.textContent).toContain('MP4に対応していません');
    expect(host.textContent).not.toContain('H.264');
    act(() => root.unmount());
  });

  it('starts a new Editor with the ordered Spectrum Bars, Ink Diffusion, and Shockwave defaults', () => {
    validateBlueprint(newEditorBlueprint);
    expect(newEditorBlueprint.effects.map(({ kind }) => kind)).toEqual(['spectrum-bars', 'ink-diffusion', 'shockwave']);
    expect(initialEditorBlueprint.effects.map(({ kind }) => kind)).toContain('waveform-bars');
    expect(initialEditorBlueprint.effects).toHaveLength(5);
    expect(newEditorBlueprint.effects.map((effect) => ({
      kind: effect.kind,
      regionId: effect.regionId,
      color: effect.color,
      colorMode: effect.colorMode,
      opacity: effect.opacity,
      visibilityMode: effect.visibilityMode,
      audioReactive: effect.audioReactive,
    }))).toEqual([
      { kind: 'spectrum-bars', regionId: 'region-stage', color: '#91e8ff', colorMode: 'global-gradient', opacity: 1, visibilityMode: 'always', audioReactive: true },
      { kind: 'ink-diffusion', regionId: 'region-stage', color: '#8b5cf6', colorMode: 'global-gradient', opacity: 1, visibilityMode: 'always', audioReactive: true },
      { kind: 'shockwave', regionId: 'region-stage', color: '#ff48d6', colorMode: 'global-gradient', opacity: 1, visibilityMode: 'triggered', audioReactive: true },
    ]);
    expect(newEditorBlueprint.bindings).toEqual([
      { id: 'binding-effect-spectrum-bars-default', effectId: 'effect-spectrum-bars-default', source: 'music.energy', strength: 0.9, threshold: 0.1, attackMs: 60, releaseMs: 260 },
      { id: 'binding-effect-ink-diffusion-default', effectId: 'effect-ink-diffusion-default', source: 'music.energy', strength: 0.9, threshold: 0.1, attackMs: 60, releaseMs: 260 },
      { id: 'binding-effect-shockwave-default', effectId: 'effect-shockwave-default', source: 'kick.events', strength: 1, threshold: 0, attackMs: 0, releaseMs: 260 },
    ]);
    expect(newEditorBlueprint.effects[0]).toMatchObject({ barWidth: 0.72, spacing: 0.12, amplitudeScale: 1.35, glowIntensity: 1.15, segmented: true, segmentsPerBar: 12, attackMs: 35, releaseMs: 180 });
    expect(newEditorBlueprint.effects[1]).toMatchObject({ diffusionSpeed: 0.25, flowStrength: 0.4, turbulence: 0.3, inkDensity: 0.65, cloudScale: 0.5, responseTime: 3 });
    expect(newEditorBlueprint.globalGradient).toEqual({ startColor: '#22d3ee', middleColor: '#8b5cf6', endColor: '#ec4899', angleDeg: 0 });

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext().context);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor />));
    expect([...host.querySelectorAll('.effect-list button')].map((button) => button.textContent?.trim())).toEqual(['周波数バーステージ', 'インク拡散ステージ', '衝撃波ステージ']);
    expect(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの分類"]')?.value).toBe('EQ / Spectrum');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの種類"]')?.value).toBe('spectrum-bars');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="カラー設定"]')?.value).toBe('global-gradient');
    expect(host.querySelector<HTMLInputElement>('[aria-label="エフェクトの色"]')?.value).toBe('#91e8ff');
    expect(host.querySelector<HTMLInputElement>('[aria-label="エフェクトの色"]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLInputElement>('[aria-label="不透明度"]')?.value).toBe('1');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="表示条件"]')?.value).toBe('always');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="音に反応"]')?.value).toBe('true');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="適用範囲"]')?.value).toBe('region-stage');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="反応させる音"]')?.value).toBe('music.energy');
    expect(host.querySelector<HTMLInputElement>('[aria-label="反応量"]')?.value).toBe('0.9');
    expect(host.querySelector<HTMLInputElement>('[aria-label="しきい値"]')?.value).toBe('0.1');
    expect(host.querySelector<HTMLInputElement>('.binding-fields [aria-label="Attack（ms）"]')?.value).toBe('60');
    expect(host.querySelector<HTMLInputElement>('.binding-fields [aria-label="Release（ms）"]')?.value).toBe('260');
    act(() => host.querySelectorAll<HTMLButtonElement>('.effect-list button')[1]!.click());
    expect(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの分類"]')?.value).toBe('Ambient / Atmospheric');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの種類"]')?.value).toBe('ink-diffusion');
    expect(host.querySelector<HTMLInputElement>('[aria-label="エフェクトの色"]')?.value).toBe('#8b5cf6');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="反応させる音"]')?.value).toBe('music.energy');
    expect(host.querySelector<HTMLInputElement>('[aria-label="反応量"]')?.value).toBe('0.9');
    expect(host.querySelector<HTMLInputElement>('[aria-label="しきい値"]')?.value).toBe('0.1');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Attack（ms）"]')?.value).toBe('60');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Release（ms）"]')?.value).toBe('260');
    act(() => root.unmount());
  });

  it('assigns all twenty Effect Types exactly once and keeps EQ Spectrum separate from Waveform', () => {
    const assigned = Object.values(EFFECTS_BY_CATEGORY).flat();
    expect(assigned).toHaveLength(20);
    expect(new Set(assigned).size).toBe(20);
    expect(new Set(assigned)).toEqual(new Set(['pulse-scale', 'glow-brightness', 'rotation-movement', 'particles', 'waveform-bars', 'waveform-line', 'waveform-peak-bars', 'waveform-ring', 'spectrum-bars', 'spectrum-line', 'radial-bars', 'wave-ring', 'particle-burst', 'particle-trail', 'ripple', 'shockwave', 'oscilloscope-line', 'ink-diffusion', 'ink-flow', 'color-mixing']));
    expect(effectCategoryFor('wave-ring')).toBe('Circular / Radial');
    expect(EFFECTS_BY_CATEGORY['Waveform']).toEqual(['waveform-bars', 'waveform-line', 'waveform-peak-bars', 'oscilloscope-line']);
    expect(EFFECTS_BY_CATEGORY['EQ / Spectrum']).toEqual(['spectrum-bars', 'spectrum-line']);
    expect(effectCategoryFor('spectrum-bars')).toBe('EQ / Spectrum');
    expect(EFFECTS_BY_CATEGORY['Ambient / Atmospheric']).toEqual(['ink-diffusion', 'ink-flow', 'color-mixing']);
    expect(effectCategoryFor('ink-diffusion')).toBe('Ambient / Atmospheric');
    expect(effectCategoryFor('ink-flow')).toBe('Ambient / Atmospheric');
    expect(effectCategoryFor('color-mixing')).toBe('Ambient / Atmospheric');
  });

  it('keeps core settings and Binding visible while effect-specific settings start collapsed', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext().context);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor />));
    const details = host.querySelector<HTMLDetailsElement>('.advanced-settings')!;
    expect(details.open).toBe(false);
    expect(host.querySelector('[aria-label="エフェクトの分類"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="エフェクトの種類"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="カラー設定"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="エフェクトの色"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="不透明度"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="表示条件"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="音に反応"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="適用範囲"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="反応させる音"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="反応量"]')).not.toBeNull();
    expect([...host.querySelectorAll<HTMLSelectElement>('[aria-label="反応させる音"] option')].map((option) => option.textContent?.replace('（利用不可）', ''))).toEqual(['Bass', 'Drums', 'Vocals', 'Other', 'Song', 'Kick', 'Snare（推定）']);
    expect(host.textContent).toContain('Attack（ms）');
    expect(host.textContent).toContain('Release（ms）');
    expect(host.querySelector('[aria-label="バーの幅"]')?.closest('details')?.open).toBe(false);
    act(() => host.querySelector('.advanced-settings > summary')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(host.querySelector<HTMLDetailsElement>('.advanced-settings')?.open).toBe(true);
    expect(host.querySelector('[aria-label="バーの幅"]')).not.toBeNull();
    act(() => host.querySelectorAll<HTMLButtonElement>('.effect-list button')[1]!.click());
    expect(host.querySelector<HTMLDetailsElement>('.advanced-settings')?.open).toBe(false);
    act(() => host.querySelectorAll<HTMLButtonElement>('.effect-list button')[0]!.click());
    expect(host.querySelector<HTMLDetailsElement>('.advanced-settings')?.open).toBe(false);
    act(() => root.unmount());
  });

  it('shows only audio selection and analysis status, all seven Timeline sources, and the native Preview aspect ratio', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext().context);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor />));
    const steps = [...host.querySelectorAll<HTMLElement>('.workflow-step')];
    expect(steps.map((step) => step.querySelector('strong')?.textContent)).toEqual(['音源選択', '音声解析']);
    expect(steps.map((step) => step.querySelector('span')?.textContent)).toEqual(['未選択', '未解析']);
    expect(steps.filter((step) => step.dataset.state === 'done')).toHaveLength(0);
    expect(host.querySelector('.workflow-blueprint')).toBeNull();
    expect(host.querySelectorAll('.timeline-source')).toHaveLength(7);
    const canvas = host.querySelector<HTMLCanvasElement>('[aria-label="映像プレビュー"]')!;
    expect(canvas.width / canvas.height).toBeCloseTo(16 / 9);
    expect(host.querySelector('.editor-layout .workspace')).not.toBeNull();
    expect(host.querySelector('.editor-layout .side-panel')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('.effect-list button[aria-pressed="true"]')).not.toBeNull();
    expect(host.querySelector<HTMLDetailsElement>('.advanced-settings')?.open).toBe(false);
    act(() => root.unmount());
  });

  it('keeps audio, range, and effect editors mounted and preserves edited values when accordions close', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext().context);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor />));
    const accordions = [...host.querySelectorAll<HTMLDetailsElement>('.editor-accordion')];
    expect(accordions.map((details) => details.closest('section')?.getAttribute('aria-label') ?? (details.closest('section')?.classList.contains('editor-regions') ? 'editor-regions' : details.closest('section')?.className))).toEqual(['音源', 'editor-regions', 'effects-panel']);
    expect(accordions.every((details) => details.open)).toBe(true);
    const color = host.querySelector<HTMLInputElement>('[aria-label="エフェクトの色"]')!;
    act(() => change(color, '#ff3366'));
    act(() => { accordions[2]!.open = false; });
    expect(host.querySelector('[aria-label="エフェクトの色"]')).not.toBeNull();
    act(() => { accordions[2]!.open = true; });
    expect(host.querySelector<HTMLInputElement>('[aria-label="エフェクトの色"]')?.value).toBe('#ff3366');
    expect(host.querySelector('[aria-label="再生位置の調整"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it('keeps selected Effect and Delete controls together without changing Effect add/type behavior', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext().context);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor />));
    const effectCount = host.querySelectorAll('.effect-list > button').length;
    expect(host.querySelectorAll('.effect-list > button[aria-pressed="true"]')).toHaveLength(1);
    const deleteButton = [...host.querySelectorAll<HTMLButtonElement>('.effect-add-controls button')].find((button) => button.textContent?.trim() === 'エフェクトを削除')!;
    expect(deleteButton.disabled).toBe(false);
    act(() => deleteButton.click());
    expect(host.querySelectorAll('.effect-list > button')).toHaveLength(effectCount - 1);
    expect(host.querySelectorAll('.effect-list > button[aria-pressed="true"]')).toHaveLength(0);
    expect(host.querySelector<HTMLButtonElement>('.effect-add-controls button')?.disabled).toBe(true);
    addEditorType(host, 'Ambient / Atmospheric', 'ink-flow');
    expect(host.querySelectorAll('.effect-list > button[aria-pressed="true"]')).toHaveLength(1);
    expect(host.querySelector('[aria-label="流れの強さ"]')).not.toBeNull();
    expect([...host.querySelectorAll<HTMLButtonElement>('.effect-add-controls button')].find((button) => button.textContent?.trim() === 'エフェクトを削除')?.disabled).toBe(false);
    act(() => root.unmount());
  });

  it('drags the selected positional Effect gizmo and synchronizes numeric fields both ways', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext().context);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor />));
    const canvas = host.querySelector<HTMLCanvasElement>('[aria-label="映像プレビュー"]')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 640, height: 360, right: 650, bottom: 380, x: 10, y: 20, toJSON() {} });
    const captured = new Set<number>();
    const capture = vi.fn((pointerId: number) => captured.add(pointerId));
    const release = vi.fn((pointerId: number) => captured.delete(pointerId));
    Object.defineProperties(canvas, {
      setPointerCapture: { configurable: true, value: capture },
      hasPointerCapture: { configurable: true, value: (pointerId: number) => captured.has(pointerId) },
      releasePointerCapture: { configurable: true, value: release },
    });
    addEditorType(host, 'Circular / Radial', 'radial-bars');
    act(() => change(host.querySelector<HTMLSelectElement>('[aria-label="適用範囲"]')!, 'region-accent'));
    const handle = host.querySelector<HTMLButtonElement>('[aria-label="放射状バーの位置"]')!;
    expect(host.textContent).toContain('放射状バーの位置をドラッグして調整');
    expect(handle.style.left).toBe('50%');
    expect(handle.style.top).toBe('50%');
    const pointer = (type: string, x: number, y: number, pointerId = 1) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y }, pointerId: { value: pointerId } });
      return event;
    };
    act(() => handle.dispatchEvent(pointer('pointerdown', 330, 200)));
    expect(capture).toHaveBeenCalledWith(1);
    expect([...host.querySelectorAll('.item-list button')].find((button) => button.textContent?.includes('ステージ'))?.classList.contains('selected')).toBe(true);
    act(() => canvas.dispatchEvent(pointer('pointermove', 10 + 0.36 * 640, 20 + 0.66 * 360)));
    expect(host.querySelector('[aria-label="映像プレビュー"]')).toBe(canvas);
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.trim() === '再生')).toBe(true);
    expect(host.querySelector<HTMLInputElement>('[aria-label="中心 X"]')?.value).toBe('0.25');
    act(() => canvas.dispatchEvent(pointer('pointermove', 10 + 0.36 * 640, 20 + 0.66 * 360)));
    act(() => canvas.dispatchEvent(pointer('pointerup', 10 + 0.36 * 640, 20 + 0.66 * 360)));
    expect(release).toHaveBeenCalledWith(1);
    expect(host.querySelector<HTMLInputElement>('[aria-label="中心 X"]')?.value).toBe('0.25');
    expect(host.querySelector<HTMLInputElement>('[aria-label="中心 Y"]')?.value).toBe('0.75');
    const moved = host.querySelector<HTMLButtonElement>('[aria-label="放射状バーの位置"]')!;
    expect(moved.style.left).toBe('36%');
    expect(moved.style.top).toBe('66%');
    act(() => change(host.querySelector<HTMLInputElement>('[aria-label="中心 X"]')!, '0.75'));
    expect(host.querySelector<HTMLButtonElement>('[aria-label="放射状バーの位置"]')?.style.left).toBe('64%');
    const edgeHandle = host.querySelector<HTMLButtonElement>('[aria-label="放射状バーの位置"]')!;
    act(() => edgeHandle.dispatchEvent(pointer('pointerdown', 419, 258, 2)));
    act(() => canvas.dispatchEvent(pointer('pointermove', 1000, -50, 2)));
    act(() => canvas.dispatchEvent(pointer('pointerup', 1000, -50, 2)));
    expect(host.querySelector<HTMLInputElement>('[aria-label="中心 X"]')?.value).toBe('1');
    expect(host.querySelector<HTMLInputElement>('[aria-label="中心 Y"]')?.value).toBe('0');
    const cancelHandle = host.querySelector<HTMLButtonElement>('[aria-label="放射状バーの位置"]')!;
    act(() => cancelHandle.dispatchEvent(pointer('pointerdown', 400, 200, 3)));
    act(() => canvas.dispatchEvent(pointer('pointermove', 10 + 0.2 * 640, 20 + 0.3 * 360, 3)));
    act(() => canvas.dispatchEvent(pointer('pointercancel', 10 + 0.2 * 640, 20 + 0.3 * 360, 3)));
    expect(release).toHaveBeenCalledWith(3);
    const valueAfterCancel = host.querySelector<HTMLInputElement>('[aria-label="中心 X"]')?.value;
    act(() => canvas.dispatchEvent(pointer('pointermove', 10 + 0.8 * 640, 20 + 0.8 * 360, 3)));
    expect(host.querySelector<HTMLInputElement>('[aria-label="中心 X"]')?.value).toBe(valueAfterCancel);
    const lostCaptureHandle = host.querySelector<HTMLButtonElement>('[aria-label="放射状バーの位置"]')!;
    act(() => lostCaptureHandle.dispatchEvent(pointer('pointerdown', 400, 200, 4)));
    act(() => canvas.dispatchEvent(pointer('lostpointercapture', 10 + 0.4 * 640, 20 + 0.4 * 360, 4)));
    const valueAfterLostCapture = host.querySelector<HTMLInputElement>('[aria-label="中心 X"]')?.value;
    act(() => canvas.dispatchEvent(pointer('pointermove', 10 + 0.8 * 640, 20 + 0.8 * 360, 4)));
    expect(host.querySelector<HTMLInputElement>('[aria-label="中心 X"]')?.value).toBe(valueAfterLostCapture);
    act(() => [...host.querySelectorAll<HTMLButtonElement>('.effect-list button')].find((button) => button.textContent?.includes('インク拡散'))!.click());
    expect(host.querySelector('[aria-label="放射状バーの位置"]')).toBeNull();
    expect(host.querySelector('[aria-label^="Drag "][aria-label$=" position"]')).toBeNull();
    act(() => root.unmount());
  });

  it('lets demo image layers select, move, resize with aspect lock, and removes form controls', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext().context);
    class MockImage {
      naturalWidth = 400; naturalHeight = 200; width = 400; height = 200;
      onload: (() => void) | null = null; onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', MockImage);
    class MockFileReader {
      result: string | ArrayBuffer | null = null; onload: (() => void) | null = null; onerror: (() => void) | null = null;
      readAsDataURL() { this.result = 'data:image/png;base64,AAAA'; queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('FileReader', MockFileReader);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor variant="demo" />));
    const input = host.querySelector<HTMLInputElement>('[aria-label="画像を追加"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['a'], 'portrait.png', { type: 'image/png' }), new File(['b'], 'landscape.png', { type: 'image/png' })] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((resolve) => window.setTimeout(resolve, 10)); });
    expect(host.querySelector('[aria-label="画像 1"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="画像位置 X"]')).toBeNull();
    expect(host.querySelector('[aria-label="画像幅"]')).toBeNull();
    const layerOne = host.querySelector<HTMLButtonElement>('[aria-label="画像 1"]')!;
    const layerTwo = host.querySelector<HTMLButtonElement>('[aria-label="画像 2"]')!;
    act(() => layerOne.click());
    const canvas = host.querySelector<HTMLCanvasElement>('[aria-label="映像プレビュー"]')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 320, height: 180, right: 330, bottom: 200, x: 10, y: 20, toJSON() {} });
    const captured = new Set<number>();
    Object.defineProperties(canvas, { setPointerCapture: { configurable: true, value: (id: number) => captured.add(id) }, hasPointerCapture: { configurable: true, value: (id: number) => captured.has(id) }, releasePointerCapture: { configurable: true, value: (id: number) => captured.delete(id) } });
    const pointer = (type: string, x: number, y: number, pointerId = 1) => { const event = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y }, pointerId: { value: pointerId } }); return event; };
    act(() => canvas.dispatchEvent(pointer('pointerdown', 60, 70, 5)));
    act(() => canvas.dispatchEvent(pointer('pointerup', 60, 70, 5)));
    expect(layerTwo.getAttribute('aria-pressed')).toBe('true');
    act(() => canvas.dispatchEvent(pointer('pointerdown', 60, 70)));
    act(() => canvas.dispatchEvent(pointer('pointermove', 85, 80)));
    act(() => canvas.dispatchEvent(pointer('pointerup', 85, 80)));
    expect(host.querySelector<HTMLElement>('.image-selection-outline')?.style.left).toBe('7.813%');
    const east = host.querySelector<HTMLButtonElement>('[aria-label="選択画像のサイズ変更 e"]')!;
    const eastX = 10 + Number(east.style.left.replace('%', '')) * 320 / 100;
    const eastY = 20 + Number(east.style.top.replace('%', '')) * 180 / 100;
    act(() => east.dispatchEvent(pointer('pointerdown', eastX, eastY, 6)));
    act(() => canvas.dispatchEvent(pointer('pointermove', eastX + 10, eastY, 6)));
    act(() => canvas.dispatchEvent(pointer('pointerup', eastX + 10, eastY, 6)));
    const unlockedOutline = host.querySelector<HTMLElement>('.image-selection-outline')!;
    expect((Number(unlockedOutline.style.width.replace('%', '')) * 640) / (Number(unlockedOutline.style.height.replace('%', '')) * 360)).not.toBeCloseTo(2);
    act(() => host.querySelector<HTMLInputElement>('[aria-label="縦横比を固定"]')!.click());
    const lockedOutline = host.querySelector<HTMLElement>('.image-selection-outline')!;
    expect((Number(lockedOutline.style.width.replace('%', '')) * 640) / (Number(lockedOutline.style.height.replace('%', '')) * 360)).toBeCloseTo(2);
    const southEast = host.querySelector<HTMLButtonElement>('[aria-label="選択画像のサイズ変更 se"]')!;
    const handleX = 10 + Number(southEast.style.left.replace('%', '')) * 320 / 100;
    const handleY = 20 + Number(southEast.style.top.replace('%', '')) * 180 / 100;
    act(() => southEast.dispatchEvent(pointer('pointerdown', handleX, handleY, 2)));
    act(() => canvas.dispatchEvent(pointer('pointermove', handleX + 20, handleY + 10, 2)));
    act(() => canvas.dispatchEvent(pointer('pointerup', handleX + 20, handleY + 10, 2)));
    const outline = host.querySelector<HTMLElement>('.image-selection-outline')!;
    expect((Number(outline.style.width.replace('%', '')) * 640) / (Number(outline.style.height.replace('%', '')) * 360)).toBeCloseTo(2);
    expect(host.querySelector('[aria-label="画像 2"]')).not.toBeNull();
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.includes('クロップ範囲を指定'))).toBe(true);
    act(() => host.querySelector<HTMLDetailsElement>('.image-settings')!.querySelector('summary')!.dispatchEvent(new Event('click', { bubbles: true })));
    act(() => [...host.querySelectorAll<HTMLButtonElement>('.image-settings button')].find((button) => button.textContent?.includes('クロップ範囲を指定'))!.click());
    act(() => canvas.dispatchEvent(pointer('pointerdown', 60, 70, 3)));
    act(() => canvas.dispatchEvent(pointer('pointermove', 110, 100, 3)));
    act(() => canvas.dispatchEvent(pointer('pointercancel', 110, 100, 3)));
    expect(host.querySelector('.image-crop-outline')).toBeNull();
    act(() => canvas.dispatchEvent(pointer('pointerdown', 60, 70, 4)));
    act(() => canvas.dispatchEvent(pointer('pointermove', 110, 100, 4)));
    act(() => canvas.dispatchEvent(pointer('pointerup', 110, 100, 4)));
    expect(host.querySelector('.image-crop-outline')).not.toBeNull();
    act(() => [...host.querySelectorAll<HTMLButtonElement>('.image-layer-order button')].find((button) => button.textContent?.includes('レイヤーを背面へ'))!.click());
    expect(host.querySelector<HTMLButtonElement>('.image-layer-controls button[aria-pressed="true"]')?.getAttribute('aria-label')).toBe('画像 1');
    act(() => host.querySelector<HTMLButtonElement>('.image-delete')!.click());
    expect(host.querySelectorAll('.image-layer-controls button')).toHaveLength(1);
    expect(host.querySelector('[aria-label="画像 2"]')).toBeNull();
    act(() => root.unmount());
  });

  it('provides position handles for the center-based kinds and 粒子バースト origin', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext().context);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor />));
    const centerKinds: Array<import('./editor-model').Effect['kind']> = ['radial-bars', 'wave-ring', 'ripple', 'shockwave'];
    for (const kind of centerKinds) {
      selectEditorType(host, kind);
      expect(host.querySelector(`[aria-label="${kind === 'radial-bars' ? '放射状バー' : kind === 'wave-ring' ? '波形リング' : kind === 'ripple' ? '波紋' : '衝撃波'}の位置"]`)).not.toBeNull();
      expect(host.querySelector('[aria-label="中心 X"]')).not.toBeNull();
    }
    addEditorType(host, 'Particles', 'particle-burst');
    expect(host.querySelector('[aria-label="粒子バーストの位置"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="発生位置 X"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="発生位置 Y"]')).not.toBeNull();
    expect(host.querySelectorAll('.effect-position-handle')).toHaveLength(1);
    act(() => root.unmount());
  });

  it('filters existing Effect Types by Category without applying a Type until selection', () => {
    const fake = canvasContext(); vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.context);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor />));
    selectEditorType(host, 'wave-ring');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの分類"]')?.value).toBe('Circular / Radial');
    const amplitude = host.querySelector<HTMLInputElement>('[aria-label="振幅"]')!;
    expect(amplitude.value).toBe('0.14');
    expect(host.querySelector<HTMLInputElement>('[aria-label="不透明度"]')?.value).toBe('1');
    expect(host.querySelector<HTMLInputElement>('[aria-label="層の数"]')?.value).toBe('4');
    expect(host.querySelector<HTMLInputElement>('[aria-label="層の数"]')?.max).toBe('10');
    expect(host.querySelector<HTMLInputElement>('[aria-label="層ごとの角度差（自動は0）"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="層ごとの半径差"]')).toBeNull();
    expect(host.querySelector<HTMLSelectElement>('[aria-label="表示条件"]')?.value).toBe('always');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="音に反応"]')?.value).toBe('true');
    act(() => change(host.querySelector<HTMLSelectElement>('[aria-label="音に反応"]')!, 'false'));
    expect(host.querySelector<HTMLSelectElement>('[aria-label="表示条件"]')?.value).toBe('always');
    act(() => change(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの分類"]')!, 'Waveform'));
    const type = host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの種類"]')!;
    expect(type.value).toBe('');
    expect([...type.options].map((option) => option.value).filter(Boolean)).toEqual(['waveform-bars', 'waveform-line', 'waveform-peak-bars', 'oscilloscope-line']);
    expect(host.querySelector<HTMLInputElement>('[aria-label="振幅"]')?.value).toBe('0.14');
    act(() => change(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの分類"]')!, 'Circular / Radial'));
    expect(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの種類"]')?.value).toBe('wave-ring');
    expect(host.querySelector<HTMLInputElement>('[aria-label="振幅"]')?.value).toBe('0.14');
    act(() => change(host.querySelector<HTMLInputElement>('[aria-label="不透明度"]')!, '0.4'));
    act(() => change(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの種類"]')!, 'radial-bars'));
    expect(host.querySelector<HTMLInputElement>('[aria-label="中心 X"]')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('[aria-label="振幅"]')).toBeNull();
    expect(host.querySelector<HTMLInputElement>('[aria-label="不透明度"]')?.value).toBe('0.4');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="音に反応"]')?.value).toBe('false');
    act(() => root.unmount());
  });

  it('adds Ink Diffusion under Ambient / Atmospheric with its defaults and music Binding', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext().context);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor />));
    addEditorType(host, 'Ambient / Atmospheric', 'ink-diffusion');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの分類"]')?.value).toBe('Ambient / Atmospheric');
    expect(host.querySelector<HTMLInputElement>('[aria-label="広がる速さ"]')?.value).toBe('0.25');
    expect(host.querySelector<HTMLInputElement>('[aria-label="反応時間（秒）"]')?.value).toBe('3');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="反応させる音"]')?.value).toBe('music.energy');
    act(() => root.unmount());
  });

  it('adds Ink Flow and Color Mixing with independent music bindings and type-specific controls', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext().context);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor />));
    addEditorType(host, 'Ambient / Atmospheric', 'ink-flow');
    expect(host.querySelector<HTMLInputElement>('[aria-label="流れの強さ"]')?.value).toBe('0.95');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="反応させる音"]')?.value).toBe('music.energy');
    addEditorType(host, 'Ambient / Atmospheric', 'color-mixing');
    expect(host.querySelector<HTMLInputElement>('[aria-label="雲の大きさ"]')?.value).toBe('0.9');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="反応させる音"]')?.value).toBe('music.energy');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="表示条件"]')?.value).toBe('always');
    act(() => change(host.querySelector<HTMLSelectElement>('[aria-label="カラー設定"]')!, 'custom'));
    expect(host.querySelectorAll('[aria-label^="パレットの色 "]')).toHaveLength(3);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="パレットの色を追加"]')!.click());
    expect(host.querySelectorAll('[aria-label^="パレットの色 "]')).toHaveLength(4);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="パレットの色を削除 4"]')!.click());
    expect(host.querySelectorAll('[aria-label^="パレットの色 "]')).toHaveLength(3);
    act(() => root.unmount());
  });

  it('pins 粒子 to Triggered and 音に反応 ON for add and in-place Type changes', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext().context);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor />));
    addEditorType(host, 'Particles', 'particles');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="表示条件"]')?.value).toBe('triggered');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="音に反応"]')?.value).toBe('true');
    addEditorType(host, 'Particles', 'particle-burst');
    selectEditorType(host, 'particles');
    const visibility = host.querySelector<HTMLSelectElement>('[aria-label="表示条件"]')!;
    const reactive = host.querySelector<HTMLSelectElement>('[aria-label="音に反応"]')!;
    expect(visibility.value).toBe('triggered');
    expect(visibility.disabled).toBe(true);
    expect([...visibility.options].map((option) => option.value)).toEqual(['triggered']);
    expect(reactive.value).toBe('true');
    expect(reactive.disabled).toBe(true);
    act(() => root.unmount());
  });

  it('uses the same Category then Type flow for Add Effect', () => {
    const fake = canvasContext(); vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.context);
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor variant="app" />));
    act(() => change(host.querySelector<HTMLSelectElement>('[aria-label="追加するエフェクトの分類"]')!, 'Impacts'));
    const type = host.querySelector<HTMLSelectElement>('[aria-label="追加するエフェクト"]')!;
    expect([...type.options].map((option) => option.value).filter(Boolean)).toEqual(['ripple', 'shockwave']);
    act(() => change(type, 'shockwave'));
    act(() => { const details = host.querySelector<HTMLDetailsElement>('.advanced-settings'); if (details) details.open = true; });
    expect(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの分類"]')?.value).toBe('Impacts');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの種類"]')?.value).toBe('shockwave');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="反応させる音"]')?.value).toBe('kick.events');
    expect(host.querySelector<HTMLInputElement>('[aria-label="しきい値"]')?.value).toBe('0');
    expect(host.querySelector<HTMLInputElement>('[aria-label="反応量"]')?.value).toBe('1');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Attack（ms）"]')?.value).toBe('0');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Release（ms）"]')?.value).toBe('260');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="表示条件"]')?.value).toBe('always');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="音に反応"]')?.value).toBe('true');
    const gateMode = host.querySelector<HTMLSelectElement>('[aria-label="キック音の検出感度"]')!;
    expect(gateMode.value).toBe('middle');
    expect(gateMode.closest('.workflow-audio')).toBeNull();
    expect(gateMode.closest('.effects-panel')).not.toBeNull();
    expect(host.querySelector('.global-gradient-panel')?.compareDocumentPosition(gateMode)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(gateMode.compareDocumentPosition(host.querySelector('.effect-list')!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    act(() => change(gateMode, 'soft'));
    expect(host.querySelector<HTMLSelectElement>('[aria-label="キック音の検出感度"]')?.value).toBe('soft');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/v1/audio/analyze'))).toBe(false);
    selectEditorType(host, 'wave-ring');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="キック音の検出感度"]')?.value).toBe('soft');
    act(() => [...host.querySelectorAll<HTMLButtonElement>('.effect-add-controls button')].find((button) => button.textContent?.trim() === 'エフェクトを削除')!.click());
    expect(host.querySelector<HTMLSelectElement>('[aria-label="キック音の検出感度"]')?.value).toBe('soft');
    act(() => root.unmount());
  });

  it('adds and changes to Spectrum Effects through the independent EQ Category', () => {
    const fake = canvasContext(); vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.context);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor />));
    addEditorType(host, 'EQ / Spectrum', 'spectrum-bars');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの分類"]')?.value).toBe('EQ / Spectrum');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの種類"]')?.value).toBe('spectrum-bars');
    expect(host.querySelector<HTMLInputElement>('[aria-label="バー内の区切り数"]')?.value).toBe('12');
    act(() => change(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの分類"]')!, 'Waveform'));
    expect(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの種類"]')?.value).toBe('');
    expect(host.querySelector<HTMLInputElement>('[aria-label="バー内の区切り数"]')).not.toBeNull();
    act(() => change(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの分類"]')!, 'EQ / Spectrum'));
    act(() => change(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの種類"]')!, 'spectrum-line'));
    expect(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの種類"]')?.value).toBe('spectrum-line');
    expect(host.querySelector<HTMLInputElement>('[aria-label="滑らかさ"]')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('[aria-label="バー内の区切り数"]')).toBeNull();
    act(() => root.unmount());
  });

  it('exposes visibility and reactive controls for all twenty Effect Types', () => {
    const fake = canvasContext(); vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.context);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor />));
    for (const kind of Object.values(EFFECTS_BY_CATEGORY).flat()) {
      selectEditorType(host, kind);
      expect(host.querySelector<HTMLSelectElement>('[aria-label="表示条件"]'), kind).not.toBeNull();
      expect(host.querySelector<HTMLSelectElement>('[aria-label="音に反応"]'), kind).not.toBeNull();
    }
    act(() => root.unmount());
  });

  it('derives Category after loading a v1 project without storing Category fields', async () => {
    const fake = canvasContext(); vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.context);
    const blueprint = structuredClone(initialEditorBlueprint);
    blueprint.effects = [{ id: 'saved-wave-ring', kind: 'wave-ring', regionId: 'region-stage', color: '#ddbbff', centerX: 0.5, centerY: 0.5, radius: 0.28, amplitude: 0.14, points: 64, lineWidth: 0.018, smoothing: 0.55, rotationMode: 'continuous', beatsPerRevolution: 8, rotationDirection: 'clockwise', initialAngleDeg: 0 }];
    blueprint.bindings = [{ id: 'saved-binding', effectId: 'saved-wave-ring', source: 'music.energy', strength: 0.8, threshold: 0.1, attackMs: 30, releaseMs: 120 }];
    const blob = await serializeProject(blueprint, demoTimeline, null);
    const projectJson = JSON.parse(await blob.text()) as { blueprint: { effects: Array<Record<string, unknown>> } };
    expect(projectJson.blueprint.effects[0]).not.toHaveProperty('category');
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor />));
    const input = host.querySelector<HTMLInputElement>('[aria-label="プロジェクトファイルを選択"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([blob], 'roundtrip.arvproj')] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((resolve) => window.setTimeout(resolve, 10)); });
    expect(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの分類"]')?.value).toBe('Circular / Radial');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの種類"]')?.value).toBe('wave-ring');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="反応させる音"]')?.value).toBe('music.energy');
    expect(host.querySelector<HTMLInputElement>('[aria-label="エフェクトの色"]')?.value).toBe('#ddbbff');
    act(() => root.unmount());
  });

  it('derives EQ / Spectrum after restoring a saved Spectrum Effect from Project v1', async () => {
    const fake = canvasContext(); vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.context);
    const blueprint = structuredClone(initialEditorBlueprint);
    const effect = { id: 'saved-spectrum', kind: 'spectrum-line' as const, regionId: 'region-stage', color: '#c5aaff', amplitudeScale: 1.4, lineWidth: 0.01, smoothing: 0.3, glowIntensity: 0.8, attackMs: 40, releaseMs: 180 };
    blueprint.effects = [effect];
    blueprint.bindings = [{ id: 'saved-spectrum-binding', effectId: effect.id, source: 'music.energy', strength: 0.8, threshold: 0.1, attackMs: 20, releaseMs: 140 }];
    const sourceTimeline = { ...demoTimeline, frequencySpectrum: { hopMs: 20 as const, fftSize: 4096 as const, bandCount: 32 as const, sampleRateHz: 44100, minHz: 40, maxHz: 16000, normalization: 'whole-clip-p99-log-rms' as const, encoding: 'uint8-linear-0-255' as const, values: Array.from({ length: 600 * 32 }, (_, index) => index % 256) } };
    const blob = await serializeProject(blueprint, sourceTimeline, null);
    const saved = JSON.parse(await blob.text()) as { blueprint: { effects: Array<Record<string, unknown>> } };
    expect(saved.blueprint.effects[0]).not.toHaveProperty('category');
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor />));
    const input = host.querySelector<HTMLInputElement>('[aria-label="プロジェクトファイルを選択"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([blob], 'spectrum.arvproj')] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの分類"]')?.value).toBe('EQ / Spectrum');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの種類"]')?.value).toBe('spectrum-line');
    expect(host.querySelector<HTMLInputElement>('[aria-label="滑らかさ"]')?.value).toBe('0.3');
    act(() => root.unmount());
  });

  it('exposes BPM rotation controls with an eight beat default for circular Effects', () => {
    const fake = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.context);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor />));
    selectEditorType(host, 'wave-ring');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="回転方法"]')?.value).toBe('continuous');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="1回転あたりの拍数"]')?.value).toBe('8');
    expect(host.textContent).toContain('テンポ： 120（標準）');
    act(() => change(host.querySelector<HTMLSelectElement>('[aria-label="回転方法"]')!, 'triggered'));
    expect(host.querySelector<HTMLSelectElement>('[aria-label="回転方法"]')?.value).toBe('triggered');
    act(() => root.unmount());
  });

  it('changes the selected effect type in place and switches only incompatible Binding sources', () => {
    const fake = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.context);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor />));
    const region = host.querySelector<HTMLSelectElement>('[aria-label="適用範囲"]')!;
    expect(region.value).toBe('region-stage');
    expect(host.querySelectorAll('[aria-label="反応させる音"] option')).toHaveLength(7);
    selectEditorType(host, 'particle-burst');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの種類"]')?.value).toBe('particle-burst');
    expect(host.querySelector('[aria-label="発生位置 X"]')).not.toBeNull();
    expect(host.querySelector<HTMLSelectElement>('[aria-label="反応させる音"]')?.value).toBe('music.energy');
    const strength = host.querySelector<HTMLInputElement>('[aria-label="反応量"]')!;
    act(() => change(strength, '0.42'));
    selectEditorType(host, 'particle-trail');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの種類"]')?.value).toBe('particle-trail');
    expect(host.querySelector('[aria-label="サンプル数"]')).not.toBeNull();
    expect(host.querySelector<HTMLSelectElement>('[aria-label="反応させる音"]')?.value).toBe('music.energy');
    expect(host.querySelector<HTMLInputElement>('[aria-label="反応量"]')?.value).toBe('0.42');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="適用範囲"]')?.value).toBe('region-stage');
    const expectedSource = 'music.energy';
    for (const kind of ['pulse-scale', 'glow-brightness', 'rotation-movement', 'particles', 'waveform-bars', 'radial-bars', 'wave-ring', 'particle-burst', 'particle-trail', 'ripple', 'shockwave', 'oscilloscope-line']) {
      selectEditorType(host, kind as import('./editor-model').Effect['kind']);
      expect(host.querySelector<HTMLSelectElement>('[aria-label="エフェクトの種類"]')?.value).toBe(kind);
      expect(host.querySelector<HTMLSelectElement>('[aria-label="反応させる音"]')?.value).toBe(expectedSource);
      expect(host.querySelector<HTMLSelectElement>('[aria-label="適用範囲"]')?.value).toBe('region-stage');
      expect(host.querySelector<HTMLInputElement>('[aria-label="反応量"]')?.value).toBe('0.42');
    }
    act(() => root.unmount());
  });

  it('loads a validated Blueprint from the local fixture API', async () => {
    const fake = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.context);
    sessionStorage.setItem('arvc.local.auth.session.v1', JSON.stringify({ accessToken: 'user-jwt', refreshToken: 'refresh', expiresAt: Date.now() + 60_000, email: 'ai@example.test' }));
    const generated = structuredClone(initialEditorBlueprint);
    generated.seed = 4242;
    generated.effects.push({ id: 'generated-burst', kind: 'particle-burst', regionId: 'region-stage', color: '#ff48d6', originX: 0.5, originY: 0.5, directionDeg: 0, spreadDeg: 90, speedPxPerSec: 420, lifetimeMs: 1500, count: 32, sizePx: 7 });
    generated.bindings.push({ id: 'binding-generated-burst', effectId: 'generated-burst', source: 'kick.events', strength: 0.9, threshold: 0.1, attackMs: 60, releaseMs: 260 });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/api/v1/blueprints/generate')
      ? ({ ok: true, json: async () => ({ mode: 'fixture', blueprint: generated }) })
      : ({ ok: true, json: async () => ({ items: [] }) })));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<VisualEditor />));
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'サンプル設定を読み込む');
    await act(async () => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(host.textContent).toContain('サンプル設定の設定を読み込みました。エフェクトを編集できます。');
    const burstRow = [...host.querySelectorAll<HTMLButtonElement>('.effect-list button')].find((item) => item.textContent?.includes('粒子バースト'))!;
    act(() => burstRow.click());
    act(() => { const details = host.querySelector<HTMLDetailsElement>('.advanced-settings'); if (details) details.open = true; });
    expect(host.querySelector<HTMLSelectElement>('[aria-label="反応させる音"]')?.value).toBe('kick.events');
    expect(host.querySelector<HTMLInputElement>('[aria-label="しきい値"]')?.value).toBe('0');
    expect(host.querySelector<HTMLInputElement>('[aria-label="反応量"]')?.value).toBe('1');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Attack（ms）"]')?.value).toBe('60');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Release（ms）"]')?.value).toBe('260');
    expect(fetch).toHaveBeenCalledWith('/api/v1/blueprints/generate', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer user-jwt', 'Idempotency-Key': expect.any(String) }) }));
    act(() => root.unmount());
  });

  it('loads a selected static demo and follows its audio clock without API requests', async () => {
    const fake = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.context);
    const timelineJson = { schemaVersion: 1, analysisVersion: 'python-island/0.1.0', sampleRateHz: 44_100, timeUnit: 'ms', durationMs: 1000, bassEnvelope: [{ timeMs: 0, value: 0.2 }, { timeMs: 1000, value: 0.8 }], kickEvents: [250], kickEventStrengths: [0.7], drumEnergy: [{ timeMs: 0, value: 0.1 }, { timeMs: 1000, value: 0.4 }] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => { void input; return new Response(JSON.stringify(timelineJson), { status: 200 }); });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(1);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor variant="demo" />));
    expect([...host.querySelectorAll('.effect-list button')].map((button) => button.textContent?.trim())).toEqual(['周波数バーステージ', 'インク拡散ステージ', '衝撃波ステージ']);
    const audio = host.querySelector<HTMLAudioElement>('audio[aria-label="デモ音源"]')!;
    expect(audio.getAttribute('src')).toBe('/demo/audio-reactive-silent-demo1.mp3');
    expect(host.querySelector('[aria-label="クラウド保存"]')).toBeNull();
    expect(host.querySelector('[aria-label="音源を選択"]')).toBeNull();
    expect(host.querySelector('[aria-label="プロジェクトファイルを選択"]')).toBeNull();
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.includes('動画を書き出す'))).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith('/demo/demo1.feature-timeline-v2.json');

    let currentTime = 0;
    let metadataLoaded = false;
    Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => metadataLoaded ? currentTime : 0, set: (value: number) => { if (metadataLoaded) currentTime = value; } });
    const seek = host.querySelector<HTMLInputElement>('[aria-label="再生位置の調整"]')!;
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(seek.disabled).toBe(false);
    act(() => change(seek, '400'));
    expect(audio.currentTime).toBe(0);
    expect(host.querySelector('output')?.textContent).toContain('0.40 s');

    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); metadataLoaded = true; audio.dispatchEvent(new Event('loadedmetadata')); });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(audio.currentTime).toBe(0.4);

    const play = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === '再生')!;
    await act(async () => { play.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(audio.currentTime).toBe(0.4);
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.trim() === '一時停止')).toBe(true);
    act(() => change(seek, '600'));
    expect(audio.currentTime).toBe(0.6);
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.trim() === '一時停止')).toBe(true);
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === '一時停止')!.click(); await Promise.resolve(); });
    expect(audio.currentTime).toBe(0.6);
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === '再生')!.click(); await Promise.resolve(); });
    expect(audio.currentTime).toBe(0.6);
    await act(async () => { audio.currentTime = 0.75; audio.dispatchEvent(new Event('timeupdate')); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(host.querySelector('output')?.textContent).toContain('0.75 s');

    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === '停止')!.click(); await Promise.resolve(); });
    expect(audio.currentTime).toBe(0);
    expect(host.querySelector('output')?.textContent).toContain('0.00 s');
    act(() => change(seek, '1000'));
    expect(audio.currentTime).toBe(1);
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === '再生')!.click(); await Promise.resolve(); });
    expect(audio.currentTime).toBe(0);

    const selector = host.querySelector<HTMLSelectElement>('select[aria-label="デモ楽曲"]')!;
    change(selector, 'demo2');
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); audio.dispatchEvent(new Event('loadedmetadata')); });
    expect(audio.getAttribute('src')).toBe('/demo/audio-reactive-silent-demo2.mp3');
    expect(fetchMock).toHaveBeenCalledWith('/demo/demo2.feature-timeline-v2.json');
    expect(host.querySelector('output')?.textContent).toContain('0.00 s');
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith('/demo/'))).toBe(true);
    act(() => root.unmount());
  });

  it('shows a blocking error when a static demo Timeline is missing', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext().context);
    const fetchMock = vi.fn(async () => new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor variant="demo" />));
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('HTTP 404');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === '再生')?.disabled).toBe(true);
    act(() => root.unmount());
  });

  it('requires range confirmation in the authenticated app before any analysis or Blueprint request', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext().context);
    sessionStorage.setItem('arvc.local.auth.session.v1', JSON.stringify({ accessToken: 'user-jwt', refreshToken: 'refresh', expiresAt: Date.now() + 60_000, email: 'user@example.test' }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/api/v1/projects?limit=20');
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:source-audio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    stubAudioDecoder(90);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor variant="app" />));
    const input = host.querySelector<HTMLInputElement>('[aria-label="音源を選択"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['wav-test'], 'source.wav', { type: 'audio/wav' })] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    const generate = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('エフェクトを生成'))!;
    expect(generate.disabled).toBe(true);
    const workflowSteps = [...host.querySelectorAll<HTMLElement>('.workflow-step')];
    expect(workflowSteps.map((step) => step.querySelector('strong')?.textContent)).toEqual(['音源選択', '音声解析']);
    expect(workflowSteps.map((step) => step.querySelector('span')?.textContent)).toEqual(['選択済み', '未解析']);
    expect(workflowSteps.map((step) => step.dataset.state)).toEqual(['done', 'pending']);
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.includes('範囲を確定して解析'))).toBe(true);
    expect(fetchMock.mock.calls.map((call) => String(call[0])).some((url) => url.includes('/api/v1/audio/analyze') || url.includes('/api/v1/blueprints/generate'))).toBe(false);
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'キャンセル')!.click(); await Promise.resolve(); });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:source-audio');
    act(() => root.unmount());
  });

  it.each([30, 60, 90])('limits the default selection for a %i-second source', async (duration) => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext().context);
    sessionStorage.setItem('arvc.local.auth.session.v1', JSON.stringify({ accessToken: 'user-jwt', refreshToken: 'refresh', expiresAt: Date.now() + 60_000, email: 'user@example.test' }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:source-audio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor variant="app" />));
    const input = host.querySelector<HTMLInputElement>('[aria-label="音源を選択"]')!;
    stubAudioDecoder(duration);
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['wav-test'], 'source.wav', { type: 'audio/wav' })] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    const length = host.querySelector<HTMLInputElement>('[aria-label="選択する長さ"]')!;
    expect(Number(length.value)).toBe(Math.min(duration, 60));
    expect(Number(length.max)).toBe(Math.min(duration, 60));
    act(() => root.unmount());
  });

  it('does not open the range dialog when decoding fails and gives a retry instruction', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext().context);
    sessionStorage.setItem('arvc.local.auth.session.v1', JSON.stringify({ accessToken: 'user-jwt', refreshToken: 'refresh', expiresAt: Date.now() + 60_000, email: 'user@example.test' }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:source-audio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    stubAudioDecoder(10, true);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor variant="app" />));
    const input = host.querySelector<HTMLInputElement>('[aria-label="音源を選択"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['source'], 'broken.mp3', { type: 'audio/mpeg' })] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((resolve) => window.setTimeout(resolve, 10)); });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('別の音源を選択してください');
    act(() => root.unmount());
  });

  it('passes the committed crop analysis into the existing Blueprint generation request', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext().context);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    sessionStorage.setItem('arvc.local.auth.session.v1', JSON.stringify({ accessToken: 'user-jwt', refreshToken: 'refresh', expiresAt: Date.now() + 60_000, email: 'user@example.test' }));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:source-audio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    stubAudioDecoder(1);
    class FakeOfflineAudioContext {
      destination = {};
      constructor(public channels: number, public frames: number, public rate: number) {}
      createBufferSource() { return { buffer: null, connect() {}, start() {} }; }
      async startRendering() { const data = new Float32Array(this.frames).fill(0.1); return { length: this.frames, sampleRate: this.rate, numberOfChannels: this.channels, getChannelData: () => data } as unknown as AudioBuffer; }
    }
    vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
    const analysisTimeline = { ...demoTimeline, schemaVersion: 1, timeUnit: 'ms', analysisVersion: 'python-island/test', sampleRateHz: 44_100, durationMs: 1000, bassEnvelope: [{ timeMs: 0, value: 0.2 }, { timeMs: 1000, value: 0.5 }], kickEvents: [] };
    const summary = { summaryVersion: 1, durationMs: 1000, sourceAudio: { format: 'wav', codec: 'pcm_s16le', sampleRateHz: 44_100, channels: 2, fileBytes: 176_444 }, analysis: { model: 'scnet_standard', device: 'cpu', stemRms: { drums: 0.1, bass: 0.2, vocals: 0.1, other: 0.1 }, estimatedKickCount: 0, featureSampleRateHz: 100, kickDetection: 'test' } };
    let resolveAnalysis: ((response: Response) => void) | undefined;
    const pendingAnalysis = new Promise<Response>((resolve) => { resolveAnalysis = resolve; });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push({ url, init });
      if (url.endsWith('/api/v1/projects?limit=20')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.endsWith('/api/v1/audio/analyze')) return pendingAnalysis;
      if (url.endsWith('/api/v1/blueprints/generate')) return new Response(JSON.stringify({ mode: 'fixture', blueprint: structuredClone(initialEditorBlueprint) }), { status: 200 });
      throw new Error(`unexpected request ${url}`);
    }));
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor variant="app" />));
    const input = host.querySelector<HTMLInputElement>('[aria-label="音源を選択"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['source-audio-bytes'], 'source.wav', { type: 'audio/wav' })] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    const gateMode = host.querySelector<HTMLSelectElement>('[aria-label="キック音の検出感度"]')!;
    expect(gateMode.value).toBe('middle');
    act(() => change(gateMode, 'soft'));
    const statusRows = [...host.querySelectorAll<HTMLElement>('.workflow-step')];
    expect(statusRows.map((row) => row.querySelector('span')?.textContent)).toEqual(['選択済み', '未解析']);
    const analyze = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('範囲を確定して解析'))!;
    await act(async () => { analyze.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise((resolve) => window.setTimeout(resolve, 30)); });
    expect(statusRows.map((row) => row.querySelector('span')?.textContent)).toEqual(['選択済み', '解析中']);
    expect(statusRows.map((row) => row.dataset.state)).toEqual(['done', 'pending']);
    await act(async () => {
      resolveAnalysis?.(new Response(JSON.stringify({ featureTimeline: analysisTimeline, musicSummary: summary, analysisMetadata: { metadataVersion: 1 } }), { status: 200 }));
      await new Promise((resolve) => window.setTimeout(resolve, 30));
    });
    expect(host.textContent).toContain('解析済み範囲: 1.00 秒');
    expect(statusRows.map((row) => row.querySelector('span')?.textContent)).toEqual(['選択済み', '解析済み']);
    expect(statusRows.map((row) => row.dataset.state)).toEqual(['done', 'done']);
    const analysisCall = calls.find((call) => call.url.endsWith('/api/v1/audio/analyze'))!;
    expect(analysisCall.init?.headers).toEqual({ Authorization: 'Bearer user-jwt' });
    expect((analysisCall.init?.body as FormData).get('audio')).toBeInstanceOf(File);
    expect((analysisCall.init?.body as FormData).get('kickGateMode')).toBe('soft');
    const generate = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('エフェクトを生成'))!;
    expect(generate.disabled).toBe(false);
    expect(calls.some((call) => call.url.endsWith('/api/v1/blueprints/generate'))).toBe(false);
    await act(async () => { generate.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    const generationCall = calls.find((call) => call.url.endsWith('/api/v1/blueprints/generate'))!;
    const request = JSON.parse(String(generationCall.init?.body)) as { musicSummary: { durationMs: number; analysis: { model: string } }; featureTimeline: Record<string, unknown> };
    expect(request.musicSummary.durationMs).toBe(1000);
    expect(request.musicSummary.analysis.model).toBe('scnet_standard');
    expect(request.featureTimeline.durationMs).toBe(1000);
    expect(request.featureTimeline.waveformPeaks).toBeUndefined();
    expect(request.featureTimeline.vocalsEnvelope).toBeUndefined();
    const playback = host.querySelector<HTMLAudioElement>('[aria-label="編集プレビュー音声"]')!;
    expect(playback.src).toBe('blob:source-audio');
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === '再生')!.click(); await Promise.resolve(); });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.trim() === '一時停止')).toBe(true);
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === '一時停止')!.click(); await Promise.resolve(); });
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    act(() => change(host.querySelector<HTMLInputElement>('[aria-label="再生位置の調整"]')!, '500'));
    expect(playback.currentTime).toBe(0.5);
    const audioTrack = host.querySelector<HTMLSelectElement>('[aria-label="音声"]')!;
    act(() => change(audioTrack, 'with-audio'));
    const exportButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === '動画を書き出す')!;
    await act(async () => { exportButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    const exportInput = vi.mocked(exportWebM).mock.calls.at(-1)?.[0];
    expect(exportInput?.timeline.durationMs).toBe(1000);
    expect(exportInput?.audioFile?.name).toBe('source-clip.wav');
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['replacement-audio'], 'replacement.wav', { type: 'audio/wav' })] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(statusRows.map((row) => row.querySelector('span')?.textContent)).toEqual(['選択済み', '未解析']);
    expect(statusRows.map((row) => row.dataset.state)).toEqual(['done', 'pending']);
    act(() => root.unmount());
  });

  it('keeps authentication available while hiding Cloud Project UI and automatic project-list requests', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'local-public-key');
    const fake = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.context);
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/auth/v1/token?grant_type=password')) return new Response(JSON.stringify({ access_token: 'user-jwt', refresh_token: 'refresh', expires_in: 3600, user: { email: 'local@example.test' } }), { status: 200 });
      throw new Error(`unexpected local request ${init?.method ?? 'GET'} ${url}`);
    }));
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor />));
    expect(host.querySelector('canvas')).not.toBeNull();
    expect(host.querySelector('[aria-label="クラウド保存"]')).toBeNull();
    expect(host.textContent).not.toContain('クラウドに保存');
    expect(host.textContent).not.toContain('新規作成');
    expect(host.textContent).not.toContain('一覧を更新');
    expect(host.querySelector('[aria-label="プロジェクトファイルを選択"]')).not.toBeNull();
    const email = host.querySelector<HTMLInputElement>('[aria-label="メールアドレス"]')!;
    const password = host.querySelector<HTMLInputElement>('[aria-label="パスワード"]')!;
    change(email, 'local@example.test'); change(password, 'local-password');
    const login = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'ログイン')!;
    await act(async () => { login.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(host.textContent).toContain('ログイン中：local@example.test');
    expect(host.querySelector('[aria-label="クラウド保存"]')).toBeNull();
    expect(requests.some((request) => request.includes('/api/v1/projects'))).toBe(false);
    act(() => root.unmount());
  });

  it('restores an embedded audio file, selects audio export, and passes that file to WebM export', async () => {
    const fake = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.context);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:project-test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const audio = new File([new Uint8Array([7, 8, 9, 10])], 'restored.wav', { type: 'audio/wav' });
    const projectBlob = await serializeProject(initialEditorBlueprint, demoTimeline, audio);
    const projectFile = new File([projectBlob], 'audio-project.arvproj', { type: 'application/json' });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<VisualEditor />));

    const projectInput = host.querySelector<HTMLInputElement>('[aria-label="プロジェクトファイルを選択"]')!;
    Object.defineProperty(projectInput, 'files', { configurable: true, value: [projectFile] });
    await act(async () => {
      projectInput.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(host.querySelector<HTMLSelectElement>('[aria-label="音声"]')?.value).toBe('with-audio');
    expect(host.textContent).toContain('使用中の音源：restored.wav');
    const exportButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === '動画を書き出す');
    await act(async () => {
      exportButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(exportWebM).toHaveBeenCalledWith(expect.objectContaining({ audioFile: expect.objectContaining({ name: 'restored.wav', type: 'audio/wav' }) }));

    const silentProjectBlob = await serializeProject(initialEditorBlueprint, demoTimeline, null);
    const silentProjectFile = new File([silentProjectBlob], 'silent-project.arvproj', { type: 'application/json' });
    Object.defineProperty(projectInput, 'files', { configurable: true, value: [silentProjectFile] });
    await act(async () => {
      projectInput.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(host.querySelector<HTMLSelectElement>('[aria-label="音声"]')?.value).toBe('silent');
    expect(host.textContent).not.toContain('使用中の音源：restored.wav');
    act(() => root.unmount());
  });

  it('restores the saved analysis summary and regenerates a Blueprint without reanalysis', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext().context);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    sessionStorage.setItem('arvc.local.auth.session.v1', JSON.stringify({ accessToken: 'user-jwt', refreshToken: 'refresh', expiresAt: Date.now() + 60_000, email: 'user@example.test' }));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:project-audio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); calls.push(url);
      if (url.endsWith('/api/v1/projects?limit=20')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.endsWith('/api/v1/blueprints/generate')) return new Response(JSON.stringify({ mode: 'fixture', blueprint: structuredClone(initialEditorBlueprint) }), { status: 200 });
      throw new Error(`unexpected request ${url}`);
    }));
    const clip = analyzedWav(demoTimeline.durationMs);
    const musicSummary = {
      summaryVersion: 1 as const, durationMs: demoTimeline.durationMs,
      sourceAudio: { format: 'wav', codec: 'pcm_s16le', sampleRateHz: 44_100, channels: 2, fileBytes: clip.size },
      analysis: { model: 'htdemucs', device: 'cpu', stemRms: { drums: 0.1, bass: 0.2, vocals: 0.1, other: 0.1 }, estimatedKickCount: 1, featureSampleRateHz: 100, kickDetection: 'fixture' },
    };
    const projectBlob = await serializeProject(initialEditorBlueprint, demoTimeline, clip, new Date(), musicSummary);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor variant="app" />));
    const projectInput = host.querySelector<HTMLInputElement>('[aria-label="プロジェクトファイルを選択"]')!;
    Object.defineProperty(projectInput, 'files', { configurable: true, value: [new File([projectBlob], 'analyzed.arvproj', { type: 'application/json' })] });
    await act(async () => { projectInput.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(host.querySelector('.audio-generation-action')?.hasAttribute('hidden')).toBe(true);
    expect(host.textContent).toContain('プロジェクトを読み込みました。');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="音声"]')?.value).toBe('with-audio');
    const playback = host.querySelector<HTMLAudioElement>('[aria-label="編集プレビュー音声"]')!;
    expect(playback.src).toBe('blob:project-audio');
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === '再生')!.click(); await Promise.resolve(); });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    act(() => change(host.querySelector<HTMLInputElement>('[aria-label="再生位置の調整"]')!, '2500'));
    expect(playback.currentTime).toBe(2.5);
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.playback-controls button')].find((button) => button.textContent?.trim() === '停止')!.click(); await Promise.resolve(); });
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'エフェクトを生成')!.click(); await Promise.resolve(); });
    expect(calls.filter((url) => url.endsWith('/api/v1/audio/analyze'))).toHaveLength(0);
    expect(calls.filter((url) => url.endsWith('/api/v1/blueprints/generate'))).toHaveLength(1);
    act(() => root.unmount());
  });

  it('reports export failure and restores the UI for a manual retry', async () => {
    const fake = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.context);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:retry-test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.mocked(exportWebM).mockRejectedValueOnce(new Error('動画を作成できませんでした。'));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<VisualEditor />));
    const exportButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === '動画を書き出す')!;
    await act(async () => {
      exportButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('動画を作成できませんでした。');
    expect(exportButton.disabled).toBe(false);
    await act(async () => {
      exportButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('動画を保存しました');
    expect(exportWebM).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it('keeps the current editor state when project restoration fails', async () => {
    const fake = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.context);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<VisualEditor />));
    const regionNamesBefore = [...host.querySelectorAll('.item-list button')].map((button) => button.textContent);
    const malformed = new File(['not-json'], 'broken.arvproj', { type: 'application/json' });
    const projectInput = host.querySelector<HTMLInputElement>('[aria-label="プロジェクトファイルを選択"]')!;
    Object.defineProperty(projectInput, 'files', { configurable: true, value: [malformed] });
    await act(async () => {
      projectInput.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect([...host.querySelectorAll('.item-list button')].map((button) => button.textContent)).toEqual(regionNamesBefore);
    expect(host.textContent).toContain('ファイルを読み込めませんでした。');
    act(() => root.unmount());
  });

  it('reflects background edits, effect and binding edits, and seeks through fixed features', () => {
    const fake = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.context);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<VisualEditor timeline={{ ...demoTimeline, drumEnergy: [{ timeMs: 0, value: 0.1 }, { timeMs: 12000, value: 0.7 }] }} />));
    const button = (name: string) => [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === name);
    act(() => button('単色')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(fake.fills).toContain('#141824');

    const addEffect = host.querySelector<HTMLSelectElement>('[aria-label="追加するエフェクト"]');
    expect(addEffect).not.toBeNull();
    addEditorType(host, 'Particles', 'particles');
    expect(host.textContent).toContain('粒子');
    expect(host.querySelector<HTMLInputElement>('[aria-label="最大粒子数"]')?.max).toBe('64');
    expect(host.querySelector('[aria-label="横方向の広がり"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="音による速度変化"]')).not.toBeNull();

    const source = host.querySelector<HTMLSelectElement>('[aria-label="反応させる音"]');
    expect(source?.value).toBe('bass.envelope');
    act(() => change(source!, 'drums.energy'));
    expect(source?.value).toBe('drums.energy');
    const strength = host.querySelector<HTMLInputElement>('[aria-label="反応量"]');
    act(() => change(strength!, '0.55'));
    expect(strength?.value).toBe('0.55');

    addEditorType(host, 'Circular / Radial', 'radial-bars');
    expect(host.textContent).toContain('放射状バー');
    expect(host.querySelector('[aria-label="バーの長さ"]')).not.toBeNull();
    addEditorType(host, 'Circular / Radial', 'wave-ring');
    expect(host.textContent).toContain('波形リング');
    expect(host.querySelector('[aria-label="振幅"]')).not.toBeNull();

    addEditorType(host, 'Particles', 'particle-burst');
    expect(host.textContent).toContain('粒子バースト');
    expect(host.querySelector('[aria-label="発生位置 X"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="渦の回転数"]')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('[aria-label="最大粒子数"]')?.max).toBe('64');
    expect(host.querySelector('[aria-label="音の影響"]')).not.toBeNull();
    expect(host.querySelector<HTMLSelectElement>('[aria-label="反応させる音"]')?.value).toBe('kick.events');
    addEditorType(host, 'Particles', 'particle-trail');
    expect(host.textContent).toContain('粒子の軌跡');
    expect(host.querySelector('[aria-label="サンプル数"]')).not.toBeNull();
    expect(host.querySelector<HTMLSelectElement>('[aria-label="反応させる音"]')?.value).toBe('bass.envelope');
    addEditorType(host, 'Impacts', 'ripple');
    expect(host.textContent).toContain('波紋');
    expect(host.querySelector('[aria-label="波の数"]')).not.toBeNull();
    expect(host.querySelector<HTMLSelectElement>('[aria-label="反応させる音"]')?.value).toBe('bass.envelope');
    addEditorType(host, 'Impacts', 'shockwave');
    expect(host.textContent).toContain('衝撃波');
    expect(host.querySelector('[aria-label="最大半径"]')).not.toBeNull();
    expect(host.querySelector<HTMLSelectElement>('[aria-label="反応させる音"]')?.value).toBe('kick.events');
    addEditorType(host, 'Waveform', 'oscilloscope-line');
    expect(host.textContent).toContain('オシロスコープ線');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="波形の向き"]')?.value).toBe('horizontal');
    expect(host.textContent).toContain('元の音声波形そのものではありません');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="反応させる音"]')?.value).toBe('bass.envelope');

    const seek = host.querySelector<HTMLInputElement>('[aria-label="再生位置の調整"]');
    expect(seek).not.toBeNull();
    act(() => change(seek!, '3200'));
    expect(host.querySelector('output')?.textContent).toContain('3.20 s');

    act(() => root.unmount());
  });

  it('plays, pauses and stops the fixed preview clock', async () => {
    const fake = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.context);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<VisualEditor />));
    const button = (name: string) => [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === name);
    act(() => button('再生')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(button('一時停止')).toBeDefined();
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 90)));
    const output = host.querySelector('output')!;
    expect(Number.parseFloat(output.textContent ?? '0')).toBeGreaterThan(0);
    act(() => button('一時停止')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const pausedAt = output.textContent;
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 60)));
    expect(output.textContent).toBe(pausedAt);
    act(() => button('停止')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(output.textContent).toContain('0.00 s');
    act(() => root.unmount());
  });

  it('creates and deletes normalized rectangles and polygons through the region tools', () => {
    const fake = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.context);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<VisualEditor />));
    const canvas = host.querySelector('canvas')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360, toJSON() {},
    });
    Object.defineProperty(canvas, 'setPointerCapture', { configurable: true, value: () => {} });
    const pointer = (type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y }, pointerId: { value: 1 } });
      canvas.dispatchEvent(event);
    };
    const button = (name: string) => [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === name);

    act(() => button('四角形を描く')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => pointer('pointerdown', 64, 72));
    act(() => pointer('pointermove', 256, 216));
    act(() => pointer('pointerup', 256, 216));
    expect(host.textContent).toContain('範囲 3');
    const rectWidth = host.querySelector<HTMLInputElement>('[aria-label="範囲 width"]')!;
    expect(rectWidth.value).toBe('0.3');
    act(() => change(rectWidth, '0.25'));
    expect(rectWidth.value).toBe('0.25');
    const addEffect = host.querySelector<HTMLSelectElement>('[aria-label="追加するエフェクト"]')!;
    act(() => change(addEffect, 'glow-brightness'));
    expect([...host.querySelectorAll('.effect-list button')].some((item) => item.textContent?.includes('発光・明るさ') && item.textContent.includes('範囲 3'))).toBe(true);

    act(() => button('多角形を描く')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => pointer('pointerdown', 320, 72));
    act(() => pointer('pointerdown', 480, 72));
    act(() => pointer('pointerdown', 400, 180));
    act(() => button('多角形を確定')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(host.textContent).toContain('多角形');
    const firstPointX = host.querySelector<HTMLInputElement>('[aria-label="頂点 1 の x"]')!;
    expect(firstPointX.value).toBe('0.5');
    act(() => change(firstPointX, '0.52'));
    expect(firstPointX.value).toBe('0.52');

    const region3 = [...host.querySelectorAll('.item-list button')].find((item) => item.textContent?.includes('範囲 3'))!;
    act(() => region3.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => button('範囲を削除')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect([...host.querySelectorAll('.item-list button')].some((item) => item.textContent?.includes('範囲 3'))).toBe(false);
    expect([...host.querySelectorAll('.effect-list button')].some((item) => item.textContent?.includes('発光・明るさ') && item.textContent.includes('範囲 3'))).toBe(false);
    expect(host.textContent).toContain('範囲 4');
    const region4 = [...host.querySelectorAll('.item-list button')].find((item) => item.textContent?.includes('範囲 4'))!;
    act(() => region4.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => button('範囲を削除')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(host.textContent).not.toContain('範囲 4');
    act(() => root.unmount());
  });

  it('moves and resizes the selected Rectangle in Preview using CSS-scaled Stage coordinates and saves it to Project v1', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext().context);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:region-project');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor />));
    const canvas = host.querySelector<HTMLCanvasElement>('[aria-label="映像プレビュー"]')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 320, height: 180, right: 330, bottom: 200, x: 10, y: 20, toJSON() {} });
    const captured = new Set<number>();
    Object.defineProperties(canvas, {
      setPointerCapture: { configurable: true, value: (id: number) => { captured.add(id); } },
      hasPointerCapture: { configurable: true, value: (id: number) => captured.has(id) },
      releasePointerCapture: { configurable: true, value: (id: number) => { captured.delete(id); } },
    });
    const pointer = (type: string, x: number, y: number, pointerId: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y }, pointerId: { value: pointerId } });
      return event;
    };
    const selectRegion = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('.item-list button')].find((button) => button.textContent?.includes(name))!;
    act(() => selectRegion('ステージ').click());
    selectEditorType(host, 'radial-bars');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="範囲の直接編集"]')!.click());
    expect(host.querySelector('[aria-label="放射状バーの位置"]')).toBeNull();
    expect(host.querySelectorAll('.region-edit-handle')).toHaveLength(9);
    const moveHandle = host.querySelector<HTMLButtonElement>('[aria-label="ステージを移動"]')!;
    act(() => moveHandle.dispatchEvent(pointer('pointerdown', 170, 110, 1)));
    expect(captured.has(1)).toBe(true);
    act(() => canvas.dispatchEvent(pointer('pointermove', 202, 128, 1)));
    expect(host.querySelector<HTMLInputElement>('[aria-label="範囲 x"]')?.value).toBe('0.22');
    expect(host.querySelector<HTMLInputElement>('[aria-label="範囲 y"]')?.value).toBe('0.24');
    act(() => canvas.dispatchEvent(pointer('pointerup', 202, 128, 1)));
    expect(captured.has(1)).toBe(false);
    const northwest = host.querySelector<HTMLButtonElement>('[aria-label="ステージをサイズ変更 nw"]')!;
    act(() => northwest.dispatchEvent(pointer('pointerdown', 80, 78, 2)));
    act(() => canvas.dispatchEvent(pointer('pointermove', 105.6, 92.4, 2)));
    act(() => canvas.dispatchEvent(pointer('pointerup', 105.6, 92.4, 2)));
    expect(host.querySelector<HTMLInputElement>('[aria-label="範囲 x"]')?.value).toBe('0.3');
    expect(host.querySelector<HTMLInputElement>('[aria-label="範囲 y"]')?.value).toBe('0.32');
    expect(host.querySelector<HTMLInputElement>('[aria-label="範囲 width"]')?.value).toBe('0.68');
    expect(host.querySelector<HTMLInputElement>('[aria-label="範囲 height"]')?.value).toBe('0.64');
    const east = host.querySelector<HTMLButtonElement>('[aria-label="ステージをサイズ変更 e"]')!;
    act(() => east.dispatchEvent(pointer('pointerdown', 323.6, 135.2, 7)));
    act(() => canvas.dispatchEvent(pointer('pointermove', 298, 135.2, 7)));
    expect(host.querySelector<HTMLInputElement>('[aria-label="範囲 x"]')?.value).toBe('0.3');
    expect(host.querySelector<HTMLInputElement>('[aria-label="範囲 width"]')?.value).toBe('0.6');
    act(() => canvas.dispatchEvent(pointer('pointerup', 298, 135.2, 7)));
    const resizedEast = host.querySelector<HTMLButtonElement>('[aria-label="ステージをサイズ変更 e"]')!;
    act(() => resizedEast.dispatchEvent(pointer('pointerdown', 298, 135.2, 8)));
    act(() => canvas.dispatchEvent(pointer('pointermove', 323.6, 135.2, 8)));
    act(() => canvas.dispatchEvent(pointer('pointerup', 323.6, 135.2, 8)));
    expect(host.querySelector<HTMLInputElement>('[aria-label="範囲 width"]')?.value).toBe('0.68');
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.trim() === '再生')).toBe(true);

    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'プロジェクトを保存')!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const savedUrl = vi.mocked(URL.createObjectURL).mock.results.at(-1)?.value as string;
    expect(savedUrl).toBe('blob:region-project');
    expect(host.textContent).toContain('プロジェクトを保存しました');
    expect(host.textContent).toContain('保存したファイルには、使用した音源や画像が含まれる場合があります。共有する際は内容をご確認ください。');
    expect(host.textContent).not.toContain('暗号化');
    const projectData = vi.mocked(URL.createObjectURL).mock.calls.at(-1)?.[0] as Blob;
    const projectEnvelope = JSON.parse(await projectData.text()) as { formatVersion: number };
    expect(projectEnvelope.formatVersion).toBe(1);
    const restored = await parseProjectFile(new File([projectData], 'region-edited.arvproj'));
    expect(restored.blueprint.regions.find((region) => region.id === 'region-stage')?.geometry).toEqual({ kind: 'rect', x: 0.3, y: 0.32, width: 0.68, height: 0.64 });

    const projectInput = host.querySelector<HTMLInputElement>('[aria-label="プロジェクトファイルを選択"]')!;
    Object.defineProperty(projectInput, 'files', { configurable: true, value: [new File([projectData], 'region-edited.arvproj')] });
    await act(async () => { projectInput.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(host.querySelector<HTMLInputElement>('[aria-label="範囲 x"]')?.value).toBe('0.3');
    expect(host.querySelector<HTMLInputElement>('[aria-label="範囲 height"]')?.value).toBe('0.64');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="範囲の直接編集"]')!.click());
    const restoredMoveHandle = host.querySelector<HTMLButtonElement>('[aria-label="ステージを移動"]')!;
    act(() => restoredMoveHandle.dispatchEvent(pointer('pointerdown', 214.8, 135.2, 6)));
    act(() => canvas.dispatchEvent(pointer('pointermove', 500, 500, 6)));
    act(() => canvas.dispatchEvent(pointer('pointerup', 500, 500, 6)));
    expect(host.querySelector<HTMLInputElement>('[aria-label="範囲 x"]')?.value).toBe('0.32');
    expect(host.querySelector<HTMLInputElement>('[aria-label="範囲 y"]')?.value).toBe('0.36');
    act(() => root.unmount());
  });

  it('moves polygon vertices directly and ends range capture on pointer cancellation or capture loss', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext().context);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); act(() => root.render(<VisualEditor />));
    const canvas = host.querySelector<HTMLCanvasElement>('[aria-label="映像プレビュー"]')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 320, height: 180, right: 330, bottom: 200, x: 10, y: 20, toJSON() {} });
    const captured = new Set<number>();
    Object.defineProperties(canvas, {
      setPointerCapture: { configurable: true, value: (id: number) => { captured.add(id); } },
      hasPointerCapture: { configurable: true, value: (id: number) => captured.has(id) },
      releasePointerCapture: { configurable: true, value: (id: number) => { captured.delete(id); } },
    });
    const pointer = (type: string, x: number, y: number, pointerId: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y }, pointerId: { value: pointerId } });
      return event;
    };
    const region = [...host.querySelectorAll<HTMLButtonElement>('.item-list button')].find((button) => button.textContent?.includes('アクセント'))!;
    act(() => region.click());
    selectEditorType(host, 'radial-bars');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="範囲の直接編集"]')!.click());
    expect(host.querySelector('[aria-label="放射状バーの位置"]')).toBeNull();
    const vertex = host.querySelector<HTMLButtonElement>('[aria-label="アクセントの頂点 1 を移動"]')!;
    act(() => vertex.dispatchEvent(pointer('pointerdown', 170, 52.4, 3)));
    act(() => canvas.dispatchEvent(pointer('pointermove', 186, 59.6, 3)));
    expect(host.querySelector<HTMLInputElement>('[aria-label="頂点 1 の x"]')?.value).toBe('0.55');
    expect(host.querySelector<HTMLInputElement>('[aria-label="頂点 1 の y"]')?.value).toBe('0.22');
    act(() => canvas.dispatchEvent(pointer('pointerup', 186, 59.6, 3)));
    expect(captured.has(3)).toBe(false);

    const movedVertex = host.querySelector<HTMLButtonElement>('[aria-label="アクセントの頂点 1 を移動"]')!;
    act(() => movedVertex.dispatchEvent(pointer('pointerdown', 186, 59.6, 4)));
    act(() => canvas.dispatchEvent(pointer('pointermove', 195.6, 64.6, 4)));
    act(() => canvas.dispatchEvent(pointer('pointercancel', 195.6, 64.6, 4)));
    expect(captured.has(4)).toBe(false);
    const afterCancel = host.querySelector<HTMLInputElement>('[aria-label="頂点 1 の x"]')?.value;
    act(() => canvas.dispatchEvent(pointer('pointermove', 250, 150, 4)));
    expect(host.querySelector<HTMLInputElement>('[aria-label="頂点 1 の x"]')?.value).toBe(afterCancel);

    const cancelVertex = host.querySelector<HTMLButtonElement>('[aria-label="アクセントの頂点 1 を移動"]')!;
    act(() => cancelVertex.dispatchEvent(pointer('pointerdown', 195.6, 64.6, 5)));
    act(() => canvas.dispatchEvent(pointer('lostpointercapture', 195.6, 64.6, 5)));
    const afterLostCapture = host.querySelector<HTMLInputElement>('[aria-label="頂点 1 の x"]')?.value;
    act(() => canvas.dispatchEvent(pointer('pointermove', 270, 160, 5)));
    expect(host.querySelector<HTMLInputElement>('[aria-label="頂点 1 の x"]')?.value).toBe(afterLostCapture);
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.trim() === '再生')).toBe(true);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="範囲の直接編集"]')!.click());
    expect(host.querySelector('[aria-label="放射状バーの位置"]')).not.toBeNull();
    act(() => root.unmount());
  });
});
