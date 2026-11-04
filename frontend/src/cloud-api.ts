import { apiUrl } from './api-connection';
import type { AuthSession } from './auth-client';
import type { CloudAsset, CloudDocumentEnvelopeV1, ProjectDocumentV1 } from './cloud-project';

export type CloudProject = {
  id: string; title: string; revision: number; document: CloudDocumentEnvelopeV1 | ProjectDocumentV1; createdAt: string; updatedAt: string;
};
export type CloudEnvelopeProject = Omit<CloudProject, 'document'> & { document: CloudDocumentEnvelopeV1 };
export type AssetMetadata = { id: string; projectId: string; kind: CloudAsset['kind']; originalName: string; contentType: string; byteSize: number; sha256: string; status: 'pending_upload' | 'ready' | 'delete_pending'; };
const pendingReservations = new Map<string, AssetMetadata>();

async function call<T>(session: AuthSession, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(`/api/v1${path}`), {
    ...init,
    headers: { Authorization: `Bearer ${session.accessToken}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  if (response.status === 401) { window.dispatchEvent(new Event('arvc-auth-expired')); throw new Error('ログインの有効期限が切れました。再度ログインしてください。'); }
  if (!response.ok) {
    let code = '';
    try { code = (await response.json() as { error?: { code?: string } }).error?.code ?? ''; } catch { /* sanitized below */ }
    const messages: Record<string, string> = {
      revision_conflict: '別の更新が先に保存されました。一覧から最新Projectを読み込み直してください。',
      project_limit_reached: 'Projectの上限に達しています。', project_too_large: 'Projectデータが上限を超えています。',
      invalid_asset_reference: '素材参照を検証できませんでした。', asset_limit_reached: '素材の容量上限に達しています。',
      asset_referenced: 'Projectから素材参照を外してから削除してください。', project_asset_cleanup_failed: '素材の削除が完了しませんでした。Projectは保持されています。再試行してください。',
    };
    throw new Error(messages[code] ?? `クラウドAPIに失敗しました（HTTP ${response.status}）。`);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export async function listProjects(session: AuthSession): Promise<CloudProject[]> {
  const page = await call<{ items: CloudProject[]; nextCursor?: string }>(session, '/projects?limit=20');
  if (page.nextCursor) throw new Error('Project一覧が複数ページあります。一覧ページングは未対応です。');
  return page.items;
}
export function createProject(session: AuthSession, title: string, document: CloudDocumentEnvelopeV1) {
  return call<CloudEnvelopeProject>(session, '/projects', { method: 'POST', body: JSON.stringify({ title, document }) });
}
export function updateProject(session: AuthSession, project: CloudProject, title: string, document: CloudDocumentEnvelopeV1) {
  return call<CloudEnvelopeProject>(session, `/projects/${encodeURIComponent(project.id)}`, { method: 'PUT', body: JSON.stringify({ title, revision: project.revision, document }) });
}
export function getProject(session: AuthSession, id: string) { return call<CloudProject>(session, `/projects/${encodeURIComponent(id)}`); }
export function deleteProject(session: AuthSession, id: string) { return call<void>(session, `/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
export function deleteAsset(session: AuthSession, projectId: string, assetId: string) { return call<void>(session, `/projects/${projectId}/assets/${assetId}`, { method: 'DELETE' }); }

export async function listAssets(session: AuthSession, projectId: string): Promise<AssetMetadata[]> {
  return (await call<{ items: AssetMetadata[] }>(session, `/projects/${projectId}/assets`)).items;
}

export async function uploadAsset(session: AuthSession, projectId: string, file: File, kind: CloudAsset['kind']): Promise<AssetMetadata> {
  const bytes = await file.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const contentType = kind === 'background_image' ? file.type : (file.type || inferAudioType(file.name));
  const pendingKey = `${projectId}:${kind}:${sha256}`;
  let reservation = pendingReservations.get(pendingKey);
  if (!reservation) {
    reservation = await call<AssetMetadata>(session, `/projects/${projectId}/assets`, {
      method: 'POST', body: JSON.stringify({ kind, name: file.name, contentType, byteSize: file.size, sha256 }),
    });
    pendingReservations.set(pendingKey, reservation);
  }
  if (reservation.projectId !== projectId || reservation.kind !== kind || reservation.status !== 'pending_upload' || reservation.contentType !== contentType || reservation.byteSize !== file.size || reservation.sha256 !== sha256 || !reservation.id) {
    throw new Error('素材予約の応答が要求内容と一致しません。');
  }
  const completePath = apiUrl(`/api/v1/projects/${projectId}/assets/${reservation.id}/complete`);
  const completion = await fetch(completePath, { method: 'POST', headers: { Authorization: `Bearer ${session.accessToken}` } });
  if (completion.ok) {
    const ready = await completion.json() as AssetMetadata;
    assertReadyAsset(ready, reservation, sha256);
    pendingReservations.delete(pendingKey);
    return ready;
  }
  if (completion.status === 401) { window.dispatchEvent(new Event('arvc-auth-expired')); throw new Error('ログインの有効期限が切れました。再度ログインしてください。'); }
  if (completion.status !== 422 && completion.status !== 409) throw new Error(`素材の完了確認に失敗しました（HTTP ${completion.status}）。`);
  // A reservation with no stored object is expected to fail completion; upload the bytes once.
  const upload = await fetch(apiUrl(`/api/v1/projects/${projectId}/assets/${reservation.id}/content`), {
    method: 'POST', headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': contentType }, body: file,
  });
  if (!upload.ok) {
    if (upload.status === 401) { window.dispatchEvent(new Event('arvc-auth-expired')); throw new Error('ログインの有効期限が切れました。再度ログインしてください。'); }
    throw new Error(`素材アップロードに失敗しました（HTTP ${upload.status}）。予約は保持されています。`);
  }
  const ready = await upload.json() as AssetMetadata;
  assertReadyAsset(ready, reservation, sha256);
  pendingReservations.delete(pendingKey);
  return ready;
}

function assertReadyAsset(value: AssetMetadata, reservation: AssetMetadata, sha256: string): void {
  if (!value || value.id !== reservation.id || value.projectId !== reservation.projectId || value.kind !== reservation.kind || value.sha256 !== sha256 || value.byteSize !== reservation.byteSize || value.status !== 'ready') {
    throw new Error('素材アップロード結果を検証できません。');
  }
}

export async function loadAsset(session: AuthSession, projectId: string, assetId: string): Promise<CloudAsset> {
  const metadata = await call<AssetMetadata>(session, `/projects/${projectId}/assets/${assetId}`);
  if (metadata.projectId !== projectId || metadata.id !== assetId || metadata.status !== 'ready') throw new Error('素材metadataがProjectまたは状態と一致しません。');
  const response = await fetch(apiUrl(`/api/v1/projects/${projectId}/assets/${assetId}/content`), { headers: { Authorization: `Bearer ${session.accessToken}` } });
  if (!response.ok) throw new Error(`素材を読み込めません（HTTP ${response.status}）。`);
  const blob = await response.blob();
  if (blob.size !== metadata.byteSize) throw new Error('取得した素材のサイズが一致しません。');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  const hash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== metadata.sha256) throw new Error('取得した素材のSHA-256が一致しません。');
  return { id: metadata.id, kind: metadata.kind, contentType: metadata.contentType, file: new File([blob], metadata.originalName, { type: metadata.contentType }) };
}

export function inferAudioType(name: string): string {
  const ext = name.toLowerCase().split('.').pop();
  const map: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/opus', m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm', flac: 'audio/flac' };
  const value = ext ? map[ext] : undefined;
  if (!value) throw new Error('音源形式を判定できません。対応形式の音源を選択してください。');
  return value;
}

export function imageFileFromDataURL(dataURL: string): File {
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+=*)$/.exec(dataURL);
  if (!match?.[1] || !match[2]) throw new Error('背景画像data URLが不正です。');
  const binary = atob(match[2]);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new File([bytes], match[1] === 'image/png' ? 'background.png' : 'background.jpg', { type: match[1] });
}
