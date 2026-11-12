/**
 * Whitelisted IPC channel names — M1 freezes the constants only.
 * The IpcGateway that registers handlers is an M3/M4 stub.
 */
export const IPC_CHANNELS = {
  PROBE: 'ytvdlt:probe',
  PROBE_PLAYLIST: 'ytvdlt:probePlaylist',
  DOWNLOAD_START: 'ytvdlt:download:start',
  DOWNLOAD_CANCEL: 'ytvdlt:download:cancel',
  ENGINE_EVENT: 'ytvdlt:engine:event',
  RUNTIME_STATUS: 'ytvdlt:runtime:status',
  CONFIG_GET: 'ytvdlt:config:get',
  CONFIG_SET: 'ytvdlt:config:set',
  ERROR_REPORT: 'ytvdlt:error:report',
  // M2 additions (constants only; the gateway itself is M3/M4).
  DOWNLOAD_EVENT: 'ytvdlt:download:event',
  TASK_STATE: 'ytvdlt:task:state',
  HISTORY_QUERY: 'ytvdlt:history:query',
  ARTIFACT_VERIFY: 'ytvdlt:artifact:verify',
  // M3 additions (append-only): three dialogs + path preview.
  DIALOG_OPEN: 'ytvdlt:dialog:open',
  DIALOG_CONFIRM: 'ytvdlt:dialog:confirm',
  PATH_PREVIEW: 'ytvdlt:path:preview',
  // M4-4 additions (append-only): explicit batch enqueue, SEPARATE from the
  // playlist dialog confirmation (which still only persists selected ids).
  PLAYLIST_ENQUEUE: 'ytvdlt:playlist:enqueue',
  // M5-0 additions (append-only): the renderer's real data surface. The M3/M4
  // fixture channels above stay untouched so their contracts keep passing.
  TASK_LIST: 'ytvdlt:task:list',
  TASK_DETAIL: 'ytvdlt:task:detail',
  TASK_ACTION: 'ytvdlt:task:action',
  TEMPLATE_LIST: 'ytvdlt:template:list',
  TEMPLATE_SAVE: 'ytvdlt:template:save',
  TEMPLATE_DELETE: 'ytvdlt:template:delete',
  SETTINGS_GET: 'ytvdlt:settings:get',
  SETTINGS_SET: 'ytvdlt:settings:set',
  // M5-5 follow-up (D-67): bundled component (yt-dlp / aria2c) updates.
  COMPONENT_STATUS: 'ytvdlt:component:status',
  COMPONENT_UPDATE: 'ytvdlt:component:update',
  // 0.2.1 (append-only, D-93 / D-94): app update over GitHub Releases, and a
  // network version lookup for the bundled components (separate on purpose:
  // a stale yt-dlp must be fixable without touching the app itself).
  APP_UPDATE_STATUS: 'ytvdlt:appUpdate:status',
  APP_UPDATE_ACTION: 'ytvdlt:appUpdate:action',
  COMPONENT_CHECK: 'ytvdlt:component:check',
  // 0.2.1 (append-only, D-98): pick / reset / open a download directory.
  PATH_ACTION: 'ytvdlt:path:action',
  // D-103 (append-only): cover-cache occupancy / auto-clean switch / prune.
  THUMBNAIL_CACHE: 'ytvdlt:thumbnail:cache',
  // D-106 (append-only): ONE window-level fullscreen authority. The renderer
  // asks, the BrowserWindow owns the state; never use the HTML Fullscreen API
  // and setFullScreen() side by side again.
  WINDOW_FULLSCREEN: 'ytvdlt:window:fullscreen',
  // D-114 (append-only): the one reliable answer to "which version is this?".
  // The `?v=` query parameter is a first-paint optimisation, NOT the source of
  // truth: every renderer-side navigation that forgets to copy it used to fall
  // back to a hard-coded literal. This channel reads `app.getVersion()` inside
  // the main process, so it cannot rot and cannot be spoofed by the page.
  APP_INFO: 'ytvdlt:app:info',
  // Subtitle preview (stage 2, append-only): the live, on-demand probe that
  // replaces the recorded-fixture PROBE for the subtitle picker. Two channels
  // on purpose — "open the picker" returns an opaque ticket, "abandon it"
  // releases that ticket; folding both into one `action` string would blur a
  // success path and a cleanup path.
  // NOTE: `PROBE` / `DIALOG_*` above stay fixture channels and keep their
  // contracts; nothing here changes them.
  SUBTITLE_PREVIEW: 'ytvdlt:subtitle:preview',
  SUBTITLE_PREVIEW_CANCEL: 'ytvdlt:subtitle:previewCancel',
  // TXT batch import (append-only). Two channels on purpose: PICK takes NO
  // payload (the renderer may never name a local path), ENQUEUE takes ONLY the
  // opaque import id + the existing download enums (never a URL list).
  TXT_IMPORT_PICK: 'ytvdlt:txtImport:pick',
  TXT_IMPORT_ENQUEUE: 'ytvdlt:txtImport:enqueue',
  // Playlist batch import (append-only). The M3 `PLAYLIST_ENQUEUE` above stays
  // untouched for its frozen L1 contract; these three carry the live probe,
  // its ticket release and the ticket-bound batch confirmation.
  PLAYLIST_PREVIEW: 'ytvdlt:playlist:preview',
  PLAYLIST_PREVIEW_CANCEL: 'ytvdlt:playlist:previewCancel',
  PLAYLIST_BATCH_ENQUEUE: 'ytvdlt:playlist:batchEnqueue',
  // D-134 (append-only): supported-site discovery and per-URL support
  // pre-check. Both READ the running engine; neither can start a download and
  // neither accepts a path, an argv token or a format selection.
  //   SUPPORTED_SITES    -> the running engine's extractor list (display only)
  //   URL_SUPPORT_CHECK  -> the six-state advisory verdict for ONE url
  // Why two channels: the catalog is a page-level read that may be cached for
  // minutes, while the pre-check is a per-submission action with a 20s budget.
  // Folding them into one `action` string would hide a long network call inside
  // a "list" channel.
  SUPPORTED_SITES: 'ytvdlt:sites:list',
  URL_SUPPORT_CHECK: 'ytvdlt:sites:check',
  // D-148 (append-only): the "Star on GitHub" nudge. Two channels on purpose:
  //   CHECK  takes NO payload (same zero-input rule as APP_INFO) — the renderer
  //          can only ask "may the prompt show now?", the frequency decision
  //          and the state live in the main process;
  //   ACTION takes ONLY the action enum. The renderer never names a URL: the
  //          repository page is resolved and opened inside the main process
  //          (D-98 spirit — the page is not trusted with link construction).
  STAR_PROMPT_CHECK: 'ytvdlt:starPrompt:check',
  STAR_PROMPT_ACTION: 'ytvdlt:starPrompt:action',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
