import { validateBlueprint } from './editor-model';
import type { EditorBlueprint, FeatureTimeline } from './editor-model';
import { renderEditorFrame, validateFeatureTimeline } from './renderer';
import type { RenderAssets } from './renderer';

export const MAX_EXPORT_DURATION_MS = 10 * 60 * 1000;
export const MAX_EXPORT_BYTES = 512 * 1024 * 1024;
export type ExportFPS = 24 | 30 | 60;
export type ExportScale = 1 | 2;
export type VideoFormat = 'webm' | 'mp4';

export type VideoExportOptions = {
  blueprint: EditorBlueprint;
  timeline: FeatureTimeline;
  assets?: RenderAssets;
  audioFile?: File | null;
  fps: ExportFPS;
  scale: ExportScale;
  signal: AbortSignal;
  onProgress?: (progress: number) => void;
};

function exportError(message: string): Error { return new Error(message); }

export function selectWebMMimeType(withAudio: boolean): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    throw exportError('このブラウザーでは動画を作成できません。別のブラウザーをお試しください。');
  }
  const candidates = withAudio
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8,vorbis', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const supported = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
  if (!supported) throw exportError('このブラウザーでは動画を作成できません。別のブラウザーをお試しください。');
  return supported;
}

const mp4MimeTypes = (withAudio: boolean) => withAudio
  ? ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4;codecs="avc1.4D401E,mp4a.40.2"', 'video/mp4;codecs="avc1.64001E,mp4a.40.2"']
  : ['video/mp4;codecs="avc1.42E01E"', 'video/mp4;codecs="avc1.4D401E"', 'video/mp4;codecs="avc1.64001E"'];

export function selectMP4MimeType(withAudio: boolean): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    throw exportError('このブラウザーはMP4に対応していません。WebMを選択してください。');
  }
  const supported = mp4MimeTypes(withAudio).find((candidate) => MediaRecorder.isTypeSupported(candidate));
  if (!supported) throw exportError(withAudio
    ? 'このブラウザーは音声付きMP4に対応していません。WebMを選択してください。'
    : 'このブラウザーはMP4に対応していません。WebMを選択してください。');
  return supported;
}

export function isMP4Supported(withAudio: boolean): boolean {
  try { selectMP4MimeType(withAudio); return true; } catch { return false; }
}

export function exportFrameTime(elapsedMs: number, fps: ExportFPS, durationMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || !Number.isFinite(durationMs) || durationMs <= 0) throw exportError('動画時間が不正です。');
  const frameIndex = Math.floor(elapsedMs * fps / 1000);
  return Math.min(durationMs, frameIndex * 1000 / fps);
}

function makeCanvasStream(canvas: HTMLCanvasElement, fps: ExportFPS): MediaStream {
  if (typeof canvas.captureStream !== 'function') throw exportError('このブラウザーはCanvas captureStreamに対応していません。');
  return canvas.captureStream(fps);
}

async function decodeAudio(file: File): Promise<{ context: AudioContext; buffer: AudioBuffer }> {
  const AudioContextConstructor = globalThis.AudioContext;
  if (typeof AudioContextConstructor !== 'function') throw exportError('このブラウザーはWeb Audio APIに対応していません。');
  if (file.size < 1 || file.size > 32 * 1024 * 1024) throw exportError('音源は32 MiB以下のローカルファイルを選択してください。');
  const context = new AudioContextConstructor();
  try {
    await context.resume();
    const bytes = await file.arrayBuffer();
    const buffer = await context.decodeAudioData(bytes.slice(0));
    if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) throw exportError('音源の長さを読み取れませんでした。');
    return { context, buffer };
  } catch (error) {
    await context.close().catch(() => undefined);
    if (error instanceof Error && error.message.startsWith('音源')) throw error;
    throw exportError('音源形式を読み込めません。対応するローカル音源を選び直してください。');
  }
}

export function exportWebM(options: VideoExportOptions): Promise<Blob> { return exportVideo(options, 'webm'); }

export function exportMP4(options: VideoExportOptions): Promise<Blob> { return exportVideo(options, 'mp4'); }

async function exportVideo(options: VideoExportOptions, format: VideoFormat): Promise<Blob> {
  const { blueprint, timeline, fps, scale, signal, onProgress } = options;
  validateBlueprint(blueprint);
  validateFeatureTimeline(timeline);
  if (![24, 30, 60].includes(fps) || ![1, 2].includes(scale)) throw exportError('未対応の動画設定です。');
  if (timeline.durationMs > MAX_EXPORT_DURATION_MS) throw exportError(`${format.toUpperCase()} exportは10分までです。`);
  if (signal.aborted) throw new DOMException('Export canceled', 'AbortError');
  const width = blueprint.width * scale;
  const height = blueprint.height * scale;
  if (width > 4096 || height > 4096 || width * height > 16_777_216) throw exportError('出力解像度がブラウザー上限を超えています。');
  if (blueprint.background.kind === 'image' && !options.assets?.[blueprint.background.src]) {
    throw exportError('背景画像が読み込まれていません。画像を再選択してから出力してください。');
  }

  const withAudio = Boolean(options.audioFile);
  const mimeType = format === 'mp4' ? selectMP4MimeType(withAudio) : selectWebMMimeType(withAudio);
  const formatName = format.toUpperCase();
  let audioContext: AudioContext | null = null;
  let source: AudioBufferSourceNode | null = null;
  let audioDestination: MediaStreamAudioDestinationNode | null = null;
  let canvasStream: MediaStream | null = null;
  let combinedStream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let animationId = 0;
  let abortHandler: (() => void) | null = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw exportError('Canvas 2D contextを作成できません。');
    context.setTransform(scale, 0, 0, scale, 0, 0);
    renderEditorFrame(context, blueprint, timeline, 0, options.assets);
    canvasStream = makeCanvasStream(canvas, fps);
    let stream = canvasStream;
    let buffer: AudioBuffer | null = null;
    if (options.audioFile) {
      const decoded = await decodeAudio(options.audioFile);
      audioContext = decoded.context;
      buffer = decoded.buffer;
      const timelineSeconds = timeline.durationMs / 1000;
      const durationDifference = Math.abs(buffer.duration - timelineSeconds);
      if (durationDifference > 1 / fps) throw exportError(`音源(${buffer.duration.toFixed(3)}秒)とFeature Timeline(${timelineSeconds.toFixed(3)}秒)の長さが一致しません。対応する解析結果を読み込んでください。`);
      audioDestination = audioContext.createMediaStreamDestination();
      source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(audioDestination);
      stream = new MediaStream([...canvasStream.getVideoTracks(), ...audioDestination.stream.getAudioTracks()]);
    }
    combinedStream = stream;
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: scale === 2 ? 6_000_000 : 3_000_000, ...(withAudio ? { audioBitsPerSecond: 128_000 } : {}) });
    const chunks: Blob[] = [];
    let chunkBytes = 0;
    let failure: Error | null = null;
    let terminateLoop: ((error: Error) => void) | null = null;
    const recorded = new Promise<{ blob: Blob | null; error: Error | null }>((resolve) => {
      recorder!.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunkBytes += event.data.size;
          if (chunkBytes > MAX_EXPORT_BYTES) {
            failure = exportError('出力が512 MiBを超えたため停止しました。短い動画または低い解像度を選択してください。');
            terminateLoop?.(failure);
          } else chunks.push(event.data);
        }
      };
      recorder!.onerror = () => {
        failure = exportError(`${formatName} encoderでエラーが発生しました。ブラウザーのcodec対応と空き容量を確認してください。`);
        terminateLoop?.(failure);
      };
      recorder!.onstop = () => {
        if (failure) resolve({ blob: null, error: failure });
        else if (chunks.length === 0) resolve({ blob: null, error: exportError(`${formatName} encoderがデータを出力しませんでした。`) });
        else void finalizeRecording().then(resolve);
      };

      async function finalizeRecording(): Promise<{ blob: Blob | null; error: Error | null }> {
        try {
          const actualMimeType = recorder?.mimeType || mimeType;
          if (!recorderMimeMatches(actualMimeType, format, withAudio)) throw exportError(`出力形式が選択した${formatName}と一致しません。別の形式を選んでください。`);
          const blob = new Blob(chunks, { type: actualMimeType });
          if (blob.size === 0 || blob.type !== actualMimeType.toLowerCase()) throw exportError(`${formatName} encoderが有効なデータを出力しませんでした。`);
          if (format === 'mp4' && !(await hasMP4FileTypeBox(blob))) throw exportError('MP4ファイルの形式を確認できませんでした。MP4出力を完了できません。');
          return { blob, error: null };
        } catch (error) {
          return { blob: null, error: error instanceof Error ? error : exportError(`${formatName} output validation failed.`) };
        }
      }
    });
    const recordedOutcome = recorded;
    await new Promise<void>((resolve, reject) => {
      let lastFrameIndex = 0;
      let startContextTime = 0;
      let startPerformanceTime = 0;
      const stopWithError = (error: Error) => {
        failure = error;
        if (recorder?.state === 'recording' || recorder?.state === 'paused') {
          try { recorder.stop(); resolve(); }
          catch { reject(exportError(`${formatName}録画を停止できませんでした。`)); }
        } else reject(error);
      };
      terminateLoop = stopWithError;
      abortHandler = () => stopWithError(new DOMException('Export canceled', 'AbortError'));
      signal.addEventListener('abort', abortHandler, { once: true });
      if (signal.aborted) { abortHandler(); return; }
      try {
        recorder!.start(1000);
        startPerformanceTime = performance.now();
        if (audioContext && source) {
          startContextTime = audioContext.currentTime;
          source.start(startContextTime, 0, Math.min(timeline.durationMs / 1000, buffer?.duration ?? 0));
        }
      } catch {
        stopWithError(exportError(`${formatName}録画を開始できません。MediaRecorder、codec、AudioContextを確認してください。`));
        return;
      }
      const durationSeconds = timeline.durationMs / 1000;
      const tick = () => {
        const elapsedSeconds = audioContext ? audioContext.currentTime - startContextTime : (performance.now() - startPerformanceTime) / 1000;
        const elapsedMs = Math.max(0, elapsedSeconds * 1000);
        if (elapsedMs >= timeline.durationMs) {
          try { renderEditorFrame(context!, blueprint, timeline, timeline.durationMs, options.assets); }
          catch { stopWithError(exportError('Rendererが最後のframeを描画できませんでした。')); return; }
          onProgress?.(1);
          if (recorder?.state === 'recording' || recorder?.state === 'paused') {
            try { recorder.stop(); }
            catch { reject(exportError(`${formatName}録画を停止できませんでした。`)); return; }
          }
          resolve();
          return;
        }
        const frameIndex = Math.floor(elapsedSeconds * fps);
        if (frameIndex > lastFrameIndex) {
          try {
            renderEditorFrame(context!, blueprint, timeline, Math.min(durationSeconds * 1000, frameIndex * 1000 / fps), options.assets);
            lastFrameIndex = frameIndex;
          } catch {
            stopWithError(exportError('Rendererがframeを描画できませんでした。'));
            return;
          }
        }
        onProgress?.(Math.min(0.999, elapsedMs / timeline.durationMs));
        animationId = requestAnimationFrame(tick);
      };
      animationId = requestAnimationFrame(tick);
    });
    const outcome = await recordedOutcome;
    if (outcome.error) throw outcome.error;
    if (!outcome.blob) throw exportError(`${formatName} encoder returned no data.`);
    return outcome.blob;
  } finally {
    if (abortHandler) signal.removeEventListener('abort', abortHandler);
    if (animationId) cancelAnimationFrame(animationId);
    try { if (source) source.stop(); } catch { /* already ended */ }
    source?.disconnect();
    const tracks = new Set<MediaStreamTrack>([
      ...(canvasStream?.getTracks() ?? []),
      ...(combinedStream?.getTracks() ?? []),
      ...(audioDestination?.stream.getTracks() ?? []),
    ]);
    tracks.forEach((track) => track.stop());
    if (audioContext && audioContext.state !== 'closed') await audioContext.close().catch(() => undefined);
  }
}

function recorderMimeMatches(mimeType: string, format: VideoFormat, withAudio: boolean): boolean {
  if (format === 'webm') return mimeType.toLowerCase().startsWith('video/webm');
  const normalized = mimeType.toLowerCase();
  if (!normalized.startsWith('video/mp4;')) return false;
  const codecs = /codecs\s*=\s*"?([^";]+)"?/i.exec(mimeType)?.[1]?.split(',').map((codec) => codec.trim().toLowerCase()) ?? [];
  return codecs.some((codec) => codec.startsWith('avc1.')) && (!withAudio || codecs.includes('mp4a.40.2'));
}

async function hasMP4FileTypeBox(blob: Blob): Promise<boolean> {
  if (blob.size < 12) return false;
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  return String.fromCharCode(...header.slice(4, 8)) === 'ftyp';
}
