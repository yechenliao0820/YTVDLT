import type { AppError } from './errors.js';

/** A produced file. `path` is absolute; M2 obtains it from `--print after_move:filepath`. */
export interface Artifact {
  taskId: string;
  path: string;
  kind: 'video' | 'audio' | 'subtitle' | 'thumbnail' | 'infojson';
  sizeBytes: number | null;
}

export type EngineStage = 'fetching' | 'downloading' | 'postprocess';

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
