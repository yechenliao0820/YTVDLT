/**
 * M5-5 follow-up · HTTP update source (D-67).
 *
 * The feed is a plain directory: `SHA2-256SUMS` + one binary per component.
 * These cases pin the URL shape (trailing slashes, no double slashes) and that
 * transport errors propagate instead of being turned into empty bytes — the
 * caller must be able to tell "no update" from "network broken".
 */
import { describe, expect, it } from 'vitest';
import { HttpUpdateSource } from '@ytvdlt/engine-ytdlp';
import type { HttpFetchOptions, HttpPort } from '@ytvdlt/shared';

function recorder(behaviour: { failText?: boolean; failBytes?: boolean } = {}) {
  const calls: string[] = [];
  const optsSeen: (HttpFetchOptions | undefined)[] = [];
  const http: HttpPort = {
    async getText(url: string, opts?: HttpFetchOptions) {
      calls.push(`text:${url}`);
      optsSeen.push(opts);
      if (behaviour.failText === true) throw new Error('HTTP 404');
      return 'deadbeef  yt-dlp.exe';
    },
    async getBytes(url: string, opts?: HttpFetchOptions) {
      calls.push(`bytes:${url}`);
      optsSeen.push(opts);
      if (behaviour.failBytes === true) throw new Error('HTTP 500');
      return new Uint8Array([1, 2, 3]);
    },
  };
  return { http, calls, optsSeen };
}

describe('D-67 · HttpUpdateSource', () => {
  it('reads the manifest and the binary from the same directory', async () => {
    const { http, calls } = recorder();
    const source = new HttpUpdateSource({ baseUrl: 'https://feed.example.org/c', fileName: 'yt-dlp.exe', http });
    expect(await source.fetchChecksums()).toContain('yt-dlp.exe');
    expect(await source.fetchEngineBinary()).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls).toEqual([
      'text:https://feed.example.org/c/SHA2-256SUMS',
      'bytes:https://feed.example.org/c/yt-dlp.exe',
    ]);
  });

  it('normalises trailing and leading slashes', async () => {
    const { http, calls } = recorder();
    const source = new HttpUpdateSource({ baseUrl: 'https://feed.example.org/c///', fileName: '/aria2c.exe', http });
    await source.fetchChecksums();
    await source.fetchEngineBinary();
    expect(calls).toEqual([
      'text:https://feed.example.org/c/SHA2-256SUMS',
      'bytes:https://feed.example.org/c/aria2c.exe',
    ]);
  });

  it('honours a custom manifest name', async () => {
    const { http, calls } = recorder();
    const source = new HttpUpdateSource({
      baseUrl: 'https://feed.example.org', fileName: 'yt-dlp.exe', http, checksumsName: 'SUMS.txt',
    });
    await source.fetchChecksums();
    expect(calls[0]).toBe('text:https://feed.example.org/SUMS.txt');
  });

  it('propagates transport errors instead of returning empty data', async () => {
    const broken = recorder({ failText: true, failBytes: true });
    const source = new HttpUpdateSource({ baseUrl: 'https://feed.example.org', fileName: 'yt-dlp.exe', http: broken.http });
    await expect(source.fetchChecksums()).rejects.toThrow(/404/);
    await expect(source.fetchEngineBinary()).rejects.toThrow(/500/);
  });

  it('declares itself as the official-release kind', () => {
    const { http } = recorder();
    expect(new HttpUpdateSource({ baseUrl: 'https://x', fileName: 'y', http }).kind).toBe('official-release');
  });
});

describe('component-update hardening · policy forwarding', () => {
  it('forwards a caller URL policy to BOTH the manifest and the binary fetch', async () => {
    const { http, calls, optsSeen } = recorder();
    // The shape `component-updater.ts` passes for an official GitHub feed.
    const policy = (raw: string): boolean => raw.startsWith('https://github.com/');
    const base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
    const source = new HttpUpdateSource({ baseUrl: base, fileName: 'yt-dlp.exe', http, urlPolicy: policy });
    await source.fetchChecksums();
    await source.fetchEngineBinary();
    expect(calls).toEqual([
      `text:${base}/SHA2-256SUMS`,
      `bytes:${base}/yt-dlp.exe`,
    ]);
    // The predicate must arrive verbatim — pitfall 29's "channel exists, policy
    // not wired" is exactly what this pins down.
    expect(optsSeen[0]?.urlPolicy).toBe(policy);
    expect(optsSeen[1]?.urlPolicy).toBe(policy);
  });

  it('sends policy-free options for a mirror source — the explicit port-default mode', async () => {
    const { http, optsSeen } = recorder();
    const source = new HttpUpdateSource({
      baseUrl: 'http://nas.local/yt-dlp-mirror', fileName: 'yt-dlp.exe', http,
    });
    await source.fetchChecksums();
    await source.fetchEngineBinary();
    // No urlPolicy anywhere: the port's bounded permissive transport IS the
    // mirror policy (see component-updater.ts). The empty options object is the
    // deliberate decision, asserted here so "forgot the policy" cannot pose as
    // the mirror mode.
    expect(optsSeen[0]).toEqual({});
    expect(optsSeen[1]).toEqual({});
  });
});
