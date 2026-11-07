/**
 * L2 `retry-local` (M2 acceptance ④ + C10).
 * Cancel mid-flight, then resume with the SAME url/params: the final artifact
 * must be byte-identical to a one-shot download (continuation consistency).
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { startMockServer } from '../helpers/mock-server.js';
import {
  createL2Context, buildRequest, waitFor, filesIn, FIXTURE, FIXTURE_MANIFEST,
} from '../helpers/l2-harness.js';

const RATE = 20_480;
const manifest = JSON.parse(await readFile(FIXTURE_MANIFEST, 'utf8'));

describe('retry-local · L2 cancel → resume consistency (C10)', () => {
  it('resumed download ends with the one-shot hash', async () => {
    const ctx = await createL2Context('retry-local', {
      sha256: manifest.sha256, sizeBytes: manifest.sizeBytes, durationSec: manifest.durationSec,
      videoCodec: manifest.videoCodec, audioCodec: manifest.audioCodec,
      expectedFormat: manifest.expectedFormat ?? null, c8Golden: null,
    });
    const server = await startMockServer(FIXTURE, { rateBytesPerSec: RATE });
    try {
      const req = buildRequest('retry-1', server.url, ctx);

      // --- first attempt: start then cancel mid-flight ---
      let sawProgress = false;
      let canceled = false;
      const first = ctx.engine.download(req, (event) => {
        if (event.type === 'progress' && (event.percent ?? 0) < 100) sawProgress = true;
        if (event.type === 'canceled') canceled = true;
      });
      await waitFor(() => sawProgress, 30_000, 'first-attempt progress');
      expect(await first.cancel()).toBe(true);
      await waitFor(() => canceled, 10_000, 'first attempt canceled');
      await waitFor(async () => (await filesIn(ctx.outDir, (n) => n.endsWith('.part'))).length > 0,
        10_000, '.part retained after cancel');

      // --- second attempt: resume and finish ---
      const result = await new Promise<{ artifacts: string[] }>((resolve, reject) => {
        let artifacts: string[] | null = null;
        ctx.engine.download(req, (event) => {
          if (event.type === 'completed') { artifacts = event.artifacts.map((a) => a.path); resolve({ artifacts }); }
          if (event.type === 'failed') reject(new Error(`resume failed: ${event.error.code} ${event.error.detail}`));
          if (event.type === 'canceled') reject(new Error('resume was canceled'));
        });
      });

      expect(result.artifacts.length).toBeGreaterThan(0);
      const finalPath = result.artifacts[0] as string;
      const finalSha = await ctx.ports.hash.sha256File(finalPath);
      // C10: continuation must equal the one-shot download bytes.
      expect(finalSha).toBe(manifest.sha256);
      const stat = await ctx.ports.fs.stat(finalPath);
      expect(stat.sizeBytes).toBe(manifest.sizeBytes);
      // The .part file must be gone after a successful resume.
      expect(await filesIn(ctx.outDir, (n) => n.endsWith('.part'))).toHaveLength(0);
    } finally {
      await server.close();
      await ctx.cleanup();
    }
  }, 180_000);
});
