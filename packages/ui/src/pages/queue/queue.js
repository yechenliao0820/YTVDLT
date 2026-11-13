/**
 * queue.js — download queue page (M5-3, A-4.4-16; 0.1.9 UI: D-85…D-88).
 *
 * Deterministic by construction: the sample records below are the only data
 * source when no `window.__YTVDLT_TASKS__` is injected, so the screenshot suite
 * renders the same 6 cards on every machine. Query switches:
 *   ?empty=1      -> zero tasks (empty state)
 *   ?error=1      -> queue read failure (error state + retry)
 *   ?tab=finished -> start on a specific tab
 *   ?lang=en      -> English copy (handled by i18n.js)
 *   ?theme=dark&accent=teal -> dark palette (handled by theme.js)
 *
 * The page never talks to the filesystem or a child process: every action is
 * emitted as `{action, taskId}` and executed by the main process through the
 * M5 IPC surface (`TASK_ACTION`), exactly like the M4 task-detail page.
 * Deleting LOCAL files is still a main-process job — the renderer only passes
 * `withFiles: true` and the host moves the artifacts to the OS recycle bin.
 */
(function (global) {
  'use strict';
  var doc = global.document;

  var SAMPLE = [
    {
      id: 't-run-1', state: 'Running', title: 'Sprite Fright — Blender Open Movie',
      uploader: 'Blender Studio', duration: 624, percent: 42,
      speed: 4_200_000, eta: 96, kind: 'video', artifacts: 0, errorCode: null,
      downloadedBytes: 94_371_840, totalBytes: 224_694_080, thumbPath: null
    },
    {
      id: 't-fetch-2', state: 'FetchingInfo', title: 'Big Buck Bunny — 4K remaster',
      uploader: 'Peach Open Movie', duration: 596, percent: null,
      speed: 0, eta: null, kind: 'video', artifacts: 0, errorCode: null,
      downloadedBytes: null, totalBytes: null, thumbPath: null
    },
    {
      id: 't-ready-3', state: 'ReadyWithInfo', title: 'Sintel — 1080p',
      uploader: 'Durian Open Movie', duration: 888, percent: 0,
      speed: 0, eta: null, kind: 'video', artifacts: 0, errorCode: null,
      downloadedBytes: null, totalBytes: null, thumbPath: null
    },
    {
      id: 't-done-4', state: 'Completed', title: 'Tears of Steel — 720p',
      uploader: 'Mango Open Movie', duration: 734, percent: 100,
      speed: 0, eta: 0, kind: 'video', artifacts: 2, errorCode: null,
      downloadedBytes: 318_767_104, totalBytes: 318_767_104, thumbPath: null
    },
    {
      id: 't-cancel-5', state: 'Canceled', title: 'Cosmos Laundromat — pilot',
      uploader: 'Gooseberry', duration: 731, percent: 37,
      speed: 0, eta: null, kind: 'video', artifacts: 0, errorCode: null,
      downloadedBytes: 61_865_984, totalBytes: 167_205_376, thumbPath: null
    },
    {
      id: 't-error-6', state: 'Error', title: 'Live concert — private stream',
      uploader: 'unknown', duration: null, percent: 12,
      speed: 0, eta: null, kind: 'audio', artifacts: 0, errorCode: 'HTTP_403',
      // D-109: what `toTaskListItem()` would send for an HTTP_403 record.
      failureKind: 'forbidden',
      downloadedBytes: null, totalBytes: null, thumbPath: null
    }
  ];

  var TABS = ['all', 'downloading', 'finished', 'canceled'];
  var CONCURRENCY = { active: 2, limit: 3 };
  var HISTORY_STATES = ['Completed', 'Canceled', 'Error'];

  /**
   * D-83：粘贴区新增「视频 / 音频」与清晰度选择。
   *
   * 取值必须与主进程 `FormatDomain` 的枚举逐字一致：
   *   quality      best | 2160p | 1440p | 1080p | 720p | 480p | 360p | lowest
   *   audioQuality best | 192 | 128 | 64 | 32 | lowest
   *   audioFormat  auto（原始/不转码） | mp3 | m4a
   * 主进程 `m5-channels.ts` 会再校验一次，这里错了会被直接拒收，不会带进 argv。
   */
  var QUALITY_OPTIONS = {
    video: [
      { value: 'best', key: 'queue.quality.video.best' },
      { value: '2160p', label: '2160p · 4K' },
      { value: '1440p', label: '1440p · 2K' },
      { value: '1080p', label: '1080p · 全高清' },
      { value: '720p', label: '720p · 高清' },
      { value: '480p', label: '480p' },
      { value: '360p', label: '360p' },
      { value: 'lowest', key: 'queue.quality.video.lowest' }
    ],
    audio: [
      { value: 'best', key: 'queue.quality.audio.best' },
      { value: '192', label: '192 kbps' },
      { value: '128', label: '128 kbps' },
      { value: '64', label: '64 kbps' },
      { value: '32', label: '32 kbps' },
      { value: 'lowest', key: 'queue.quality.audio.lowest' }
    ]
  };

  var choice = { kind: 'video', videoQuality: 'best', audioQuality: 'best', audioFormat: 'auto' };
  var model = { tab: 'all', query: '', sort: 'newest', selected: {} };

  /**
   * Stage 5: the subtitle picker is a component in its own right, but it is
   * mounted ONLY in live mode (a preload bridge exists) or when the layout
   * switch `?subtitle=1` is given. That is the D-120 rule: static file://
   * preview and the frozen screenshot baselines must stay byte-identical.
   * A page load therefore adds ZERO nodes and ZERO probes by default.
   */
  var subtitlePicker = null;
  var subtitleLoading = false;

  function t(key, params) {
    return global.YTVDLT && global.YTVDLT.shell ? global.YTVDLT.shell.t(key, params) : key;
  }
  function shell() { return global.YTVDLT && global.YTVDLT.shell ? global.YTVDLT.shell : null; }

  function param(name, fallback) {
    var match = new RegExp('[?&]' + name + '=([^&]*)').exec(global.location ? global.location.search : '');
    return match === null ? fallback : decodeURIComponent(match[1]);
  }

  /** D-85: the persisted locale is written by SETTINGS_SET; the query wins. */
  function locale() {
    var fromQuery = param('lang', '');
    if (fromQuery !== '') return String(fromQuery).toLowerCase().indexOf('en') === 0 ? 'en' : 'zh-CN';
    try {
      var saved = global.localStorage && global.localStorage.getItem('ytvdlt.locale');
      if (saved === 'en') return 'en';
    } catch (error) { /* file:// preview: storage may be unavailable */ }
    return 'zh-CN';
  }

  function store(key, value) {
    try { if (global.localStorage) global.localStorage.setItem(key, value); } catch (error) { /* offline */ }
  }
  function readStore(key) {
    try { return global.localStorage ? global.localStorage.getItem(key) : null; } catch (error) { return null; }
  }

  /**
   * TXT batch import entry. Loaded ONLY when a preload bridge exists (or via
   * `?txtimport=1` for layout checks), exactly like the subtitle picker: the
   * frozen static screenshot baselines must not gain a single DOM node.
   */
  var txtImport = null;
  var txtImportLoading = false;
  /** Live playlist selector — also loaded only in live mode (frozen baselines). */
  var playlistImport = null;
  var playlistImportLoading = false;
  /** D-134: the supported-sites panel; same live-only reason as above. */
  var supportedSites = null;
  var supportedSitesLoading = false;

  /** D-106: one queue view survives menu / nav-bar page switches. */
  var viewReady = false;

  function saveView() {
    if (!viewReady) return;
    var nav = global.YTVDLTNav;
    if (!nav || typeof nav.saveView !== 'function') return;
    var body = doc.getElementById('queue-body');
    nav.saveView({
      tab: model.tab,
      query: model.query,
      sort: model.sort,
      kind: choice.kind,
      selected: Object.keys(model.selected || {}),
      scroll: body === null ? 0 : body.scrollTop
    });
  }

  function restoreView() {
    var nav = global.YTVDLTNav;
    var saved = nav && typeof nav.restoreView === 'function' ? nav.restoreView() : null;
    if (saved === null || typeof saved !== 'object') return;
    // An explicit ?tab= / ?kind= (e2e, deep link) must always win.
    var hasQuery = param('tab', '') !== '' || param('kind', '') !== '';
    if (!hasQuery) {
      if (TABS.indexOf(saved.tab) !== -1) model.tab = saved.tab;
      if (typeof saved.query === 'string') model.query = saved.query;
      var searchBox = doc.getElementById('queue-search');
      if (searchBox !== null) searchBox.value = model.query;
      if (['newest', 'oldest', 'name', 'state'].indexOf(saved.sort) !== -1) model.sort = saved.sort;
      var sortBox = doc.getElementById('queue-sort');
      if (sortBox !== null) sortBox.value = model.sort;
      if (param('kind', '') === '' && (saved.kind === 'audio' || saved.kind === 'video')) setKind(saved.kind);
    }
    if (Array.isArray(saved.selected)) {
      model.selected = {};
      saved.selected.forEach(function (id) { model.selected[id] = true; });
    }
    if (typeof saved.scroll === 'number' && saved.scroll >= 0) {
      var body = doc.getElementById('queue-body');
      global.setTimeout(function () { if (body !== null) body.scrollTop = saved.scroll; }, 0);
    }
  }

  /**
   * D-76: live mode. Until this change every button on this page only wrote
   * `{action, taskId}` into `#ytvdlt-output` — no IPC call existed, so in the
   * packaged app nothing was clickable. With a preload bridge present the page
   * now reads the real queue (`TASK_LIST`) and performs real actions
   * (`TASK_ACTION` / `DOWNLOAD_START`). Without a bridge (file:// preview and
   * the screenshot suite) the deterministic SAMPLE path stays byte-identical.
   */
  var live = { active: false, tasks: null, error: false };

  function tasks() {
    if (param('empty', '0') === '1') return [];
    // D-141: live mode NEVER borrows the screenshot fixture. Boot used to run a
    // synchronous render before the first `TASK_LIST` reply, so `live.tasks`
    // was still null and the six sample rows below were painted into the real
    // window — every launch, and again on every language switch (which is a
    // full page reload). "Unknown" is not "these six fake downloads".
    if (live.active) return Array.isArray(live.tasks) ? live.tasks : [];
    var injected = global.__YTVDLT_TASKS__;
    return Array.isArray(injected) && injected.length > 0 ? injected : SAMPLE;
  }

  function taskBridge() {
    var candidate = global.ytvdltBridge;
    return candidate && typeof candidate.invoke === 'function' ? candidate : null;
  }

  function isLive() {
    return taskBridge() !== null;
  }

  /** Channel names -> wire strings (D-77: the preload whitelists the strings). */
  var CHANNELS = {
    TASK_LIST: 'ytvdlt:task:list',
    TASK_DETAIL: 'ytvdlt:task:detail',
    TASK_ACTION: 'ytvdlt:task:action',
    DOWNLOAD_START: 'ytvdlt:download:start',
    SETTINGS_GET: 'ytvdlt:settings:get',
    SETTINGS_SET: 'ytvdlt:settings:set',
    // Stage 5 (append-only): the live, on-demand subtitle preview. The two
    // strings are the exact values in shared/src/ipc.ts; the preload whitelist
    // is generated from that same table, so no bridge change is needed.
    SUBTITLE_PREVIEW: 'ytvdlt:subtitle:preview',
    SUBTITLE_PREVIEW_CANCEL: 'ytvdlt:subtitle:previewCancel',
    // TXT batch import (append-only): exact wire strings from shared/src/ipc.ts.
    TXT_IMPORT_PICK: 'ytvdlt:txtImport:pick',
    TXT_IMPORT_ENQUEUE: 'ytvdlt:txtImport:enqueue',
    // Playlist batch import (append-only): exact wire strings from shared/src/ipc.ts.
    PLAYLIST_PREVIEW: 'ytvdlt:playlist:preview',
    PLAYLIST_PREVIEW_CANCEL: 'ytvdlt:playlist:previewCancel',
    PLAYLIST_BATCH_ENQUEUE: 'ytvdlt:playlist:batchEnqueue',
    // D-134 (append-only): supported sites + the per-URL pre-check. Both read
    // the running engine; neither can start a download.
    SUPPORTED_SITES: 'ytvdlt:sites:list',
    URL_SUPPORT_CHECK: 'ytvdlt:sites:check',
    // T5 (append-only): user-level pre-check cancellation + batch progress.
    // CANCEL takes no payload (it stops the CURRENT in-flight pre-check);
    // STATUS is a read-only poll consumed by the two batch dialogs.
    URL_SUPPORT_CHECK_CANCEL: 'ytvdlt:sites:checkCancel',
    URL_SUPPORT_CHECK_STATUS: 'ytvdlt:sites:checkStatus',
    // D-148 (append-only): the "Star on GitHub" nudge. CHECK takes no payload
    // and ACTION only the button enum; the repo URL never crosses IPC.
    STAR_PROMPT_CHECK: 'ytvdlt:starPrompt:check',
    STAR_PROMPT_ACTION: 'ytvdlt:starPrompt:action'
  };

  /** Thin wrapper over the preload surface: `{ok:false, code, message}` on failure
   *  instead of a rejected promise, so every caller has one shape to handle. */
  function call(channel, payload) {
    var bridge = taskBridge();
    if (bridge === null) return Promise.resolve({ ok: false, code: 'BRIDGE_UNAVAILABLE', message: t('queue.notify.bridge') });
    try {
      return Promise.resolve(bridge.invoke(CHANNELS[channel] || channel, payload || {})).catch(function (error) {
        return { ok: false, code: 'IPC_ERROR', message: String(error && error.message ? error.message : error) };
      });
    } catch (error) {
      return Promise.resolve({ ok: false, code: 'IPC_ERROR', message: t('queue.notify.ipc') });
    }
  }

  /** Visible status line. The hidden `<pre>` stays a debug surface for live mode. */
  function notify(text) {
    var output = doc.getElementById('ytvdlt-output');
    if (output !== null && live.active) {
      setHidden(output, false);
      output.textContent = String(text);
      output.setAttribute('data-last-action', 'live');
    }
    var status = doc.getElementById('queue-status');
    if (status !== null) {
      status.textContent = String(text);
      setHidden(status, false);
    }
  }

  function toTask(item) {
    return {
      id: item.id,
      state: item.state,
      // D-164: "waiting for a slot" is not a state; the DTO says it explicitly.
      pending: item.pending === true,
      kind: item.kind || 'video',
      title: item.title || item.id,
      uploader: item.uploader || '—',
      duration: typeof item.duration === 'number' ? item.duration : null,
      // D-107: `null` means "no usable percent yet" and MUST survive the
      // projection. Coercing it to 0 painted a fake 0.0% on a task whose first
      // progress line had not arrived; a real 0 is a legal observation and is
      // kept as 0 (see `progressMode()`), so this is a type check, never `|| 0`.
      percent: typeof item.percent === 'number' && isFinite(item.percent) ? item.percent : null,
      // 0.2.1 (D-95): these four are what makes the card useful while it runs.
      speed: typeof item.speedBps === 'number' ? item.speedBps : 0,
      eta: typeof item.etaSec === 'number' ? item.etaSec : null,
      downloadedBytes: typeof item.downloadedBytes === 'number' ? item.downloadedBytes : null,
      totalBytes: typeof item.totalBytes === 'number' ? item.totalBytes : null,
      // 0.2.1 (D-96): a local, already-cached cover path — never a remote URL.
      thumbPath: typeof item.thumbPath === 'string' && item.thumbPath !== '' ? item.thumbPath : null,
      // D-115: the real phase of a running task. `null` = no reliable info;
      // the card then behaves exactly as before (no invented "merging").
      stage: isStage(item.stage) ? item.stage : null,
      artifacts: typeof item.artifactCount === 'number' ? item.artifactCount : 0,
      errorCode: item.errorCode || null,
      // D-109: the main process sends a STABLE bucket, never a sentence. `null`
      // when the record carries no error; the copy is resolved at paint time so
      // a language switch repaints in the new language without a new request.
      failureKind: isFailureKind(item.failureKind) ? item.failureKind : null,
      // D-120: the main process' observation of the recorded artifact path.
      // `null` = no probe (old build / running task / static preview) → paint
      // nothing. It NEVER changes `state`: the download succeeded in the past.
      fileStatus: isFileStatus(item.fileStatus) ? item.fileStatus : null,
      subtitleOutcome: item.subtitleOutcome === 'missing' || item.subtitleOutcome === 'partial' ? item.subtitleOutcome : null,
      dirStatus: isFileStatus(item.dirStatus) ? item.dirStatus : null
    };
  }

  /** D-109: mirror of core's `FailureKind` — guards the i18n key lookup so an
   *  unknown bucket can never print a raw `queue.failure.x` key on a card. */
  var FAILURE_KINDS = ['network', 'service', 'forbidden', 'save', 'unknown'];

  /**
   * D-115: mirror of shared `EngineStage`. An unknown value is treated as "no
   * information" — never as a phase, so a future backend value cannot make the
   * card claim something it does not know.
   */
  var STAGES = ['fetching', 'downloading', 'merging', 'postprocess', 'verifying'];

  function isStage(value) {
    return typeof value === 'string' && STAGES.indexOf(value) !== -1;
  }

  function isFailureKind(value) {
    return typeof value === 'string' && FAILURE_KINDS.indexOf(value) !== -1;
  }

  /** D-120: mirror of main's `LocalFileStatus`. Unknown values paint nothing. */
  var FILE_STATUSES = ['present', 'missing', 'inaccessible', 'unavailable', 'invalid'];

  function isFileStatus(value) {
    return typeof value === 'string' && FILE_STATUSES.indexOf(value) !== -1;
  }

  /**
   * D-120: a lightweight, non-destructive hint on the CARD (not the checkbox,
   * not the whole page). Only `Completed` tasks are probed by main, and only a
   * genuinely bad observation produces copy — "present" keeps the original
   * finished look exactly as before.
   */
  function fileStateKey(task) {
    if (task.state !== 'Completed') return null;
    if (!isFileStatus(task.fileStatus) || task.fileStatus === 'present') return null;
    return 'queue.file.' + task.fileStatus;
  }

  /**
   * D-109: which i18n key a card shows, or `null` when it must show none.
   *
   * Only `Error` counts as a failure. A canceled task, a queued one, one that is
   * being retried (state flips back to ReadyWithInfo/Idle and `error` is
   * cleared) or one still running must never look like "download failed".
   * When the backend recorded a failure but no usable code, the honest brief is
   * the generic one — never a guessed cause.
   */
  function failureKeyOf(task) {
    if (task.state !== 'Error') return null;
    var kind = isFailureKind(task.failureKind) ? task.failureKind : 'unknown';
    return 'queue.failure.' + kind;
  }

  /** 0.2.1 (D-96): a full re-render replaces every `<img>`; polling every 1.2 s
   *  would make the covers flicker. The queue is only repainted when something
   *  the user can see actually changed.
   *  D-112: the key is now split in two — `paintKey` covers everything that
   *  changes the DOM *shape* (a full re-render), `progressKey` covers only the
   *  numbers inside an existing card (patched in place, see `patchProgress`).
   *  Without the split, a 400 ms poll would rebuild every cover 2.5×/s. */
  var lastPaint = '';
  var lastProgress = '';

  function paintKey(list) {
    var rows = list.map(function (task) {
      return [
        task.id, task.state, task.thumbPath, task.errorCode,
        task.failureKind, progressMode(task.state, hasPercent(task), task.stage),
        // D-120: a state change repaints ONE card once, not on every poll.
        task.fileStatus, task.subtitleOutcome
      ].join(',');
    }).join('~');
    return [model.tab, model.query, model.sort, list.length, rows].join('#');
  }

  function progressKey(list) {
    return list.map(function (task) {
      return [
        task.id, task.percent, task.downloadedBytes, task.totalBytes, task.speed, task.eta,
        // D-115: merging → finalizing keeps the same mode but changes the copy,
        // so the stage has to take part in the in-place patch key too.
        task.stage
      ].join(',');
    }).join('~');
  }

  /** First descendant carrying `className` (depth-first, DOM or test fake). */
  function findByClass(node, className) {
    var kids = (node && node.children) || [];
    for (var i = 0; i < kids.length; i += 1) {
      var kid = kids[i];
      var cls = ' ' + String(kid.className || '') + ' ';
      if (cls.indexOf(' ' + className + ' ') !== -1) return kid;
      var deeper = findByClass(kid, className);
      if (deeper !== null) return deeper;
    }
    return null;
  }

  /** The rendered card for `taskId`, or null when it is filtered out. */
  function cardOf(host, taskId) {
    var kids = (host && host.children) || [];
    for (var i = 0; i < kids.length; i += 1) {
      var node = kids[i];
      if (typeof node.getAttribute === 'function' && node.getAttribute('data-task-id') === String(taskId)) {
        return node;
      }
    }
    return null;
  }

  /**
   * D-112: refresh the numbers of already-rendered cards without touching their
   * DOM structure. Only called when `paintKey` is unchanged, i.e. no card was
   * added / removed / restated / switched between progress modes.
   */
  function patchProgress(list) {
    var host = doc.getElementById('queue-cards');
    if (host === null) return;
    var visible = sortTasks(filterTasks(list, model.tab, model.query));
    visible.forEach(function (task) {
      var node = cardOf(host, task.id);
      if (node === null) return;
      var mode = progressMode(task.state, hasPercent(task), task.stage);
      // D-115: `working` has no numbers to patch, but merging → finalizing
      // changes the copy, so it is patched here instead of forcing a re-render.
      if (mode === 'working') {
        var stageLine = findByClass(node, 'card-progress');
        if (stageLine !== null) {
          stageLine.textContent = stageText(task.stage);
          stageLine.setAttribute('data-progress', 'working');
        }
        return;
      }
      if (mode !== 'value' && mode !== 'unknown') return;
      var line = findByClass(node, 'card-progress');
      if (line !== null) {
        line.textContent = mode === 'value' ? progressText(task) : unknownProgressText(task);
        line.setAttribute('data-progress', mode === 'value' ? String(task.percent) : mode);
      }
      if (mode === 'value') {
        var bar = findByClass(node, 'bar');
        var fill = bar !== null && bar.children.length > 0 ? bar.children[0] : null;
        if (fill !== null) fill.style.width = Math.max(0, Math.min(100, task.percent)) + '%';
      }
    });
    lastProgress = progressKey(list);
  }

  /** D-112: is anything still in flight? Drives the poll cadence. */
  function hasActiveTask() {
    if (!live.active || !Array.isArray(live.tasks)) return false;
    return live.tasks.some(function (task) {
      return task.state !== 'Completed' && task.state !== 'Canceled' && task.state !== 'Error';
    });
  }

  /** D-120: first load and every re-entry ask main for one fresh stat. Normal
   *  polls reuse its short-TTL cache, so no filesystem work per repaint. */
  var statusRefreshDue = true;

  function refresh(forceStatus) {
    if (!live.active) { render(); return Promise.resolve(); }
    var listPayload = { tab: 'all' };
    if (forceStatus === true || statusRefreshDue) {
      listPayload.refreshFileStatus = true;
      statusRefreshDue = false;
    }
    return call('TASK_LIST', listPayload).then(function (result) {
      if (!result || result.ok === false) { live.error = true; render(); return; }
      var wasError = live.error;
      // D-141: the very first reply must always repaint — with an empty queue
      // the data is identical to the pre-reply placeholder, so the paint-key
      // comparison below would otherwise swallow the transition to "empty".
      var firstReply = live.tasks === null;
      live.error = false;
      live.tasks = (Array.isArray(result.items) ? result.items : []).map(toTask);
      // D-148: the FIRST real TASK_LIST reply (never fake data) is what arms
      // the Star-prompt timer. Before this point the queue is unknown, so the
      // "no task in flight" guard could not be honest yet.
      if (firstReply) scheduleStarPrompt(STAR_PROMPT_DELAY_MS);
      // Recovering from an error must always repaint, even if the data matches.
      if (firstReply || wasError || paintKey(live.tasks) !== lastPaint) { render(); return; }
      if (progressKey(live.tasks) === lastProgress) return;
      patchProgress(live.tasks);
    });
  }

  function actionCode(result) {
    if (!result) return t('queue.notify.ipc');
    if (result.ok === true) return null;
    return result.message || result.code || t('queue.notify.ipc');
  }

  /** D-120: stable codes from main -> shipped copy in the ACTIVE language. */
  var OPEN_FILE_CODES = {
    FILE_MISSING: 'queue.open.fileMissing',
    FILE_INACCESSIBLE: 'queue.open.fileInaccessible',
    FILE_UNAVAILABLE: 'queue.open.fileUnavailable',
    NO_ARTIFACT: 'queue.open.fileInvalid'
  };
  var OPEN_FOLDER_CODES = {
    FOLDER_MISSING: 'queue.open.folderMissing',
    FOLDER_INACCESSIBLE: 'queue.open.folderInaccessible',
    FOLDER_UNAVAILABLE: 'queue.open.folderUnavailable',
    NO_ARTIFACT: 'queue.open.fileInvalid'
  };

  /** `null` = fall back to the generic action notice. */
  function openActionMessage(action, result) {
    if (!result) return null;
    if (result.ok === true) {
      // Folder opened successfully although the video itself is gone.
      if (action === 'folder' && (result.fileStatus === 'missing' || result.fileMissing === true)) {
        return t('queue.open.folderOpenedMissing');
      }
      return null;
    }
    var table = action === 'folder' ? OPEN_FOLDER_CODES : OPEN_FILE_CODES;
    var key = table[result.code];
    return key === undefined ? null : t(key);
  }

  /** Real execution in live mode; the JSON contract otherwise. */
  function act(action, task) {
    if (!live.active) { emit(action, task); return; }
    if (action === 'detail') {
      // D-114: carry the version across the hop. Losing it here was the exact
      // path that made the footer claim 0.2.2 — the detail page rebuilt its URL
      // from scratch and the return trip inherited the empty value.
      var suffix = locale() === 'en' ? '&lang=en' : '';
      var registry = global.YTVDLTAppVersion;
      var known = registry && typeof registry.query === 'function' ? registry.query() : '';
      if (known !== '') suffix += '&v=' + known;
      global.location.href = '../task-detail/index.html?taskId=' + encodeURIComponent(task.id) + suffix;
      return;
    }
    var mapped = action === 'retry' ? 'retry'
      : action === 'folder' ? 'open-folder'
      : action === 'file' ? 'open-file'
      : 'cancel';
    call('TASK_ACTION', { taskId: task.id, action: mapped }).then(function (result) {
      var openCopy = openActionMessage(action, result);
      if (openCopy !== null) notify(openCopy);
      else {
        var problem = actionCode(result);
        if (problem !== null) notify(t('queue.notify.actionFailed', { action: mapped, reason: problem }));
        else notify(t('queue.notify.actionDone', { action: mapped }));
      }
      // D-120: main just re-stat'ed this path; repaint the affected card(s).
      refresh(true);
    });
  }

  var enqueueing = false;

  // ---- Stage 5: subtitle picker wiring -----------------------------------
  // The picker lives in its own zero-dependency browser script. It is loaded
  // ONLY when a preload bridge exists (live mode), so file:// static preview
  // and the 31 frozen screenshot baselines are untouched. A page load never
  // probes: the single SUBTITLE_PREVIEW call happens when the user clicks the
  // entry button inside the component.
  function subtitleUrl() {
    var field = doc.getElementById('queue-url');
    return field === null ? '' : String(field.value || '').trim();
  }

  function mountSubtitlePicker(factory) {
    if (subtitlePicker !== null || !factory || typeof factory.create !== 'function') return;
    var anchor = doc.getElementById('queue-paste-form');
    if (anchor === null) return;
    subtitlePicker = factory.create({
      doc: doc,
      t: t,
      call: call,
      notify: notify,
      getUrl: subtitleUrl,
      getKind: function () { return choice.kind; },
      onSelectionChange: function () { /* the chip is owned by the picker */ }
    });
    subtitlePicker.mount(anchor, '../../styles/subtitles.css', doc.getElementById('queue-paste'));
    // A typed/pasted URL invalidates any ticket bound to the previous one.
    var field = doc.getElementById('queue-url');
    if (field !== null) {
      field.addEventListener('input', function () {
        if (subtitlePicker !== null) subtitlePicker.onUrlChanged(subtitleUrl());
      });
    }
  }

  function ensureSubtitlePicker() {
    if (subtitlePicker !== null || subtitleLoading) return;
    // `?subtitle=1` is a layout/no-bridge verification switch only. Every
    // frozen e2e case omits it, so no baseline sees a single extra node.
    var force = param('subtitle', '') === '1';
    if (!live.active && !force) return;
    var existing = global.YTVDLT && global.YTVDLT.subtitles;
    if (existing) { mountSubtitlePicker(existing); return; }
    subtitleLoading = true;
    var tag = doc.createElement('script');
    tag.setAttribute('src', '../../subtitles/subtitle-picker.js');
    tag.addEventListener('load', function () {
      subtitleLoading = false;
      mountSubtitlePicker(global.YTVDLT && global.YTVDLT.subtitles);
    });
    tag.addEventListener('error', function () {
      subtitleLoading = false;
      notify(t('subtitle.error.unavailable'));
    });
    if (doc.head && typeof doc.head.appendChild === 'function') doc.head.appendChild(tag);
    else subtitleLoading = false;
  }

  function mountTxtImport(factory) {
    if (txtImport !== null || !factory || typeof factory.create !== 'function') return;
    var anchor = doc.getElementById('queue-paste-form');
    if (anchor === null) return;
    txtImport = factory.create({
      doc: doc,
      t: t,
      call: call,
      notify: notify,
      // The batch must inherit the SAME type / quality / audio choices a
      // normal single download would use; the main process reads the rest of
      // the settings (paths / subtitles / network) from ConfigStore.
      getChoice: function () {
        return {
          kind: choice.kind,
          videoQuality: choice.videoQuality,
          audioQuality: choice.audioQuality,
          audioFormat: choice.audioFormat
        };
      },
      refresh: refresh
    });
    txtImport.mount(anchor, '../../styles/txt-import.css');
  }

  function ensureTxtImport() {
    if (txtImport !== null || txtImportLoading) return;
    var force = param('txtimport', '') === '1';
    if (!live.active && !force) return;
    var existing = global.YTVDLT && global.YTVDLT.txtImport;
    if (existing) { mountTxtImport(existing); return; }
    txtImportLoading = true;
    var tag = doc.createElement('script');
    tag.setAttribute('src', '../../txt-import/txt-import.js');
    tag.addEventListener('load', function () {
      txtImportLoading = false;
      mountTxtImport(global.YTVDLT && global.YTVDLT.txtImport);
    });
    tag.addEventListener('error', function () { txtImportLoading = false; });
    if (doc.head && typeof doc.head.appendChild === 'function') doc.head.appendChild(tag);
    else txtImportLoading = false;
  }

  function mountPlaylistImport(factory) {
    if (playlistImport !== null || !factory || typeof factory.create !== 'function') return;
    var anchor = doc.getElementById('queue-paste-form');
    if (anchor === null) return;
    playlistImport = factory.create({
      doc: doc,
      t: t,
      call: call,
      notify: notify,
      getChoice: function () {
        return {
          kind: choice.kind,
          videoQuality: choice.videoQuality,
          audioQuality: choice.audioQuality,
          audioFormat: choice.audioFormat
        };
      },
      refresh: refresh,
      // Bypasses auto-detection: a failed probe can fall back to the normal
      // single-download path without re-entering the playlist selector.
      startSingleDownload: function (url) { enqueueSingleDownload(url); },
      readUrl: function () {
        var field = doc.getElementById('queue-url');
        return field === null ? '' : String(field.value || '').trim();
      }
    });
    playlistImport.mount(anchor, '../../styles/playlist-import.css');
  }

  function ensurePlaylistImport() {
    if (playlistImport !== null || playlistImportLoading) return;
    var force = param('playlist', '') === '1';
    if (!live.active && !force) return;
    var existing = global.YTVDLT && global.YTVDLT.playlists;
    if (existing) { mountPlaylistImport(existing); return; }
    playlistImportLoading = true;
    var tag = doc.createElement('script');
    tag.setAttribute('src', '../../playlists/playlist-import.js');
    tag.addEventListener('load', function () {
      playlistImportLoading = false;
      mountPlaylistImport(global.YTVDLT && global.YTVDLT.playlists);
    });
    tag.addEventListener('error', function () { playlistImportLoading = false; });
    if (doc.head && typeof doc.head.appendChild === 'function') doc.head.appendChild(tag);
    else playlistImportLoading = false;
  }

  /** D-134：把「支持的网站」入口挂到粘贴框旁边（仅 live 模式注入）。 */
  function mountSupportedSites(factory) {
    if (supportedSites !== null || !factory || typeof factory.create !== 'function') return;
    var anchor = doc.getElementById('queue-paste-form');
    if (anchor === null) return;
    supportedSites = factory.create({ doc: doc, t: t, call: call, notify: notify });
    supportedSites.mount(anchor, '../../styles/supported-sites.css');
  }

  /**
   * Lazy loader, identical in shape to the txt-import / playlist loaders.
   *
   * Why lazy at all: the panel is only useful in the packaged app (there is no
   * engine in a file:// preview), and loading it unconditionally would add a
   * button and a stylesheet to every frozen screenshot baseline.
   */
  function ensureSupportedSites() {
    if (supportedSites !== null || supportedSitesLoading) return;
    if (!live.active) return;
    var existing = global.YTVDLT && global.YTVDLT.supportedSites;
    if (existing) { mountSupportedSites(existing); return; }
    supportedSitesLoading = true;
    var tag = doc.createElement('script');
    tag.setAttribute('src', '../../sites/supported-sites.js');
    tag.addEventListener('load', function () {
      supportedSitesLoading = false;
      mountSupportedSites(global.YTVDLT && global.YTVDLT.supportedSites);
    });
    tag.addEventListener('error', function () { supportedSitesLoading = false; });
    if (doc.head && typeof doc.head.appendChild === 'function') doc.head.appendChild(tag);
    else supportedSitesLoading = false;
  }

  /** The six flat DOWNLOAD_START keys, or `null` for the untouched old flow. */
  function currentSubtitleSelection() {
    return subtitlePicker === null ? null : subtitlePicker.getSelection();
  }

  // ---- D-148: "Star on GitHub" prompt -------------------------------------
  // Live-only, dynamic-DOM (D-139 pattern): built with createElement, appended
  // to <body>, removed on close — index.html and the frozen screenshot
  // baselines never gain a single node. Frequency is owned by the MAIN process
  // (third launch of a version, max 2 asks per version, 7-day retry gap after
  // "later", permanent silence after "star"/"never"); the renderer adds two
  // guards of its own:
  //   - the timer is armed by the FIRST real TASK_LIST reply (D-141: never on
  //     fake/unknown data) and fires STAR_PROMPT_DELAY_MS later;
  //   - at fire time the queue must have NO Running/FetchingInfo task — a task
  //     in flight is never interrupted; the check waits for an idle moment.
  // Exactly ONE CHECK happens per session, so the dialog can appear at most
  // once per page load; across sessions the main-process config state decides.
  var STAR_PROMPT_DELAY_MS = 45 * 1000;
  var STAR_PROMPT_BUSY_RETRY_MS = 60 * 1000;
  var starPromptTimer = null;
  var starPromptChecked = false;
  var starPromptShown = false;
  var starPromptDialog = null;

  /** True while a download is actually in flight (not queued, not settled). */
  function starPromptBusy() {
    if (!live.active || !Array.isArray(live.tasks)) return true;
    return live.tasks.some(function (task) {
      return task.state === 'Running' || task.state === 'FetchingInfo';
    });
  }

  function scheduleStarPrompt(delay) {
    if (!live.active || starPromptChecked || starPromptShown) return;
    if (starPromptTimer !== null) return;
    starPromptTimer = global.setTimeout(function () {
      starPromptTimer = null;
      maybeCheckStarPrompt();
    }, delay);
  }

  function maybeCheckStarPrompt() {
    if (!live.active || starPromptChecked || starPromptShown) return;
    // Red line (D-148): never even ASK while a task is running. One CHECK per
    // session, so the spend is bounded whether or not the queue is idle.
    if (starPromptBusy()) { scheduleStarPrompt(STAR_PROMPT_BUSY_RETRY_MS); return; }
    starPromptChecked = true;
    call('STAR_PROMPT_CHECK', {}).then(function (result) {
      if (starPromptShown) return;
      if (result && result.show === true) showStarPrompt();
    }).catch(function () { /* call() already normalizes IPC failures */ });
  }

  function starPromptEl(tag, style, text) {
    var node = doc.createElement(tag);
    if (style) node.style.cssText = style;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function closeStarPrompt() {
    if (starPromptDialog === null) return;
    var parent = starPromptDialog.parentNode;
    // `parent` may be `undefined` (test sandbox without real DOM linkage);
    // the dialog is then simply dropped, never thrown over.
    if (parent !== null && parent !== undefined && typeof parent.removeChild === 'function') {
      parent.removeChild(starPromptDialog);
    }
    starPromptDialog = null;
  }

  function answerStarPrompt(action, controls) {
    // The user has spoken: whatever the IPC answer says, the dialog closes.
    if (controls && controls.length > 0) {
      for (var index = 0; index < controls.length; index += 1) controls[index].disabled = true;
    }
    call('STAR_PROMPT_ACTION', { action: action }).then(closeStarPrompt).catch(closeStarPrompt);
  }

  function showStarPrompt() {
    if (starPromptShown || starPromptDialog !== null) return;
    // A page without a real <body> (test sandbox) cannot host the dialog.
    if (!doc.body || typeof doc.body.appendChild !== 'function') return;
    starPromptShown = true;

    var backdrop = starPromptEl('div', [
      'position:fixed', 'inset:0', 'z-index:96', 'display:flex',
      'align-items:center', 'justify-content:center',
      'background:rgba(12,22,34,.52)', 'padding:20px'
    ].join(';'));
    backdrop.id = 'ytvdlt-star-prompt';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');

    var box = starPromptEl('div', [
      'width:min(420px,100%)', 'padding:18px 20px', 'border-radius:14px',
      'background:var(--panel,#fff)', 'color:var(--ink,#1b2430)',
      'border:1px solid var(--line,#d5dde5)',
      'box-shadow:0 24px 70px rgba(10,20,32,.34)', 'font-family:inherit'
    ].join(';'));
    var title = starPromptEl('strong',
      'display:block;font-size:16px;letter-spacing:.02em;margin-bottom:8px;',
      t('starPrompt.title'));
    title.id = 'ytvdlt-star-prompt-title';
    backdrop.setAttribute('aria-labelledby', title.id);
    box.appendChild(title);
    box.appendChild(starPromptEl('p',
      'margin:0 0 14px;font-size:12.5px;line-height:1.7;color:var(--ink,#1b2430);',
      t('starPrompt.body')));

    var actions = starPromptEl('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;');
    var buttonStyle = [
      'height:32px', 'padding:0 13px', 'font-size:12px', 'font-family:inherit',
      'border-radius:6px', 'cursor:pointer', 'white-space:nowrap',
      'border:1px solid var(--line,#d5dde5)', 'background:var(--panel,#fff)', 'color:var(--ink,#1b2430)'
    ].join(';');
    var primaryStyle = buttonStyle
      + ';background:var(--accent,#1d63b8);border-color:var(--accent,#1d63b8);color:#ffffff;font-weight:700';

    var star = starPromptEl('button', primaryStyle, t('starPrompt.star'));
    star.type = 'button';
    var later = starPromptEl('button', buttonStyle, t('starPrompt.later'));
    later.type = 'button';
    var never = starPromptEl('button', buttonStyle, t('starPrompt.never'));
    never.type = 'button';
    var controls = [star, later, never];
    star.addEventListener('click', function () { answerStarPrompt('star', controls); });
    later.addEventListener('click', function () { answerStarPrompt('later', controls); });
    never.addEventListener('click', function () { answerStarPrompt('never', controls); });
    // Clicking the dimmed background counts as "later": every showing must be
    // answered for the main-process per-version budget to stay honest.
    backdrop.addEventListener('click', function (event) {
      if (event && event.target === backdrop) answerStarPrompt('later', controls);
    });
    actions.appendChild(star);
    actions.appendChild(later);
    actions.appendChild(never);
    box.appendChild(actions);
    backdrop.appendChild(box);
    doc.body.appendChild(backdrop);
    starPromptDialog = backdrop;
  }


  /** D-83：把界面上选好的类型/清晰度一起交给主进程。 */
  function downloadPayload(url) {
    var payload = { url: url, kind: choice.kind };
    if (choice.kind === 'audio') {
      payload.audioQuality = choice.audioQuality;
      payload.audioFormat = choice.audioFormat;
    } else {
      payload.quality = choice.videoQuality;
    }
    // Stage 5: only when the user confirmed a still-valid selection. With no
    // selection the payload is byte-for-byte the pre-stage-5 shape, so the old
    // download experience is preserved (and the main process skips the ticket).
    var selection = currentSubtitleSelection();
    if (selection === false) return null;
    if (selection !== null) {
      payload.previewId = selection.previewId;
      payload.subtitleLanguages = selection.subtitleLanguages;
      payload.subtitleAutoCaptions = selection.subtitleAutoCaptions;
      payload.subtitleConvertTo = selection.subtitleConvertTo;
      payload.subtitleEmbed = selection.subtitleEmbed;
      payload.subtitleKeepFile = selection.subtitleKeepFile;
    }
    return payload;
  }

  /**
   * D-137 (F-07): the main process sends a stable CODE, never a sentence to
   * print. An English page used to receive a hard-coded Chinese `reason` and
   * show it verbatim; resolve the refusal in the active locale instead, and
   * keep the raw reason only as a fallback for other failure kinds.
   */
  function enqueueFailureText(result) {
    var code = (result && result.code) ? String(result.code) : '';
    if (code === 'SITE_UNSUPPORTED') return t('queue.precheck.blocked.site');
    if (code === 'ITEM_UNSUPPORTED') return t('queue.precheck.blocked.item');
    // T5: a cancellation is "the user said stop" — nothing was queued.
    if (code === 'PRECHECK_CANCELLED') return t('queue.precheck.cancelled');
    return t('queue.notify.enqueueFailed', {
      reason: (result && (result.reason || result.message)) || t('queue.notify.ipc')
    });
  }

  /**
   * D-137 (F-06): a NON-blocking verdict is now explained in one line appended
   * to the success toast. Only live IPC carries `support`, so the frozen static
   * previews never see this text and the screenshot baselines stay untouched.
   */
  function precheckNote(support) {
    if (!support || support.blocks === true) return '';
    var key = support.state === 'NO_MEDIA' ? 'queue.precheck.noMediaNotice'
      : support.state === 'TIMEOUT' ? 'queue.precheck.timeoutNotice'
        : (support.state === 'INDETERMINATE' || support.state === 'CANCELLED')
          ? 'queue.precheck.indeterminateNotice' : '';
    return key === '' ? '' : t(key);
  }

  /**
   * D-139 (待改清单 #1/#2): the single-URL pre-check now has a visible
   * lifecycle and a real caller.
   *
   * `URL_SUPPORT_CHECK` existed with a handler and payload validation but no
   * production caller, so the six-state verdict only surfaced AFTER
   * `DOWNLOAD_START` had already enqueued the task. This path asks FIRST:
   *
   *   SUPPORTED / unavailable  -> enqueue exactly as before;
   *   UNSUPPORTED              -> refuse in the active locale, never enqueue;
   *   NO_MEDIA / INDETERMINATE / TIMEOUT / CANCELLED
   *                            -> ask the user before creating a task.
   *
   * `DOWNLOAD_START` keeps its own gate; this is advisory and fail-open. The
   * modal is built on the fly, not declared in `index.html`, so the frozen DOM
   * baselines of the static preview cases stay byte-identical.
   */
  var precheckConfirm = null;

  /**
   * T5: the single-URL pre-check is cancellable. The bar is built on the fly
   * (D-139 pattern, never declared in `index.html`) and ONLY in the live
   * pre-check path, so the frozen static baselines never see it. The cancel
   * click fires `URL_SUPPORT_CHECK_CANCEL` with this submission's opaque
   * `operationId` (D-160); the main process aborts ONLY the controllers bound
   * to that id. The outcome comes back through the normal verdict / enqueue
   * reply as `PRECHECK_CANCELLED`, which renders as「已取消，未入队」.
   */
  var precheckCancelBar = null;
  var singlePrecheckCancelled = false;
  /**
   * D-160: one opaque id per user submission. `URL_SUPPORT_CHECK` and the
   * `DOWNLOAD_START` gate re-check share it, so the cancel bar stops exactly
   * this submission and can never abort another live dialog's pre-check.
   */
  var currentPrecheckOperationId = '';
  function newOperationId() {
    return 'pc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function removePrecheckCancelBar() {
    if (precheckCancelBar !== null) {
      // Same guard as the Star prompt (D-139): a test sandbox's nodes expose
      // `parent`, not `parentNode`, so `!== null` alone still dereferences
      // `undefined` and turns every enqueue reply into an unhandled rejection.
      var parent = precheckCancelBar.parentNode;
      if (parent !== null && parent !== undefined && typeof parent.removeChild === 'function') {
        parent.removeChild(precheckCancelBar);
      }
    }
    precheckCancelBar = null;
  }

  function showPrecheckCancelBar() {
    if (precheckCancelBar !== null) return;
    // A page without a real <body> (static preview / test sandbox) cannot
    // host the bar; the cancel capability simply stays invisible there.
    if (!doc.body || typeof doc.body.appendChild !== 'function') return;
    var bar = doc.createElement('div');
    bar.setAttribute('id', 'queue-precheck-bar');
    bar.setAttribute('role', 'status');
    bar.setAttribute('style', 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);'
      + 'display:flex;align-items:center;gap:12px;padding:10px 16px;border-radius:8px;'
      + 'background:var(--ytvdlt-surface, #fff);color:inherit;'
      + 'box-shadow:0 4px 16px rgba(0,0,0,0.18);z-index:60;');
    var text = doc.createElement('span');
    text.setAttribute('id', 'queue-precheck-bar-text');
    text.textContent = t('queue.precheck.checking');
    var stop = doc.createElement('button');
    stop.setAttribute('type', 'button');
    stop.setAttribute('id', 'queue-precheck-cancel');
    stop.textContent = t('queue.precheck.cancel');
    stop.addEventListener('click', function () {
      singlePrecheckCancelled = true;
      stop.setAttribute('disabled', 'disabled');
      text.textContent = t('queue.precheck.cancelling');
      call('URL_SUPPORT_CHECK_CANCEL', { operationId: currentPrecheckOperationId });
    });
    bar.appendChild(text);
    bar.appendChild(stop);
    doc.body.appendChild(bar);
    precheckCancelBar = bar;
  }

  function needsPrecheckConfirm(verdict) {
    if (!verdict || verdict.blocks === true) return false;
    // A build without the capability must behave exactly like the old path.
    if (verdict.code === 'PREVIEW_UNAVAILABLE') return false;
    var state = String(verdict.state || '');
    // T5: a cancelled check is the user saying "stop", not a site verdict to
    // reason about. It must NEVER offer "add it anyway" — that would enqueue
    // behind the user's back when the cancel came from another live view.
    if (verdict.code === 'PRECHECK_CANCELLED' || state === 'CANCELLED') return false;
    return state === 'NO_MEDIA' || state === 'INDETERMINATE' || state === 'TIMEOUT';
  }

  function precheckConfirmReason(verdict) {
    var state = String((verdict && verdict.state) || '');
    if (state === 'NO_MEDIA') return t('queue.precheck.confirm.noMedia');
    if (state === 'TIMEOUT') return t('queue.precheck.confirm.timeout');
    return t('queue.precheck.confirm.indeterminate');
  }

  function closePrecheckConfirm() {
    if (precheckConfirm !== null && precheckConfirm.parentNode !== null) {
      precheckConfirm.parentNode.removeChild(precheckConfirm);
    }
    precheckConfirm = null;
  }

  function showPrecheckConfirm(verdict, onContinue) {
    closePrecheckConfirm();
    var backdrop = doc.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');

    var modal = doc.createElement('div');
    modal.className = 'modal';

    var title = doc.createElement('h2');
    title.textContent = t('queue.precheck.confirm.title');

    var message = doc.createElement('p');
    message.textContent = precheckConfirmReason(verdict);

    var actions = doc.createElement('div');
    actions.className = 'modal-actions';

    var cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.textContent = t('queue.precheck.confirm.cancel');
    cancel.addEventListener('click', function () {
      closePrecheckConfirm();
      enqueueing = false;
    });

    var proceed = doc.createElement('button');
    proceed.type = 'button';
    proceed.className = 'primary';
    proceed.textContent = t('queue.precheck.confirm.continue');
    proceed.addEventListener('click', function () {
      closePrecheckConfirm();
      onContinue();
    });

    actions.appendChild(cancel);
    actions.appendChild(proceed);
    modal.appendChild(title);
    modal.appendChild(message);
    modal.appendChild(actions);
    backdrop.appendChild(modal);
    doc.body.appendChild(backdrop);
    precheckConfirm = backdrop;
    proceed.focus();
  }

  /** The actual enqueue, shared by the direct and the confirmed path. */
  function startDownload(payload) {
    call('DOWNLOAD_START', payload).then(function (result) {
      enqueueing = false;
      // T5: the enqueue reply ends the cancellable pre-check window; if a
      // cancel landed here it answers PRECHECK_CANCELLED below.
      removePrecheckCancelBar();
      // A one-shot ticket is spent on success; a dead ticket must be forgotten
      // so the next download does not silently repeat a stale subtitle choice.
      var subtitleMessage = subtitlePicker === null ? null : subtitlePicker.onEnqueueResult(result);
      if (subtitleMessage !== null) {
        notify(subtitleMessage);
        return;
      }
      if (!result || result.accepted !== true || result.enqueued !== true) {
        notify(enqueueFailureText(result));
        return;
      }
      var field = doc.getElementById('queue-url');
      if (field !== null) field.value = '';
      if (subtitlePicker !== null) subtitlePicker.onUrlChanged('');
      var note = precheckNote(result.support);
      notify(t('queue.notify.enqueued', { n: Array.isArray(result.taskIds) ? result.taskIds.length : 0 })
        + (note === '' ? '' : ' · ' + note));
      refresh();
    });
  }

  function enqueueSingleDownload(url) {
    if (enqueueing) return;
    if (!/^https?:\/\//i.test(url)) {
      notify(t('queue.notify.invalidUrl'));
      return;
    }
    var payload = downloadPayload(url);
    if (payload === null) return;
    // D-160: bind both pre-checks of this submission to ONE cancellation scope.
    currentPrecheckOperationId = newOperationId();
    payload.operationId = currentPrecheckOperationId;
    enqueueing = true;

    // No bridge = static preview; keep the byte-identical legacy path.
    if (taskBridge() === null) {
      notify(t('queue.notify.enqueuing'));
      startDownload(payload);
      return;
    }

    notify(t('queue.precheck.checking'));
    // T5: the check window shows the runtime cancel bar (live only).
    singlePrecheckCancelled = false;
    showPrecheckCancelBar();
    call('URL_SUPPORT_CHECK', {
      url: url, operationId: currentPrecheckOperationId,
    }).then(function (verdict) {
      if (singlePrecheckCancelled) {
        // The user pressed stop: the verdict (a CANCELLED state) is not a gate
        // judgement — nothing may be enqueued behind their back.
        enqueueing = false;
        removePrecheckCancelBar();
        notify(t('queue.precheck.cancelled'));
        return;
      }
      // D-160: a CANCELLED verdict still terminates here (no confirm modal, no
      // DOWNLOAD_START, no task). With per-submission scopes it can now only
      // come from THIS submission's own cancel, but keeping the verdict as the
      // authority preserves the fail-closed rule if a signal is aborted by any
      // other means (e.g. a process-level shutdown).
      if (verdict && (verdict.code === 'PRECHECK_CANCELLED' || verdict.state === 'CANCELLED')) {
        enqueueing = false;
        removePrecheckCancelBar();
        notify(t('queue.precheck.cancelled'));
        return;
      }
      if (verdict && verdict.blocks === true) {
        enqueueing = false;
        removePrecheckCancelBar();
        notify(enqueueFailureText(verdict));
        return;
      }
      if (needsPrecheckConfirm(verdict)) {
        // The modal takes over; the bar must not sit behind it.
        removePrecheckCancelBar();
        showPrecheckConfirm(verdict, function () { startDownload(payload); });
        return;
      }
      // The bar stays up through DOWNLOAD_START, whose own gate re-check is
      // cancellable too; startDownload() removes it when the reply arrives.
      startDownload(payload);
    }).catch(function () {
      // A pre-check that cannot answer must never block a download (fail-open).
      removePrecheckCancelBar();
      startDownload(payload);
    });
  }

  /**
   * Auto-detect a playlist URL on paste/submit. Everything else keeps the
   * byte-identical single-download path above; a failed probe can still fall
   * back to it from inside the selector.
   */
  function startRealDownload(url) {
    if (enqueueing) return;
    if (playlistImport !== null && typeof playlistImport.isPlaylistLike === 'function'
      && playlistImport.isPlaylistLike(url)) {
      playlistImport.open(url);
      return;
    }
    enqueueSingleDownload(url);
  }

  // ---- D-83: 类型 / 清晰度控件 -------------------------------------------
  var qualitySelect = doc.getElementById('queue-quality');
  var audioFormatSelect = doc.getElementById('queue-audio-format');
  var kindButtons = doc.querySelectorAll('.queue-kind-btn');

  function currentQuality() {
    return choice.kind === 'audio' ? choice.audioQuality : choice.videoQuality;
  }

  /** 选项按当前类型重建：视频列分辨率，音频列码率。 */
  function renderQualityOptions() {
    if (qualitySelect === null) return;
    var options = QUALITY_OPTIONS[choice.kind];
    var selected = currentQuality();
    qualitySelect.textContent = '';
    options.forEach(function (item) {
      var option = doc.createElement('option');
      option.value = item.value;
      option.textContent = item.key ? t(item.key) : item.label;
      qualitySelect.appendChild(option);
    });
    qualitySelect.value = selected;
    qualitySelect.setAttribute('data-kind', choice.kind);
  }

  function setKind(kind) {
    choice.kind = kind === 'audio' ? 'audio' : 'video';
    Array.prototype.forEach.call(kindButtons, function (button) {
      button.setAttribute('aria-pressed', button.getAttribute('data-kind') === choice.kind ? 'true' : 'false');
    });
    // 音频格式只对音频有意义；视频模式下整列隐藏，避免占宽度。
    if (audioFormatSelect !== null) setHidden(audioFormatSelect, choice.kind !== 'audio');
    renderQualityOptions();
    var root = doc.getElementById('queue-root');
    if (root !== null) root.setAttribute('data-kind', choice.kind);
    // Stage 5: audio mode cannot embed a soft subtitle track (main process
    // rejects SUBTITLE_EMBED_UNSUPPORTED), so mirror the gate in the picker.
    if (subtitlePicker !== null) subtitlePicker.setKind();
    saveView();
  }

  if (kindButtons !== null) {
    Array.prototype.forEach.call(kindButtons, function (button) {
      button.addEventListener('click', function () {
        setKind(button.getAttribute('data-kind') === 'audio' ? 'audio' : 'video');
      });
    });
  }
  if (qualitySelect !== null) {
    qualitySelect.addEventListener('change', function () {
      var value = String(qualitySelect.value || '');
      if (choice.kind === 'audio') choice.audioQuality = value;
      else choice.videoQuality = value;
    });
  }
  if (audioFormatSelect !== null) {
    audioFormatSelect.addEventListener('change', function () {
      var value = String(audioFormatSelect.value || 'auto');
      choice.audioFormat = value === 'mp3' || value === 'm4a' ? value : 'auto';
    });
  }

  /** 7 states -> the 4 tabs (Error belongs with Canceled: no successful end). */
  function tabOf(state) {
    if (state === 'Completed') return 'finished';
    if (state === 'Canceled' || state === 'Error') return 'canceled';
    return 'downloading';
  }

  function matchesQuery(task, query) {
    if (query.length === 0) return true;
    var needle = query.toLowerCase();
    return [task.title, task.uploader, task.id].some(function (value) {
      return typeof value === 'string' && value.toLowerCase().indexOf(needle) !== -1;
    });
  }

  function filterTasks(list, tab, query) {
    return list.filter(function (task) {
      if (tab !== 'all' && tabOf(task.state) !== tab) return false;
      return matchesQuery(task, query);
    });
  }

  /** D-87: display order is view-only — the queue itself is never reordered. */
  function sortTasks(list) {
    var copy = list.slice();
    if (model.sort === 'oldest') return copy.reverse();
    if (model.sort === 'name') {
      return copy.sort(function (a, b) { return String(a.title).localeCompare(String(b.title)); });
    }
    if (model.sort === 'state') {
      return copy.sort(function (a, b) {
        return String(a.state).localeCompare(String(b.state)) || String(a.id).localeCompare(String(b.id));
      });
    }
    return copy.reverse(); // newest: the list arrives oldest-first
  }

  function counts(list) {
    var result = { all: list.length, downloading: 0, finished: 0, canceled: 0 };
    list.forEach(function (task) { result[tabOf(task.state)] += 1; });
    return result;
  }

  /** The pages use `hidden="true"` (string) so CSS can target it deterministically. */
  function setHidden(node, hidden) {
    if (node !== null && node !== undefined) node.setAttribute('hidden', hidden ? 'true' : 'false');
  }

  function el(tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function actionsFor(task) {
    var running = task.state === 'Running' || task.state === 'FetchingInfo';
    var retryable = task.state === 'Error' || task.state === 'Canceled';
    if (live.active) {
      // D-76 / D-162 / D-164: match what the queue can actually do.
      //  - `Running` — the transfer has a kill handle;
      //  - `FetchingInfo` — the probe now carries an AbortSignal, so cancelling
      //    during "解析中" really kills the child (before D-162 it refused);
      //  - `pending` — parked in the FIFO, `TaskQueue.cancel()` drops it.
      // `ReadyWithInfo` still has no handle: it is a zero-length phase that
      // ends in `Running` immediately, so it is not offered.
      return {
        cancel: task.state === 'Running' || task.state === 'FetchingInfo' || task.pending === true,
        retry: retryable,
        // D-120: live builds expose "open file" on the card so the freshness
        // check is reachable where the user sees the finished task. Injected
        // ONLY in live mode -> file:// screenshot baselines keep their DOM.
        file: task.state === 'Completed',
        folder: task.state === 'Completed',
        remove: !running,
        detail: true
      };
    }
    return {
      cancel: running || task.state === 'ReadyWithInfo',
      retry: retryable,
      folder: task.state === 'Completed',
      remove: !running,
      detail: true
    };
  }

  // ---- 0.2.1 (D-95): 进度行的构成 ---------------------------------------
  // Parts drop out independently: size unknown, speed unknown and ETA unknown
  // are three different states, and a single template cannot express all eight
  // combinations without turning into a wall of `{placeholder}`s.
  function fmtBytes(value) {
    var s = shell();
    return s !== null && typeof s.formatBytes === 'function' ? s.formatBytes(value) : String(value);
  }
  function fmtSpeed(value) {
    var s = shell();
    return s !== null && typeof s.formatSpeed === 'function' ? s.formatSpeed(value) : String(value) + ' B/s';
  }
  function fmtEta(value) {
    var s = shell();
    return s !== null && typeof s.formatEta === 'function' ? s.formatEta(value) : String(value);
  }
  /** D-107: never invent a number. Unknown is a dash, not 0.0%. */
  function percentLabel(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '—';
    return (Math.round(value * 10) / 10).toFixed(1) + '%';
  }

  /** D-107: a usable percent is a finite NUMBER — `0` is legal data. */
  function hasPercent(task) {
    return typeof task.percent === 'number' && isFinite(task.percent);
  }

  /**
   * D-107: which of the five progress presentations a card needs.
   *
   *   value   — a real percent from THIS run → numeric bar.
   *   unknown — Running, no usable percent yet → keep the D-102 wait animation.
   *             The backend state already IS `Running` (cancel/scheduling depend
   *             on it); only the visual is undecided, so this never waits for a
   *             timer or delays the download.
   *   working — D-115: Running, past the transfer (merge / post-process /
   *             verify). The bytes are done but the task is NOT; a numeric bar
   *             would sit frozen at 100% and read as "stuck". Yellow sweep.
   *   none    — Canceled / Error that never produced a number: an inert track,
   *             no animation, no fake 0% (the terminal text must win).
   *   waiting — Idle / FetchingInfo / ReadyWithInfo: nothing started yet.
   */
  function progressMode(state, hasValue, stage) {
    if (state === 'Completed') return 'complete';
    if (state === 'Running') {
      if (stage === 'merging' || stage === 'postprocess' || stage === 'verifying') return 'working';
      return hasValue ? 'value' : 'unknown';
    }
    if (state === 'Canceled' || state === 'Error') return hasValue ? 'value' : 'none';
    return 'waiting';
  }

  /**
   * D-115: the honest label for a task past the transfer.
   *
   * "merging" is only reachable from yt-dlp's own `[Merger]` line, so this is
   * the single place allowed to say it. Everything else falls back to the
   * generic "finalizing" — including verification, whose outcome is still open.
   */
  function stageText(stage) {
    if (stage === 'merging') return t('queue.stage.merging');
    return t('queue.stage.finalizing');
  }

  /** Size / speed / ETA — only what the engine actually reported. */
  function transferParts(task) {
    var parts = [];
    var done = task.downloadedBytes;
    var total = task.totalBytes;
    if (typeof done === 'number' && isFinite(done) && done > 0) {
      if (typeof total === 'number' && isFinite(total) && total > 0) {
        parts.push(t('queue.card.size', { done: fmtBytes(done), total: fmtBytes(total) }));
      } else {
        parts.push(t('queue.card.downloaded', { done: fmtBytes(done) }));
      }
    }
    if (task.state === 'Running' && typeof task.speed === 'number' && task.speed > 0) {
      parts.push(fmtSpeed(task.speed));
      if (typeof task.eta === 'number' && task.eta >= 0) {
        parts.push(t('queue.card.eta', { eta: fmtEta(task.eta) }));
      }
    }
    return parts;
  }

  function progressText(task) {
    return [percentLabel(task.percent)].concat(transferParts(task)).join(' · ');
  }

  /**
   * D-107: the line under the wait animation while Running.
   *
   * Real bytes are shown when the engine reported them (never a made-up total
   * or percent); otherwise the honest stage is "connecting" — D-112: the card
   * already says 下载中 in its badge, so "preparing" was contradicting itself.
   */
  function unknownProgressText(task) {
    var parts = transferParts(task);
    parts.push(t(parts.length > 0 ? 'queue.card.measuring' : 'queue.card.connecting'));
    return parts.join(' · ');
  }

  // ---- 0.2.1 (D-96): 封面图 -------------------------------------------------
  /** `C:\a b\c.jpg` → `file:///C:/a%20b/c.jpg` (encodeURI keeps the drive colon). */
  function toFileUrl(path) {
    var normalized = String(path).replace(/\\/g, '/').replace(/^\/+/, '');
    return encodeURI('file:///' + normalized);
  }

  function thumbNode(task) {
    var node = el('div', 'thumb');
    var letter = String(task.title || '?').slice(0, 1).toUpperCase();
    var path = task.thumbPath;
    if (typeof path !== 'string' || path === '') {
      node.setAttribute('data-thumb', 'letter');
      node.textContent = letter;
      return node;
    }
    var image = doc.createElement('img');
    image.className = 'thumb-img';
    image.alt = '';
    image.setAttribute('draggable', 'false');
    image.setAttribute('loading', 'lazy');
    image.src = toFileUrl(path);
    node.setAttribute('data-thumb', 'image');
    // A deleted cache file or an unsupported codec must degrade to the badge,
    // not leave a broken-image glyph in the middle of the card.
    image.addEventListener('error', function () {
      if (image.parentNode === node) node.removeChild(image);
      node.setAttribute('data-thumb', 'letter');
      node.textContent = letter;
    });
    node.appendChild(image);
    return node;
  }

  // ---- 0.2.2 (D-102): 等待态的线性不确定进度指示器 -----------------------
  /** 稳定相位：按任务 id 取模，而不是 Date.now()。同一任务每次重绘都落在
   *  动画的同一帧（全量重绘不会把短条甩回起点），多个等待任务不会齐步走，
   *  截图基线也不受真实时间影响。 */
  function waitPhase(id) {
    var hash = 0;
    for (var i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 1700;
    return hash;
  }

  /** 轨道与进行中卡片共用 `.bar`，只把填充条换成 CSS 动画短条。
   *  故意不写 `aria-valuenow` / 百分比：这些状态还没有可报的数值进度。
   *  D-115: `tone` tints the sweep. The preparing/waiting states keep the
   *  accent colour; `work` (merging / post-processing / verifying) is yellow —
   *  the bytes are done but the task is not, and yellow says "still working"
   *  without pretending a number exists. */
  function waitBar(task, tone) {
    var bar = el('div', 'bar');
    bar.setAttribute('data-mode', 'indeterminate');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', t(tone === 'work' ? 'queue.stage.working' : 'queue.card.waiting'));
    if (tone) bar.setAttribute('data-tone', tone);
    var segment = el('i');
    segment.style.animationDelay = '-' + waitPhase(String(task.id)) + 'ms';
    bar.appendChild(segment);
    return bar;
  }

  /** Numeric progress: the classic filled track. Only reached when the value is a
   *  real number (`0` included), so the width never falls back to a guess. */
  function valueBar(task) {
    var pct = hasPercent(task) ? Math.max(0, Math.min(100, task.percent)) : 0;
    var bar = el('div', 'bar');
    var fill = el('i');
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    bar.setAttribute('data-percent', String(task.percent));
    return bar;
  }

  /** A terminal task that never reported a number: inert track, no animation. */
  function idleBar() {
    var bar = el('div', 'bar');
    bar.setAttribute('data-mode', 'idle');
    bar.setAttribute('aria-hidden', 'true');
    bar.appendChild(el('i'));
    return bar;
  }

  /** D-115: the finished track — green and full. Only ever painted for a
   *  `Completed` record, i.e. after verification AND history succeeded. */
  function doneBar() {
    var bar = el('div', 'bar');
    bar.setAttribute('data-mode', 'done');
    bar.setAttribute('data-tone', 'done');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', '100');
    var fill = el('i');
    fill.style.width = '100%';
    bar.appendChild(fill);
    return bar;
  }

  function progressLine(task, mode, text) {
    var node = el('div', 'card-meta card-progress');
    node.setAttribute('data-progress', mode === 'value' ? String(task.percent) : mode);
    node.textContent = text;
    return node;
  }

  /** Stage copy under the wait animation — one honest label per real phase. */
  function waitHint(state) {
    if (state === 'FetchingInfo') return t('queue.card.parsing');
    if (state === 'ReadyWithInfo') return t('queue.card.ready');
    return t('queue.card.queued');
  }

  function card(task) {
    var node = el('article', 'card');
    node.setAttribute('data-task-id', task.id);
    node.setAttribute('data-state', task.state);
    node.setAttribute('data-tab', tabOf(task.state));
    node.setAttribute('data-selected', model.selected[task.id] === true ? 'true' : 'false');
    var mode = progressMode(task.state, hasPercent(task), task.stage);
    node.setAttribute('data-progress-mode', mode);
    if (mode === 'working' && isStage(task.stage)) node.setAttribute('data-stage', task.stage);

    // D-87: per-task checkbox for multi-select.
    var check = doc.createElement('input');
    check.type = 'checkbox';
    check.className = 'card-check';
    check.checked = model.selected[task.id] === true;
    check.setAttribute('aria-label', task.title);
    check.addEventListener('change', function () {
      if (check.checked) model.selected[task.id] = true;
      else delete model.selected[task.id];
      node.setAttribute('data-selected', check.checked ? 'true' : 'false');
      refreshToolbar();
    });
    node.appendChild(check);

    node.appendChild(thumbNode(task));

    var main = el('div', 'card-main');
    var title = el('div', 'card-title', task.title);
    title.setAttribute('title', task.title);
    main.appendChild(title);

    var meta = el('div', 'card-meta');
    var badge = el('span', 'badge', shell() ? shell().stateLabel(task.state) : task.state);
    badge.setAttribute('data-state', task.state);
    meta.appendChild(badge);
    meta.appendChild(doc.createTextNode(' '));
    var suffix = task.uploader + ' · ' + (shell() ? shell().formatDuration(task.duration) : String(task.duration));
    if (task.errorCode) suffix += ' · ' + task.errorCode;
    meta.appendChild(doc.createTextNode(suffix));
    // D-109: one plain-language reason for ordinary users, immediately RIGHT of
    // the existing red failure info (the Error badge + error code) and ABOVE the
    // progress bar. The code, the badge, retry and the detail entry are all
    // untouched — this is an addition, never a replacement.
    var failureKey = failureKeyOf(task);
    if (failureKey !== null) {
      meta.appendChild(doc.createTextNode(' · '));
      var failure = el('span', 'card-failure', t(failureKey));
      failure.setAttribute('data-failure-kind', isFailureKind(task.failureKind) ? task.failureKind : 'unknown');
      meta.appendChild(failure);
    }
    // D-120: one small hint in the SAME meta row. It never hides the card,
    // replaces the "已完成" badge, touches the cover/title/progress bar or
    // deletes history. Static previews have no `fileStatus` -> no DOM change.
    var fileKey = fileStateKey(task);
    if (fileKey !== null) {
      meta.appendChild(doc.createTextNode(' · '));
      var fileState = el('span', 'card-file-state', t(fileKey));
      fileState.setAttribute('data-file-status', task.fileStatus);
      meta.appendChild(fileState);
    }
    if (task.subtitleOutcome === 'missing' || task.subtitleOutcome === 'partial') {
      meta.appendChild(doc.createTextNode(' · '));
      var subtitleWarning = el('span', 'card-failure', t('subtitle.outcome.' + task.subtitleOutcome));
      subtitleWarning.setAttribute('data-subtitle-outcome', task.subtitleOutcome);
      subtitleWarning.setAttribute('role', 'status');
      meta.appendChild(subtitleWarning);
    }
    main.appendChild(meta);

    if (mode === 'value') {
      main.appendChild(valueBar(task));
      main.appendChild(progressLine(task, 'value', progressText(task)));
    } else if (mode === 'working') {
      // D-115: the transfer is over, the task is not. Percent is deliberately
      // hidden — a video+audio pair reaches 100% twice and neither means done.
      main.appendChild(waitBar(task, 'work'));
      main.appendChild(progressLine(task, 'working', stageText(task.stage)));
    } else if (mode === 'complete') {
      // D-115: green bar + the final transfer numbers. Reached only after
      // verification passed and the history row was written (CD-12 order).
      main.appendChild(doneBar());
      var done = el('div', 'card-meta card-progress');
      done.setAttribute('data-progress', '100');
      done.textContent = progressText({ percent: 100, downloadedBytes: task.downloadedBytes, totalBytes: task.totalBytes, state: 'Completed', speed: 0, eta: null });
      main.appendChild(done);
    } else if (mode === 'unknown') {
      // D-107: the D-102 animation keeps running after the state turns
      // `Running` — a percent only appears once THIS run reported one.
      main.appendChild(waitBar(task));
      main.appendChild(progressLine(task, 'unknown', unknownProgressText(task)));
    } else if (mode === 'none') {
      // Canceled / Error before the first progress line: the terminal state must
      // win, and "0.0%" would be an invented number.
      main.appendChild(idleBar());
      main.appendChild(progressLine(task, 'none', t('queue.card.noProgress')));
    } else {
      // 0.2.2 (D-102): 下载尚未开始（Idle / FetchingInfo / ReadyWithInfo）。
      // 复用下载进度条的轨道，换成循环短条：大文件解析较久时也有可见反馈，
      // 不会被当成卡死；状态文案保留，但不编造百分比。
      main.appendChild(waitBar(task));
      main.appendChild(el('div', 'card-meta', waitHint(task.state)));
    }

    var foot = el('div', 'card-foot');
    var allowed = actionsFor(task);
    var addButton = function (action, key) {
      if (allowed[action] !== true) return;
      var button = el('button', null, t(key));
      button.setAttribute('type', 'button');
      button.setAttribute('data-action', action);
      button.setAttribute('aria-disabled', 'false');
      if (action === 'remove') {
        button.className = 'remove-btn';
        button.addEventListener('click', function () { requestDelete([task.id]); });
      } else {
        button.addEventListener('click', function () { act(action, task); });
      }
      foot.appendChild(button);
    };
    addButton('cancel', 'queue.action.cancel');
    addButton('retry', 'queue.action.retry');
    addButton('file', 'detail.openFile');
    addButton('folder', 'queue.action.open-folder');
    addButton('remove', 'queue.action.remove');
    foot.appendChild(el('span', 'spacer'));
    addButton('detail', 'queue.action.detail');
    main.appendChild(foot);

    node.appendChild(main);

    // D-87: right-click menu, wired once per card.
    node.addEventListener('contextmenu', function (event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      var x = event && typeof event.clientX === 'number' ? event.clientX : 0;
      var y = event && typeof event.clientY === 'number' ? event.clientY : 0;
      openContextMenu(task, x, y);
    });
    return node;
  }

  function emit(action, task, value) {
    var output = doc.getElementById('ytvdlt-output');
    if (output === null) return;
    setHidden(output, false);
    output.textContent = JSON.stringify({
      action: action,
      taskId: task ? task.id : null,
      // D-83: 截图/静态预览里也把选中项写出来，便于对照实际会下发什么。
      ...(action === 'paste-and-parse' ? { kind: choice.kind, quality: currentQuality(), audioFormat: choice.audioFormat } : {}),
      // Never echo the URL (it can carry a signature): report presence only.
      ...(typeof value === 'string' && value.length > 0 ? { urlProvided: true } : {})
    }, null, 2);
    output.setAttribute('data-last-action', action);
  }

  function setEmptyVariant(variant) {
    var box = doc.getElementById('queue-empty');
    if (box === null) return;
    box.setAttribute('data-variant', variant);
    var title = box.querySelector('h2');
    var hint = box.querySelector('p');
    if (variant === 'filter') {
      if (title) title.textContent = t('queue.filter.empty.title');
      if (hint) hint.textContent = t('queue.filter.empty.hint');
    } else {
      if (title) title.textContent = t('queue.empty.title');
      if (hint) hint.textContent = t('queue.empty.hint');
    }
  }

  /** D-87: keep the toolbar's dynamic labels in the active locale. */
  function refreshToolbar() {
    var selectedIds = Object.keys(model.selected).filter(function (id) { return model.selected[id] === true; });
    var count = doc.getElementById('queue-selected-count');
    if (count !== null) count.textContent = t('queue.selected.count', { n: selectedIds.length });
    var remove = doc.getElementById('queue-delete-selected');
    if (remove !== null) {
      remove.textContent = t('queue.tools.deleteSelected');
      remove.disabled = selectedIds.length === 0;
    }
    var clear = doc.getElementById('queue-clear-history');
    if (clear !== null) clear.textContent = t('queue.tools.clearHistory');
    var all = doc.getElementById('queue-select-all');
    if (all !== null) {
      var visible = sortTasks(filterTasks(tasks(), model.tab, model.query));
      all.checked = visible.length > 0 && visible.every(function (task) { return model.selected[task.id] === true; });
      all.indeterminate = !all.checked && visible.some(function (task) { return model.selected[task.id] === true; });
    }
  }

  function render() {
    var list = tasks();
    var root = doc.getElementById('queue-root');
    var cardsHost = doc.getElementById('queue-cards');
    var visible = sortTasks(filterTasks(list, model.tab, model.query));
    var perTab = counts(list);
    var errorMode = param('error', '0') === '1' || live.error;
    // D-141: live mode, after boot and before the first `TASK_LIST` reply. The
    // queue is unknown here — neither the fixture nor the empty illustration may
    // be painted, or the window would claim something it cannot know yet.
    var awaitingFirstList = live.active && live.tasks === null && !live.error;
    // Live mode reports what is actually running; the fixture keeps 2/3 so the
    // screenshot baselines stay identical.
    var banner = CONCURRENCY;
    if (live.active) {
      var runningNow = 0;
      list.forEach(function (task) {
        if (task.state === 'Running' || task.state === 'FetchingInfo') runningNow += 1;
      });
      banner = { active: runningNow, limit: CONCURRENCY.limit };
    }

    cardsHost.textContent = '';
    visible.forEach(function (task) { cardsHost.appendChild(card(task)); });

    var empty = doc.getElementById('queue-empty');
    var error = doc.getElementById('queue-error');
    var showError = errorMode;
    var showEmpty = !errorMode && visible.length === 0 && !awaitingFirstList;
    setHidden(empty, !showEmpty);
    setHidden(error, !showError);
    setHidden(cardsHost, showError || showEmpty || awaitingFirstList);
    if (showEmpty) setEmptyVariant(list.length === 0 ? 'empty' : 'filter');
    if (showError) {
      root.setAttribute('data-state', 'error');
    } else if (awaitingFirstList) {
      root.setAttribute('data-state', 'loading');
    } else if (visible.length === 0) {
      root.setAttribute('data-state', 'empty');
    } else {
      root.setAttribute('data-state', 'ready');
    }

    root.setAttribute('data-tab', model.tab);
    root.setAttribute('data-visible-count', String(showError ? 0 : visible.length));
    root.setAttribute('data-total-count', String(list.length));
    root.setAttribute('data-concurrency', banner.active + '/' + banner.limit);

    TABS.forEach(function (tab) {
      var button = doc.querySelector('.queue-tab[data-tab="' + tab + '"]');
      if (button === null) return;
      button.setAttribute('aria-selected', tab === model.tab ? 'true' : 'false');
      var counter = button.querySelector('.n');
      if (counter === null) {
        counter = el('span', 'n');
        button.appendChild(counter);
      }
      counter.textContent = String(perTab[tab]);
      button.setAttribute('data-count', String(perTab[tab]));
    });

    var concurrency = doc.getElementById('queue-concurrency');
    if (concurrency !== null) {
      concurrency.textContent = t('queue.concurrency', { active: banner.active, limit: banner.limit });
    }
    var footCount = doc.getElementById('queue-foot-count');
    if (footCount !== null) footCount.textContent = visible.length + ' / ' + list.length;
    refreshToolbar();
    lastPaint = paintKey(list);
    lastProgress = progressKey(list);
    return { list: list, visible: visible, counts: perTab };
  }

  function selectTab(tab) {
    if (TABS.indexOf(tab) === -1) return;
    model.tab = tab;
    saveView();
    render();
  }

  // ---- D-85: language switch (persisted through SETTINGS_SET) -------------
  function paintLanguageButtons() {
    var current = locale();
    var buttons = doc.querySelectorAll('#queue-lang [data-locale]');
    Array.prototype.forEach.call(buttons, function (button) {
      var value = button.getAttribute('data-locale') === 'en' ? 'en' : 'zh-CN';
      button.setAttribute('aria-pressed', value === current ? 'true' : 'false');
    });
  }

  function switchLocale(next) {
    var target = next === 'en' ? 'en' : 'zh-CN';
    store('ytvdlt.locale', target);
    call('SETTINGS_SET', { language: target }).then(function () { /* best effort */ });
    var url = String(global.location.href).replace(/[?&]lang=[^&]*/g, '');
    // Keep the other query switches (tab / theme / kind) intact.
    var separator = url.indexOf('?') === -1 ? '?' : '&';
    var finalUrl = target === 'zh-CN' ? url : url + separator + 'lang=' + target;
    if (global.location && typeof global.location.replace === 'function') global.location.replace(finalUrl);
  }

  function installLanguageSwitch() {
    paintLanguageButtons();
    var buttons = doc.querySelectorAll('#queue-lang [data-locale]');
    Array.prototype.forEach.call(buttons, function (button) {
      button.addEventListener('click', function () {
        switchLocale(button.getAttribute('data-locale') === 'en' ? 'en' : 'zh-CN');
      });
    });
  }

  // ---- D-106: full-screen is owned by shell/app-nav.js -------------------
  // The old button used the HTML Fullscreen API while 视图/全屏 used Electron's
  // setFullScreen(); the button could never exit a fullscreen entered from the
  // menu. One shared controller now drives the native window state, and the
  // main process pushes enter/leave back to the renderer.
  function installFullscreen() {
    var nav = global.YTVDLTNav;
    if (nav && typeof nav.bindFullscreenButton === 'function') {
      // layout.css hides the legacy header button, but keep it in sync so any
      // older markup never shows a stale label.
      nav.bindFullscreenButton('queue-fullscreen');
    }
  }

  // ---- D-87: right-click menu + delete / clear confirmation ---------------
  var contextTask = null;
  var pending = { mode: 'delete', ids: [] };

  function openContextMenu(task, x, y) {
    var menu = doc.getElementById('queue-context-menu');
    if (menu === null) return;
    contextTask = task;
    var folder = menu.querySelector('[data-ctx="folder"]');
    if (folder !== null) setHidden(folder, !actionsFor(task).folder);
    setHidden(menu, false);
    var width = menu.offsetWidth || 180;
    var height = menu.offsetHeight || 120;
    var maxX = Math.max(0, (global.innerWidth || 1280) - width - 8);
    var maxY = Math.max(0, (global.innerHeight || 800) - height - 8);
    menu.style.left = Math.min(x, maxX) + 'px';
    menu.style.top = Math.min(y, maxY) + 'px';
  }

  function closeContextMenu() {
    var menu = doc.getElementById('queue-context-menu');
    setHidden(menu, true);
  }

  function installContextMenu() {
    var menu = doc.getElementById('queue-context-menu');
    if (menu !== null) {
      menu.addEventListener('click', function (event) {
        var node = event && event.target;
        var target = node && typeof node.closest === 'function' ? node.closest('[data-ctx]') : null;
        if (target === null || contextTask === null) return;
        var action = target.getAttribute('data-ctx');
        closeContextMenu();
        if (action === 'delete') { requestDelete([contextTask.id]); return; }
        if (action === 'folder') { act('folder', contextTask); return; }
        act('detail', contextTask);
      });
    }
    doc.addEventListener('click', function (event) {
      if (menu === null) return;
      if (event && event.target && menu.contains(event.target)) return;
      closeContextMenu();
    });
    doc.addEventListener('keydown', function (event) {
      if (event && event.key === 'Escape') { closeContextMenu(); closeModal(); }
    });
  }

  function setModalText(id, text) {
    var node = doc.getElementById(id);
    if (node === null) return;
    node.removeAttribute('data-i18n');
    node.textContent = text;
  }

  /**
   * D-116: one destructive dialog for every entry point (single card, batch
   * selection, clear-history).
   *
   * The old dialog offered TWO primary buttons — "only the record" and "also
   * the files" — with the destructive one permanently red. That is a coin flip
   * next to the mouse, not a decision. Now the default action is always the
   * safe one and file deletion needs an explicit tick.
   */
  function openModal(mode, ids) {
    pending.mode = mode;
    pending.ids = ids.slice();
    var box = doc.getElementById('queue-modal-with-files');
    var note = doc.getElementById('queue-modal-note');
    if (mode === 'clear') {
      setModalText('queue-modal-title', t('queue.clear.title'));
      setModalText('queue-modal-message', t('queue.clear.message'));
      setModalText('queue-modal-count', t('queue.delete.count', { n: ids.length }));
      setModalText('queue-modal-note', t('queue.clear.filesHint'));
      setHidden(box, false);
      setHidden(note, false);
    } else {
      setModalText('queue-modal-title', t('queue.delete.title'));
      setModalText('queue-modal-message', t('queue.delete.message'));
      setModalText('queue-modal-count', t('queue.delete.count', { n: ids.length }));
      setModalText('queue-modal-note', t('queue.delete.filesHint'));
      setHidden(box, false);
      setHidden(note, false);
    }
    // D-116: EVERY open starts unticked — a remembered tick is how a user
    // deletes files they meant to keep on the second pass.
    if (box !== null) box.checked = false;
    syncDeleteRisk();
    setHidden(doc.getElementById('queue-modal'), false);
  }

  /**
   * D-116: reflect the tick in the confirm button. The button is the only
   * element that changes colour, so "blue = records only / red = records AND
   * files" stays unambiguous in both themes.
   */
  function syncDeleteRisk() {
    var box = doc.getElementById('queue-modal-with-files');
    var label = doc.getElementById('queue-modal-check');
    var confirm = doc.getElementById('queue-modal-confirm');
    var withFiles = box !== null && box.checked === true;
    if (label !== null) label.setAttribute('data-risk', withFiles ? 'true' : 'false');
    var risk = doc.getElementById('queue-modal-risk');
    if (risk !== null) setHidden(risk, !withFiles);
    if (confirm === null) return;
    confirm.className = withFiles ? 'danger' : 'primary';
    confirm.removeAttribute('data-i18n');
    if (pending.mode === 'clear') {
      confirm.textContent = t(withFiles ? 'queue.clear.confirmFiles' : 'queue.clear.confirm');
    } else {
      confirm.textContent = t(withFiles ? 'queue.delete.confirmFiles' : 'queue.delete.confirm');
    }
  }

  function closeModal() {
    setHidden(doc.getElementById('queue-modal'), true);
    pending.ids = [];
    // D-116: never carry the tick to the next dialog.
    var box = doc.getElementById('queue-modal-with-files');
    if (box !== null) box.checked = false;
  }

  function requestDelete(ids) {
    if (ids.length === 0) { notify(t('queue.notify.noSelection')); return; }
    if (!live.active) { emit('remove', { id: ids[0] }); return; }
    openModal('delete', ids);
  }

  /** Iterate the existing `remove` action; `withFiles` is a main-process flag. */
  function performRemoval(ids, withFiles) {
    var done = 0;
    var failed = 0;
    var filesMissing = 0;
    var filesTrashed = 0;
    var sharedKept = 0;
    var failureReason = '';
    var chain = Promise.resolve();
    ids.forEach(function (id) {
      chain = chain.then(function () {
        var payload = { taskId: id, action: 'remove' };
        if (withFiles) payload.withFiles = true;
        return call('TASK_ACTION', payload).then(function (result) {
          if (result && result.ok !== false) {
            done += 1;
            if (typeof result.filesMissing === 'number') filesMissing += result.filesMissing;
            if (typeof result.filesTrashed === 'number') filesTrashed += result.filesTrashed;
            if (typeof result.sharedSkipped === 'number') sharedKept += result.sharedSkipped;
          } else {
            failed += 1;
            if (failureReason === '') {
              failureReason = (result && (result.reason || result.message || result.code)) || t('queue.notify.ipc');
            }
          }
        });
      });
    });
    chain.then(function () {
      pending.ids.forEach(function (id) { delete model.selected[id]; });
      closeModal();
      var count = failed + ' / ' + ids.length;
      if (failed > 0) {
        // D-120: a REAL filesystem failure says why and how to fall back to
        // "history only". A missing file is not a failure and never lands here.
        notify(withFiles
          ? t('queue.delete.filesFailed', { reason: failureReason || count })
          : t('queue.status.failed', { reason: failureReason || count }));
      } else if (sharedKept > 0) {
        notify(t('queue.delete.filesShared'));
      } else if (withFiles && filesMissing > 0 && filesTrashed === 0) {
        notify(t('queue.delete.filesAlreadyGone'));
      } else if (withFiles) notify(t('queue.status.filesRemoved', { n: done }));
      else if (pending.mode === 'clear') notify(t('queue.status.cleared'));
      else notify(t('queue.status.removed', { n: done }));
      pending.mode = 'delete';
      refresh(true);
    });
  }

  function clearHistory() {
    var ids = tasks()
      .filter(function (task) { return HISTORY_STATES.indexOf(task.state) !== -1; })
      .map(function (task) { return task.id; });
    if (ids.length === 0) { notify(t('queue.clear.empty')); return; }
    if (!live.active) { emit('clear-history', null); return; }
    openModal('clear', ids);
  }

  function installTaskManagement() {
    var all = doc.getElementById('queue-select-all');
    if (all !== null) {
      all.addEventListener('change', function () {
        var visible = sortTasks(filterTasks(tasks(), model.tab, model.query));
        visible.forEach(function (task) {
          if (all.checked) model.selected[task.id] = true;
          else delete model.selected[task.id];
        });
        render();
      });
    }
    var sort = doc.getElementById('queue-sort');
    if (sort !== null) {
      var saved = readStore('ytvdlt.sort');
      model.sort = ['newest', 'oldest', 'name', 'state'].indexOf(saved) === -1 ? 'newest' : saved;
      sort.value = model.sort;
      sort.addEventListener('change', function () {
        model.sort = ['newest', 'oldest', 'name', 'state'].indexOf(sort.value) === -1 ? 'newest' : sort.value;
        store('ytvdlt.sort', model.sort);
        saveView();
        render();
      });
    }
    var remove = doc.getElementById('queue-delete-selected');
    if (remove !== null) {
      remove.addEventListener('click', function () {
        var ids = Object.keys(model.selected).filter(function (id) { return model.selected[id] === true; });
        requestDelete(ids);
      });
    }
    var clear = doc.getElementById('queue-clear-history');
    if (clear !== null) clear.addEventListener('click', clearHistory);

    var cancel = doc.getElementById('queue-modal-cancel');
    if (cancel !== null) cancel.addEventListener('click', closeModal);
    var backdrop = doc.getElementById('queue-modal');
    if (backdrop !== null) {
      backdrop.addEventListener('click', function (event) {
        if (event && event.target === backdrop) closeModal();
      });
    }
    // D-116: one confirm button; the checkbox decides whether the artifacts are
    // recycled too. No second destructive button exists any more.
    var confirm = doc.getElementById('queue-modal-confirm');
    if (confirm !== null) {
      confirm.addEventListener('click', function () {
        var box = doc.getElementById('queue-modal-with-files');
        performRemoval(pending.ids, box !== null && box.checked === true);
      });
    }
    var withFilesBox = doc.getElementById('queue-modal-with-files');
    if (withFilesBox !== null) withFilesBox.addEventListener('change', syncDeleteRisk);

    // D-88: private mode is persisted by the host and honoured on window close.
    var privateBox = doc.getElementById('queue-private-mode');
    if (privateBox !== null) {
      privateBox.checked = readStore('ytvdlt.privateMode') === 'true';
      if (live.active) {
        call('SETTINGS_GET', {}).then(function (snapshot) {
          if (snapshot && typeof snapshot.privateMode === 'boolean') {
            privateBox.checked = snapshot.privateMode;
            store('ytvdlt.privateMode', String(snapshot.privateMode));
          }
        });
      }
      privateBox.addEventListener('change', function () {
        var on = privateBox.checked;
        store('ytvdlt.privateMode', String(on));
        call('SETTINGS_SET', { privateMode: on });
        notify(t(on ? 'queue.status.privateOn' : 'queue.status.privateOff'));
      });
    }
    installContextMenu();
  }

  // ---- wiring ----
  TABS.forEach(function (tab) {
    var button = doc.querySelector('.queue-tab[data-tab="' + tab + '"]');
    if (button !== null) button.addEventListener('click', function () { selectTab(tab); });
  });

  var search = doc.getElementById('queue-search');
  if (search !== null) {
    search.addEventListener('input', function () {
      model.query = String(search.value || '').trim();
      saveView();
      render();
    });
  }

  var pasteForm = doc.getElementById('queue-paste-form');
  if (pasteForm !== null) {
    pasteForm.addEventListener('submit', function (event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      var field = doc.getElementById('queue-url');
      var value = field === null ? '' : String(field.value || '').trim();
      if (live.active) { startRealDownload(value); return; }
      emit('paste-and-parse', null, value);
    });
  }
  var paste = doc.getElementById('queue-paste');
  if (paste !== null) paste.addEventListener('click', function (event) {
    // D-80: handle the click explicitly in live mode instead of relying on the
    // browser turning a submit button into a form submission. That implicit
    // chain is what broke twice: first preventDefault ate the submit, and after
    // reordering it still depended on native form semantics the user could not
    // verify. Now the click itself enqueues; the form handler below only serves
    // the Enter key.
    if (live.active) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      var field = doc.getElementById('queue-url');
      startRealDownload(field === null ? '' : String(field.value || '').trim());
      return;
    }
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    emit('paste-and-parse', null);
  });
  var fresh = doc.getElementById('queue-new');
  if (fresh !== null) fresh.addEventListener('click', function () {
    if (live.active) {
      var field = doc.getElementById('queue-url');
      var typed = field === null ? '' : String(field.value || '').trim();
      if (typed !== '') { startRealDownload(typed); return; }
      if (field !== null) field.focus();
      notify(t('queue.notify.pasteHint'));
      return;
    }
    emit('new-download', null);
  });
  var emptyCta = doc.getElementById('queue-empty-cta');
  if (emptyCta !== null) emptyCta.addEventListener('click', function () {
    if (live.active) {
      var field = doc.getElementById('queue-url');
      var typed = field === null ? '' : String(field.value || '').trim();
      if (typed !== '') { startRealDownload(typed); return; }
      if (field !== null) field.focus();
      notify(t('queue.notify.pasteHint'));
      return;
    }
    emit('paste-and-parse', null);
  });
  var retry = doc.getElementById('queue-retry');
  if (retry !== null) retry.addEventListener('click', function () {
    if (live.active) { live.error = false; refresh(); return; }
    emit('reload-queue', null); render();
  });

  live.active = isLive();
  ensureSubtitlePicker();
  ensureTxtImport();
  ensurePlaylistImport();
  ensureSupportedSites();
  model.tab = TABS.indexOf(param('tab', 'all')) === -1 ? 'all' : param('tab', 'all');
  // `?kind=audio` starts on the audio tab (e2e case + deep-link friendly).
  setKind(param('kind', 'video') === 'audio' ? 'audio' : 'video');
  installLanguageSwitch();
  installFullscreen();
  installTaskManagement();
  restoreView();
  viewReady = true;
  var bodyScroll = doc.getElementById('queue-body');
  if (bodyScroll !== null) bodyScroll.addEventListener('scroll', saveView);
  if (global.YTVDLTNav && typeof global.YTVDLTNav.onLeave === 'function') {
    global.YTVDLTNav.onLeave(saveView);
  }
  global.addEventListener('pagehide', saveView);
  // D-120: the user may delete/move a video in Explorer while the window is
  // hidden or another page is open. Re-entry must re-stat the recorded paths
  // instead of trusting a stale cache; the next poll then picks it up.
  var markStatusStale = function () { if (live.active) statusRefreshDue = true; };
  global.addEventListener('pageshow', markStatusStale);
  global.addEventListener('focus', markStatusStale);
  doc.addEventListener('visibilitychange', function () {
    if (doc.visibilityState !== 'hidden') markStatusStale();
  });
  var result = render();
  if (live.active) {
    // D-112: a fixed 1.2 s tick shows at most one or two frames of a download
    // that takes a few seconds, so the card appeared to jump from "connecting"
    // straight to "completed". Poll fast while something is in flight, fall back
    // when the queue is idle. The next delay is chosen AFTER the reply lands, so
    // the cadence always reflects the list we just received. Numbers are patched
    // in place (`patchProgress`), so the faster cadence does not rebuild covers.
    var pollActiveMs = 400;
    // Idle stays at the historical 1.2 s cadence — no extra load when nothing
    // is running, and the existing 1.2 s poll test contract keeps working.
    var pollIdleMs = 1200;
    var loop = function () {
      // A hidden page does not need to repaint; it refreshes again as soon as it
      // is visible, on the next tick.
      var step = doc.visibilityState === 'hidden' ? Promise.resolve() : refresh();
      step.then(function () {
        global.setTimeout(loop, hasActiveTask() ? pollActiveMs : pollIdleMs);
      });
    };
    loop();
    // D-141: a first reply that never lands would leave the shell blank forever.
    // After this window the page admits it could not read the queue and offers
    // the normal retry button, instead of silently showing nothing.
    global.setTimeout(function () {
      if (live.tasks !== null || live.error) return;
      live.error = true;
      render();
    }, 2500);
  }

  if (global.YTVDLT && global.YTVDLT.shell) {
    global.YTVDLT.shell.boot({
      'paste-parse': function () { emit('paste-and-parse', null); },
      'new-download': function () { emit('new-download', null); },
      'search': function () { if (search !== null) search.focus(); },
      'nav-1': function () { selectTab('all'); },
      'nav-2': function () { selectTab('downloading'); },
      'nav-3': function () { selectTab('finished'); },
      'nav-4': function () { selectTab('canceled'); },
      'refresh': function () { render(); }
    });
    var argv = Array.isArray(global.__YTVDLT_ARGV__) ? global.__YTVDLT_ARGV__ : [];
    var deepLink = global.YTVDLT.shortcuts.extractDeepLink(argv);
    // The Electron bootstrap also passes ?prefill= on a second-instance launch.
    var fromQuery = param('prefill', '');
    if (deepLink === null && /^https?:\/\//i.test(fromQuery)) deepLink = fromQuery;
    if (deepLink !== null) {
      global.YTVDLT.shell.prefill(deepLink, { focus: param('focus', '1') !== '0' });
      // A deep link replaces the URL programmatically (no `input` event), so
      // invalidate any ticket bound to the previously typed link explicitly.
      if (subtitlePicker !== null) subtitlePicker.onUrlChanged(subtitleUrl());
      var shellRoot = doc.getElementById('queue-root');
      if (shellRoot !== null) {
        // Never mirror the link itself into the DOM: it can carry a signature.
        shellRoot.setAttribute('data-prefilled', 'true');
        try { shellRoot.setAttribute('data-prefill-host', new URL(deepLink).host); } catch (error) { /* opaque URL */ }
      }
    }
  }

  global.YTVDLTQueue = {
    render: render,
    selectTab: selectTab,
    tabOf: tabOf,
    filterTasks: filterTasks,
    counts: counts,
    sample: SAMPLE,
    snapshot: result,
    // D-83: 类型/清晰度状态，e2e 与单测据此断言实际下发值。
    setKind: setKind,
    choice: choice,
    // D-85…D-88: exposed for the packaged-app smoke driver.
    locale: locale,
    switchLocale: switchLocale,
    requestDelete: requestDelete,
    clearHistory: clearHistory,
    model: model,
    // Stage 5: test/smoke surface for the subtitle picker wiring.
    subtitlePicker: function () { return subtitlePicker; },
    mountSubtitlePicker: mountSubtitlePicker,
    // TXT import: exposed for the packaged-app smoke driver / unit tests.
    txtImport: function () { return txtImport; },
    mountTxtImport: mountTxtImport,
    ensureTxtImport: ensureTxtImport,
    playlistImport: function () { return playlistImport; },
    mountPlaylistImport: mountPlaylistImport,
    ensurePlaylistImport: ensurePlaylistImport,
    startRealDownload: startRealDownload,
    enqueueSingleDownload: enqueueSingleDownload,
    downloadPayload: downloadPayload,
    // D-148: test/smoke surface for the Star-prompt wiring (same idea as the
    // subtitle-picker / txt-import exposures above).
    starPrompt: function () {
      return {
        shown: starPromptShown,
        checked: starPromptChecked,
        dialogOpen: starPromptDialog !== null,
        scheduled: starPromptTimer !== null
      };
    },
    scheduleStarPrompt: scheduleStarPrompt,
    maybeCheckStarPrompt: maybeCheckStarPrompt,
    showStarPrompt: showStarPrompt,
    closeStarPrompt: closeStarPrompt
  };
})(typeof window === 'undefined' ? this : window);
