/**
 * Structured progress DTO (replaces Seal's discarded second callback arg).
 * Pure types only — no I/O, no node imports.
 */

export type ProgressStage = 'downloading' | 'postprocess';

export interface ProgressEvent {
  taskId: string;
  stage: ProgressStage;
  /** 0–100; null when both total and total_estimate are missing. */
  percent: number | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
  /** bytes/second; null when unknown (UI shows "—"). */
  speedBps: number | null;
  etaSec: number | null;
  elapsedSec: number | null;
  /** Raw (already-redacted) line, kept for logs/troubleshooting. */
  rawLine: string;
}
