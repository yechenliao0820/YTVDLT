import type { AppError } from './errors.js';

/**
 * A produced file. `path` is absolute; M2 obtains it from `--print after_move:filepath`.
 *
 * `other` (stage 4, append-only): the classification is deliberately NOT
 * "everything unknown is video". A `.srv3` / `.ttml` / `.json3` subtitle used to
 * fall through to `video` and then became "the main file" of the task; an
 * unknown extension now says so instead of pretending. Media selection does not
 * depend on this field (see `primaryMediaArtifact`), so a wrong guess here can
 * no longer corrupt verification.
 */
export interface Artifact {
  taskId: string;
  path: string;
  kind: 'video' | 'audio' | 'subtitle' | 'thumbnail' | 'infojson' | 'other';
  sizeBytes: number | null;
}

/**
 * Where a running task actually is (D-115).
 *
 * `downloading` covers the byte transfer of EVERY stream — a video-only and an
 * audio-only pass each report their own 0%→100%, so a single 100% says nothing
 * about the task being finished. `merging` is only ever emitted after yt-dlp
 * itself printed `[Merger]`, and `postprocess` covers the remaining fixups
 * (audio extraction, container conversion, metadata, subtitle conversion).
 * `verifying` is set by the queue itself, after the engine exited 0 and before
 * the record is allowed to become `Completed`.
 *
 * Append-only: `fetching` / `downloading` / `postprocess` keep their meaning.
 */
export type EngineStage = 'fetching' | 'downloading' | 'merging' | 'postprocess' | 'verifying';

/**
 * D-115: ordinal of a stage. A running task may only move FORWARD: the second
 * stream of a video+audio pair restarts its byte counter at 0% and would
 * otherwise drag the card from "merging" back to "downloading" for a frame.
 * `verifying` is last because it happens after the process exited 0.
 */
const STAGE_ORDER: Readonly<Record<EngineStage, number>> = {
  fetching: 0,
  downloading: 1,
  merging: 2,
  postprocess: 3,
  verifying: 4,
};

/** Unknown values rank `-1`, i.e. they can never advance a task. */
export function stageRank(stage: string): number {
  const value = STAGE_ORDER[stage as EngineStage];
  return typeof value === 'number' ? value : -1;
}

/** True when `next` is reachable from `current` (same stage counts as reachable). */
export function isForwardStage(current: string | null | undefined, next: EngineStage): boolean {
  const to = stageRank(next);
  if (to < 0) return false;
  if (current === null || current === undefined || current === '') return true;
  return to >= stageRank(current);
}

/** HANDOFF §6.4: the Renderer only subscribes to events and sends commands. */
export type EngineEvent =
  | { type: 'stage'; taskId: string; stage: EngineStage }
  | {
      type: 'progress';
      taskId: string;
      percent: number | null;
      downloadedBytes: number | null;
      totalBytes: number | null;
      speedBps: number | null;
      etaSec: number | null;
      rawLine: string;
    }
  | { type: 'artifact'; taskId: string; path: string }
  | { type: 'completed'; taskId: string; artifacts: Artifact[] }
  | { type: 'failed'; taskId: string; error: AppError }
  | { type: 'canceled'; taskId: string };

export interface CancelHandle {
  cancel(): Promise<boolean>;
  readonly pid: number | null;
}

export interface UpdateResult {
  fromVersion: string;
  toVersion: string;
  channel: 'stable' | 'nightly';
  changed: boolean;
  rolledBack?: boolean;
  /**
   * M5 append-only (D-67): why nothing changed, machine-readable.
   * `up-to-date` means "the installed bytes already match the feed"; every other
   * value is a failure that the caller should surface (`checksum-mismatch`,
   * `manifest-unavailable`, `no-checksum-line`, `download-failed`, `swap-failed`).
   */
  reason?: string;
}
