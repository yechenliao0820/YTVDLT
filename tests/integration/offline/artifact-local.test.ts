/**
 * L2 `artifact-local` (M2 acceptance ⑤).
 * Downloads with the REAL engine, then runs the REAL ArtifactVerifier so all
 * C1–C12 are judged against a genuinely produced file (no synthetic bytes).
 */
import { describe, it, expect } from 'vitest';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startMockServer } from '../helpers/mock-server.js';
import {
  createL2Context, buildRequest, waitFor, ROOT, FIXTURE, FIXTURE_MANIFEST,
} from '../helpers/l2-harness.js';

const manifest = JSON.parse(await readFile(FIXTURE_MANIFEST, 'utf8'));

describe('artifact-local · L2 C1–C12 on a real download', () => {
  it('12/12 criteria are PASS or SKIPPED (zero FAIL)', async () => {
    const expectedManifest = {
      sha256: manifest.sha256, sizeBytes: manifest.sizeBytes, durationSec: manifest.durationSec,
      videoCodec: manifest.videoCodec, audioCodec: manifest.audioCodec,
      expectedFormat: manifest.expectedFormat ?? null, c8Golden: null,
    };
    const ctx = await createL2Context('artifact-local', expectedManifest);
    const server = await startMockServer(FIXTURE);
    try {
      const req = buildRequest('artifact-1', server.url, ctx);
      let artifacts: string[] = [];
      await new Promise<void>((resolve, reject) => {
        ctx.engine.download(req, (event) => {
          if (event.type === 'completed') { artifacts = event.artifacts.map((a) => a.path); resolve(); }
          if (event.type === 'failed') reject(new Error(`${event.error.code}: ${event.error.detail}`));
        });
      });
      await waitFor(() => artifacts.length > 0, 10_000, 'artifacts');

      const report = await ctx.verifier.verify({
        taskId: req.taskId,
        artifacts,
        // Local direct links report duration=null; C5 degrades to the manifest (D-20).
        expected: null,
        postprocessed: false,
        expectedManifest,
        historyEntry: null,
        kind: 'video',
      });

      const failed = report.criteria.filter((c) => c.status === 'FAIL');
      expect(failed, `unexpected FAILs: ${JSON.stringify(failed)}`).toEqual([]);
      expect(report.criteria).toHaveLength(12);
      expect(report.ok).toBe(true);
      expect(report.failureCode).toBeNull();

      const byId = Object.fromEntries(report.criteria.map((c) => [c.id, c.status]));
      // Spot-check the ones that must be real judgements, not skips.
      expect(byId['C1']).toBe('PASS');
      expect(byId['C2']).toBe('PASS');   // pure download → byte hash
      expect(byId['C3']).toBe('PASS');
      expect(byId['C4']).toBe('PASS');
      expect(byId['C5']).toBe('PASS');   // degraded to manifest.durationSec
      expect(byId['C6']).toBe('PASS');
      expect(byId['C12']).toBe('PASS');
      // Skips are expected and must carry a reason.
      for (const criterion of report.criteria.filter((c) => c.status === 'SKIPPED')) {
        expect(criterion.skipReason, `${criterion.id} must explain its skip`).toBeTruthy();
      }

      // Persist the evidence next to the other M2 reports.
      await mkdir(join(ROOT, 'reports'), { recursive: true });
      await writeFile(
        join(ROOT, 'reports', 'artifact-verification.json'),
        `${JSON.stringify(report, null, 2)}\n`,
        'utf8',
      );
    } finally {
      await server.close();
      await ctx.cleanup();
    }
  }, 150_000);
});
