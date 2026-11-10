import { describe, it, expect } from 'vitest';
import { YtDlpEngine } from '@ytvdlt/engine-ytdlp';
import { Logger, ErrorMapper } from '@ytvdlt/core';
import type { Artifact, DownloadRequest } from '@ytvdlt/shared';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const request = (keepSubtitleFile = true): DownloadRequest => ({
  taskId: 'ownership', url: 'https://example.org/video',
  format: { quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null, extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto', audioFormat: null, audioMultistreams: false },
  subtitle: { enabled: true, languages: 'en', autoCaptions: false, skipTranslated: true, convertTo: 'srt', embed: !keepSubtitleFile, keepSubtitleFile },
  paths: { videoDir: 'C:/out', audioDir: 'C:/audio', commandDir: 'C:/cmd', privateMode: false, subdirByExtractor: false, subdirByPlaylist: false, outputTemplate: '%(title)s.%(ext)s', tempDir: 'C:/temp/ownership' },
  network: { rateLimit: null, proxy: null, cookiesFile: null, userAgent: null, ipv4Only: false, concurrentFragments: null, aria2cPath: null },
  advanced: { sponsorblockRemove: null, downloadSections: null, splitChapters: false, customTitle: null, debug: false, downloadArchive: null, customCommand: null },
});

const manifest = (moves: unknown, paths: string[]): string =>
  `YTVDLT_SUBTITLE_MOVES:${JSON.stringify(moves)}\nYTVDLT_SUBTITLE_PATHS:${JSON.stringify(paths)}`;

async function download(text: string, files: Record<string, string>, keepSubtitleFile = true, media = ['C:/out/clip.mp4']): Promise<Artifact[]> {
  const { ports, state } = createInMemoryPorts();
  for (const path of media) state.files.set(path, 'media');
  for (const [path, value] of Object.entries(files)) state.files.set(path, value);
  state.streamScripts.set('yt-dlp.exe', {
    chunks: [], exitCode: 0,
    writeFiles: {
      'C:/temp/ownership/ytvdlt-artifacts-ownership.txt': media.map((path) => `"${path}"`).join('\n'),
      'C:/temp/ownership/ytvdlt-subtitles-ownership.txt': text,
    },
  });
  const engine = new YtDlpEngine({
    ports, logger: new Logger({ ports, appVersion: '0.2.9' }),
    mapper: new ErrorMapper({ clock: ports.clock }),
    enginePath: 'C:/runtime/yt-dlp.exe', jsRuntimePath: 'C:/runtime/node.exe', appVersion: '0.2.9',
  });
  return new Promise((resolve, reject) => {
    engine.download(request(keepSubtitleFile), (event) => {
      if (event.type === 'completed') resolve([...event.artifacts]);
      if (event.type === 'failed') reject(new Error(event.error.code));
    });
  });
}

const source = 'C:/temp/ownership/clip.en.srt';
const target = 'D:/subtitles/renamed.en.srt';

describe('subtitle artifacts require exact process ownership', () => {
  it('rejects the old same-basename file when a reported temp path is missing', async () => {
    const artifacts = await download(JSON.stringify([source]), { 'C:/out/clip.en.srt': 'old subtitle' });
    expect(artifacts.map((item) => item.path)).toEqual(['C:/out/clip.mp4']);
  });

  it('accepts converted SRT at the explicit target, not an old source or media basename', async () => {
    const artifacts = await download(manifest({ [source]: target }, [source]), {
      [source]: 'stale source', [target]: 'converted subtitle', 'C:/out/clip.en.srt': 'old subtitle',
    });
    expect(artifacts.map((item) => item.path)).toEqual(['C:/out/clip.mp4', target]);
    expect(artifacts[1]?.kind).toBe('subtitle');
  });

  it('does not fall back when an explicit target is missing', async () => {
    const artifacts = await download(manifest({ [source]: target }, [source]), {
      [source]: 'leftover source', 'C:/out/clip.en.srt': 'old subtitle',
    });
    expect(artifacts).toHaveLength(1);
  });

  it('does not claim an old sidecar after embed-only removal', async () => {
    const artifacts = await download(manifest({}, [source]), { 'C:/out/clip.en.srt': 'old subtitle' }, false);
    expect(artifacts).toHaveLength(1);
  });

  it('does not cross-claim sidecars for split multi-media output', async () => {
    const media = ['C:/out/chapter1.mp4', 'C:/audio/chapter2.mp4'];
    const artifacts = await download(manifest({ [source]: target, 'C:/temp/other.en.srt': 'C:/audio/clip.en.srt' }, [source]), {
      [target]: 'owned subtitle', 'C:/out/clip.en.srt': 'old one', 'C:/audio/clip.en.srt': 'old two',
    }, true, media);
    expect(artifacts.map((item) => item.path)).toEqual([...media, target]);
  });

  it('keeps legacy lists usable only at the exact reported location', async () => {
    const artifacts = await download("['C:/out/clip.en.srt']", { 'C:/out/clip.en.srt': 'owned subtitle' });
    expect(artifacts.map((item) => item.path)).toEqual(['C:/out/clip.mp4', 'C:/out/clip.en.srt']);
  });

  it('does not fail media completion for empty subtitles or malformed maps', async () => {
    expect(await download(manifest({ [source]: target }, [source]), { [target]: '' })).toHaveLength(1);
    expect(await download(`YTVDLT_SUBTITLE_MOVES:NA\nYTVDLT_SUBTITLE_PATHS:${JSON.stringify([source])}`, { [source]: 'leftover' })).toHaveLength(1);
  });
});
