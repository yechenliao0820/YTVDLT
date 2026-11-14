/** Download history DTOs. Pure types only. */
import type { DownloadKind } from './task.js';

export interface HistoryEntry {
  /** Stable unique id (taskId or uuid). */
  id: string;
  taskId: string;
  url: string;
  title: string;
  uploader: string | null;
  durationSec: number | null;
  /** Absolute product path (C11 verification target). */
  videoPath: string;
  audioPath: string | null;
  thumbnailPath: string | null;
  subtitlePaths: string[];
  /** Measured on-disk size of `videoPath`; `0` = unknown, never fabricated. */
  sizeBytes: number;
  extractorKey: string;
  downloadType: DownloadKind;
  formatId: string | null;
  createdAt: string;
  completedAt: string;
}

export interface HistoryQuery {
  /** Case-insensitive contains match on title / uploader / videoPath. */
  text?: string;
  downloadType?: DownloadKind;
  extractorKey?: string;
  limit?: number;
  offset?: number;
}

export type HistoryAddResult =
  | { added: true; entry: HistoryEntry }
  | { added: false; reason: 'duplicate'; existing: HistoryEntry }
  | { added: false; reason: 'private-mode' };
