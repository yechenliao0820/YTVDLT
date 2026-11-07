/**
 * L2 `download-local` (M2 acceptance ① ② ⑥).
 * REAL yt-dlp against a 127.0.0.1 fixture server:
 *  - artifact path comes from `--print-to-file` (never directory scanning);
 *  - progress percent increases and speed/eta are not all null;
 *  - history entry exists on disk and is unique.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { startMockServer } from '../helpers/mock-server.js';
import {
  createL2Context, buildRequest, makeRecord, waitFor, FIXTURE, FIXTURE_MANIFEST,
} from '../helpers/l2-harness.js';

const manifest = JSON.parse(await readFile(FIXTURE_MANIFEST, 'utf8'));

/**
 * Throttle the fixture body so the download lasts ~7.5 s (308 KB @ 40 KB/s).
 * Unthrottled loopback finishes in a single `--progress-delta 0.5` window and
 * yields only 2 progress lines — the last one is the terminal line where yt-dlp
 * reports `eta=NA` → null, so an ETA assertion on it is a coin flip (M2 QA P1-1).
 */
const RATE = 40_960;

describe('download-local · L2 real download end-to-end', () => {
  it('completes with manifest-sourced artifact, increasing progress, and unique history', async () => {
    const ctx = await createL2Context('download-local', {
      sha256: manifest.sha256, sizeBytes: manifest.sizeBytes, durationSec: manifest.durationSec,
      videoCodec: manifest.videoCodec, audioCodec: manifest.audioCodec,
      expectedFormat: manifest.expectedFormat ?? null, c8Golden: null,
    });
    const server = await startMockServer(FIXTURE, { rateBytesPerSec: RATE });
    try {
      const req = buildRequest('download-local-1', server.url, ctx);
      await ctx.queue.enqueue(makeRecord(req));
      await waitFor(() => ctx.queue.get(req.taskId)?.state === 'Completed', 90_000, 'Completed');

      const record = ctx.queue.get(req.taskId);
      expect(record?.state).toBe('Completed');
      expect(record?.artifacts.length).toBeGreaterThan(0);

      // ① artifact path comes from the manifest and exists on disk.
      const artifact = record?.artifacts[0] ?? '';
      expect(artifact).toContain('download-local-1'.length > 0 ? 'fixture' : 'fixture');
      const stat = await ctx.ports.fs.stat(artifact);
      expect(stat.sizeBytes).toBe(manifest.sizeBytes);
      const sha = await ctx.ports.hash.sha256File(artifact);
      expect(sha).toBe(manifest.sha256);

      // ② progress increases (single-stream) and speed/eta are observed.
      const progresses = ctx.events.filter((e) => e.type === 'progress');
      expect(progresses.length).toBeGreaterThan(1);
      const percents = progresses.map((e) => e.percent ?? -1);
      for (let index = 1; index < percents.length; index += 1) {
        expect(percents[index]).toBeGreaterThanOrEqual(percents[index - 1] as number);
      }
      expect(percents.at(-1)).toBe(100);
      // ETA/speed must be observable on INTERMEDIATE lines: yt-dlp emits `NA`
      // (→ null) on the terminal line, so asserting over all lines including
      // the last one is inherently flaky (M2 QA P1-1).
      const intermediate = progresses.filter((e) => (e.percent ?? 0) < 100);
      expect(intermediate.length).toBeGreaterThan(2);
      expect(intermediate.some((e) => (e.speedBps ?? 0) > 0)).toBe(true);
      expect(intermediate.some((e) => e.etaSec !== null)).toBe(true);

      // ⑥ history entry exists, points at the artifact, and is unique.
      const entries = await ctx.history.query({});
      expect(entries).toHaveLength(1);
      expect(entries[0]?.videoPath).toBe(artifact);
      expect(await ctx.ports.fs.exists(entries[0]?.videoPath ?? '')).toBe(true);
    } finally {
      await server.close();
      await ctx.cleanup();
    }
  }, 120_000);
});
