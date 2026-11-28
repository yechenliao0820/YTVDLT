/**
 * L2 `categorized-dir-local` · D-275 (external audit P2, 2026-11-22 round).
 *
 * REAL yt-dlp against the 127.0.0.1 fixture server, with
 * `subdirByExtractor` / `subdirByPlaylist` ON. This closes what D-273's
 * 「未覆盖」 registered and what the audit explicitly asked for: the FINAL
 * on-disk path is verified, not just the plan strings.
 *
 * The engine's `-P` handler (`get_output_path()`) only expands environment
 * variables — output-template FIELD substitution happens exclusively on the
 * `-o` path. The old plan therefore created literal `%(...)s` directories; the
 * fixed plan must land the file under a REAL `<Extractor>/` layer (the
 * playlist layer collapses for a single video thanks to the
 * `%(playlist|.)s` relative default — never an `NA` directory and never a
 * leading separator, D-290).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { startMockServer } from '../helpers/mock-server.js';
import {
  createL2Context, buildRequest, makeRecord, waitFor, FIXTURE, NODE_EXE,
} from '../helpers/l2-harness.js';
import { buildPlaylistBatchRecordsByUrl } from '@ytvdlt/core';
import type { DownloadRequest } from '@ytvdlt/shared';

describe('categorized-dir-local · D-275 real yt-dlp final path', () => {
  it('lands the file under a real <Extractor>/ layer; no literal %(…)s directory, no NA layer', async () => {
    const ctx = await createL2Context('categorized-dir-local', null);
    const server = await startMockServer(FIXTURE);
    try {
      const req = buildRequest('categorized-dir-1', server.url, ctx);
      const categorized: DownloadRequest = {
        ...req,
        paths: { ...req.paths, subdirByExtractor: true, subdirByPlaylist: true },
      };
      await ctx.queue.enqueue(makeRecord(categorized));
      await waitFor(() => ctx.queue.get(categorized.taskId)?.state === 'Completed', 90_000, 'Completed');

      const record = ctx.queue.get(categorized.taskId);
      expect(record?.state).toBe('Completed');
      expect(record?.artifacts.length).toBeGreaterThan(0);

      const raw = record!.artifacts[0]!;
      const artifact = raw.replace(/\\/g, '/');
      const root = ctx.outDir.replace(/\\/g, '/').replace(/\/+$/, '');
      // The `-P` root is still the output directory…
      expect(artifact.startsWith(`${root}/`)).toBe(true);
      // …and the extractor layer is REAL (`extractor_key = 'Generic'` for the
      // fixture page, pinned the same way lowest-quality-local does).
      expect(artifact).toContain('/Generic/');
      // No literal template token ever reached the filesystem.
      expect(artifact).not.toContain('%(');
      expect(existsSync(join(ctx.outDir, '%(extractor_key)s'))).toBe(false);
      expect(existsSync(join(ctx.outDir, '%(extractor_key)s', '%(playlist)s'))).toBe(false);
      // A single video has no playlist: the empty default collapses the layer
      // instead of rendering the engine's NA placeholder directory.
      expect(artifact).not.toContain('/NA/');
      // The bytes really are on disk at the recorded path.
      const stat = await ctx.ports.fs.stat(raw);
      expect(stat.sizeBytes).toBeGreaterThan(0);
    } finally {
      await server.close();
      await ctx.cleanup();
    }
  }, 120_000);

  /**
   * D-290 regression: `subdirByPlaylist` ON, `subdirByExtractor` OFF, TRUE
   * single video (a direct media URL — GenericIE reports no playlist field).
   *
   * With the old `%(playlist|)s` empty default the rendered `-o` value started
   * with `/`, which yt-dlp reads as an ABSOLUTE path: `-P <outDir>` was
   * bypassed and the file landed in the DRIVE ROOT. The containment gate then
   * rejected it and the task failed after a full download. The `.` default
   * keeps the template relative.
   */
  it('D-290 · single video + playlist layer only stays inside the output dir (no drive-root escape)', async () => {
    const ctx = await createL2Context('categorized-dir-local', null);
    const server = await startMockServer(FIXTURE);
    try {
      const req = buildRequest('categorized-dir-2', server.url, ctx);
      const playlistOnly: DownloadRequest = {
        ...req,
        paths: { ...req.paths, subdirByExtractor: false, subdirByPlaylist: true },
      };
      await ctx.queue.enqueue(makeRecord(playlistOnly));
      await waitFor(() => ctx.queue.get(playlistOnly.taskId)?.state === 'Completed', 90_000, 'Completed');

      const record = ctx.queue.get(playlistOnly.taskId);
      expect(record?.state).toBe('Completed');
      const artifact = (record?.artifacts[0] ?? '').replace(/\\/g, '/');
      const root = ctx.outDir.replace(/\\/g, '/').replace(/\/+$/, '');
      expect(artifact.startsWith(`${root}/`)).toBe(true);
      // The single video has no playlist layer: the file sits DIRECTLY in the
      // output dir, not in a subdirectory (and certainly not on `C:/`).
      expect(artifact.slice(0, artifact.lastIndexOf('/'))).toBe(root);
      expect(existsSync(join(ctx.outDir, '%(playlist|)s'))).toBe(false);
    } finally {
      await server.close();
      await ctx.cleanup();
    }
  }, 120_000);

  /**
   * P2 fix · the production playlist-batch path (PLAYLIST_PREVIEW →
   * BATCH_ENQUEUE): `buildPlaylistBatchRecordsByUrl` gives every entry its own
   * URL and `--no-playlist`, so yt-dlp never had playlist context and the
   * `%(playlist|.)s` layer collapsed — the batch landed flat in `outDir` even
   * with `subdirByPlaylist` on. The batch now bakes the playlist title as a
   * LITERAL directory layer into each record's output template at record time.
   *
   * FULL real chain, zero network: a locally served playlist page → REAL
   * `probePlaylist` (shipped yt-dlp parses it into a flat PlaylistInfo with
   * entry URLs) → REAL `buildPlaylistBatchRecordsByUrl` → REAL downloads
   * through the queue → the artifacts must sit DIRECTLY under
   * `<outDir>/<Sanitized_Title>/`.
   */
  it('P2 fix · real playlist batch lands under <outDir>/<playlist title>/', async () => {
    const ctx = await createL2Context('categorized-dir-local', null);
    // The playlist page needs the DYNAMIC port inside its `<video src>` entry
    // URLs, so (like playlist-probe-local) this case runs its own tiny server:
    // the page is built after binding, and the entry URLs serve the real
    // fixture bytes so the batch downloads actual media. 127.0.0.1 only.
    const fixtureBytes = readFileSync(FIXTURE);
    const server: import('node:http').Server = createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname === '/videos.html') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(page);
        return;
      }
      if (/^\/v\d+\.mp4$/.test(pathname)) {
        response.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': String(fixtureBytes.length),
          'Accept-Ranges': 'none',
        });
        response.end(fixtureBytes);
        return;
      }
      response.writeHead(404);
      response.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;
    const page = '<html><head><title>Local Batch Playlist</title></head><body>'
      + ['v1', 'v2'].map((name) => `<video src="${base}/${name}.mp4"></video>`).join('\n')
      + '</body></html>';
    const urlFor = (path: string): string => `${base}${path}`;
    try {
      const info = await ctx.engine.probePlaylist(urlFor('/videos.html'), {
        jsRuntimePath: NODE_EXE, noPlaylist: false, flatPlaylist: true,
      });
      expect(info._type).toBe('playlist');
      expect(info.title).toBe('Local Batch Playlist');
      expect(info.entries.length).toBe(2);
      expect(info.entries.every((entry) => typeof entry.url === 'string' && entry.url !== '')).toBe(true);

      const template = buildRequest('batch-template', base, ctx);
      const batchBase: DownloadRequest = {
        ...template,
        paths: { ...template.paths, subdirByPlaylist: true },
      };
      const plan = buildPlaylistBatchRecordsByUrl({
        playlist: info,
        selectedIds: info.entries.map((entry) => entry.id),
        baseRequest: batchBase,
        kind: 'video',
        createdAt: '2026-11-28T00:00:00.000Z',
      });
      expect(plan.records).toHaveLength(2);
      // The literal layer is baked into every entry-URL record at BATCH time…
      for (const record of plan.records) {
        expect(record.request?.advanced.playlistItems).toBeNull();
        expect(record.request?.paths.outputTemplate)
          .toBe('Local Batch Playlist/%(title)s.%(ext)s');
      }

      for (const record of plan.records) await ctx.queue.enqueue(record);
      await waitFor(() => plan.records.every((r) => ctx.queue.get(r.id)?.state === 'Completed'),
        90_000, 'both batch downloads Completed');

      const titleDir = join(ctx.outDir, 'Local_Batch_Playlist');
      // …and the argv-side sanitizeToken folded the space: the on-disk layer.
      expect(existsSync(titleDir)).toBe(true);
      for (const record of plan.records) {
        const queued = ctx.queue.get(record.id);
        expect(queued?.state).toBe('Completed');
        expect(queued?.artifacts.length).toBeGreaterThan(0);
        const artifact = (queued?.artifacts[0] ?? '').replace(/\\/g, '/');
        const root = ctx.outDir.replace(/\\/g, '/').replace(/\/+$/, '');
        // Directly under <outDir>/<title>/ — the fix's whole point.
        expect(artifact.startsWith(`${root}/Local_Batch_Playlist/`)).toBe(true);
        expect(artifact.slice(0, artifact.lastIndexOf('/'))).toBe(`${root}/Local_Batch_Playlist`);
        expect(artifact).not.toContain('%(');
        // Not flat in the output root (the bug) and not on the drive root.
        expect(artifact.slice(root.length)).toContain('/');
        const stat = await ctx.ports.fs.stat(queued!.artifacts[0]!);
        expect(stat.sizeBytes).toBeGreaterThan(0);
      }
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await ctx.cleanup();
    }
  }, 120_000);
});
