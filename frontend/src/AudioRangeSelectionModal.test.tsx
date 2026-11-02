import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioRangeSelectionModal, clampAudioRange, createAudioRange } from './AudioRangeSelectionModal';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

function renderModal() {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const onRangeChange = vi.fn(); const onConfirm = vi.fn(); const onCancel = vi.fn(); const onAbort = vi.fn();
  const headXs: number[] = [];
  const context = { strokeStyle: '', lineWidth: 1, setTransform() {}, clearRect() {}, fillRect() {}, beginPath() {}, moveTo(x: number) { if (this.strokeStyle === '#fff' && this.lineWidth === 2) headXs.push(x); }, lineTo() {}, stroke() {}, arc() {}, fill() {} };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 160, width: 1000, height: 160, toJSON() {} });
  act(() => root.render(<AudioRangeSelectionModal audioUrl="blob:audio" waveform={new Float32Array([0, 0.5, 1, 0.25])} duration={100} start={10} end={60} onRangeChange={onRangeChange} onConfirm={onConfirm} onCancel={onCancel} onAbort={onAbort} busy={false} status="" />));
  return { host, root, onRangeChange, onConfirm, onCancel, onAbort, headXs };
}

function renderControlledModal(duration: number, initialStart: number, initialEnd: number) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const onRangeChange = vi.fn(); const onConfirm = vi.fn(); const onCancel = vi.fn(); const onAbort = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform() {}, clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {} } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 160, width: 1000, height: 160, toJSON() {} });
  function Harness() {
    const [range, setRange] = useState({ start: initialStart, end: initialEnd });
    return <AudioRangeSelectionModal audioUrl="blob:audio" waveform={new Float32Array([0, 0.5, 1, 0.25])} duration={duration} start={range.start} end={range.end} onRangeChange={(next) => { onRangeChange(next); setRange(next); }} onConfirm={onConfirm} onCancel={onCancel} onAbort={onAbort} busy={false} status="" />;
  }
  act(() => root.render(<Harness />));
  return { host, root, onRangeChange, onConfirm, onCancel, onAbort };
}

describe('audio range modal', () => {
  it('clamps both boundaries, preserves the duration cap, and moves a selected interval', () => {
    expect(clampAudioRange(-4, 60, 90, 'start')).toEqual({ start: 0, end: 60 });
    expect(clampAudioRange(50, 90, 90, 'end')).toEqual({ start: 50, end: 90 });
    expect(clampAudioRange(40, 100, 120, 'end')).toEqual({ start: 40, end: 100 });
    expect(clampAudioRange(75, 135, 90, 'move', { start: 60, end: 90 })).toEqual({ start: 60, end: 90 });
    expect(clampAudioRange(30, 90, 120, 'move', { start: 20, end: 80 })).toEqual({ start: 30, end: 90 });
    expect(createAudioRange(1, 90, 120)).toEqual({ start: 1, end: 61 });
    expect(createAudioRange(90, 1, 120)).toEqual({ start: 30, end: 90 });
    expect(createAudioRange(0, 0.001, 5)).toEqual({ start: 0, end: 0.01 });
    expect(createAudioRange(0, 0.001, 0.005)).toEqual({ start: 0, end: 0.005 });
  });

  it('shows the waveform dialog, drags either edge or the interval, and routes confirmation', () => {
    const { host, root, onRangeChange, onConfirm } = renderModal();
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
    expect(host.querySelectorAll('input[type="range"]')).toHaveLength(1);
    expect(host.querySelector('[aria-label="解析範囲の開始位置"]')).toBeNull();
    expect(host.querySelector('[aria-label="解析範囲の終了位置"]')).toBeNull();
    const canvas = host.querySelector('canvas')!;
    const send = (type: string, x: number, pointerId = 4) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { clientX: { value: x }, clientY: { value: 80 }, pointerId: { value: pointerId } });
      canvas.dispatchEvent(event);
    };
    Object.defineProperties(canvas, { setPointerCapture: { value: vi.fn() }, hasPointerCapture: { value: () => true }, releasePointerCapture: { value: vi.fn() } });
    act(() => { send('pointerdown', 100); send('pointermove', 200); send('pointerup', 200); });
    expect(onRangeChange).toHaveBeenLastCalledWith({ start: 20, end: 60 });
    act(() => { send('pointerdown', 400, 5); send('pointermove', 500, 5); send('pointerup', 500, 5); });
    expect(onRangeChange).toHaveBeenLastCalledWith({ start: 20, end: 70 });
    act(() => { send('pointerdown', 600, 6); send('pointermove', 700, 6); send('pointerup', 700, 6); });
    expect(onRangeChange).toHaveBeenLastCalledWith({ start: 10, end: 70 });
    const audio = host.querySelector<HTMLAudioElement>('audio')!;
    act(() => { send('pointerdown', 400, 7); send('pointerup', 400, 7); });
    expect(audio.currentTime).toBe(40);
    act(() => { send('pointerdown', 10, 8); send('pointermove', 900, 8); send('pointerup', 900, 8); });
    expect(onRangeChange).toHaveBeenLastCalledWith({ start: 1, end: 61 });
    act(() => { send('pointerdown', 900, 9); send('pointermove', 10, 9); send('pointerup', 10, 9); });
    expect(onRangeChange).toHaveBeenLastCalledWith({ start: 30, end: 90 });
    act(() => { send('pointerdown', 950, 10); send('pointerup', 950, 10); });
    expect(audio.currentTime).toBe(95);
    act(() => host.querySelector<HTMLButtonElement>('.primary-button')!.click());
    expect(onConfirm).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it('uses one duration slider, keeps the start fixed, syncs waveform changes, and does not control playback', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const { host, root, onRangeChange } = renderControlledModal(90, 20, 50);
    const slider = host.querySelector<HTMLInputElement>('[aria-label="選択する長さ"]')!;
    const audio = host.querySelector<HTMLAudioElement>('audio')!;
    Object.defineProperty(audio, 'currentTime', { configurable: true, value: 25, writable: true });
    expect(slider.value).toBe('30');
    expect(slider.min).toBe('0.01');
    expect(slider.max).toBe('60');
    const setSlider = (value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(slider, value);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    };
    act(() => setSlider('60'));
    expect(onRangeChange).toHaveBeenLastCalledWith({ start: 20, end: 80 });
    expect(host.querySelector('.audio-range-values')?.textContent).toContain('開始 20.00秒');
    expect(host.querySelector('.audio-range-values')?.textContent).toContain('終了 80.00秒');
    expect(host.querySelector('.audio-range-values')?.textContent).toContain('選択 60.00秒');
    expect(slider.value).toBe('60');
    expect(audio.currentTime).toBe(25);
    expect(play).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();

    const canvas = host.querySelector('canvas')!;
    Object.defineProperties(canvas, { setPointerCapture: { value: vi.fn() }, hasPointerCapture: { value: () => true }, releasePointerCapture: { value: vi.fn() } });
    const pointer = (type: string, x: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { clientX: { value: x }, clientY: { value: 80 }, pointerId: { value: 12 } });
      canvas.dispatchEvent(event);
    };
    act(() => { pointer('pointerdown', 222); pointer('pointermove', 278); pointer('pointerup', 278); });
    expect(onRangeChange).toHaveBeenLastCalledWith({ start: 25.04, end: 80 });
    expect(Number(slider.value)).toBeCloseTo(54.96);
    expect(audio.currentTime).toBe(25);
    act(() => root.unmount());
  });

  it('sets the duration slider bounds to the remaining audio and handles very short sources', () => {
    const { host, root } = renderControlledModal(90, 40, 50);
    const slider = host.querySelector<HTMLInputElement>('[aria-label="選択する長さ"]')!;
    expect(slider.min).toBe('0.01');
    expect(slider.max).toBe('50');
    expect(slider.value).toBe('10');
    act(() => root.unmount());

    const short = renderControlledModal(0.005, 0, 0.005);
    const shortSlider = short.host.querySelector<HTMLInputElement>('[aria-label="選択する長さ"]')!;
    expect(shortSlider.min).toBe('0.005');
    expect(shortSlider.max).toBe('0.005');
    expect(shortSlider.value).toBe('0.005');
    act(() => short.root.unmount());
  });

  it('supports keyboard duration adjustment and Escape cancellation', () => {
    const { host, root, onRangeChange, onCancel } = renderModal();
    const length = host.querySelector<HTMLInputElement>('[aria-label="選択する長さ"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(length, '5');
    act(() => { length.dispatchEvent(new Event('input', { bubbles: true })); length.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onRangeChange).toHaveBeenCalledWith({ start: 10, end: 15 });
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onCancel).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it('plays only the selected interval, resets at its end, and stops when the dialog closes', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const { host, root, onCancel } = renderModal();
    const audio = host.querySelector<HTMLAudioElement>('audio')!;
    let currentTime = 0;
    Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => currentTime, set: (value: number) => { currentTime = value; } });
    await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click(); await Promise.resolve(); });
    expect(currentTime).toBe(10);
    expect(play).toHaveBeenCalledOnce();
    act(() => { currentTime = 60; audio.dispatchEvent(new Event('timeupdate')); });
    expect(pause).toHaveBeenCalled();
    expect(currentTime).toBe(10);
    act(() => onCancel());
    act(() => root.unmount());
  });

  it('stops audition and resets audio and waveform playhead to the selection start before replay', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const { host, root, headXs } = renderModal();
    const audio = host.querySelector<HTMLAudioElement>('audio')!;
    let currentTime = 0;
    Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => currentTime, set: (value: number) => { currentTime = value; } });
    const audition = () => host.querySelector<HTMLButtonElement>('.audio-range-actions button')!;

    await act(async () => { audition().click(); await Promise.resolve(); });
    expect(currentTime).toBe(10);
    expect(audition().textContent).toBe('停止');
    act(() => { currentTime = 35; audio.dispatchEvent(new Event('timeupdate')); });
    expect(headXs.at(-1)).toBe(350);
    act(() => audition().click());
    expect(pause).toHaveBeenCalledOnce();
    expect(currentTime).toBe(10);
    expect(headXs.at(-1)).toBe(100);
    expect(audition().textContent).toBe('選択範囲を試聴');

    await act(async () => { audition().click(); await Promise.resolve(); });
    expect(currentTime).toBe(10);
    expect(headXs.at(-1)).toBe(100);
    expect(play).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it('returns to the latest selection start after the range changes and at natural end', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const { host, root } = renderControlledModal(100, 10, 60);
    const audio = host.querySelector<HTMLAudioElement>('audio')!;
    let currentTime = 0;
    Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => currentTime, set: (value: number) => { currentTime = value; } });
    const audition = () => host.querySelector<HTMLButtonElement>('.audio-range-actions button')!;
    await act(async () => { audition().click(); await Promise.resolve(); });
    const canvas = host.querySelector<HTMLCanvasElement>('canvas')!;
    const pointer = (type: string, x: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { clientX: { value: x }, clientY: { value: 80 }, pointerId: { value: 1 } });
      canvas.dispatchEvent(event);
    };
    Object.defineProperties(canvas, { setPointerCapture: { value: vi.fn() }, hasPointerCapture: { value: () => true }, releasePointerCapture: { value: vi.fn() } });
    act(() => { pointer('pointerdown', 100); pointer('pointermove', 200); pointer('pointerup', 200); });
    expect(host.querySelector('.audio-range-values')?.textContent).toContain('開始 20.00秒');
    act(() => audition().click());
    expect(currentTime).toBe(20);

    await act(async () => { audition().click(); await Promise.resolve(); });
    act(() => { currentTime = 70; audio.dispatchEvent(new Event('ended')); });
    expect(currentTime).toBe(20);
    expect(audition().textContent).toBe('選択範囲を試聴');
    act(() => root.unmount());
  });
});
