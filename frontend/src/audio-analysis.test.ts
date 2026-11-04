import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeAudioClipSync, analyzeQueuedAudioClip, buildWaveformPeaks, encodePCM16StereoWav, trimAudioToWav } from './audio-analysis';
import { demoTimeline } from './editor-model';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('audio selection processing', () => {
  it('retains the synchronous Analyze contract for compatibility', async () => {
    const clip=new File([new Uint8Array(48)],'sync.wav',{type:'audio/wav'});
    const timeline={...demoTimeline,schemaVersion:1,timeUnit:'ms',analysisVersion:'python-island/test',sampleRateHz:44_100,durationMs:1000,bassEnvelope:[{timeMs:0,value:0.2},{timeMs:1000,value:0.4}],kickEvents:[]};
    const summary={summaryVersion:1,durationMs:1000,sourceAudio:{format:'wav',codec:'pcm_s16le',sampleRateHz:44_100,channels:2,fileBytes:48},analysis:{model:'scnet_standard',device:'cpu',stemRms:{drums:0,bass:0,vocals:0,other:0},estimatedKickCount:0,featureSampleRateHz:100,kickDetection:'test'}};
    const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{expect(String(input)).toBe('/api/v1/audio/analyze');return new Response(JSON.stringify({featureTimeline:timeline,musicSummary:summary,analysisMetadata:{metadataVersion:1}}),{status:200});});
    vi.stubGlobal('fetch',fetchMock);
    const result=await analyzeAudioClipSync(clip,'token',new AbortController().signal);
    expect(result.durationMs).toBe(1000);expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('builds a bounded waveform peak series including silence and channel peaks', () => {
    const left = new Float32Array([0, 0.2, -0.8, 0, 0.1, 0, 0.4, 0]);
    const right = new Float32Array([0, 0.3, 0.1, 0, -0.6, 0, 0.2, 0]);
    const peaks = buildWaveformPeaks({ length: 8, numberOfChannels: 2, getChannelData: (channel) => channel === 0 ? left : right }, 4);
    expect([...peaks].map((peak) => Number(peak.toFixed(2)))).toEqual([0.3, 0.8, 0.6, 0.4]);
    expect(buildWaveformPeaks({ length: 3, numberOfChannels: 1, getChannelData: () => new Float32Array(3) }, 20)).toHaveLength(3);
    expect([...buildWaveformPeaks({ length: 0, numberOfChannels: 1, getChannelData: () => new Float32Array(0) })]).toEqual([0]);
  });

  it('encodes bounded samples as 44.1 kHz stereo PCM16 WAV', () => {
    const wav = encodePCM16StereoWav(new Float32Array([-1, 0, 1]), new Float32Array([1, 0, -1]));
    const view = new DataView(wav);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(44_100);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(12);
    expect(view.getInt16(44, true)).toBe(-32768);
    expect(view.getInt16(46, true)).toBe(32767);
  });

  it('crops only the selected sample range and closes the decode context', async () => {
    const decoded = { duration: 1, length: 44_100, sampleRate: 44_100, numberOfChannels: 1 };
    const starts: number[][] = [];
    let closeCount = 0;
    class FakeAudioContext {
      state = 'running';
      async decodeAudioData() { return decoded as unknown as AudioBuffer; }
      async close() { closeCount += 1; this.state = 'closed'; }
    }
    class FakeOfflineAudioContext {
      destination = {};
      constructor(public channels: number, public frames: number, public rate: number) {}
      createBufferSource() { return { buffer: null, connect() {}, start: (...args: number[]) => { starts.push(args); } }; }
      async startRendering() { const rendered = new Float32Array(this.frames).fill(0.25); return { length: this.frames, sampleRate: this.rate, numberOfChannels: this.channels, getChannelData: () => rendered } as unknown as AudioBuffer; }
    }
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
    const result = await trimAudioToWav(new File(['source'], 'source.wav', { type: 'audio/wav' }), 0.2, 0.7);
    expect(starts[0]?.[1]).toBeCloseTo(0.2, 5);
    expect(starts[0]?.[2]).toBeCloseTo(0.5, 5);
    expect(result.frameCount).toBe(22_050);
    expect(result.durationMs).toBe(500);
    expect(result.file.size).toBe(44 + 22_050 * 4);
    const beginning = await trimAudioToWav(new File(['source'], 'source.wav', { type: 'audio/wav' }), 0, 1);
    expect(starts[1]?.[1]).toBe(0);
    expect(starts[1]?.[2]).toBe(1);
    expect(beginning.frameCount).toBe(44_100);
    const ending = await trimAudioToWav(new File(['source'], 'source.wav', { type: 'audio/wav' }), 0.99, 1);
    expect(starts[2]?.[1]).toBeCloseTo(0.99, 5);
    expect(ending.frameCount).toBe(441);
    const short = await trimAudioToWav(new File(['source'], 'source.wav', { type: 'audio/wav' }), 0.01, 0.02);
    expect(starts[3]?.[1]).toBeCloseTo(0.01, 5);
    expect(short.frameCount).toBe(441);
    expect(closeCount).toBe(4);
  });

  it('encodes the reported 43.14–103.14 second selection as a valid 60-second WAV', async () => {
    const decoded = { duration: 189.96, length: Math.round(189.96 * 48_000), sampleRate: 48_000, numberOfChannels: 2 };
    let sourceStart: number[] = [];
    class FakeAudioContext {
      state = 'running';
      async decodeAudioData() { return decoded as unknown as AudioBuffer; }
      async close() { this.state = 'closed'; }
    }
    class FakeOfflineAudioContext {
      destination = {};
      constructor(public channels: number, public frames: number, public rate: number) {}
      createBufferSource() { return { buffer: null, connect() {}, start: (...args: number[]) => { sourceStart = args; } }; }
      async startRendering() {
        const rendered = new Float32Array(this.frames).fill(0.25);
        return { length: this.frames, sampleRate: this.rate, numberOfChannels: this.channels, getChannelData: () => rendered } as unknown as AudioBuffer;
      }
    }
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);

    const result = await trimAudioToWav(new File(['source'], 'acoustic.mp3', { type: 'audio/mpeg' }), 43.14, 103.14);
    const bytes = new Uint8Array(await result.file.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(sourceStart[1]).toBeCloseTo(43.14, 8);
    expect(sourceStart[2]).toBe(60);
    expect(result.frameCount).toBe(2_646_000);
    expect(result.durationMs).toBe(60_000);
    expect(result.file.size).toBe(10_584_044);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF');
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(44_100);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(10_584_000);
    expect(view.getInt16(44, true)).toBeGreaterThan(0);
  });

  it('rejects invalid clip ranges before allocating browser audio contexts', async () => {
    const audioContext = vi.fn();
    vi.stubGlobal('AudioContext', audioContext);
    const source = new File(['source'], 'source.wav', { type: 'audio/wav' });
    for (const [start, end] of [[-0.01, 0.2], [0.2, 0.2], [0.3, 0.2], [0, 60.01], [Number.NaN, 1], [0, Number.POSITIVE_INFINITY]]) {
      await expect(trimAudioToWav(source, start!, end!)).rejects.toThrow();
    }
    expect(audioContext).not.toHaveBeenCalled();
  });

  it('sends only the selected WAV clip and validates the returned timeline', async () => {
    const clip = new File([new Uint8Array(48)], 'selected.wav', { type: 'audio/wav' });
    const timeline = { ...demoTimeline, schemaVersion: 1, timeUnit: 'ms', analysisVersion: 'python-island/test', sampleRateHz: 44_100, durationMs: 1000, bassEnvelope: [{ timeMs: 0, value: 0.2 }, { timeMs: 1000, value: 0.4 }], kickEvents: [] };
    const summary = { summaryVersion: 1, durationMs: 1000, sourceAudio: { format: 'wav', codec: 'pcm_s16le', sampleRateHz: 44_100, channels: 2, fileBytes: 48 }, analysis: { model: 'htdemucs', device: 'cpu', stemRms: { drums: 0, bass: 0, vocals: 0, other: 0 }, estimatedKickCount: 0, featureSampleRateHz: 100, kickDetection: 'test' } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/v1/audio/jobs') {
        expect(init?.method).toBe('POST');
        expect((init?.headers as Record<string,string>)['Authorization']).toBe('Bearer opaque-test-token');
        expect((init?.headers as Record<string,string>)['Idempotency-Key']).toBeTruthy();
        return new Response(JSON.stringify({ jobId: 'job-1', state: 'queued' }), { status: 202 });
      }
      if (String(input) === '/api/v1/audio/jobs/job-1') return new Response(JSON.stringify({ jobId: 'job-1', state: 'succeeded' }), { status: 200 });
      expect(String(input)).toBe('/api/v1/audio/jobs/job-1/result');
      return new Response(JSON.stringify({ featureTimeline: timeline, musicSummary: summary, analysisMetadata: { metadataVersion: 1 } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await analyzeQueuedAudioClip(clip, 'opaque-test-token', new AbortController().signal);
    expect(result.durationMs).toBe(1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const init = fetchMock.mock.calls[0]?.[1];
    if (!init) throw new Error('expected analysis fetch options');
    expect((init.headers as Record<string,string>).Authorization).toBe('Bearer opaque-test-token');
    expect(init.body).toBeInstanceOf(FormData);
    const sentClip = (init.body as FormData).get('audio') as File;
    expect(sentClip.name).toBe(clip.name);
    expect(sentClip.size).toBe(clip.size);
    expect((init.body as FormData).get('kickGateMode')).toBe('hard');
  });

  it('sends each selected Kick gate mode without changing the audio payload', async () => {
    const clip = new File([new Uint8Array(48)], 'selected.wav', { type: 'audio/wav' });
    const timeline = { ...demoTimeline, schemaVersion: 1, timeUnit: 'ms', analysisVersion: 'python-island/test', sampleRateHz: 44_100, durationMs: 1000, bassEnvelope: [{ timeMs: 0, value: 0 }, { timeMs: 1000, value: 0.4 }], kickEvents: [] };
    const summary = { summaryVersion: 1, durationMs: 1000, sourceAudio: { format: 'wav', codec: 'pcm_s16le', sampleRateHz: 44_100, channels: 2, fileBytes: 48 }, analysis: { model: 'htdemucs', device: 'cpu', stemRms: { drums: 0, bass: 0, vocals: 0, other: 0 }, estimatedKickCount: 0, featureSampleRateHz: 100, kickDetection: 'test' } };
    const captured: FormData[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/v1/audio/jobs') {
        expect(init?.method).toBe('POST'); captured.push(init?.body as FormData);
        return new Response(JSON.stringify({ jobId: `job-${captured.length}`, state: 'queued' }), { status: 202 });
      }
      if (String(input).includes('/result')) return new Response(JSON.stringify({ featureTimeline: timeline, musicSummary: summary, analysisMetadata: { metadataVersion: 1 } }), { status: 200 });
      const id = captured.length;
      return new Response(JSON.stringify({ jobId: `job-${id}`, state: 'succeeded' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    for (const mode of ['off', 'middle', 'hard', 'soft'] as const) await analyzeQueuedAudioClip(clip, 'token', new AbortController().signal, mode);
    expect(captured.map((form) => form.get('kickGateMode'))).toEqual(['off', 'middle', 'hard', 'soft']);
    expect(captured.every((form) => form.get('audio') instanceof File)).toBe(true);
  }, 15_000);

  it('shows a validation-specific message for HTTP 422 without claiming volume is checked', async () => {
    const clip = new File([new Uint8Array(48)], 'selected.wav', { type: 'audio/wav' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'invalid_audio', message: 'audio must be WAV' } }), { status: 422 })));
    await expect(analyzeQueuedAudioClip(clip, 'token', new AbortController().signal)).rejects.toThrow('解析サーバーが音声データを受け付けませんでした。音声形式と60秒以内の選択範囲を確認してください。');
  });

  it('signals session expiry on HTTP 401 without retrying anonymously', async () => {
    const clip = new File([new Uint8Array(48)], 'selected.wav', { type: 'audio/wav' });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/v1/audio/jobs');
      expect((init?.headers as Record<string,string>).Authorization).toBe('Bearer opaque-test-token');
      return new Response(JSON.stringify({ error: { code: 'unauthorized' } }), { status: 401 });
    });
    const expired = vi.fn();
    window.addEventListener('arvc-auth-expired', expired);
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(analyzeQueuedAudioClip(clip, 'opaque-test-token', new AbortController().signal)).rejects.toThrow('セッションが切れました。再度ログインしてください。');
      expect(expired).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string,string>).Authorization).toBe('Bearer opaque-test-token');
    } finally {
      window.removeEventListener('arvc-auth-expired', expired);
    }
  });

  it('propagates AbortController cancellation to the Analyze request', async () => {
    let receivedSignal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input)==='/api/v1/audio/jobs') receivedSignal = init?.signal;
      if (String(input)!=='/api/v1/audio/jobs') return Promise.resolve(new Response(null,{status:200}));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }));
    const controller = new AbortController();
    const pending = analyzeQueuedAudioClip(new File([new Uint8Array(48)], 'selected.wav', { type: 'audio/wav' }), 'opaque-test-token', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(receivedSignal).toBe(controller.signal);
  });

  it('accepts the completed 60-second analysis response shape with 6,000 timeline points', async () => {
    const clip = new File([new Uint8Array(48)], 'sixty-seconds.wav', { type: 'audio/wav' });
    const series = Array.from({ length: 6000 }, (_, index) => ({ timeMs: index * 10, value: (index % 100) / 100 }));
    const timeline = { ...demoTimeline, schemaVersion: 1, timeUnit: 'ms', analysisVersion: 'python-island/test', sampleRateHz: 44_100, durationMs: 60_000, bassEnvelope: series, kickEvents: [59900] };
    const summary = { summaryVersion: 1, durationMs: 60_000, sourceAudio: { format: 'wav', codec: 'pcm_s16le', sampleRateHz: 44_100, channels: 2, fileBytes: 10_584_245 }, analysis: { model: 'scnet_standard', device: 'cpu', stemRms: { drums: 0.1, bass: 0.2, vocals: 0.1, other: 0.1 }, estimatedKickCount: 1, featureSampleRateHz: 100, kickDetection: 'test' } };
    let calls=0;
    vi.stubGlobal('fetch', vi.fn(async () => {calls+=1;if(calls===1)return new Response(JSON.stringify({jobId:'job-60',state:'queued'}),{status:202});if(calls===2)return new Response(JSON.stringify({jobId:'job-60',state:'succeeded'}),{status:200});return new Response(JSON.stringify({ featureTimeline: timeline, musicSummary: summary, analysisMetadata: { metadataVersion: 1 } }), { status: 200 });}));
    const result = await analyzeQueuedAudioClip(clip, 'opaque-test-token', new AbortController().signal);
    expect(result.durationMs).toBe(60_000);
    expect(result.musicSummary.analysis.model).toBe('scnet_standard');
    expect(result.featureTimeline.bassEnvelope).toHaveLength(6000);
    expect(result.featureTimeline.kickEvents.at(-1)).toBe(59_900);
  });
});
