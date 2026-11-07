/**
 * queue.js — download queue page (M5-3, A-4.4-16).
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

  function t(key, params) {
    return global.YTVDLT && global.YTVDLT.shell ? global.YTVDLT.shell.t(key, params) : key;
  }
  function shell() { return global.YTVDLT && global.YTVDLT.shell ? global.YTVDLT.shell : null; }

  function param(name, fallback) {
    var match = new RegExp('[?&]' + name + '=([^&]*)').exec(global.location ? global.location.search : '');
    return match === null ? fallback : decodeURIComponent(match[1]);
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
    TASK_ACTION: 'ytvdlt:task:action',
    DOWNLOAD_START: 'ytvdlt:download:start'
  };

  /** Thin wrapper over the preload surface: `{ok:false, code, message}` on failure
   *  instead of a rejected promise, so every caller has one shape to handle. */
  function call(channel, payload) {
    var bridge = taskBridge();
    if (bridge === null) return Promise.resolve({ ok: false, code: 'BRIDGE_UNAVAILABLE', message: '桥接不可用' });
    try {
      return Promise.resolve(bridge.invoke(CHANNELS[channel] || channel, payload || {})).catch(function (error) {
        return { ok: false, code: 'IPC_ERROR', message: String(error && error.message ? error.message : error) };
      });
    } catch (error) {
      return Promise.resolve({ ok: false, code: 'IPC_ERROR', message: String(error) });
    }
  }

  /** Visible status line, created only in live mode. The hidden `<pre>` is a
   *  debug surface at the bottom of a tall page — a user clicking a button in
   *  the toolbar never sees it, which is why "nothing happened". */
  var statusNode = null;

  function ensureStatus() {
    if (statusNode !== null) return statusNode;
    var form = doc.getElementById('queue-paste-form');
    if (form === null || form.parentNode === null || form.parentNode.parentNode === null) return null;
    statusNode = doc.createElement('p');
    statusNode.id = 'queue-status';
    statusNode.className = 'hint';
    statusNode.setAttribute('role', 'status');
    statusNode.setAttribute('aria-live', 'polite');
    statusNode.setAttribute('hidden', 'true');
    var actions = form.parentNode;
    actions.parentNode.insertBefore(statusNode, actions.nextSibling);
    return statusNode;
  }

  /** Human-readable status line. Only used in live mode; the fixture path keeps
   *  emitting the JSON contract that the e2e baselines capture. */
  function notify(text) {
    var output = doc.getElementById('ytvdlt-output');
    if (output !== null) {
      setHidden(output, false);
      output.textContent = String(text);
      output.setAttribute('data-last-action', 'live');
    }
    var status = ensureStatus();
    if (status !== null) {
      status.textContent = String(text);
      status.setAttribute('hidden', 'false');
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
    if (!result) return '主进程没有返回结果';
    if (result.ok === true) return null;
    return result.message || result.code || '操作被拒绝';
  }

  /** Real execution in live mode; the JSON contract otherwise. */
  function act(action, task) {
    if (!live.active) { emit(action, task); return; }
    if (action === 'detail') {
      global.location.href = '../task-detail/index.html?taskId=' + encodeURIComponent(task.id);
      return;
    }
    var mapped = action === 'retry' ? 'retry' : action === 'folder' ? 'open-folder' : 'cancel';
    call('TASK_ACTION', { taskId: task.id, action: mapped }).then(function (result) {
      var problem = actionCode(result);
      if (problem !== null) notify('「' + mapped + '」未执行：' + problem);
      else notify('已执行：' + mapped);
      refresh();
    });
  }

  var enqueueing = false;

  function startRealDownload(url) {
    if (enqueueing) return;
    if (!/^https?:\/\//i.test(url)) {
      notify('请先粘贴 http(s) 链接');
      return;
    }
    enqueueing = true;
    notify('正在加入队列…');
    call('DOWNLOAD_START', { url: url, kind: 'video' }).then(function (result) {
      enqueueing = false;
      if (!result || result.accepted !== true || result.enqueued !== true) {
        notify('未能加入队列：' + ((result && (result.reason || result.message)) || '主进程未接受该链接'));
        return;
      }
      var field = doc.getElementById('queue-url');
      if (field !== null) field.value = '';
      notify('已加入队列：' + (Array.isArray(result.taskIds) ? result.taskIds.length : 0) + ' 个任务，开始下载');
      refresh();
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
        detail: true
      };
    }
    return {
      cancel: running || task.state === 'ReadyWithInfo',
      retry: retryable,
      folder: task.state === 'Completed',
      detail: true
    };
  }

  function card(task) {
    var node = el('article', 'card');
    node.setAttribute('data-task-id', task.id);
    node.setAttribute('data-state', task.state);
    node.setAttribute('data-tab', tabOf(task.state));

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
      button.addEventListener('click', function () { act(action, task); });
      foot.appendChild(button);
    };
    addButton('cancel', 'queue.action.cancel');
    addButton('retry', 'queue.action.retry');
    addButton('folder', 'queue.action.open-folder');
    foot.appendChild(el('span', 'spacer'));
    addButton('detail', 'queue.action.detail');
    main.appendChild(foot);

    node.appendChild(main);
    return node;
  }

  var model = { tab: TABS.indexOf(param('tab', 'all')) === -1 ? 'all' : param('tab', 'all'), query: '' };

  function emit(action, task, value) {
    var output = doc.getElementById('ytvdlt-output');
    if (output === null) return;
    setHidden(output, false);
    output.textContent = JSON.stringify({
      action: action,
      taskId: task ? task.id : null,
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

  function render() {
    var list = tasks();
    var root = doc.getElementById('queue-root');
    var cardsHost = doc.getElementById('queue-cards');
    var visible = filterTasks(list, model.tab, model.query);
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
    return { list: list, visible: visible, counts: perTab };
  }

  function selectTab(tab) {
    if (TABS.indexOf(tab) === -1) return;
    model.tab = tab;
    render();
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
      notify('把链接粘到上方输入框，再点「粘贴并解析」或按回车');
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
      notify('把链接粘到上方输入框，再点「粘贴并解析」或按回车');
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
    snapshot: result
  };
})(typeof window === 'undefined' ? this : window);
