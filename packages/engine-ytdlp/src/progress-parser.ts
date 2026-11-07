/**
 * Pure progress-line parser (D-18, A-4.4-11 / A-4.4-12 / A-M2-05..07).
 *
 * Only lines beginning with `YTVDLT|` are considered; every human-readable
 * `[download]` / `[info]` line is ignored. Any unusable field becomes `null`,
 * never NaN / Infinity / negative.
 */
import type { ProgressEvent, ProgressStage } from '@ytvdlt/shared';
import {
  PROGRESS_LINE_PREFIX, PROGRESS_FIELD_SEPARATOR, PROGRESS_SEGMENT_COUNT,
} from './progress-template.js';

/** Tokens yt-dlp emits when a value is unavailable. */
const NULL_TOKENS = new Set(['', 'NA', 'N/A', 'None', 'null', 'undefined']);

/** Parse one numeric field; unusable values (incl. negatives) become null. */
export function parseNumericField(raw: string): number | null {
  const token = raw.trim();
  if (NULL_TOKENS.has(token)) return null;
  const value = Number(token);
  if (!Number.isFinite(value)) return null;
  if (value < 0) return null;
  // `0` is a legal observation (e.g. stalled speed) and is returned as-is.
  return value;
}

function clampPercent(value: number): number {
  // Inputs are built from two non-negative values, so only the upper bound
  // can ever be exceeded (downloaded > total while yt-dlp settles estimates).
  if (value > 100) return 100;
  return Math.round(value * 10) / 10;
}

/**
 * Parse a single stdout line.
 * @returns a ProgressEvent, or null when the line is not a progress line.
 */
export function parseProgressLine(line: string, taskId: string): ProgressEvent | null {
  // Defensive: chunk callbacks are typed, but a bad caller must not crash the run.
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed.startsWith(PROGRESS_LINE_PREFIX)) return null;

  const segments = trimmed.split(PROGRESS_FIELD_SEPARATOR);
  if (segments.length !== PROGRESS_SEGMENT_COUNT) return null;

  // Segment count is exact, so indices 1..6 always exist.
  const downloadedBytes = parseNumericField(segments[1] as string);
  const totalBytes = parseNumericField(segments[2] as string);
  const totalEstimate = parseNumericField(segments[3] as string);
  const speedBps = parseNumericField(segments[4] as string);
  const etaSec = parseNumericField(segments[5] as string);
  const elapsedSec = parseNumericField(segments[6] as string);

  let percent: number | null = null;
  if (downloadedBytes !== null && totalBytes !== null && totalBytes > 0) {
    percent = clampPercent((downloadedBytes / totalBytes) * 100);
  } else if (downloadedBytes !== null && totalEstimate !== null && totalEstimate > 0) {
    percent = clampPercent((downloadedBytes / totalEstimate) * 100);
  }

  return {
    taskId,
    stage: 'downloading',
    percent,
    downloadedBytes,
    totalBytes,
    speedBps,
    etaSec,
    elapsedSec,
    rawLine: trimmed,
  };
}

/**
 * Parse a whole stdout buffer into events.
 * Keeps a trailing partial line in `rest` so chunk boundaries are lossless.
 */
export function parseProgressChunk(
  buffer: string,
  taskId: string,
): { events: ProgressEvent[]; rest: string } {
  const lines = buffer.split(/\r?\n/);
  // split() always yields at least one element, so pop() is never undefined.
  const rest = lines.pop() as string;
  const events: ProgressEvent[] = [];
  for (const line of lines) {
    const event = parseProgressLine(line, taskId);
    if (event !== null) events.push(event);
  }
  return { events, rest };
}

/**
 * M3 B3 / D-18 · split a multi-stream progress stream into monotonic stages.
 *
 * With `bestvideo+bestaudio` yt-dlp prints two independent 0->100% runs, so a
 * naive "percent must increase" assertion fails at the stream boundary. A new
 * segment starts when the stage changes OR percent drops. Callers can then
 * assert monotonicity PER SEGMENT instead of across the whole run.
 */
export interface ProgressStageSegment {
  readonly index: number;
  readonly stage: ProgressStage;
  /** Index of the first event in this segment (inclusive). */
  readonly startEvent: number;
  /** Index after the last event in this segment (exclusive). */
  readonly endEvent: number;
  readonly percents: readonly number[];
  /** True when every observed percent in the segment is non-decreasing. */
  readonly monotonic: boolean;
}

function finalizeSegment(
  index: number,
  stage: ProgressStage,
  startEvent: number,
  endEvent: number,
  percents: readonly number[],
): ProgressStageSegment {
  let monotonic = true;
  for (let i = 1; i < percents.length; i += 1) {
    if ((percents[i] as number) < (percents[i - 1] as number)) {
      monotonic = false;
      break;
    }
  }
  return { index, stage, startEvent, endEvent, percents, monotonic };
}

export function segmentProgressByStage(
  events: readonly ProgressEvent[],
): ProgressStageSegment[] {
  if (!Array.isArray(events) || events.length === 0) return [];
  const segments: ProgressStageSegment[] = [];
  let stage: ProgressStage = 'downloading';
  let startEvent = 0;
  let percents: number[] = [];
  let lastPercent: number | null = null;
  let open = false;

  events.forEach((event, index) => {
    const eventStage: ProgressStage = event?.stage === 'postprocess' ? 'postprocess' : 'downloading';
    const raw = event?.percent;
    const percent = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    const needsNewSegment = !open
      || eventStage !== stage
      || (percent !== null && lastPercent !== null && percent < lastPercent);
    if (needsNewSegment) {
      if (open) {
        segments.push(finalizeSegment(segments.length, stage, startEvent, index, percents));
      }
      stage = eventStage;
      startEvent = index;
      percents = [];
      lastPercent = null;
      open = true;
    }
    if (percent !== null) {
      percents.push(percent);
      lastPercent = percent;
    }
  });
  if (open) {
    segments.push(finalizeSegment(segments.length, stage, startEvent, events.length, percents));
  }
  return segments;
}
