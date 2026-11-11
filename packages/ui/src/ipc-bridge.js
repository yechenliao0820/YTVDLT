/**
 * ipc-bridge.js — the ONLY way a dialog talks to the main process.
 *
 * Zero imports by design: no `electron`, no `node:fs`, no child_process.
 * The preload script exposes a narrow `window.ytvdltBridge` whitelist.
 * When the bridge is absent (static file:// preview / headless screenshot),
 * calls degrade to a structured "unavailable" result instead of throwing.
 */
(function (global) {
  'use strict';
  var YTVDLT = global.YTVDLT || (global.YTVDLT = {});

  var ALLOWED_COMMANDS = [
    'PROBE', 'PROBE_PLAYLIST',
    'DIALOG_OPEN', 'DIALOG_CONFIRM', 'PATH_PREVIEW',
    'CONFIG_GET', 'CONFIG_SET',
    // D-76: the real task surface. Until this change the queue and detail pages
    // only wrote `{action, taskId}` into a <pre> and never called the main
    // process, so every button was inert in the packaged app.
    'TASK_LIST', 'TASK_DETAIL', 'TASK_ACTION', 'DOWNLOAD_START',
    // Stage 5 (append-only): live, on-demand subtitle preview. The queue page
    // has its own CHANNELS table, but the symbolic names must also be known
    // here so no caller can be rejected by the command whitelist (§5).
    'SUBTITLE_PREVIEW', 'SUBTITLE_PREVIEW_CANCEL',
    // D-129 / D-130 (append-only): the two batch-import surfaces. Their UI
    // components call `queue.js::call()` directly today, but §5 requires all
    // THREE cable tables to agree. Registering them here prevents a future
    // dialog / renderer caller from being silently rejected with
    // `command-not-allowed` (the classic "button does nothing" failure).
    'TXT_IMPORT_PICK', 'TXT_IMPORT_ENQUEUE',
    'PLAYLIST_PREVIEW', 'PLAYLIST_PREVIEW_CANCEL', 'PLAYLIST_BATCH_ENQUEUE',
    // D-134 (append-only): supported-site discovery + per-URL pre-check. §5
    // requires all THREE cable tables to agree; the panel lives on the queue
    // page today, but registering the names here keeps a future dialog or
    // renderer caller from being rejected with `command-not-allowed`.
    'SUPPORTED_SITES', 'URL_SUPPORT_CHECK'
  ];

  function bridge() {
    return global.ytvdltBridge && typeof global.ytvdltBridge === 'object'
      ? global.ytvdltBridge : null;
  }

  function isAvailable() {
    var b = bridge();
    return b !== null && typeof b.invoke === 'function';
  }

  /**
   * D-77: names -> wire strings. The preload whitelists the VALUES of
   * `IPC_CHANNELS` (`ytvdlt:task:list`), while every page calls the symbolic
   * name (`TASK_LIST`). Passing the name straight through made the preload
   * reject every call in the packaged app — that is why the paste box, the
   * queue buttons and even the format dialog's PROBE were inert.
   */
  var CHANNEL_STRINGS = {
    PROBE: 'ytvdlt:probe',
    PROBE_PLAYLIST: 'ytvdlt:probePlaylist',
    DIALOG_OPEN: 'ytvdlt:dialog:open',
    DIALOG_CONFIRM: 'ytvdlt:dialog:confirm',
    PATH_PREVIEW: 'ytvdlt:path:preview',
    CONFIG_GET: 'ytvdlt:config:get',
    CONFIG_SET: 'ytvdlt:config:set',
    TASK_LIST: 'ytvdlt:task:list',
    TASK_DETAIL: 'ytvdlt:task:detail',
    TASK_ACTION: 'ytvdlt:task:action',
    DOWNLOAD_START: 'ytvdlt:download:start',
    // Stage 5: exact wire strings from shared/src/ipc.ts (append-only).
    SUBTITLE_PREVIEW: 'ytvdlt:subtitle:preview',
    SUBTITLE_PREVIEW_CANCEL: 'ytvdlt:subtitle:previewCancel',
    // D-129 / D-130: exact wire strings from shared/src/ipc.ts (append-only).
    TXT_IMPORT_PICK: 'ytvdlt:txtImport:pick',
    TXT_IMPORT_ENQUEUE: 'ytvdlt:txtImport:enqueue',
    PLAYLIST_PREVIEW: 'ytvdlt:playlist:preview',
    PLAYLIST_PREVIEW_CANCEL: 'ytvdlt:playlist:previewCancel',
    PLAYLIST_BATCH_ENQUEUE: 'ytvdlt:playlist:batchEnqueue',
    // D-134: exact wire strings from shared/src/ipc.ts (append-only).
    SUPPORTED_SITES: 'ytvdlt:sites:list',
    URL_SUPPORT_CHECK: 'ytvdlt:sites:check'
  };

  /** Whitelisted, synchronous-safe command dispatch. Never builds a command. */
  function invoke(command, payload) {
    if (ALLOWED_COMMANDS.indexOf(command) === -1) {
      return { ok: false, reason: 'command-not-allowed', command: command };
    }
    var b = bridge();
    if (b === null || typeof b.invoke !== 'function') {
      return { ok: false, reason: 'bridge-unavailable', command: command };
    }
    var wire = CHANNEL_STRINGS[command] || command;
    try {
      return b.invoke(wire, payload || {});
    } catch (error) {
      return { ok: false, reason: 'bridge-error', command: command, message: String(error) };
    }
  }

  function requestProbe(url) { return invoke('PROBE', { url: url }); }
  function requestProbePlaylist(url) { return invoke('PROBE_PLAYLIST', { url: url }); }
  function openDialog(kind) { return invoke('DIALOG_OPEN', { kind: kind }); }
  function confirmDialog(result) { return invoke('DIALOG_CONFIRM', result); }
  function previewPath(patch) { return invoke('PATH_PREVIEW', patch); }

  // ---- D-76: real task operations (queue / detail pages) ----
  function listTasks(payload) { return invoke('TASK_LIST', payload || {}); }
  function taskDetail(taskId) { return invoke('TASK_DETAIL', { taskId: taskId }); }
  function taskAction(taskId, action) { return invoke('TASK_ACTION', { taskId: taskId, action: action }); }
  /** D-83: `options` may carry kind / quality / audioQuality / audioFormat. */
  function startDownload(url, options) {
    var request = { url: url, kind: 'video' };
    var extra = options && typeof options === 'object' ? options : {};
    if (extra.kind === 'audio') request.kind = 'audio';
    if (typeof extra.quality === 'string') request.quality = extra.quality;
    if (typeof extra.audioQuality === 'string') request.audioQuality = extra.audioQuality;
    if (typeof extra.audioFormat === 'string') request.audioFormat = extra.audioFormat;
    return invoke('DOWNLOAD_START', request);
  }

  YTVDLT.bridge = {
    ALLOWED_COMMANDS: ALLOWED_COMMANDS,
    isAvailable: isAvailable,
    invoke: invoke,
    requestProbe: requestProbe,
    requestProbePlaylist: requestProbePlaylist,
    openDialog: openDialog,
    confirmDialog: confirmDialog,
    previewPath: previewPath,
    listTasks: listTasks,
    taskDetail: taskDetail,
    taskAction: taskAction,
    startDownload: startDownload
  };
})(window);
