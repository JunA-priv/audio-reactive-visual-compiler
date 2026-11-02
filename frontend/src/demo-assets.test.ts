import { describe, expect, it } from 'vitest';
import { demoTracks, loadDemoTimeline, validateDemoTimeline } from './demo-assets';

const valid = {
  schemaVersion: 1, analysisVersion: 'python-island/0.1.0', sampleRateHz: 44_100, timeUnit: 'ms', durationMs: 1000,
  bassEnvelope: [{ timeMs: 0, value: 0 }, { timeMs: 1000, value: 0.8 }],
  kickEvents: [200], kickEventStrengths: [0.75], drumEnergy: [{ timeMs: 0, value: 0 }, { timeMs: 1000, value: 0.4 }],
};

describe('demo static assets', () => {
  it('maps three unique track IDs to matching audio and timeline paths', () => {
    expect(demoTracks.map((track) => track.id)).toEqual(['demo1', 'demo2', 'demo3']);
    for (const track of demoTracks) {
      expect(track.audioUrl).toContain(`silent-${track.id}.mp3`);
      expect(track.timelineUrl).toBe(`/demo/${track.id}.feature-timeline-v2.json`);
      expect(track.waveformPeaksUrl).toBe(`/demo/${track.id}.waveform-peaks-v2.json`);
      expect(track.frequencySpectrumUrl).toBe(`/demo/${track.id}.frequency-spectrum-v1.json`);
    }
  });

  it('accepts the Python Island Timeline contract', () => {
    expect(validateDemoTimeline(valid)).toMatchObject({ schemaVersion: 1, durationMs: 1000, kickEvents: [200] });
  });

  it('keeps additive feature sources optional for legacy Timeline v1', () => {
    expect(validateDemoTimeline(valid)).not.toHaveProperty('snareEvents');
    expect(() => validateDemoTimeline({ ...valid, snareEvents: [300, 200], snareEventStrengths: [0.4, 0.5] })).toThrow(/不正です/);
  });

  it('validates optional signed peak arrays for each audio stem', () => {
    const source = Array.from({ length: 50 }, () => ({ min: -0.5, max: 0.75 }));
    const withPeaks = { ...valid, waveformPeaks: { sampleIntervalMs: 20, windowSamples: 882, normalization: 'signed-full-scale', music: source, drums: source, bass: source, vocals: source, other: source } };
    expect(validateDemoTimeline(withPeaks)).toMatchObject({ waveformPeaks: { sampleIntervalMs: 20 } });
    expect(() => validateDemoTimeline({ ...withPeaks, waveformPeaks: { ...withPeaks.waveformPeaks, drums: [{ min: 0.8, max: 0.2 }, ...source.slice(1)] } })).toThrow(/Feature Timeline validator/);
  });

  it('validates the fixed 32-band quantized Spectrum contract', () => {
    const frequencySpectrum = { hopMs: 20, fftSize: 4096, bandCount: 32, sampleRateHz: 44100, minHz: 40, maxHz: 16000, normalization: 'whole-clip-p99-log-rms', encoding: 'uint8-linear-0-255', values: Array.from({ length: 50 * 32 }, (_, index) => index % 256) };
    expect(validateDemoTimeline({ ...valid, frequencySpectrum })).toMatchObject({ frequencySpectrum: { bandCount: 32, hopMs: 20 } });
    expect(() => validateDemoTimeline({ ...valid, frequencySpectrum: { ...frequencySpectrum, values: [0] } })).toThrow(/デモ解析データ/);
    expect(() => validateDemoTimeline({ ...valid, frequencySpectrum: { ...frequencySpectrum, values: [256, ...frequencySpectrum.values.slice(1)] } })).toThrow(/デモ解析データ/);
  });

  it('merges peak and Spectrum sidecars while retaining the existing demo Timeline contract', async () => {
    const source = Array.from({ length: 50 }, () => ({ min: -0.3, max: 0.4 }));
    const peaks = { sampleIntervalMs: 20, windowSamples: 882, normalization: 'signed-full-scale', music: source, drums: source, bass: source, vocals: source, other: source };
    const spectrum = { hopMs: 20, fftSize: 4096, bandCount: 32, sampleRateHz: 44100, minHz: 40, maxHz: 16000, normalization: 'whole-clip-p99-log-rms', encoding: 'uint8-linear-0-255', values: Array(50 * 32).fill(10) };
    const loaded = await loadDemoTimeline(demoTracks[0]!, async (url) => new Response(JSON.stringify(String(url).includes('waveform-peaks') ? { waveformPeaks: peaks } : String(url).includes('frequency-spectrum') ? { frequencySpectrum: spectrum } : valid), { status: 200 }));
    expect(loaded.waveformPeaks).toEqual(peaks);
    expect(loaded.frequencySpectrum).toEqual(spectrum);
    expect(loaded.durationMs).toBe(valid.durationMs);
  });

  it('fails clearly for missing or malformed static Timeline assets', async () => {
    await expect(loadDemoTimeline(demoTracks[0]!, async () => new Response('', { status: 404 }))).rejects.toThrow(/HTTP 404/);
    await expect(loadDemoTimeline(demoTracks[0]!, async () => new Response('not-json', { status: 200 }))).rejects.toThrow(/JSONを解析できません/);
  });

  it.each([
    { ...valid, schemaVersion: 2 },
    { ...valid, bassEnvelope: [{ timeMs: 0, value: Number.NaN }] },
    { ...valid, kickEvents: [200], kickEventStrengths: [] },
    { ...valid, drumEnergy: [{ timeMs: 1, value: 0.2 }] },
    { ...valid, durationMs: 500 },
  ])('rejects invalid or mismatched Timeline data', (input) => {
    expect(() => validateDemoTimeline(input)).toThrow(/デモ解析データが不正です/);
  });
});
