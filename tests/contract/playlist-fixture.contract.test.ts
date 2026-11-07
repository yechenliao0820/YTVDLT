/**
 * B4 / F038 · A-4.1-05 L1 flat-playlist fixture contract.
 *
 * `mapProbeResult()` / `toPlaylistInfo()` are driven ONLY by the recorded
 * `tests/fixtures/info-flat-playlist.json`: no spawn, no network, no engine.
 * Also verifies the M3 IpcGateway resolves PROBE / PROBE_PLAYLIST from the L1
 * fixtures through an in-memory reader and strips every `url` key.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapProbeResult, toPlaylistInfo, toMediaInfo } from '@ytvdlt/engine-ytdlp';
import { IPC_CHANNELS } from '@ytvdlt/shared';
import { createIpcGateway, omitUrl, validatePayload } from '../../apps/desktop/src/main/ipc-gateway.js';
import { registerIpcGateway } from '../../apps/desktop/src/main/index.js';
import { createBridgeApi, BRIDGE_CHANNELS } from '../../apps/desktop/src/preload/bridge.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (relative: string): unknown =>
  JSON.parse(readFileSync(join(ROOT, relative), 'utf8')) as unknown;

function hasUrlKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUrlKey);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).some((key) =>
      key === 'url' || hasUrlKey((value as Record<string, unknown>)[key]));
  }
  return false;
}

const gateway = createIpcGateway({
  readText: async (path: string) => readFileSync(path, 'utf8'),
  videoFixturePath: join(ROOT, 'tests/fixtures/info-video.json'),
  playlistFixturePath: join(ROOT, 'tests/fixtures/info-flat-playlist.json'),
});

describe('A-4.1-05 · L1 flat-playlist fixture dispatch', () => {
  it('routes _type=playlist to PlaylistInfo with 3 entries and exact titles', () => {
    const raw = read('tests/fixtures/info-flat-playlist.json');
    const info = mapProbeResult(raw) as { _type: string; entries: Array<{ id: string; title: string; duration: number | null }> };
    expect(info._type).toBe('playlist');
    expect(info.entries).toHaveLength(3);
    expect(info.entries.map((e) => e.id)).toEqual(['a1', 'a2', 'a3']);
    expect(info.entries.map((e) => e.title)).toEqual(['Episode 1', 'Episode 2', 'Episode 3']);
    expect(info.entries[2]?.duration).toBeNull();
  });

  it('toPlaylistInfo() is deterministic and _type-independent of the video path', () => {
    const raw = read('tests/fixtures/info-flat-playlist.json');
    const a = toPlaylistInfo(raw);
    const b = toPlaylistInfo(raw);
    expect(a).toEqual(b);
    expect(a._type).toBe('playlist');
    expect(a.extractor_key).toBe('generic');
    const video = mapProbeResult(read('tests/fixtures/info-video.json')) as { _type: string };
    expect(video._type).toBe('video');
    expect(toMediaInfo(read('tests/fixtures/info-video.json')).title).toBe('Recorded Fixture Video');
  });

  it('NEVER spawns a process or uses the network (static source scan)', () => {
    const mapper = readFileSync(join(ROOT, 'packages/engine-ytdlp/src/json-mapper.ts'), 'utf8');
    const gatewaySource = readFileSync(join(ROOT, 'apps/desktop/src/main/ipc-gateway.ts'), 'utf8');
    for (const source of [mapper, gatewaySource]) {
      expect(source).not.toMatch(/from\s+['"]node:child_process['"]/);
      expect(source).not.toMatch(/from\s+['"]child_process['"]/);
      expect(source).not.toMatch(/from\s+['"]node:https?['"]/);
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/spawnSync|spawnStreaming/);
    }
  });
});

describe('A-4.1-05 · M3 IpcGateway L1 fixture handlers', () => {
  it('PROBE_PLAYLIST returns the recorded PlaylistInfo with no url keys', async () => {
    const result = await gateway.dispatch(IPC_CHANNELS.PROBE_PLAYLIST, { url: 'https://example.org/list' });
    const info = result as { _type: string; entries: unknown[] };
    expect(info._type).toBe('playlist');
    expect(info.entries).toHaveLength(3);
    expect(hasUrlKey(result)).toBe(false);
    // NOTE: `_type: "url"` is a legitimate yt-dlp discriminator, so we match
    // the JSON *key* form (`"url":`) rather than the bare substring.
    expect(JSON.stringify(result)).not.toContain('"url":');
  });

  it('PROBE returns a MediaInfo without any credential-bearing url fields', async () => {
    const result = await gateway.dispatch(IPC_CHANNELS.PROBE, { url: 'https://example.org/v' });
    expect((result as { title: string }).title).toBe('Recorded Fixture Video');
    expect(hasUrlKey(result)).toBe(false);
    expect(omitUrl({ formats: [{ url: 'secret' }], keep: 1 })).toEqual({ formats: [{}], keep: 1 });
  });

  it('rejects payload keys outside the channel whitelist', () => {
    expect(() => validatePayload(IPC_CHANNELS.PROBE, { url: 'x', evil: 1 })).toThrow(/not allowed/);
    expect(() => validatePayload('ytvdlt:unknown', {})).toThrow(/unregistered channel/);
    expect(() => validatePayload(IPC_CHANNELS.PROBE, null)).toThrow(/must be an object/);
  });

  it('playlist DIALOG_CONFIRM must not carry a requestPatch (A-M3-04 / D-38)', async () => {
    await expect(gateway.dispatch(IPC_CHANNELS.DIALOG_CONFIRM, {
      kind: 'playlist', confirmed: true, state: 'ready', selectedPlaylistIds: ['a1'],
      requestPatch: { format: {} },
    })).rejects.toThrow(/must not carry a requestPatch/);
    const ok = await gateway.dispatch(IPC_CHANNELS.DIALOG_CONFIRM, {
      kind: 'playlist', confirmed: true, state: 'ready', selectedPlaylistIds: ['a1'],
    });
    expect(ok).toEqual({ accepted: true, persisted: true, enqueued: false });
  });

  it('registers all M3 + M4-4 channels and exposes only frozen channels via the preload bridge', async () => {
    const registered: string[] = [];
    const count = registerIpcGateway(gateway, {
      register(channel: string): void { registered.push(channel); },
    });
    // 7 M3 channels + 1 M4-4 batch-enqueue channel (append-only).
    expect(count).toBe(8);
    expect(registered).toContain(IPC_CHANNELS.PROBE_PLAYLIST);
    expect(registered).toContain(IPC_CHANNELS.DIALOG_CONFIRM);
    expect(registered).toContain(IPC_CHANNELS.PLAYLIST_ENQUEUE);

    const seen: string[] = [];
    const api = createBridgeApi({ invoke: async (channel: string) => { seen.push(channel); return null; } });
    expect(BRIDGE_CHANNELS).toContain(IPC_CHANNELS.PATH_PREVIEW);
    await api.invoke(IPC_CHANNELS.PATH_PREVIEW, {});
    await expect(api.invoke('ytvdlt:evil', {})).rejects.toThrow(/not whitelisted/);
    expect(seen).toEqual([IPC_CHANNELS.PATH_PREVIEW]);
  });
});
