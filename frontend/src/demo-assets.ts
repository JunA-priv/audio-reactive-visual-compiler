import type { FeatureTimeline } from './editor-model';
import { validateFeatureTimeline } from './renderer';

export type DemoTrack = { id: string; title: string; audioUrl: string; timelineUrl: string; waveformPeaksUrl?: string; frequencySpectrumUrl?: string };

export const demoTracks: DemoTrack[] = [
  { id: 'demo1', title: 'デモ1', audioUrl: '/demo/audio-reactive-silent-demo1.mp3', timelineUrl: '/demo/demo1.feature-timeline-v2.json', waveformPeaksUrl: '/demo/demo1.waveform-peaks-v2.json', frequencySpectrumUrl: '/demo/demo1.frequency-spectrum-v1.json' },
  { id: 'demo2', title: 'デモ2', audioUrl: '/demo/audio-reactive-silent-demo2.mp3', timelineUrl: '/demo/demo2.feature-timeline-v2.json', waveformPeaksUrl: '/demo/demo2.waveform-peaks-v2.json', frequencySpectrumUrl: '/demo/demo2.frequency-spectrum-v1.json' },
  { id: 'demo3', title: 'デモ3', audioUrl: '/demo/audio-reactive-silent-demo3.mp3', timelineUrl: '/demo/demo3.feature-timeline-v2.json', waveformPeaksUrl: '/demo/demo3.waveform-peaks-v2.json', frequencySpectrumUrl: '/demo/demo3.frequency-spectrum-v1.json' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never { throw new Error(`デモ解析データが不正です: ${message}`); }

export function validateDemoTimeline(value: unknown): FeatureTimeline {
  if (!isRecord(value)) return fail('JSON objectがありません');
  if (value.schemaVersion !== 1 || value.timeUnit !== 'ms' || value.sampleRateHz !== 44_100 || typeof value.analysisVersion !== 'string' || !value.analysisVersion.startsWith('python-island/')) return fail('schema/versionが未対応です');
  if (!Number.isSafeInteger(value.durationMs) || (value.durationMs as number) <= 0 || (value.durationMs as number) > 240_000) return fail('durationMsが範囲外です');
  if (!Array.isArray(value.bassEnvelope) || value.bassEnvelope.length === 0 || value.bassEnvelope.length > 25_000 || !Array.isArray(value.kickEvents) || value.kickEvents.length > 20_000 || !Array.isArray(value.kickEventStrengths) || value.kickEventStrengths.length !== value.kickEvents.length || !Array.isArray(value.drumEnergy) || value.drumEnergy.length === 0 || value.drumEnergy.length > 25_000) return fail('必須Featureまたは配列件数が不正です');
  const durationMs = value.durationMs as number;
  const checkPoints = (points: unknown[], key: string) => {
    let previous = -1;
    for (const item of points) {
      if (!isRecord(item) || !Number.isFinite(item.timeMs) || !Number.isFinite(item.value) || (item.timeMs as number) <= previous || (item.timeMs as number) < 0 || (item.timeMs as number) > durationMs || (item.value as number) < 0 || (item.value as number) > 1) return fail(`${key}の時刻または値が不正です`);
      previous = item.timeMs as number;
    }
    if ((points[0] as Record<string, number>).timeMs !== 0) return fail(`${key}が0msから始まりません`);
  };
  checkPoints(value.bassEnvelope, 'bassEnvelope');
  checkPoints(value.drumEnergy, 'drumEnergy');
  for (const key of ['vocalsEnvelope', 'otherEnvelope', 'musicEnergy'] as const) {
    const points = value[key];
    if (points !== undefined) {
      if (!Array.isArray(points) || points.length === 0 || points.length > 25_000) return fail(`${key}の配列件数が不正です`);
      checkPoints(points, key);
    }
  }
  let previousKick = -1;
  for (let index = 0; index < value.kickEvents.length; index += 1) {
    const event = value.kickEvents[index];
    const strength = value.kickEventStrengths[index];
    if (!Number.isSafeInteger(event) || (event as number) <= previousKick || (event as number) < 0 || (event as number) > durationMs || !Number.isFinite(strength) || (strength as number) < 0 || (strength as number) > 1) return fail('kickEvents / kickEventStrengthsが不正です');
    previousKick = event as number;
  }
  if (value.snareEvents !== undefined || value.snareEventStrengths !== undefined) {
    if (!Array.isArray(value.snareEvents) || !Array.isArray(value.snareEventStrengths) || value.snareEvents.length !== value.snareEventStrengths.length || value.snareEvents.length > 20_000) return fail('snareEvents / snareEventStrengthsが不正です');
    let previousSnare = -1;
    const snareEvents = value.snareEvents as unknown[];
    const snareStrengths = value.snareEventStrengths as unknown[];
    snareEvents.forEach((event, index) => {
      const strength = snareStrengths[index];
      if (!Number.isSafeInteger(event) || (event as number) <= previousSnare || (event as number) < 0 || (event as number) > durationMs || !Number.isFinite(strength) || (strength as number) < 0 || (strength as number) > 1) return fail('snareEvents / snareEventStrengthsが不正です');
      previousSnare = event as number;
    });
  }
  try { validateFeatureTimeline(value as unknown as FeatureTimeline); }
  catch { return fail('Frontend Feature Timeline validatorに違反しています'); }
  return value as unknown as FeatureTimeline;
}

export async function loadDemoTimeline(track: DemoTrack, fetcher: typeof fetch = fetch): Promise<FeatureTimeline> {
  const response = await fetcher(track.timelineUrl);
  if (!response.ok) throw new Error(`${track.title}のTimelineを読み込めません (HTTP ${response.status})`);
  let json: unknown;
  try { json = await response.json(); }
  catch { return fail(`${track.title}のTimeline JSONを解析できません`); }
  const timeline = validateDemoTimeline(json);
  const extended: Record<string, unknown> = { ...timeline };
  if (track.waveformPeaksUrl) {
    const peaksResponse = await fetcher(track.waveformPeaksUrl);
    if (peaksResponse.ok) {
      try {
        const peaksJson: unknown = await peaksResponse.json();
        if (isRecord(peaksJson) && isRecord(peaksJson.waveformPeaks)) extended.waveformPeaks = peaksJson.waveformPeaks;
      } catch { /* Older static demos remain playable without waveform peak data. */ }
    }
  }
  if (track.frequencySpectrumUrl) {
    const spectrumResponse = await fetcher(track.frequencySpectrumUrl);
    if (spectrumResponse.ok) {
      try {
        const spectrumJson: unknown = await spectrumResponse.json();
        if (isRecord(spectrumJson) && isRecord(spectrumJson.frequencySpectrum)) extended.frequencySpectrum = spectrumJson.frequencySpectrum;
      } catch { /* Spectrum Effects remain explicitly inactive if the optional sidecar is unavailable. */ }
    }
  }
  return validateDemoTimeline(extended);
}
