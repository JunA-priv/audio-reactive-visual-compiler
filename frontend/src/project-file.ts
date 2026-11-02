import { normalizeBlueprintForSave, validateBlueprint } from './editor-model';
import type { EditorBlueprint, FeatureTimeline } from './editor-model';
import { validateFeatureTimeline } from './renderer';
import type { MusicSummary } from './audio-analysis';

export const PROJECT_FILE_FORMAT = 'arvc-project';
export const PROJECT_FILE_VERSION = 1;
export const PROJECT_RENDERER_VERSION = 'editor-renderer/1';
export const MAX_PROJECT_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_PROJECT_AUDIO_BYTES = 32 * 1024 * 1024;

export type ProjectAudioAsset = {
  name: string;
  mimeType: string;
  dataBase64: string;
  sha256: string;
};

export type ProjectFile = {
  format: typeof PROJECT_FILE_FORMAT;
  formatVersion: typeof PROJECT_FILE_VERSION;
  metadata: {
    createdAt: string;
    blueprintSchemaVersion: 1;
    featureTimelineSchemaVersion: 1;
    rendererVersion: typeof PROJECT_RENDERER_VERSION;
    analysisVersion: string;
    seed: number;
    musicSummary?: MusicSummary;
  };
  blueprint: EditorBlueprint;
  featureTimeline: FeatureTimeline;
  assets: { audio: ProjectAudioAsset | null };
};

export type RestoredProject = {
  blueprint: EditorBlueprint;
  featureTimeline: FeatureTimeline;
  audioFile: File | null;
  musicSummary: MusicSummary | null;
};

function fail(message: string): never {
  throw new Error(`Invalid project file: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeAudioName(name: string): string {
  const safe = name.replace(/[\\/\0]/g, '_').trim();
  if (!safe || safe.length > 255) fail('invalid audio filename');
  return safe;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function decodeBase64(value: string): Uint8Array {
  if (!value || value.length > Math.ceil(MAX_PROJECT_AUDIO_BYTES / 3) * 4 || value.length % 4 !== 0) {
    fail('invalid audio encoding');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const bodyLength = value.length - padding;
  if ((padding === 2 && bodyLength % 4 !== 2) || (padding === 1 && bodyLength % 4 !== 3) || (padding === 0 && bodyLength % 4 !== 0)) fail('invalid audio encoding');
  for (let index = 0; index < bodyLength; index += 1) {
    const code = value.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47)) fail('invalid audio encoding');
  }
  let binary: string;
  try { binary = atob(value); } catch { return fail('invalid audio encoding'); }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 is unavailable in this browser context. Open the local app on localhost or HTTPS.');
  const digest = await crypto.subtle.digest('SHA-256', ownedBuffer(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function timelineMetadata(timeline: FeatureTimeline): { schemaVersion: number; analysisVersion: string } {
  const extended = timeline as FeatureTimeline & { schemaVersion?: unknown; analysisVersion?: unknown; timeUnit?: unknown };
  if (extended.schemaVersion !== undefined && extended.schemaVersion !== 1) fail('unsupported Feature Timeline schema version');
  if (extended.timeUnit !== undefined && extended.timeUnit !== 'ms') fail('unsupported Feature Timeline time unit');
  return {
    schemaVersion: typeof extended.schemaVersion === 'number' ? extended.schemaVersion : 1,
    analysisVersion: typeof extended.analysisVersion === 'string' ? extended.analysisVersion : 'unknown',
  };
}

function validateProjectInputs(blueprint: EditorBlueprint, timeline: FeatureTimeline): void {
  validateBlueprint(blueprint);
  validateFeatureTimeline(timeline);
  if (timeline.bassEnvelope.length > 50_000 || timeline.kickEvents.length > 20_000) fail('Feature Timeline exceeds item limits');
  timelineMetadata(timeline);
  if (blueprint.background.kind === 'image' && blueprint.background.src.length > 14_000_000) fail('background image exceeds size limit');
}

function validateMusicSummary(value: unknown, durationMs: number): MusicSummary {
  if (!isRecord(value) || value.summaryVersion !== 1 || value.durationMs !== durationMs || typeof value.durationMs !== 'number' || value.durationMs <= 0 || value.durationMs > 60_000 || !isRecord(value.sourceAudio) || !isRecord(value.analysis) || !isRecord(value.analysis.stemRms)) fail('Music Summary is invalid or does not match the Feature Timeline');
  const source = value.sourceAudio;
  const analysis = value.analysis;
  const stemRms = analysis.stemRms;
  if (!isRecord(stemRms)) fail('Music Summary stem levels are invalid');
  if (source.format !== 'wav' || source.codec !== 'pcm_s16le' || !Number.isSafeInteger(source.sampleRateHz) || Number(source.sampleRateHz) !== 44_100 || source.channels !== 2 || !Number.isSafeInteger(source.fileBytes) || Number(source.fileBytes) < 45 || Number(source.fileBytes) > 16 * 1024 * 1024) fail('Music Summary source audio metadata is invalid');
  if (Object.keys(stemRms).length < 1 || Object.keys(stemRms).length > 16 || Object.entries(stemRms).some(([key, item]) => !key || key.length > 64 || typeof item !== 'number' || !Number.isFinite(item) || item < 0)) fail('Music Summary stem levels are invalid');
  if (typeof analysis.model !== 'string' || !analysis.model || analysis.model.length > 128 || typeof analysis.device !== 'string' || !analysis.device || analysis.device.length > 64 || !Number.isInteger(analysis.estimatedKickCount) || Number(analysis.estimatedKickCount) < 0 || Number(analysis.estimatedKickCount) > 20_000 || typeof analysis.featureSampleRateHz !== 'number' || !Number.isFinite(analysis.featureSampleRateHz) || analysis.featureSampleRateHz <= 0 || analysis.featureSampleRateHz > 1000 || typeof analysis.kickDetection !== 'string' || !analysis.kickDetection || analysis.kickDetection.length > 512) fail('Music Summary analysis metadata is invalid');
  return value as unknown as MusicSummary;
}

function validateAnalyzedWav(bytes: Uint8Array, mimeType: string, summary: MusicSummary): void {
  if (mimeType !== 'audio/wav' || bytes.byteLength < 45) fail('analyzed audio must be a non-empty WAV clip');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, expected: string) => expected.split('').every((character, index) => view.getUint8(offset + index) === character.charCodeAt(0));
  if (!ascii(0, 'RIFF') || !ascii(8, 'WAVE') || !ascii(12, 'fmt ') || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 2 || view.getUint32(24, true) !== 44_100 || view.getUint32(28, true) !== 176_400 || view.getUint16(32, true) !== 4 || view.getUint16(34, true) !== 16 || !ascii(36, 'data')) fail('analyzed WAV format is invalid');
  const dataBytes = view.getUint32(40, true);
  const durationMs = dataBytes / 4 * 1000 / 44_100;
  if (view.getUint32(4, true) + 8 !== bytes.byteLength || dataBytes !== bytes.byteLength - 44 || dataBytes % 4 !== 0 || Math.abs(durationMs - summary.durationMs) > 1.1 || summary.sourceAudio.codec !== 'pcm_s16le' || summary.sourceAudio.sampleRateHz !== 44_100 || summary.sourceAudio.channels !== 2) fail('analyzed WAV is truncated or inconsistent with its Music Summary');
}

export function inferAudioMimeType(file: Pick<File, 'name' | 'type'>): string {
  const supportedMimeTypes = new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/opus', 'audio/mp4', 'audio/aac', 'audio/webm', 'audio/flac']);
  if (supportedMimeTypes.has(file.type)) return file.type === 'audio/x-wav' ? 'audio/wav' : file.type;
  const extension = file.name.toLowerCase().split('.').pop();
  return ({ mp3: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/opus', m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm', flac: 'audio/flac' } as Record<string, string>)[extension ?? ''] ?? '';
}

export async function serializeProject(
  blueprint: EditorBlueprint,
  timeline: FeatureTimeline,
  audioFile: File | null,
  createdAt = new Date(),
  musicSummary: MusicSummary | null = null,
): Promise<Blob> {
  const storedBlueprint = normalizeBlueprintForSave(blueprint);
  validateProjectInputs(storedBlueprint, timeline);
  let audio: ProjectAudioAsset | null = null;
  let audioBytes: Uint8Array | null = null;
  if (audioFile) {
    if (audioFile.size < 1 || audioFile.size > MAX_PROJECT_AUDIO_BYTES) fail('audio file exceeds 32 MiB or is empty');
    const mimeType = inferAudioMimeType(audioFile);
    if (!mimeType) fail('unsupported audio file type');
    audioBytes = new Uint8Array(await audioFile.arrayBuffer());
    audio = { name: safeAudioName(audioFile.name), mimeType, dataBase64: encodeBase64(audioBytes), sha256: await sha256(audioBytes) };
  }
  const storedMusicSummary = musicSummary === null ? undefined : validateMusicSummary(musicSummary, timeline.durationMs);
  if (storedMusicSummary && !audio) fail('Music Summary requires its analyzed audio clip');
  if (storedMusicSummary && audioFile && (storedMusicSummary.sourceAudio.fileBytes !== audioFile.size || !audioBytes)) fail('Music Summary audio size does not match the embedded clip');
  if (storedMusicSummary && audioFile && audioBytes) validateAnalyzedWav(audioBytes, audio!.mimeType, storedMusicSummary);
  const extended = timeline as FeatureTimeline & { analysisVersion?: unknown };
  const metadata = timelineMetadata(timeline);
  const project: ProjectFile = {
    format: PROJECT_FILE_FORMAT,
    formatVersion: PROJECT_FILE_VERSION,
    metadata: {
      createdAt: createdAt.toISOString(),
      blueprintSchemaVersion: 1,
      featureTimelineSchemaVersion: metadata.schemaVersion as 1,
      rendererVersion: PROJECT_RENDERER_VERSION,
      analysisVersion: typeof extended.analysisVersion === 'string' ? extended.analysisVersion : 'unknown',
      seed: storedBlueprint.seed,
      ...(storedMusicSummary ? { musicSummary: storedMusicSummary } : {}),
    },
    blueprint: storedBlueprint,
    // JSON cloning retains additive Python Timeline fields such as featureHopMs and drumEnergy.
    featureTimeline: JSON.parse(JSON.stringify(timeline)) as FeatureTimeline,
    assets: { audio },
  };
  const json = JSON.stringify(project);
  if (new TextEncoder().encode(json).byteLength > MAX_PROJECT_FILE_BYTES) fail('project file exceeds 64 MiB');
  return new Blob([json], { type: 'application/json' });
}

function validateStoredBlueprint(value: unknown): EditorBlueprint {
  if (!isRecord(value)) return fail('missing Blueprint');
  try { validateBlueprint(value as unknown as EditorBlueprint); } catch { return fail('Blueprint does not match Editor schema v1'); }
  return value as unknown as EditorBlueprint;
}

function validateStoredTimeline(value: unknown): FeatureTimeline {
  if (!isRecord(value)) return fail('missing Feature Timeline');
  const timeline = value as unknown as FeatureTimeline;
  try { validateFeatureTimeline(timeline); } catch { return fail('Feature Timeline is invalid'); }
  if (timeline.bassEnvelope.length > 50_000 || timeline.kickEvents.length > 20_000) fail('Feature Timeline exceeds item limits');
  timelineMetadata(timeline);
  return timeline;
}

export async function parseProjectFile(file: File): Promise<RestoredProject> {
  if (file.size < 1 || file.size > MAX_PROJECT_FILE_BYTES) fail('file exceeds 64 MiB or is empty');
  let parsed: unknown;
  try { parsed = JSON.parse(await file.text()) as unknown; } catch { return fail('file is not valid JSON'); }
  if (!isRecord(parsed) || parsed.format !== PROJECT_FILE_FORMAT) fail('unsupported file format');
  if (parsed.formatVersion !== PROJECT_FILE_VERSION) fail('unsupported project version');
  if (!isRecord(parsed.metadata) || parsed.metadata.blueprintSchemaVersion !== 1 || parsed.metadata.featureTimelineSchemaVersion !== 1) fail('unsupported schema version');
  if (parsed.metadata.rendererVersion !== PROJECT_RENDERER_VERSION) fail('unsupported Renderer version');
  if (typeof parsed.metadata.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.metadata.createdAt)) || typeof parsed.metadata.analysisVersion !== 'string' || parsed.metadata.analysisVersion.length > 256) fail('invalid project metadata');
  const blueprint = validateStoredBlueprint(parsed.blueprint);
  if (parsed.metadata.seed !== blueprint.seed) fail('project seed does not match Blueprint');
  const featureTimeline = validateStoredTimeline(parsed.featureTimeline);
  const musicSummary = parsed.metadata.musicSummary === undefined ? null : validateMusicSummary(parsed.metadata.musicSummary, featureTimeline.durationMs);
  if (!isRecord(parsed.assets) || !(parsed.assets.audio === null || isRecord(parsed.assets.audio))) fail('invalid assets');

  let audioFile: File | null = null;
  const audio = parsed.assets.audio;
  if (audio) {
    if (typeof audio.name !== 'string' || typeof audio.mimeType !== 'string' || !inferAudioMimeType({ name: audio.name, type: audio.mimeType }) || typeof audio.dataBase64 !== 'string' || typeof audio.sha256 !== 'string') fail('invalid audio asset metadata');
    const name = safeAudioName(audio.name);
    const bytes = decodeBase64(audio.dataBase64);
    if (bytes.length < 1 || bytes.length > MAX_PROJECT_AUDIO_BYTES) fail('audio asset exceeds 32 MiB or is empty');
    if (!/^[a-f0-9]{64}$/.test(audio.sha256) || await sha256(bytes) !== audio.sha256) fail('audio asset integrity check failed');
    audioFile = new File([ownedBuffer(bytes)], name, { type: audio.mimeType });
    if (musicSummary) validateAnalyzedWav(bytes, inferAudioMimeType({ name, type: audio.mimeType }), musicSummary);
  }
  if (musicSummary && !audioFile) fail('Music Summary requires its analyzed audio clip');
  if (musicSummary && audioFile && musicSummary.sourceAudio.fileBytes !== audioFile.size) fail('Music Summary audio size does not match the embedded clip');
  return { blueprint, featureTimeline, audioFile, musicSummary };
}
