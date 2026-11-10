import { describe, it, expect } from 'vitest';
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import type { DownloadRequest, SpawnResult } from '@ytvdlt/shared';
import { startMockServer, type MockRoute } from '../helpers/mock-server.js';
import { createL2Context, buildRequest, makeRecord, waitFor, FIXTURE, RUNTIME, YTDLP, type L2Context } from '../helpers/l2-harness.js';

process.env['YTVDLT_L2_KEEP_TMP'] = '1';

const vtt = (label: string): string => `WEBVTT\n\n00:00:00.000 --> 00:00:01.500\n${label}\n`;
const page = (tracks: string): string => `<!doctype html><html><head><title>final subtitle acceptance</title></head><body><video controls><source src="/fixture.mp4" type="video/mp4">${tracks}</video></body></html>`;
const track = (language: string, path: string): string => `<track kind="subtitles" src="${path}" srclang="${language}" label="${language}">`;

interface DiskFile { path: string; bytes: number }
interface ProbeStream { codec_type: string; codec_name: string; tags?: { language?: string } }

async function diskFiles(directory: string): Promise<DiskFile[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: DiskFile[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await diskFiles(path));
    else if (entry.isFile()) files.push({ path, bytes: (await stat(path)).size });
  }
  return files;
}

function observeProcesses(ctx: L2Context): Array<{ file: string; result: SpawnResult }> {
  const observed: Array<{ file: string; result: SpawnResult }> = [];
  const original = ctx.ports.process.spawnStreaming.bind(ctx.ports.process);
  ctx.ports.process.spawnStreaming = (file, argv, options, onChunk) => {
    const handle = original(file, argv, options, onChunk);
    void handle.done.then((result) => { observed.push({ file, result }); }, () => undefined);
    return handle;
  };
  return observed;
}

async function probe(ctx: L2Context, path: string): Promise<ProbeStream[]> {
  const result = await ctx.ports.process.spawn(join(RUNTIME, 'ffmpeg', 'ffprobe.exe'), [
    '-v', 'error', '-show_entries', 'stream=codec_type,codec_name:stream_tags=language', '-of', 'json', path,
  ], { shell: false, windowsHide: true, cwd: ctx.dir, timeoutMs: 30_000 });
  expect(result.timedOut).toBe(false);
  expect(result.exitCode, result.stderr).toBe(0);
  return (JSON.parse(result.stdout) as { streams: ProbeStream[] }).streams;
}

async function runCase(name: string, tracks: string, routes: MockRoute[], configure: (base: DownloadRequest) => DownloadRequest) {
  const ctx = await createL2Context(`subtitle-final-${name}`);
  const observed = observeProcesses(ctx);
  const verify = ctx.verifier.verify.bind(ctx.verifier);
  ctx.verifier.verify = async (...args) => {
    const report = await verify(...args);
    console.log('[subtitle-final-attachments]', JSON.stringify({ case: name, attachments: report.attachments }));
    return report;
  };
  const server = await startMockServer(FIXTURE, { routes: [
    { path: '/page.html', body: page(tracks), contentType: 'text/html; charset=utf-8' }, ...routes,
  ] });
  try {
    const request = configure(buildRequest(`subtitle-final-${name}`, server.urlFor('/page.html'), ctx));
    await ctx.queue.enqueue({ ...makeRecord(request), kind: request.format.extractAudio ? 'audio' : 'video' });
    await waitFor(() => ['Completed', 'Error', 'Canceled'].includes(ctx.queue.get(request.taskId)?.state ?? ''), 120_000, `${name} terminal state`);
    const record = ctx.queue.get(request.taskId)!;
    const disk = [...await diskFiles(ctx.outDir), ...await diskFiles(ctx.tempDir)];
    const downloads = observed.filter((entry) => entry.file === YTDLP);
    const media = disk.filter((entry) => /\.(mp4|mkv|m4a|mp3)$/.test(entry.path));
    const streams = await Promise.all(media.map(async (entry) => ({ path: relative(ctx.dir, entry.path), streams: await probe(ctx, entry.path) })));
    console.log('[subtitle-final-evidence]', JSON.stringify({
      case: name, directory: ctx.dir, exitCodes: downloads.map((entry) => entry.result.exitCode),
      state: record.state, error: record.error?.code ?? null, subtitleOutcome: record.subtitleOutcome ?? null,
      artifacts: record.artifacts.map((path) => relative(ctx.dir, path)),
      disk: disk.map((entry) => ({ path: relative(ctx.dir, entry.path), bytes: entry.bytes })), streams,
      diagnostics: downloads.flatMap((entry) => entry.result.stderr.split(/\r?\n/).filter((line) => /ERROR|WARNING|convert|subtitle/i.test(line)).slice(-5)),
    }));
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.result.timedOut).toBe(false);
    for (const path of record.artifacts) expect((await stat(path)).size).toBeGreaterThan(0);
    return { ctx, record, disk, media, streams, result: downloads[0]!.result };
  } finally {
    await server.close();
  }
}

const withSubtitles = (base: DownloadRequest): DownloadRequest => ({
  ...base, subtitle: { ...base.subtitle, enabled: true, languages: 'en', convertTo: 'srt' },
});

describe('subtitle-final-acceptance · bundled processes and physical artifacts', () => {
  it('measures missing subtitle HTTP 404 without replacing the process or queue result', async () => {
    const { record, media, result } = await runCase('404', track('en', '/missing.en.vtt'), [], withSubtitles);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('404');
    expect(record.state).toBe('Error');
    expect(record.artifacts).toEqual([]);
    expect(media).toHaveLength(0);
  }, 180_000);

  it('measures zero-byte subtitle download failure while retaining real video', async () => {
    const { record, media, streams, result } = await runCase('empty', track('en', '/empty.en.vtt'), [
      { path: '/empty.en.vtt', body: '', contentType: 'text/vtt' },
    ], withSubtitles);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ERROR: Did not get any data blocks');
    expect(record.state).toBe('Error');
    expect(record.artifacts).toEqual([]);
    expect(media).toHaveLength(1);
    expect(media[0]!.bytes).toBe((await stat(FIXTURE)).size);
    expect(streams[0]!.streams.some((stream) => stream.codec_type === 'video')).toBe(true);
  }, 180_000);

  it('converts cue-less VTT to an empty attachment without failing the video', async () => {
    const { record, disk, media, result } = await runCase('cue-less', track('en', '/empty.en.vtt'), [
      { path: '/empty.en.vtt', body: 'WEBVTT\n\n', contentType: 'text/vtt' },
    ], withSubtitles);
    expect(result.exitCode).toBe(0);
    expect(record.state).toBe('Completed');
    expect(record.subtitleOutcome).toBe('missing');
    expect(media).toHaveLength(1);
    expect(record.artifacts).toEqual([media[0]!.path]);
    expect(disk.filter((entry) => entry.path.endsWith('.srt')).map((entry) => entry.bytes)).toEqual([0]);
  }, 180_000);

  it('measures whitespace-only SRT to ASS conversion failure', async () => {
    const { record, disk, media, streams, result } = await runCase('conversion', track('en', '/empty.en.srt'), [
      { path: '/empty.en.srt', body: ' ', contentType: 'application/x-subrip' },
    ], (base) => ({ ...withSubtitles(base), subtitle: { ...withSubtitles(base).subtitle, convertTo: 'ass' } }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/ERROR.*(convert|subtitle|Invalid data)/i);
    expect(record.state).toBe('Error');
    expect(record.artifacts).toEqual([]);
    expect(media).toHaveLength(1);
    expect(media[0]!.bytes).toBe((await stat(FIXTURE)).size);
    expect(streams[0]!.streams.some((stream) => stream.codec_type === 'video')).toBe(true);
    expect(disk.filter((entry) => entry.path.endsWith('.srt')).map((entry) => entry.bytes)).toEqual([1]);
    expect(disk.some((entry) => entry.path.endsWith('.ass'))).toBe(false);
  }, 180_000);

  it.each([true, false])('embeds two real selectable subtitle streams in an MKV, keep=%s', async (keepSubtitleFile) => {
    const { record, media, streams, result } = await runCase(`embed-${keepSubtitleFile}`, track('en', '/en.vtt') + track('zh-Hans', '/zh.vtt'), [
      { path: '/en.vtt', body: vtt('English'), contentType: 'text/vtt' },
      { path: '/zh.vtt', body: vtt('Chinese'), contentType: 'text/vtt' },
    ], (base) => ({ ...withSubtitles(base), subtitle: { ...withSubtitles(base).subtitle, languages: 'en,zh-Hans', embed: true, keepSubtitleFile } }));
    expect(result.exitCode, result.stderr).toBe(0);
    expect(record.state).toBe('Completed');
    expect(media).toHaveLength(1);
    expect(basename(media[0]!.path)).toMatch(/\.mkv$/);
    expect(record.artifacts[0]).toBe(media[0]!.path);
    const subtitleStreams = streams[0]!.streams.filter((stream) => stream.codec_type === 'subtitle');
    expect(subtitleStreams).toHaveLength(2);
    expect(subtitleStreams.map((stream) => stream.codec_name)).toEqual(['subrip', 'subrip']);
    expect(subtitleStreams.map((stream) => stream.tags?.language).sort()).toEqual(['eng', 'zho']);
    expect(streams[0]!.streams.some((stream) => stream.codec_type === 'video')).toBe(true);
    expect(record.subtitleFiles).toHaveLength(2);
    expect(record.subtitleOutcome).toBe('ok');
  }, 180_000);

  it.each([true, false])('observes real move templates with subtitles=%s without changing queue spawning', async (hasSubtitles) => {
    const ctx = await createL2Context('subtitle-final-mapping');
    const mappingPath = join(ctx.dir, 'after-move-mapping.jsonl');
    const requestedPath = join(ctx.dir, 'after-move-requested.jsonl');
    const server = await startMockServer(FIXTURE, { routes: [
      { path: '/page.html', body: page(hasSubtitles ? track('en', '/en.vtt') + track('zh-Hans', '/zh.vtt') : ''), contentType: 'text/html' },
      { path: '/en.vtt', body: vtt('English'), contentType: 'text/vtt' },
      { path: '/zh.vtt', body: vtt('Chinese'), contentType: 'text/vtt' },
    ] });
    try {
      const result = await ctx.ports.process.spawn(YTDLP, [
        '--ignore-config', '--no-simulate', '--no-playlist', '--write-subs', '--sub-langs', 'en,zh-Hans',
        '--convert-subs', 'srt', '--embed-subs', '--remux-video', 'mkv',
        '--ffmpeg-location', join(RUNTIME, 'ffmpeg'), '-P', ctx.outDir, '-P', `temp:${ctx.tempDir}`,
        '-o', 'mapping.%(ext)s', '--print-to-file', 'after_move:%(__files_to_move)j', mappingPath,
        '--print-to-file', 'after_move:%(requested_subtitles.:.filepath|[])j', requestedPath,
        '--print-to-file', 'after_move:%(.{__files_to_move})j', join(ctx.dir, 'projection.jsonl'),
        '--print-to-file', 'post_process:%(__files_to_move|{})j', join(ctx.dir, 'post-process.jsonl'),
        '--print-to-file', 'post_process:YTVDLT_SUBTITLE_MOVES:%(__files_to_move|{})j', join(ctx.dir, 'prefixed.jsonl'),
        '--print-to-file', 'after_move:YTVDLT_SUBTITLE_PATHS:%(requested_subtitles.:.filepath|[])j', join(ctx.dir, 'prefixed.jsonl'),
        '--print-to-file', 'after_video:%(requested_subtitles.:.filepath|[])j', join(ctx.dir, 'after-video.jsonl'), server.urlFor('/page.html'),
      ], { shell: false, windowsHide: true, cwd: ctx.dir, timeoutMs: 120_000 });
      expect(result.exitCode, result.stderr).toBe(0);
      const rawMapping = (await readFile(mappingPath, 'utf8')).trim();
      const rawRequested = (await readFile(requestedPath, 'utf8')).trim();
      const projection = (await readFile(join(ctx.dir, 'projection.jsonl'), 'utf8')).trim();
      const postProcess = (await readFile(join(ctx.dir, 'post-process.jsonl'), 'utf8')).trim();
      const afterVideo = (await readFile(join(ctx.dir, 'after-video.jsonl'), 'utf8')).trim();
      const prefixed = (await readFile(join(ctx.dir, 'prefixed.jsonl'), 'utf8')).trim();
      console.log('[subtitle-final-mapping]', JSON.stringify({ directory: ctx.dir, exitCode: result.exitCode, rawMapping, rawRequested, projection, postProcess, afterVideo, prefixed }));
      expect(prefixed.split(/\r?\n/)).toEqual([`YTVDLT_SUBTITLE_MOVES:${postProcess}`, `YTVDLT_SUBTITLE_PATHS:${rawRequested}`]);
      expect(rawMapping).toBe('NA');
      expect(projection).toBe('{}');
      expect(afterVideo).toBe(rawRequested);
      const mappings = JSON.parse(postProcess) as Record<string, string>;
      const requested = JSON.parse(rawRequested) as string[];
      expect(requested).toHaveLength(hasSubtitles ? 2 : 0);
      for (const source of requested) {
        expect(source.startsWith(await realpath(ctx.tempDir))).toBe(true);
        const destination = mappings[source];
        expect(destination).toBeDefined();
        expect(destination!.startsWith(await realpath(ctx.outDir))).toBe(true);
        expect((await stat(destination!)).size).toBeGreaterThan(0);
      }
    } finally {
      await server.close();
    }
  }, 180_000);

  it('downloads selected automatic captions from controlled local metadata, not a real site', async () => {
    const ctx = await createL2Context('subtitle-final-auto');
    const server = await startMockServer(FIXTURE, { routes: [
      { path: '/manual.en.vtt', body: vtt('MANUAL_EN'), contentType: 'text/vtt' },
      { path: '/auto.en.vtt', body: vtt('AUTO_EN'), contentType: 'text/vtt' },
      { path: '/auto.fr.vtt', body: vtt('AUTO_FR'), contentType: 'text/vtt' },
    ] });
    try {
      const infoPath = join(ctx.dir, 'controlled-info.json');
      await writeFile(infoPath, JSON.stringify({
        id: 'local-auto', title: 'local-auto', extractor: 'generic', extractor_key: 'Generic',
        webpage_url: server.url, url: server.url, ext: 'mp4',
        subtitles: { en: [{ url: server.urlFor('/manual.en.vtt'), ext: 'vtt' }] },
        automatic_captions: {
          en: [{ url: server.urlFor('/auto.en.vtt'), ext: 'vtt' }],
          fr: [{ url: server.urlFor('/auto.fr.vtt'), ext: 'vtt' }],
        },
      }), 'utf8');
      const result = await ctx.ports.process.spawn(YTDLP, [
        '--ignore-config', '--load-info-json', infoPath, '--skip-download', '--no-write-subs',
        '--write-auto-subs', '--sub-langs', 'en', '-P', ctx.outDir, '-o', 'auto.%(ext)s',
      ], { shell: false, windowsHide: true, cwd: ctx.dir, timeoutMs: 120_000 });
      const disk = await diskFiles(ctx.outDir);
      console.log('[subtitle-final-auto]', JSON.stringify({ directory: ctx.dir, exitCode: result.exitCode, files: disk.map((entry) => basename(entry.path)) }));
      expect(result.exitCode, result.stderr).toBe(0);
      expect(disk.map((entry) => basename(entry.path))).toEqual(['auto.en.vtt']);
      const content = await readFile(disk[0]!.path, 'utf8');
      expect(content).toContain('AUTO_EN');
      expect(content).not.toContain('MANUAL_EN');
      expect(content).not.toContain('AUTO_FR');
    } finally {
      await server.close();
    }
  }, 180_000);

  it('extracts real audio with external subtitles and suppresses embedding', async () => {
    const { record, media, streams, result } = await runCase('audio', track('en', '/en.vtt'), [
      { path: '/en.vtt', body: vtt('English audio'), contentType: 'text/vtt' },
    ], (base) => ({ ...withSubtitles(base),
      format: { ...base.format, extractAudio: true, audioFormat: 'mp3' },
      subtitle: { ...withSubtitles(base).subtitle, embed: true },
    }));
    expect(result.exitCode, result.stderr).toBe(0);
    expect(record.state).toBe('Completed');
    expect(media).toHaveLength(1);
    expect(media[0]!.path).toMatch(/\.mp3$/);
    expect(streams[0]!.streams.map((stream) => stream.codec_type)).toEqual(['audio']);
    expect(record.subtitleFiles).toHaveLength(1);
    expect(record.subtitleOutcome).toBe('ok');
  }, 180_000);

  it('keeps ordinary video without requested subtitles completed', async () => {
    const { record, media, streams, result } = await runCase('plain', '', [], (base) => base);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(record.state).toBe('Completed');
    expect(media).toHaveLength(1);
    expect(media[0]!.path).toMatch(/\.mp4$/);
    expect(record.artifacts).toEqual([media[0]!.path]);
    expect(streams[0]!.streams.filter((stream) => stream.codec_type === 'subtitle')).toEqual([]);
    expect(streams[0]!.streams.some((stream) => stream.codec_type === 'video')).toBe(true);
    expect(record.subtitleFiles).toEqual([]);
    expect(record.subtitleOutcome).toBe('none');
  }, 180_000);
});
