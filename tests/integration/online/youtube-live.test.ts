/**
 * LIVE YouTube audit — real international traffic, real downloads.
 *
 * NOT part of the offline suite. Run explicitly:
 *
 *   npx vitest run --config vitest.online.config.ts
 *
 * Scope:
 *   1. A real public playlist: flat probe → display DTO → ticket consume →
 *      `createM4Host().enqueuePlaylistBatchWithReport()` → 3 independent tasks
 *      → real media on disk (360p to keep the audit cheap).
 *   2. A real public video that ships ONLY automatic captions: auto-caption
 *      download + `--embed-subs` + `keepSubtitleFile=false` (D-131) → MKV with
 *      subtitle streams, no standalone sidecar, recycle-bin copies recoverable.
 *
 * The user explicitly authorised saving these two URLs for testing. Output is
 * confined to a per-case scratch directory under `reports/l2-tmp/`; the user's
 * video library is never touched.
 */
import { describe, it, expect } from 'vitest';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PlaylistPreviewService } from '../../../apps/desktop/src/main/playlist-preview-service.js';
import { createM4Host } from '../../../apps/desktop/src/main/m4-host.js';
import {
  createL2Context, buildRequest, makeRecord, waitFor,
  NODE_EXE, RUNTIME, ROOT, type L2Context,
} from '../helpers/l2-harness.js';

process.env['YTVDLT_L2_KEEP_TMP'] = '1';

const PLAYLIST_URL = 'https://www.youtube.com/watch?v=aArYr1vUgjs&list=PLpODSd__yLPULp9c7RaFXF4W8yxRnMZgd';
const SUBTITLE_URL = 'https://www.youtube.com/watch?v=DTu4yvmc0Fc';
const EVIDENCE_DIR = join(ROOT, 'reports', 'live-audit');
const PICK_COUNT = 3;

const rel = (ctx: L2Context, path: string): string => relative(ctx.dir, path).replace(/\\/g, '/');

interface DiskFile { path: string; bytes: number }

async function diskFiles(directory: string): Promise<DiskFile[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { return []; }
  const out: DiskFile[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await diskFiles(path));
    else if (entry.isFile()) out.push({ path, bytes: (await stat(path)).size });
  }
  return out;
}

interface ProbeStream {
  codec_type: string;
  codec_name: string;
  tags?: { language?: string };
}

async function probeStreams(ctx: L2Context, path: string): Promise<ProbeStream[]> {
  const result = await ctx.ports.process.spawn(join(RUNTIME, 'ffmpeg', 'ffprobe.exe'), [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name:stream_tags=language',
    '-of', 'json', path,
  ], { shell: false, windowsHide: true, cwd: ctx.dir, timeoutMs: 30_000 });
  expect(result.timedOut).toBe(false);
  expect(result.exitCode, result.stderr).toBe(0);
  const parsed = JSON.parse(result.stdout) as { streams?: ProbeStream[] };
  return parsed.streams ?? [];
}

async function saveEvidence(name: string, payload: unknown): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(join(EVIDENCE_DIR, name), JSON.stringify(payload, null, 2), 'utf8');
}

describe('live YouTube audit', () => {
  it(`real playlist preview + ${PICK_COUNT} independent downloads`, async () => {
    const ctx = await createL2Context('youtube-live-playlist');
    const preview = new PlaylistPreviewService({
      probe: (url) => ctx.engine.probePlaylist(url, {
        jsRuntimePath: NODE_EXE,
        noPlaylist: false,
        flatPlaylist: true,
      }),
      clock: ctx.ports.clock,
      newId: () => randomUUID(),
    });

    const dto = await preview.preview(PLAYLIST_URL);
    const previewEvidence = {
      ok: dto.ok, code: dto.code, title: dto.title, extractorKey: dto.extractorKey,
      declaredCount: dto.declaredCount, fetchedCount: dto.fetchedCount,
      availableCount: dto.availableCount, unavailableCount: dto.unavailableCount,
      totalDurationSec: dto.totalDurationSec, truncated: dto.truncated,
      firstFive: dto.entries.slice(0, 5),
    };
    console.log('[live-playlist-preview]', JSON.stringify(previewEvidence));
    await saveEvidence('playlist-preview.json', previewEvidence);

    expect(dto.ok).toBe(true);
    expect(dto.fetchedCount).toBeGreaterThanOrEqual(PICK_COUNT);
    // The real playlist declares 20 and the flat probe delivered all 20 — the
    // "declared vs fetched" honesty rule is observable on a real site.
    expect(dto.declaredCount).toBe(dto.fetchedCount);
    // D-130: the renderer-visible DTO must contain NO entry URL.
    expect(JSON.stringify(dto)).not.toMatch(/https?:\/\/|watch\?v=|youtu\.be/);

    const picked = dto.entries.filter((entry) => entry.available).slice(0, PICK_COUNT);
    expect(picked).toHaveLength(PICK_COUNT);

    const consumed = preview.consume(dto.previewId, PLAYLIST_URL);
    expect(consumed.ok).toBe(true);
    if (!consumed.ok) throw new Error(`ticket consume failed: ${consumed.code}`);

    const m4 = await createM4Host({
      ports: ctx.ports,
      engine: ctx.engine,
      verifier: ctx.verifier,
      jsRuntimePath: NODE_EXE,
      videoFixturePath: join(ROOT, 'tests', 'fixtures', 'info-video.json'),
      playlistFixturePath: join(ROOT, 'tests', 'fixtures', 'info-flat-playlist.json'),
      appVersion: '0.2.9',
      engineVersion: '2026.10.26',
      configPath: join(ctx.dir, 'config', 'config.json'),
      snapshotPath: join(ctx.dir, 'config', 'tasks.json'),
      internalWorkDir: join(ctx.dir, 'work'),
      concurrency: 2,
    });
    // Real output root inside the case dir; the user's video library is untouched.
    await m4.task.config.set('paths', 'videoDir', ctx.outDir);
    await m4.task.config.set('paths', 'audioDir', ctx.outDir);

    const report = await m4.enqueuePlaylistBatchWithReport({
      selectedIds: picked.map((entry) => entry.id),
      playlistUrl: PLAYLIST_URL,
      kind: 'video',
      quality: '360p',
      // Cached probe result: enqueue must NOT re-probe (D-130).
      playlist: consumed.playlist,
    });
    console.log('[live-playlist-enqueue]', JSON.stringify(report));
    await saveEvidence('playlist-enqueue.json', report);

    expect(report.requested).toBe(PICK_COUNT);
    expect(report.enqueued).toBe(PICK_COUNT);
    expect(report.failed).toBe(0);
    expect(new Set(report.taskIds).size).toBe(PICK_COUNT);

    await waitFor(
      () => report.taskIds.every((id) => ['Completed', 'Error', 'Canceled']
        .includes(m4.task.queue.get(id)?.state ?? '')),
      900_000,
      'playlist tasks terminal',
    );

    const rows = [];
    for (const id of report.taskIds) {
      const record = m4.task.queue.get(id)!;
      const artifacts = [];
      for (const path of record.artifacts ?? []) {
        let bytes = 0;
        try { bytes = (await stat(path)).size; } catch { bytes = 0; }
        artifacts.push({ path: rel(ctx, path), bytes });
      }
      rows.push({
        id,
        state: record.state,
        error: record.error?.code ?? null,
        title: record.mediaInfo?.title ?? '',
        durationSec: record.mediaInfo?.duration ?? null,
        tempDir: record.request?.paths.tempDir ?? '',
        artifacts,
      });
    }
    const evidence = {
      picked: picked.map((entry) => ({ id: entry.id, title: entry.title, position: entry.position })),
      rows,
      disk: (await diskFiles(ctx.outDir)).map((file) => ({ path: rel(ctx, file.path), bytes: file.bytes })),
    };
    console.log('[live-playlist-result]', JSON.stringify(evidence));
    await saveEvidence('playlist-result.json', evidence);

    for (const row of rows) {
      expect(row.state, `${row.title} → ${row.error ?? ''}`).toBe('Completed');
      expect(row.error).toBeNull();
      expect(row.artifacts.length).toBeGreaterThanOrEqual(1);
      expect(row.artifacts.every((file) => file.bytes > 0)).toBe(true);
    }
    // One temp directory per task (D-118 / D-130).
    expect(new Set(rows.map((row) => row.tempDir)).size).toBe(PICK_COUNT);
    expect(rows.every((row) => row.tempDir !== '')).toBe(true);
    // Every row kept its own title, i.e. the batch really downloaded 3 videos.
    expect(new Set(rows.map((row) => row.title)).size).toBe(PICK_COUNT);

    m4.dispose();
  }, 1_500_000);

  it('real automatic-caption video: embed + keepSubtitleFile=false keeps MKV tracks, no sidecar', async () => {
    const ctx = await createL2Context('youtube-live-subtitle', null, { recycleSubtitles: true });
    const base = buildRequest('yt-live-subtitle', SUBTITLE_URL, ctx);
    const request = {
      ...base,
      // 360p keeps the audit cheap; the caption path is independent of quality.
      format: { ...base.format, quality: '360p' as const },
      subtitle: {
        enabled: false,
        languages: 'en',
        autoCaptions: true,
        skipTranslated: true,
        convertTo: 'srt' as const,
        embed: true,
        keepSubtitleFile: false,
      },
    };

    await ctx.queue.enqueue(makeRecord(request));
    await waitFor(
      () => ['Completed', 'Error', 'Canceled'].includes(ctx.queue.get(request.taskId)?.state ?? ''),
      600_000,
      'subtitle task terminal',
    );

    const record = ctx.queue.get(request.taskId)!;
    const media = (record.artifacts ?? []).filter((path) => /\.(mp4|mkv|webm)$/i.test(path));
    const sidecars = (record.artifacts ?? []).filter((path) => /\.(srt|vtt|ass|ssa|lrc|ttml)$/i.test(path));
    const streams = media.length > 0 ? await probeStreams(ctx, media[0] as string) : [];
    const recycledDir = join(ctx.dir, '_recycled');
    const recycled = await readdir(recycledDir).catch(() => [] as string[]);
    const disk = await diskFiles(ctx.outDir);

    const mediaInfo = record.mediaInfo;
    const evidence = {
      url: SUBTITLE_URL,
      state: record.state,
      error: record.error?.code ?? null,
      title: mediaInfo?.title ?? '',
      manualSubtitleLanguages: Object.keys(mediaInfo?.subtitles ?? {}),
      automaticCaptionLanguages: Object.keys(mediaInfo?.automatic_captions ?? {}).length,
      hasEnglishAutoCaptions: Object.keys(mediaInfo?.automatic_captions ?? {}).includes('en'),
      artifacts: (record.artifacts ?? []).map((path) => rel(ctx, path)),
      media: media.map((path) => rel(ctx, path)),
      sidecars: sidecars.map((path) => rel(ctx, path)),
      subtitleFiles: (record.subtitleFiles ?? []).map((link) => ({
        path: rel(ctx, link.path), language: link.language, ext: link.ext, source: link.source,
      })),
      subtitleOutcome: record.subtitleOutcome ?? null,
      streams: streams.map((stream) => ({
        type: stream.codec_type, codec: stream.codec_name, language: stream.tags?.language ?? null,
      })),
      recycled,
      disk: disk.map((file) => ({ path: rel(ctx, file.path), bytes: file.bytes })),
    };
    console.log('[live-subtitle-result]', JSON.stringify(evidence));
    await saveEvidence('subtitle-result.json', evidence);

    expect(record.state, record.error?.code ?? '').toBe('Completed');
    expect(media).toHaveLength(1);
    expect(media[0]).toMatch(/\.mkv$/i);
    // No manual tracks on this video — it really is an auto-caption-only source.
    expect(Object.keys(mediaInfo?.subtitles ?? {})).toHaveLength(0);
    expect(Object.keys(mediaInfo?.automatic_captions ?? {})).toContain('en');
    // Embedded streams exist …
    const embedded = streams.filter((stream) => stream.codec_type === 'subtitle');
    expect(embedded.length).toBeGreaterThanOrEqual(1);
    expect(embedded.map((stream) => stream.tags?.language)).toContain('eng');
    // … and D-131 removed the standalone copies from the output dir.
    expect(sidecars).toEqual([]);
    expect((record.subtitleFiles ?? [])).toEqual([]);
    expect(disk.filter((file) => /\.(srt|vtt|ass)$/i.test(file.path))).toEqual([]);
    // yt-dlp may remove the temporary sidecar itself after embedding (observed
    // on this real auto-caption video). Either way nothing may remain in the
    // output dir; if a sidecar did survive, it must be recoverable in _recycled
    // (never permanently deleted). `every` on an empty array is true, which is
    // exactly the "yt-dlp already cleaned it" case.
    expect(recycled.every((name) => /\.(srt|vtt)$/i.test(name))).toBe(true);
    // D-132: embedded delivery with keep=false is a complete result, not partial.
    expect(record.subtitleOutcome).toBe('ok');
  }, 900_000);
});
