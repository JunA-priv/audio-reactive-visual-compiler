import { useEffect, useMemo, useRef, useState } from 'react';
import { apiUrl } from './api-connection';
import type { ChangeEvent, PointerEvent } from 'react';
import { DEFAULT_GLOBAL_GRADIENT, demoTimeline, newEditorBlueprint, validateBlueprint } from './editor-model';
import type { Background, EditorBlueprint, Effect, EffectColorMode, FeatureTimeline, GlobalGradient, Region, RegionGeometry } from './editor-model';
import { renderEditorFrame } from './renderer';
import type { RenderAssets } from './renderer';
import { inferAudioMimeType, parseProjectFile, serializeProject } from './project-file';
import { exportMP4, exportWebM, isMP4Supported } from './video-export';
import type { ExportFPS, ExportScale, VideoFormat } from './video-export';
import { readSession, signIn, signOut, subscribeAuth, validSession } from './auth-client';
import type { AuthSession } from './auth-client';
import { createProject, deleteAsset, deleteProject, getProject, imageFileFromDataURL, listAssets, listProjects, loadAsset, updateProject, uploadAsset } from './cloud-api';
import type { CloudEnvelopeProject, CloudProject } from './cloud-api';
import { envelopeFromProjectDocumentV1, hydrateCloudEnvelopeV1, toCloudEnvelopeV1 } from './cloud-project';
import { analyzeAudioClip, cancelSavedAudioAnalysisJob, hasSavedAudioAnalysisJob, MAX_CLIP_SECONDS, restoreAudioAnalysisJob, trimAudioToWav, type AudioJobStatus, type KickGateMode } from './audio-analysis';
import type { MusicSummary } from './audio-analysis';
import { demoTracks, loadDemoTimeline } from './demo-assets';
import { AudioRangeSelectionModal } from './AudioRangeSelectionModal';
import { buildWaveformPeaks } from './audio-analysis';

type Tool = 'select' | 'rect' | 'polygon';
type PositionKeys = { xKey: 'centerX' | 'originX'; yKey: 'centerY' | 'originY' };
type RegionEditMode = 'move-rect' | 'resize-rect' | 'move-polygon-point';
type RegionResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
type RegionEditDrag= { regionId: string; pointerId: number; mode: RegionEditMode; edge?: RegionResizeEdge; pointIndex?: number; startPoint: { x: number; y: number }; startGeometry: RegionGeometry };
export const EFFECTS_BY_CATEGORY = {
  'Core / Transform': ['pulse-scale', 'glow-brightness', 'rotation-movement'],
  'Waveform': ['waveform-bars', 'waveform-line', 'waveform-peak-bars', 'oscilloscope-line'],
  'EQ / Spectrum': ['spectrum-bars', 'spectrum-line'],
  'Circular / Radial': ['radial-bars', 'wave-ring', 'waveform-ring'],
  'Particles': ['particles', 'particle-burst', 'particle-trail'],
  'Impacts': ['ripple', 'shockwave'],
  'Ambient / Atmospheric': ['ink-diffusion', 'ink-flow', 'color-mixing'],
} as const satisfies Record<string, Effect['kind'][]>;
type EffectCategory = keyof typeof EFFECTS_BY_CATEGORY;
const EFFECT_CATEGORIES = Object.keys(EFFECTS_BY_CATEGORY) as EffectCategory[];

export function effectCategoryFor(kind: Effect['kind']): EffectCategory {
  return EFFECT_CATEGORIES.find((category) => (EFFECTS_BY_CATEGORY[category] as readonly Effect['kind'][]).includes(kind)) ?? 'Core / Transform';
}

function clamp01(value: number): number { return Math.min(1, Math.max(0, value)); }

function effectPosition(effect: Effect): ({ x: number; y: number } & PositionKeys) | null {
  switch (effect.kind) {
    case 'radial-bars':
    case 'wave-ring':
    case 'ripple':
    case 'shockwave': return { x: effect.centerX, y: effect.centerY, xKey: 'centerX', yKey: 'centerY' };
    case 'particle-burst': return { x: effect.originX, y: effect.originY, xKey: 'originX', yKey: 'originY' };
    default: return null;
  }
}

function newEffectDefaults(kind: Effect['kind'], regionId: string, index: number): Effect {
  const id = `effect-${kind}-${index}`;
  switch (kind) {
    case 'pulse-scale': return { id, kind, regionId, color: '#ff9bd1', colorMode: 'global-gradient', baseScale: 0.4, maxScale: 1 };
    case 'glow-brightness': return { id, kind, regionId, color: '#42eaff', colorMode: 'global-gradient', blurPx: 38, brightness: 1.45, glowIntensity: 1.6 };
    case 'rotation-movement': return { id, kind, regionId, color: '#b4a5ff', colorMode: 'global-gradient', rotationDeg: 20, moveX: 0.08, moveY: 0.03 };
    case 'particles': return { id, kind, regionId, color: '#ffe39b', colorMode: 'global-gradient', count: 64, sizePx: 4, cycleMs: 2200, spread: 0.92, speedInfluence: 0.9, glowIntensity: 1.1, baselineOpacity: 0.26 };
    case 'waveform-bars': return { id, kind, regionId, color: '#91e8ff', colorMode: 'global-gradient', bars: 24, lineWidth: 0.72 };
    case 'waveform-line': return { id, kind, regionId, color: '#91e8ff', colorMode: 'global-gradient', orientation: 'horizontal', sampleCount: 192, amplitudeScale: 0.9, lineWidth: 0.012, glowIntensity: 1.25 };
    case 'waveform-peak-bars': return { id, kind, regionId, color: '#91e8ff', colorMode: 'global-gradient', bars: 64, barWidth: 0.82, spacing: 0.08, amplitudeScale: 1, glowIntensity: 1.1 };
    case 'spectrum-bars': return { id, kind, regionId, color: '#91e8ff', colorMode: 'global-gradient', barWidth: 0.72, spacing: 0.12, amplitudeScale: 1.35, glowIntensity: 1.15, segmented: true, segmentsPerBar: 12, attackMs: 35, releaseMs: 180 };
    case 'spectrum-line': return { id, kind, regionId, color: '#91e8ff', colorMode: 'global-gradient', amplitudeScale: 1.4, lineWidth: 0.012, smoothing: 0.35, glowIntensity: 1.2, attackMs: 35, releaseMs: 180 };
    case 'waveform-ring': return { id, kind, regionId, color: '#91e8ff', colorMode: 'global-gradient', radius: 0.28, sampleCount: 256, amplitudeScale: 1, lineWidth: 0.012, smoothing: 0.55, glowIntensity: 1.25, rotationMode: 'continuous', beatsPerRevolution: 8, rotationDirection: 'clockwise', initialAngleDeg: 0 };
    case 'radial-bars': return { id, kind, regionId, color: '#38edff', colorMode: 'global-gradient', centerX: 0.5, centerY: 0.5, radius: 0.26, bars: 64, barLength: 0.22, lineWidth: 0.35, barWidth: 0.42, spikeSharpness: 0.9, innerRadius: 0.13, amplitudeScale: 1.8, glowIntensity: 1.5, rotationMode: 'continuous', beatsPerRevolution: 8, rotationDirection: 'clockwise', initialAngleDeg: 0 };
    case 'wave-ring': return { id, kind, regionId, color: '#f346ff', colorMode: 'global-gradient', opacity: 1, centerX: 0.5, centerY: 0.5, radius: 0.28, amplitude: 0.14, points: 64, lineWidth: 0.018, sampleCount: 192, amplitudeScale: 2.4, jaggedness: 0.9, smoothing: 0.55, glowIntensity: 1.5, layerCount: 4, layerRadiusStep: 0.018, layerAngleOffsetDeg: 0, layerAmplitudeDecay: 0.9, rotationMode: 'continuous', beatsPerRevolution: 8, rotationDirection: 'clockwise', initialAngleDeg: 0 };
    case 'particle-burst': return { id, kind, regionId, color: '#ff48d6', colorMode: 'global-gradient', originX: 0.5, originY: 0.5, directionDeg: 0, spreadDeg: 90, speedPxPerSec: 420, lifetimeMs: 1500, count: 32, sizePx: 7, glowIntensity: 1.6, opacityBoost: 1.6, coreBrightness: 1.1, swirl: 0.55, audioInfluence: 1, baselineOpacity: 0.12 };
    case 'particle-trail': return { id, kind, regionId, color: '#35eaff', colorMode: 'global-gradient', samples: 72, trailMs: 2400, sizePx: 8, amplitude: 0.42, glowIntensity: 1.3, opacityBoost: 1.5, lengthScale: 1.2 };
    case 'ripple': return { id, kind, regionId, color: '#42eaff', colorMode: 'global-gradient', centerX: 0.5, centerY: 0.5, waves: 4, periodMs: 1200, radius: 0.38, amplitude: 0.14, lineWidth: 0.018, glowIntensity: 1.4, opacityBoost: 1.5 };
    case 'shockwave': return { id, kind, regionId, color: '#ff48d6', colorMode: 'global-gradient', centerX: 0.5, centerY: 0.5, maxRadius: 0.48, lifetimeMs: 1200, lineWidth: 0.026, glowIntensity: 1.7, opacityBoost: 1.6 };
    case 'oscilloscope-line': return { id, kind, regionId, color: '#45f3ff', colorMode: 'global-gradient', orientation: 'horizontal', lineWidth: 0.012, sampleCount: 256, amplitudeScale: 0.9, glowIntensity: 1.6 };
    case 'ink-diffusion': return { id, kind, regionId, color: '#8b5cf6', colorMode: 'global-gradient', diffusionSpeed: 0.25, flowStrength: 0.4, turbulence: 0.3, inkDensity: 0.65, cloudScale: 0.5, responseTime: 3 };
    case 'ink-flow': return { id, kind, regionId, color: '#38bdf8', colorMode: 'global-gradient', diffusionSpeed: 0.45, flowStrength: 0.95, turbulence: 0.65, inkDensity: 0.5, cloudScale: 0.65, responseTime: 3 };
    case 'color-mixing': return { id, kind, regionId, color: '#8b5cf6', colorMode: 'global-gradient', diffusionSpeed: 0.25, flowStrength: 0.5, turbulence: 0.55, inkDensity: 0.65, cloudScale: 0.9, responseTime: 4, customPalette: ['#22d3ee', '#8b5cf6', '#ec4899'] };
  }
}

function newEffect(kind: Effect['kind'], regionId: string, index: number): Effect {
  const effect = { ...newEffectDefaults(kind, regionId, index), opacity: 1, visibilityMode: 'always', audioReactive: true } as Effect;
  if (kind === 'particles') {
    effect.visibilityMode = 'triggered';
    effect.audioReactive = true;
  }
  return effect;
}

function bindingFor(effectId: string, source: import('./editor-model').BindingSource) {
  return {
    id: `binding-${effectId}`,
    effectId,
    source,
    strength: source === 'kick.events' ? 1 : 0.9,
    threshold: source === 'kick.events' ? 0 : 0.1,
    attackMs: source === 'kick.events' ? 0 : 60,
    releaseMs: 260,
  };
}

function prepareGeneratedBlueprint(candidate: EditorBlueprint): EditorBlueprint {
  const blueprint = structuredClone(candidate);
  const effectsById = new Map(blueprint.effects.map((effect) => [effect.id, effect]));
  for (const binding of blueprint.bindings) {
    if (effectsById.get(binding.effectId)?.kind !== 'particle-burst' || binding.source !== 'kick.events') continue;
    binding.strength = 1;
    binding.threshold = 0;
  }
  return blueprint;
}

const sourceLabels: Record<import('./editor-model').BindingSource, string> = {
  'bass.envelope': 'Bass', 'kick.events': 'Kick', 'snare.events': 'Snare（推定）',
  'drums.energy': 'Drums', 'vocals.envelope': 'Vocals', 'other.envelope': 'Other', 'music.energy': 'Song',
};

const cloudProjectUIEnabled = false;

const parameterLabels: Record<string, string> = {
  'Amplitude scale': '振幅倍率', Amplitude: '振幅', 'Angular variation': '角度のばらつき', 'Audio influence': '音の影響',
  'Audio speed influence': '音による速度変化', 'Attack ms': 'Attack（ms）', 'Bar length': 'バーの長さ', 'Bar width': 'バーの幅', Bars: '本数',
  'Base scale': '基準サイズ', 'Baseline opacity': '基本の不透明度', 'Beats per revolution': '1回転あたりの拍数', Blur: 'ぼかし', Brightness: '明るさ',
  'Burst rotation degrees': '発射角度', 'Center X': '中心 X', 'Center Y': '中心 Y', 'Cloud scale': '雲の大きさ', 'Core flash': '中心の明るさ',
  'Diffusion speed': '広がる速さ', 'Flow strength': '流れの強さ', 'Glow intensity': '発光の強さ', 'Horizontal spread': '横方向の広がり',
  'Initial angle degrees': '開始角度', 'Ink density': 'インクの濃さ', 'Inner radius': '内側の半径', Jaggedness: '輪郭の粗さ',
  'Layer amplitude decay': '層ごとの振幅低下', 'Layer angle step (0 = auto)': '層ごとの角度差（自動は0）', 'Layer count': '層の数', 'Layer radius step': '層ごとの半径差',
  'Length scale': '長さ', 'Lifetime ms': '表示時間（ミリ秒）', 'Line width': '線の太さ', 'Max scale': '最大サイズ', 'Maximum particle count': '最大粒子数',
  'Maximum radius': '最大半径', 'Move X': '横方向の移動', 'Move Y': '縦方向の移動', Opacity: '不透明度', 'Opacity boost': '不透明度の強さ',
  'Origin X': '発生位置 X', 'Origin Y': '発生位置 Y', 'Particle size': '粒子の大きさ', 'Period ms': '周期（ミリ秒）', Radius: '半径',
  'Release ms': 'Release（ms）', 'Response time seconds': '反応時間（秒）', 'Rise cycle ms': '上昇周期（ミリ秒）', 'Rotation degrees': '回転角度',
  'Sample count': 'サンプル数', Samples: 'サンプル数', 'Segments per bar': 'バー内の区切り数', Smoothing: '滑らかさ', Spacing: '間隔',
  'Spectrum attack ms': 'Attack（ms）', 'Spectrum release ms': 'Release（ms）', 'Speed px/s': '速度（ピクセル／秒）', 'Spike sharpness': 'とがり具合',
  Strength: '反応量', 'Swirl rotations': '渦の回転数', 'Timeline samples': '時間分解能', 'Trail ms': '軌跡の長さ（ミリ秒）', Threshold: 'しきい値',
  Turbulence: 'ゆらぎ', 'Wave points': '波の点数', Waves: '波の数',
};
function parameterLabel(label: string): string { return parameterLabels[label] ?? label; }
function regionDisplayName(name: string): string {
  if (name === 'Stage') return 'ステージ';
  if (name === 'Accent') return 'アクセント';
  return name.replace(/^Region (\d+)$/, '範囲 $1');
}

function sourceIsAvailable(Source: import('./editor-model').BindingSource, timeline: FeatureTimeline, effect?: Effect): boolean {
  if (effect?.kind === 'spectrum-bars' || effect?.kind === 'spectrum-line') return Boolean(timeline.frequencySpectrum);
  if (effect?.kind === 'waveform-line' || effect?.kind === 'waveform-peak-bars' || effect?.kind === 'waveform-ring') {
    if (!timeline.waveformPeaks) return false;
    if (Source === 'kick.events') return Boolean(timeline.kickEvents);
    if (Source === 'snare.events') return Boolean(timeline.snareEvents && timeline.snareEventStrengths);
    return true;
  }
  if (Source === 'bass.envelope' || Source === 'kick.events') return true;
  if (Source === 'snare.events') return Boolean(timeline.snareEvents && timeline.snareEventStrengths);
  if (Source === 'drums.energy') return Boolean(timeline.drumEnergy);
  if (Source === 'vocals.envelope') return Boolean(timeline.vocalsEnvelope);
  if (Source === 'other.envelope') return Boolean(timeline.otherEnvelope);
  return Boolean(timeline.musicEnergy);
}

function regionContains(geometry: RegionGeometry, x: number, y: number): boolean {
  if (geometry.kind === 'rect') return x >= geometry.x && x <= geometry.x + geometry.width && y >= geometry.y && y <= geometry.y + geometry.height;
  let inside = false;
  for (let i = 0, j = geometry.points.length - 1; i < geometry.points.length; j = i, i += 1) {
    const a = geometry.points[i];
    const b = geometry.points[j];
    if (!a || !b) continue;
    const cross = (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x);
    if (Math.abs(cross) < 1e-8 && x >= Math.min(a.x, b.x) && x <= Math.max(a.x, b.x) && y >= Math.min(a.y, b.y) && y <= Math.max(a.y, b.y)) return true;
    const intersects = ((a.y > y) !== (b.y > y)) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y || Number.EPSILON) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function bounds(geometry: RegionGeometry): { x: number; y: number; width: number; height: number } {
  if (geometry.kind === 'rect') return geometry;
  const xs = geometry.points.map((point) => point.x);
  const ys = geometry.points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function titleFor(kind: Effect['kind']): string {
  return ({ 'pulse-scale': '脈動・拡大縮小', 'glow-brightness': '発光・明るさ', 'rotation-movement': '回転・移動', particles: '粒子', 'waveform-bars': '波形バー（音量）', 'waveform-line': '波形ライン（ピーク）', 'waveform-peak-bars': '波形バー（ピーク）', 'waveform-ring': '波形リング（ピーク）', 'spectrum-bars': '周波数バー', 'spectrum-line': '周波数ライン', 'radial-bars': '放射状バー', 'wave-ring': '波形リング', 'particle-burst': '粒子バースト', 'particle-trail': '粒子の軌跡', ripple: '波紋', shockwave: '衝撃波', 'oscilloscope-line': 'オシロスコープ線', 'ink-diffusion': 'インク拡散', 'ink-flow': 'インクの流れ', 'color-mixing': '色の混合' })[kind];
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('背景画像を読み込めません。'));
    image.src = src;
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function VisualEditor({ timeline: initialTimeline = demoTimeline, variant = 'local' }: { timeline?: FeatureTimeline; variant?: 'local' | 'app' | 'demo' }) {
  const isDemo = variant === 'demo';
  const startingBlueprint = newEditorBlueprint;
  const [blueprint, setBlueprint] = useState<EditorBlueprint>(() => structuredClone(startingBlueprint));
  const [timeline, setTimeline] = useState<FeatureTimeline>(() => structuredClone(initialTimeline));
  const [selectedDemoId, setSelectedDemoId] = useState('demo1');
  const [demoTimelineReady, setDemoTimelineReady] = useState(false);
  const [demoAudioDurationMs, setDemoAudioDurationMs] = useState<number | null>(null);
  const [demoStatus, setDemoStatus] = useState('');
  const [timeMs, setTimeMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [tool, setTool] = useState<Tool>('select');
  const [regionEditMode, setRegionEditMode] = useState(false);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(startingBlueprint.regions[0]?.id ?? null);
  const [selectedEffectId, setSelectedEffectId] = useState<string | null>(startingBlueprint.effects[0]?.id ?? null);
  const effectPositionDrag= useRef<{ effectId: string; pointerId: number } | null>(null);
  const regionEditDrag= useRef<RegionEditDrag| null>(null);
  const [editCategory, setEditCategory] = useState<EffectCategory>(effectCategoryFor(startingBlueprint.effects[0]!.kind));
  const [editTypeChoice, setEditTypeChoice] = useState<Effect['kind'] | ''>(startingBlueprint.effects[0]!.kind);
  const [addCategory, setAddCategory] = useState<EffectCategory>('Core / Transform');
  const [polygonDraft, setPolygonDraft] = useState<Array<{ x: number; y: number }>>([]);
  const [rectDraft, setRectDraft] = useState<{ start: { x: number; y: number }; end: { x: number; y: number } } | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageError, setImageError] = useState('');
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [playbackAudioUrl, setPlaybackAudioUrl] = useState('');
  const [SourceAudioFile, setSourceAudioFile] = useState<File | null>(null);
  const [SourceAudioUrl, setSourceAudioUrl] = useState('');
  const [SourceDuration, setSourceDuration] = useState(0);
  const [sourceWaveform, setSourceWaveform] = useState<Float32Array | null>(null);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(0);
  const [rangeSelectionOpen, setRangeSelectionOpen] = useState(false);
  const [audioAnalysisBusy, setAudioAnalysisBusy] = useState(false);
  const [kickGateMode, setKickGateMode] = useState<KickGateMode>('middle');
  const [audioAnalysisStatus, setAudioAnalysisStatus] = useState('');
  const [musicSummary, setMusicSummary] = useState<MusicSummary | null>(null);
  const [audioError, setAudioError] = useState('');
  const [exportWithAudio, setExportWithAudio] = useState(false);
  const [exportFormat, setExportFormat] = useState<VideoFormat>('webm');
  const [exportFPS, setExportFPS] = useState<ExportFPS>(30);
  const [exportScale, setExportScale] = useState<ExportScale>(1);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStatus, setExportStatus] = useState('');
  const [projectStatus, setProjectStatus] = useState('');
  const [apiStatus, setApiStatus] = useState('');
  const [apiLoading, setApiLoading] = useState(false);
  const [authSession, setAuthSession] = useState<AuthSession | null>(() => readSession());
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [cloudStatus, setCloudStatus] = useState('');
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudProjects, setCloudProjects] = useState<CloudProject[]>([]);
  const [activeCloudProject, setActiveCloudProject] = useState<CloudProject | null>(null);
  const [cloudTitle, setCloudTitle] = useState('新しいプロジェクト');
  const [regionError, setRegionError] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const dragEnd = useRef<{ x: number; y: number } | null>(null);
  const idSequence = useRef(100);
  const exportController = useRef<AbortController | null>(null);
  const audioAnalysisController = useRef<AbortController | null>(null);
  const audioJobRestoreController = useRef<AbortController | null>(null);
  const audioDecodeSequence = useRef(0);
  const demoAudioRef = useRef<HTMLAudioElement>(null);
  const playbackAudioRef = useRef<HTMLAudioElement>(null);
  const selectedDemoTrack = demoTracks.find((track) => track.id === selectedDemoId) ?? demoTracks[0]!;
  const background = blueprint.background;
  const imageSource = background.kind === 'image' ? background.src : null;
  const assets = useMemo<RenderAssets>(() => image && imageSource ? { [imageSource]: image } : {}, [imageSource, image]);
  const selectedRegion = blueprint.regions.find((region) => region.id === selectedRegionId);
  const selectedEffect = blueprint.effects.find((effect) => effect.id === selectedEffectId);
  const selectedBinding = blueprint.bindings.find((binding) => binding.effectId === selectedEffectId);
  const selectedEffectPosition = selectedEffect ? effectPosition(selectedEffect) : null;
  const position = selectedEffect ? blueprint.regions.find((region) => region.id === selectedEffect.regionId) : undefined;
  const positionBounds = position ? bounds(position.geometry) : null;
  const percent = (value: number) => `${Math.round(value * 100_000) / 1_000}%`;
  const positionHandleStyle = selectedEffectPosition && positionBounds ? {
    left: percent(positionBounds.x + selectedEffectPosition.x * positionBounds.width),
    top: percent(positionBounds.y + selectedEffectPosition.y * positionBounds.height),
  } : undefined;

  useEffect(() => {
    if (!selectedEffect) return;
    const category = effectCategoryFor(selectedEffect.kind);
    setEditCategory(category);
    setEditTypeChoice(selectedEffect.kind);
  }, [selectedEffectId, selectedEffect?.kind]);

  useEffect(() => {
    if (!SourceAudioUrl) return undefined;
    return () => URL.revokeObjectURL(SourceAudioUrl);
  }, [SourceAudioUrl]);

  useEffect(() => {
    if (!audioFile) { setPlaybackAudioUrl(''); return undefined; }
    const url = URL.createObjectURL(audioFile);
    setPlaybackAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [audioFile]);

  useEffect(() => {
    if (isDemo) { setAuthSession(null); return undefined; }
    let mounted = true;
    void validSession().then((session) => { if (mounted) setAuthSession(session); });
    const unsubscribe = subscribeAuth(() => { if (mounted) setAuthSession(readSession()); });
    return () => { mounted = false; unsubscribe(); };
  }, [isDemo]);

  useEffect(() => {
    if (variant !== 'app' || !authSession || !hasSavedAudioAnalysisJob()) return undefined;
    const controller = new AbortController();
    const sequence = audioDecodeSequence.current;
    audioJobRestoreController.current?.abort();
    audioJobRestoreController.current = controller;
    setAudioAnalysisBusy(true);
    setAudioAnalysisStatus('保存された解析ジョブを復元しています…');
    void restoreAudioAnalysisJob(authSession.accessToken, controller.signal, (job: AudioJobStatus) => {
      if (job.state === 'queued') setAudioAnalysisStatus(job.queuePosition ? `解析待ち：前に${Math.max(0, job.queuePosition - 1)}件あります。` : '解析待ちです。');
      else if (job.state === 'running') setAudioAnalysisStatus('SCNetで音源を解析しています…');
    }).then((result) => {
      if (!result || controller.signal.aborted || sequence !== audioDecodeSequence.current) return;
      setTimeline(result.featureTimeline);
      setMusicSummary(result.musicSummary);
      setAudioAnalysisStatus('前回の解析結果を復元しました。再生する場合は音源を選び直してください。');
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && sequence === audioDecodeSequence.current) setAudioAnalysisStatus(error instanceof Error ? error.message : '解析ジョブを復元できませんでした。');
    }).finally(() => {
      if (audioJobRestoreController.current === controller) audioJobRestoreController.current = null;
      if (!controller.signal.aborted && sequence === audioDecodeSequence.current) setAudioAnalysisBusy(false);
    });
    return () => controller.abort();
  }, [authSession, variant]);

  useEffect(() => {
    if (!isDemo) return undefined;
    let cancelled = false;
    setPlaying(false);
    if (demoAudioRef.current) { demoAudioRef.current.pause(); demoAudioRef.current.currentTime = 0; }
    setTimeMs(0);
    setBlueprint(structuredClone(newEditorBlueprint));
    setSelectedRegionId(newEditorBlueprint.regions[0]?.id ?? null);
    setSelectedEffectId(newEditorBlueprint.effects[0]?.id ?? null);
    setTimeline({ durationMs: 1, bassEnvelope: [{ timeMs: 0, value: 0 }], kickEvents: [] });
    setDemoTimelineReady(false);
    setDemoAudioDurationMs(null);
    setDemoStatus(`${selectedDemoTrack.title}を読み込んでいます…`);
    void loadDemoTimeline(selectedDemoTrack).then((next) => {
      if (!cancelled) { setTimeline(next); setDemoTimelineReady(true); }
    }).catch((error: unknown) => {
      if (!cancelled) setDemoStatus(error instanceof Error ? error.message : 'デモの解析結果を読み込めません。');
    });
    return () => { cancelled = true; };
  }, [isDemo, selectedDemoId, selectedDemoTrack]);

  useEffect(() => {
    if (!isDemo || !demoTimelineReady || demoAudioDurationMs === null) return;
    if (Math.abs(demoAudioDurationMs - timeline.durationMs) > 100) {
      setDemoStatus(`音源とタイムラインの長さが一致しません (${(demoAudioDurationMs / 1000).toFixed(3)}s / ${(timeline.durationMs / 1000).toFixed(3)}s)。`);
      return;
    }
    setDemoStatus('ready');
  }, [isDemo, demoTimelineReady, demoAudioDurationMs, timeline.durationMs]);

  async function currentSession(): Promise<AuthSession> {
    const current = await validSession();
    setAuthSession(current);
    if (!current) throw new Error('ログインが必要です。セッションが切れた場合は再度ログインしてください。');
    return current;
  }

  async function login() {
    setAuthBusy(true); setCloudStatus('ログインしています…');
    try {
      const session = await signIn(authEmail.trim(), authPassword);
      setAuthSession(session); setAuthPassword(''); setCloudStatus('ログインしました。');
    } catch (error) { setCloudStatus(error instanceof Error ? error.message : 'ログインできませんでした。'); }
    finally { setAuthBusy(false); }
  }

  async function refreshCloudProjects(session = authSession) {
    if (!session) return;
    try { setCloudProjects(await listProjects(session)); }
    catch (error) { setCloudStatus(error instanceof Error ? error.message : 'プロジェクト一覧を読み込めません。'); }
  }

  async function loadCloudProject(id: string) {
    if (cloudBusy) return;
    setCloudBusy(true);
    setCloudStatus('クラウドプロジェクトと素材を読み込んでいます…');
    try {
      const session = await currentSession();
      const rawProject = await getProject(session, id);
      const project: CloudEnvelopeProject = 'cloudDocumentVersion' in rawProject.document
        ? rawProject as CloudEnvelopeProject
        : { ...rawProject, document: envelopeFromProjectDocumentV1(rawProject.document) };
      const hydrated = await hydrateCloudEnvelopeV1(project.document, (assetId) => loadAsset(session, project.id, assetId));
      validateBlueprint(hydrated.blueprint);
      const restoredImage = hydrated.blueprint.background.kind === 'image' ? await loadImage(hydrated.blueprint.background.src) : null;
      audioAnalysisController.current?.abort(); audioAnalysisController.current = null;
      setAudioAnalysisBusy(false); setPlaying(false); setTimeMs(0); setBlueprint(hydrated.blueprint); setTimeline(hydrated.featureTimeline);
      setAudioFile(hydrated.audioFile); setExportWithAudio(Boolean(hydrated.audioFile)); setImage(restoredImage);
      setMusicSummary(null); setSourceAudioFile(null); setSourceAudioUrl(''); setRangeSelectionOpen(false);
      setSelectedRegionId(hydrated.blueprint.regions[0]?.id ?? null); setSelectedEffectId(hydrated.blueprint.effects[0]?.id ?? null);
      setActiveCloudProject(project); setCloudTitle(project.title); setCloudStatus('クラウドプロジェクトと素材を復元しました。');
    } catch (error) { setCloudStatus(error instanceof Error ? error.message : 'クラウドプロジェクトを読み込めませんでした。現在の編集状態は維持しています。'); }
    finally { setCloudBusy(false); }
  }

  async function saveCloudProject() {
    if (cloudBusy) return;
    setCloudBusy(true);
    setCloudStatus('クラウドプロジェクトを保存しています…');
    try {
      const session = await currentSession();
      const currentBackground = blueprint.background.kind === 'image' ? imageFileFromDataURL(blueprint.background.src) : null;
      const desired = [
        ...(currentBackground ? [{ kind: 'background_image' as const, file: currentBackground }] : []),
        ...(audioFile ? [{ kind: 'source_audio' as const, file: audioFile }] : []),
      ];
      const desiredHashes = new Map<string, string>();
      for (const item of desired) {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await item.file.arrayBuffer()));
        desiredHashes.set(item.kind, [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''));
      }
      let project: CloudEnvelopeProject | null = activeCloudProject
        ? ('cloudDocumentVersion' in activeCloudProject.document
          ? activeCloudProject as CloudEnvelopeProject
          : { ...activeCloudProject, document: envelopeFromProjectDocumentV1(activeCloudProject.document) })
        : null;
      let assets = project ? await listAssets(session, project.id) : [];
      let backgroundAssetId = project?.document.editorState.backgroundAssetId ?? null;
      let audioAssetId = project?.document.assetRefs.audioAssetId ?? null;
      const initialBlueprint = structuredClone(blueprint);
      if (currentBackground) initialBlueprint.background = { kind: 'solid', color: '#000000' };
      const emptyEnvelope = toCloudEnvelopeV1(initialBlueprint, timeline, { ...blueprintMetadata(), seed: blueprint.seed });
      if (!project) {
        project = await createProject(session, cloudTitle.trim() || 'Untitled project', emptyEnvelope);
        setActiveCloudProject(project); setCloudTitle(project.title);
      }

      const desiredKinds = new Set(desired.map((item) => item.kind));
      const refFor = (kind: 'background_image' | 'source_audio') => kind === 'background_image' ? backgroundAssetId : audioAssetId;
      const replaceKinds = desired.filter(({ kind }) => {
        const current = assets.find((asset) => asset.id === refFor(kind));
        return Boolean(current && current.sha256 !== desiredHashes.get(kind));
      }).map((item) => item.kind);
      const removedKinds = (['background_image', 'source_audio'] as const).filter((kind) => refFor(kind) && !desiredKinds.has(kind));
      const replacementIDs = [...replaceKinds, ...removedKinds].map((kind) => ({ kind, id: refFor(kind) })).filter((item): item is { kind: 'background_image' | 'source_audio'; id: string } => Boolean(item.id));
      if (replacementIDs.length) {
        const clearBackground = replacementIDs.some((item) => item.kind === 'background_image');
        const clearAudio = replacementIDs.some((item) => item.kind === 'source_audio');
        const interimBlueprint = structuredClone(blueprint);
        const interimBackgroundRef = clearBackground ? null : backgroundAssetId;
        const interimAudioRef = clearAudio ? null : audioAssetId;
        if (interimBlueprint.background.kind === 'image' && !interimBackgroundRef) interimBlueprint.background = { kind: 'solid', color: '#000000' };
        const interim = toCloudEnvelopeV1(interimBlueprint, timeline, blueprintMetadata(), { backgroundAssetId: interimBackgroundRef, audioAssetId: interimAudioRef });
        project = await updateProject(session, project, cloudTitle.trim() || project.title, interim);
        setActiveCloudProject(project);
        backgroundAssetId = interimBackgroundRef; audioAssetId = interimAudioRef;
        for (const item of replacementIDs) await deleteAsset(session, project.id, item.id);
        assets = await listAssets(session, project.id);
      }

      for (const item of desired) {
        const existingID = refFor(item.kind);
        const existing = assets.find((asset) => asset.id === existingID);
        let id = existing && existing.sha256 === desiredHashes.get(item.kind) ? existing.id : null;
        if (!id) {
          if (existing) { await deleteAsset(session, project.id, existing.id); assets = assets.filter((asset) => asset.id !== existing.id); }
          const uploaded = await uploadAsset(session, project.id, item.file, item.kind);
          id = uploaded.id; assets.push(uploaded);
        }
        if (item.kind === 'background_image') backgroundAssetId = id; else audioAssetId = id;
      }
      if (!currentBackground) backgroundAssetId = null;
      if (!audioFile) audioAssetId = null;
      const document = toCloudEnvelopeV1(blueprint, timeline, blueprintMetadata(), { backgroundAssetId, audioAssetId });
      project = await updateProject(session, project, cloudTitle.trim() || project.title, document);
      setActiveCloudProject(project); setCloudTitle(project.title); setCloudStatus(`「${project.title}」を保存しました（更新番号 ${project.revision}）。`);
      await refreshCloudProjects(session);
    } catch (error) { setCloudStatus(error instanceof Error ? error.message : 'クラウドへの保存に失敗しました。時間をおいて再度お試しください。'); }
    finally { setCloudBusy(false); }
  }

  function blueprintMetadata() {
    return { blueprintSchemaVersion: 1 as const, featureTimelineSchemaVersion: 1 as const, rendererVersion: 'editor-renderer/1' as const, analysisVersion: 'feature-timeline/1', seed: blueprint.seed };
  }

  async function removeCloudProject() {
    if (!activeCloudProject || cloudBusy) return;
    setCloudBusy(true);
    setCloudStatus('クラウドプロジェクトを削除しています…');
    try { const session = await currentSession(); await deleteProject(session, activeCloudProject.id); setActiveCloudProject(null); setCloudProjects((items) => items.filter((item) => item.id !== activeCloudProject.id)); setCloudStatus('クラウドプロジェクトと関連素材を削除しました。'); }
    catch (error) { setCloudStatus(error instanceof Error ? error.message : '削除できませんでした。'); }
    finally { setCloudBusy(false); }
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    renderEditorFrame(context, blueprint, timeline, timeMs, assets);
    for (const region of blueprint.regions) {
      context.save();
      context.beginPath();
      if (region.geometry.kind === 'rect') context.rect(region.geometry.x * blueprint.width, region.geometry.y * blueprint.height, region.geometry.width * blueprint.width, region.geometry.height * blueprint.height);
      else region.geometry.points.forEach((point, index) => index === 0 ? context.moveTo(point.x * blueprint.width, point.y * blueprint.height) : context.lineTo(point.x * blueprint.width, point.y * blueprint.height));
      if (region.geometry.kind === 'polygon') context.closePath();
      context.strokeStyle = region.id === selectedRegionId ? '#d0c7ff' : 'rgba(211, 215, 255, .48)';
      context.lineWidth = region.id === selectedRegionId ? 2 : 1;
      context.setLineDash(region.id === selectedRegionId ? [6, 4] : [3, 5]);
      context.stroke();
      context.restore();
    }
    if (rectDraft) {
      const x = Math.min(rectDraft.start.x, rectDraft.end.x) * blueprint.width;
      const y = Math.min(rectDraft.start.y, rectDraft.end.y) * blueprint.height;
      const width = Math.abs(rectDraft.start.x - rectDraft.end.x) * blueprint.width;
      const height = Math.abs(rectDraft.start.y - rectDraft.end.y) * blueprint.height;
      context.save();
      context.strokeStyle = '#d0c7ff';
      context.setLineDash([6, 4]);
      context.strokeRect(x, y, width, height);
      context.restore();
    }
    if (polygonDraft.length > 0) {
      context.save();
      context.beginPath();
      polygonDraft.forEach((point, index) => index === 0 ? context.moveTo(point.x * blueprint.width, point.y * blueprint.height) : context.lineTo(point.x * blueprint.width, point.y * blueprint.height));
      context.strokeStyle = '#d0c7ff';
      context.setLineDash([6, 4]);
      context.stroke();
      context.restore();
    }
  }, [blueprint, timeline, timeMs, assets, selectedRegionId, rectDraft, polygonDraft]);

  useEffect(() => {
    if (!imageSource) { setImage(null); return; }
    const next = new Image();
    next.onload = () => setImage(next);
    next.onerror = () => setImageError('画像を読み込めませんでした。PNG/JPEGを選び直してください。');
    next.src = imageSource;
  }, [imageSource]);

  useEffect(() => {
    if (!playing) return undefined;
    if (isDemo || (variant === 'app' && playbackAudioUrl)) {
      const timer = window.setInterval(() => {
        const audio = isDemo ? demoAudioRef.current : playbackAudioRef.current;
        if (!audio) return;
        const next = Math.min(timeline.durationMs, audio.currentTime * 1000);
        setTimeMs(next);
        if (audio.ended || next >= timeline.durationMs) {
          audio.pause(); setPlaying(false);
        }
      }, 30);
      return () => window.clearInterval(timer);
    }
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const next = Math.min(timeline.durationMs, timeMs + (now - last));
      last = now;
      setTimeMs(next);
      if (next >= timeline.durationMs) setPlaying(false);
    }, 33);
    return () => window.clearInterval(timer);
  }, [isDemo, variant, playbackAudioUrl, playing, timeline.durationMs, timeMs]);

  function setPreviewPlaying(next: boolean) {
    if (!isDemo && variant === 'app') {
      const audio = playbackAudioRef.current;
      if (!audioFile || !audio) { setPlaying(false); return; }
      if (!next) { audio.pause(); setPlaying(false); return; }
      audio.currentTime = Math.min(timeMs, timeline.durationMs) / 1000;
      void audio.play().then(() => setPlaying(true)).catch(() => {
        setPlaying(false); setApiStatus('選択した音源を再生できませんでした。ブラウザの音声設定を確認してください。');
      });
      return;
    }
    if (isDemo) {
      if (demoStatus !== 'ready') return;
      const audio = demoAudioRef.current;
      if (!audio) return;
      if (!next) { audio.pause(); setPlaying(false); return; }
      if (audio.ended || timeMs >= timeline.durationMs) {
        audio.currentTime = 0;
        setTimeMs(0);
      }
      void audio.play().then(() => setPlaying(true)).catch(() => {
        setPlaying(false); setApiStatus('デモ音源を再生できませんでした。ブラウザの音声設定を確認してください。');
      });
      return;
    }
    setPlaying(next);
  }

  function stopPreview() {
    if (isDemo && demoAudioRef.current) { demoAudioRef.current.pause(); demoAudioRef.current.currentTime = 0; }
    if (variant === 'app' && playbackAudioRef.current) { playbackAudioRef.current.pause(); playbackAudioRef.current.currentTime = 0; }
    setPlaying(false); setTimeMs(0);
  }

  function seekPreview(value: number) {
    const nextTimeMs = Math.max(0, Math.min(value, timeline.durationMs));
    if (isDemo) {
      setTimeMs(nextTimeMs);
      if (demoAudioRef.current) demoAudioRef.current.currentTime = nextTimeMs / 1000;
      return;
    }
    setPlaying(false);
    if (variant === 'app' && playbackAudioRef.current) { playbackAudioRef.current.pause(); playbackAudioRef.current.currentTime = nextTimeMs / 1000; }
    setTimeMs(nextTimeMs);
  }

  function updateBlueprint(update: (draft: EditorBlueprint) => void) {
    setBlueprint((current) => {
      const draft = structuredClone(current);
      update(draft);
      validateBlueprint(draft);
      return draft;
    });
  }

  function updateBackground(next: Background) { updateBlueprint((draft) => { draft.background = next; }); }

  function normalizedPoint(event: PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = rect.width || event.currentTarget.width;
    const height = rect.height || event.currentTarget.height;
    const round = (value: number) => Math.round(clamp01(value) * 1_000_000) / 1_000_000;
    return { x: round((event.clientX - rect.left) / width), y: round((event.clientY - rect.top) / height) };
  }

  function normalizedClientPoint(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || canvas.width;
    const height = rect.height || canvas.height;
    if (width <= 0 || height <= 0) return null;
    const round = (value: number) => Math.round(clamp01(value) * 1_000_000) / 1_000_000;
    return { x: round((clientX - rect.left) / width), y: round((clientY - rect.top) / height) };
  }

  function beginRegionEditPointer(event: PointerEvent<HTMLButtonElement>, mode: RegionEditMode, edge?: RegionResizeEdge, pointIndex?: number) {
    event.preventDefault();
    event.stopPropagation();
    if (!regionEditMode || tool !== 'select' || !selectedRegion) return;
    const startPoint = normalizedClientPoint(event.clientX, event.clientY);
    const canvas = canvasRef.current;
    if (!startPoint || !canvas) return;
    try {
      canvas.setPointerCapture(event.pointerId);
      regionEditDrag.current = {
        regionId: selectedRegion.id,
        pointerId: event.pointerId,
        mode,
        ...(edge ? { edge } : {}),
        ...(pointIndex === undefined ? {} : { pointIndex }),
        startPoint,
        startGeometry: structuredClone(selectedRegion.geometry),
      };
    } catch {
      regionEditDrag.current = null;
    }
  }

  function setRegionGeometryById(regionId: string, geometry: RegionGeometry) {
    const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
    const nextGeometry: RegionGeometry = geometry.kind === 'rect'
      ? { ...geometry, x: round(geometry.x), y: round(geometry.y), width: round(geometry.width), height: round(geometry.height) }
      : { ...geometry, points: geometry.points.map((point) => ({ x: round(point.x), y: round(point.y) })) };
    if (nextGeometry.kind === 'rect') {
      if (![nextGeometry.x, nextGeometry.y, nextGeometry.width, nextGeometry.height].every(Number.isFinite) || nextGeometry.width < 0.01 || nextGeometry.height < 0.01 || nextGeometry.x < 0 || nextGeometry.y < 0 || nextGeometry.x + nextGeometry.width > 1 || nextGeometry.y + nextGeometry.height > 1) return;
    } else {
      if (nextGeometry.points.length < 3 || nextGeometry.points.length > 64 || !nextGeometry.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)) return;
      const area = nextGeometry.points.reduce((sum, point, index, points) => {
        const next = points[(index + 1) % points.length];
        return sum + (next ? point.x * next.y - next.x * point.y : 0);
      }, 0);
      if (Math.abs(area) < 1e-8) return;
    }
    updateBlueprint((draft) => {
      const region = draft.regions.find((item) => item.id === regionId);
      if (region) region.geometry = nextGeometry;
    });
  }

  function updateRegionFromPointer(event: PointerEvent<HTMLCanvasElement>, drag: RegionEditDrag) {
    const pointer = normalizedClientPoint(event.clientX, event.clientY);
    if (!pointer) return;
    const dx = pointer.x - drag.startPoint.x;
    const dy = pointer.y - drag.startPoint.y;
    if (drag.mode === 'move-polygon-point' && drag.startGeometry.kind === 'polygon' && drag.pointIndex !== undefined) {
      const points = drag.startGeometry.points.map((point, index) => index === drag.pointIndex ? { x: pointer.x, y: pointer.y } : point);
      setRegionGeometryById(drag.regionId, { kind: 'polygon', points });
      return;
    }
    if (drag.startGeometry.kind !== 'rect') return;
    const start = drag.startGeometry;
    if (drag.mode === 'move-rect') {
      const x = Math.min(1 - start.width, Math.max(0, start.x + dx));
      const y = Math.min(1 - start.height, Math.max(0, start.y + dy));
      setRegionGeometryById(drag.regionId, { ...start, x, y });
      return;
    }
    const edge = drag.edge;
    if (!edge) return;
    const minSize = 0.01;
    let left = start.x;
    let right = start.x + start.width;
    let top = start.y;
    let bottom = start.y + start.height;
    if (edge.includes('w')) left = Math.max(0, Math.min(right - minSize, left + dx));
    if (edge.includes('e')) right = Math.min(1, Math.max(left + minSize, right + dx));
    if (edge.includes('n')) top = Math.max(0, Math.min(bottom - minSize, top + dy));
    if (edge.includes('s')) bottom = Math.min(1, Math.max(top + minSize, bottom + dy));
    setRegionGeometryById(drag.regionId, { kind: 'rect', x: left, y: top, width: right - left, height: bottom - top });
  }

  function finishRegionEditPointer(event: PointerEvent<HTMLCanvasElement>) {
    const drag = regionEditDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return false;
    event.preventDefault();
    regionEditDrag.current = null;
    const canvas = canvasRef.current;
    try {
      if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    } catch {
      // The browser may already have released pointer capture.
    }
    return true;
  }

  function setEffectPositionFromPointer(effectId: string, clientX: number, clientY: number) {
    const effect = blueprint.effects.find((item) => item.id === effectId);
    const position = effect ? effectPosition(effect) : null;
    const region = effect ? blueprint.regions.find((item) => item.id === effect.regionId) : undefined;
    const regionBounds = region ? bounds(region.geometry) : null;
    if (!effect || !position || !regionBounds || regionBounds.width <= 0 || regionBounds.height <= 0) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const stageX = clamp01((clientX - rect.left) / rect.width);
    const stageY = clamp01((clientY - rect.top) / rect.height);
    const x = Math.round(clamp01((stageX - regionBounds.x) / regionBounds.width) * 1_000_000) / 1_000_000;
    const y = Math.round(clamp01((stageY - regionBounds.y) / regionBounds.height) * 1_000_000) / 1_000_000;
    updateBlueprint((draft) => {
      const target = draft.effects.find((item) => item.id === effectId);
      const targetPosition = target ? effectPosition(target) : null;
      if (!target || !targetPosition) return;
      const values = target as unknown as Record<string, unknown>;
      values[targetPosition.xKey] = x;
      values[targetPosition.yKey] = y;
    });
  }

  function onEffectPositionPointerDown(event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedEffectPosition || tool !== 'select' || !selectedEffect) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      canvas.setPointerCapture(event.pointerId);
      effectPositionDrag.current = { effectId: selectedEffect.id, pointerId: event.pointerId };
    } catch {
      effectPositionDrag.current = null;
    }
  }

  function finishEffectPositionPointer(event: PointerEvent<HTMLCanvasElement>) {
    const drag = effectPositionDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return false;
    event.preventDefault();
    const canvas = canvasRef.current;
    effectPositionDrag.current = null;
    try {
      if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    } catch {
      // The browser may have already released capture while dispatching pointerup/cancel.
    }
    return true;
  }

  function onPointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (regionEditMode) return;
    if (tool === 'rect') {
      const start = normalizedPoint(event);
      dragStart.current = start;
      setRectDraft({ start, end: start });
      event.currentTarget.setPointerCapture(event.pointerId);
    } else if (tool === 'polygon') {
      const point = normalizedPoint(event);
      setPolygonDraft((points) => [...points, point]);
    } else {
      const point = normalizedPoint(event);
      const region = [...blueprint.regions].reverse().find((item) => regionContains(item.geometry, point.x, point.y));
      setSelectedRegionId(region?.id ?? null);
    }
  }

  function onPointerMove(event: PointerEvent<HTMLCanvasElement>) {
    const drag = effectPositionDrag.current;
    if (drag && drag.pointerId === event.pointerId) {
      event.preventDefault();
      setEffectPositionFromPointer(drag.effectId, event.clientX, event.clientY);
      return;
    }
    const regionDrag= regionEditDrag.current;
    if (regionDrag&& regionDrag.pointerId === event.pointerId) {
      event.preventDefault();
      updateRegionFromPointer(event, regionDrag);
      return;
    }
    if (!dragStart.current || tool !== 'rect') return;
    setRectDraft({ start: dragStart.current, end: normalizedPoint(event) });
  }

  function onPointerUp(event: PointerEvent<HTMLCanvasElement>) {
    if (finishEffectPositionPointer(event)) return;
    if (finishRegionEditPointer(event)) return;
    if (!dragStart.current) return;
    dragEnd.current = normalizedPoint(event);
    const start = dragStart.current;
    const end = dragEnd.current;
    dragStart.current = null;
    dragEnd.current = null;
    setRectDraft(null);
    if (!start || !end) return;
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const width = Math.round(Math.abs(start.x - end.x) * 1_000_000) / 1_000_000;
    const height = Math.round(Math.abs(start.y - end.y) * 1_000_000) / 1_000_000;
    if (width < 0.01 || height < 0.01) return;
    const id = `region-${idSequence.current++}`;
    const region: Region = { id, name: `Region ${blueprint.regions.length + 1}`, geometry: { kind: 'rect', x, y, width, height } };
    updateBlueprint((draft) => { draft.regions.push(region); });
    setSelectedRegionId(id);
    setRegionEditMode(false);
    setTool('select');
  }

  function onPointerCancel(event: PointerEvent<HTMLCanvasElement>) {
    if (finishEffectPositionPointer(event)) return;
    if (finishRegionEditPointer(event)) return;
    dragStart.current = null;
    dragEnd.current = null;
    setRectDraft(null);
  }

  function onLostPointerCapture(event: PointerEvent<HTMLCanvasElement>) {
    if (effectPositionDrag.current?.pointerId === event.pointerId) effectPositionDrag.current = null;
    if (regionEditDrag.current?.pointerId === event.pointerId) regionEditDrag.current = null;
  }

  function createPolygon() {
    if (polygonDraft.length < 3) return;
    const area = polygonDraft.reduce((sum, point, index) => {
      const next = polygonDraft[(index + 1) % polygonDraft.length];
      return sum + (next ? point.x * next.y - next.x * point.y : 0);
    }, 0);
    if (Math.abs(area) < 1e-8) { setRegionError('多角形は面積ができるよう、3点以上で描いてください。'); return; }
    const id = `region-${idSequence.current++}`;
    const region: Region = { id, name: `Region ${blueprint.regions.length + 1}`, geometry: { kind: 'polygon', points: polygonDraft } };
    updateBlueprint((draft) => { draft.regions.push(region); });
    setSelectedRegionId(id);
    setRegionEditMode(false);
    setPolygonDraft([]);
    setTool('select');
    setRegionError('');
  }

  function deleteRegion() {
    if (!selectedRegionId) return;
    const affectedEffects = blueprint.effects.filter((effect) => effect.regionId === selectedRegionId);
    updateBlueprint((draft) => {
      draft.regions = draft.regions.filter((region) => region.id !== selectedRegionId);
      draft.effects = draft.effects.filter((effect) => effect.regionId !== selectedRegionId);
      draft.bindings = draft.bindings.filter((binding) => !affectedEffects.some((effect) => effect.id === binding.effectId));
    });
    setSelectedRegionId(null);
    setRegionEditMode(false);
    if (affectedEffects.some((effect) => effect.id === selectedEffectId)) setSelectedEffectId(null);
  }

  function updateRegionGeometry(next: RegionGeometry) {
    if (!selectedRegion) return;
    const normalized = next.kind === 'rect'
      ? { ...next, x: Math.min(0.99, clamp01(next.x)), y: Math.min(0.99, clamp01(next.y)), width: Math.max(0.01, Math.min(next.width, 1 - Math.min(0.99, clamp01(next.x)))), height: Math.max(0.01, Math.min(next.height, 1 - Math.min(0.99, clamp01(next.y)))) }
      : { ...next, points: next.points.map((point) => ({ x: clamp01(point.x), y: clamp01(point.y) })) };
    updateBlueprint((draft) => {
      const region = draft.regions.find((item) => item.id === selectedRegionId);
      if (region) region.geometry = normalized;
    });
  }

  function addEffect(kind: Effect['kind']) {
    const regionId = selectedRegionId ?? blueprint.regions[0]?.id;
    if (!regionId) return;
    const effect = newEffect(kind, regionId, idSequence.current++);
    updateBlueprint((draft) => {
      draft.effects.push(effect);
      draft.bindings.push(bindingFor(effect.id, ['ink-diffusion', 'ink-flow', 'color-mixing'].includes(kind) ? 'music.energy' : kind === 'particle-burst' || kind === 'shockwave' ? 'kick.events' : 'bass.envelope'));
    });
    setSelectedEffectId(effect.id);
  }

  function changeSelectedEffectType(kind: Effect['kind']) {
    if (!selectedEffect) return;
    if (selectedEffect.kind === kind) return;
    const effectIndex = blueprint.effects.findIndex((effect) => effect.id === selectedEffect.id);
    const replacement = newEffect(kind, selectedEffect.regionId, effectIndex);
    replacement.id = selectedEffect.id;
    replacement.color = selectedEffect.color;
    replacement.colorMode = selectedEffect.colorMode;
    replacement.opacity = selectedEffect.opacity ?? 1;
    replacement.visibilityMode = kind === 'particles' ? 'triggered' : selectedEffect.visibilityMode;
    replacement.audioReactive = kind === 'particles' ? true : selectedEffect.audioReactive;
    updateBlueprint((draft) => {
      draft.effects[effectIndex] = replacement;
    });
  }

  function updateGlobalGradient(key: keyof GlobalGradient, value: string | number) {
    updateBlueprint((draft) => {
      const gradient = { ...(draft.globalGradient ?? DEFAULT_GLOBAL_GRADIENT) };
      gradient[key] = value as never;
      draft.globalGradient = gradient;
    });
  }

  function updateEffect(key: string, value: string | number | boolean | string[]) {
    if (!selectedEffectId) return;
    updateBlueprint((draft) => {
      const effect = draft.effects.find((item) => item.id === selectedEffectId);
      if (effect) {
        const values = effect as unknown as Record<string, string | number | boolean | string[] | undefined>;
        const limits: Record<string, [number, number, boolean?]> = {
          opacity: [0, 1], layerCount: [1, 10, true], layerRadiusStep: [0, 0.1], layerAngleOffsetDeg: [0, 360], layerAmplitudeDecay: [0.5, 1], baseScale: [0, 4], maxScale: [0, 4], blurPx: [0, 100], brightness: [0, 3], rotationDeg: [-360, 360],
          moveX: [-1, 1], moveY: [-1, 1], initialAngleDeg: [-360, 360], beatsPerRevolution: [4, 32, true], count: [1, 64, true], sizePx: effect.kind === 'particles' ? [1, 100] : [1, 32], cycleMs: [100, 10000], bars: [2, 128, true], lineWidth: effect.kind === 'oscilloscope-line' || effect.kind === 'spectrum-line' ? [0.001, 0.05] : ['wave-ring', 'ripple', 'shockwave'].includes(effect.kind) ? [0.003, 0.05] : [0.05, 1],
          centerX: [0, 1], centerY: [0, 1], radius: [0.05, 0.45], barLength: [0.02, 0.3], amplitude: effect.kind === 'particle-trail' ? [0, 0.5] : [0, 0.2], points: [16, 128, true], glowIntensity: [0, 2], waves: [1, 6, true], periodMs: [250, 4000], maxRadius: [0.05, 0.5],
          originX: [0, 1], originY: [0, 1], directionDeg: [-360, 360], spreadDeg: [0, 360], speedPxPerSec: [0, 1000], lifetimeMs: [100, 5000], samples: [8, 128, true], trailMs: [100, 5000],
          barWidth: [effect.kind === 'waveform-peak-bars' ? 0.1 : effect.kind === 'spectrum-bars' ? 0.2 : 0.05, 1], spacing: [0, 0.5], smoothing: [0, 1], spikeSharpness: [0, 1], innerRadius: [0.02, effect.kind === 'radial-bars' ? effect.radius : 0.45], amplitudeScale: [0.1, ['spectrum-bars', 'spectrum-line'].includes(effect.kind) ? 3 : effect.kind === 'oscilloscope-line' ? 1 : ['radial-bars', 'wave-ring'].includes(effect.kind) ? 4 : 2], sampleCount: [effect.kind === 'oscilloscope-line' || effect.kind.startsWith('waveform-') ? 16 : 24, effect.kind === 'oscilloscope-line' || effect.kind.startsWith('waveform-') ? 512 : 256, true], jaggedness: [0, 1], opacityBoost: [0.5, 2], coreBrightness: [0, 2], lengthScale: [0.25, 1.5], segmentsPerBar: [1, 24, true], attackMs: [0, 1000], releaseMs: [0, 3000], spread: [0.1, 1], speedInfluence: [0, 2], baselineOpacity: [0, 0.35], audioInfluence: [0, 2], swirl: [-2, 2], diffusionSpeed: [0, 2], flowStrength: [0, 2], turbulence: [0, 2], inkDensity: [0, 1], cloudScale: [0.1, 2], responseTime: [0.5, 10],
        };
        const limit = limits[key];
        const safeValue = typeof value === 'number' && limit ? Math.min(limit[1], Math.max(limit[0], value)) : value;
        values[key] = typeof safeValue === 'number' && (limit?.[2] || key === 'count' && effect.kind === 'particle-burst') ? Math.round(safeValue) : safeValue;
        if (effect.kind === 'particles') {
          values.visibilityMode = 'triggered';
          values.audioReactive = true;
        } else if (key === 'audioReactive' && value === false) values.visibilityMode = 'always';
        if (['rotationMode', 'beatsPerRevolution', 'rotationDirection', 'initialAngleDeg'].includes(key) && (effect.kind === 'radial-bars' || effect.kind === 'wave-ring' || effect.kind === 'waveform-ring')) {
          values.rotationMode ??= 'continuous'; values.beatsPerRevolution ??= 8; values.rotationDirection ??= 'clockwise'; values.initialAngleDeg ??= 0;
        }
        if (effect.kind === 'pulse-scale') {
          if (key === 'baseScale') values.maxScale = Math.max(effect.maxScale, Number(safeValue));
          if (key === 'maxScale') values.baseScale = Math.min(effect.baseScale, Number(safeValue));
        }
      }
    });
  }

  function updateBinding(key: string, value: string | number) {
    if (!selectedEffectId) return;
    updateBlueprint((draft) => {
      const binding = draft.bindings.find((item) => item.effectId === selectedEffectId);
      if (binding) {
        const limits: Record<string, [number, number]> = { strength: [0, 1], threshold: [0, 1], attackMs: [0, 5000], releaseMs: [0, 10000] };
        const limit = limits[key];
        (binding as unknown as Record<string, string | number>)[key] = typeof value === 'number' && limit ? Math.min(limit[1], Math.max(limit[0], value)) : value;
      }
    });
  }

  function deleteEffect() {
    if (!selectedEffectId) return;
    updateBlueprint((draft) => {
      draft.effects = draft.effects.filter((effect) => effect.id !== selectedEffectId);
      draft.bindings = draft.bindings.filter((binding) => binding.effectId !== selectedEffectId);
    });
    setSelectedEffectId(null);
  }

  function onImageSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 10 * 1024 * 1024) {
      setImageError('PNG/JPEG形式、10 MB以下の画像を選択してください。');
      event.target.value = '';
      return;
    }
    setImageError('');
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') { setImage(null); updateBackground({ kind: 'image', src: reader.result }); }
      else setImageError('画像ファイルを読み込めませんでした。');
    };
    reader.onerror = () => setImageError('画像ファイルを読み込めませんでした。');
    reader.readAsDataURL(file);
  }

  async function onAudioSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (!inferAudioMimeType(file) || file.size < 1 || file.size > 32 * 1024 * 1024) {
      setAudioError('対応する音声形式で32 MiB以下のファイルを選択してください。範囲の確定前の元の音源はAPIへ送信しません。');
      return;
    }
    audioAnalysisController.current?.abort();
    audioAnalysisController.current = null;
    if (authSession && hasSavedAudioAnalysisJob()) cancelSavedAudioAnalysisJob(authSession.accessToken);
    audioJobRestoreController.current?.abort();
    audioJobRestoreController.current = null;
    setAudioAnalysisBusy(false);
    playbackAudioRef.current?.pause();
    setPlaying(false);
    setTimeMs(0);
    setAudioError('');
    if (variant === 'app') {
      const sequence = ++audioDecodeSequence.current;
      setRangeSelectionOpen(false);
      setSourceAudioFile(file);
      setSourceAudioUrl(URL.createObjectURL(file));
      setSourceDuration(0);
      setSourceWaveform(null);
      setRangeStart(0);
      setRangeEnd(0);
      setAudioAnalysisStatus('音源を読み込んでいます…');
      setAudioError('');
      let context: AudioContext | null = null;
      try {
        const Context = globalThis.AudioContext;
        if (typeof Context !== 'function') throw new Error('このブラウザーでは音源を読み込めません。');
        context = new Context();
        const decoded = await context.decodeAudioData((await file.arrayBuffer()).slice(0));
        if (sequence !== audioDecodeSequence.current) return;
        if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) throw new Error('音源の長さを読み取れません。別の音源を選択してください。');
        setSourceDuration(decoded.duration);
        setRangeStart(0);
        setRangeEnd(Math.min(decoded.duration, MAX_CLIP_SECONDS));
        setSourceWaveform(buildWaveformPeaks(decoded));
        setRangeSelectionOpen(true);
        setAudioAnalysisStatus('');
      } catch {
        if (sequence === audioDecodeSequence.current) {
          setSourceAudioFile(null);
          setSourceAudioUrl('');
          setSourceDuration(0);
          setSourceWaveform(null);
          setAudioError('音源を読み込めませんでした。ファイル形式を確認するか、別の音源を選択してください。');
          setAudioAnalysisStatus('');
        }
      } finally {
        if (context && context.state !== 'closed') await context.close().catch(() => undefined);
      }
    } else {
      setAudioFile(file);
      setMusicSummary(null);
    }
  }

  function cancelAudioRangeSelection() {
    audioDecodeSequence.current += 1;
    audioAnalysisController.current?.abort();
    audioAnalysisController.current = null;
    setAudioAnalysisBusy(false);
    setRangeSelectionOpen(false);
    setSourceAudioFile(null);
    setSourceAudioUrl('');
    setSourceDuration(0);
    setSourceWaveform(null);
    setAudioAnalysisStatus('音源範囲の選択をキャンセルしました。編集中の音源は維持しています。');
  }

  async function analyzeSelectedAudio() {
    if (!SourceAudioFile || !Number.isFinite(SourceDuration) || SourceDuration <= 0 || rangeEnd <= rangeStart || rangeEnd - rangeStart > MAX_CLIP_SECONDS + 1e-6 || audioAnalysisBusy) return;
    const controller = new AbortController();
    audioAnalysisController.current = controller;
    setAudioAnalysisBusy(true);
    setAudioAnalysisStatus('選択範囲をトリミングし、音源解析を実行しています…');
    try {
      const session = await currentSession();
      const clip = await trimAudioToWav(SourceAudioFile, rangeStart, rangeEnd);
      if (controller.signal.aborted) throw new DOMException('analysis canceled', 'AbortError');
      const result = await analyzeAudioClip(clip.file, session.accessToken, controller.signal, kickGateMode, (job) => {
        if (job.state === 'queued') setAudioAnalysisStatus(job.queuePosition ? `解析待ち：前に${Math.max(0, job.queuePosition - 1)}件あります。` : '解析待ちです。');
        else if (job.state === 'running') setAudioAnalysisStatus('SCNetで音源を解析しています…');
      });
      if (Math.abs(result.durationMs - clip.durationMs) > 1.1 || Math.abs(result.frameCount - clip.frameCount) > 45) throw new Error('解析結果の長さが切り出した音声と一致しません。');
      setPlaying(false);
      setTimeMs(0);
      setAudioFile(clip.file);
      setExportWithAudio(true);
      setTimeline(result.featureTimeline);
      setMusicSummary(result.musicSummary);
      setBlueprint(structuredClone(newEditorBlueprint));
      setSelectedRegionId(newEditorBlueprint.regions[0]?.id ?? null);
      setSelectedEffectId(newEditorBlueprint.effects[0]?.id ?? null);
      setSourceAudioFile(null);
      setSourceAudioUrl('');
      setSourceDuration(0);
      setSourceWaveform(null);
      setRangeSelectionOpen(false);
      setAudioAnalysisStatus(`解析完了：${(clip.durationMs / 1000).toFixed(2)}秒の選択した音源を編集画面に読み込みました。`);
    } catch (error) {
      if (audioAnalysisController.current === controller) {
        if (error instanceof DOMException && error.name === 'AbortError') setAudioAnalysisStatus('解析を中断しました。選択範囲を確認して再試行できます。');
        else setAudioAnalysisStatus(error instanceof Error ? error.message : '音源解析に失敗しました。');
      }
    } finally {
      if (audioAnalysisController.current === controller) {
        audioAnalysisController.current = null;
        setAudioAnalysisBusy(false);
      }
    }
  }

  async function saveProject() {
    setProjectStatus('プロジェクトを作成しています…');
    try {
      const blob = await serializeProject(blueprint, timeline, audioFile, new Date(), musicSummary);
      downloadBlob(blob, 'audio-reactive-project.arvproj');
      setProjectStatus('プロジェクトを保存しました。プロジェクトファイル（.arvproj）は暗号化されていないローカルファイルです。');
    } catch (error) {
      setProjectStatus(error instanceof Error ? error.message : 'プロジェクトを保存できませんでした。');
    }
  }

  async function loadProjectSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    setProjectStatus('プロジェクトを検証しています…');
    try {
      const restored = await parseProjectFile(file);
      validateBlueprint(restored.blueprint);
      let restoredImage: HTMLImageElement | null = null;
      if (restored.blueprint.background.kind === 'image') restoredImage = await loadImage(restored.blueprint.background.src);
      // Commit state only after format, schema, references and all referenced image data pass validation.
      audioAnalysisController.current?.abort(); audioAnalysisController.current = null;
      setAudioAnalysisBusy(false);
      setPlaying(false);
      setTimeMs(0);
      setBlueprint(restored.blueprint);
      setTimeline(restored.featureTimeline);
      setAudioFile(restored.audioFile);
      setMusicSummary(restored.musicSummary); setSourceAudioFile(null); setSourceAudioUrl(''); setRangeSelectionOpen(false);
      setExportWithAudio(Boolean(restored.audioFile));
      setImage(restoredImage);
      setImageError('');
      setAudioError('');
      setRegionEditMode(false);
      setSelectedRegionId(restored.blueprint.regions[0]?.id ?? null);
      setSelectedEffectId(restored.blueprint.effects[0]?.id ?? null);
      setProjectStatus(restored.musicSummary
        ? 'プロジェクトを復元しました。解析結果を使ってエフェクトを再生成できます。'
        : `プロジェクトを復元しました。${restored.audioFile ? 'このプロジェクトには解析要約がありません。エフェクトを再生成するには音源を再解析してください。' : ''}`);
    } catch (error) {
      setProjectStatus(error instanceof Error ? error.message : 'プロジェクトを読み込めませんでした。編集中の状態は維持しています。');
    }
  }

  async function startVideoExport() {
    if (exporting) return;
    if (exportFormat === 'mp4' && !isMP4Supported(exportWithAudio)) {
      setExportStatus(exportWithAudio
        ? 'このブラウザーはH.264 / AACのMP4出力に対応していません。WebMを選択してください。'
        : 'このブラウザーはH.264のMP4出力に対応していません。WebMを選択してください。');
      return;
    }
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    setPlaying(false);
    setExportProgress(0);
    setExportStatus('動画を生成しています…');
    try {
      const options = {
        blueprint, timeline, assets, fps: exportFPS, scale: exportScale,
        audioFile: exportWithAudio ? audioFile : null,
        signal: controller.signal,
        onProgress: setExportProgress,
      };
      const blob = exportFormat === 'mp4' ? await exportMP4(options) : await exportWebM(options);
      const extension = exportFormat === 'mp4' ? 'mp4' : 'webm';
      downloadBlob(blob, `audio-reactive-${exportWithAudio ? 'with-audio' : 'silent'}.${extension}`);
      setExportStatus(`動画を保存しました（${(blob.size / 1024 / 1024).toFixed(1)} MiB、${Math.round(timeline.durationMs / 1000)}s）。`);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') setExportStatus('動画出力を中断しました。');
      else setExportStatus(error instanceof Error ? error.message : '動画を生成できませんでした。');
    } finally {
      exportController.current = null;
      setExporting(false);
    }
  }

  function inputNumber(label: string, key: string, value: number, min: number, max: number, step = 0.01) {
    const localizedLabel = parameterLabel(label);
    return <label className="field" key={key}>{localizedLabel}<input aria-label={localizedLabel} type="number" min={min} max={max} step={step} value={value} onChange={(event) => updateEffect(key, Number(event.target.value))} /></label>;
  }

  function rotationControls(effect: Effect) {
    if (effect.kind !== 'radial-bars' && effect.kind !== 'wave-ring' && effect.kind !== 'waveform-ring') return null;
    return <>
      <label className="field">回転方法<select aria-label="回転方法" value={effect.rotationMode ?? 'continuous'} onChange={(event) => updateEffect('rotationMode', event.target.value)}><option value="continuous">テンポに合わせて回転</option><option value="triggered">音に合わせて回転</option></select></label>
      <label className="field">1回転あたりの拍数<select aria-label="1回転あたりの拍数" value={effect.beatsPerRevolution ?? 8} onChange={(event) => updateEffect('beatsPerRevolution', Number(event.target.value))}>{[4, 8, 16, 32].map((拍) => <option key={拍} value={拍}>{拍} 拍</option>)}</select></label>
      <label className="field">回転方向<select aria-label="回転方向" value={effect.rotationDirection ?? 'clockwise'} onChange={(event) => updateEffect('rotationDirection', event.target.value)}><option value="clockwise">時計回り</option><option value="counterclockwise">反時計回り</option></select></label>
      {inputNumber('Initial angle degrees', 'initialAngleDeg', effect.initialAngleDeg ?? 0, -360, 360, 1)}
      <p>テンポ： {timeline.bpm ?? 120}（{timeline.bpmSource === 'kick-estimated' ? '解析値' : '標準'}）に合わせて回転します。</p>
    </>;
  }

  function bindingNumber(label: string, key: string, value: number, min: number, max: number, step = 0.01) {
    const localizedLabel = parameterLabel(label);
    return <label className="field" key={key}>{localizedLabel}<input aria-label={localizedLabel} type="number" min={min} max={max} step={step} value={value} onChange={(event) => updateBinding(key, Number(event.target.value))} /></label>;
  }

  async function loadBlueprintFixture() {
    if (isDemo) return;
    if (variant === 'app' && (!musicSummary || rangeSelectionOpen || audioAnalysisBusy)) {
      setApiStatus('エフェクトを生成する前に、音源の範囲を選んで解析してください。');
      return;
    }
    setApiLoading(true);
    setApiStatus('');
    const fixtureSummary = {
      summaryVersion: 1,
      durationMs: timeline.durationMs,
      sourceAudio: { format: 'fixture', codec: 'fixture', sampleRateHz: 44100, channels: 2, fileBytes: 0 },
      analysis: { model: 'fixture', device: 'cpu', stemRms: { drums: 0.18, bass: 0.24, vocals: 0.12, other: 0.16 }, estimatedKickCount: timeline.kickEvents.length, featureSampleRateHz: 10, kickDetection: 'Fixed UI fixture only.' },
    };
    try {
      const session = await currentSession();
      const summary = variant === 'app' ? musicSummary : fixtureSummary;
      const idempotencyKey = crypto.randomUUID();
      const compactGenerationTimeline = {
        schemaVersion: 1,
        timeUnit: 'ms',
        durationMs: timeline.durationMs,
        ...(timeline.bpm !== undefined && timeline.bpmSource ? { bpm: timeline.bpm, bpmSource:timeline.bpmSource } : {}),
        bassEnvelope: timeline.bassEnvelope,
        kickEvents: timeline.kickEvents,
        ...(timeline.kickEventStrengths ? { kickEventStrengths: timeline.kickEventStrengths } : {}),
      };
      const response = await fetch(apiUrl('/api/v1/blueprints/generate'), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}`, 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ musicSummary: summary, featureTimeline: compactGenerationTimeline, visualIntent: 'Create a calm luminous stage with bass-reactive bars and kick accents.' }),
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const code = result && typeof result === 'object' && 'error' in result ? (result as { error?: { code?: string } }).error?.code : undefined;
        if (response.status === 401) { window.dispatchEvent(new Event('arvc-auth-expired')); throw new Error('セッションが切れました。再度ログインしてください。'); }
        if (response.status === 403) throw new Error('AI生成の利用許可がありません。運営者の許可が必要です。');
        if (response.status === 429) throw new Error('AI生成の利用上限に達しました。時間をおいてください。');
        if (response.status === 503) throw new Error('AI生成は現在停止中か、予算管理を利用できません。');
        if (response.status === 409 || code === 'idempotency_key_reused') throw new Error('この生成要求はすでに処理されています。新しいBlueprintを作る場合は新規要求として実行してください。');
        throw new Error('エフェクトを生成できませんでした。時間をおいて再度お試しください。');
      }
      if (!result || typeof result !== 'object' || !('blueprint' in result)) throw new Error('生成結果を読み込めませんでした。もう一度お試しください。');
      const candidate = (result as { blueprint: unknown }).blueprint as EditorBlueprint;
      validateBlueprint(candidate);
      const prepared = prepareGeneratedBlueprint(candidate);
      validateBlueprint(prepared);
      setBlueprint(prepared);
      setSelectedRegionId(prepared.regions[0]?.id ?? null);
      setSelectedEffectId(prepared.effects[0]?.id ?? null);
      const mode = 'mode' in result && result.mode === 'openai' ? '生成結果' : 'サンプル設定';
      setApiStatus(`${mode}の設定を読み込みました。エフェクトを編集できます。`);
    } catch (error) {
      setApiStatus(error instanceof Error ? error.message : '生成結果を読み込めませんでした。');
    } finally { setApiLoading(false); }
  }

  const geometryBounds = selectedRegion ? bounds(selectedRegion.geometry) : null;
  const selectedRect = selectedRegion?.geometry.kind === 'rect' ? selectedRegion.geometry : null;
  const selectedPolygonPoints = selectedRegion?.geometry.kind === 'polygon' ? selectedRegion.geometry.points : [];
  const regionEditHandles: Array<{ key: string; label: string; x: number; y: number; mode: RegionEditMode; edge?: RegionResizeEdge; pointIndex?: number; className?: string }> = [];
  if (regionEditMode && selectedRegion) {
    if (selectedRegion.geometry.kind === 'rect') {
      const rect = selectedRegion.geometry;
      const x1 = rect.x + rect.width;
      const y1 = rect.y + rect.height;
      regionEditHandles.push({ key: 'move', label: `${regionDisplayName(selectedRegion.name)}を移動`, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, mode: 'move-rect', className: 'region-move-handle' });
      const handles: Array<[RegionResizeEdge, number, number, string]> = [
        ['nw', rect.x, rect.y, 'nwse'], ['n', rect.x + rect.width / 2, rect.y, 'ns'], ['ne', x1, rect.y, 'nesw'],
        ['e', x1, rect.y + rect.height / 2, 'ew'], ['se', x1, y1, 'nwse'], ['s', rect.x + rect.width / 2, y1, 'ns'],
        ['sw', rect.x, y1, 'nesw'], ['w', rect.x, rect.y + rect.height / 2, 'ew'],
      ];
      handles.forEach(([edge, x, y, cursor]) => regionEditHandles.push({ key: edge, label: `${regionDisplayName(selectedRegion.name)}をサイズ変更 ${edge}`, x, y, mode: 'resize-rect', edge, className: `region-resize-handle cursor-${cursor}` }));
    } else {
      selectedRegion.geometry.points.forEach((point, pointIndex) => regionEditHandles.push({ key: `point-${pointIndex}`, label: `${regionDisplayName(selectedRegion.name)}の頂点 ${pointIndex + 1} を移動`, x: point.x, y: point.y, mode: 'move-polygon-point', pointIndex, className: 'region-vertex-handle' }));
    }
  }
  const workflowAudioReady = Boolean(SourceAudioFile || audioFile || musicSummary);
  const workflowAnalysisReady = !audioAnalysisBusy && !SourceAudioFile && Boolean(musicSummary);
  const workflowAnalysisStatus = audioAnalysisBusy ? '解析中' : workflowAnalysisReady ? '解析済み' : '未解析';

  return (
    <main className="editor-shell">
      <header className="editor-header">
        <div>{isDemo && <a className="registration-link" href="/">← トップページに戻る</a>}<h1>{isDemo ? 'サンプルデモ' : 'ビジュアルエディター'}</h1><p>{isDemo ? 'サンプル楽曲に合わせて映像を再生します。変更はこの画面だけに保存されます。' : '音に反応するエフェクトを編集し、プレビューで確認できます。'}</p></div>
        <div className="badge">プレビュー</div>
      </header>

      {!isDemo && <nav className="editor-workflow" aria-label="音源・解析の状態">
        <div className={`workflow-step${workflowAudioReady ? ' state-done' : ''}`} data-state={workflowAudioReady ? 'done' : 'pending'}>
          <strong>音源選択</strong><span>{workflowAudioReady ? '選択済み' : '未選択'}</span>
        </div>
        <div className={`workflow-step${workflowAnalysisReady ? ' state-done' : ''}`} data-state={workflowAnalysisReady ? 'done' : 'pending'}>
          <strong>音声解析</strong><span>{workflowAnalysisStatus}</span>
        </div>
      </nav>}

      {isDemo && <audio hidden ref={demoAudioRef} src={selectedDemoTrack.audioUrl} preload="metadata" onLoadedMetadata={(event) => {
        const audio = event.currentTarget;
        const durationMs = Number.isFinite(audio.duration) ? audio.duration * 1000 : null;
        if (durationMs !== null && timeMs > 0) audio.currentTime = Math.min(timeMs, timeline.durationMs, durationMs) / 1000;
        setDemoAudioDurationMs(durationMs);
      }} onTimeUpdate={(event) => {
        if (demoAudioDurationMs !== null && !event.currentTarget.seeking) setTimeMs(Math.min(timeline.durationMs, event.currentTarget.currentTime * 1000));
      }} onSeeked={(event) => setTimeMs(Math.min(timeline.durationMs, event.currentTarget.currentTime * 1000))} onPause={(event) => setTimeMs(Math.min(timeline.durationMs, event.currentTarget.currentTime * 1000))} onError={() => setDemoStatus(`${selectedDemoTrack.title}の音源を読み込めません。`)} onEnded={() => { setPlaying(false); setTimeMs(timeline.durationMs); }} aria-label="デモ音源" />}
      {!isDemo && playbackAudioUrl && <audio hidden ref={playbackAudioRef} src={playbackAudioUrl} preload="metadata" onEnded={() => { setPlaying(false); setTimeMs(timeline.durationMs); }} onError={() => { setPlaying(false); setApiStatus('選択した音源を読み込めませんでした。'); }} aria-label="編集プレビュー音声" />}
      {isDemo && demoStatus && demoStatus !== 'ready' && <p role="alert" className="notice-error">{demoStatus}</p>}

      <div className="editor-layout">
        <aside className="side-panel" aria-label="編集設定">
          {!isDemo && <section className="panel-section workflow-account" aria-label="アカウント">
            <h2>アカウント</h2>
            {authSession ? <>
              <p>ログイン中：{authSession.email || 'ローカルユーザー'}</p>
              <button onClick={() => void signOut()}>ログアウト</button>
            </> : <>
              <p>ローカル編集とプロジェクトファイルの保存はログインなしで利用できます。音声解析やAI生成にはログインが必要です。</p>
              <label className="field">メールアドレス<input aria-label="メールアドレス" type="email" autoComplete="username" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} /></label>
              <label className="field">パスワード<input aria-label="パスワード" type="password" autoComplete="current-password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} /></label>
              <button className="primary-button" disabled={authBusy || !authEmail || !authPassword} onClick={() => void login()}>{authBusy ? 'ログイン中…' : 'ログイン'}</button>
            </>}
            {cloudStatus && <p role="status">{cloudStatus}</p>}
          </section>}
          {cloudProjectUIEnabled && !isDemo && <section className="panel-section workflow-cloud" aria-label="クラウド保存">
            <h2>クラウド保存</h2>
            {authSession && <>
              <p>ログイン中：{authSession.email || 'ローカルユーザー'}</p>
              <div className="inline-actions"><button onClick={() => void signOut()}>ログアウト</button><button onClick={() => void refreshCloudProjects()}>一覧を更新</button></div>
              <label className="field">プロジェクト名<input aria-label="プロジェクト名" value={cloudTitle} maxLength={120} onChange={(event) => setCloudTitle(event.target.value)} /></label>
              <button className="primary-button" onClick={() => { setActiveCloudProject(null); setCloudTitle('新しいプロジェクト'); setCloudStatus('現在の編集状態を新しいクラウドプロジェクトとして保存できます。'); }}>新規作成</button>
              <div className="item-list" aria-label="保存済みプロジェクト一覧">
                {cloudProjects.map((project) => <button key={project.id} disabled={cloudBusy} className={activeCloudProject?.id === project.id ? 'active' : ''} onClick={() => void loadCloudProject(project.id)}>{project.title} · r{project.revision}</button>)}
                {cloudProjects.length === 0 && <p>保存済みプロジェクトはありません。</p>}
              </div>
              <div className="inline-actions">
                <button className="primary-button" disabled={cloudBusy || rangeSelectionOpen || audioAnalysisBusy} onClick={() => void saveCloudProject()}>{cloudBusy ? '処理中…' : 'クラウドに保存'}</button>
                {activeCloudProject && <button className="danger-button" disabled={cloudBusy} onClick={() => void removeCloudProject()}>プロジェクトを削除</button>}
              </div>
            </>}
            {cloudStatus && <p role="status">{cloudStatus}</p>}
          </section>}
          {!isDemo && <section className="panel-section workflow-audio" aria-label="音源">
            <details className="editor-accordion" open>
            <summary><h2>2 · 音源</h2><span className="accordion-hint">選択・解析</span></summary>
            <div className="accordion-content">
            <p>{variant === 'app' ? '音源を選び、範囲を指定して解析します。' : '音声付き動画の書き出しや解析に使う音源を選びます。サンプル設定の読み込みと無音の書き出しは、音源なしで利用できます。'}</p>
            <label className="file-button">{variant === 'app' ? '音源を選択して範囲を解析' : '音源を選択'}<input aria-label="音源を選択" type="file" accept="audio/*" onChange={(event) => { void onAudioSelected(event); }} /></label>
            {SourceAudioFile && <p className="local-file-name">元の音源：{SourceAudioFile.name}</p>}
            {audioFile && <p className="local-file-name">使用中の音源：{audioFile.name}</p>}
            {variant === 'app' && musicSummary && <p className="workflow-complete">解析済み範囲: {(musicSummary.durationMs / 1000).toFixed(2)} 秒。この範囲をプレビューと書き出しに使います。</p>}
            {variant === 'app' && audioAnalysisStatus && !rangeSelectionOpen && <p role="status">{audioAnalysisStatus}</p>}
            {audioError && <p role="alert" className="field-error">{audioError}</p>}
            <div className="audio-generation-action">
              <h3>{variant === 'app' ? '解析結果からエフェクトを生成' : 'サンプル設定'}</h3>
              <p>{variant === 'app' ? '解析した音源の特徴をもとに、編集用のエフェクト設定を作成します。' : 'サンプル設定を読み込んで編集できます。'}</p>
              <button className="primary-button" onClick={() => void loadBlueprintFixture()} disabled={apiLoading || (variant === 'app' && (!musicSummary || rangeSelectionOpen || audioAnalysisBusy))}>{apiLoading ? '読み込み中…' : variant === 'app' ? 'エフェクトを生成' : 'サンプル設定を読み込む'}</button>
              {variant === 'app' && !musicSummary && !apiLoading && <p className="workflow-prerequisite">先に音源の範囲を選んで解析してください。</p>}
              {apiStatus && <p role="status">{apiStatus}</p>}
            </div>
            </div>
            </details>
          </section>}
          {variant === 'app' && rangeSelectionOpen && SourceAudioFile && sourceWaveform && <AudioRangeSelectionModal
            audioUrl={SourceAudioUrl} waveform={sourceWaveform} duration={SourceDuration} start={rangeStart} end={rangeEnd}
            onRangeChange={(range) => { setRangeStart(range.start); setRangeEnd(range.end); }}
            onConfirm={() => void analyzeSelectedAudio()} onCancel={cancelAudioRangeSelection}
            onAbort={() => audioAnalysisController.current?.abort()} busy={audioAnalysisBusy} status={audioAnalysisStatus}
          />}
          <section className="panel-section editor-background">
            <h2>背景</h2>
            <div className="segmented">
              <button className={background.kind === 'solid' ? 'active' : ''} onClick={() => updateBackground({ kind: 'solid', color: '#141824' })}>単色</button>
              <button className={background.kind === 'gradient' ? 'active' : ''} onClick={() => updateBackground({ kind: 'gradient', from: '#10131c', to: '#40306f', angleDeg: 120 })}>グラデーション</button>
            </div>
            {background.kind === 'solid' && <label className="field">背景色<input aria-label="背景色" type="color" value={background.color} onChange={(event) => updateBackground({ ...background, color: event.target.value })} /></label>}
            {background.kind === 'gradient' && <div className="color-pair"><label className="field">開始色<input aria-label="グラデーションの開始色" type="color" value={background.from} onChange={(event) => updateBackground({ ...background, from: event.target.value })} /></label><label className="field">終了色<input aria-label="グラデーションの終了色" type="color" value={background.to} onChange={(event) => updateBackground({ ...background, to: event.target.value })} /></label><label className="field">角度<input aria-label="グラデーションの角度" type="number" min={0} max={360} value={background.angleDeg} onChange={(event) => updateBackground({ ...background, angleDeg: Math.min(360, Math.max(0, Number(event.target.value))) })} /></label></div>}
            {!isDemo && <label className="file-button">画像を選択（PNG / JPEG）<input aria-label="背景画像を選択" type="file" accept="image/png,image/jpeg" onChange={onImageSelected} /></label>}
            {background.kind === 'image' && <button className="quiet-button" onClick={() => updateBackground({ kind: 'solid', color: '#141824' })}>画像を削除</button>}
            {imageError && <p role="alert" className="field-error">{imageError}</p>}
          </section>

          {!isDemo && <section className="panel-section workflow-export">
            <h2>5 · 書き出しとプロジェクト</h2>
            <label className="field export-field">音声<select aria-label="音声" value={exportWithAudio ? 'with-audio' : 'silent'} disabled={exporting} onChange={(event) => setExportWithAudio(event.target.value === 'with-audio')}><option value="silent">無音の動画</option><option value="with-audio">選択した音源を含める</option></select></label>
            <label className="field export-field">動画形式<select aria-label="動画形式" value={exportFormat} disabled={exporting} onChange={(event) => setExportFormat(event.target.value as VideoFormat)}><option value="webm">WebM</option><option value="mp4" disabled={!isMP4Supported(exportWithAudio)}>MP4（H.264{exportWithAudio ? ' / AAC' : ''}）</option></select></label>
            {!isMP4Supported(exportWithAudio) && <p className="workflow-prerequisite">このブラウザーは現在の音声設定で{exportWithAudio ? 'H.264 / AAC' : 'H.264'}のMP4出力に対応していません。WebMは引き続き利用できます。</p>}
            {exportWithAudio && !audioFile && <p className="workflow-prerequisite">音声付き動画には音源が必要です。音源を選択するか、無音の動画を選んでください。</p>}
            {(rangeSelectionOpen || audioAnalysisBusy) && <p className="workflow-prerequisite">範囲を解析が完了するまで書き出しは利用できません。</p>}
            <div className="export-options">
              <label className="field">フレームレート<select aria-label="フレームレート" value={exportFPS} onChange={(event) => setExportFPS(Number(event.target.value) as ExportFPS)}><option value={24}>24</option><option value={30}>30</option><option value={60}>60</option></select></label>
              <label className="field">解像度<select aria-label="解像度" value={exportScale} onChange={(event) => setExportScale(Number(event.target.value) as ExportScale)}><option value={1}>{blueprint.width} × {blueprint.height}</option><option value={2}>{blueprint.width * 2} × {blueprint.height * 2}</option></select></label>
            </div>
            <div className="inline-actions export-actions">
              <button className="primary-button" disabled={exporting || rangeSelectionOpen || audioAnalysisBusy || (exportWithAudio && !audioFile) || (exportFormat === 'mp4' && !isMP4Supported(exportWithAudio))} onClick={() => void startVideoExport()}>{exporting ? '書き出し中…' : '動画を書き出す'}</button>
              {exporting && <button onClick={() => exportController.current?.abort()}>中止</button>}
            </div>
            {exporting && <progress aria-label="書き出しの進捗" max={1} value={exportProgress} />}
            {exportStatus && <p role="status">{exportStatus}</p>}
            <div className="inline-actions project-actions">
              <button disabled={exporting || rangeSelectionOpen || audioAnalysisBusy} onClick={() => void saveProject()}>プロジェクトを保存</button>
              <label className="file-button">プロジェクトを読み込む<input aria-label="プロジェクトファイルを選択" type="file" accept=".arvproj,application/json" onChange={(event) => void loadProjectSelected(event)} /></label>
            </div>
            {projectStatus && <p role="status">{projectStatus}</p>}
            <p className="privacy-note">音源と画像は、解析や動画書き出しのために必要な場合を除き外部へ送信しません。プロジェクトファイルには音源や画像が含まれる場合があります。共有する際は内容をご確認ください。</p>
          </section>}

          <section className="panel-section editor-regions">
            <details className="editor-accordion" open>
            <summary><h2>3 · 範囲 <span>{blueprint.regions.length}</span></h2><span className="accordion-hint">選択・編集</span></summary>
            <div className="accordion-content">
            <div className="tool-row">
              <button className={tool === 'select' ? 'active' : ''} onClick={() => { setTool('select'); setRectDraft(null); setPolygonDraft([]); }}>選択</button>
              <button className={tool === 'rect' ? 'active' : ''} onClick={() => { setRegionEditMode(false); setTool('rect'); setPolygonDraft([]); }}>四角形を描く</button>
              <button className={tool === 'polygon' ? 'active' : ''} onClick={() => { setRegionEditMode(false); setTool('polygon'); setPolygonDraft([]); }}>多角形を描く</button>
            </div>
            <button className={`region-edit-toggle ${regionEditMode ? 'active' : ''}`} aria-label="範囲の直接編集" aria-pressed={regionEditMode} disabled={!selectedRegion || tool !== 'select'} onClick={() => setRegionEditMode((active) => !active)}>{regionEditMode ? '範囲編集を終了' : 'プレビューで範囲を編集'}</button>
            {regionEditMode && <p className="region-edit-help">{selectedRect ? '範囲編集：中央をドラッグして移動、辺や角をドラッグして大きさを変更します。エフェクト位置の編集は一時停止します。' : '範囲編集：頂点をドラッグして形を変更します。エフェクト位置の編集は一時停止します。'}</p>}
            {tool === 'polygon' && <div className="inline-actions"><span>{polygonDraft.length} 点</span><button disabled={polygonDraft.length < 3} onClick={createPolygon}>多角形を確定</button><button onClick={() => setPolygonDraft([])}>クリア</button></div>}
            {regionError && <p role="alert" className="field-error">{regionError}</p>}
            <ul className="item-list">{blueprint.regions.map((region) => <li key={region.id}><button className={selectedRegionId === region.id ? 'selected' : ''} onClick={() => { setRegionEditMode(false); setSelectedRegionId(region.id); }}>{regionDisplayName(region.name)}<small>{region.geometry.kind === 'rect' ? '四角形' : '多角形'}</small></button></li>)}</ul>
            {selectedRegion && geometryBounds && <div className="geometry-fields">
              {selectedRect ? <>
                {(['x', 'y', 'width', 'height'] as const).map((key) => <label className="field compact" key={key}>{key}<input aria-label={`範囲 ${key}`} type="number" min={0} max={1} step={0.01} value={selectedRect[key]} onChange={(event) => updateRegionGeometry({ ...selectedRect, [key]: Number(event.target.value) })} /></label>)}
              </> : selectedPolygonPoints.map((point, index) => <div className="polygon-point" key={`${selectedRegion.id}-${index}`}><span>P{index + 1}</span><label>x<input aria-label={`頂点 ${index + 1} の x`} type="number" min={0} max={1} step={0.01} value={point.x} onChange={(event) => updateRegionGeometry({ kind: 'polygon', points: selectedPolygonPoints.map((item, i) => i === index ? { ...item, x: Number(event.target.value) } : item) })} /></label><label>y<input aria-label={`頂点 ${index + 1} の y`} type="number" min={0} max={1} step={0.01} value={point.y} onChange={(event) => updateRegionGeometry({ kind: 'polygon', points: selectedPolygonPoints.map((item, i) => i === index ? { ...item, y: Number(event.target.value) } : item) })} /></label></div>)}
              <button className="danger-button" onClick={deleteRegion}>範囲を削除</button>
            </div>}
            </div>
            </details>
          </section>
        </aside>

        <section className="workspace">
          <div className="canvas-card">
            <div className="canvas-toolbar"><span>プレビュー · {blueprint.width} × {blueprint.height}</span><span>{regionEditMode && selectedRegion ? `${regionDisplayName(selectedRegion.name)}を編集中` : tool === 'select' && selectedEffect && selectedEffectPosition ? `${titleFor(selectedEffect.kind)}の位置をドラッグして調整` : '音に反応：Bass・Kick'}</span></div>
            <div className="preview-canvas-wrap">
              <canvas ref={canvasRef} width={blueprint.width} height={blueprint.height} aria-label="映像プレビュー" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onLostPointerCapture={onLostPointerCapture} />
              {regionEditMode && selectedRegion && <>
                <svg className="region-edit-outline" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
                  {selectedRegion.geometry.kind === 'rect'
                    ? <rect x={selectedRegion.geometry.x * 1000} y={selectedRegion.geometry.y * 1000} width={selectedRegion.geometry.width * 1000} height={selectedRegion.geometry.height * 1000} />
                    : <polygon points={selectedRegion.geometry.points.map((point) => `${point.x * 1000},${point.y * 1000}`).join(' ')} />}
                </svg>
                {regionEditHandles.map((handle) => <button
                  key={`${selectedRegion.id}-${handle.key}`}
                  type="button"
                  className={`region-edit-handle ${handle.className ?? ''}`}
                  style={{ left: percent(handle.x), top: percent(handle.y) }}
                  aria-label={handle.label}
                  title={handle.label}
                  onPointerDown={(event) => beginRegionEditPointer(event, handle.mode, handle.edge, handle.pointIndex)}
                />)}
              </>}
              {!regionEditMode && tool === 'select' && selectedEffect && selectedEffectPosition && positionHandleStyle && <button
                type="button"
                className="effect-position-handle"
                style={positionHandleStyle}
                aria-label={`${titleFor(selectedEffect.kind)}の位置`}
                title={`${titleFor(selectedEffect.kind)}の位置`}
                onPointerDown={onEffectPositionPointerDown}
              >✥</button>}
            </div>
            {tool === 'polygon' && <p className="canvas-hint">プレビューをクリックして頂点を追加し、多角形を確定します。</p>}
          </div>

          <section className="timeline-panel" aria-label="再生とタイムライン">
            <h2>1 · 再生とタイムライン</h2>
            {isDemo && <label className="field">デモ楽曲<select aria-label="デモ楽曲" value={selectedDemoId} onChange={(event) => { setPlaying(false); setTimeMs(0); setDemoStatus('楽曲を切り替えています…'); setSelectedDemoId(event.target.value); }}>{demoTracks.map((track) => <option key={track.id} value={track.id}>{track.title}</option>)}</select></label>}
            <div className="playback-controls"><button className="primary-button" disabled={isDemo && demoStatus !== 'ready'} onClick={() => setPreviewPlaying(!playing)}>{playing ? '一時停止' : '再生'}</button><button disabled={isDemo && demoStatus !== 'ready'} onClick={stopPreview}>停止</button><output aria-label="再生位置" className="timeline-time">{(timeMs / 1000).toFixed(2)} s <span>/ {(timeline.durationMs / 1000).toFixed(2)} s</span></output></div>
            <input aria-label="再生位置の調整" className="seek" type="range" min={0} max={timeline.durationMs} step={20} disabled={isDemo && !demoTimelineReady} value={timeMs} onChange={(event) => seekPreview(Number(event.target.value))} />
            <div className="timeline-sources" aria-label="音源データの利用状況"><span className="timeline-sources-label">反応データ</span>{(['bass.envelope', 'kick.events', 'snare.events', 'drums.energy', 'vocals.envelope', 'other.envelope', 'music.energy'] as const).map((Source) => <span key={Source} className={`timeline-source ${sourceIsAvailable(Source, timeline) ? 'available' : 'missing'}`} title={`${sourceLabels[Source]}：${sourceIsAvailable(Source, timeline) ? '利用できます' : 'データがありません'}`}>{sourceLabels[Source]}</span>)}</div>
          </section>

          <section className="effects-panel">
            <details className="editor-accordion" open>
            <summary><div className="section-heading"><div><h2>4 · エフェクト</h2><p>種類を選び、プレビューで確認しながら見た目と音への反応を調整します。</p></div><span className="accordion-hint">追加・編集</span></div></summary>
            <div className="accordion-content">
            <div className="effect-add-controls"><label className="field">分類<select aria-label="追加するエフェクトの分類" value={addCategory} onChange={(event) => setAddCategory(event.target.value as EffectCategory)}>{EFFECT_CATEGORIES.map((category) => <option key={category} value={category}>{({ 'Core / Transform': '基本・変形', Waveform: '波形', 'EQ / Spectrum': '周波数', 'Circular / Radial': '円形・放射', Particles: '粒子', Impacts: '衝撃', 'Ambient / Atmospheric': '雰囲気' } as Record<string, string>)[category] ?? category}</option>)}</select></label><label className="field">＋ エフェクトを追加<select aria-label="追加するエフェクト" defaultValue="" onChange={(event) => { if (event.target.value) addEffect(event.target.value as Effect['kind']); event.target.value = ''; }}><option value="">種類を選択</option>{EFFECTS_BY_CATEGORY[addCategory].map((kind) => <option key={kind} value={kind}>{titleFor(kind)}</option>)}</select></label><button type="button" className="danger-button" disabled={!selectedEffect} onClick={deleteEffect}>エフェクトを削除</button></div>
            <div className="global-gradient-panel"><h3>共通カラー</h3><p>すべてのエフェクトに使う色の変化を設定します。</p>{(['startColor', 'middleColor', 'endColor'] as const).map((key) => <label className="field" key={key}>{key === 'startColor' ? '開始色' : key === 'middleColor' ? '中間色' : '終了色'}<input aria-label={`共通カラー ${key}`} type="color" value={(blueprint.globalGradient ?? DEFAULT_GLOBAL_GRADIENT)[key]} onChange={(event) => updateGlobalGradient(key, event.target.value)} /></label>)}<label className="field">色の向き<input aria-label="共通カラーの向き" type="number" min={0} max={360} value={(blueprint.globalGradient ?? DEFAULT_GLOBAL_GRADIENT).angleDeg} onChange={(event) => updateGlobalGradient('angleDeg', Number(event.target.value))} /></label></div>
            {variant === 'app' && <label className="field kick-gate-mode">Kick Detection Gate Mode<select aria-label="Kick Detection Gate Mode" value={kickGateMode} disabled={audioAnalysisBusy} onChange={(event) => setKickGateMode(event.target.value as KickGateMode)}><option value="off">Off</option><option value="soft">Soft</option><option value="middle">Middle</option><option value="hard">Hard</option></select><small>Kick検出の感度を設定します。変更は次回の音声解析時に反映されます。</small></label>}
            <div className="effect-editor">
              <div className="effect-list" aria-label="エフェクト一覧">{blueprint.effects.map((effect) => <button key={effect.id} aria-pressed={selectedEffectId === effect.id} className={selectedEffectId === effect.id ? 'selected' : ''} onClick={() => { setRegionEditMode(false); setSelectedEffectId(effect.id); }}><span className="swatch" style={{ background: effect.color }} />{titleFor(effect.kind)}<small>{blueprint.regions.find((region) => region.id === effect.regionId)?.name ? regionDisplayName(blueprint.regions.find((region) => region.id === effect.regionId)!.name) : '範囲なし'}</small></button>)}</div>
              {selectedEffect ? <div className="effect-fields">
                <label className="field">分類<select aria-label="エフェクトの分類" value={editCategory} onChange={(event) => { const category = event.target.value as EffectCategory; setEditCategory(category); setEditTypeChoice((EFFECTS_BY_CATEGORY[category] as readonly Effect['kind'][]).includes(selectedEffect.kind) ? selectedEffect.kind : ''); }}>
                  {EFFECT_CATEGORIES.map((category) => <option key={category} value={category}>{({ 'Core / Transform': '基本・変形', Waveform: '波形', 'EQ / Spectrum': '周波数', 'Circular / Radial': '円形・放射', Particles: '粒子', Impacts: '衝撃', 'Ambient / Atmospheric': '雰囲気' } as Record<string, string>)[category] ?? category}</option>)}</select></label>
                <label className="field">種類<select aria-label="エフェクトの種類" value={editTypeChoice} onChange={(event) => { const kind = event.target.value as Effect['kind']; if (!kind) return; changeSelectedEffectType(kind); setEditTypeChoice(kind); setEditCategory(effectCategoryFor(kind)); }}>{editTypeChoice === '' && <option value="">種類を選択</option>}{EFFECTS_BY_CATEGORY[editCategory].map((kind) => <option key={kind} value={kind}>{titleFor(kind)}</option>)}</select></label>
                <p className="effect-category-help">分類で種類を絞り込めます。種類を選ぶと、選択中のエフェクトが切り替わります。</p>
                <label className="field">カラー設定<select aria-label="カラー設定" value={selectedEffect.colorMode ?? 'custom'} onChange={(event) => updateEffect('colorMode', event.target.value as EffectColorMode)}><option value="global-gradient">共通カラー</option><option value="custom">個別の色</option></select></label>
                <label className="field">エフェクトの色<input aria-label="エフェクトの色" type="color" disabled={(selectedEffect.colorMode ?? 'custom') === 'global-gradient'} value={selectedEffect.color} onChange={(event) => { updateEffect('colorMode', 'custom'); updateEffect('color', event.target.value); }} /></label>
                {inputNumber('Opacity', 'opacity', selectedEffect.opacity ?? 1, 0, 1, 0.01)}
                {selectedEffect.kind === 'particles'
                  ? <label className="field">表示条件<select aria-label="表示条件" value="triggered" disabled><option value="triggered">音に反応</option></select></label>
                  : <label className="field">表示条件<select aria-label="表示条件" value={selectedEffect.visibilityMode ?? 'triggered'} onChange={(event) => updateEffect('visibilityMode', event.target.value)}><option value="triggered" disabled={selectedEffect.audioReactive === false}>音に反応</option><option value="always">常に表示</option></select></label>}
                {selectedEffect.kind === 'particles'
                  ? <label className="field">Audio Reactive<select aria-label="Audio Reactive" value="true" disabled><option value="true">オン</option></select></label>
                  : <label className="field">Audio Reactive<select aria-label="Audio Reactive" value={selectedEffect.audioReactive === false ? 'false' : 'true'} onChange={(event) => updateEffect('audioReactive', event.target.value === 'true')}><option value="true">オン</option><option value="false">オフ（常に表示）</option></select></label>}
                <label className="field">適用範囲<select aria-label="適用範囲" value={selectedEffect.regionId} onChange={(event) => updateEffect('regionId', event.target.value)}>{blueprint.regions.map((region) => <option key={region.id} value={region.id}>{regionDisplayName(region.name)}</option>)}</select></label>
                <details className="advanced-settings" key={`${selectedEffectId}:${selectedEffect.kind}`}>
                  <summary>詳細設定 · {titleFor(selectedEffect.kind)}</summary>
                  <div className="advanced-fields">
                {selectedEffect.kind === 'pulse-scale' && <>{inputNumber('Base scale', 'baseScale', selectedEffect.baseScale, 0, 4)}{inputNumber('Max scale', 'maxScale', selectedEffect.maxScale, 0, 4)}</>}
                {selectedEffect.kind === 'glow-brightness' && <>{inputNumber('Blur', 'blurPx', selectedEffect.blurPx, 0, 100, 1)}{inputNumber('Brightness', 'brightness', selectedEffect.brightness, 0, 3)}</>}
                {selectedEffect.kind === 'glow-brightness' && inputNumber('Glow intensity', 'glowIntensity', selectedEffect.glowIntensity ?? 1, 0, 2, 0.05)}
                {selectedEffect.kind === 'rotation-movement' && <>{inputNumber('Rotation degrees', 'rotationDeg', selectedEffect.rotationDeg, -360, 360, 1)}{inputNumber('Move X', 'moveX', selectedEffect.moveX, -1, 1)}{inputNumber('Move Y', 'moveY', selectedEffect.moveY, -1, 1)}</>}
                {selectedEffect.kind === 'particles' && <>{inputNumber('Maximum particle count', 'count', selectedEffect.count, 1, 64, 1)}{inputNumber('Particle size', 'sizePx', selectedEffect.sizePx, 1, 100, 1)}{inputNumber('Rise cycle ms', 'cycleMs', selectedEffect.cycleMs, 100, 10000, 50)}{inputNumber('Horizontal spread', 'spread', selectedEffect.spread ?? 0.92, 0.1, 1)}{inputNumber('Audio speed influence', 'speedInfluence', selectedEffect.speedInfluence ?? 0.9, 0, 2)}{inputNumber('Glow intensity', 'glowIntensity', selectedEffect.glowIntensity ?? 1.1, 0, 2)}{inputNumber('Baseline opacity', 'baselineOpacity', selectedEffect.baselineOpacity ?? 0.26, 0, 0.35)}<p>粒子は範囲の下端から上昇し、音の強さに応じて数・速度・広がり・発光が変わります。</p></>}
                {selectedEffect.kind === 'waveform-bars' && <>{inputNumber('Bars', 'bars', selectedEffect.bars, 2, 128, 1)}{inputNumber('Bar width', 'lineWidth', selectedEffect.lineWidth, 0.05, 1)}</>}
                {selectedEffect.kind === 'radial-bars' && <>{inputNumber('Center X', 'centerX', selectedEffect.centerX, 0, 1)}{inputNumber('Center Y', 'centerY', selectedEffect.centerY, 0, 1)}{inputNumber('Radius', 'radius', selectedEffect.radius, 0.05, 0.45)}{inputNumber('Inner radius', 'innerRadius', selectedEffect.innerRadius ?? selectedEffect.radius * 0.56, 0.02, selectedEffect.radius)}{inputNumber('Bars', 'bars', selectedEffect.bars, 8, 128, 1)}{inputNumber('Bar length', 'barLength', selectedEffect.barLength, 0.02, 0.3)}{inputNumber('Spike sharpness', 'spikeSharpness', selectedEffect.spikeSharpness ?? 0, 0, 1)}{inputNumber('Bar width', 'barWidth', selectedEffect.barWidth ?? 0.6, 0.05, 1)}{inputNumber('Amplitude scale', 'amplitudeScale', selectedEffect.amplitudeScale ?? 1, 0.1, 3)}{inputNumber('Glow intensity', 'glowIntensity', selectedEffect.glowIntensity ?? 0, 0, 2)}{rotationControls(selectedEffect)}</>}
                {selectedEffect.kind === 'wave-ring' && <>{inputNumber('Center X', 'centerX', selectedEffect.centerX, 0, 1)}{inputNumber('Center Y', 'centerY', selectedEffect.centerY, 0, 1)}{inputNumber('Radius', 'radius', selectedEffect.radius, 0.05, 0.45)}{inputNumber('Amplitude', 'amplitude', selectedEffect.amplitude, 0, 0.2)}{inputNumber('Wave points', 'points', selectedEffect.points, 16, 128, 1)}{inputNumber('Timeline samples', 'sampleCount', selectedEffect.sampleCount ?? selectedEffect.points, 24, 256, 1)}{inputNumber('Layer count', 'layerCount', selectedEffect.layerCount ?? 1, 1, 10, 1)}{inputNumber('Layer angle step (0 = auto)', 'layerAngleOffsetDeg', selectedEffect.layerAngleOffsetDeg ?? 0, 0, 360, 1)}{inputNumber('Layer amplitude decay', 'layerAmplitudeDecay', selectedEffect.layerAmplitudeDecay ?? 0.9, 0.5, 1, 0.01)}{inputNumber('Jaggedness', 'jaggedness', selectedEffect.jaggedness ?? 0, 0, 1)}{inputNumber('Smoothing', 'smoothing', selectedEffect.smoothing ?? 0.55, 0, 1)}{inputNumber('Amplitude scale', 'amplitudeScale', selectedEffect.amplitudeScale ?? 1, 0.1, 4)}{inputNumber('Line width', 'lineWidth', selectedEffect.lineWidth, 0.003, 0.05, 0.001)}{inputNumber('Glow intensity', 'glowIntensity', selectedEffect.glowIntensity ?? 0, 0, 2)}{rotationControls(selectedEffect)}</>}
                {selectedEffect.kind === 'waveform-line' && <><label className="field">向き<select aria-label="波形の向き" value={selectedEffect.orientation} onChange={(event) => updateEffect('orientation', event.target.value)}><option value="horizontal">横向き</option><option value="vertical">縦向き</option></select></label>{inputNumber('Sample count', 'sampleCount', selectedEffect.sampleCount, 16, 512, 1)}{inputNumber('Amplitude scale', 'amplitudeScale', selectedEffect.amplitudeScale, 0.1, 2)}{inputNumber('Line width', 'lineWidth', selectedEffect.lineWidth, 0.001, 0.05, 0.001)}{inputNumber('Glow intensity', 'glowIntensity', selectedEffect.glowIntensity, 0, 2)}</>}
                {selectedEffect.kind === 'waveform-peak-bars' && <>{inputNumber('Bars', 'bars', selectedEffect.bars, 2, 256, 1)}{inputNumber('Bar width', 'barWidth', selectedEffect.barWidth, 0.1, 1)}{inputNumber('Spacing', 'spacing', selectedEffect.spacing, 0, 0.5)}{inputNumber('Amplitude scale', 'amplitudeScale', selectedEffect.amplitudeScale, 0.1, 2)}{inputNumber('Glow intensity', 'glowIntensity', selectedEffect.glowIntensity, 0, 2)}</>}
                {selectedEffect.kind === 'spectrum-bars' && <>{inputNumber('Bar width', 'barWidth', selectedEffect.barWidth, 0.2, 1)}{inputNumber('Spacing', 'spacing', selectedEffect.spacing, 0, 0.5)}{inputNumber('Amplitude scale', 'amplitudeScale', selectedEffect.amplitudeScale, 0.1, 3)}{inputNumber('Glow intensity', 'glowIntensity', selectedEffect.glowIntensity, 0, 2)}<label className="field">バーの表示<select aria-label="バーの表示" value={String(selectedEffect.segmented ?? true)} onChange={(event) => updateEffect('segmented', event.target.value === 'true')}><option value="true">区切りあり</option><option value="false">連続</option></select></label>{selectedEffect.segmented !== false && inputNumber('Segments per bar', 'segmentsPerBar', selectedEffect.segmentsPerBar ?? 12, 1, 24, 1)}{inputNumber('Spectrum attack ms', 'attackMs', selectedEffect.attackMs ?? selectedBinding?.attackMs ?? 35, 0, 1000, 5)}{inputNumber('Spectrum release ms', 'releaseMs', selectedEffect.releaseMs ?? selectedBinding?.releaseMs ?? 180, 0, 3000, 10)}<p>音の高さを32帯域で表示します。選んだ音の強さに応じて反応します。</p></>}
                {selectedEffect.kind === 'spectrum-line' && <>{inputNumber('Amplitude scale', 'amplitudeScale', selectedEffect.amplitudeScale, 0.1, 3)}{inputNumber('Line width', 'lineWidth', selectedEffect.lineWidth, 0.001, 0.05, 0.001)}{inputNumber('Smoothing', 'smoothing', selectedEffect.smoothing, 0, 1)}{inputNumber('Glow intensity', 'glowIntensity', selectedEffect.glowIntensity, 0, 2)}{inputNumber('Spectrum attack ms', 'attackMs', selectedEffect.attackMs ?? selectedBinding?.attackMs ?? 35, 0, 1000, 5)}{inputNumber('Spectrum release ms', 'releaseMs', selectedEffect.releaseMs ?? selectedBinding?.releaseMs ?? 180, 0, 3000, 10)}<p>音の高さを32帯域の線で表示します。選んだ音の強さに応じて反応します。</p></>}
                {(selectedEffect.kind === 'ink-diffusion' || selectedEffect.kind === 'ink-flow' || selectedEffect.kind === 'color-mixing') && <>{inputNumber('Diffusion speed', 'diffusionSpeed', selectedEffect.diffusionSpeed ?? 0.25, 0, 2, 0.01)}{inputNumber('Flow strength', 'flowStrength', selectedEffect.flowStrength ?? 0.4, 0, 2, 0.01)}{inputNumber('Turbulence', 'turbulence', selectedEffect.turbulence ?? 0.3, 0, 2, 0.01)}{inputNumber('Ink density', 'inkDensity', selectedEffect.inkDensity ?? 0.65, 0, 1, 0.01)}{inputNumber('Cloud scale', 'cloudScale', selectedEffect.cloudScale ?? 0.5, 0.1, 2, 0.01)}{inputNumber('Response time seconds', 'responseTime', selectedEffect.responseTime ?? 3, 0.5, 10, 0.1)}<p>{selectedEffect.kind === 'ink-flow' ? '流れと渦を描きます。' : selectedEffect.kind === 'color-mixing' ? '複数の色密度場を時間変化で混ぜ合わせます。' : '模様を変化させてインクの雲を描きます。'} 音への反応は滑らかに変化します。</p>{selectedEffect.kind === 'color-mixing' && selectedEffect.colorMode !== 'global-gradient' && <div className="ink-palette-fields"><p>色のパレット（2〜4色）</p>{(selectedEffect.customPalette ?? ['#22d3ee', '#8b5cf6', '#ec4899']).map((color, index, palette) => <div className="field-row" key={`palette-${index}`}><label className="field">色 {index + 1}<input aria-label={`パレットの色 ${index + 1}`} type="color" value={color} onChange={(event) => { const next = [...palette]; next[index] = event.target.value; updateEffect('customPalette', next); }} /></label>{palette.length > 2 && <button type="button" aria-label={`パレットの色を削除 ${index + 1}`} onClick={() => updateEffect('customPalette', palette.filter((_, paletteIndex) => paletteIndex !== index))}>−</button>}</div>)}{(selectedEffect.customPalette ?? ['#22d3ee', '#8b5cf6', '#ec4899']).length < 4 && <button type="button" aria-label="パレットの色を追加" onClick={() => updateEffect('customPalette', [...(selectedEffect.customPalette ?? ['#22d3ee', '#8b5cf6', '#ec4899']), '#f59e0b'])}>色を追加</button>}</div>}</>}
                {selectedEffect.kind === 'waveform-ring' && <>{inputNumber('Radius', 'radius', selectedEffect.radius, 0.05, 0.45)}{inputNumber('Sample count', 'sampleCount', selectedEffect.sampleCount, 16, 512, 1)}{inputNumber('Amplitude scale', 'amplitudeScale', selectedEffect.amplitudeScale, 0.1, 2)}{inputNumber('Line width', 'lineWidth', selectedEffect.lineWidth, 0.001, 0.05, 0.001)}{inputNumber('Smoothing', 'smoothing', selectedEffect.smoothing, 0, 1)}{inputNumber('Glow intensity', 'glowIntensity', selectedEffect.glowIntensity, 0, 2)}{rotationControls(selectedEffect)}</>}
                {selectedEffect.kind === 'particle-burst' && <>{inputNumber('Origin X', 'originX', selectedEffect.originX, 0, 1)}{inputNumber('Origin Y', 'originY', selectedEffect.originY, 0, 1)}{inputNumber('Burst rotation degrees', 'directionDeg', selectedEffect.directionDeg, -360, 360)}{inputNumber('Angular variation', 'spreadDeg', selectedEffect.spreadDeg, 0, 360)}{inputNumber('Speed px/s', 'speedPxPerSec', selectedEffect.speedPxPerSec, 0, 1000)}{inputNumber('Lifetime ms', 'lifetimeMs', selectedEffect.lifetimeMs, 100, 5000, 50)}{inputNumber('Maximum particle count', 'count', selectedEffect.count, 1, 64, 1)}{inputNumber('Particle size', 'sizePx', selectedEffect.sizePx, 1, 32, 1)}{inputNumber('Glow intensity', 'glowIntensity', selectedEffect.glowIntensity ?? 0, 0, 2)}{inputNumber('Opacity boost', 'opacityBoost', selectedEffect.opacityBoost ?? 1, 0.5, 2)}{inputNumber('Core flash', 'coreBrightness', selectedEffect.coreBrightness ?? 0, 0, 2)}{inputNumber('Swirl rotations', 'swirl', selectedEffect.swirl ?? 0.55, -2, 2)}{inputNumber('Audio influence', 'audioInfluence', selectedEffect.audioInfluence ?? 1, 0, 2)}{inputNumber('Baseline opacity', 'baselineOpacity', selectedEffect.baselineOpacity ?? 0.12, 0, 0.35)}<p>粒子は全周へ放射状に飛び、イベントごとに向きが回転します。</p></>}
                {selectedEffect.kind === 'particle-trail' && <>{inputNumber('Samples', 'samples', selectedEffect.samples, 8, 128, 1)}{inputNumber('Trail ms', 'trailMs', selectedEffect.trailMs, 100, 5000, 50)}{inputNumber('Particle size', 'sizePx', selectedEffect.sizePx, 1, 32, 1)}{inputNumber('Amplitude', 'amplitude', selectedEffect.amplitude, 0, 0.5)}{inputNumber('Length scale', 'lengthScale', selectedEffect.lengthScale ?? 1, 0.25, 1.5)}{inputNumber('Glow intensity', 'glowIntensity', selectedEffect.glowIntensity ?? 0, 0, 2)}{inputNumber('Opacity boost', 'opacityBoost', selectedEffect.opacityBoost ?? 1, 0.5, 2)}</>}
                {selectedEffect.kind === 'ripple' && <>{inputNumber('Center X', 'centerX', selectedEffect.centerX, 0, 1)}{inputNumber('Center Y', 'centerY', selectedEffect.centerY, 0, 1)}{inputNumber('Waves', 'waves', selectedEffect.waves, 1, 6, 1)}{inputNumber('Period ms', 'periodMs', selectedEffect.periodMs, 250, 4000, 50)}{inputNumber('Radius', 'radius', selectedEffect.radius, 0.05, 0.45)}{inputNumber('Amplitude', 'amplitude', selectedEffect.amplitude, 0, 0.2)}{inputNumber('Line width', 'lineWidth', selectedEffect.lineWidth, 0.003, 0.05, 0.001)}{inputNumber('Glow intensity', 'glowIntensity', selectedEffect.glowIntensity ?? 0, 0, 2)}{inputNumber('Opacity boost', 'opacityBoost', selectedEffect.opacityBoost ?? 1, 0.5, 2)}</>}
                {selectedEffect.kind === 'shockwave' && <>{inputNumber('Center X', 'centerX', selectedEffect.centerX, 0, 1)}{inputNumber('Center Y', 'centerY', selectedEffect.centerY, 0, 1)}{inputNumber('Maximum radius', 'maxRadius', selectedEffect.maxRadius, 0.05, 0.5)}{inputNumber('Lifetime ms', 'lifetimeMs', selectedEffect.lifetimeMs, 100, 5000, 50)}{inputNumber('Line width', 'lineWidth', selectedEffect.lineWidth, 0.003, 0.05, 0.001)}{inputNumber('Glow intensity', 'glowIntensity', selectedEffect.glowIntensity ?? 0, 0, 2)}{inputNumber('Opacity boost', 'opacityBoost', selectedEffect.opacityBoost ?? 1, 0.5, 2)}</>}
                {selectedEffect.kind === 'oscilloscope-line' && <><label className="field">向き<select aria-label="波形の向き" value={selectedEffect.orientation} onChange={(event) => updateEffect('orientation', event.target.value)}><option value="horizontal">横向きの波形</option><option value="radial">円形の波形</option></select></label>{inputNumber('Line width', 'lineWidth', selectedEffect.lineWidth, 0.001, 0.05, 0.001)}{inputNumber('Sample count', 'sampleCount', selectedEffect.sampleCount, 32, 512, 1)}{inputNumber('Amplitude scale', 'amplitudeScale', selectedEffect.amplitudeScale, 0.1, 1)}{inputNumber('Glow intensity', 'glowIntensity', selectedEffect.glowIntensity, 0, 2)}<p>楽曲の低音の強さをもとに波形を描きます。元の音声波形そのものではありません。</p></>}
                </div></details>
                {selectedBinding && <div className="binding-fields"><h3>Audio Reactive</h3><label className="field">Audio Source<select aria-label="Audio Source" value={selectedBinding.source} onChange={(event) => updateBinding('source', event.target.value)}>{(['bass.envelope', 'drums.energy', 'vocals.envelope', 'other.envelope', 'music.energy', 'kick.events', 'snare.events'] as const).map((Source) => <option key={Source} value={Source}>{sourceLabels[Source]}{sourceIsAvailable(Source, timeline, selectedEffect) ? '' : '（利用不可）'}</option>)}</select></label>{!sourceIsAvailable(selectedBinding.source, timeline, selectedEffect) && <p role="status">{selectedEffect.kind === 'spectrum-bars' || selectedEffect.kind === 'spectrum-line' ? '周波数データがないため、このエフェクトは停止中です。' : selectedEffect.kind.startsWith('waveform-') ? selectedEffect.visibilityMode === 'always' ? '実際の波形データがないため、基準線・輪郭のみ表示します。代用の波形は生成しません。' : '実際の波形データがないため、このエフェクトは停止中です。' : selectedEffect.audioReactive === false ? '音への反応がオフのため、選んだ音源には反応しません。' : selectedEffect.visibilityMode === 'always' ? `${sourceLabels[selectedBinding.source]}のデータがないため、基本形状のみ表示します。` : `${sourceLabels[selectedBinding.source]}のデータがないため、このエフェクトは停止中です。`}</p>}{bindingNumber('Strength', 'strength', selectedBinding.strength, 0, 1)}{bindingNumber('Threshold', 'threshold', selectedBinding.threshold, 0, 1)}{bindingNumber('Attack ms', 'attackMs', selectedBinding.attackMs, 0, 5000, 10)}{bindingNumber('Release ms', 'releaseMs', selectedBinding.releaseMs, 0, 10000, 10)}</div>}
              </div> : <div className="empty-selection">エフェクトを選ぶか追加すると、設定を編集できます。</div>}
            </div>
            </div>
            </details>
          </section>
        </section>
      </div>
    </main>
  );
}
