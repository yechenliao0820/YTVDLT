/**
 * D-153 — bounded line-assembly (pending) buffer for the streaming download
 * stdout.
 *
 * `parseProgressChunk` keeps the last unterminated line in `rest`, and the
 * engine used to re-accumulate it with an unbounded `pending += chunk.text` —
 * stdout that never emits a newline grew that string without limit for as
 * long as the child ran. The fix bounds `pending` at PROGRESS_PENDING_MAX_BYTES
 * by dropping the OLDEST prefix, counted and logged once after the run.
 *
 * Two levels, mirroring stream-tail-buffer.test.ts (D-144):
 *
 *  L0 · pure byte accounting (`dropUtf8Prefix`) — byte-exactness (ASCII,
 *       CJK glyphs, surrogate pairs), code-point-boundary cuts, and the
 *       invariant `droppedBytes + utf8ByteLength(rest) === utf8ByteLength(text)`
 *       that keeps the engine's incremental accounting exact.
 *
 *  L0 · the engine's spawnStreaming chunk handler on the in-memory
 *       ProcessPort (scripted chunks, zero real processes):
 *         - a no-newline flood far above the ceiling stays bounded, never
 *           throws, and is reported once after the run;
 *         - landing EXACTLY on the ceiling is accepted (no warning), like
 *           D-144's tail;
 *         - a CJK flood is bounded on UTF-8 bytes although a `String.length`
 *           accounting would have waved it through (手册坑 23);
 *         - after a flood, normal newline progress lines still parse (the
 *           guard must never corrupt the working buffer's job);
 *         - normal line-by-line output (LF / CRLF, lines split across chunk
 *           boundaries) is observably unchanged and logs no warning.
 *
 * The realtime `onChunk` feed and the D-144 stderr tail buffer are separate
 * mechanisms and stay untouched — asserted here only where the two could be
 * confused (a stdout flood must never stamp the stderr STREAM_TAIL marker).
 */
import { describe, it, expect } from 'vitest';
import { PROGRESS_PENDING_MAX_BYTES } from '@ytvdlt/shared';
import type { DownloadRequest, EngineEvent } from '@ytvdlt/shared';
import { YtDlpEngine } from '@ytvdlt/engine-ytdlp';
import { Logger, ErrorMapper } from '@ytvdlt/core';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';
import { dropUtf8Prefix, utf8ByteLength } from '../../packages/engine-ytdlp/src/yt-dlp-engine.js';

/** A lone (unpaired) surrogate means a cut landed inside a code point. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ---------------------------------------------------------------------------
// L0 · dropUtf8Prefix byte accounting (yt-dlp-engine.ts)
// ---------------------------------------------------------------------------

describe('D-153 · dropUtf8Prefix byte accounting (L0)', () => {
  it('drops an ASCII prefix byte-exactly', () => {
    const cut = dropUtf8Prefix('abcdefghij', 4);
    expect(cut.rest).toBe('efghij');
    expect(cut.droppedBytes).toBe(4);
    expect(utf8ByteLength(cut.rest) + cut.droppedBytes).toBe(utf8ByteLength('abcdefghij'));
  });

  it('a non-positive drop and empty text are no-ops', () => {
    expect(dropUtf8Prefix('abc', 0)).toEqual({ rest: 'abc', droppedBytes: 0 });
    expect(dropUtf8Prefix('abc', -5)).toEqual({ rest: 'abc', droppedBytes: 0 });
    expect(dropUtf8Prefix('', 10)).toEqual({ rest: '', droppedBytes: 0 });
  });

  it('a drop of the whole buffer empties it and books every byte', () => {
    expect(dropUtf8Prefix('中中中', utf8ByteLength('中中中'))).toEqual({ rest: '', droppedBytes: 9 });
    expect(dropUtf8Prefix('abcdef', 100)).toEqual({ rest: '', droppedBytes: 6 });
  });

  it('a cut inside a 3-byte CJK glyph moves FORWARD to the next boundary', () => {
    // Drop 1 requested → the whole first glyph (3 bytes) goes; the retained
    // tail stays well-formed, and the ACTUAL dropped bytes are booked.
    const cut = dropUtf8Prefix('中中中中', 1);
    expect(cut.rest).toBe('中中中');
    expect(cut.droppedBytes).toBe(3);
    expect(utf8ByteLength(cut.rest) + cut.droppedBytes).toBe(12);
    expect(LONE_SURROGATE.test(cut.rest)).toBe(false);
  });

  it('a surrogate pair moves as one 4-byte unit — never split', () => {
    // 🙂 is 4 UTF-8 bytes and a surrogate PAIR (2 UTF-16 units).
    const text = '🙂🙂🙂';
    const cut = dropUtf8Prefix(text, 2);
    expect(cut.rest).toBe('🙂🙂');
    expect(cut.droppedBytes).toBe(4);
    expect(utf8ByteLength(cut.rest) + cut.droppedBytes).toBe(utf8ByteLength(text));
    expect(LONE_SURROGATE.test(cut.rest)).toBe(false);
  });

  it('the accounting invariant holds through mixed-code-point text', () => {
    // ASCII + 2-byte + 3-byte + 4-byte code points, cut mid-glyph on purpose.
    const text = `aé中🙂${'b'.repeat(5)}中a`;
    let probe = dropUtf8Prefix(text, 1);
    // Walk every possible cut point: invariant + no lone surrogate, always.
    for (let drop = 1; drop <= utf8ByteLength(text); drop += 1) {
      probe = dropUtf8Prefix(text, drop);
      expect(probe.droppedBytes).toBeGreaterThanOrEqual(drop);
      expect(utf8ByteLength(probe.rest) + probe.droppedBytes).toBe(utf8ByteLength(text));
      expect(LONE_SURROGATE.test(probe.rest)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// L0 · the engine's spawnStreaming pending ceiling (in-memory port)
// ---------------------------------------------------------------------------

/** Same fixture shape as the L1 download contract test (D-118 temp-dir rule). */
const request = (taskId: string): DownloadRequest => ({
  taskId, url: 'https://example.org/v',
  format: { quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null, extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto', audioFormat: null, audioMultistreams: false },
  subtitle: { enabled: false, languages: 'en.*', autoCaptions: false, skipTranslated: true, convertTo: 'none', embed: false, keepSubtitleFile: false },
  paths: { videoDir: 'C:/out', audioDir: 'C:/out', commandDir: 'C:/cmd', privateMode: false, subdirByExtractor: false, subdirByPlaylist: false, outputTemplate: '%(title)s.%(ext)s', tempDir: `C:/temp/${taskId}` },
  network: { rateLimit: null, proxy: null, cookiesFile: null, userAgent: null, ipv4Only: false, concurrentFragments: null, aria2cPath: null },
  advanced: { sponsorblockRemove: null, downloadSections: null, splitChapters: false, customTitle: null, debug: false, downloadArchive: null, customCommand: null },
});

interface RunOutcome {
  events: EngineEvent[];
  percents: Array<number | null>;
  warnings: Array<{ drops: number; droppedBytes: number; limitBytes: number; retainedBytes: number }>;
}

async function runDownload(taskId: string, chunks: ReadonlyArray<{ stream: 'stdout' | 'stderr'; text: string }>): Promise<RunOutcome> {
  const { ports, state } = createInMemoryPorts();
  const artifact = 'C:/out/fixture.mp4';
  state.files.set(artifact, 'fixture-bytes');
  const manifestPath = `C:/temp/${taskId}/ytvdlt-artifacts-${taskId}.txt`;
  state.streamScripts.set('yt-dlp.exe', {
    chunks,
    exitCode: 0,
    writeFiles: { [manifestPath]: `"${artifact}"\n` },
  });
  const engine = new YtDlpEngine({
    ports,
    logger: new Logger({ ports, appVersion: '0.1.0' }),
    mapper: new ErrorMapper({ clock: ports.clock }),
    enginePath: 'C:/runtime/yt-dlp.exe',
    jsRuntimePath: 'C:/runtime/node.exe',
    appVersion: '0.1.0',
  });
  const events: EngineEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    engine.download(request(taskId), (event) => {
      events.push(event);
      if (event.type === 'completed') resolve();
      if (event.type === 'failed') reject(new Error(event.error.code));
    });
    setTimeout(() => reject(new Error('download did not settle')), 10_000);
  });
  const warnings = state.logLines
    .filter((line) => line.includes('"progress.pendingTruncated"'))
    .map((line) => JSON.parse(line) as { payload: RunOutcome['warnings'][number] })
    .map((parsed) => parsed.payload);
  return {
    events,
    percents: events.filter((e) => e.type === 'progress').map((e) => e.percent),
    warnings,
  };
}

describe('D-153 · spawnStreaming pending ceiling (L0, in-memory port)', () => {
  const CHUNK = 'a'.repeat(65_536); // 64 KiB ASCII, never a newline
  const LIMIT = PROGRESS_PENDING_MAX_BYTES; // 1 MiB, same magnitude as D-144's tail

  it('a no-newline flood far over the ceiling stays bounded and never throws', async () => {
    // 40 × 64 KiB = 2,621,440 B > 1 MiB. The first 16 chunks fit; every chunk
    // after that triggers exactly one whole-chunk trim (ASCII = exact bytes).
    const flood = Array.from({ length: 40 }, () => ({ stream: 'stdout' as const, text: CHUNK }));
    const run = await runDownload('flood-1', flood);

    // No exception (the run settled), no phantom progress events from garbage.
    expect(run.events.at(-1)?.type).toBe('completed');
    expect(run.percents).toEqual([]);

    // Exactly one post-run warning with byte-exact numbers: 24 trims of
    // 64 KiB each leave exactly the ceiling in the buffer.
    expect(run.warnings).toHaveLength(1);
    expect(run.warnings[0]?.drops).toBe(24);
    expect(run.warnings[0]?.droppedBytes).toBe(40 * 65_536 - LIMIT);
    expect(run.warnings[0]?.retainedBytes).toBe(LIMIT);
    expect(run.warnings[0]?.limitBytes).toBe(LIMIT);
  });

  it('landing EXACTLY on the ceiling is accepted — no trim, no warning', async () => {
    // 16 × 64 KiB = 1,048,576 = the ceiling: `>` (not `>=`) keeps D-144's
    // "exactly on the ceiling is accepted" semantics.
    const flood = Array.from({ length: 16 }, () => ({ stream: 'stdout' as const, text: CHUNK }));
    const run = await runDownload('flood-exact', flood);
    expect(run.events.at(-1)?.type).toBe('completed');
    expect(run.warnings).toHaveLength(0);
  });

  it('a CJK flood is bounded on UTF-8 bytes although String.length would wave it through', async () => {
    // 600k glyphs = 1.8 MB UTF-8 but only 600k UTF-16 units — UNDER the
    // ceiling as units, way over as bytes (手册坑 23).
    const glyphs = 600_000;
    const run = await runDownload('flood-cjk', [
      { stream: 'stdout', text: '中'.repeat(glyphs) },
    ]);
    expect(run.events.at(-1)?.type).toBe('completed');
    expect(glyphs).toBeLessThan(LIMIT); // the counterfactual: length-based guard would skip
    expect(run.warnings).toHaveLength(1);
    const warning = run.warnings[0] as { drops: number; droppedBytes: number; retainedBytes: number };
    expect(warning.drops).toBe(1);
    // Whole glyphs only: 3 bytes each, cut forward to the next boundary.
    expect(warning.retainedBytes % 3).toBe(0);
    expect(warning.retainedBytes).toBeLessThanOrEqual(LIMIT);
    expect(warning.retainedBytes).toBeGreaterThan(LIMIT - 3);
    expect(warning.droppedBytes).toBe(3 * glyphs - warning.retainedBytes);
  });

  it('after a flood, normal newline progress lines still parse', async () => {
    // 20 × 64 KiB over the ceiling (4 trims), then REAL progress lines
    // starting on a FRESH line (what a process resuming line output does).
    // The recovery chunk opens with '\n' so the first progress line is not
    // fused with flood tail bytes: a line fused with garbage ('aaa…YTVDLT|…')
    // starts with flood bytes and is unparsable under the UNCHANGED parser
    // semantics — true before this fix too, so it is not a regression; what
    // matters is that parsing itself comes back intact.
    const flood = Array.from({ length: 20 }, () => ({ stream: 'stdout' as const, text: CHUNK }));
    const run = await runDownload('flood-recover', [
      ...flood,
      { stream: 'stdout', text: '\nYTVDLT|400|1000|NA|50|20|1.5\n' },
      { stream: 'stdout', text: 'YTVDLT|800|1000|NA|50|10|3\n' },
    ]);
    expect(run.events.at(-1)?.type).toBe('completed');
    expect(run.percents).toEqual([40, 80]);
    expect(run.warnings).toHaveLength(1);
    expect((run.warnings[0] as { drops: number }).drops).toBeGreaterThanOrEqual(1);
  });

  it('normal line-by-line output is observably unchanged and logs no warning', async () => {
    // LF and CRLF, and a line SPLIT across chunk boundaries in both ways —
    // the shapes the D-153 fast path could have broken if it skipped parses
    // too eagerly. Events must be identical to the legacy behaviour.
    const run = await runDownload('normal-1', [
      // CRLF split across the boundary: '\r' ends chunk 1 (no '\n'), '\n'
      // opens chunk 2 — the parse must still see the joined line.
      { stream: 'stdout', text: 'YTVDLT|400|1000|NA|50|20|1.5\r' },
      { stream: 'stdout', text: '\nYTVDLT|800|1000|NA|50|10|3\n' },
      // A partial line split mid-field.
      { stream: 'stdout', text: 'YTVDLT|9' },
      { stream: 'stdout', text: '00|1000|NA|50|0|4\n' },
    ]);
    expect(run.events.at(-1)?.type).toBe('completed');
    expect(run.percents).toEqual([40, 80, 90]);
    expect(run.warnings).toHaveLength(0);
  });
});
