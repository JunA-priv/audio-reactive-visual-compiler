import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoTimeline, initialEditorBlueprint } from './editor-model';
import { exportFrameTime, exportMP4, exportWebM, isMP4Supported, selectMP4MimeType, selectWebMMimeType } from './video-export';

const stoppedTracks: string[] = [];
const events: string[] = [];
let captureDescriptor: PropertyDescriptor | undefined;

class FakeMediaStream {
  constructor(readonly tracks: Array<{ kind: string; stop: () => void }>) {}
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
}

class FakeMediaRecorder {
  static latest: FakeMediaRecorder | null = null;
  static isTypeSupported = vi.fn((mime: string) => mime.includes('webm'));
  static output = 'mock-webm';
  static mimeTypeOverride: string | null = null;
  static failConstruction = false;
  static failStart = false;
  static failStop = false;
  readonly mimeType: string;
  state: RecordingState = 'inactive';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  constructor(readonly stream: FakeMediaStream, options?: MediaRecorderOptions) {
    if (FakeMediaRecorder.failConstruction) throw new Error('recorder constructor failed');
    this.mimeType = FakeMediaRecorder.mimeTypeOverride ?? options?.mimeType ?? 'video/webm';
    FakeMediaRecorder.latest = this;
  }
  start() { if (FakeMediaRecorder.failStart) throw new Error('recorder start failed'); events.push('recorder-start'); this.state = 'recording'; }
  stop() {
    if (this.state === 'inactive') return;
    if (FakeMediaRecorder.failStop) throw new Error('recorder stop failed');
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob([FakeMediaRecorder.output], { type: this.mimeType }) } as BlobEvent);
      this.onstop?.(new Event('stop'));
    });
  }
}

function makeFakeContext(): CanvasRenderingContext2D {
  return {
    globalAlpha: 1, fillStyle: '', shadowBlur: 0, shadowColor: '',
    setTransform() {}, clearRect() {}, fillRect() {}, createLinearGradient: () => ({ addColorStop() {} } as CanvasGradient),
    beginPath() {}, rect() {}, moveTo() {}, lineTo() {}, bezierCurveTo() {}, closePath() {}, clip() {}, save() {}, restore() {},
    translate() {}, rotate() {}, scale() {}, ellipse() {}, fill() {}, stroke() {}, strokeRect() {}, setLineDash() {}, drawImage() {},
  } as unknown as CanvasRenderingContext2D;
}

function setupMediaMocks(withAudio = false) {
  const videoTrack = { kind: 'video', stop: () => stoppedTracks.push('video') };
  const canvasStream = new FakeMediaStream([videoTrack]);
  captureDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'captureStream');
  Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', { configurable: true, value: vi.fn(() => canvasStream) });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(makeFakeContext());
  vi.stubGlobal('MediaStream', FakeMediaStream);
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);

  if (withAudio) {
    class FakeAudioContext {
      state: AudioContextState = 'running';
      get currentTime() { return performance.now() / 1000; }
      async resume() {}
      async close() { this.state = 'closed'; events.push('context-close'); }
      async decodeAudioData() { return { duration: 0.1 } as AudioBuffer; }
      createMediaStreamDestination() {
        const audioTrack = { kind: 'audio', stop: () => stoppedTracks.push('audio') };
        return { stream: new FakeMediaStream([audioTrack]) } as unknown as MediaStreamAudioDestinationNode;
      }
      createBufferSource() {
        return {
          buffer: null,
          connect() {},
          disconnect() {},
          start: (...args: number[]) => { events.push(`audio-start:${args.join(',')}`); },
          stop() { events.push('audio-stop'); },
        } as unknown as AudioBufferSourceNode;
      }
    }
    vi.stubGlobal('AudioContext', FakeAudioContext);
  }
  return { canvasStream };
}

afterEach(() => {
  if (captureDescriptor) Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', captureDescriptor);
  else Reflect.deleteProperty(HTMLCanvasElement.prototype, 'captureStream');
  captureDescriptor = undefined;
  stoppedTracks.length = 0;
  events.length = 0;
  FakeMediaRecorder.latest = null;
  FakeMediaRecorder.output = 'mock-webm';
  FakeMediaRecorder.mimeTypeOverride = null;
  FakeMediaRecorder.failConstruction = false;
  FakeMediaRecorder.failStart = false;
  FakeMediaRecorder.failStop = false;
  FakeMediaRecorder.isTypeSupported.mockImplementation((mime) => mime.includes('webm'));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('video export', () => {
  it('selects supported WebM codecs and rejects unsupported browsers', () => {
    setupMediaMocks();
    expect(selectWebMMimeType(false)).toContain('video/webm');
    const unsupported = { isTypeSupported: () => false };
    vi.stubGlobal('MediaRecorder', unsupported);
    expect(() => selectWebMMimeType(true)).toThrow(/codec/);
  });

  it('requires browser-declared H.264 and AAC support for the matching MP4 mode', () => {
    setupMediaMocks();
    FakeMediaRecorder.isTypeSupported.mockImplementation((mime) => mime.includes('video/mp4') && mime.includes('avc1') && !mime.includes('mp4a.40.2'));
    expect(isMP4Supported(false)).toBe(true);
    expect(isMP4Supported(true)).toBe(false);
    expect(selectMP4MimeType(false)).toContain('avc1.');
    expect(() => selectMP4MimeType(true)).toThrow(/H.264 \/ AAC/);
    FakeMediaRecorder.isTypeSupported.mockImplementation((mime) => mime.includes('video/mp4') && mime.includes('mp4a.40.2'));
    expect(isMP4Supported(true)).toBe(true);
    expect(selectMP4MimeType(true)).toContain('mp4a.40.2');
  });

  it.each([false, true])('records an MP4 with H.264 and matching audio mode (withAudio=%s)', async (withAudio) => {
    setupMediaMocks(withAudio);
    vi.useFakeTimers();
    FakeMediaRecorder.isTypeSupported.mockImplementation((mime) => mime.includes('video/mp4'));
    FakeMediaRecorder.output = '\u0000\u0000\u0000\u0018ftypisom\u0000\u0000\u0002\u0000isomiso2';
    const timeline = { ...demoTimeline, durationMs: 100, bassEnvelope: [{ timeMs: 0, value: 0 }, { timeMs: 100, value: 1 }], kickEvents: [] };
    const audio = withAudio ? new File([new Uint8Array([1, 2, 3])], 'fixture.wav', { type: 'audio/wav' }) : null;
    const promise = exportMP4({ blueprint: initialEditorBlueprint, timeline, audioFile: audio, fps: 30, scale: 1, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(300);
    const blob = await promise;
    expect(blob.type).toContain('video/mp4');
    expect(blob.type).toContain('avc1.');
    expect(blob.type.includes('mp4a.40.2')).toBe(withAudio);
    expect(new TextDecoder().decode(await blob.slice(4, 8).arrayBuffer())).toBe('ftyp');
    expect(stoppedTracks).toContain('video');
    expect(stoppedTracks.includes('audio')).toBe(withAudio);
  });

  it('rejects mismatched recorder MIME and non-MP4 output instead of relabeling it', async () => {
    setupMediaMocks();
    vi.useFakeTimers();
    FakeMediaRecorder.isTypeSupported.mockImplementation((mime) => mime.includes('video/mp4'));
    FakeMediaRecorder.output = '\u0000\u0000\u0000\u0018ftypisom\u0000\u0000\u0002\u0000isomiso2';
    FakeMediaRecorder.mimeTypeOverride = 'video/webm;codecs=vp8';
    const timeline = { ...demoTimeline, durationMs: 100, bassEnvelope: [{ timeMs: 0, value: 0 }, { timeMs: 100, value: 1 }], kickEvents: [] };
    const promise = exportMP4({ blueprint: initialEditorBlueprint, timeline, fps: 30, scale: 1, signal: new AbortController().signal });
    const mismatch = expect(promise).rejects.toThrow(/一致しません/);
    await vi.advanceTimersByTimeAsync(300);
    await mismatch;
    expect(stoppedTracks).toContain('video');

    FakeMediaRecorder.mimeTypeOverride = null;
    FakeMediaRecorder.output = 'mock-webm';
    const badOutput = exportMP4({ blueprint: initialEditorBlueprint, timeline, fps: 30, scale: 1, signal: new AbortController().signal });
    const invalidContainer = expect(badOutput).rejects.toThrow(/MP4ファイルの形式/);
    await vi.advanceTimersByTimeAsync(300);
    await invalidContainer;
  });

  it.each(['construction', 'start', 'stop', 'empty'] as const)('reports MP4 %s failures and releases stream resources', async (failureKind) => {
    setupMediaMocks();
    vi.useFakeTimers();
    FakeMediaRecorder.isTypeSupported.mockImplementation((mime) => mime.includes('video/mp4'));
    FakeMediaRecorder.output = '\u0000\u0000\u0000\u0018ftypisom\u0000\u0000\u0002\u0000isomiso2';
    FakeMediaRecorder.failConstruction = failureKind === 'construction';
    FakeMediaRecorder.failStart = failureKind === 'start';
    FakeMediaRecorder.failStop = failureKind === 'stop';
    if (failureKind === 'empty') FakeMediaRecorder.output = '';
    const timeline = { ...demoTimeline, durationMs: 100, bassEnvelope: [{ timeMs: 0, value: 0 }, { timeMs: 100, value: 1 }], kickEvents: [] };
    const controller = new AbortController();
    const promise = exportMP4({ blueprint: initialEditorBlueprint, timeline, fps: 30, scale: 1, signal: controller.signal });
    const expected = expect(promise).rejects.toThrow(failureKind === 'empty' ? /データを出力/ : failureKind === 'stop' ? /停止できません/ : /録画を開始できません|constructor failed/);
    if (failureKind === 'stop' || failureKind === 'empty') await vi.advanceTimersByTimeAsync(300);
    await expected;
    expect(stoppedTracks).toContain('video');
  });

  it('records silent video through Canvas capture and stops its tracks', async () => {
    setupMediaMocks();
    vi.useFakeTimers();
    const controller = new AbortController();
    const timeline = { ...demoTimeline, durationMs: 100, bassEnvelope: [{ timeMs: 0, value: 0 }, { timeMs: 100, value: 1 }], kickEvents: [] };
    const promise = exportWebM({ blueprint: initialEditorBlueprint, timeline, fps: 30, scale: 1, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(300);
    const blob = await promise;
    expect(blob.type).toContain('video/webm');
    expect(blob.size).toBeGreaterThan(0);
    expect(stoppedTracks).toContain('video');
  });

  it('starts the audio track with the recorder and releases audio resources', async () => {
    setupMediaMocks(true);
    vi.useFakeTimers();
    const controller = new AbortController();
    const timeline = { ...demoTimeline, durationMs: 100, bassEnvelope: [{ timeMs: 0, value: 0 }, { timeMs: 100, value: 1 }], kickEvents: [] };
    const audio = new File([new Uint8Array([1, 2, 3])], 'fixture.wav', { type: 'audio/wav' });
    const promise = exportWebM({ blueprint: initialEditorBlueprint, timeline, audioFile: audio, fps: 30, scale: 1, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(300);
    const blob = await promise;
    expect(blob.type).toContain('video/webm');
    expect(events[0]).toBe('recorder-start');
    expect(events.some((event) => event.startsWith('audio-start:'))).toBe(true);
    expect(stoppedTracks).toEqual(expect.arrayContaining(['video', 'audio']));
    expect(events).toContain('context-close');
  });

  it('uses frame timestamps derived from the media clock and bounds the last frame', () => {
    expect(exportFrameTime(100, 30, 1000)).toBe(100);
    expect(exportFrameTime(101, 30, 1000)).toBe(100);
    expect(exportFrameTime(10_000, 30, 1000)).toBe(1000);
    expect(() => exportFrameTime(Number.NaN, 30, 1000)).toThrow(/時間/);
  });

  it('cancels recording and releases the video stream', async () => {
    setupMediaMocks();
    vi.useFakeTimers();
    const controller = new AbortController();
    const timeline = demoTimeline;
    const promise = exportWebM({ blueprint: initialEditorBlueprint, timeline, fps: 30, scale: 1, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(32);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(stoppedTracks).toContain('video');
  });

  it('releases audio and recorder resources on cancellation and supports a later export', async () => {
    setupMediaMocks(true);
    vi.useFakeTimers();
    const timeline = { ...demoTimeline, durationMs: 100, bassEnvelope: [{ timeMs: 0, value: 0 }, { timeMs: 100, value: 1 }], kickEvents: [] };
    const audio = new File([new Uint8Array([1, 2, 3])], 'fixture.wav', { type: 'audio/wav' });
    const firstController = new AbortController();
    const firstExport = exportWebM({ blueprint: initialEditorBlueprint, timeline, audioFile: audio, fps: 30, scale: 1, signal: firstController.signal });
    await vi.advanceTimersByTimeAsync(32);
    firstController.abort();
    await expect(firstExport).rejects.toMatchObject({ name: 'AbortError' });
    expect(stoppedTracks).toEqual(expect.arrayContaining(['video', 'audio']));
    expect(events).toContain('audio-stop');
    expect(events).toContain('context-close');

    const secondController = new AbortController();
    const secondExport = exportWebM({ blueprint: initialEditorBlueprint, timeline, audioFile: audio, fps: 30, scale: 1, signal: secondController.signal });
    await vi.advanceTimersByTimeAsync(200);
    await expect(secondExport).resolves.toMatchObject({ type: expect.stringContaining('video/webm'), size: expect.any(Number) });
    expect(stoppedTracks.filter((kind) => kind === 'video')).toHaveLength(2);
    expect(stoppedTracks.filter((kind) => kind === 'audio')).toHaveLength(2);
  });

  it('rejects a MediaRecorder failure and releases combined-stream resources', async () => {
    setupMediaMocks(true);
    vi.useFakeTimers();
    const timeline = { ...demoTimeline, durationMs: 100, bassEnvelope: [{ timeMs: 0, value: 0 }, { timeMs: 100, value: 1 }], kickEvents: [] };
    const audio = new File([new Uint8Array([1, 2, 3])], 'fixture.wav', { type: 'audio/wav' });
    const promise = exportWebM({ blueprint: initialEditorBlueprint, timeline, audioFile: audio, fps: 30, scale: 1, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(32);
    FakeMediaRecorder.latest?.onerror?.(new Event('error'));
    await expect(promise).rejects.toThrow(/encoder/);
    expect(stoppedTracks).toEqual(expect.arrayContaining(['video', 'audio']));
    expect(events).toContain('audio-stop');
    expect(events).toContain('context-close');
  });

  it('closes the AudioContext and canvas track when local audio decoding fails', async () => {
    setupMediaMocks();
    const cleanup: string[] = [];
    class BrokenAudioContext {
      state: AudioContextState = 'running';
      get currentTime() { return 0; }
      async resume() {}
      async decodeAudioData() { throw new Error('decode fixture failure'); }
      async close() { this.state = 'closed'; cleanup.push('context-close'); }
    }
    vi.stubGlobal('AudioContext', BrokenAudioContext);
    const timeline = { ...demoTimeline, durationMs: 100, bassEnvelope: [{ timeMs: 0, value: 0 }, { timeMs: 100, value: 1 }], kickEvents: [] };
    const audio = new File([new Uint8Array([1, 2, 3])], 'fixture.wav', { type: 'audio/wav' });
    await expect(exportWebM({ blueprint: initialEditorBlueprint, timeline, audioFile: audio, fps: 30, scale: 1, signal: new AbortController().signal })).rejects.toThrow(/音源形式/);
    expect(stoppedTracks).toContain('video');
    expect(cleanup).toContain('context-close');
  });
});
