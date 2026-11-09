/**
 * D-118 · real-download verification (opt-in).
 *
 * The rest of the suite runs the engine against an in-memory ProcessPort; that
 * proves the ARGV, not what yt-dlp does with it. This file runs the bundled
 * yt-dlp.exe for real against a loopback HTTP server and asserts the two
 * properties the whole decision rests on:
 *
 *   1. with a resolved temp dir, `.part` never appears in the output folder;
 *   2. an interrupted download resumes from the bytes already on disk.
 *
 * It is SKIPPED by default — a normal `npm test` must not need a network stack
 * or spawn binaries. Enable explicitly:
 *
 *   YTVDLT_REAL_DOWNLOAD=1 npx vitest run tests/integration/real-temp-isolation.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, readdirSync, openSync, writeSync,
  closeSync, rmSync, statSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveDownloadPlan } from '@ytvdlt/core';
import { buildDownload } from '@ytvdlt/engine-ytdlp';
import type { DownloadRequest } from '@ytvdlt/shared';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const YTDLP = join(ROOT, 'resources', 'runtime', 'win-x64', 'yt-dlp.exe');
const FFMPEG_DIR = join(ROOT, 'resources', 'runtime', 'win-x64', 'ffmpeg');
const NODE_EXE = join(ROOT, 'resources', 'runtime', 'win-x64', 'node.exe');
const REAL = process.env['YTVDLT_REAL_DOWNLOAD'] === '1';

const SIZE = 2 * 1024 * 1024;

let server: Server | null = null;
let baseUrl = '';
let lab = '';

function makeFile(path: string, bytes: number): void {
  const fd = openSync(path, 'w');
  const chunk = Buffer.alloc(1024 * 1024, 7);
  let left = bytes;
  while (left > 0) {
    const write = Math.min(left, chunk.length);
    writeSync(fd, chunk, 0, write);
    left -= write;
  }
  closeSync(fd);
}

function request(taskId: string, tempDir: string, outDir: string): DownloadRequest {
  return {
    taskId,
    url: `${baseUrl}/clip.mp4`,
    format: {
      quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null,
      extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto',
      audioFormat: null, audioMultistreams: false,
    },
    subtitle: {
      enabled: false, languages: 'en.*', autoCaptions: false, skipTranslated: true,
      convertTo: 'none', embed: false, keepSubtitleFile: false,
    },
    paths: {
      videoDir: outDir, audioDir: join(outDir, 'Audio'), commandDir: join(outDir, 'Commands'),
      privateMode: false, subdirByExtractor: false, subdirByPlaylist: false,
      outputTemplate: '%(title)s.%(ext)s', tempDir,
    },
    network: {
      // Throttled so a 900 ms kill reliably lands mid-transfer on loopback.
      rateLimit: '200K', proxy: null, cookiesFile: null, userAgent: null,
      ipv4Only: false, concurrentFragments: null, aria2cPath: null,
    },
    advanced: {
      sponsorblockRemove: null, downloadSections: null, splitChapters: false,
      customTitle: null, debug: false, downloadArchive: null, customCommand: null,
    },
  };
}

/** Exactly what YtDlpEngine does: plan → argv → spawn with cwd/TEMP pinned. */
function argvFor(req: DownloadRequest): string[] {
  const plan = resolveDownloadPlan(req);
  return buildDownload(req, {
    jsRuntimePath: NODE_EXE,
    ffmpegDir: FFMPEG_DIR,
    artifactManifestPath: join(req.paths.tempDir === '' ? req.paths.videoDir : req.paths.tempDir, `ytvdlt-artifacts-${req.taskId}.txt`),
  });
}

function run(argv: string[], cwd: string, killAfterMs?: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(YTDLP, argv, {
      cwd,
      windowsHide: true,
      shell: false,
      // D-118: TEMP is NOT overridden — the app leaves the inherited system
      // temp alone, so yt-dlp's ~29 MB unpack never lands in our folders.
      env: { ...process.env },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    // D-118: yt-dlp's onefile bootloader spawns a child; `child.kill()` only
    // terminates the parent and the download keeps running. The app cancels
    // with `taskkill /T /F`, so the test must do the same or it proves nothing.
    const timer = killAfterMs === undefined ? null : setTimeout(() => {
      try {
        execFileSync(
          join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' },
        );
      } catch { /* already gone */ }
    }, killAfterMs);
    child.on('close', (code) => {
      if (timer !== null) clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

describe.skipIf(!REAL)('D-118 real download · temp isolation', () => {
  beforeAll(async () => {
    lab = mkdtempSync(join(tmpdir(), 'ytvdlt-real-'));
    mkdirSync(join(lab, 'src'), { recursive: true });
    makeFile(join(lab, 'src', 'clip.mp4'), SIZE);
    const root = join(lab, 'src');
    server = createServer((req, res) => {
      const file = join(root, 'clip.mp4');
      const size = statSync(file).size;
      const range = req.headers.range;
      const all = readFileSync(file);
      if (range !== undefined) {
        const m = /bytes=(\d*)-(\d*)/.exec(String(range));
        const start = m?.[1] ? Number(m[1]) : 0;
        const end = m?.[2] ? Number(m[2]) : size - 1;
        res.writeHead(206, {
          'Content-Type': 'video/mp4',
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
        });
        res.end(all.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': size });
      res.end(all);
    });
    await new Promise<void>((resolve) => { server?.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  }, 60_000);

  afterAll(() => {
    server?.close();
    if (lab !== '') rmSync(lab, { recursive: true, force: true });
  });

  it('keeps `.part` out of the output folder and resumes from it', async () => {
    const outDir = join(lab, 'out');
    const tempDir = join(lab, 'work', 'task-1');
    mkdirSync(outDir, { recursive: true });
    mkdirSync(tempDir, { recursive: true });

    const req = request('task-1', tempDir, outDir);
    const argv = argvFor(req);

    // The argv sent to the real binary must carry the temp dir.
    expect(argv).toContain(`temp:${tempDir}`);
    expect(argv).toContain(outDir);

    const first = await run(argv, tempDir, 3_000);
    if (process.env['YTVDLT_REAL_DEBUG'] === '1') {
      console.log('ARGV', JSON.stringify(argv));
      console.log('OUT\n' + first.out.slice(-1200));
      console.log('TEMP', JSON.stringify(readdirSync(tempDir)));
      console.log('OUTDIR', JSON.stringify(readdirSync(outDir)));
    }
    // Interrupted on purpose: the partial must be in temp, never in out.
    expect(readdirSync(outDir).filter((name) => name.endsWith('.part'))).toEqual([]);
    // D-118: yt-dlp's PyInstaller unpack follows TEMP, not `-P temp:`, so it
    // must NOT appear here (those were the `_MEI*` folders beside the media).
    expect(readdirSync(tempDir).filter((name) => name.startsWith('_MEI'))).toEqual([]);
    const partials = readdirSync(tempDir).filter((name) => name.includes('.part'));
    expect(partials.length).toBeGreaterThan(0);
    const partialSize = statSync(join(tempDir, partials[0] ?? '')).size;
    expect(partialSize).toBeGreaterThan(0);
    expect(first.out).toContain('[download]');

    const second = await run(argv, tempDir);
    expect(second.code).toBe(0);
    // Resume proof: yt-dlp says where it picked up, and never restarts at 0.
    expect(second.out).toMatch(/Resuming download at byte \d+/);

    // Finished file in the output folder, nothing partial left behind.
    const produced = readdirSync(outDir);
    expect(produced).toEqual(['clip.mp4']);
    expect(statSync(join(outDir, 'clip.mp4')).size).toBe(SIZE);
    expect(readdirSync(tempDir).filter((name) => name.includes('.part'))).toEqual([]);
  }, 120_000);

  it('a request with no temp dir keeps the legacy behaviour (partial next to media)', async () => {
    const outDir = join(lab, 'legacy-out');
    mkdirSync(outDir, { recursive: true });
    const req = request('task-2', '', outDir);
    const argv = argvFor(req);
    expect(argv.some((part) => part.startsWith('temp:'))).toBe(false);

    await run(argv, outDir, 3_000);
    // Documented, expected: without a temp dir the partial lands beside the media.
    const leftovers = readdirSync(outDir).filter((name) => name.endsWith('.part'));
    expect(leftovers.length).toBeGreaterThan(0);
  }, 120_000);
});

