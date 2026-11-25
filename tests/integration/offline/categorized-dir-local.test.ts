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
 * playlist layer collapses for a single video thanks to the `%(playlist|)s`
 * empty default — never an `NA` directory).
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startMockServer } from '../helpers/mock-server.js';
import { createL2Context, buildRequest, makeRecord, waitFor, FIXTURE } from '../helpers/l2-harness.js';
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
});
