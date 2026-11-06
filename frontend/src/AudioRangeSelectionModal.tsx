import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { MAX_CLIP_SECONDS } from './audio-analysis';

type Range = { start: number; end: number };
type Drag = { pointerId: number; mode: 'start' | 'end' | 'move' | 'create'; downX: number; start: number; end: number; anchor: number; moved: boolean };

export function createAudioRange(anchor: number, current: number, duration: number): Range {
  const maximum = Math.min(MAX_CLIP_SECONDS, duration);
  const minimum = Math.min(0.01, maximum);
  if (current >= anchor) {
    const start = Math.max(0, Math.min(anchor, duration - minimum));
    const end = Math.min(duration, Math.max(start + minimum, Math.min(current, start + maximum)));
    return { start, end };
  }
  const end = Math.max(minimum, Math.min(anchor, duration));
  const start = Math.max(0, end - maximum, Math.min(current, end - minimum));
  return { start, end };
}

export function clampAudioRange(start: number, end: number, duration: number, mode: 'start' | 'end' | 'move', initial?: Range): Range {
  const maximum = Math.min(MAX_CLIP_SECONDS, duration);
  const minimum = Math.min(0.01, maximum);
  if (mode === 'move' && initial) {
    const length = Math.min(maximum, Math.max(minimum, initial.end - initial.start));
    const nextStart = Math.min(Math.max(0, start), Math.max(0, duration - length));
    return { start: nextStart, end: nextStart + length };
  }
  if (mode === 'start') {
    const nextStart = Math.max(0, Math.min(start, end - minimum, duration - minimum));
    return { start: nextStart, end: Math.min(duration, Math.min(MAX_CLIP_SECONDS, end - nextStart) + nextStart) };
  }
  const nextEnd = Math.max(start + minimum, Math.min(end, duration, start + MAX_CLIP_SECONDS));
  return { start: Math.max(0, Math.min(start, nextEnd - minimum)), end: nextEnd };
}

export function AudioRangeSelectionModal({ audioUrl, waveform, duration, start, end, onRangeChange, onConfirm, onCancel, onAbort, busy, status }: {
  audioUrl: string; waveform: Float32Array; duration: number; start: number; end: number;
  onRangeChange: (range: Range) => void; onConfirm: () => void; onCancel: () => void; onAbort: () => void; busy: boolean; status: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  onCancelRef.current = onCancel;
  busyRef.current = busy;
  const [playhead, setPlayhead] = useState(start);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) onCancelRef.current();
      if (event.key === 'Tab' && dialogRef.current) {
        const items = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), summary')]
          .filter((item) => item.tagName === 'SUMMARY' || !item.closest('details') || item.closest('details')?.open);
        if (items.length === 0) return;
        const first = items[0]!; const last = items.at(-1)!;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); audioRef.current?.pause(); previousFocus.current?.focus(); };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const ratio = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio);
      const ctx = canvas.getContext('2d'); if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.fillStyle = '#0b1020'; ctx.fillRect(0, 0, rect.width, rect.height);
      const xFor = (seconds: number) => Math.max(0, Math.min(rect.width, seconds / duration * rect.width));
      const left = xFor(start); const right = xFor(end); const middle = rect.height / 2;
      ctx.beginPath(); ctx.strokeStyle = '#86dfff'; ctx.lineWidth = 1;
      const samplesPerPixel = Math.max(1, Math.ceil(waveform.length / Math.max(1, rect.width)));
      for (let x = 0; x < rect.width; x += 1) {
        const first = Math.floor(x / rect.width * waveform.length);
        const last = Math.min(waveform.length, first + samplesPerPixel);
        let peak = 0;
        for (let i = first; i < last; i += 1) peak = Math.max(peak, waveform[i] ?? 0);
        const amplitude = Math.max(1, peak * middle * 0.92);
        ctx.moveTo(x + 0.5, middle - amplitude); ctx.lineTo(x + 0.5, middle + amplitude);
      }
      ctx.stroke();
      ctx.fillStyle = 'rgba(3, 6, 12, .48)';
      ctx.fillRect(0, 0, left, rect.height);
      ctx.fillRect(right, 0, Math.max(0, rect.width - right), rect.height);
      ctx.fillStyle = 'rgba(134, 111, 255, .22)'; ctx.fillRect(left, 0, Math.max(0, right - left), rect.height);
      for (const [x, color] of [[left, '#b9aaff'], [right, '#b9aaff']] as const) {
        ctx.fillStyle = '#f8f7ff'; ctx.fillRect(x - 5, 0, 10, rect.height);
        ctx.fillStyle = color; ctx.fillRect(x - 3, 0, 6, rect.height);
        ctx.beginPath(); ctx.arc(x, 12, 10, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#10131c'; ctx.lineWidth = 2; ctx.stroke();
      }
      const head = xFor(playhead); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(head, 0); ctx.lineTo(head, rect.height); ctx.stroke();
    };
    draw();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
    observer?.observe(canvas);
    window.addEventListener('resize', draw);
    return () => { observer?.disconnect(); window.removeEventListener('resize', draw); };
  }, [waveform, duration, start, end, playhead]);

  const secondsAt = (clientX: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return Math.max(0, Math.min(duration, (clientX - rect.left) / rect.width * duration));
  };
  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (busy) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const left = start / duration * rect.width; const right = end / duration * rect.width;
    const nearStart = Math.abs(x - left) <= 14; const nearEnd = Math.abs(x - right) <= 14;
    const mode = nearStart ? 'start' : nearEnd ? 'end' : x >= left && x <= right ? 'move' : 'create';
    dragRef.current = { pointerId: event.pointerId, mode, downX: event.clientX, start, end, anchor: secondsAt(event.clientX), moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (Math.abs(event.clientX - drag.downX) < 3) return;
    drag.moved = true;
    const delta = (event.clientX - drag.downX) / Math.max(1, rect.width) * duration;
    const next = drag.mode === 'create'
      ? createAudioRange(drag.anchor, secondsAt(event.clientX), duration)
      : drag.mode === 'start'
      ? clampAudioRange(drag.start + delta, drag.end, duration, 'start')
      : drag.mode === 'end'
        ? clampAudioRange(drag.start, drag.end + delta, duration, 'end')
        : clampAudioRange(drag.start + delta, drag.end + delta, duration, 'move', drag);
    onRangeChange(next);
  };
  const endPointer = (event: PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (!dragRef.current.moved && (dragRef.current.mode === 'move' || dragRef.current.mode === 'create')) {
      const next = secondsAt(event.clientX);
      setPlayhead(next);
      if (audioRef.current) audioRef.current.currentTime = next;
    }
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const maximumSelectionLength = Math.min(MAX_CLIP_SECONDS, Math.max(0, duration - start));
  const minimumSelectionLength = Math.min(0.01, maximumSelectionLength);
  const selectionLength = Math.max(minimumSelectionLength, Math.min(maximumSelectionLength, end - start));
  const updateSelectionLength = (value: number) => {
    const bounded = Math.max(minimumSelectionLength, Math.min(maximumSelectionLength, value));
    onRangeChange({ start, end: start + bounded });
  };
  const playSelection = async () => {
    const audio = audioRef.current; if (!audio || busy) return;
    audio.currentTime = start;
    try { await audio.play(); setPlaying(true); } catch { setPlaying(false); }
  };
  const stopSelection = () => {
    const audio = audioRef.current;
    audio?.pause();
    if (audio) audio.currentTime = start;
    setPlayhead(start);
    setPlaying(false);
  };
  const timeUpdate = () => {
    const audio = audioRef.current; if (!audio) return;
    if (audio.currentTime >= end) { stopSelection(); return; }
    setPlayhead(audio.currentTime);
  };

  return <div className="audio-range-backdrop"><div className="audio-range-dialog" role="dialog" aria-modal="true" aria-labelledby="audio-range-title" aria-describedby="audio-range-description" tabIndex={-1} ref={dialogRef}>
    <h2 id="audio-range-title">解析する範囲を選択</h2>
    <p id="audio-range-description">両端のハンドルで調整、選択範囲内のドラッグで移動、範囲外からのドラッグで新しく選択できます。クリックすると試聴位置が移動します。最大60秒まで選べます。</p>
    <p className="audio-range-duration">音源の長さ：{duration.toFixed(2)}秒</p>
    <div className="audio-waveform-wrap"><canvas ref={canvasRef} aria-label="音声波形。ハンドルで範囲調整、範囲内をドラッグして移動、範囲外からドラッグして新しく選択" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endPointer} onPointerCancel={endPointer} onLostPointerCapture={() => { dragRef.current = null; }} /></div>
    <div className="audio-range-values"><span>開始 {start.toFixed(2)}秒</span><span>終了 {end.toFixed(2)}秒</span><span>選択 {Math.max(0, end - start).toFixed(2)}秒</span></div>
    <div className="audio-range-duration-control"><label htmlFor="audio-range-length">選択する長さ</label><output htmlFor="audio-range-length">{selectionLength.toFixed(2)}秒</output><input id="audio-range-length" aria-label="選択する長さ" type="range" min={minimumSelectionLength} max={maximumSelectionLength} step={Math.min(0.01, maximumSelectionLength - minimumSelectionLength || 0.01)} value={selectionLength} onChange={(event) => updateSelectionLength(Number(event.target.value))} disabled={busy || maximumSelectionLength <= minimumSelectionLength} /></div>
    <audio ref={audioRef} src={audioUrl} preload="auto" onTimeUpdate={timeUpdate} onEnded={stopSelection} onPause={() => setPlaying(false)} aria-label="選択範囲の試聴" />
    <div className="audio-range-actions"><button type="button" onClick={() => playing ? stopSelection() : void playSelection()} disabled={busy}>{playing ? '停止' : '選択範囲を試聴'}</button><button type="button" className="primary-button" onClick={onConfirm} disabled={busy || end <= start}>{busy ? '解析中...' : '範囲を確定して解析'}</button>{busy && <button type="button" onClick={onAbort}>解析をキャンセル</button>}<button type="button" onClick={onCancel} disabled={busy}>キャンセル</button></div>
    {status && <p role="status">{status}</p>}
  </div></div>;
}
