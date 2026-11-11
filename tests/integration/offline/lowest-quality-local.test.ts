/**
 * TASK-01 · lowest-quality acceptance against the REAL engine (L2, offline).
 *
 * What this proves that a unit test cannot: the `-S` term the app actually
 * EMITS is fed to the shipped yt-dlp, and the format yt-dlp really SELECTS is
 * inspected. A unit test can only show the argv string is `+res`; only the
 * engine can show `+res` means "lowest available".
 *
 * Method — fully offline:
 *   - `--load-info-json` hands yt-dlp a metadata document from disk, so format
 *     SELECTION runs for real while nothing is fetched from any network;
 *   - `--simulate --print` reports the winner without writing a file;
 *   - the fixtures are generated here with hand-built format lists, so the
 *     expected winner is derivable by inspection and the assertion is not a
 *     snapshot of whatever the engine happened to do.
 *
 * The reported regression: `lowest` produced NO sort term, yt-dlp's default
 * descending sort then picked the HIGHEST resolution, and a ~980 MB 4K file
 * appeared where the user had asked for the smallest one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DownloadRequest } from '@ytvdlt/shared';
import { buildDownload } from '@ytvdlt/engine-ytdlp';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const YTDLP = join(ROOT, 'resources', 'runtime', 'win-x64', 'yt-dlp.exe');
const NODE_EXE = join(ROOT, 'resources', 'runtime', 'win-x64', 'node.exe');

let workDir = '';
const FIXTURES: Record<string, string> = {};

interface RawFormat {
  readonly format_id: string;
  readonly vcodec: string;
  readonly acodec: string;
  readonly height?: number;
  readonly width?: number;
  readonly abr?: number;
}

/** Build a minimal but VALID info.json for the bundled engine. */
function infoDocument(id: string, formats: readonly RawFormat[]): string {
  return `${JSON.stringify({
    id,
    title: id,
    webpage_url: `http://127.0.0.1/${id}`,
    original_url: `http://127.0.0.1/${id}`,
    extractor: 'generic',
    extractor_key: 'Generic',
    ext: 'mp4',
    _type: 'video',
    protocol: 'https',
    duration: 100,
    http_headers: {},
    formats: formats.map((format) => ({
      ...format,
      url: `http://127.0.0.1/v/${format.format_id}.mp4`,
      ext: format.vcodec === 'none' ? 'm4a' : 'mp4',
      protocol: 'https',
      http_headers: {},
    })),
    subtitles: {},
    automatic_captions: {},
    chapters: null,
  })}\n`;
}

const video = (id: string, height: number, vcodec = 'avc1'): RawFormat =>
  ({ format_id: id, vcodec, acodec: 'none', height, width: Math.round(height * 16 / 9) });

const audio = (id: string, abr = 128): RawFormat =>
  ({ format_id: id, vcodec: 'none', acodec: 'mp4a.40.2', abr });

beforeAll(() => {
  workDir = join(tmpdir(), `ytvdlt-task01-${process.pid}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  const documents: Record<string, string> = {
    // 2160 / 1080 / 720 / 360 plus audio: the reported scenario.
    multi: infoDocument('multi', [
      video('v2160', 2160), video('v1080', 1080), video('v720', 720), video('v360', 360),
      audio('a140'),
    ]),
    // A 480p-only source: `lowest` must yield 480p, NOT a hard-coded 360p.
    only480: infoDocument('only480', [video('v480', 480), audio('a140')]),
    // Audio-only: `lowest` must not invent a video stream.
    audioOnly: infoDocument('audioOnly', [audio('a251', 160)]),
    // A single video stream: nothing to choose from, must still work.
    single: infoDocument('single', [video('v720', 720), audio('a140')]),
  };
  for (const [name, text] of Object.entries(documents)) {
    const path = join(workDir, `${name}.json`);
    writeFileSync(path, text, 'utf8');
    FIXTURES[name] = path;
  }
});

afterAll(() => {
  if (workDir !== '') rmSync(workDir, { recursive: true, force: true });
});

/** Ask the real engine which format a `-S` term selects from a local document. */
function selectFormat(fixturePath: string, sortTerm: string | null): Promise<string> {
  const argv = ['--load-info-json', fixturePath, '--simulate', '--no-warnings'];
  if (sortTerm !== null) argv.push('-S', sortTerm);
  argv.push('--print', '%(format_id)s|%(height)s|%(vcodec)s');
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, argv, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`yt-dlp exit ${String(code)}: ${stderr.slice(0, 300)}`));
      else resolve((stdout.trim().split(/\r?\n/)[0] ?? ''));
    });
  });
}

/** The `-S` term the production argv builder emits for a quality preset. */
function sortTermFor(quality: string): string | null {
  const request: DownloadRequest = {
    taskId: 'task01',
    url: 'https://example.org/v',
    format: {
      quality: quality as DownloadRequest['format']['quality'],
      videoCodecPref: 'auto', formatId: null, sortingFields: null,
      extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto',
      audioFormat: null, audioMultistreams: false,
    },
    subtitle: {
      enabled: false, languages: 'en.*', autoCaptions: false, skipTranslated: true,
      convertTo: 'none', embed: false, keepSubtitleFile: false,
    },
    paths: {
      videoDir: 'C:/V', audioDir: 'C:/A', commandDir: 'C:/C',
      privateMode: false, subdirByExtractor: false, subdirByPlaylist: false,
      outputTemplate: '%(title)s.%(ext)s', tempDir: 'C:/T/task01',
    },
    network: {
      rateLimit: null, proxy: null, cookiesFile: null, userAgent: null,
      ipv4Only: false, concurrentFragments: null, aria2cPath: null,
    },
    advanced: {
      sponsorblockRemove: null, downloadSections: null, splitChapters: false,
      customTitle: null, debug: false, downloadArchive: null, customCommand: null,
    },
  };
  const argv = buildDownload(request, {
    jsRuntimePath: NODE_EXE,
    ffmpegDir: join(workDir, 'ffmpeg'),
    artifactManifestPath: join(workDir, 'manifest.txt'),
    subtitleManifestPath: join(workDir, 'subs.txt'),
  });
  const index = argv.indexOf('-S');
  return index === -1 ? null : (argv[index + 1] ?? null);
}

describe('TASK-01 · lowest quality picks the smallest available stream (L2, offline)', () => {
  it('the bundled engine is present', () => {
    expect(existsSync(YTDLP), `missing ${YTDLP}`).toBe(true);
  });

  it('`lowest` emits `+res` — an ASCENDING sort, not a fixed resolution', () => {
    expect(sortTermFor('lowest')).toBe('+res');
    // The regression: an absent term let the default DESCENDING sort win.
    expect(sortTermFor('lowest')).not.toBeNull();
    expect(sortTermFor('lowest')).not.toContain('res:');
  });

  it('`best` still emits no term, and every fixed preset keeps its `res:N`', () => {
    expect(sortTermFor('best')).toBeNull();
    for (const quality of ['2160p', '1440p', '1080p', '720p', '480p', '360p']) {
      expect(sortTermFor(quality)).toBe(`res:${quality.replace('p', '')}`);
    }
  });

  it('on a 2160/1080/720/360 source, `+res` selects 360p while no term selects 2160p', async () => {
    const fixture = FIXTURES['multi'] as string;
    // The difference the fix makes, measured on the engine, same fixture.
    const high = await selectFormat(fixture, null);
    const low = await selectFormat(fixture, '+res');
    expect(high).toBe('v2160+a140|2160|avc1');
    expect(low).toBe('v360+a140|360|avc1');
  });

  it('`lowest` is RELATIVE: on a 480p-only source it yields 480p, never a 360p upsell', async () => {
    // A hard-coded `res:360` would be the wrong answer here; `+res` is right.
    const lowest = await selectFormat(FIXTURES['only480'] as string, '+res');
    expect(lowest).toBe('v480+a140|480|avc1');
  });

  it('`lowest` on an audio-only source stays audio and never fabricates a video stream', async () => {
    const lowest = await selectFormat(FIXTURES['audioOnly'] as string, '+res');
    expect(lowest).toBe('a251|NA|none');
  });

  it('a single-resolution source downloads normally under `+res`', async () => {
    const lowest = await selectFormat(FIXTURES['single'] as string, '+res');
    expect(lowest).toBe('v720+a140|720|avc1');
  });

  it('every fixed preset still resolves, proving the presets were not disturbed', async () => {
    const fixture = FIXTURES['multi'] as string;
    const expected: Record<string, string> = {
      'res:2160': 'v2160+a140|2160|avc1',
      'res:1080': 'v1080+a140|1080|avc1',
      'res:720': 'v720+a140|720|avc1',
      'res:360': 'v360+a140|360|avc1',
    };
    for (const [term, want] of Object.entries(expected)) {
      expect(await selectFormat(fixture, term), term).toBe(want);
    }
  });
});
