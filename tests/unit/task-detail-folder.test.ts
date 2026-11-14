/**
 * D-120 · core's `open-folder` must not depend on the FILE still existing.
 *
 * The download succeeded in the past; an external delete/move does not erase
 * the history, and the user is still entitled to see the original folder.
 *
 * D-204 · when the fs port provides `realpath`, the folder gate resolves the
 * FINAL target (the file while it exists, the fallback DIRECTORY once the
 * file is gone) through every symlink / NTFS junction and re-runs
 * containment on the real path. The fallback directory may BE a trusted root
 * (file lived directly in videoDir); only resolutions OUTSIDE every root are
 * refused.
 */
import { describe, it, expect } from 'vitest';
import {
  TaskDetailService, buildErrorReport, formatErrorReport,
} from '@ytvdlt/core';
import type { DownloadRequest, IShellPort, TaskRecord } from '@ytvdlt/shared';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const FILE = 'C:/Videos/clip.mp4';
const DIR = 'C:/Videos';

const REQUEST: DownloadRequest = {
  taskId: 't1', url: 'https://example.org/v',
  format: { quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null, extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto', audioFormat: null, audioMultistreams: false },
  subtitle: { enabled: false, languages: 'en.*', autoCaptions: false, skipTranslated: true, convertTo: 'none', embed: false, keepSubtitleFile: false },
  paths: { videoDir: 'C:/Videos', audioDir: '', commandDir: 'C:/cmd', privateMode: false, subdirByExtractor: false, subdirByPlaylist: false, outputTemplate: '%(title)s.%(ext)s', tempDir: '' },
  network: { rateLimit: null, proxy: null, cookiesFile: null, userAgent: null, ipv4Only: false, concurrentFragments: null, aria2cPath: null },
  advanced: { sponsorblockRemove: null, downloadSections: null, splitChapters: false, customTitle: null, debug: false, downloadArchive: null, customCommand: null },
};

function record(artifacts: readonly string[]): TaskRecord {
  return {
    id: 't1', url: 'https://example.org/v', kind: 'video', state: 'Completed',
    createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
    mediaInfo: null, request: REQUEST, artifacts: [...artifacts], lastPercent: 100,
    error: null, privateMode: false, postprocessed: false,
  };
}

function harness(task: TaskRecord, shellError?: unknown) {
  const mem = createInMemoryPorts();
  const recorded: Array<{ op: string; path: string }> = [];
  const shell: IShellPort = {
    async openPath(path: string) {
      if (shellError !== undefined) throw shellError;
      recorded.push({ op: 'open', path });
    },
    async showItemInFolder(path: string) { recorded.push({ op: 'reveal', path }); },
  };
  const tasks = new Map([[task.id, task]]);
  const queue = {
    async enqueue() {}, async enqueueBatch() { return []; },
    async cancel() { return true; }, async restart() {}, async remove() { return true; },
    get(id: string) { return tasks.get(id); },
    list() { return [...tasks.values()]; },
    onEvent() { return () => {}; },
    concurrency: 3, activeTaskIds: [] as readonly string[], pendingCount: 0,
    setConcurrency() { return 3; },
  };
  const service = new TaskDetailService({
    ports: mem.ports,
    queue,
    shell,
    clipboard: { async writeText() {} },
    buildReport: (t) => buildErrorReport({
      task: t, appVersion: '0.2.7', engineVersion: 'unknown', os: 'win32',
      stderr: '',
    }, '2026-11-10T00:00:00.000Z'),
    formatReport: formatErrorReport,
  });
  return { mem, recorded, service };
}

describe('D-120 · core open-folder is folder-driven', () => {
  it('file present -> reveal the file (unchanged behaviour)', async () => {
    const h = harness(record([FILE]));
    h.mem.state.files.set(FILE, 'bytes');
    const result = await h.service.perform('t1', 'open-folder');
    expect(result.ok).toBe(true);
    expect(h.recorded).toEqual([{ op: 'reveal', path: FILE }]);
  });

  it('file gone, folder present -> open the folder and say the file is missing', async () => {
    const h = harness(record([FILE]));
    h.mem.state.files.set(DIR, 'directory');
    const result = await h.service.perform('t1', 'open-folder');
    expect(result.ok).toBe(true);
    expect(result.fileMissing).toBe(true);
    expect(h.recorded).toEqual([{ op: 'open', path: DIR }]);
  });

  it('file AND folder gone -> FOLDER_MISSING, no shell call', async () => {
    const h = harness(record([FILE]));
    const result = await h.service.perform('t1', 'open-folder');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('FOLDER_MISSING');
    expect(h.recorded).toEqual([]);
  });

  it('opening the folder itself failing is an ERROR, not a silent success', async () => {
    const h = harness(record([FILE]), new Error('EACCES'));
    h.mem.state.files.set(DIR, 'directory');
    const result = await h.service.perform('t1', 'open-folder');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ERROR');
  });

  it('open-file still refuses a missing file (nothing to open)', async () => {
    const h = harness(record([FILE]));
    h.mem.state.files.set(DIR, 'directory');
    const result = await h.service.perform('t1', 'open-file');
    expect(result.code).toBe('FILE_MISSING');
    expect(h.recorded).toEqual([]);
  });

  it('no recorded path -> NO_ARTIFACT, never "file deleted"', async () => {
    const h = harness(record([]));
    expect((await h.service.perform('t1', 'open-folder')).code).toBe('NO_ARTIFACT');
    expect((await h.service.perform('t1', 'open-file')).code).toBe('NO_ARTIFACT');
  });
});

// ---------------------------------------------------------------------------
// D-204 · open-folder 的 realpath 真实路径校验：最终目标（文件在 → 文件；
// 文件缺失 → 回退目录）解析后必须仍在可信根内。
// ---------------------------------------------------------------------------
describe('D-204 · open-folder realpath containment', () => {
  /** Attach a controllable realpath stub to the in-memory fs port. */
  function attachRealpath(
    mem: ReturnType<typeof createInMemoryPorts>,
    impl: (path: string) => Promise<string>,
  ): void {
    Object.assign(mem.ports.fs, { realpath: impl });
  }

  /** A rejection shaped like a real `node:fs` error (carries `code`). */
  const fsError = (code: string, path: string): Error =>
    Object.assign(new Error(`${code}: simulated, lstat '${path}'`), { code });

  it('文件看似根内但真实路径在根外（junction）→ REFUSED，shell 零调用', async () => {
    const h = harness(record([FILE]));
    h.mem.state.files.set(FILE, 'bytes');
    attachRealpath(h.mem, async (p) => (p === FILE ? 'C:/Windows/System32/evil.mp4' : p));
    const result = await h.service.perform('t1', 'open-folder');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('REFUSED');
    expect(result.message).toContain('产物真实路径指向任务输出目录之外');
    expect(result.message).toContain('符号链接');
    expect(h.recorded).toEqual([]);
  });

  it('真实路径仍在根内 → 照常 reveal 文件（跟随用户意图）', async () => {
    const h = harness(record([FILE]));
    h.mem.state.files.set(FILE, 'bytes');
    attachRealpath(h.mem, async (p) => (p === FILE ? 'c:/videos/clip.mp4' : p));
    const result = await h.service.perform('t1', 'open-folder');
    expect(result.ok).toBe(true);
    expect(h.recorded).toEqual([{ op: 'reveal', path: FILE }]);
  });

  it('文件缺失 → 回退打开目录，目录本身也做真实路径校验（目录即可信根，合法）', async () => {
    // 文件被外部删除；目录 realpath 回到扩展前缀形态的真实路径 = videoDir
    // 根本身 —— 「inside-or-equal」允许，D-120 回退行为不变。
    const h = harness(record([FILE]));
    attachRealpath(h.mem, async (p) => {
      if (p === FILE) throw fsError('ENOENT', p);
      return '\\\\?\\C:\\Videos'; // 目录存在，realpath 是根自己的扩展形态
    });
    const result = await h.service.perform('t1', 'open-folder');
    expect(result.ok).toBe(true);
    expect(result.fileMissing).toBe(true);
    expect(h.recorded).toEqual([{ op: 'open', path: DIR }]);
  });

  it('文件缺失且目录真实路径在根外（目录是 junction）→ REFUSED', async () => {
    const h = harness(record([FILE]));
    attachRealpath(h.mem, async (p) => {
      if (p === FILE) throw fsError('ENOENT', p);
      if (p === DIR) return 'D:/Elsewhere/Videos'; // 目录被联接到可信根之外
      return p;
    });
    const result = await h.service.perform('t1', 'open-folder');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('REFUSED');
    expect(result.message).toContain('产物真实路径指向任务输出目录之外');
    expect(h.recorded).toEqual([]);
  });

  it('目录也缺失（ENOENT）→ FOLDER_MISSING，不是安全拒绝', async () => {
    const h = harness(record([FILE]));
    attachRealpath(h.mem, async (p) => { throw fsError('ENOENT', p); });
    const result = await h.service.perform('t1', 'open-folder');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('FOLDER_MISSING');
    expect(result.message).toContain('原下载目录不存在');
    expect(h.recorded).toEqual([]);
  });

  it('目录 realpath EACCES → fail-closed REFUSED，带真实原因', async () => {
    const h = harness(record([FILE]));
    attachRealpath(h.mem, async (p) => {
      if (p === FILE) throw fsError('ENOENT', p);
      throw fsError('EACCES', p);
    });
    const result = await h.service.perform('t1', 'open-folder');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('REFUSED');
    expect(result.message).toContain('无法解析产物真实路径');
    expect(result.message).toContain('EACCES');
    expect(h.recorded).toEqual([]);
  });

  it('文件 realpath EACCES → REFUSED，不做目录回退（无法证明就不放行）', async () => {
    const h = harness(record([FILE]));
    h.mem.state.files.set(FILE, 'bytes');
    h.mem.state.files.set(DIR, 'directory');
    attachRealpath(h.mem, async (p) => { throw fsError('EACCES', p); });
    const result = await h.service.perform('t1', 'open-folder');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('REFUSED');
    expect(result.message).toContain('无法解析产物真实路径');
    expect(h.recorded).toEqual([]);
  });

  it('request-less 记录的 open-folder 也 fail-closed → REFUSED', async () => {
    const h = harness({ ...record([FILE]), request: null });
    h.mem.state.files.set(FILE, 'bytes');
    const result = await h.service.perform('t1', 'open-folder');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('REFUSED');
    expect(result.message).toContain('无法验证产物路径归属');
    expect(h.recorded).toEqual([]);
  });
});
