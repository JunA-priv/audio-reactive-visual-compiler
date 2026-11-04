import { apiUrl } from './api-connection';
import { validateFeatureTimeline } from './renderer';
import type { FeatureTimeline } from './editor-model';

export const TARGET_SAMPLE_RATE = 44_100;
export const MAX_CLIP_SECONDS = 60;
export type KickGateMode = 'off' | 'soft' | 'middle' | 'hard';
export const MAX_ANALYSIS_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_CLIP_FRAMES = TARGET_SAMPLE_RATE * MAX_CLIP_SECONDS;

export function buildWaveformPeaks(buffer: Pick<AudioBuffer, 'length' | 'numberOfChannels' | 'getChannelData'>, maxPoints = 1600): Float32Array {
  if (!Number.isSafeInteger(buffer.length) || buffer.length < 0 || !Number.isSafeInteger(maxPoints) || maxPoints < 1) throw new Error('波形データを作成できません。');
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  if (channels.length === 0 || channels.some((channel) => channel.length !== buffer.length)) throw new Error('音源データを読み取れません。');
  const count = Math.min(maxPoints, Math.max(1, buffer.length));
  const peaks = new Float32Array(count);
  for (let point = 0; point < count; point += 1) {
    const first = Math.floor(point * buffer.length / count);
    const last = Math.max(first + 1, Math.floor((point + 1) * buffer.length / count));
    let peak = 0;
    for (const channel of channels) for (let frame = first; frame < Math.min(last, buffer.length); frame += 1) peak = Math.max(peak, Math.abs(channel[frame] ?? 0));
    peaks[point] = Number.isFinite(peak) ? Math.min(1, peak) : 0;
  }
  return peaks;
}

export type MusicSummary = {
  summaryVersion: 1;
  durationMs: number;
  sourceAudio: { format: string; codec: string; sampleRateHz: number; channels: number; fileBytes: number };
  analysis: { model: string; device: string; stemRms: Record<string, number>; estimatedKickCount: number; featureSampleRateHz: number; kickDetection: string };
};

export type AudioAnalysis = {
  featureTimeline: FeatureTimeline & { schemaVersion: 1; timeUnit: 'ms'; analysisVersion: string; sampleRateHz: number };
  musicSummary: MusicSummary;
  analysisMetadata: Record<string, unknown>;
  durationMs: number;
  frameCount: number;
};

type AnalysisResponse = { featureTimeline: unknown; musicSummary: unknown; analysisMetadata: unknown };

export async function trimAudioToWav(file: File, startSeconds: number, endSeconds: number): Promise<{ file: File; durationMs: number; frameCount: number }> {
  if (file.size < 1 || file.size > MAX_SOURCE_BYTES) throw new Error('元音源のサイズが対応範囲外です。');
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds || endSeconds - startSeconds > MAX_CLIP_SECONDS + 1e-6) {
    throw new Error('選択範囲は0秒超、最大60秒にしてください。');
  }
  const Context = globalThis.AudioContext;
  const Offline = globalThis.OfflineAudioContext;
  if (typeof Context !== 'function' || typeof Offline !== 'function') throw new Error('このブラウザーは音声トリミングに対応していません。');
  const context = new Context();
  try {
    const decoded = await context.decodeAudioData((await file.arrayBuffer()).slice(0));
    const availableFrames = Math.floor(decoded.duration * TARGET_SAMPLE_RATE);
    const startFrame = Math.max(0, Math.min(availableFrames - 1, Math.round(startSeconds * TARGET_SAMPLE_RATE)));
    let endFrame = Math.min(availableFrames, Math.round(endSeconds * TARGET_SAMPLE_RATE));
    endFrame = Math.floor(endFrame);
    if (endFrame - startFrame > MAX_CLIP_FRAMES) endFrame = startFrame + MAX_CLIP_FRAMES;
    const frameCount = Math.trunc(endFrame - startFrame);
    if (frameCount < 1 || frameCount > MAX_CLIP_FRAMES) throw new Error('音声区間が空、または60秒を超えています。');
    const durationMs = frameCount * 1000 / TARGET_SAMPLE_RATE;
    const offline = new Offline(2, frameCount, TARGET_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0, startFrame / TARGET_SAMPLE_RATE, durationMs / 1000);
    const rendered = await offline.startRendering();
    if (rendered.length !== frameCount || rendered.sampleRate !== TARGET_SAMPLE_RATE || rendered.numberOfChannels !== 2) throw new Error('トリミング後の音声形式が不正です。');
    const wav = encodePCM16StereoWav(rendered.getChannelData(0), rendered.getChannelData(1));
    if (wav.byteLength > MAX_ANALYSIS_REQUEST_BYTES) throw new Error('トリミング音声が16 MiBを超えています。');
    const baseName = file.name.replace(/\.[^.]*$/, '').slice(0, 96) || 'audio';
    return { file: new File([wav], `${baseName}-clip.wav`, { type: 'audio/wav' }), durationMs, frameCount };
  } finally {
    if (context.state !== 'closed') await context.close().catch(() => undefined);
  }
}

export function encodePCM16StereoWav(left: Float32Array, right: Float32Array): ArrayBuffer {
  if (left.length !== right.length || left.length < 1) throw new Error('PCMチャンネル長が一致しません。');
  const dataBytes = left.length * 4;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, value: string) => { for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true); view.setUint32(28, TARGET_SAMPLE_RATE * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, dataBytes, true);
  for (let i = 0; i < left.length; i += 1) {
    const l = Math.max(-1, Math.min(1, left[i] ?? 0));
    const r = Math.max(-1, Math.min(1, right[i] ?? 0));
    view.setInt16(44 + i * 4, l < 0 ? Math.round(l * 32768) : Math.round(l * 32767), true);
    view.setInt16(46 + i * 4, r < 0 ? Math.round(r * 32768) : Math.round(r * 32767), true);
  }
  return buffer;
}

export type AudioJobStatus = { jobId: string; state: 'queued'|'running'|'succeeded'|'failed'|'canceled'; queuePosition?: number; errorCode?: string; cancelRequested?: boolean };
const ACTIVE_JOB_KEY = 'arvc.audio.analysis.job.v1';
export function hasSavedAudioAnalysisJob():boolean{return Boolean(sessionStorage.getItem(ACTIVE_JOB_KEY));}
export function cancelSavedAudioAnalysisJob(accessToken:string):void{
  const jobId=sessionStorage.getItem(ACTIVE_JOB_KEY);if(!jobId)return;sessionStorage.removeItem(ACTIVE_JOB_KEY);
  void fetch(apiUrl(`/api/v1/audio/jobs/${encodeURIComponent(jobId)}`),{method:'DELETE',headers:{Authorization:`Bearer ${accessToken}`}}).catch(()=>undefined);
}

export async function analyzeAudioClip(file: File, accessToken: string, signal: AbortSignal, kickGateMode: KickGateMode = 'hard', onJobStatus?: (status: AudioJobStatus) => void): Promise<AudioAnalysis> {
  if(import.meta.env.VITE_AUDIO_ANALYSIS_JOBS_ENABLED==='true')return analyzeQueuedAudioClip(file,accessToken,signal,kickGateMode,onJobStatus);
  return analyzeAudioClipSync(file,accessToken,signal,kickGateMode);
}

export async function analyzeQueuedAudioClip(file: File, accessToken: string, signal: AbortSignal, kickGateMode: KickGateMode = 'hard', onJobStatus?: (status: AudioJobStatus) => void): Promise<AudioAnalysis> {
  if (file.type !== 'audio/wav' || file.size <= 44 || file.size > MAX_ANALYSIS_REQUEST_BYTES) throw new Error('解析用WAVクリップの形式またはサイズが不正です。');
  const form = new FormData();
  form.append('audio', file, file.name);
  form.append('kickGateMode', kickGateMode);
  let response = await fetch(apiUrl('/api/v1/audio/jobs'), { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Idempotency-Key': crypto.randomUUID() }, body: form, signal });
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) { window.dispatchEvent(new Event('arvc-auth-expired')); throw new Error('セッションが切れました。再度ログインしてください。'); }
    if (response.status === 413) throw new Error('トリミング音声が16 MiBを超えています。');
    if (response.status === 422) throw new Error('解析サーバーが音声データを受け付けませんでした。音声形式と60秒以内の選択範囲を確認してください。');
    if (response.status === 429) throw new Error('解析キューが満杯です。少し待ってから再試行してください。');
    if (response.status === 504) throw new Error('音声解析が制限時間を超えました。');
    if (response.status === 499 || signal.aborted) throw new DOMException('分析を中断しました。', 'AbortError');
    throw new Error(readJobError(raw) ?? '音声解析に失敗しました。');
  }
  const accepted = raw as { jobId?: unknown; state?: unknown } | null;
  if (!accepted || typeof accepted.jobId !== 'string' || accepted.state !== 'queued') throw new Error('解析ジョブ応答の形式が不正です。');
  const jobId = accepted.jobId;
  sessionStorage.setItem(ACTIVE_JOB_KEY, jobId);
  try {
    let status: AudioJobStatus = { jobId, state: 'queued' };
    onJobStatus?.(status);
    while (status.state === 'queued' || status.state === 'running') {
      await delay(1200, signal);
      response = await fetch(apiUrl(`/api/v1/audio/jobs/${encodeURIComponent(jobId)}`), { headers: { Authorization: `Bearer ${accessToken}` }, signal });
      const stateRaw: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(readJobError(stateRaw) ?? '解析ジョブの状態を取得できません。');
      status = parseJobStatus(stateRaw);
      onJobStatus?.(status);
    }
    if (status.state === 'canceled') throw new DOMException('分析を中断しました。', 'AbortError');
    if (status.state === 'failed') throw new Error(`音声解析に失敗しました。(${status.errorCode ?? 'analysis_failed'})`);
    response = await fetch(apiUrl(`/api/v1/audio/jobs/${encodeURIComponent(jobId)}/result`), { headers: { Authorization: `Bearer ${accessToken}` }, signal });
    const result: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(readJobError(result) ?? '解析結果を取得できません。');
    return parseAnalysisResult(result);
  } catch (error) {
    if (signal.aborted) {
      void fetch(apiUrl(`/api/v1/audio/jobs/${encodeURIComponent(jobId)}`), { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } }).catch(() => undefined);
      throw new DOMException('分析を中断しました。', 'AbortError');
    }
    throw error;
  } finally {
    if (sessionStorage.getItem(ACTIVE_JOB_KEY) === jobId) sessionStorage.removeItem(ACTIVE_JOB_KEY);
  }
}

export async function analyzeAudioClipSync(file:File,accessToken:string,signal:AbortSignal,kickGateMode:KickGateMode='hard'):Promise<AudioAnalysis>{
  if(file.type!=='audio/wav'||file.size<=44||file.size>MAX_ANALYSIS_REQUEST_BYTES)throw new Error('解析用WAVクリップの形式またはサイズが不正です。');
  const form=new FormData();form.append('audio',file,file.name);form.append('kickGateMode',kickGateMode);
  const response=await fetch(apiUrl('/api/v1/audio/analyze'),{method:'POST',headers:{Authorization:`Bearer ${accessToken}`},body:form,signal});
  const raw:unknown=await response.json().catch(()=>null);
  if(!response.ok){
    if(response.status===401){window.dispatchEvent(new Event('arvc-auth-expired'));throw new Error('セッションが切れました。再度ログインしてください。');}
    if(response.status===413)throw new Error('トリミング音声が16 MiBを超えています。');
    if(response.status===422)throw new Error('解析サーバーが音声データを受け付けませんでした。音声形式と60秒以内の選択範囲を確認してください。');
    if(response.status===429)throw new Error('別の音声解析が進行中です。完了後に再試行してください。');
    if(response.status===504)throw new Error('音声解析が制限時間を超えました。');
    if(response.status===499||signal.aborted)throw new DOMException('分析を中断しました。','AbortError');
    throw new Error('音声解析に失敗しました。');
  }
  return parseAnalysisResult(raw);
}

export async function restoreAudioAnalysisJob(accessToken:string,signal:AbortSignal,onJobStatus?:(status:AudioJobStatus)=>void):Promise<AudioAnalysis|null>{
  const jobId=sessionStorage.getItem(ACTIVE_JOB_KEY);if(!jobId)return null;
  let status:AudioJobStatus={jobId,state:'queued'};
  try{
    while(status.state==='queued'||status.state==='running'){
      const response=await fetch(apiUrl(`/api/v1/audio/jobs/${encodeURIComponent(jobId)}`),{headers:{Authorization:`Bearer ${accessToken}`},signal});
      const value:unknown=await response.json().catch(()=>null);
      if(!response.ok)throw new Error(readJobError(value)??'解析ジョブの状態を復元できません。');
      status=parseJobStatus(value);onJobStatus?.(status);if(status.state==='queued'||status.state==='running')await delay(1200,signal);
    }
    if(status.state==='canceled')throw new DOMException('分析を中断しました。','AbortError');
    if(status.state==='failed')throw new Error(`音声解析に失敗しました。(${status.errorCode??'analysis_failed'})`);
    const response=await fetch(apiUrl(`/api/v1/audio/jobs/${encodeURIComponent(jobId)}/result`),{headers:{Authorization:`Bearer ${accessToken}`},signal});
    const value:unknown=await response.json().catch(()=>null);if(!response.ok)throw new Error(readJobError(value)??'解析結果を復元できません。');return parseAnalysisResult(value);
  }finally{if(!signal.aborted&&sessionStorage.getItem(ACTIVE_JOB_KEY)===jobId)sessionStorage.removeItem(ACTIVE_JOB_KEY);}
}

function parseAnalysisResult(raw: unknown): AudioAnalysis {
  const result = raw as AnalysisResponse | null;
  if (!result || typeof result !== 'object' || !isRecord(result.analysisMetadata)) throw new Error('解析応答の形式が不正です。');
  const summary = result.musicSummary as MusicSummary;
  const timeline = result.featureTimeline as AudioAnalysis['featureTimeline'];
  if (!isRecord(summary) || summary.summaryVersion !== 1 || !Number.isSafeInteger(summary.durationMs) || !isRecord(timeline) || timeline.schemaVersion !== 1 || timeline.timeUnit !== 'ms' || typeof timeline.analysisVersion !== 'string') throw new Error('解析応答に必須項目がありません。');
  validateFeatureTimeline(timeline);
  if (summary.durationMs !== timeline.durationMs || summary.durationMs < 1 || summary.durationMs > 60_000) throw new Error('解析結果の音源長とFeature Timelineが一致しません。');
  return { featureTimeline: timeline, musicSummary: summary, analysisMetadata: result.analysisMetadata, durationMs: timeline.durationMs, frameCount: Math.round(timeline.durationMs * TARGET_SAMPLE_RATE / 1000) };
}

function parseJobStatus(value: unknown): AudioJobStatus {
  if (!isRecord(value) || typeof value.jobId !== 'string' || !['queued','running','succeeded','failed','canceled'].includes(String(value.state))) throw new Error('解析ジョブ状態の形式が不正です。');
  return { jobId: value.jobId, state: value.state as AudioJobStatus['state'], ...(Number.isSafeInteger(value.queuePosition) ? { queuePosition: value.queuePosition as number } : {}), ...(typeof value.errorCode === 'string' ? { errorCode: value.errorCode } : {}), ...(typeof value.cancelRequested === 'boolean' ? { cancelRequested: value.cancelRequested } : {}) };
}

function readJobError(value: unknown): string | null { return isRecord(value) && isRecord(value.error) && typeof value.error.message === 'string' ? value.error.message : null; }
function delay(ms: number, signal: AbortSignal): Promise<void> { return new Promise((resolve,reject)=>{ if(signal.aborted){reject(new DOMException('分析を中断しました。','AbortError'));return;} const timer=setTimeout(resolve,ms); signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('分析を中断しました。','AbortError'));},{once:true}); }); }

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
