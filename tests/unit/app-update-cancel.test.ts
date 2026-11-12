/**
 * Update-download cancellation, L2-local (D-93, D-104).
 *
 * D-143: the transport behind `downloadToFile` moved from global `fetch` to
 * `node:http`/`node:https` (pinned DNS), so the old `globalThis.fetch` stub
 * cannot intercept anything any more. The semantics under test are unchanged:
 * an abort mid-stream must fail the download, trash (or rename) the `.part`
 * file exactly once and never leave a half installer that looks installable.
 * The stream now comes from a throw-away local http server instead of a mock.
 */
import { mkdtemp, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadToFile } from '../../apps/desktop/src/main/adapters/http-download.js';

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** Sends the `MZ` header bytes, then stalls forever — the client must abort. */
async function serveStalledInstaller(): Promise<string> {
  const server = createServer((_req, res) => {
    res.on('error', () => { /* client aborted mid-stream — expected */ });
    res.writeHead(200, { 'content-length': '220000000' });
    res.write(Buffer.from([0x4d, 0x5a]));
    // Never end: the body only completes if the client gives up.
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return `http://127.0.0.1:${port}/setup`;
}

describe('update download cancellation', () => {
  it.each([false, true])('stops a stream and reports cleanup failure=%s', async (failCleanup) => {
    const url = await serveStalledInstaller();
    const dir = await mkdtemp(join(tmpdir(), 'ytvdlt-cancel-'));
    const target = join(dir, 'setup.exe');
    const controller = new AbortController();
    let started: () => void = () => {};
    const progress = new Promise<void>((resolve) => { started = resolve; });
    const trash = vi.fn(async (path: string) => {
      if (failCleanup) throw new Error('trash unavailable');
      await rename(path, `${path}.recycled`);
    });
    const pending = downloadToFile({ url, targetPath: target,
      signal: controller.signal, trashPartial: trash, onProgress: () => started() });
    await progress;
    controller.abort();
    await expect(pending).rejects.toThrow(failCleanup ? '临时文件清理失败' : /abort/i);
    expect(trash).toHaveBeenCalledOnce();
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(failCleanup ? /\.part$/ : /\.part\.recycled$/);
    expect(files).not.toContain('setup.exe');
  });

  it('does not create or remove files for a pre-aborted request', async () => {
    const url = await serveStalledInstaller();
    const dir = await mkdtemp(join(tmpdir(), 'ytvdlt-cancel-'));
    const controller = new AbortController();
    controller.abort();
    const trash = vi.fn();
    await expect(downloadToFile({ url, targetPath: join(dir, 'setup.exe'),
      signal: controller.signal, trashPartial: trash })).rejects.toThrow();
    expect(trash).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });
});
