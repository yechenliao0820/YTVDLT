/**
 * M4-4 · playlist batch IPC contract.
 *
 * Proves the data path: selected ids → enqueue callback → task ids, with strict
 * payload validation. Also pins the M3 invariant that the DIALOG confirmation
 * still writes only ids and never enqueues (A-M3-04 / D-38).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IPC_CHANNELS } from '@ytvdlt/shared';
import { createIpcGateway, validatePayload } from '../../apps/desktop/src/main/ipc-gateway.js';

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');

const PLAYLIST_URL = 'https://example.org/playlist?list=PL_fixture_01';

function gateway(overrides: Partial<Parameters<typeof createIpcGateway>[0]> = {}) {
  const calls: Array<{ selectedIds: readonly string[]; playlistUrl: string; kind: string }> = [];
  const instance = createIpcGateway({
    readText: async (path: string) => fixture(path.split(/[\\/]/).pop() ?? ''),
    videoFixturePath: fixturePath('info-video.json'),
    playlistFixturePath: fixturePath('info-flat-playlist.json'),
    enqueuePlaylistBatch: async (input) => {
      calls.push(input);
      return input.selectedIds.map((id) => `PL_fixture_01-${id}`);
    },
    ...overrides,
  });
  return { instance, calls };
}

describe('M4-4 · PLAYLIST_ENQUEUE channel', () => {
  it('is a registered channel with an explicit payload whitelist', () => {
    expect(IPC_CHANNELS.PLAYLIST_ENQUEUE).toBe('ytvdlt:playlist:enqueue');
    expect(() => validatePayload(IPC_CHANNELS.PLAYLIST_ENQUEUE, {
      selectedIds: ['a1'], playlistUrl: PLAYLIST_URL, kind: 'video',
    })).not.toThrow();
    expect(() => validatePayload(IPC_CHANNELS.PLAYLIST_ENQUEUE, {
      selectedIds: ['a1'], playlistUrl: PLAYLIST_URL, kind: 'video', argv: ['--exec'],
    })).toThrow(/payload key not allowed/);
  });

  it('turns 5 selected ids into 5 task ids', async () => {
    const { instance, calls } = gateway();
    const result = await instance.dispatch(IPC_CHANNELS.PLAYLIST_ENQUEUE, {
      selectedIds: ['a1', 'a2', 'a3', 'a4', 'a5'],
      playlistUrl: PLAYLIST_URL,
      kind: 'video',
    }) as { accepted: boolean; enqueued: boolean; taskIds: string[] };

    expect(result.accepted).toBe(true);
    expect(result.enqueued).toBe(true);
    expect(result.taskIds).toHaveLength(5);
    expect(result.taskIds[0]).toBe('PL_fixture_01-a1');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.selectedIds).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    expect(calls[0]?.kind).toBe('video');
  });

  it('rejects empty / oversized / non-string selections', async () => {
    const { instance } = gateway();
    const send = (selectedIds: unknown) => instance.dispatch(IPC_CHANNELS.PLAYLIST_ENQUEUE, {
      selectedIds, playlistUrl: PLAYLIST_URL, kind: 'video',
    });
    await expect(send([])).rejects.toThrow(/non-empty array/);
    await expect(send(['a1', 42])).rejects.toThrow(/non-empty strings/);
    await expect(send(['a'.repeat(201)])).rejects.toThrow(/non-empty strings/);
    await expect(send(Array.from({ length: 501 }, (_, i) => `a${i}`))).rejects.toThrow(/exceeds 500/);
    await expect(send('a1')).rejects.toThrow(/non-empty array/);
  });

  it('rejects a non-http(s) playlist URL (file:// / UNC / credentials)', async () => {
    const instance = createIpcGateway({
      readText: async () => '{}',
      videoFixturePath: 'x',
      playlistFixturePath: 'y',
    });
    for (const url of ['file:///C:/secrets.txt', '\\\\server\\share', 'https://user:pw@example.org/p']) {
      await expect(instance.dispatch(IPC_CHANNELS.PLAYLIST_ENQUEUE, {
        selectedIds: ['a1'], playlistUrl: url, kind: 'video',
      })).rejects.toMatchObject({ code: 'INVALID_URL' });
    }
  });

  it('reports enqueued:false when no queue is wired (L1 fixture mode)', async () => {
    const { instance } = gateway({ enqueuePlaylistBatch: undefined });
    const result = await instance.dispatch(IPC_CHANNELS.PLAYLIST_ENQUEUE, {
      selectedIds: ['a1'], playlistUrl: PLAYLIST_URL, kind: 'audio',
    }) as { enqueued: boolean; taskIds: string[] };
    expect(result.enqueued).toBe(false);
    expect(result.taskIds).toEqual([]);
  });

  it('keeps the dialog confirmation non-enqueueing (A-M3-04 not regressed)', async () => {
    const { instance, calls } = gateway();
    const result = await instance.dispatch(IPC_CHANNELS.DIALOG_CONFIRM, {
      kind: 'playlist', confirmed: true, state: 'ready', selectedPlaylistIds: ['a1', 'a2'],
    }) as { enqueued: boolean };
    expect(result.enqueued).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
