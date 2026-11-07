/**
 * Playlist batch planning (M4-4 / 原始验收 ③).
 *
 * A "batch" is N INDEPENDENT tasks: one `TaskRecord` per selected entry, each
 * carrying `advanced.playlistItems = '<n>'` (1-based position inside the
 * original playlist). They share the playlist URL, so yt-dlp resolves exactly
 * one item per task and every task gets its own progress / cancel / retry and
 * its own slot in the concurrency pool.
 *
 * Pure: no I/O, no clock, deterministic ids.
 */
import type {
  DownloadKind, DownloadRequest, PlaylistEntry, PlaylistInfo, TaskRecord,
} from '@ytvdlt/shared';

export interface PlaylistBatchInput {
  readonly playlist: PlaylistInfo;
  /** Entry ids confirmed in the playlist dialog (order is irrelevant). */
  readonly selectedIds: readonly string[];
  /** Five-domain request template; `taskId` / `url` / `playlistItems` are replaced. */
  readonly baseRequest: DownloadRequest;
  readonly kind: DownloadKind;
  readonly createdAt: string;
  readonly privateMode?: boolean;
  /** Defaults to `<playlistId>-<entryId>`; must be unique. */
  readonly makeTaskId?: (playlistId: string, entryId: string, position: number) => string;
}

export interface PlaylistBatchPlan {
  readonly records: readonly TaskRecord[];
  /** Selected ids that do not exist in `playlist.entries`. */
  readonly unknownIds: readonly string[];
  /** Duplicate selections, removed (first occurrence wins). */
  readonly duplicateIds: readonly string[];
}

export function defaultBatchTaskId(playlistId: string, entryId: string): string {
  return `${playlistId}-${entryId}`;
}

/**
 * Build one task per selected entry. Positions are taken from the ORIGINAL
 * playlist order (1-based), never from the click order, so `--playlist-items`
 * stays stable when the user reorders the selector UI.
 */
export function buildPlaylistBatchRecords(input: PlaylistBatchInput): PlaylistBatchPlan {
  const { playlist, selectedIds, baseRequest, kind, createdAt } = input;
  const positions = new Map<string, number>();
  playlist.entries.forEach((entry, index) => {
    if (!positions.has(entry.id)) positions.set(entry.id, index + 1);
  });

  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  const unknownIds: string[] = [];
  const records: TaskRecord[] = [];

  for (const rawId of selectedIds) {
    const entryId = String(rawId);
    if (seen.has(entryId)) {
      duplicateIds.push(entryId);
      continue;
    }
    seen.add(entryId);
    const position = positions.get(entryId);
    if (position === undefined) {
      unknownIds.push(entryId);
      continue;
    }
    const makeId = input.makeTaskId ?? defaultBatchTaskId;
    const taskId = makeId(playlist.id, entryId, position);
    const request: DownloadRequest = {
      ...baseRequest,
      taskId,
      url: playlist.webpage_url,
      advanced: { ...baseRequest.advanced, playlistItems: String(position) },
    };
    records.push({
      id: taskId,
      url: playlist.webpage_url,
      kind,
      state: 'Idle',
      createdAt,
      updatedAt: createdAt,
      mediaInfo: null,
      request,
      artifacts: [],
      lastPercent: null,
      error: null,
      privateMode: input.privateMode === true,
      postprocessed: false,
    });
  }

  return { records, unknownIds, duplicateIds };
}

/**
 * D-69 · production batch planner (append-only; the position-based planner
 * above stays as the frozen M4-4 contract and keeps its tests).
 *
 * A flat playlist entry carries its OWN `url`. Downloading that URL with
 * `--no-playlist` removes two failure modes at once:
 *   1. `engine.probe --no-playlist` used to resolve the whole playlist to its
 *      FIRST entry, so C5 compared a non-first artifact against the wrong
 *      duration and reported ARTIFACT_INCOMPLETE;
 *   2. YouTube `RD...` radio mixes are regenerated between requests, so a
 *      1-based `--playlist-items <n>` position can point at a different video
 *      by the time the download starts.
 *
 * If an extractor provides no entry URL, the old position-based behaviour is
 * kept as a fallback (never a silent drop).
 */
export function buildPlaylistBatchRecordsByUrl(input: PlaylistBatchInput): PlaylistBatchPlan {
  const { playlist, selectedIds, baseRequest, kind, createdAt } = input;
  const byId = new Map<string, { entry: PlaylistEntry; position: number }>();
  playlist.entries.forEach((entry, index) => {
    if (!byId.has(entry.id)) byId.set(entry.id, { entry, position: index + 1 });
  });

  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  const unknownIds: string[] = [];
  const records: TaskRecord[] = [];

  for (const rawId of selectedIds) {
    const entryId = String(rawId);
    if (seen.has(entryId)) {
      duplicateIds.push(entryId);
      continue;
    }
    seen.add(entryId);
    const found = byId.get(entryId);
    if (found === undefined) {
      unknownIds.push(entryId);
      continue;
    }
    const makeId = input.makeTaskId ?? defaultBatchTaskId;
    const taskId = makeId(playlist.id, entryId, found.position);
    const entryUrl = typeof found.entry.url === 'string' ? found.entry.url.trim() : '';
    const hasEntryUrl = entryUrl !== '';
    const url = hasEntryUrl ? entryUrl : playlist.webpage_url;
    const request: DownloadRequest = {
      ...baseRequest,
      taskId,
      url,
      advanced: {
        ...baseRequest.advanced,
        playlistItems: hasEntryUrl ? null : String(found.position),
      },
    };
    records.push({
      id: taskId,
      url,
      kind,
      state: 'Idle',
      createdAt,
      updatedAt: createdAt,
      mediaInfo: null,
      request,
      artifacts: [],
      lastPercent: null,
      error: null,
      privateMode: input.privateMode === true,
      postprocessed: false,
    });
  }

  return { records, unknownIds, duplicateIds };
}
