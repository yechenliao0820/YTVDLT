/**
 * The C11/C12 history entry builder, split out of `task-queue.ts` (task-6
 * refactor).
 *
 * `buildHistoryEntry` was moved VERBATIM from `task-queue.ts` — behaviour is
 * byte-identical. It is pure: it reads the finished record, the artifact list
 * and the engine-measured sizes, and shapes the row; no `this`, no I/O (the
 * timestamp comes from the injected `ports.clock`). The CD-12 ordering iron
 * rule is NOT affected: `TaskQueue.run()` still calls `history.add()` only
 * after `verify().ok === true`, and never for a canceled task (D-209).
 */
import type { HistoryEntry, MediaInfo, TaskRecord, CorePorts } from '@ytvdlt/shared';
import {
  classifyArtifact, primaryMediaArtifact, subtitleArtifactsOf,
} from '../artifact-classify/index.js';

export function buildHistoryEntry(
  record: TaskRecord,
  artifacts: readonly string[],
  sizes: ReadonlyMap<string, number | null>,
  ports: CorePorts,
): HistoryEntry {
  const info: MediaInfo | null = record.mediaInfo;
  // Stage 4: `artifacts[0]` is a thumbnail or a subtitle often enough that it
  // must never be the history's `videoPath` — C11 verifies that path and the UI
  // opens it. Fall back to index 0 only when no media file exists at all, so a
  // degenerate run still produces an honest (and correctly failing) record.
  const primary = primaryMediaArtifact(artifacts) ?? artifacts[0] ?? '';
  const audio = artifacts.find((path) => classifyArtifact(path) === 'audio') ?? null;
  const thumb = artifacts.find((path) => classifyArtifact(path) === 'thumbnail') ?? null;
  const subs = subtitleArtifactsOf(artifacts);
  const timestamp = ports.clock.nowIso();
  // The engine fs.stat'd every artifact when the completed event was emitted;
  // the primary media file IS the product, so its measured size is the honest
  // history value. For a merged video+audio download that file is the merged
  // output — the per-stream progress totals (`record.lastTotalBytes`) describe
  // only the LAST stream and would under-report the product. `0` stays the
  // "unknown" sentinel (engine could not stat): an unknown size is never
  // fabricated into a non-zero number (D-107 spirit).
  const reported = sizes.get(primary);
  const sizeBytes = typeof reported === 'number' && Number.isFinite(reported) && reported > 0
    ? reported
    : 0;
  return {
    id: record.id,
    taskId: record.id,
    url: record.url,
    title: info?.title ?? '',
    uploader: info?.uploader ?? null,
    durationSec: info?.duration ?? null,
    videoPath: primary,
    audioPath: audio,
    thumbnailPath: thumb,
    subtitlePaths: subs,
    sizeBytes,
    extractorKey: info?.extractor_key ?? '',
    downloadType: record.kind,
    formatId: record.request?.format.formatId ?? null,
    createdAt: record.createdAt,
    completedAt: timestamp,
  };
}
