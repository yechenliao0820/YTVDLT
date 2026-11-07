/**
 * M5-5 follow-up · component updater (D-67).
 *
 * Covers the part that is easy to get wrong: an update round must survive one
 * component failing, must not run twice at the same time, and must say "no feed"
 * instead of throwing when the build ships without one.
 */
import { describe, it, expect } from 'vitest';
import { Logger } from '@ytvdlt/core';
import type { CorePorts, HttpPort } from '@ytvdlt/shared';
import {
  createComponentUpdater, normalizeVersion, type ComponentSpec,
} from '../../apps/desktop/src/main/component-updater.js';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const YTDLP_BYTES = new TextEncoder().encode('ytdlp-v2');
const ARIA_BYTES = new TextEncoder().encode('aria2-v2');

function fakeHttp(behaviour: {
  failBytesFor?: string;
  delayMs?: number;
} = {}): HttpPort & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getText(url: string) {
      calls.push(`text:${url}`);
      if (url.endsWith('SHA2-256SUMS')) {
        const lines = [
          `${'a'.repeat(64)}  yt-dlp.exe`,
          `${'b'.repeat(64)}  aria2c.exe`,
        ];
        return lines.join('\n');
      }
      throw new Error(`unexpected text url ${url}`);
    },
    async getBytes(url: string) {
      calls.push(`bytes:${url}`);
      if (behaviour.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
      }
      if (behaviour.failBytesFor !== undefined && url.endsWith(behaviour.failBytesFor)) {
        throw new Error('ECONNRESET');
      }
      return url.endsWith('aria2c.exe') ? ARIA_BYTES : YTDLP_BYTES;
    },
  };
}

async function setup(behaviour: Parameters<typeof fakeHttp>[0] = {}) {
  const mem = createInMemoryPorts();
  const http = fakeHttp(behaviour);
  const ports: CorePorts = { ...mem.ports, http };
  const logger = new Logger({ ports, appVersion: '0.1.0' });

  // The feed's checksums must match the bytes we serve, otherwise every update
  // is (correctly) refused before touching the disk.
  const ytdlpHash = await mem.ports.hash.sha256Bytes(YTDLP_BYTES);
  const ariaHash = await mem.ports.hash.sha256Bytes(ARIA_BYTES);
  http.getText = async (url: string) => {
    if (url.endsWith('SHA2-256SUMS')) return `${ytdlpHash}  yt-dlp.exe\n${ariaHash}  aria2c.exe`;
    throw new Error(`unexpected text url ${url}`);
  };

  mem.state.bytes.set('C:/runtime/yt-dlp.exe', new TextEncoder().encode('ytdlp-v1'));
  mem.state.bytes.set('C:/runtime/aria2c.exe', new TextEncoder().encode('aria2-v1'));
  mem.state.spawnResults.set('yt-dlp.exe', { exitCode: 0, stdout: '2026.10.26\n', stderr: '', timedOut: false });
  mem.state.spawnResults.set('aria2c.exe', { exitCode: 0, stdout: 'aria2 version 1.35.0\n', stderr: '', timedOut: false });

  const components: ComponentSpec[] = [
    { id: 'yt-dlp', label: 'yt-dlp', fileName: 'yt-dlp.exe', path: 'C:/runtime/yt-dlp.exe' },
    { id: 'aria2c', label: 'aria2c', fileName: 'aria2c.exe', path: 'C:/runtime/aria2c.exe' },
  ];
  return { mem, http, logger, ports, components };
}

describe('D-67 · normalizeVersion', () => {
  it('extracts a dotted version from either tool', () => {
    expect(normalizeVersion('2026.10.26\n')).toBe('2026.10.26');
    expect(normalizeVersion('aria2 version 1.35.0\nCopyright…')).toBe('1.35.0');
    expect(normalizeVersion('')).toBe('');
  });
});

describe('D-67 · status', () => {
  it('reports both components with their installed versions', async () => {
    const { ports, logger, components } = await setup();
    const updater = createComponentUpdater({
      ports, logger, components, baseUrl: 'https://feed.example.org/c/', intakeGate: null,
    });
    const status = await updater.status();
    expect(status.source).toBe('https://feed.example.org/c/');
    expect(status.updating).toBe(false);
    expect(status.components.map((item) => `${item.id}:${item.installed}:${item.version}`)).toEqual([
      'yt-dlp:true:2026.10.26',
      'aria2c:true:1.35.0',
    ]);
  });

  it('marks a missing component as not installed instead of failing', async () => {
    const { mem, ports, logger } = await setup();
    mem.state.bytes.delete('C:/runtime/aria2c.exe');
    const updater = createComponentUpdater({
      ports, logger, baseUrl: 'https://feed.example.org', intakeGate: null,
      components: [
        { id: 'yt-dlp', label: 'yt-dlp', fileName: 'yt-dlp.exe', path: 'C:/runtime/yt-dlp.exe' },
        { id: 'aria2c', label: 'aria2c', fileName: 'aria2c.exe', path: 'C:/runtime/aria2c.exe' },
      ],
    });
    const status = await updater.status();
    expect(status.components[1]).toMatchObject({ id: 'aria2c', installed: false, version: '' });
  });

  it('reports a null source when the build has no feed', async () => {
    const { ports, logger, components } = await setup();
    const updater = createComponentUpdater({ ports, logger, components, baseUrl: null, intakeGate: null });
    expect((await updater.status()).source).toBeNull();
  });
});

describe('D-67 · run', () => {
  it('refuses early when no feed is configured (no network at all)', async () => {
    const { ports, logger, components, http } = await setup();
    const updater = createComponentUpdater({ ports, logger, components, baseUrl: null, intakeGate: null });
    const result = await updater.run();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('未配置');
    expect(http.calls).toEqual([]);
  });

  it('updates both components in one pass', async () => {
    const { mem, ports, logger, components } = await setup();
    const updater = createComponentUpdater({
      ports, logger, components, baseUrl: 'https://feed.example.org/', intakeGate: null,
    });
    const result = await updater.run();
    expect(result.ok).toBe(true);
    expect(result.results.map((item) => item.changed)).toEqual([true, true]);
    expect(result.results.map((item) => `${item.label}:${item.changed}:${item.fromVersion}->${item.toVersion}`)).toEqual([
      'yt-dlp:true:2026.10.26->2026.10.26',
      'aria2c:true:1.35.0->1.35.0',
    ]);
    expect(new TextDecoder().decode(mem.state.bytes.get('C:/runtime/yt-dlp.exe'))).toBe('ytdlp-v2');
    expect(new TextDecoder().decode(mem.state.bytes.get('C:/runtime/aria2c.exe'))).toBe('aria2-v2');
    expect(mem.state.bytes.has('C:/runtime/yt-dlp.exe.bak')).toBe(false);
    expect(mem.state.bytes.has('C:/runtime/aria2c.exe.bak')).toBe(false);
  });

  it('keeps going when one component fails, and marks only that one', async () => {
    const { mem, ports, logger, components } = await setup({ failBytesFor: 'aria2c.exe' });
    const updater = createComponentUpdater({
      ports, logger, components, baseUrl: 'https://feed.example.org', intakeGate: null,
    });
    const result = await updater.run();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('1/2');
    expect(result.results[0]).toMatchObject({ id: 'yt-dlp', changed: true, error: null });
    // SelfUpdater refuses instead of throwing, so the failure shows up as a reason.
    expect(result.results[1]).toMatchObject({ id: 'aria2c', changed: false, reason: 'download-failed', error: null });
    // yt-dlp still got updated; aria2c kept its old bytes.
    expect(new TextDecoder().decode(mem.state.bytes.get('C:/runtime/yt-dlp.exe'))).toBe('ytdlp-v2');
    expect(new TextDecoder().decode(mem.state.bytes.get('C:/runtime/aria2c.exe'))).toBe('aria2-v1');
  });

  it('never runs two rounds at once', async () => {
    const { ports, logger, components } = await setup({ delayMs: 30 });
    const updater = createComponentUpdater({
      ports, logger, components, baseUrl: 'https://feed.example.org', intakeGate: null,
    });
    const first = updater.run();
    const second = await updater.run();
    expect(second.ok).toBe(false);
    expect(second.reason).toContain('正在进行');
    expect((await first).ok).toBe(true);
  });
});
