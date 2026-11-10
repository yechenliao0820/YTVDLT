import { mkdtemp, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadToFile } from '../../apps/desktop/src/main/adapters/http-download.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('update download cancellation', () => {
  it.each([false, true])('stops a stream and reports cleanup failure=%s', async (failCleanup) => {
    const dir = await mkdtemp(join(tmpdir(), 'ytvdlt-cancel-'));
    const target = join(dir, 'setup.exe');
    const controller = new AbortController();
    let started: () => void = () => {};
    const progress = new Promise<void>((resolve) => { started = resolve; });
    globalThis.fetch = vi.fn(async (_url, options) => {
      const signal = (options as RequestInit).signal!;
      return new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(new Uint8Array([77, 90]));
          signal.addEventListener('abort', () => stream.error(new Error('aborted')));
        },
      }));
    }) as typeof fetch;
    const trash = vi.fn(async (path: string) => {
      if (failCleanup) throw new Error('trash unavailable');
      await rename(path, `${path}.recycled`);
    });
    const pending = downloadToFile({ url: 'https://example.test/setup', targetPath: target,
      signal: controller.signal, trashPartial: trash, onProgress: () => started() });
    await progress;
    controller.abort();
    await expect(pending).rejects.toThrow(failCleanup ? '临时文件清理失败' : 'aborted');
    expect(trash).toHaveBeenCalledOnce();
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(failCleanup ? /\.part$/ : /\.part\.recycled$/);
    expect(files).not.toContain('setup.exe');
  });

  it('does not create or remove files for a pre-aborted request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ytvdlt-cancel-'));
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = vi.fn(async (_url, options) => {
      (options as RequestInit).signal!.throwIfAborted();
      throw new Error('unexpected');
    }) as typeof fetch;
    const trash = vi.fn();
    await expect(downloadToFile({ url: 'https://example.test/setup', targetPath: join(dir, 'setup.exe'),
      signal: controller.signal, trashPartial: trash })).rejects.toThrow();
    expect(trash).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });
});
