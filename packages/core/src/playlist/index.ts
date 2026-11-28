/** Playlist batch barrel (M4-4). */
export {
  buildPlaylistBatchRecords, buildPlaylistBatchRecordsByUrl, defaultBatchTaskId,
  type PlaylistBatchInput, type PlaylistBatchPlan,
} from './batch.js';
// Playlist batch import (append-only): main-process ticket store. `batch.ts`
// itself is untouched — the M4-4 pure planner keeps its frozen contract.
export * from './preview-cache.js';
// Playlist-title directory layer (append-only): pure string rules for baking
// `playlist.title` into a record's output template. Single-responsibility
// module per §3.0 (same directory, no backfill into the frozen planners).
export {
  bakePlaylistTitleLayer, playlistTitleTemplateLayer,
  PLAYLIST_TITLE_LAYER_MAX,
} from './title-layer.js';
