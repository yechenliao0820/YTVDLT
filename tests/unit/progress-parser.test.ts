/**
 * A-M2-05 / A-M2-06 / A-M2-07 · progress parsing.
 * Covers NA/empty/negative/malformed lines, the 3-tier percent fallback,
 * `speed === 0` legality, and the documented multi-stream rollback.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseProgressLine, parseProgressChunk, parseNumericField, PROGRESS_LINE_PREFIX,
} from '@ytvdlt/engine-ytdlp';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');

describe('A-M2-05 progress parser · line filtering & tolerance', () => {
  it('parses a well-formed line into all 6 numeric fields + percent', () => {
    const event = parseProgressLine('YTVDLT|150000|308666|NA|1900000|9|1.5', 't1');
    expect(event).not.toBeNull();
    expect(event?.taskId).toBe('t1');
    expect(event?.stage).toBe('downloading');
    expect(event?.downloadedBytes).toBe(150000);
    expect(event?.totalBytes).toBe(308666);
    expect(event?.speedBps).toBe(1900000);
    expect(event?.etaSec).toBe(9);
    expect(event?.elapsedSec).toBe(1.5);
    expect(event?.percent).toBeCloseTo(48.6, 1);
    expect(event?.rawLine).toBe('YTVDLT|150000|308666|NA|1900000|9|1.5');
  });

  it('ignores every non-prefixed human-readable line', () => {
    for (const line of [
      '[download]  48.6% of 301.43KiB at 1.81MiB/s ETA 00:09',
      '[info] fixture: Downloading 1 format(s): 0',
      '[youtube] extracting',
      '',
      '   ',
    ]) {
      expect(parseProgressLine(line, 't1'), line).toBeNull();
    }
    expect(PROGRESS_LINE_PREFIX).toBe('YTVDLT|');
  });

  it('returns null for a wrong segment count', () => {
    expect(parseProgressLine('YTVDLT|100|200|300', 't1')).toBeNull();
    expect(parseProgressLine('YTVDLT|1|2|3|4|5|6|7|8', 't1')).toBeNull();
  });

  it('is defensive against a non-string input (never throws)', () => {
    expect(parseProgressLine(null as never, 't1')).toBeNull();
    expect(parseProgressLine(undefined as never, 't1')).toBeNull();
    expect(parseProgressLine(42 as never, 't1')).toBeNull();
  });

  it('treats NA / N/A / None / null / empty as null', () => {
    for (const token of ['NA', 'N/A', 'None', 'null', 'undefined', '', '  ']) {
      expect(parseNumericField(token), token).toBeNull();
    }
    const event = parseProgressLine('YTVDLT|NA|NA|NA|NA|NA|NA', 't1');
    expect(event?.downloadedBytes).toBeNull();
    expect(event?.totalBytes).toBeNull();
    expect(event?.percent).toBeNull();
    expect(event?.speedBps).toBeNull();
    expect(event?.etaSec).toBeNull();
  });

  it('rejects negatives, NaN and Infinity', () => {
    expect(parseNumericField('-5')).toBeNull();
    expect(parseNumericField('NaN')).toBeNull();
    expect(parseNumericField('Infinity')).toBeNull();
    const event = parseProgressLine('YTVDLT|-5|308666|NA|-100|-3|0', 't1');
    expect(event?.downloadedBytes).toBeNull();
    expect(event?.speedBps).toBeNull();
    expect(event?.etaSec).toBeNull();
    expect(event?.percent).toBeNull();
  });
});

describe('A-M2-06 percent · three-tier fallback', () => {
  it('prefers total, then total_estimate, then null', () => {
    // tier 1: total present
    expect(parseProgressLine('YTVDLT|50|100|999|10|5|1', 't1')?.percent).toBe(50);
    // tier 2: total missing, estimate present
    expect(parseProgressLine('YTVDLT|100|NA|200|10|5|1', 't1')?.percent).toBe(50);
    // tier 3: neither usable
    expect(parseProgressLine('YTVDLT|100|NA|NA|10|5|1', 't1')?.percent).toBeNull();
  });

  it('clamps to 0..100 and rounds to one decimal', () => {
    expect(parseProgressLine('YTVDLT|999|100|NA|10|0|1', 't1')?.percent).toBe(100);
    expect(parseProgressLine('YTVDLT|1|3|NA|10|0|1', 't1')?.percent).toBe(33.3);
  });

  it('keeps speed === 0 as a legal value (not null)', () => {
    const event = parseProgressLine('YTVDLT|50|100|NA|0|0|0.5', 't1');
    expect(event?.speedBps).toBe(0);
    expect(event?.etaSec).toBe(0);
  });
});

describe('A-4.4-11 / A-4.4-12 progress · recorded fixtures', () => {
  it('progress-basic.log yields monotonically increasing percent (single stream)', () => {
    const { events, rest } = parseProgressChunk(fixture('progress-basic.log'), 't1');
    expect(rest).toBe('');
    expect(events.length).toBeGreaterThanOrEqual(5);
    const percents = events.map((e) => e.percent ?? -1);
    for (let index = 1; index < percents.length; index += 1) {
      expect(percents[index]).toBeGreaterThanOrEqual(percents[index - 1] as number);
    }
    expect(percents.at(-1)).toBe(100);
    // speed/eta are present (A-4.4-12), first line legitimately null.
    expect(events.some((e) => e.speedBps !== null)).toBe(true);
    expect(events.some((e) => e.etaSec !== null)).toBe(true);
  });

  it('progress-edge.log tolerates garbage and shows the documented rollback', () => {
    const { events } = parseProgressChunk(fixture('progress-edge.log'), 't1');
    // 10 prefixed lines have 7 segments; the 4-segment one is dropped.
    expect(events.length).toBe(10);
    const percents = events.map((e) => e.percent);
    expect(percents[0]).toBeNull();          // all NA
    expect(percents[1]).toBeNull();          // empty downloaded
    expect(percents[2]).toBeNull();          // negatives
    expect(percents[3]).toBe(50);            // total_estimate fallback
    expect(percents[4]).toBe(50);
    expect(percents[5]).toBe(100);
    // multi-stream: 100 -> 0 -> 100 (rollback is real, hence the D-18 limit)
    expect(percents[6]).toBe(0);
    expect(percents[7]).toBe(100);
    expect(percents[8]).toBeNull();          // NaN/Infinity
    expect(percents[9]).toBeNull();          // None/null/undefined
  });

  it('keeps a trailing partial line in `rest` (chunk boundary safe)', () => {
    const out = parseProgressChunk('YTVDLT|1|2|NA|3|4|5\nYTVDLT|6|7', 't1');
    expect(out.events).toHaveLength(1);
    expect(out.rest).toBe('YTVDLT|6|7');
    expect(parseProgressLine('YTVDLT|6|7|NA|8|9|10', 't1')?.downloadedBytes).toBe(6);
  });
});
