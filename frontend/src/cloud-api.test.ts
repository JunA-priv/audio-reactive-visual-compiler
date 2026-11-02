import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProject, imageFileFromDataURL, listProjects, uploadAsset } from './cloud-api';
import type { AuthSession } from './auth-client';
import { initialEditorBlueprint } from './editor-model';
import { toCloudEnvelopeV1 } from './cloud-project';

const session: AuthSession = { accessToken: 'test-token', refreshToken: 'refresh', expiresAt: Date.now() + 60_000, email: 'test@example.test' };
const envelope = toCloudEnvelopeV1(initialEditorBlueprint, { durationMs: 1000, bassEnvelope: [{ timeMs: 0, value: 0 }], kickEvents: [] }, {
  blueprintSchemaVersion: 1, featureTimelineSchemaVersion: 1, rendererVersion: 'editor-renderer/1', analysisVersion: 'test/1', seed: initialEditorBlueprint.seed,
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('cloud API adapter', () => {
  it('uses the existing Go API and user bearer token for Project creation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'project-id', title: 'Test', revision: 1, document: envelope, createdAt: '', updatedAt: '' }), { status: 201 })));
    await createProject(session, 'Test', envelope);
    expect(fetch).toHaveBeenCalledWith('/api/v1/projects', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }));
  });

  it('surfaces revision conflicts as an editable reload instruction', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'revision_conflict', message: 'sanitized' } }), { status: 409 })));
    await expect(listProjects(session)).rejects.toThrow(/別の更新が先/);
  });

  it('converts only supported image data URLs to a file', () => {
    const file = imageFileFromDataURL('data:image/png;base64,iVBORw0KGgo=');
    expect(file.type).toBe('image/png');
    expect(file.name).toBe('background.png');
    expect(() => imageFileFromDataURL('data:text/html;base64,SGVsbG8=')).toThrow(/不正/);
  });

  it('reserves and sends asset bytes through the verified Go API path', async () => {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([1, 2, 3, 4])));
    const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const pending = { id: 'asset-id', projectId: 'project-id', kind: 'source_audio', originalName: 'track.wav', contentType: 'audio/wav', byteSize: 4, sha256, status: 'pending_upload' };
    const ready = { ...pending, status: 'ready' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(pending), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'asset_integrity_mismatch' } }), { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(ready), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'track.wav', { type: 'audio/wav' });
    await expect(uploadAsset(session, 'project-id', file, 'source_audio')).resolves.toMatchObject({ id: 'asset-id', status: 'ready' });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/projects/project-id/assets', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/projects/project-id/assets/asset-id/complete', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/v1/projects/project-id/assets/asset-id/content', expect.objectContaining({ method: 'POST', body: file }));
    expect(JSON.stringify(fetchMock.mock.calls).includes('test-token')).toBe(true);
  });

  it('reuses a pending reservation after a failed upload when the same asset is retried', async () => {
    const file = new File([new Uint8Array([9, 8, 7])], 'retry.wav', { type: 'audio/wav' });
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
    const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const metadata = { id: 'retry-asset', projectId: 'retry-project', kind: 'source_audio', originalName: file.name, contentType: file.type, byteSize: file.size, sha256, status: 'pending_upload' };
    const ready = { ...metadata, status: 'ready' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(metadata), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'asset_integrity_mismatch' } }), { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'asset_storage_unavailable' } }), { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(ready), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(uploadAsset(session, 'retry-project', file, 'source_audio')).rejects.toThrow(/予約は保持/);
    await expect(uploadAsset(session, 'retry-project', file, 'source_audio')).resolves.toMatchObject({ id: 'retry-asset', status: 'ready' });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/assets')).length).toBe(1);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/complete')).length).toBe(2);
  });
});
