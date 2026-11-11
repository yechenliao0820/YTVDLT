/**
 * L2 · REAL bundled yt-dlp against a 127.0.0.1 HTML page.
 *
 * No mock engine, no fixture JSON, no international network: `YtDlpEngine`
 * spawns the shipped `yt-dlp.exe`, which parses a locally served page with N
 * `<video src>` tags into a flat playlist. Verified against the shipped
 * 2026.10.26 binary. This proves the LIVE probe path, not a unit-level fake.
 *
 * The page is served by this file's own tiny HTTP server so the entry URLs
 * can contain the dynamic port.
 */
import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { PlaylistInfo } from '@ytvdlt/shared';
import { PlaylistPreviewService } from '../../../apps/desktop/src/main/playlist-preview-service.js';
import {
  createL2Context, NODE_EXE, type L2Context,
} from '../helpers/l2-harness.js';

interface PageServer {
  readonly base: string;
  readonly close: () => Promise<void>;
  readonly urls: readonly string[];
}

async function startPageServer(count: number): Promise<PageServer> {
  let base = '';
  let html = '';
  const server: Server = createServer((request, response) => {
    const path = String(request.url ?? '').split('?')[0];
    if (path === '/videos.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }
    if (/^\/v\d+\.mp4$/.test(path)) {
      // A flat playlist probe only needs the URL to exist; no media bytes are
      // downloaded here (the real engine still validates the URL).
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '0' });
      response.end();
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  const urls = Array.from({ length: count }, (_v, i) => `${base}/v${i + 1}.mp4`);
  html = `<html><head><title>Local Playlist ${count}</title></head><body>`
    + urls.map((url, i) => `<video src="${url}" title="Episode ${i + 1}"></video>`).join('\n')
    + '</body></html>';
  return {
    base,
    urls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function withContext(): Promise<L2Context> {
  return createL2Context('playlist-probe-local');
}

describe('playlist-probe-local · real yt-dlp, local HTTP source', () => {
  it('probes a 3-entry page into a real flat PlaylistInfo', async () => {
    const server = await startPageServer(3);
    const ctx = await withContext();
    try {
      const info = await ctx.engine.probePlaylist(`${server.base}/videos.html`, {
        jsRuntimePath: NODE_EXE, noPlaylist: false, flatPlaylist: true,
      });
      expect(info._type).toBe('playlist');
      expect(info.title).toBe('Local Playlist 3');
      expect(info.entries).toHaveLength(3);
      expect(info.entries.every((entry) => entry.url.startsWith('http://127.0.0.1:'))).toBe(true);
      expect(info.entries.every((entry) => entry.id !== '')).toBe(true);
      expect(ctx.ports.env.platform()).toBeTruthy(); // real ports, not a fake
    } finally {
      await server.close();
      await ctx.cleanup();
    }
  }, 90_000);

  it('probes a 65-entry collection without truncating to the first few', async () => {
    const server = await startPageServer(65);
    const ctx = await withContext();
    try {
      const info = await ctx.engine.probePlaylist(`${server.base}/videos.html`, {
        jsRuntimePath: NODE_EXE, noPlaylist: false, flatPlaylist: true,
      });
      expect(info.entries).toHaveLength(65);
      expect(new Set(info.entries.map((entry) => entry.url)).size).toBe(65);
      expect(info.entries[0]?.url).toBe(server.urls[0]);
      expect(info.entries[64]?.url).toBe(server.urls[64]);
    } finally {
      await server.close();
      await ctx.cleanup();
    }
  }, 120_000);

  it('feeds the REAL probe into PlaylistPreviewService → safe 65-row DTO', async () => {
    const server = await startPageServer(65);
    const ctx = await withContext();
    try {
      const service = new PlaylistPreviewService({
        probe: (url) => ctx.engine.probePlaylist(url, {
          jsRuntimePath: NODE_EXE, noPlaylist: false, flatPlaylist: true,
        }),
        clock: { nowEpochMs: () => 1_000 },
        newId: () => 'preview-ticket-live-0001',
      });
      const dto = await service.preview(`${server.base}/videos.html`);
      expect(dto.ok).toBe(true);
      expect(dto.fetchedCount).toBe(65);
      expect(dto.availableCount).toBe(65);
      expect(dto.unavailableCount).toBe(0);
      expect(dto.entries).toHaveLength(65);
      expect(dto.entries[0]?.position).toBe(1);
      expect(dto.entries[64]?.position).toBe(65);
      // The live probe's entry URLs must NOT cross into the renderer DTO.
      expect(JSON.stringify(dto)).not.toContain('127.0.0.1');
      expect(JSON.stringify(dto)).not.toContain('/v1.mp4');

      const consumed = service.consume(dto.previewId, `${server.base}/videos.html`);
      expect(consumed.ok).toBe(true);
      expect(consumed.playlist?.entries).toHaveLength(65);
      expect((consumed.playlist as PlaylistInfo | undefined)?.entries[0]?.url)
        .toBe(server.urls[0]);
      expect(service.consume(dto.previewId, `${server.base}/videos.html`).ok).toBe(false);
    } finally {
      await server.close();
      await ctx.cleanup();
    }
  }, 120_000);

  it('a single-video URL is rejected by the real engine (not shown as an empty playlist)', async () => {
    const server = await startPageServer(1);
    const ctx = await withContext();
    try {
      await expect(ctx.engine.probePlaylist(`${server.base}/v1.mp4`, {
        jsRuntimePath: NODE_EXE, noPlaylist: false, flatPlaylist: true,
      })).rejects.toBeTruthy();
    } finally {
      await server.close();
      await ctx.cleanup();
    }
  }, 90_000);

  it('an unsupported local path fails with an error, never a fake playlist', async () => {
    const server = await startPageServer(1);
    const ctx = await withContext();
    try {
      await expect(ctx.engine.probePlaylist(`${server.base}/missing.html`, {
        jsRuntimePath: NODE_EXE, noPlaylist: false, flatPlaylist: true,
      })).rejects.toBeTruthy();
    } finally {
      await server.close();
      await ctx.cleanup();
    }
  }, 90_000);
});
