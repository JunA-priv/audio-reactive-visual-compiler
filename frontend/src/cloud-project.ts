import { normalizeBlueprintForSave, validateBlueprint } from './editor-model';
import type { EditorBlueprint, FeatureTimeline } from './editor-model';
import { validateFeatureTimeline } from './renderer';

export type CloudDocumentEnvelopeV1 = {
  cloudDocumentVersion: 1;
  metadata: {
    blueprintSchemaVersion: 1;
    featureTimelineSchemaVersion: 1;
    rendererVersion: 'editor-renderer/1';
    analysisVersion: string;
    seed: number;
  };
  editorState: {
    blueprint: EditorBlueprint;
    backgroundAssetId: string | null;
  };
  featureTimeline: FeatureTimeline & { schemaVersion: 1; timeUnit: 'ms' };
  assetRefs: { audioAssetId: string | null };
};

export type ProjectDocumentV1 = {
  documentVersion: 1;
  metadata: CloudDocumentEnvelopeV1['metadata'];
  blueprint: EditorBlueprint;
  featureTimeline: FeatureTimeline & { schemaVersion: 1; timeUnit: 'ms' };
};

export type CloudAsset = {
  id: string;
  kind: 'source_audio' | 'background_image';
  contentType: string;
  file: File;
};

export type HydratedCloudProject = {
  blueprint: EditorBlueprint;
  featureTimeline: FeatureTimeline;
  audioFile: File | null;
};

export function toCloudEnvelopeV1(
  blueprint: EditorBlueprint,
  featureTimeline: FeatureTimeline,
  metadata: CloudDocumentEnvelopeV1['metadata'],
  refs: { backgroundAssetId?: string | null; audioAssetId?: string | null } = {},
): CloudDocumentEnvelopeV1 {
  const storedBlueprint = normalizeBlueprintForSave(blueprint);
  validateBlueprint(storedBlueprint);
  validateFeatureTimeline(featureTimeline);
  const backgroundAssetId = refs.backgroundAssetId ?? null;
  if (blueprint.background.kind === 'image') {
    if (!backgroundAssetId) throw new Error('Cloud project image background must be uploaded as an asset first.');
    storedBlueprint.background = { kind: 'solid', color: '#000000' };
  } else if (backgroundAssetId) {
    throw new Error('Cloud project background asset requires an image background in the editor.');
  }
  const result: CloudDocumentEnvelopeV1 = {
    cloudDocumentVersion: 1,
    metadata: { ...metadata },
    editorState: { blueprint: storedBlueprint, backgroundAssetId },
    featureTimeline: { ...structuredClone(featureTimeline), schemaVersion: 1, timeUnit: 'ms' },
    assetRefs: { audioAssetId: refs.audioAssetId ?? null },
  };
  validateCloudHeader(result);
  return result;
}

export function envelopeFromProjectDocumentV1(document: ProjectDocumentV1): CloudDocumentEnvelopeV1 {
  if (!document || document.documentVersion !== 1 || document.metadata?.blueprintSchemaVersion !== 1 || document.metadata?.featureTimelineSchemaVersion !== 1 || document.metadata?.rendererVersion !== 'editor-renderer/1') {
    throw new Error('Unsupported ProjectDocument v1.');
  }
  validateBlueprint(document.blueprint);
  validateFeatureTimeline(document.featureTimeline);
  if (document.blueprint.background.kind === 'image') throw new Error('Legacy cloud Project contains an embedded image that cannot be safely converted.');
  const envelope: CloudDocumentEnvelopeV1 = {
    cloudDocumentVersion: 1,
    metadata: { ...document.metadata },
    editorState: { blueprint: structuredClone(document.blueprint), backgroundAssetId: null },
    featureTimeline: { ...structuredClone(document.featureTimeline), schemaVersion: 1, timeUnit: 'ms' },
    assetRefs: { audioAssetId: null },
  };
  validateCloudHeader(envelope);
  return envelope;
}

export async function hydrateCloudEnvelopeV1(
  envelope: CloudDocumentEnvelopeV1,
  loadAsset: (assetId: string) => Promise<CloudAsset>,
): Promise<HydratedCloudProject> {
  validateCloudHeader(envelope);
  const blueprint = structuredClone(envelope.editorState.blueprint);
  if (envelope.editorState.backgroundAssetId) {
    const image = await loadAsset(envelope.editorState.backgroundAssetId);
    if (image.id !== envelope.editorState.backgroundAssetId || image.kind !== 'background_image' || !['image/png', 'image/jpeg'].includes(image.contentType)) {
      throw new Error('Cloud project background asset metadata is invalid.');
    }
    const data = new Uint8Array(await image.file.arrayBuffer());
    blueprint.background = { kind: 'image', src: `data:${image.contentType};base64,${encodeBase64(data)}` };
  }
  let audioFile: File | null = null;
  if (envelope.assetRefs.audioAssetId) {
    const audio = await loadAsset(envelope.assetRefs.audioAssetId);
    if (audio.id !== envelope.assetRefs.audioAssetId || audio.kind !== 'source_audio' || !audio.contentType.startsWith('audio/')) {
      throw new Error('Cloud project audio asset metadata is invalid.');
    }
    audioFile = audio.file;
  }
  validateBlueprint(blueprint);
  validateFeatureTimeline(envelope.featureTimeline);
  return { blueprint, featureTimeline: structuredClone(envelope.featureTimeline), audioFile };
}

function validateCloudHeader(envelope: CloudDocumentEnvelopeV1): void {
  if (!envelope || envelope.cloudDocumentVersion !== 1 || envelope.metadata?.blueprintSchemaVersion !== 1 || envelope.metadata?.featureTimelineSchemaVersion !== 1 || envelope.metadata?.rendererVersion !== 'editor-renderer/1' || !Number.isSafeInteger(envelope.metadata?.seed) || envelope.metadata.seed !== envelope.editorState?.blueprint?.seed || !envelope.editorState || !envelope.assetRefs || !(envelope.assetRefs.audioAssetId === null || isUUID(envelope.assetRefs.audioAssetId)) || !(envelope.editorState.backgroundAssetId === null || isUUID(envelope.editorState.backgroundAssetId))) {
    throw new Error('Invalid Cloud Document Envelope v1.');
  }
  validateBlueprint(envelope.editorState.blueprint);
  validateFeatureTimeline(envelope.featureTimeline);
  if (envelope.editorState.backgroundAssetId && (envelope.editorState.blueprint.background.kind !== 'solid' || envelope.editorState.blueprint.background.color.toLowerCase() !== '#000000')) {
    throw new Error('Cloud image background must use the canonical placeholder.');
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
