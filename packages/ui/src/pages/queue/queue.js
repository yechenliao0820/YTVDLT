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
      speed: 4_200_000, eta: 96, kind: 'video', artifacts: 0, errorCode: null
    },
    {
      id: 't-fetch-2', state: 'FetchingInfo', title: 'Big Buck Bunny — 4K remaster',
      uploader: 'Peach Open Movie', duration: 596, percent: 0,
      speed: 0, eta: null, kind: 'video', artifacts: 0, errorCode: null
    },
    {
      id: 't-ready-3', state: 'ReadyWithInfo', title: 'Sintel — 1080p',
      uploader: 'Durian Open Movie', duration: 888, percent: 0,
      speed: 0, eta: null, kind: 'video', artifacts: 0, errorCode: null
    },
    {
      id: 't-done-4', state: 'Completed', title: 'Tears of Steel — 720p',
      uploader: 'Mango Open Movie', duration: 734, percent: 100,
      speed: 0, eta: 0, kind: 'video', artifacts: 2, errorCode: null
    },
    {
      id: 't-cancel-5', state: 'Canceled', title: 'Cosmos Laundromat — pilot',
      uploader: 'Gooseberry', duration: 731, percent: 37,
      speed: 0, eta: null, kind: 'video', artifacts: 0, errorCode: null
    },
    {
      id: 't-error-6', state: 'Error', title: 'Live concert — private stream',
      uploader: 'unknown', duration: null, percent: 12,
      speed: 0, eta: null, kind: 'audio', artifacts: 0, errorCode: 'HTTP_403'
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
    if (live.active && Array.isArray(live.tasks)) return live.tasks;
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
    SETTINGS_SET: 'ytvdlt:settings:set'
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
      kind: item.kind || 'video',
      title: item.title || item.id,
      uploader: item.uploader || '—',
      duration: typeof item.duration === 'number' ? item.duration : null,
      percent: typeof item.percent === 'number' ? item.percent : 0,
      speed: 0, eta: null,
      artifacts: typeof item.artifactCount === 'number' ? item.artifactCount : 0,
      errorCode: item.errorCode || null
    };
  }

  function refresh() {
    if (!live.active) { render(); return; }
    call('TASK_LIST', { tab: 'all' }).then(function (result) {
      if (!result || result.ok === false) { live.error = true; render(); return; }
      live.error = false;
      live.tasks = (Array.isArray(result.items) ? result.items : []).map(toTask);
      render();
    });
  }

  function actionCode(result) {
    if (!result) return t('queue.notify.ipc');
    if (result.ok === true) return null;
    return result.message || result.code || t('queue.notify.ipc');
  }

  /** Real execution in live mode; the JSON contract otherwise. */
  function act(action, task) {
    if (!live.active) { emit(action, task); return; }
    if (action === 'detail') {
      var suffix = locale() === 'en' ? '&lang=en' : '';
      global.location.href = '../task-detail/index.html?taskId=' + encodeURIComponent(task.id) + suffix;
      return;
    }
    var mapped = action === 'retry' ? 'retry' : action === 'folder' ? 'open-folder' : 'cancel';
    call('TASK_ACTION', { taskId: task.id, action: mapped }).then(function (result) {
      var problem = actionCode(result);
      if (problem !== null) notify(t('queue.notify.actionFailed', { action: mapped, reason: problem }));
      else notify(t('queue.notify.actionDone', { action: mapped }));
      refresh();
    });
  }

  var enqueueing = false;

  /** D-83：把界面上选好的类型/清晰度一起交给主进程。 */
  function downloadPayload(url) {
    var payload = { url: url, kind: choice.kind };
    if (choice.kind === 'audio') {
      payload.audioQuality = choice.audioQuality;
      payload.audioFormat = choice.audioFormat;
    } else {
      payload.quality = choice.videoQuality;
    }
    return payload;
  }

  function startRealDownload(url) {
    if (enqueueing) return;
    if (!/^https?:\/\//i.test(url)) {
      notify(t('queue.notify.invalidUrl'));
      return;
    }
    enqueueing = true;
    notify(t('queue.notify.enqueuing'));
    call('DOWNLOAD_START', downloadPayload(url)).then(function (result) {
      enqueueing = false;
      if (!result || result.accepted !== true || result.enqueued !== true) {
        notify(t('queue.notify.enqueueFailed', {
          reason: (result && (result.reason || result.message)) || t('queue.notify.ipc')
        }));
        return;
      }
      var field = doc.getElementById('queue-url');
      if (field !== null) field.value = '';
      notify(t('queue.notify.enqueued', { n: Array.isArray(result.taskIds) ? result.taskIds.length : 0 }));
      refresh();
    });
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
      // D-76: match what the queue can actually do. `TaskQueue.cancel()` drops a
      // pending (Queued) task and kills a Running one; during FetchingInfo /
      // ReadyWithInfo there is no cancellable handle, so offering the button
      // would only produce a refusal.
      return {
        cancel: task.state === 'Running' || task.state === 'Queued',
        retry: retryable,
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

  function card(task) {
    var node = el('article', 'card');
    node.setAttribute('data-task-id', task.id);
    node.setAttribute('data-state', task.state);
    node.setAttribute('data-tab', tabOf(task.state));
    node.setAttribute('data-selected', model.selected[task.id] === true ? 'true' : 'false');

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

    node.appendChild(el('div', 'thumb', String(task.title || '?').slice(0, 1).toUpperCase()));

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
    main.appendChild(meta);

    if (task.state === 'Running' || task.state === 'Canceled' || task.state === 'Error') {
      var bar = el('div', 'bar');
      var fill = el('i');
      fill.style.width = Math.max(0, Math.min(100, Number(task.percent) || 0)) + '%';
      bar.appendChild(fill);
      bar.setAttribute('data-percent', String(task.percent));
      main.appendChild(bar);
      var progress = el('div', 'card-meta');
      progress.setAttribute('data-progress', String(task.percent));
      progress.textContent = task.state === 'Running' && task.speed > 0
        ? t('queue.card.progress', {
          percent: task.percent,
          speed: shell() ? shell().formatSpeed(task.speed) : String(task.speed),
          eta: shell() ? shell().formatEta(task.eta) : String(task.eta)
        })
        : t('queue.card.progress.plain', { percent: task.percent });
      main.appendChild(progress);
    } else if (task.state === 'Completed') {
      main.appendChild(el('div', 'card-meta', t('queue.card.progress.plain', { percent: 100 })));
    } else if (task.state === 'ReadyWithInfo') {
      main.appendChild(el('div', 'card-meta', t('queue.card.ready')));
    } else {
      main.appendChild(el('div', 'card-meta', t('queue.card.queued')));
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
    var showEmpty = !errorMode && visible.length === 0;
    setHidden(empty, !showEmpty);
    setHidden(error, !showError);
    setHidden(cardsHost, showError || showEmpty);
    if (showEmpty) setEmptyVariant(list.length === 0 ? 'empty' : 'filter');
    if (showError) {
      root.setAttribute('data-state', 'error');
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
    return { list: list, visible: visible, counts: perTab };
  }

  function selectTab(tab) {
    if (TABS.indexOf(tab) === -1) return;
    model.tab = tab;
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

  // ---- D-86: full-screen toggle (HTML Fullscreen API, no IPC needed) ------
  function paintFullscreenButton() {
    var button = doc.getElementById('queue-fullscreen');
    if (button === null) return;
    button.removeAttribute('data-i18n');
    var active = Boolean(doc.fullscreenElement || doc.webkitFullscreenElement);
    button.textContent = '⛶ ' + t(active ? 'queue.fullscreen.exit' : 'queue.fullscreen.enter');
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.setAttribute('data-fullscreen', active ? 'true' : 'false');
  }

  function installFullscreen() {
    var button = doc.getElementById('queue-fullscreen');
    paintFullscreenButton();
    if (button !== null) {
      button.addEventListener('click', function () {
        var active = Boolean(doc.fullscreenElement || doc.webkitFullscreenElement);
        try {
          if (active) {
            if (doc.exitFullscreen) doc.exitFullscreen();
            else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
          } else {
            var root = doc.documentElement;
            if (root.requestFullscreen) root.requestFullscreen();
            else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
          }
        } catch (error) { /* browser refused: leave the layout as-is */ }
        paintFullscreenButton();
      });
    }
    doc.addEventListener('fullscreenchange', paintFullscreenButton);
    doc.addEventListener('webkitfullscreenchange', paintFullscreenButton);
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

  function openModal(mode, ids) {
    pending.mode = mode;
    pending.ids = ids.slice();
    var filesButton = doc.getElementById('queue-modal-files');
    var historyButton = doc.getElementById('queue-modal-history');
    var note = doc.getElementById('queue-modal-note');
    if (mode === 'clear') {
      setModalText('queue-modal-title', t('queue.clear.title'));
      setModalText('queue-modal-message', t('queue.clear.message'));
      setModalText('queue-modal-count', t('queue.delete.count', { n: ids.length }));
      setModalText('queue-modal-note', t('queue.tools.privateHint'));
      if (historyButton !== null) {
        historyButton.removeAttribute('data-i18n');
        historyButton.textContent = t('queue.clear.confirm');
      }
      setHidden(filesButton, true);
      setHidden(note, false);
    } else {
      setModalText('queue-modal-title', t('queue.delete.title'));
      setModalText('queue-modal-message', t('queue.delete.message'));
      setModalText('queue-modal-count', t('queue.delete.count', { n: ids.length }));
      setModalText('queue-modal-note', t('queue.delete.filesHint'));
      if (historyButton !== null) {
        historyButton.removeAttribute('data-i18n');
        historyButton.textContent = t('queue.delete.onlyHistory');
      }
      setHidden(filesButton, false);
      setHidden(note, false);
    }
    var backdrop = doc.getElementById('queue-modal');
    setHidden(backdrop, false);
  }

  function closeModal() {
    setHidden(doc.getElementById('queue-modal'), true);
    pending.ids = [];
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
    var chain = Promise.resolve();
    ids.forEach(function (id) {
      chain = chain.then(function () {
        var payload = { taskId: id, action: 'remove' };
        if (withFiles) payload.withFiles = true;
        return call('TASK_ACTION', payload).then(function (result) {
          if (result && result.ok !== false) done += 1;
          else failed += 1;
        });
      });
    });
    chain.then(function () {
      pending.ids.forEach(function (id) { delete model.selected[id]; });
      closeModal();
      if (failed > 0) notify(t('queue.status.failed', { reason: failed + ' / ' + ids.length }));
      else if (withFiles) notify(t('queue.status.filesRemoved', { n: done }));
      else if (pending.mode === 'clear') notify(t('queue.status.cleared'));
      else notify(t('queue.status.removed', { n: done }));
      pending.mode = 'delete';
      refresh();
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
    var history = doc.getElementById('queue-modal-history');
    if (history !== null) history.addEventListener('click', function () { performRemoval(pending.ids, false); });
    var files = doc.getElementById('queue-modal-files');
    if (files !== null) files.addEventListener('click', function () { performRemoval(pending.ids, true); });

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
  model.tab = TABS.indexOf(param('tab', 'all')) === -1 ? 'all' : param('tab', 'all');
  // `?kind=audio` starts on the audio tab (e2e case + deep-link friendly).
  setKind(param('kind', 'video') === 'audio' ? 'audio' : 'video');
  installLanguageSwitch();
  installFullscreen();
  installTaskManagement();
  var result = render();
  if (live.active) {
    refresh();
    setInterval(function () {
      if (doc.visibilityState === 'hidden') return;
      refresh();
    }, 1200);
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
    model: model
  };
})(typeof window === 'undefined' ? this : window);
