/**
 * queue-model.js — the pure display model of the download queue page (task 5).
 *
 * Extracted VERBATIM from `queue.js`: the wire-DTO projection (`toTask`), the
 * enum mirrors + guards (D-109 / D-115 / D-120), the tab / filter / counts
 * logic, and the D-107 / D-115 progress-mode state machine with its pure
 * formatting math. ZERO dependencies: no DOM, no bridge, no timer, no I/O, no
 * implicit globals, no closure state — every function maps its arguments and
 * nothing else.
 *
 * It is a plain `<script>` IIFE (same shape as every `packages/ui` module) and
 * attaches to the shared `YTVDLT` namespace. `index.html` loads it BEFORE
 * `queue.js`; the page stays the single state owner (model / live / choice /
 * selection / every timer and listener) and calls the model through
 * byte-identical delegates, so no call site moved.
 */
(function (global) {
  'use strict';
  var YTVDLT = global.YTVDLT || (global.YTVDLT = {});

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

  function counts(list) {
    var result = { all: list.length, downloading: 0, finished: 0, canceled: 0 };
    list.forEach(function (task) { result[tabOf(task.state)] += 1; });
    return result;
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

  // ---- 0.2.2 (D-102): 等待态的线性不确定进度指示器 -----------------------
  /** 稳定相位：按任务 id 取模，而不是 Date.now()。同一任务每次重绘都落在
   *  动画的同一帧（全量重绘不会把短条甩回起点），多个等待任务不会齐步走，
   *  截图基线也不受真实时间影响。 */
  function waitPhase(id) {
    var hash = 0;
    for (var i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 1700;
    return hash;
  }

  /** `C:\a b\c.jpg` → `file:///C:/a%20b/c.jpg` (encodeURI keeps the drive colon). */
  function toFileUrl(path) {
    var normalized = String(path).replace(/\\/g, '/').replace(/^\/+/, '');
    return encodeURI('file:///' + normalized);
  }

  YTVDLT.queueModel = {
    SAMPLE: SAMPLE,
    TABS: TABS,
    CONCURRENCY: CONCURRENCY,
    HISTORY_STATES: HISTORY_STATES,
    QUALITY_OPTIONS: QUALITY_OPTIONS,
    toTask: toTask,
    isStage: isStage,
    isFailureKind: isFailureKind,
    isFileStatus: isFileStatus,
    fileStateKey: fileStateKey,
    failureKeyOf: failureKeyOf,
    tabOf: tabOf,
    matchesQuery: matchesQuery,
    filterTasks: filterTasks,
    counts: counts,
    percentLabel: percentLabel,
    hasPercent: hasPercent,
    progressMode: progressMode,
    waitPhase: waitPhase,
    toFileUrl: toFileUrl
  };
})(typeof window === 'undefined' ? this : window);
