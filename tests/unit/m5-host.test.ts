/**
 * M5-0 · host composition (A-M5-00).
 *
 * Verifies that `createM5Host()` really merges the M3 fixture gateway and the M5
 * service gateway into ONE registrable surface, that the live services answer
 * through it, and that a duplicate channel is a hard error (never a silent
 * override).
 */
import { describe, it, expect } from 'vitest';
import type {
  DownloadEngine, DownloadRequest, EngineEvent, TaskRecord, VerificationReport,
} from '@ytvdlt/shared';
import { IPC_CHANNELS } from '@ytvdlt/shared';
import type { IArtifactVerifier } from '@ytvdlt/core';
import { createM5Host, mergeGateways } from '../../apps/desktop/src/main/m5-host.js';
import { createIpcGateway, type IpcGateway } from '../../apps/desktop/src/main/ipc-gateway.js';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const record = (id: string): TaskRecord => ({
  id,
  url: 'https://example.org/watch?v=abc&token=SECRET',
  kind: 'video',
  state: 'Running',
  createdAt: '2026-11-06T00:00:00.000Z',
  updatedAt: '2026-11-06T00:00:00.000Z',
  mediaInfo: null,
  request: null,
  artifacts: [],
  lastPercent: 7,
  error: null,
  privateMode: false,
  postprocessed: false,
});

const engine: DownloadEngine = {
  async version() { return '2026.11.06'; },
  async probe() { throw new Error('not used'); },
  async probePlaylist() { throw new Error('not used'); },
  download(request: DownloadRequest, onEvent: (event: EngineEvent) => void) {
    queueMicrotask(() => {
      onEvent({ type: 'canceled', taskId: request.taskId });
    });
    return { pid: 1, cancel: async () => true };
  },
  async selfUpdate() {
    return { fromVersion: '', toVersion: '', channel: 'stable', changed: false };
  },
};

const verifier: IArtifactVerifier = {
  async verify(): Promise<VerificationReport> {
    return {
      taskId: 'x', artifacts: [], postprocessed: false, criteria: [],
      ok: true, failureCode: null, durationMs: 1,
    };
  },
};

async function host() {
  const ports = createInMemoryPorts();
  const built = await createM5Host({
    ports: ports.ports,
    engine,
    verifier,
    jsRuntimePath: 'C:/runtime/node.exe',
    videoFixturePath: 'C:/fixtures/info-video.json',
    playlistFixturePath: 'C:/fixtures/info-flat-playlist.json',
    appVersion: '0.1.0',
    engineVersion: '2026.11.06',
    systemAppearance: {
      prefersDark: () => true,
      prefersReducedMotion: () => false,
      accent: () => '#0f6b64',
    },
  });
  return { built, ports };
}

describe('m5 host · gateway composition', () => {
  it('registers the M3 fixture channels AND the eight M5 channels', async () => {
    const { built } = await host();
    const channels = [...built.gateway.handlers.keys()];
    for (const channel of [
      IPC_CHANNELS.PROBE, IPC_CHANNELS.PROBE_PLAYLIST, IPC_CHANNELS.DIALOG_OPEN,
      IPC_CHANNELS.DIALOG_CONFIRM, IPC_CHANNELS.PATH_PREVIEW, IPC_CHANNELS.CONFIG_GET,
      IPC_CHANNELS.CONFIG_SET, IPC_CHANNELS.PLAYLIST_ENQUEUE,
    ]) {
      expect(channels).toContain(channel);
    }
    for (const channel of built.channels) expect(channels).toContain(channel);
    // 11 (M5) + the four 0.2.1 channels (D-93 / D-94 / D-98) + THUMBNAIL_CACHE (D-103).
    expect(built.channels).toHaveLength(17);
    expect(new Set(channels).size).toBe(channels.length);
    built.dispose();
  });

  it('refuses to merge two gateways that claim the same channel', () => {
    const make = (channel: string): IpcGateway => createIpcGateway({
      readText: async () => '{}',
      videoFixturePath: 'x',
      playlistFixturePath: 'y',
    });
    const a = make(IPC_CHANNELS.PROBE);
    const duplicate: IpcGateway = {
      handlers: new Map(a.handlers),
      dispatch: a.dispatch,
      registerAll: a.registerAll,
    };
    expect(() => mergeGateways(a, duplicate)).toThrow(/duplicate channel/);
  });
});

describe('m5 host · live services behind the gateway', () => {
  it('serves the task list without a URL and with tab counts', async () => {
    const { built } = await host();
    await built.m4.task.queue.enqueue(record('t-alpha'));
    const list = await built.gateway.dispatch(IPC_CHANNELS.TASK_LIST, { tab: 'all' }) as {
      counts: Record<string, number>; items: Record<string, unknown>[];
    };
    expect(list.counts['all']).toBe(1);
    expect(list.items[0]?.['id']).toBe('t-alpha');
    expect(Object.keys(list.items[0] ?? {})).not.toContain('url');
    expect(JSON.stringify(list)).not.toContain('SECRET');
    built.dispose();
  });

  it('persists appearance settings through ConfigStore', async () => {
    const { built } = await host();
    const updated = await built.gateway.dispatch(IPC_CHANNELS.SETTINGS_SET, { theme: 'light', accent: '#123456' }) as {
      theme: string; accent: { kind: string; value: string };
    };
    expect(updated.theme).toBe('light');
    expect(updated.accent).toEqual({ kind: 'hex', value: '#123456' });
    const read = await built.appearance();
    expect(read.theme).toBe('light');
    expect(read.prefersDark).toBe(true);
    built.dispose();
  });

  it('routes task actions to the M4 detail service', async () => {
    const { built } = await host();
    const result = await built.gateway.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 'missing', action: 'cancel' }) as {
      ok: boolean; code: string;
    };
    expect(result.ok).toBe(false);
    expect(result.code).toBe('TASK_MISSING');
    built.dispose();
  });

  it('reuses the M4 command template store', async () => {
    const { built } = await host();
    await built.gateway.dispatch(IPC_CHANNELS.TEMPLATE_SAVE, { name: 'audio only', args: ['-f', 'bestaudio', '--merge-output-format', 'mkv'] });
    const listed = await built.gateway.dispatch(IPC_CHANNELS.TEMPLATE_LIST, {}) as { templates: { name: string }[] };
    expect(listed.templates.map((template) => template.name)).toEqual(['audio only']);
    expect(built.m4.commandTemplates.list()).toHaveLength(1);
    built.dispose();
  });

  it('keeps dispatching unknown channels as an error', async () => {
    const { built } = await host();
    await expect(built.gateway.dispatch('ytvdlt:does-not-exist', {})).rejects.toThrow(/unregistered channel/);
    built.dispose();
  });
});

describe('m5 host · about box payload', () => {
  it('reports version, runtime dirs and the LGPL-3.0 licence without touching electron', async () => {
    const { built } = await host();
    const info = built.aboutInfo();
    expect(info.appVersion).toBe('0.1.0');
    expect(info.runtimeDir).toBe('C:/runtime');
    expect(info.runtime).toEqual(['yt-dlp', 'node', 'ffmpeg']);
    expect(info.license).toBe('LGPL-3.0');
    expect(info.dataDirReason).toBe('');
    built.dispose();
  });

  it('exposes the resolved data dir and why it won', async () => {
    const ports = createInMemoryPorts();
    const built = await createM5Host({
      ports: ports.ports,
      engine,
      verifier,
      jsRuntimePath: 'C:/runtime/node.exe',
      videoFixturePath: 'C:/fixtures/info-video.json',
      playlistFixturePath: 'C:/fixtures/info-flat-playlist.json',
      appVersion: '0.1.0',
      engineVersion: '2026.11.06',
      dataDir: 'D:/YTVDLT',
      dataDirReason: 'exe 目录可写 → 便携模式（配置与 exe 同目录）',
      systemAppearance: { prefersDark: () => false, prefersReducedMotion: () => false, accent: () => null },
    });
    const info = built.aboutInfo();
    expect(info.dataDir).toBe('D:/YTVDLT');
    expect(info.dataDirReason).toContain('便携');
    built.dispose();
  });

  it('falls back to the env port when no explicit data dir was injected', async () => {
    const ports = createInMemoryPorts();
    const built = await createM5Host({
      ports: ports.ports,
      engine,
      verifier,
      jsRuntimePath: 'C:/runtime/node.exe',
      videoFixturePath: 'C:/fixtures/info-video.json',
      playlistFixturePath: 'C:/fixtures/info-flat-playlist.json',
      appVersion: '0.1.0',
      engineVersion: '2026.11.06',
      systemAppearance: { prefersDark: () => false, prefersReducedMotion: () => false, accent: () => null },
    });
    expect(built.aboutInfo().dataDir).toBe(ports.ports.env.appDataDir());
    built.dispose();
  });
});
