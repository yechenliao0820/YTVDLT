/**
 * M4-4 · playlist batch (原始验收 ③).
 *
 * "Select 5 entries → 5 independent tasks, independent progress, concurrency
 * respected." Plus the argv contract: each task carries `--playlist-items <n>`
 * and `--yes-playlist`, while every non-batch request keeps the frozen
 * `--no-playlist`.
 */
import { describe, it, expect } from 'vitest';
import {
  buildPlaylistBatchRecords, buildPlaylistBatchRecordsByUrl,
  bakePlaylistTitleLayer, playlistTitleTemplateLayer, PLAYLIST_TITLE_LAYER_MAX,
  sanitizePlaylistItems, TaskQueue, HistoryStore,
} from '@ytvdlt/core';
import { buildDownload } from '@ytvdlt/engine-ytdlp';
import type {
  DownloadEngine, DownloadRequest, EngineEvent, PlaylistInfo,
} from '@ytvdlt/shared';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const PLAYLIST: PlaylistInfo = {
  id: 'PL_fixture_01',
  title: 'Recorded Flat Playlist',
  _type: 'playlist',
  extractor_key: 'generic',
  webpage_url: 'https://example.org/playlist?list=PL_fixture_01',
  entries: [
    { id: 'a1', title: 'Episode 1', url: 'https://example.org/watch?v=a1', duration: 100, _type: 'url' },
    { id: 'a2', title: 'Episode 2', url: 'https://example.org/watch?v=a2', duration: 200, _type: 'url' },
    { id: 'a3', title: 'Episode 3', url: 'https://example.org/watch?v=a3', duration: 300, _type: 'url' },
    { id: 'a4', title: 'Episode 4', url: 'https://example.org/watch?v=a4', duration: 400, _type: 'url' },
    { id: 'a5', title: 'Episode 5', url: 'https://example.org/watch?v=a5', duration: 500, _type: 'url' },
    { id: 'a6', title: 'Episode 6', url: 'https://example.org/watch?v=a6', duration: 600, _type: 'url' },
  ],
};

const baseRequest = (): DownloadRequest => ({
  taskId: 'template', url: 'https://example.org/playlist?list=PL_fixture_01',
  format: { quality: '1080p', videoCodecPref: 'h264', formatId: null, sortingFields: null, extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto', audioFormat: null, audioMultistreams: false },
  subtitle: { enabled: false, languages: 'en.*', autoCaptions: false, skipTranslated: true, convertTo: 'none', embed: false, keepSubtitleFile: false },
  paths: { videoDir: 'C:/V', audioDir: 'C:/A', commandDir: 'C:/C', privateMode: false, subdirByExtractor: false, subdirByPlaylist: true, outputTemplate: '%(title)s.%(ext)s', tempDir: 'C:/T' },
  network: { rateLimit: null, proxy: null, cookiesFile: null, userAgent: null, ipv4Only: false, concurrentFragments: null, aria2cPath: null },
  advanced: { sponsorblockRemove: null, downloadSections: null, splitChapters: false, customTitle: null, debug: false, downloadArchive: null, customCommand: null },
});

const build = (selectedIds: string[], overrides: Partial<Parameters<typeof buildPlaylistBatchRecords>[0]> = {}) =>
  buildPlaylistBatchRecords({
    playlist: PLAYLIST,
    selectedIds,
    baseRequest: baseRequest(),
    kind: 'video',
    createdAt: '2026-11-06T00:00:00.000Z',
    ...overrides,
  });

describe('M4-4 · buildPlaylistBatchRecords', () => {
  it('turns 5 selected ids into 5 independent tasks with original positions', () => {
    const plan = build(['a5', 'a1', 'a3', 'a6', 'a2']);
    expect(plan.records).toHaveLength(5);
    expect(plan.unknownIds).toEqual([]);
    expect(plan.duplicateIds).toEqual([]);

    const byId = new Map(plan.records.map((r) => [r.id, r]));
    expect([...byId.keys()]).toEqual(['PL_fixture_01-a5', 'PL_fixture_01-a1', 'PL_fixture_01-a3', 'PL_fixture_01-a6', 'PL_fixture_01-a2']);
    // Positions come from the playlist order, not the click order.
    expect(byId.get('PL_fixture_01-a5')?.request?.advanced.playlistItems).toBe('5');
    expect(byId.get('PL_fixture_01-a1')?.request?.advanced.playlistItems).toBe('1');
    expect(byId.get('PL_fixture_01-a2')?.request?.advanced.playlistItems).toBe('2');

    for (const record of plan.records) {
      expect(record.state).toBe('Idle');
      expect(record.url).toBe(PLAYLIST.webpage_url);
      expect(record.request?.url).toBe(PLAYLIST.webpage_url);
      expect(record.request?.taskId).toBe(record.id);
      expect(record.mediaInfo).toBeNull();
      expect(record.artifacts).toEqual([]);
      expect(record.lastPercent).toBeNull();
      // Every other domain is copied verbatim from the template.
      expect(record.request?.format.quality).toBe('1080p');
      expect(record.request?.paths.subdirByPlaylist).toBe(true);
    }
  });

  it('deduplicates selections and reports unknown ids (never silently drops them)', () => {
    const plan = build(['a1', 'a1', 'nope', 'a2']);
    expect(plan.records.map((r) => r.id)).toEqual(['PL_fixture_01-a1', 'PL_fixture_01-a2']);
    expect(plan.duplicateIds).toEqual(['a1']);
    expect(plan.unknownIds).toEqual(['nope']);
  });

  it('returns an empty batch for an empty selection', () => {
    expect(build([]).records).toEqual([]);
  });

  it('supports a custom task-id maker', () => {
    const plan = build(['a1'], { makeTaskId: (playlistId, entryId, position) => `${playlistId}#${position}#${entryId}` });
    expect(plan.records[0]?.id).toBe('PL_fixture_01#1#a1');
  });

  it('honours private mode', () => {
    expect(build(['a1'], { privateMode: true }).records[0]?.privateMode).toBe(true);
    expect(build(['a1']).records[0]?.privateMode).toBe(false);
  });
});

describe('M4-4 · sanitizePlaylistItems (grammar + injection guard)', () => {
  it('accepts digits, lists and ranges', () => {
    for (const value of ['1', '3', '1,3,5', '5-7', '1:3', '1,3,5-7']) {
      expect(sanitizePlaylistItems(value)).toBe(value);
    }
  });

  it('rejects option injection / shell metacharacters / empty / oversized', () => {
    for (const value of ['', '  ', '1; rm -rf /', '1 --exec calc', '--exec', '1,', 'a,b', '1..3', 'x'.repeat(201), null, 42]) {
      expect(sanitizePlaylistItems(value)).toBeNull();
    }
  });
});

describe('M4-4 · argv contract', () => {
  const CTX = { jsRuntimePath: 'C:/runtime/node.exe', ffmpegDir: 'C:/runtime/ffmpeg', artifactManifestPath: 'C:/temp/manifest.txt' };

  it('a batch task emits --yes-playlist + --playlist-items and no --no-playlist', () => {
    const record = build(['a3']).records[0];
    if (record?.request === null || record?.request === undefined) throw new Error('missing request');
    const argv = buildDownload(record.request, CTX);
    // D-245: the isolation prefix occupies the first two positions.
    expect(argv[0]).toBe('--ignore-config');
    expect(argv[1]).toBe('--no-plugin-dirs');
    expect(argv[2]).toBe('--yes-playlist');
    expect(argv[3]).toBe('--playlist-items');
    expect(argv[4]).toBe('3');
    expect(argv).not.toContain('--no-playlist');
    expect(argv.filter((x) => x === '--playlist-items')).toHaveLength(1);
    expect(argv.at(-1)).toBe(PLAYLIST.webpage_url);
  });

  it('a normal single-video request is byte-for-byte unchanged', () => {
    const argv = buildDownload(baseRequest(), CTX);
    // D-245: the isolation prefix occupies the first two positions.
    expect(argv[0]).toBe('--ignore-config');
    expect(argv[1]).toBe('--no-plugin-dirs');
    expect(argv[2]).toBe('--no-playlist');
    expect(argv).not.toContain('--yes-playlist');
    expect(argv).not.toContain('--playlist-items');
  });

  it('an injected expression is rejected and falls back to single-video mode', () => {
    const request = {
      ...baseRequest(),
      advanced: { ...baseRequest().advanced, playlistItems: '1; rm -rf /' },
    };
    const argv = buildDownload(request, CTX);
    expect(argv[2]).toBe('--no-playlist');
    expect(argv).not.toContain('--playlist-items');
  });
});

// ---------------------------------------------------------------------------
// Batch execution: 5 tasks, independent progress, concurrency respected.
// ---------------------------------------------------------------------------
interface Stats { active: number; maxActive: number; started: string[]; downloads: number }

function engine(stats: Stats, delayMs: number): DownloadEngine {
  return {
    async version() { return 'fake'; },
    async probe() {
      return {
        id: 'fixture', title: 'fixture', uploader: null, uploader_id: null, duration: 1,
        thumbnail: null, webpage_url: 'https://example.org/v', extractor_key: 'generic',
        description: null, upload_date: null, ext: 'mp4', formats: [], subtitles: {},
        automatic_captions: {}, chapters: null, _type: 'video' as const,
      };
    },
    async probePlaylist() { throw new Error('not used'); },
    download(req: DownloadRequest, onEvent: (e: EngineEvent) => void) {
      stats.downloads += 1;
      stats.active += 1;
      stats.maxActive = Math.max(stats.maxActive, stats.active);
      stats.started.push(req.taskId);
      let settled = false;
      const finish = (): void => { if (!settled) { settled = true; stats.active -= 1; } };
      setTimeout(() => {
        if (settled) return;
        onEvent({ type: 'progress', taskId: req.taskId, percent: 50, downloadedBytes: 1, totalBytes: 2, speedBps: 1, etaSec: 1, rawLine: 'x' });
        onEvent({
          type: 'completed', taskId: req.taskId,
          artifacts: [{ taskId: req.taskId, path: `C:/V/${req.taskId}.mp4`, kind: 'video', sizeBytes: 1 }],
        });
        finish();
      }, delayMs);
      return { pid: 1, cancel: async () => { onEvent({ type: 'canceled', taskId: req.taskId }); finish(); return true; } };
    },
    async selfUpdate() { return { fromVersion: '', toVersion: '', channel: 'stable', changed: false }; },
  };
}

const verifier = {
  async verify() {
    return {
      taskId: 'x', artifacts: [], postprocessed: false,
      criteria: [{ id: 'C1' as const, status: 'PASS' as const, detail: 'ok' }],
      ok: true, failureCode: null, durationMs: 1,
    };
  },
};

describe('M4-4 · 原始验收 ③ — 5 条 → 5 个独立任务，并发不超限', () => {
  it('enqueues one task per entry and keeps the slot limit', async () => {
    const mem = createInMemoryPorts();
    const stats: Stats = { active: 0, maxActive: 0, started: [], downloads: 0 };
    const queue = new TaskQueue({
      ports: mem.ports, engine: engine(stats, 15), verifier,
      history: new HistoryStore({ ports: mem.ports }), jsRuntimePath: 'C:/runtime/node.exe',
      concurrency: 2,
    });

    const plan = build(['a1', 'a2', 'a3', 'a4', 'a5']);
    const ids = await queue.enqueueBatch(plan.records);
    expect(ids).toHaveLength(5);
    expect(queue.list()).toHaveLength(5);
    expect(queue.activeTaskIds).toHaveLength(2);
    expect(queue.pendingCount).toBe(3);

    const startedAt = Date.now();
    while (!queue.list().every((r) => r.state === 'Completed')) {
      if (Date.now() - startedAt > 3000) throw new Error('batch did not finish');
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(stats.maxActive).toBe(2);
    expect(stats.downloads).toBe(5);
    // Independent records: same URL, different playlist items.
    expect(new Set(queue.list().map((r) => r.request?.advanced.playlistItems)).size).toBe(5);
  });
});

describe('D-69 · production batches use entry URLs, not playlist positions', () => {
  it('gives every selected entry its own URL and clears --playlist-items', () => {
    const plan = buildPlaylistBatchRecordsByUrl({
      playlist: PLAYLIST,
      selectedIds: ['a5', 'a1'],
      baseRequest: baseRequest(),
      kind: 'video',
      createdAt: '2026-11-07T00:00:00.000Z',
    });
    expect(plan.unknownIds).toEqual([]);
    expect(plan.records.map((r) => r.url)).toEqual([
      'https://example.org/watch?v=a5',
      'https://example.org/watch?v=a1',
    ]);
    expect(plan.records.map((r) => r.request?.url)).toEqual(plan.records.map((r) => r.url));
    expect(plan.records.every((r) => r.request?.advanced.playlistItems === null)).toBe(true);
    const argv = buildDownload(plan.records[0]!.request!, {
      jsRuntimePath: 'C:/runtime/node.exe',
      ffmpegDir: 'C:/runtime/ffmpeg',
      artifactManifestPath: 'C:/T/ytvdlt-artifacts-t.txt',
    });
    expect(argv).toContain('--no-playlist');
    expect(argv).not.toContain('--yes-playlist');
  });

  it('keeps the position fallback when an extractor gives no entry URL', () => {
    const noUrls: PlaylistInfo = {
      ...PLAYLIST,
      entries: PLAYLIST.entries.map((entry) => ({ ...entry, url: '' })),
    };
    const plan = buildPlaylistBatchRecordsByUrl({
      playlist: noUrls,
      selectedIds: ['a2'],
      baseRequest: baseRequest(),
      kind: 'video',
      createdAt: '2026-11-07T00:00:00.000Z',
    });
    expect(plan.records[0]?.url).toBe(PLAYLIST.webpage_url);
    expect(plan.records[0]?.request?.advanced.playlistItems).toBe('2');
  });
});

// ---------------------------------------------------------------------------
// P2 fix · the playlist-title directory layer (`title-layer.ts`).
//
// An entry-URL batch record downloads with `--no-playlist`, so the plan's
// `%(playlist|.)s` layer collapses to the relative no-op `.` inside yt-dlp
// (D-290) and "按播放列表分类" never grouped the production path. The batch
// knows `playlist.title` at record time, so the title is baked into the
// record's `paths.outputTemplate` as a LITERAL directory layer.
// ---------------------------------------------------------------------------
describe('P2 fix · playlistTitleTemplateLayer (pure rules)', () => {
  it('returns no layer when the switch is off or the title is unusable', () => {
    expect(playlistTitleTemplateLayer('My List', false)).toBe('');
    expect(playlistTitleTemplateLayer('My List', undefined as unknown as boolean)).toBe('');
    expect(playlistTitleTemplateLayer('', true)).toBe('');
    expect(playlistTitleTemplateLayer('   ', true)).toBe('');
    expect(playlistTitleTemplateLayer(null as unknown as string, true)).toBe('');
  });

  it('keeps the readable title (readability over aggressive cleaning) and appends the separator', () => {
    expect(playlistTitleTemplateLayer('My List', true)).toBe('My List/');
    expect(playlistTitleTemplateLayer('中文播放列表 2024', true)).toBe('中文播放列表 2024/');
    // D-270: spaces STAY in the baked template — the plan's argv-safety
    // `sanitizeToken` rewrites them to `_` on BOTH chains (argv + preview),
    // so the on-disk `My_List` is exactly what the preview showed.
  });

  it('never carries a separator, a dot-run, or a reserved device name', () => {
    expect(playlistTitleTemplateLayer('a/b\\c', true)).toBe('a_b_c/');
    expect(playlistTitleTemplateLayer('a<b>c:d"e|f?g*h', true)).toBe('a_b_c_d_e_f_g_h/');
    // sanitizeFileName's never-empty fallback maps dot-runs to `_` (a usable,
    // honest directory) instead of a phantom empty layer.
    expect(playlistTitleTemplateLayer('..', true)).toBe('_/');
    expect(playlistTitleTemplateLayer('...', true)).toBe('_/');
    expect(playlistTitleTemplateLayer('CON', true)).toBe('_CON/');
    expect(playlistTitleTemplateLayer('name.', true)).toBe('name/');
  });

  it(`caps the layer at PLAYLIST_TITLE_LAYER_MAX (${PLAYLIST_TITLE_LAYER_MAX}) to defend the Windows 260 budget`, () => {
    const layer = playlistTitleTemplateLayer('X'.repeat(200), true);
    expect(layer).toBe(`${'X'.repeat(PLAYLIST_TITLE_LAYER_MAX)}/`);
    expect(layer.length).toBe(PLAYLIST_TITLE_LAYER_MAX + 1);
    // A cut inside a dots run must re-strip the re-exposed trailing dots —
    // otherwise Windows would refuse the trailing-dot directory.
    const dotted = `${'A'.repeat(PLAYLIST_TITLE_LAYER_MAX - 1)}.${'B'.repeat(10)}`;
    expect(playlistTitleTemplateLayer(dotted, true))
      .toBe(`${'A'.repeat(PLAYLIST_TITLE_LAYER_MAX - 1)}/`);
  });

  it('bakePlaylistTitleLayer: plain prefix; behind a leading chapter: selector (手册坑 46)', () => {
    expect(bakePlaylistTitleLayer('%(title)s.%(ext)s', 'My_List/'))
      .toBe('My_List/%(title)s.%(ext)s');
    // The user's own chapter: SELECTOR keeps selecting everything after it —
    // the layer must never land in front of a `chapter:` token.
    expect(bakePlaylistTitleLayer('chapter:%(title)s.%(ext)s', 'My_List/'))
      .toBe('chapter:My_List/%(title)s.%(ext)s');
    // No layer -> byte-identical no-op.
    expect(bakePlaylistTitleLayer('%(title)s.%(ext)s', '')).toBe('%(title)s.%(ext)s');
  });
});

describe('P2 fix · buildPlaylistBatchRecordsByUrl bakes the layer (entry-url records only)', () => {
  it('switch on + entry url -> the literal layer rides the record template and the final -o', () => {
    const plan = buildPlaylistBatchRecordsByUrl({
      playlist: PLAYLIST,
      selectedIds: ['a1', 'a2'],
      baseRequest: baseRequest(),
      kind: 'video',
      createdAt: '2026-11-28T00:00:00.000Z',
    });
    expect(plan.records.every((r) => r.request?.advanced.playlistItems === null)).toBe(true);
    for (const record of plan.records) {
      expect(record.request?.paths.outputTemplate)
        .toBe('Recorded Flat Playlist/%(title)s.%(ext)s');
    }
    // End to end through the REAL argv builder: the plan wraps the layer
    // (after the categorized prefix) and sanitizes the title's space to `_`.
    const argv = buildDownload(plan.records[0]!.request!, {
      jsRuntimePath: 'C:/runtime/node.exe',
      ffmpegDir: 'C:/runtime/ffmpeg',
      artifactManifestPath: 'C:/T/ytvdlt-artifacts-a1.txt',
    });
    expect(argv[argv.indexOf('-o') + 1])
      .toBe('%(playlist|.)s/Recorded_Flat_Playlist/%(title)s.%(ext)s');
    // Everything else on the record stays byte-identical (url, domains).
    expect(plan.records[0]?.request?.url).toBe('https://example.org/watch?v=a1');
    expect(plan.records[0]?.request?.paths.subdirByPlaylist).toBe(true);
  });

  it('switch off -> template untouched', () => {
    const off = baseRequest();
    const plan = buildPlaylistBatchRecordsByUrl({
      playlist: PLAYLIST,
      selectedIds: ['a1'],
      baseRequest: { ...off, paths: { ...off.paths, subdirByPlaylist: false } },
      kind: 'video',
      createdAt: '2026-11-28T00:00:00.000Z',
    });
    expect(plan.records[0]?.request?.paths.outputTemplate).toBe('%(title)s.%(ext)s');
  });

  it('fallback records (no entry url) are NEVER baked — the engine fills %(playlist)s there', () => {
    const noUrls: PlaylistInfo = {
      ...PLAYLIST,
      entries: PLAYLIST.entries.map((entry) => ({ ...entry, url: '' })),
    };
    const plan = buildPlaylistBatchRecordsByUrl({
      playlist: noUrls,
      selectedIds: ['a2'],
      baseRequest: baseRequest(),
      kind: 'video',
      createdAt: '2026-11-28T00:00:00.000Z',
    });
    expect(plan.records[0]?.request?.advanced.playlistItems).toBe('2');
    // Baking here would create the playlist directory TWICE (literal layer +
    // the engine-resolved %(playlist)s field).
    expect(plan.records[0]?.request?.paths.outputTemplate).toBe('%(title)s.%(ext)s');
  });

  it('a title that sanitizes to nothing usable bakes nothing even with the switch on', () => {
    const plan = buildPlaylistBatchRecordsByUrl({
      playlist: { ...PLAYLIST, title: '   ' },
      selectedIds: ['a1'],
      baseRequest: baseRequest(),
      kind: 'video',
      createdAt: '2026-11-28T00:00:00.000Z',
    });
    expect(plan.records[0]?.request?.paths.outputTemplate).toBe('%(title)s.%(ext)s');
  });
});
