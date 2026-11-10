/**
 * L2 `cancel-local` (M2 acceptance ③).
 * Throttled server (20 KB/s ⇒ ~15 s for the 308 KB fixture) so cancellation
 * happens mid-flight. Asserts: pid gone, `.part` retained, no orphan ffmpeg,
 * queue state = Canceled, no history written (C12).
 */
import { describe, it, expect } from 'vitest';
import { startMockServer } from '../helpers/mock-server.js';
import {
  createL2Context, buildRequest, makeRecord, waitFor, filesIn, FIXTURE,
} from '../helpers/l2-harness.js';

const RATE = 20_480; // 20 KB/s

describe('cancel-local · L2 cancellation kills the process tree', () => {
  it('engine-level: cancel() removes the pid and keeps the .part file', async () => {
    const ctx = await createL2Context('cancel-local-engine');
    const server = await startMockServer(FIXTURE, { rateBytesPerSec: RATE });
    try {
      const req = buildRequest('cancel-engine-1', server.url, ctx);
      let sawProgressBelow100 = false;
      let pid: number | null = null;
      let canceledEvent = false;

      const handle = ctx.engine.download(req, (event) => {
        if (event.type === 'progress' && (event.percent ?? 0) < 100) sawProgressBelow100 = true;
        if (event.type === 'canceled') canceledEvent = true;
      });
      // `pid` is registered once spawnStreaming has actually started the process.
      await waitFor(() => sawProgressBelow100, 30_000, 'first progress < 100%');
      pid = handle.pid;
      expect(pid).not.toBeNull();

      const ok = await handle.cancel();
      expect(ok).toBe(true);
      await waitFor(() => canceledEvent, 10_000, 'canceled event');

      // ③ pid must be gone (no orphan process tree).
      expect(await ctx.ports.process.isAlive(pid as number)).toBe(false);

      // ③ the `.part` file must still exist (yt-dlp does not delete it).
      await waitFor(async () => (await filesIn(ctx.tempDir, (n) => n.endsWith('.part'))).length > 0,
        10_000, '.part retained');
    } finally {
      await server.close();
      await ctx.cleanup();
    }
  }, 120_000);

  it('queue-level: cancel() → Canceled, lastPercent kept, no history', async () => {
    const ctx = await createL2Context('cancel-local-queue');
    const server = await startMockServer(FIXTURE, { rateBytesPerSec: RATE });
    try {
      const req = buildRequest('cancel-queue-1', server.url, ctx);
      await ctx.queue.enqueue(makeRecord(req));
      await waitFor(() => {
        const record = ctx.queue.get(req.taskId);
        return record?.state === 'Running' && (record.lastPercent ?? 0) > 0;
      }, 30_000, 'running with progress');

      expect(await ctx.queue.cancel(req.taskId)).toBe(true);
      const record = ctx.queue.get(req.taskId);
      expect(record?.state).toBe('Canceled');
      expect(record?.lastPercent ?? 0).toBeGreaterThan(0);
      // C12: never completed, never written to history.
      expect(await ctx.history.query({})).toHaveLength(0);
    } finally {
      await server.close();
      await ctx.cleanup();
    }
  }, 120_000);
});
