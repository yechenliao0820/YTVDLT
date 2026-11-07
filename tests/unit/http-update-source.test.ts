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
import type { HttpPort } from '@ytvdlt/shared';

function recorder(behaviour: { failText?: boolean; failBytes?: boolean } = {}) {
  const calls: string[] = [];
  const http: HttpPort = {
    async getText(url: string) {
      calls.push(`text:${url}`);
      if (behaviour.failText === true) throw new Error('HTTP 404');
      return 'deadbeef  yt-dlp.exe';
    },
    async getBytes(url: string) {
      calls.push(`bytes:${url}`);
      if (behaviour.failBytes === true) throw new Error('HTTP 500');
      return new Uint8Array([1, 2, 3]);
    },
  };
  return { http, calls };
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
