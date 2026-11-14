/**
 * D-187 · shell 家族真实行为单测 —— app-nav / ipc-bridge / app-version / app-shell。
 *
 * 【import 路线】与 ui-queue-page / ui-settings-page 一致：共享装载架
 * helpers/ui-harness.ts 真实 `import()` 源码，让 v8 覆盖率提供器看见全部语句；
 * 不走 runInNewContext 沙箱（那里覆盖率统计不到）。
 *
 * 【共享架】本文件 beforeAll 假定时器 + installUiGlobals + 按冒烟测试的页面
 * 脚本顺序装载依赖模块（i18n → theme → app-version → app-nav → ipc-bridge →
 * shortcuts → app-shell），全部模块对着同一个假 window 启动一次；afterAll 恢复。
 *
 * 【单实例编排】ESM 注册表按测试文件缓存，app-version 在 import 时刻读取
 * `?v=` 首帧提示且 refresh 只问一次主进程；因此用两种手法构造场景：
 *  - 引导期把 `ytvdlt:app:info` 的应答扣住（可编程桥），先断言首帧 hint，
 *    再由专属用例放行应答，观察「IPC 权威覆盖 hint」（D-114）；
 *  - 其余 app-version 场景用 `vi.resetModules()` + 改 location.search 后重新
 *    import shell/app-version.js，拿到全新实例（`?v=` 解析、usable 边界、
 *    应答拒绝重问、v— 兜底各占一个新引导）。
 * app-nav 的页面变体（settings / other / i18n 缺席回退）同样用 resetModules
 * 重装，放在文件最后，避免干扰前面的导航条引导断言。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@ytvdlt/shared';
import { installUiGlobals, loadUiModule, uiNode, type UiGlobals, type UiNode } from './helpers/ui-harness.js';

// ---------------------------------------------------------------------------
// 可编程应答桥：每个 IPC 调用登记在 harness 的 bridgeCalls 里，应答数据由
// `reply` 现场决定（app:info 引导期扣住，其余默认空对象）。
// ---------------------------------------------------------------------------
let reply: (channel: string, payload?: any) => unknown = () => ({});
let releaseAppInfo: (value: unknown) => void = () => {};

let globals: UiGlobals | null = null;
let navRef: any = null; // window.YTVDLTNav
let shellRef: any = null; // window.YTVDLT.shell

const win = () => globals!.window as Record<string, any>;
const doc = () => globals!.document as any;
const node = (id: string): UiNode => globals!.nodes.get(id) as UiNode;
const callsTo = (channel: string) => globals!.bridgeCalls.filter((c) => c.channel === channel);
const flush = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};

// harness 的 document.addEventListener 是空转 noop（注释明说由测试自行跟踪）；
// 这里在装载任何模块之前替换成「记录 + 手工派发」，纯测试侧替换。
let docListeners: Record<string, Array<(event?: unknown) => void>> = {};
const docFire = (type: string, event?: unknown): void => {
  for (const fn of docListeners[type] ?? []) fn(event);
};

/** app-version 变体场景：换 search + 应答 → resetModules → 重装新实例。
 *  应答可以是值，也可以是「调用时才构造」的函数（懒构造拒绝 Promise，
 *  避免 eager Promise.reject 产生 unhandled rejection）。 */
async function reloadAppVersion(search: string, appInfoAnswer: unknown): Promise<any> {
  reply = (channel) => (channel === 'ytvdlt:app:info'
    ? (typeof appInfoAnswer === 'function' ? (appInfoAnswer as () => unknown)() : appInfoAnswer)
    : {});
  win().location.search = search;
  vi.resetModules();
  await loadUiModule('shell/app-version.js', globals!);
  await flush();
  return win().YTVDLTAppVersion;
}

function deepFind(root: UiNode, predicate: (n: UiNode) => boolean): UiNode | null {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const hit = deepFind(child, predicate);
    if (hit !== null) return hit;
  }
  return null;
}

beforeAll(async () => {
  vi.useFakeTimers();
  // app-nav 会把 legacy 头部全屏按钮一起画（bindFullscreenButton('queue-fullscreen')）。
  const legacyFullscreen = uiNode('button');
  globals = installUiGlobals({
    bridge: { invoke: (channel: string, payload?: unknown) => reply(channel, payload) },
    elements: { 'queue-fullscreen': legacyFullscreen },
    location: {
      href: 'file:///C:/app/pages/queue/index.html?v=9.8.7-hint',
      search: '?v=9.8.7-hint',
      protocol: 'file:',
    },
    extraWindow: {
      URLSearchParams: globalThis.URLSearchParams,
      // prefill(submit:true) 用 `new global.Event(...)`：给一个最小 Event 桩。
      Event: class FakeEvent { type: string; constructor(type: string) { this.type = type; } },
      // harness 默认 matchMedia 没有 removeEventListener，theme.watch 的 dispose
      // 会炸；换一个完整的（真实浏览器两者都有）。
      matchMedia: () => ({
        matches: false,
        addEventListener() { /* 由 watch 注册，dispose 时成对移除 */ },
        removeEventListener() { /* noop */ },
        addListener() { /* 旧 API noop */ },
        removeListener() { /* noop */ },
      }),
      // 真浏览器 window 自带 setTimeout；restoreView 滚动恢复等走 global.setTimeout。
      setTimeout: (...args: unknown[]) => (globalThis as any).setTimeout(...(args as any[])),
      clearTimeout: (handle: unknown) => (globalThis as any).clearTimeout(handle as any),
    },
  });
  // currentPage() 读 location.pathname；harness 的 location 是普通对象，补上。
  win().location.pathname = '/app/pages/queue/index.html';
  // 引导期扣住 app:info 的应答：先断言 ?v= 首帧，再由专属用例放行（D-114）。
  reply = (channel) => (channel === 'ytvdlt:app:info'
    ? new Promise((resolve) => { releaseAppInfo = resolve; })
    : {});
  // 文档级监听记录（Escape / fullscreenchange 由专属用例手工派发）。
  docListeners = {};
  doc().addEventListener = (type: string, fn: (event?: unknown) => void) => { (docListeners[type] ??= []).push(fn); };
  doc().removeEventListener = (type: string, fn: (event?: unknown) => void) => {
    const bucket = docListeners[type] ?? [];
    const at = bucket.indexOf(fn);
    if (at >= 0) bucket.splice(at, 1);
  };
  // 真实 DOM 的 `el.id = 'x'` 会写 id 属性、getElementById 能找到；harness 的
  // 节点只在按需注册表里。补两条纯测试侧桥接（同 settings 测试改写
  // querySelector 的先例）：① createElement 出的节点让 .id 赋值同步 attrs；
  // ② getElementById 未命中注册表时先在已注册节点树上按 id 属性找。
  const rawCreateElement = doc().createElement.bind(doc());
  doc().createElement = (tag?: string) => {
    const el = rawCreateElement(tag) as any;
    let idValue = '';
    Object.defineProperty(el, 'id', {
      configurable: true,
      get: () => idValue,
      set(next: string) { idValue = String(next); if (next) el.setAttribute('id', String(next)); },
    });
    return el;
  };
  const rawGetElementById = doc().getElementById.bind(doc());
  doc().getElementById = (id: string) => {
    const known = globals!.nodes.get(id);
    if (known !== undefined) return known;
    for (const root of globals!.nodes.values()) {
      const hit = deepFind(root, (n) => n.attrs['id'] === id || (n as unknown as { id?: string }).id === id);
      if (hit !== null) { globals!.nodes.set(id, hit); return hit; }
    }
    return rawGetElementById(id);
  };
  // prefill(submit:true) 需要 form 有 dispatchEvent；harness 节点没有，补上。
  const form = doc().getElementById('queue-paste-form');
  (form as any).dispatchEvent = (event: any) => form.dispatch(event.type, event);

  // 页面脚本顺序装载（与 index.html 的队列页前缀一致）。
  await loadUiModule('i18n/messages.js', globals);
  await loadUiModule('i18n/i18n.js', globals);
  await loadUiModule('theme/theme.js', globals);
  await loadUiModule('shell/app-version.js', globals);
  await loadUiModule('shell/app-nav.js', globals);
  await loadUiModule('ipc-bridge.js', globals);
  await loadUiModule('shortcuts/shortcuts.js', globals);
  await loadUiModule('app-shell.js', globals);
  navRef = win().YTVDLTNav;
  shellRef = win().YTVDLT.shell;
  await flush();
});

afterAll(() => {
  globals?.restore();
  globals = null;
  navRef = null;
  shellRef = null;
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 族一 · app-version（D-114）：?v= 首帧提示、IPC 权威覆盖、v— 兜底、监听器
// ---------------------------------------------------------------------------
describe('D-187 · app-version：?v= 只是首帧提示，APP_INFO 才是权威（D-114）', () => {
  it('引导首帧画 hint（source=none、settled=false），app:info 应答被扣住期间不覆盖', () => {
    const app = win().YTVDLTAppVersion;
    expect(app.version()).toBe('9.8.7-hint'); // ?v= 直接进入首帧
    expect(app.label()).toBe('v9.8.7-hint');
    expect(app.source()).toBe('none');
    expect(app.settled()).toBe(false);
    expect(node('queue-version').textContent).toBe('v9.8.7-hint');
    expect(node('settings-meta').textContent).toBe('v9.8.7-hint');
    expect(node('about-version').textContent).toBe('v9.8.7-hint');
    expect(doc().documentElement.getAttribute('data-app-version')).toBe('9.8.7-hint');
    expect(callsTo('ytvdlt:app:info')).toHaveLength(1); // 已问、应答在途
    expect(app.query()).toBe('9.8.7-hint');
  });

  it('IPC 应答落地：权威值覆盖 hint（哪怕两者不同），settled 翻真', async () => {
    releaseAppInfo({ version: '9.9.9' });
    await flush();
    const app = win().YTVDLTAppVersion;
    expect(app.version()).toBe('9.9.9');
    expect(app.label()).toBe('v9.9.9');
    expect(app.source()).toBe('ipc');
    expect(app.settled()).toBe(true);
    expect(doc().documentElement.getAttribute('data-app-version')).toBe('9.9.9');
  });

  it('asked 闩：第二次 refresh 直接短路，不再发通道', async () => {
    const before = callsTo('ytvdlt:app:info').length;
    const value = await win().YTVDLTAppVersion.refresh();
    expect(value).toBe('9.9.9');
    expect(callsTo('ytvdlt:app:info').length).toBe(before);
  });

  it('onChange：监听器收到 (version, label)，抛错不影响他人，退订生效', async () => {
    // 引导期拒绝（asked 复位）→ 手工 refresh 收到真实应答 → notify。
    const fresh = await reloadAppVersion('?v=8.8.8', () => Promise.reject(new Error('down')));
    expect(fresh.version()).toBe('8.8.8');
    const seen: Array<[string, string]> = [];
    fresh.onChange(() => { throw new Error('listener must not break the page'); }); // 抛错者
    fresh.onChange('not-a-function'); // 非函数 → 返回 noop 退订器，不入册
    fresh.onChange((v: unknown, l: unknown) => { seen.push([String(v), String(l)]); });
    reply = (channel) => (channel === 'ytvdlt:app:info' ? { version: '8.8.9' } : {});
    await fresh.refresh();
    await flush();
    expect(seen).toEqual([['8.8.9', 'v8.8.9']]);
    // 退订 + 抛错隔离：再一次 apply（fresh 实例 asked 已置位 → 换新实例重演）。
    const second = await reloadAppVersion('?v=9.0.0', () => Promise.reject(new Error('down')));
    const got: string[] = [];
    second.onChange(() => { throw new Error('listener must not break the page'); });
    const off = second.onChange((v: unknown) => { got.push(String(v)); });
    off();
    reply = (channel) => (channel === 'ytvdlt:app:info' ? { version: '9.0.1' } : {});
    await second.refresh();
    await flush();
    expect(second.version()).toBe('9.0.1');
    expect(got).toEqual([]); // 已退订 → 不再收到；抛错者被吞掉
  });

  it('拒绝保留现状 + asked 复位后重问；应答不带版本 → hint 也被丢弃（v— 兜底）', async () => {
    const app = await reloadAppVersion('?v=7.7.7', () => Promise.reject(new Error('down')));
    expect(app.version()).toBe('7.7.7'); // 拒绝 → 保留 URL hint
    expect(app.source()).toBe('none');
    expect(app.settled()).toBe(false);
    // asked 已复位 → refresh 真的重新发问。
    const before = callsTo('ytvdlt:app:info').length;
    await app.refresh();
    await flush();
    expect(callsTo('ytvdlt:app:info').length).toBe(before + 1);
    reply = (channel) => (channel === 'ytvdlt:app:info' ? { version: '' } : {});
    await app.refresh();
    await flush();
    // 主进程在但不能自证版本 → hint 一并丢弃，页面绝不显示无人担保的旧值。
    expect(app.version()).toBe('');
    expect(app.label()).toBe('v—');
    expect(node('queue-version').textContent).toBe('v—');
    expect(node('about-version').textContent).toBe('—');
    expect(app.query()).toBe('');
    expect(doc().documentElement.getAttribute('data-app-version')).toBe('');
  });

  it('usable 边界：>40 字符与控制字符都拒绝；无 hint 引导直接 v—', async () => {
    const long = await reloadAppVersion('?v=6.6.6', () => Promise.reject(new Error('x')));
    expect(long.version()).toBe('6.6.6');
    reply = (channel) => (channel === 'ytvdlt:app:info' ? { version: 'x'.repeat(41) } : {});
    await long.refresh();
    await flush();
    expect(long.version()).toBe(''); // 41 字符 → 不可用 → hint 丢弃
    const ctrl = await reloadAppVersion('?v=6.6.6', () => Promise.reject(new Error('x')));
    reply = (channel) => (channel === 'ytvdlt:app:info' ? { version: '6.6.6\n' } : {});
    await ctrl.refresh();
    await flush();
    expect(ctrl.version()).toBe(''); // 控制字符 → 不可用
    const exact = await reloadAppVersion('?v=6.6.6', () => Promise.reject(new Error('x')));
    reply = (channel) => (channel === 'ytvdlt:app:info' ? { version: 'y'.repeat(40) } : {});
    await exact.refresh();
    await flush();
    expect(exact.version()).toBe('y'.repeat(40)); // 40 字符整 → 可用
    const noHint = await reloadAppVersion('', { version: '5.5.5' });
    expect(noHint.version()).toBe('5.5.5');
    expect(noHint.label()).toBe('v5.5.5');
    const none = await reloadAppVersion('', { version: '' });
    expect(none.version()).toBe('');
    expect(none.label()).toBe('v—');
  });

  it('query() 给重建 URL 用：encodeURIComponent；无版本时返回空串', async () => {
    const app = await reloadAppVersion('?v=1.2%20a%26b', () => Promise.reject(new Error('x')));
    expect(app.version()).toBe('1.2 a&b'); // param() 解码 ?v=
    expect(app.query()).toBe('1.2%20a%26b');
  });

  it('无桥（静态预览）：refresh 立即返回现状，不发问、settled 不翻', async () => {
    const original = win().ytvdltBridge;
    delete win().ytvdltBridge;
    globals!.bridgeCalls.length = 0;
    try {
      const app = await reloadAppVersion('?v=4.4.4', { version: '4.4.5' });
      expect(callsTo('ytvdlt:app:info')).toHaveLength(0); // 无桥 → 引导期也不发问
      expect(app.version()).toBe('4.4.4');
      expect(app.settled()).toBe(false);
      await app.refresh(); // 无桥 → 直接返回，不抛
      expect(app.version()).toBe('4.4.4');
      expect(callsTo('ytvdlt:app:info')).toHaveLength(0);
    } finally {
      win().ytvdltBridge = original;
    }
  });
});

// ---------------------------------------------------------------------------
// 族二 · ipc-bridge：白名单、三表一致（与 shared 契约抽查）、payload、错误语义
// ---------------------------------------------------------------------------
describe('D-187 · ipc-bridge：通道白名单是渲染端唯一主权', () => {
  it('ALLOWED_COMMANDS 逐条放行，wire 串与 shared/src/ipc.ts 契约逐字一致（§5）', () => {
    const bridge = win().YTVDLT.bridge;
    expect(bridge.ALLOWED_COMMANDS.length).toBeGreaterThanOrEqual(28);
    // 渲染端需要的全部符号名都在册（含后续追加的 Stage5 / D-129/130/134/139/148/173）。
    for (const key of ['TASK_LIST', 'TASK_DETAIL', 'TASK_ACTION', 'DOWNLOAD_START', 'SUBTITLE_PREVIEW',
      'TXT_IMPORT_ENQUEUE', 'PLAYLIST_BATCH_ENQUEUE', 'URL_SUPPORT_CHECK', 'URL_SUPPORT_CHECK_CANCEL',
      'TEMPLATE_LIST', 'STAR_PROMPT_CHECK', 'CLIPBOARD_WRITE']) {
      expect(bridge.ALLOWED_COMMANDS, key).toContain(key);
    }
    for (const command of bridge.ALLOWED_COMMANDS) {
      globals!.bridgeCalls.length = 0;
      const result = bridge.invoke(command, { probe: command });
      expect(result, command).toBeDefined();
      const call = globals!.bridgeCalls[0];
      // 三处映射抽查：ipc-bridge 的 wire 串必须等于 shared 冻结契约。
      expect(call?.channel, command).toBe((IPC_CHANNELS as Record<string, string>)[command]);
      expect(call?.payload, command).toEqual({ probe: command });
    }
  });

  it('越界命令拒绝：command-not-allowed，桥完全不被触碰', () => {
    const bridge = win().YTVDLT.bridge;
    const before = globals!.bridgeCalls.length;
    for (const command of ['ENGINE_EVENT', 'task_list', 'PROBE ', '', 'DROP TABLE']) {
      expect(bridge.invoke(command)).toEqual({
        ok: false, reason: 'command-not-allowed', command,
      });
    }
    expect(globals!.bridgeCalls.length).toBe(before);
  });

  it('桥缺席 / invoke 非函数 → bridge-unavailable；isAvailable 同步反映', () => {
    const bridge = win().YTVDLT.bridge;
    expect(bridge.isAvailable()).toBe(true);
    const original = win().ytvdltBridge;
    delete win().ytvdltBridge;
    try {
      expect(bridge.isAvailable()).toBe(false);
      expect(bridge.invoke('PROBE', { url: 'x' })).toEqual({
        ok: false, reason: 'bridge-unavailable', command: 'PROBE',
      });
      win().ytvdltBridge = { notInvoke: 1 };
      expect(bridge.invoke('PROBE')).toEqual({
        ok: false, reason: 'bridge-unavailable', command: 'PROBE',
      });
    } finally {
      win().ytvdltBridge = original;
    }
  });

  it('桥同步抛错 → bridge-error + 归一化 message', () => {
    const bridge = win().YTVDLT.bridge;
    const original = win().ytvdltBridge;
    win().ytvdltBridge = { invoke: () => { throw new Error('boom'); } };
    try {
      expect(bridge.invoke('PROBE')).toEqual({
        ok: false, reason: 'bridge-error', command: 'PROBE', message: 'Error: boom',
      });
    } finally {
      win().ytvdltBridge = original;
    }
  });

  it('payload 原样透传；缺省 payload 归一为 {}（preload 侧零容错）', () => {
    const bridge = win().YTVDLT.bridge;
    globals!.bridgeCalls.length = 0;
    bridge.invoke('PROBE', { url: 'https://example.com/a' });
    expect(globals!.bridgeCalls[0]).toEqual({ channel: 'ytvdlt:probe', payload: { url: 'https://example.com/a' } });
    globals!.bridgeCalls.length = 0;
    bridge.invoke('STAR_PROMPT_CHECK'); // T5 契约：CHECK 不带 payload
    expect(globals!.bridgeCalls[0]?.payload).toEqual({});
  });

  it('语义助手：probe / dialog / task / download 的通道与载荷形状', () => {
    const bridge = win().YTVDLT.bridge;
    globals!.bridgeCalls.length = 0;
    expect(bridge.requestProbe('https://example.com/v').ok !== false).toBe(true);
    expect(bridge.requestProbePlaylist('https://example.com/pl'));
    expect(bridge.openDialog('format'));
    expect(bridge.confirmDialog({ confirmed: true }));
    expect(bridge.previewPath({ videoDir: 'C:/x' }));
    expect(bridge.listTasks({ tab: 'all' }));
    expect(bridge.listTasks()); // 缺省 → {}
    expect(bridge.taskDetail('t1'));
    expect(bridge.taskAction('t1', 'cancel'));
    expect(bridge.startDownload('https://example.com/d'));
    const channels = globals!.bridgeCalls.map((c) => c.channel);
    expect(channels).toEqual([
      'ytvdlt:probe', 'ytvdlt:probePlaylist', 'ytvdlt:dialog:open', 'ytvdlt:dialog:confirm',
      'ytvdlt:path:preview', 'ytvdlt:task:list', 'ytvdlt:task:list', 'ytvdlt:task:detail',
      'ytvdlt:task:action', 'ytvdlt:download:start',
    ]);
    const payloads = globals!.bridgeCalls.map((c) => c.payload);
    expect(payloads[0]).toEqual({ url: 'https://example.com/v' });
    expect(payloads[1]).toEqual({ url: 'https://example.com/pl' });
    expect(payloads[2]).toEqual({ kind: 'format' });
    expect(payloads[3]).toEqual({ confirmed: true });
    expect(payloads[4]).toEqual({ videoDir: 'C:/x' });
    expect(payloads[5]).toEqual({ tab: 'all' });
    expect(payloads[6]).toEqual({});
    expect(payloads[7]).toEqual({ taskId: 't1' });
    expect(payloads[8]).toEqual({ taskId: 't1', action: 'cancel' });
    expect(payloads[9]).toEqual({ url: 'https://example.com/d', kind: 'video' });
  });

  it('startDownload：D-83 选项白名单形状（audio / quality / 非字符串丢弃 / 非 object options）', () => {
    const bridge = win().YTVDLT.bridge;
    globals!.bridgeCalls.length = 0;
    bridge.startDownload('u', { kind: 'audio', audioQuality: '192', audioFormat: 'mp3' });
    bridge.startDownload('u', { quality: '720p' });
    bridge.startDownload('u', { quality: 42 }); // 非 string → 丢弃
    bridge.startDownload('u', { kind: 'audio', audioQuality: 192 }); // 非 string → 丢弃
    bridge.startDownload('u', 'not-an-object'); // 非对象 options → 默认 video
    const payloads = globals!.bridgeCalls.map((c) => c.payload);
    expect(payloads).toEqual([
      { url: 'u', kind: 'audio', audioQuality: '192', audioFormat: 'mp3' },
      { url: 'u', kind: 'video', quality: '720p' },
      { url: 'u', kind: 'video' },
      { url: 'u', kind: 'audio' },
      { url: 'u', kind: 'video' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 族三 · app-shell：命名空间组装、boot 生命周期与页面回调分发、prefill 管道
// ---------------------------------------------------------------------------
describe('D-187 · app-shell：YTVDLT.shell 组装与格式化助手', () => {
  it('暴露完整测试面（t / stateLabel / 四个 format 助手 / boot / prefill / prefillFromArgv）', () => {
    for (const key of ['t', 'stateLabel', 'formatDuration', 'formatBytes', 'formatSpeed', 'formatEta',
      'boot', 'prefill', 'prefillFromArgv']) {
      expect(typeof shellRef[key], key).toBe('function');
    }
    // t 走真实 i18n（zh-CN 表），文案以 messages.js 现状为准。
    expect(shellRef.t('task.state.Running')).toBe('下载中');
    expect(shellRef.t('nav.label')).toBe('页面导航');
    expect(shellRef.stateLabel('Completed')).toBe('已完成');
    expect(shellRef.stateLabel('不存在的状态')).toBe('task.state.不存在的状态'); // 缺键回退键名
  });

  it('formatDuration / formatEta：非法值一律 —；时/分/秒补零', () => {
    for (const bad of [undefined, null, 'x', NaN, Infinity, -1]) {
      expect(shellRef.formatDuration(bad as number)).toBe('—');
      expect(shellRef.formatEta(bad as number)).toBe('—');
    }
    expect(shellRef.formatDuration(0)).toBe('0:00');
    expect(shellRef.formatDuration(65)).toBe('1:05');
    expect(shellRef.formatDuration(3599.4)).toBe('59:59'); // 四舍五入
    expect(shellRef.formatDuration(3661)).toBe('1:01:01');
    expect(shellRef.formatDuration(7225)).toBe('2:00:25');
    expect(shellRef.formatEta(96)).toBe('1:36');
  });

  it('formatBytes / formatSpeed：单位阶梯与 >=100 / index=0 的零小数位', () => {
    for (const bad of [undefined, NaN, -5, Infinity]) {
      expect(shellRef.formatBytes(bad as number)).toBe('—');
      expect(shellRef.formatSpeed(bad as number)).toBe('—');
    }
    expect(shellRef.formatBytes(0)).toBe('0 B');
    expect(shellRef.formatBytes(1023)).toBe('1023 B');
    expect(shellRef.formatBytes(1024)).toBe('1.0 KB');
    expect(shellRef.formatBytes(1048576)).toBe('1.0 MB');
    expect(shellRef.formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(shellRef.formatBytes(3 * 1024 ** 4)).toBe('3.0 TB');
    expect(shellRef.formatBytes(3 * 1024 ** 5)).toBe('3072 TB'); // 阶梯封顶（≥100 → 零小数位）
    expect(shellRef.formatSpeed(4_200_000)).toBe('4.0 MB/s');
    expect(shellRef.formatSpeed(0)).toBe('—'); // 速度为 0 不是有效读数
  });

  it('boot：theme 先行（apply 快照返回），页面回调逐个 shortcuts.on 分发，dispose 全链路', () => {
    const recorded: Record<string, unknown> = {};
    let disposeCalls = 0;
    const realShortcuts = win().YTVDLT.shortcuts;
    win().YTVDLT.shortcuts = {
      on(id: string, fn: unknown) { recorded[id] = fn; },
      install() { return () => { disposeCalls += 1; }; },
    };
    const paste = () => undefined;
    try {
      const result = shellRef.boot({ paste, 'new-download': paste });
      expect(Object.keys(recorded).sort()).toEqual(['new-download', 'paste']); // 每个 id 一条回调
      expect(recorded.paste).toBe(paste);
      expect(result.theme).toEqual({ theme: 'light', accent: 'blue', accentKind: 'preset', motion: 'full' });
      result.dispose();
      expect(disposeCalls).toBe(1); // shortcuts 的 dispose 被调用
      // handlers 非对象 → 空 map，不注册任何回调
      const empty = shellRef.boot(null);
      empty.dispose();
      expect(Object.keys(recorded).sort()).toEqual(['new-download', 'paste']);
    } finally {
      win().YTVDLT.shortcuts = realShortcuts;
    }
  });

  it('boot：theme 协作者缺席 → theme=null，shortcuts 照常接线', () => {
    const realTheme = win().YTVDLTTheme;
    delete win().YTVDLTTheme;
    try {
      const result = shellRef.boot({});
      expect(result.theme).toBeNull();
      expect(typeof result.dispose).toBe('function');
      result.dispose(); // offSystem / offStorage 是 noop，不抛
    } finally {
      win().YTVDLTTheme = realTheme;
    }
  });

  it('boot：真实 theme + 真实 shortcuts 整链——sync 拉权威快照并落到 <html>', async () => {
    reply = (channel) => (channel === 'ytvdlt:settings:get'
      ? { theme: 'dark', accent: 'teal', motion: 'reduced', systemAccent: null }
      : {});
    const root = doc().documentElement;
    const result = shellRef.boot({});
    // boot 的返回值是同步 apply 的结果（config.json 快照还没回来）。
    expect(result.theme).toEqual({ theme: 'light', accent: 'blue', accentKind: 'preset', motion: 'full' });
    await flush(); // theme.sync 的 GET 应答落地 → 权威快照覆盖首帧
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.getAttribute('data-motion')).toBe('reduced');
    expect(root.getAttribute('data-accent')).toBe('teal');
    result.dispose();
    // 收尾：把外观复位，别泄漏给后续用例。
    win().YTVDLTTheme.set({ theme: 'system', accent: 'system', motion: 'system' });
    await flush();
    reply = () => ({});
  });

  it('prefill：填框 + data-prefilled；聚焦仅在 options 对象显式给出时；submit:true 派发表单事件', () => {
    const input = doc().getElementById('queue-url');
    const focusCalls: number[] = [];
    input.focus = () => { focusCalls.push(1); };
    const submits: unknown[] = [];
    doc().getElementById('queue-paste-form').addEventListener('submit', (e?: unknown) => { submits.push(e); });

    expect(shellRef.prefill('https://example.com/p1')).toBe(true);
    expect(input.value).toBe('https://example.com/p1');
    expect(input.getAttribute('data-prefilled')).toBe('true');
    expect(focusCalls).toHaveLength(0); // 无 options → 不碰焦点

    shellRef.prefill('https://example.com/p2', {});
    expect(focusCalls).toHaveLength(1); // options 对象 + focus 未禁用 → 聚焦

    shellRef.prefill('https://example.com/p3', { focus: false });
    expect(focusCalls).toHaveLength(1); // 截图套件要确定性：不闪光标
    expect(input.value).toBe('https://example.com/p3');

    shellRef.prefill('https://example.com/p4', { submit: true });
    expect(input.value).toBe('https://example.com/p4');
    expect(submits).toHaveLength(1); // Event 桩只带 type，页面处理器据此入队

    const originalGet = doc().getElementById;
    doc().getElementById = () => null;
    try {
      expect(shellRef.prefill('https://example.com/p5')).toBe(false); // 无粘贴框 → 显式 false
    } finally {
      doc().getElementById = originalGet;
    }
  });

  it('prefillFromArgv：--url= 两种形态都接；非 http 拒绝；shortcuts 缺席返回 null', () => {
    const input = doc().getElementById('queue-url');
    expect(shellRef.prefillFromArgv(['--url=https://example.com/deep'])).toBe('https://example.com/deep');
    expect(input.value).toBe('https://example.com/deep');
    expect(shellRef.prefillFromArgv(['--url', 'https://example.com/two'])).toBe('https://example.com/two');
    expect(shellRef.prefillFromArgv(['--url=ftp://nope'])).toBeNull();
    expect(shellRef.prefillFromArgv(['--url=ftp://nope', 'other'])).toBeNull();
    expect(shellRef.prefillFromArgv([])).toBeNull();
    expect(shellRef.prefillFromArgv('not-a-list' as unknown as string[])).toBeNull();
    const realShortcuts = win().YTVDLT.shortcuts;
    delete win().YTVDLT.shortcuts;
    try {
      expect(shellRef.prefillFromArgv(['--url=https://example.com/x'])).toBeNull();
    } finally {
      win().YTVDLT.shortcuts = realShortcuts;
    }
  });
});

// ---------------------------------------------------------------------------
// 族四 · app-nav：导航条注入、全屏权威、pageUrl、go、saveView/restoreView
// ---------------------------------------------------------------------------
describe('D-187 · app-nav：队列页导航条注入（D-106）', () => {
  it('install 把 nav 插到 host 首位；queue 页隐藏返回按钮；文案走真实 i18n', () => {
    const host = node('queue-root');
    const nav = host.children[0];
    expect(nav?.getAttribute('id')).toBe('ytvdlt-app-nav');
    expect(String((nav as any).className)).toBe('ytv-nav');
    expect(nav?.getAttribute('role')).toBe('navigation');
    expect(nav?.getAttribute('aria-label')).toBe('页面导航');
    const [back, settings] = nav!.children;
    expect(back.getAttribute('data-nav')).toBe('queue');
    expect(back.getAttribute('hidden')).toBe('true'); // 队列页不需要返回队列
    expect(back.getAttribute('data-i18n')).toBe('nav.backToQueue');
    expect(back.textContent).toBe('← 返回下载队列');
    expect(settings.getAttribute('data-nav')).toBe('settings');
    expect(settings.getAttribute('hidden')).toBeNull(); // 设置按钮可见
    const current = deepFind(nav!, (n) => String((n as any).className) === 'ytv-nav-current');
    expect(current?.textContent).toBe('下载队列');
    // 重复 install：单例闩直接拒绝。
    expect(navRef.install()).toBe(false);
  });

  it('全屏按钮双绑定：nav 权威 + legacy queue-fullscreen 同步作画', () => {
    const fs = node('ytvdlt-nav-fullscreen');
    const legacy = node('queue-fullscreen');
    for (const button of [fs, legacy]) {
      expect(button.textContent).toBe('⛶ 全屏'); // i18n queue.fullscreen.enter
      expect(button.getAttribute('aria-pressed')).toBe('false');
      expect(button.getAttribute('data-fullscreen')).toBe('false');
    }
    // 主进程推送端点（executeJavaScript 直调的别名）。
    win().YTVDLTShell.setFullscreenState(true);
    for (const button of [fs, legacy]) {
      expect(button.textContent).toBe('⛶ 退出全屏');
      expect(button.getAttribute('aria-pressed')).toBe('true');
      expect(button.getAttribute('data-fullscreen')).toBe('true');
    }
    expect(navRef.state.fullscreen).toBe(true);
    // toggleFullscreen 走 append-only 通道 ytvdlt:window:fullscreen。
    globals!.bridgeCalls.length = 0;
    void navRef.toggleFullscreen();
    expect(callsTo('ytvdlt:window:fullscreen')[0]?.payload).toEqual({ action: 'set', value: false });
  });

  it('requestFullscreen 应答语义：带 fullscreen 布尔按应答画；缺字段按请求值画；拒绝保持现状', async () => {
    const fs = node('ytvdlt-nav-fullscreen');
    globals!.bridgeCalls.length = 0;
    reply = (channel) => (channel === 'ytvdlt:window:fullscreen' ? { fullscreen: true } : {});
    await navRef.toggleFullscreen(); // 请求 false，应答 true
    await flush();
    expect(navRef.state.fullscreen).toBe(true);
    reply = (channel) => (channel === 'ytvdlt:window:fullscreen' ? {} : {});
    await navRef.toggleFullscreen(); // 请求 false，应答缺字段 → 按请求画 false
    await flush();
    expect(navRef.state.fullscreen).toBe(false);
    expect(fs.textContent).toBe('⛶ 全屏');
    reply = () => Promise.reject(new Error('down'));
    await navRef.toggleFullscreen(); // 拒绝 → 静默保持上次状态
    await flush();
    expect(navRef.state.fullscreen).toBe(false);
    reply = () => ({});
  });

  it('Escape 键：仅在全屏态拦截并退出；非全屏态不拦截', async () => {
    globals!.bridgeCalls.length = 0;
    navRef.setFullscreenState(true);
    const prevented: number[] = [];
    docFire('keydown', { key: 'a', preventDefault() { prevented.push(1); } });
    expect(callsTo('ytvdlt:window:fullscreen')).toHaveLength(0);
    docFire('keydown', { key: 'Escape', preventDefault() { prevented.push(1); } });
    expect(prevented).toHaveLength(1);
    expect(callsTo('ytvdlt:window:fullscreen').at(-1)?.payload).toEqual({ action: 'set', value: false });
    await flush(); // 空应答按请求值作画 → 回到非全屏
    expect(navRef.state.fullscreen).toBe(false);
    // 非全屏态：Escape 直接放行，不拦截也不发通道。
    const before = callsTo('ytvdlt:window:fullscreen').length;
    docFire('keydown', { key: 'Escape', preventDefault() { prevented.push(1); } });
    expect(prevented).toHaveLength(1); // preventDefault 没被再次调用
    expect(callsTo('ytvdlt:window:fullscreen').length).toBe(before);
    // 再进全屏 → Escape 再退出。
    navRef.setFullscreenState(true);
    docFire('keydown', { key: 'Escape', preventDefault() { prevented.push(1); } });
    expect(callsTo('ytvdlt:window:fullscreen').at(-1)?.payload).toEqual({ action: 'set', value: false });
    await flush();
    expect(navRef.state.fullscreen).toBe(false);
  });

  it('fullscreenchange：有桥时让位主进程；无桥时按 DOM 事实作画（HTML API 兜底）', () => {
    globals!.bridgeCalls.length = 0;
    doc().fullscreenElement = { fake: true };
    docFire('fullscreenchange');
    expect(navRef.state.fullscreen).toBe(false); // 有桥 → DOM 事件不 painting
    const original = win().ytvdltBridge;
    delete win().ytvdltBridge;
    try {
      docFire('webkitfullscreenchange');
      expect(navRef.state.fullscreen).toBe(true); // 无桥 → 按 fullscreenElement 画
      doc().fullscreenElement = undefined;
      docFire('fullscreenchange');
      expect(navRef.state.fullscreen).toBe(false);
    } finally {
      win().ytvdltBridge = original;
      doc().fullscreenElement = undefined;
    }
  });

  it('无桥 HTML API 兜底：requestFullscreen / exitFullscreen / webkit 变体逐路径', async () => {
    const original = win().ytvdltBridge;
    const root = doc().documentElement;
    const calls: string[] = [];
    delete win().ytvdltBridge;
    root.requestFullscreen = () => { calls.push('requestFullscreen'); };
    doc().exitFullscreen = () => { calls.push('exitFullscreen'); };
    try {
      // 非全屏态 toggle → 进入分支（root.requestFullscreen）。
      navRef.setFullscreenState(false);
      await navRef.toggleFullscreen();
      expect(calls).toEqual(['requestFullscreen']);
      expect(navRef.state.fullscreen).toBe(true);
      // 全屏态 toggle → 退出分支（doc.exitFullscreen；fullscreenElement 真值）。
      doc().fullscreenElement = { fake: true };
      await navRef.toggleFullscreen();
      expect(calls).toEqual(['requestFullscreen', 'exitFullscreen']);
      expect(navRef.state.fullscreen).toBe(false);
      doc().fullscreenElement = undefined;
      // webkit 变体
      delete root.requestFullscreen;
      delete doc().exitFullscreen;
      root.webkitRequestFullscreen = () => { calls.push('webkitRequestFullscreen'); };
      doc().webkitExitFullscreen = () => { calls.push('webkitExitFullscreen'); };
      doc().fullscreenElement = undefined;
      await navRef.toggleFullscreen(); // 进入分支 → webkitRequestFullscreen
      expect(navRef.state.fullscreen).toBe(true);
      doc().fullscreenElement = { fake: true };
      await navRef.toggleFullscreen(); // 退出分支 → webkitExitFullscreen
      expect(calls).toEqual(['requestFullscreen', 'exitFullscreen', 'webkitRequestFullscreen', 'webkitExitFullscreen']);
    } finally {
      win().ytvdltBridge = original;
      delete root.requestFullscreen;
      delete root.webkitRequestFullscreen;
      delete doc().exitFullscreen;
      delete doc().webkitExitFullscreen;
      doc().fullscreenElement = undefined;
    }
  });

  it('bindFullscreenButton 去重：二次绑定返回同一节点、监听器不翻倍；点击翻转请求', () => {
    const legacy = node('queue-fullscreen');
    expect(navRef.bindFullscreenButton('queue-fullscreen')).toBe(legacy);
    expect(legacy.listeners.click?.length ?? 0).toBe(1);
    globals!.bridgeCalls.length = 0;
    legacy.dispatch('click');
    expect(callsTo('ytvdlt:window:fullscreen').at(-1)?.payload).toEqual({ action: 'set', value: true });
    navRef.setFullscreenState(false);
  });
});

describe('D-187 · app-nav：pageUrl / go / saveView / restoreView（D-106 / D-114）', () => {
  afterEach(() => {
    win().location.href = 'file:///C:/app/pages/queue/index.html?v=9.9.9';
    win().location.search = '?v=9.9.9';
    delete (win().location as any).assign;
    win().sessionStorage = undefined;
    reply = () => ({});
  });

  it('pageUrl：lang/v 依序保留；?v= 缺席时从版本注册表回补（D-114 防剥落）', async () => {
    const app = await reloadAppVersion('?v=9.9.9', { version: '9.9.9' });
    expect(app.version()).toBe('9.9.9');
    win().location.href = 'file:///C:/app/pages/queue/index.html?v=9.9.9';
    win().location.search = '?v=9.9.9';
    expect(navRef.pageUrl('settings')).toBe('file:///C:/app/pages/settings/index.html?v=9.9.9');
    win().location.search = '?lang=en&v=9.9.9';
    expect(navRef.pageUrl('task-detail')).toBe('file:///C:/app/pages/task-detail/index.html?lang=en&v=9.9.9');
    // 只带 lang：v 从注册表回补。
    win().location.search = '?lang=en';
    expect(navRef.pageUrl('queue')).toBe('file:///C:/app/pages/queue/index.html?lang=en&v=9.9.9');
    // ?v= 空值：不保留也不回补（页面知道自己是被 ?v= 空过的）。
    win().location.search = '?v=';
    expect(navRef.pageUrl('settings')).toBe('file:///C:/app/pages/settings/index.html');
    // 注册表为空 → 不发明版本。
    await reloadAppVersion('?v=empty', { version: '' });
    win().location.search = '?lang=en';
    expect(navRef.pageUrl('settings')).toBe('file:///C:/app/pages/settings/index.html?lang=en');
    // URLSearchParams 缺席 → 无查询串直达。
    const usp = win().URLSearchParams;
    delete win().URLSearchParams;
    try {
      expect(navRef.pageUrl('settings')).toBe('file:///C:/app/pages/settings/index.html');
    } finally {
      win().URLSearchParams = usp;
    }
    // href 上的 hash 与无关注释参数都被剥掉。
    win().location.href = 'file:///C:/app/pages/queue/index.html?x=1#frag';
    win().location.search = '';
    expect(navRef.pageUrl('settings')).toBe('file:///C:/app/pages/settings/index.html');
  });

  it('go：先跑 onLeave 再导航；assign 优先，缺 assign 落 href；离开回调抛错不阻断', () => {
    win().location.href = 'file:///C:/app/pages/queue/index.html?v=9.9.9';
    win().location.search = '?v=9.9.9';
    const order: string[] = [];
    navRef.onLeave(() => { order.push('leave1'); });
    navRef.onLeave(() => { throw new Error('leave boom'); });
    navRef.onLeave(() => { order.push('leave2'); });
    navRef.onLeave('not-a-function'); // 非函数忽略
    const assignCalls: string[] = [];
    (win().location as any).assign = (url: string) => { assignCalls.push(url); order.push('assign'); };
    navRef.go('settings');
    expect(order).toEqual(['leave1', 'leave2', 'assign']);
    expect(assignCalls[0]).toBe('file:///C:/app/pages/settings/index.html?v=9.9.9');
    delete (win().location as any).assign;
    navRef.go('queue');
    expect(String(win().location.href)).toBe('file:///C:/app/pages/queue/index.html?v=9.9.9');
    // 导航按钮的 click 就是 go：设置按钮带参跳转。
    const nav = node('queue-root').children[0];
    const settingsButton = nav!.children[1];
    (win().location as any).assign = (url: string) => { assignCalls.push(url); };
    settingsButton.dispatch('click');
    expect(assignCalls.at(-1)).toBe('file:///C:/app/pages/settings/index.html?v=9.9.9');
  });

  it('saveView/restoreView：localStorage 兜底链路，合法对象往返', () => {
    win().sessionStorage = undefined;
    expect(navRef.saveView({ tab: 'finished', selected: ['a'] })).toBe(true);
    expect(JSON.parse(win().localStorage.getItem('ytvdlt.queue.view') as string))
      .toEqual({ tab: 'finished', selected: ['a'] });
    expect(navRef.restoreView()).toEqual({ tab: 'finished', selected: ['a'] });
    expect(navRef.saveView(null)).toBe(false);
    expect(navRef.saveView(42 as unknown as object)).toBe(false);
  });

  it('sessionStorage 是主存：有 sessionStorage 就不落 localStorage；坏 JSON / 非对象一律 null', () => {
    const sessionData = new Map<string, string>();
    win().sessionStorage = {
      getItem: (k: string) => sessionData.get(k) ?? null,
      setItem: (k: string, v: string) => { sessionData.set(k, v); },
    };
    expect(navRef.saveView({ tab: 'downloading' })).toBe(true);
    expect(sessionData.get('ytvdlt.queue.view')).toBe(JSON.stringify({ tab: 'downloading' }));
    expect(navRef.restoreView()).toEqual({ tab: 'downloading' });
    // 坏 JSON → null；JSON 非对象（字符串/数字/null）→ null。
    sessionData.set('ytvdlt.queue.view', '{oops');
    expect(navRef.restoreView()).toBeNull();
    sessionData.set('ytvdlt.queue.view', '"text"');
    expect(navRef.restoreView()).toBeNull();
    sessionData.set('ytvdlt.queue.view', 'null');
    expect(navRef.restoreView()).toBeNull();
    // 写入抛错 → saveView false（永不上抛）。
    win().sessionStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
    };
    expect(navRef.saveView({ tab: 'x' })).toBe(false);
    win().sessionStorage = undefined;
  });

  it('store 取用链：sessionStorage 读抛错 → 落 localStorage；两者都抛 → saveView false / restoreView null', () => {
    const originalSession = win().sessionStorage;
    const originalLocal = win().localStorage;
    try {
      Object.defineProperty(win(), 'sessionStorage', {
        configurable: true,
        get() { throw new Error('session denied'); },
      });
      expect(navRef.saveView({ tab: 'via-local' })).toBe(true); // 降级到 localStorage
      expect(navRef.restoreView()).toEqual({ tab: 'via-local' });
      Object.defineProperty(win(), 'localStorage', {
        configurable: true,
        get() { throw new Error('local denied'); },
      });
      expect(navRef.saveView({ tab: 'nowhere' })).toBe(false);
      expect(navRef.restoreView()).toBeNull();
    } finally {
      Object.defineProperty(win(), 'sessionStorage', { configurable: true, value: originalSession, writable: true });
      Object.defineProperty(win(), 'localStorage', { configurable: true, value: originalLocal, writable: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 族五 · app-nav 页面变体（resetModules 重装，放最后避免干扰队列页引导断言）
// ---------------------------------------------------------------------------
describe('D-187 · app-nav：settings / other 页变体与 i18n 缺席回退', () => {
  // HOST_IDS 依序命中 queue-root（最先注册的宿主），重装后的导航条仍插在
  // queue-root 里 —— 与真实 DOM 无关，只影响断言取树的入口。
  it('settings 页：设置按钮隐藏、返回按钮可见、当前页文案「设置」', async () => {
    node('queue-root').children.length = 0; // 清掉上一轮注入的 nav
    vi.resetModules();
    win().location.pathname = '/app/pages/settings/index.html';
    await loadUiModule('shell/app-nav.js', globals!);
    navRef = win().YTVDLTNav;
    const nav = node('queue-root').children[0];
    const [back, settings] = nav!.children;
    expect(back.getAttribute('hidden')).toBeNull(); // settings 页需要返回队列
    expect(settings.getAttribute('hidden')).toBe('true');
    const current = deepFind(nav!, (n) => String((n as any).className) === 'ytv-nav-current');
    expect(current?.textContent).toBe('设置');
    win().location.pathname = '/app/pages/queue/index.html';
  });

  it('other 页（task-detail 等）：双按钮都可见、当前页「任务页面」', async () => {
    node('queue-root').children.length = 0;
    vi.resetModules();
    win().location.pathname = '/app/pages/task-detail/index.html';
    await loadUiModule('shell/app-nav.js', globals!);
    navRef = win().YTVDLTNav;
    const nav = node('queue-root').children[0];
    const [back, settings] = nav!.children;
    expect(back.getAttribute('hidden')).toBeNull();
    expect(settings.getAttribute('hidden')).toBeNull();
    const current = deepFind(nav!, (n) => String((n as any).className) === 'ytv-nav-current');
    expect(current?.textContent).toBe('任务页面');
  });

  it('i18n 缺席：按 <html lang> 回退内置双语（en / zh 两条路径）', () => {
    const i18n = win().YTVDLT.i18n;
    const root = doc().documentElement;
    const fs = node('ytvdlt-nav-fullscreen');
    delete win().YTVDLT.i18n;
    try {
      root.setAttribute('lang', 'en-US');
      navRef.setFullscreenState(true);
      expect(fs.textContent).toBe('⛶ Exit full screen');
      root.setAttribute('lang', 'zh-CN');
      navRef.setFullscreenState(false);
      expect(fs.textContent).toBe('⛶ 全屏'); // 中文内置字面量
    } finally {
      win().YTVDLT.i18n = i18n;
      root.removeAttribute('lang');
      navRef.setFullscreenState(false);
    }
  });
});
