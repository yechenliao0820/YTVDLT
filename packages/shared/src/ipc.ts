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
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
