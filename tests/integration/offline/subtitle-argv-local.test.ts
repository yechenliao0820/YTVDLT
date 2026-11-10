/**
 * Stage 3 · the emitted subtitle argv is accepted by the SHIPPED yt-dlp.
 *
 * Unit tests pin which tokens `buildDownload()` produces; this one asks the real
 * binary whether it understands them. A renamed or unsupported flag exits 2 with
 * "no such option", which no amount of string comparison would catch.
 *
 * It runs with `--simulate`, so nothing is downloaded and nothing is written —
 * only option parsing + extraction against 127.0.0.1.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { DownloadRequest, SubtitleDomain } from '@ytvdlt/shared';
import { buildDownload, type DownloadContext } from '@ytvdlt/engine-ytdlp';
import { startMockServer } from '../helpers/mock-server.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RUNTIME = join(ROOT, 'resources', 'runtime', 'win-x64');
const YTDLP = join(RUNTIME, 'yt-dlp.exe');
const NODE_EXE = join(RUNTIME, 'node.exe');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'media', 'fixture.mp4');

const SUBTITLE_BASE: SubtitleDomain = {
  enabled: false, languages: 'en.*,.*-orig', autoCaptions: false, skipTranslated: true,
  convertTo: 'none', embed: false, keepSubtitleFile: false,
};

function request(url: string, subtitle: Partial<SubtitleDomain>): DownloadRequest {
  return {
    taskId: 'argv-1',
    url,
    format: {
      quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null,
      extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto',
      audioFormat: null, audioMultistreams: false,
    },
    subtitle: { ...SUBTITLE_BASE, ...subtitle },
    paths: {
      videoDir: join(ROOT, 'reports', 'l2-tmp'),
      audioDir: join(ROOT, 'reports', 'l2-tmp'),
      commandDir: join(ROOT, 'reports', 'l2-tmp'),
      privateMode: false, subdirByExtractor: false, subdirByPlaylist: false,
      outputTemplate: '%(title)s.%(ext)s', tempDir: '',
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
}

function run(argv: readonly string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(YTDLP, argv, { windowsHide: true, shell: false });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('subtitle argv · accepted by the bundled yt-dlp', () => {
  it('auto-only argv parses and extracts without "no such option"', async () => {
    expect(existsSync(YTDLP), 'bundled yt-dlp.exe must exist').toBe(true);
    const server = await startMockServer(FIXTURE);
    try {
      const ctx: DownloadContext = {
        jsRuntimePath: NODE_EXE,
        ffmpegDir: RUNTIME,
        artifactManifestPath: join(ROOT, 'reports', 'l2-tmp', 'subtitle-argv-manifest.txt'),
      };
      const argv = buildDownload(
        request(server.url, { enabled: false, autoCaptions: true, languages: 'de' }),
        ctx,
      );
      expect(argv).toContain('--write-auto-subs');
      expect(argv[argv.indexOf('--sub-langs') + 1]).toBe('de');

      const separator = argv.indexOf('--');
      const simulated = [...argv.slice(0, separator), '--simulate', ...argv.slice(separator)];
      const result = await run(simulated);

      expect(result.stderr).not.toMatch(/no such option|unrecognized|not recognized/i);
      expect(result.code).toBe(0);
    } finally {
      await server.close();
    }
  }, 60_000);

  it('manual + embed + convert argv is accepted too', async () => {
    const server = await startMockServer(FIXTURE);
    try {
      const ctx: DownloadContext = {
        jsRuntimePath: NODE_EXE,
        ffmpegDir: RUNTIME,
        artifactManifestPath: join(ROOT, 'reports', 'l2-tmp', 'subtitle-argv-manifest-2.txt'),
      };
      const argv = buildDownload(
        request(server.url, { enabled: true, languages: 'en,zh-Hans', embed: true, convertTo: 'srt' }),
        ctx,
      );
      expect(argv).toContain('--embed-subs');
      expect(argv[argv.indexOf('--convert-subs') + 1]).toBe('srt');

      const separator = argv.indexOf('--');
      const simulated = [...argv.slice(0, separator), '--simulate', ...argv.slice(separator)];
      const result = await run(simulated);

      expect(result.stderr).not.toMatch(/no such option|unrecognized|not recognized/i);
      expect(result.code).toBe(0);
    } finally {
      await server.close();
    }
  }, 60_000);
});
