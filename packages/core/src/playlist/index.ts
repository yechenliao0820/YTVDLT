/** Playlist batch barrel (M4-4). */
export {
  buildPlaylistBatchRecords, buildPlaylistBatchRecordsByUrl, defaultBatchTaskId,
  type PlaylistBatchInput, type PlaylistBatchPlan,
} from './batch.js';
// Playlist batch import (append-only): main-process ticket store. `batch.ts`
// itself is untouched — the M4-4 pure planner keeps its frozen contract.
export * from './preview-cache.js';
