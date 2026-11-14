/**
 * D-187 · updates/update-dialog.js（「发现新版本」弹窗）真实行为单测 —— import 路线，v8 覆盖率可见。
 *
 * 【为什么是 import 而不是 runInNewContext】既有语义单测 update-dialog-cancel.test.ts
 * （取消先行 + 陈旧 download 回复丢弃）与 update-dialog-history.test.ts（D-140 版本
 * 跳转历史、轮询不重建 DOM）在 VM 沙箱里执行，v8 覆盖率统计不到；本文件用共享装载架
 * tests/unit/helpers/ui-harness.ts（installUiGlobals + 真实 `await import()`）按 import
 * 路线把这两组钉点全部保住，并补齐 D-104 缓存复用直 ready、D-141 轮询闸门、
 * skip-version / 会话抑制、act 降级与失败重试等语义。
 *
 * 【模块单例】update-dialog.js 是 IIFE：state/nodes/busy/downloadPending/cancelling/
 * actionVersion/notesKey 都是模块级状态，ESM 注册表按文件缓存、只启动一次；且
 * afterEach 安全网会在用例间兜底应答残留 IPC 并复位到隐藏基线 —— 因此每个用例都
 * 自带 __apply 前置状态，不做跨用例链式依赖（「取消先行」连续流收敛进单个用例）。
 *
 * 【装载顺序】桥在 import 时刻为 null → 自动 attach() 走「无桥早退」分支（不排定时
 * 器）；轮询族用例在文件最后手动 attach() 一次，用假定时器驱动 1500ms 头班与
 * 800ms/4000ms 节流（先「烧掉」按旧相位排的一班，再量新相位的间隔）。文案取真实 i18n。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  installUiGlobals, loadUiModule, uiNode,
  type UiGlobals, type UiNode,
} from './helpers/ui-harness.js';

type TestNode = UiNode & { parentNode: TestNode | null };

/** 装载架节点补齐：id 访问器注册进 byId 表、textContent 聚合/清空语义、父链跟踪。 */
function makeNode(registry: Map<string, TestNode>, tag = 'div'): TestNode {
  const n = uiNode(tag) as unknown as TestNode;
  n.parentNode = null;
  let ownText = '';
  Object.defineProperty(n, 'textContent', {
    get: () => (n.children.length === 0 ? ownText : n.children.map((c) => String(c.textContent)).join('')),
    set: (value: string) => { n.children.length = 0; ownText = String(value); },
    configurable: true,
  });
  Object.defineProperty(n, 'id', {
    get: () => n.attrs['id'] ?? '',
    set: (value: string) => { n.attrs['id'] = String(value); registry.set(String(value), n); },
    configurable: true,
  });
  const appendChild = n.appendChild.bind(n);
  n.appendChild = (child: UiNode): UiNode => {
    (child as TestNode).parentNode = n;
    return appendChild(child);
  };
  const insertBefore = n.insertBefore.bind(n);
  n.insertBefore = (child: UiNode): UiNode => {
    (child as TestNode).parentNode = n;
    n.children.unshift(child as TestNode);
    return child;
  };
  const removeChild = n.removeChild.bind(n);
  n.removeChild = (child: UiNode): UiNode => {
    const at = n.children.indexOf(child as TestNode);
    if (at >= 0) n.children.splice(at, 1);
    (child as TestNode).parentNode = null;
    return child;
  };
  return n;
}

let registry: Map<string, TestNode>;

async function tick(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

// ---- 可编程假桥 -------------------------------------------------------------

const CH_STATUS = 'ytvdlt:appUpdate:status';
const CH_ACTION = 'ytvdlt:appUpdate:action';
const DISMISS_KEY = 'ytvdlt.update.dismissed';

interface Deferred {
  channel: string;
  payload: unknown;
  settled: boolean;
  settle(value: unknown): void;
  reject(error: unknown): void;
}

const pending: Deferred[] = [];
let holdAction = false;
let holdStatus = false;

const bridgeStub = {
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
    const entry: Deferred = {
      channel,
      payload,
      settled: false,
      settle(value: unknown) { if (!entry.settled) { entry.settled = true; resolve(value); } },
      reject(error: unknown) { if (!entry.settled) { entry.settled = true; reject(error); } },
    };
    pending.push(entry);
    return promise; // 一律挂起，由用例 / 安全网手工应答
  },
};

const callsOn = (channel: string) => pending.filter((p) => p.channel === channel);
/** 按登记序号放行单个挂起调用（陈旧回复 / 应答顺序场景）。 */
async function settleAt(channel: string, index: number, value: unknown, rejectIt = false): Promise<void> {
  const entry = pending.filter((p) => p.channel === channel)[index];
  if (entry === undefined) throw new Error(`no pending ${channel}[${index}]`);
  if (entry.settled) throw new Error(`${channel}[${index}] already settled`);
  if (rejectIt) entry.reject(value); else entry.settle(value);
  await tick();
}
/** 放行某通道全部挂起调用。 */
async function settleAll(channel: string, value: unknown, rejectIt = false): Promise<void> {
  for (const entry of pending) {
    if (entry.channel === channel && !entry.settled) {
      if (rejectIt) entry.reject(value); else entry.settle(value);
    }
  }
  await tick();
}

// ---- 状态夹具 ---------------------------------------------------------------

function availableState(overrides: Record<string, unknown> = {}) {
  return {
    phase: 'available',
    currentVersion: '0.2.8',
    latest: { version: '1.2.3', notes: 'Big release', publishedAt: '2026-11-12T05:58:56Z' },
    releaseNotes: [
      { version: '1.1.0', publishedAt: '2026-11-10T08:08:07Z', notes: 'right-click menu' },
      { version: '1.2.3', publishedAt: '2026-11-12T05:58:56Z', notes: 'Big release' },
    ],
    omittedReleaseNotes: 0,
    downloadedBytes: 0,
    totalBytes: null,
    skippedVersion: null,
    canAutoInstall: true,
    ...overrides,
  };
}
const downloadingState = (done: number, total: number | null) => availableState({
  phase: 'downloading', downloadedBytes: done, totalBytes: total,
});

// ---- 装载 -------------------------------------------------------------------

let globals: UiGlobals | null = null;
let updateDialog: { attach(): void; __apply(state: unknown): void } | null = null;
let T: (key: string, params?: Record<string, unknown>) => string;
const session = new Map<string, string>();

beforeAll(async () => {
  vi.useFakeTimers();
  globals = installUiGlobals({
    bridge: null, // import 时刻无桥 → 自动 attach 走早退分支，轮询由轮询族用例手动武装
    extraWindow: {
      setTimeout: (...args: unknown[]) => (globalThis as any).setTimeout(...args),
      clearTimeout: (handle: unknown) => (globalThis as any).clearTimeout(handle),
      sessionStorage: {
        getItem: (key: string) => session.get(key) ?? null,
        setItem: (key: string, value: string) => { session.set(key, String(value)); },
        removeItem: (key: string) => { session.delete(key); },
        clear: () => session.clear(),
      },
    },
  });
  // createElement 钩子：id 注册 + textContent 聚合语义（paintNotes 依赖 `''` 清空重绘）
  registry = new Map<string, TestNode>();
  const doc = globals.document as any;
  doc.createElement = (tag?: string): TestNode => makeNode(registry, tag ?? 'div');

  await loadUiModule('i18n/messages.js', globals);
  await loadUiModule('i18n/i18n.js', globals);
  await loadUiModule('updates/update-dialog.js', globals);
  const win = globals.window as any;
  updateDialog = win.YTVDLTUpdateDialog;
  T = (key, params) => String(win.YTVDLT.i18n.t(key, params));
  win.ytvdltBridge = bridgeStub; // 此后 attach()/poll()/act() 都能拿到桥
});

afterAll(() => {
  globals?.restore();
  globals = null;
  vi.useRealTimers();
});

afterEach(async () => {
  // 安全网：兜底应答残留 IPC（action → 空对象；status → idle + latest null），
  // 防止轮询循环 / 动作门闩 / 下载在途标记泄漏到下一个用例。
  for (let round = 0; round < 5; round += 1) {
    const leftovers = pending.filter((p) => !p.settled);
    if (leftovers.length === 0) break;
    for (const entry of leftovers) {
      entry.settle(entry.channel === CH_STATUS ? { phase: 'idle', latest: null } : {});
    }
    await tick();
  }
  pending.length = 0; // 已应答的登记一并清空：callsOn/序号只反映当前用例
  const win = globals!.window as any;
  win.ytvdltBridge = bridgeStub;
  holdAction = false;
  holdStatus = false;
  globals!.document.visibilityState = 'visible';
  session.clear();
  const skip = registry.get('ytvdlt-update-skip');
  if (skip) skip.checked = false;
  updateDialog!.__apply({ phase: 'idle', latest: null }); // 复位到隐藏基线
  await tick();
});

// ---- 节点寻址 ---------------------------------------------------------------

const byId = (id: string): TestNode | null => registry.get(id) ?? null;
const backdrop = (): TestNode | null => byId('ytvdlt-update');
const primary = (): TestNode => byId('ytvdlt-update-primary') as TestNode;
const pageBtn = (): TestNode => byId('ytvdlt-update-page') as TestNode;
const laterBtn = (): TestNode => byId('ytvdlt-update-later') as TestNode;
const skipBox = (): TestNode => byId('ytvdlt-update-skip') as TestNode;
const sub = (): TestNode => byId('ytvdlt-update-sub') as TestNode;
const notesBox = (): TestNode => byId('ytvdlt-update-notes') as TestNode;
const notesTitle = (): TestNode => byId('ytvdlt-update-notes-title') as TestNode;
const progressBar = (): TestNode => byId('ytvdlt-update-bar') as TestNode;
const progressText = (): TestNode => byId('ytvdlt-update-progress-text') as TestNode;
const progressShell = (): TestNode => byId('ytvdlt-update-progress') as TestNode;
const hint = (): TestNode => byId('ytvdlt-update-hint') as TestNode;
const visible = (): boolean => {
  const bd = backdrop();
  return bd !== null && bd.getAttribute('hidden') === 'false';
};

// ---------------------------------------------------------------------------

describe('D-187 · update-dialog 装载面', () => {
  it('真实 import 后暴露 attach / __apply；import 时刻无桥 → 自动 attach 早退、零定时器', () => {
    expect(updateDialog).toBeTruthy();
    expect(typeof updateDialog!.attach).toBe('function');
    expect(typeof updateDialog!.__apply).toBe('function');
    // 启动期 attach() 在桥缺失时直接返回：没有排任何轮询定时器
    expect(vi.getTimerCount()).toBe(0);
    // 手动再调一次仍是无桥空操作（临时拔桥验证守卫）
    const win = globals!.window as any;
    const real = win.ytvdltBridge;
    delete win.ytvdltBridge;
    updateDialog!.attach();
    expect(vi.getTimerCount()).toBe(0);
    win.ytvdltBridge = real;
  });

  it('对话框未打开前节点不存在；__apply(null/非对象/缺 latest 形状) 是安全早退', () => {
    expect(backdrop()).toBeNull();
    expect(() => updateDialog!.__apply(null)).not.toThrow();
    expect(() => updateDialog!.__apply('not-an-object')).not.toThrow();
    // D-190: `latest === null` 漏判 undefined。apply({}) 曾在轮询的 promise
    // 里抛 TypeError（latest.version），界面静默冻结且无任何可见错误。
    expect(() => updateDialog!.__apply({})).not.toThrow();
    expect(() => updateDialog!.__apply({ phase: 'available' })).not.toThrow();
    expect(() => updateDialog!.__apply({ phase: 'available', latest: 'bad-shape' })).not.toThrow();
    expect(backdrop()).toBeNull();
  });
});

describe('D-187 · available 首绘与 D-140 版本跳转历史', () => {
  it('首绘：对话框可见、副标题/历史块按旧→新排列、日期外显、进度区隐藏', () => {
    updateDialog!.__apply(availableState());
    expect(visible()).toBe(true);
    expect(backdrop()!.getAttribute('role')).toBe('dialog');
    expect(backdrop()!.getAttribute('aria-modal')).toBe('true');
    expect(backdrop()!.style.display).toBe('flex');
    expect(sub().textContent).toBe(T('update.subtitle.jump', {
      version: '1.2.3', current: '0.2.8', skipped: 1,
    }));
    expect(notesTitle().textContent).toBe(T('update.notes.range', {
      from: '1.1.0', to: '1.2.3', count: 2,
    }));
    const blocks = notesBox()!.children;
    expect(blocks).toHaveLength(2);
    const head0 = blocks[0].children[0];
    expect(head0.children[0].textContent).toBe('v1.1.0');
    expect(head0.children[1].textContent).toBe('2026-11-10'); // isoDay 截取
    expect(head0.children[0].getAttribute('style')).toBeNull(); // 版本号 span 无内联样式
    expect(String((blocks[0].children[0] as unknown as { style: { cssText?: string } }).style.cssText ?? '')).toContain('font-weight');
    expect(String(blocks[0].textContent)).toContain('right-click menu');
    const head1 = blocks[1].children[0];
    expect(head1.children[0].textContent).toBe('v1.2.3');
    expect(head1.children[1].textContent).toBe('2026-11-12');
    expect(String(blocks[1].textContent)).toContain('Big release');
    // available 且 canAutoInstall：主按钮「下载并安装」可用，提示为空
    expect(primary().textContent).toBe(T('update.download'));
    expect(primary().disabled).toBe(false);
    expect(pageBtn().disabled).toBe(false);
    expect(skipBox().disabled).toBe(false);
    expect(progressShell().getAttribute('hidden')).toBe('true');
    expect(hint().textContent).toBe('');
  });

  it('同一状态重复轮询不重建发布说明 DOM（滚动位置纪律，D-140）', () => {
    const before = notesBox()!.children.length;
    updateDialog!.__apply(availableState());                        // 同内容
    expect(notesBox()!.children.length).toBe(before);
    updateDialog!.__apply(availableState({ downloadedBytes: 64 })); // 仅字节变化
    expect(notesBox()!.children.length).toBe(before);
    expect(backdrop()!.children).toHaveLength(1);                   // 也不重复挂 backdrop
  });

  it('主进程无历史字段 → 单版本布局（无标题行、副标题不带跳过计数）', () => {
    const legacy = availableState({ releaseNotes: undefined, currentVersion: '1.2.3' });
    delete (legacy as any).releaseNotes;
    updateDialog!.__apply(legacy);
    expect(notesTitle().textContent).toBe(T('update.notes'));
    expect(sub().textContent).toBe(T('update.subtitle', { version: '1.2.3', current: '1.2.3' }));
    const blocks = notesBox()!.children;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].children).toHaveLength(1); // 只有正文 pre，没有 heading
    expect(String(blocks[0].textContent)).toContain('Big release');
  });

  it('omittedReleaseNotes：省略行 + 跳过计数合并（blocks-1+omitted）', () => {
    updateDialog!.__apply(availableState({ omittedReleaseNotes: 3 }));
    expect(String(notesBox()!.textContent)).toContain(T('update.notes.omitted', { count: 3 }));
    expect(sub().textContent).toBe(T('update.subtitle.jump', {
      version: '1.2.3', current: '0.2.8', skipped: 4,
    }));
  });

  it('空发布说明 → 「该版本未填写发布说明」（单版本布局无标题行）', () => {
    updateDialog!.__apply(availableState({
      releaseNotes: [{ version: '1.2.3', publishedAt: '2026-11-12T05:58:56Z', notes: '' }],
    }));
    expect(notesTitle().textContent).toBe(T('update.notes'));
    const blocks = notesBox()!.children;
    expect(blocks).toHaveLength(1);
    expect(String(blocks[0].textContent)).toContain(T('update.notes.empty'));
  });

  it('publishedAt 非法 → 标题行只有版本号没有日期行', () => {
    updateDialog!.__apply(availableState({
      releaseNotes: [
        { version: '1.1.0', publishedAt: '不是日期', notes: 'a' },
        { version: '1.2.3', publishedAt: '2026-11-12T05:58:56Z', notes: 'b' },
      ],
    }));
    const blocks = notesBox()!.children;
    expect(blocks[0].children[0].children).toHaveLength(1); // 无日期 span
    expect(blocks[1].children[0].children).toHaveLength(2);
  });

  it('releaseNotes 里混入坏块 → 过滤后全部无效则回落 latest 单块', () => {
    updateDialog!.__apply(availableState({
      releaseNotes: [
        { publishedAt: '2026-11-01T00:00:00Z', notes: 'no version' },
        { version: '', notes: 'empty version' },
        null,
      ],
    }));
    const blocks = notesBox()!.children;
    expect(blocks).toHaveLength(1);
    expect(String(blocks[0].textContent)).toContain('Big release'); // latest.notes 兜底
    expect(notesTitle().textContent).toBe(T('update.notes'));
  });
});

describe('D-187 · 进度与提示矩阵（D-104 诚实呈现）', () => {
  it('downloading：百分比条与「正在下载 done / total · x%」按字节呈现', () => {
    updateDialog!.__apply(availableState()); // 先打开
    updateDialog!.__apply(downloadingState(4096, 8192));
    expect(visible()).toBe(true);
    expect(progressShell().getAttribute('hidden')).toBe('false');
    expect(progressBar().style.width).toBe('50.0%');
    expect(progressText().textContent)
      .toBe(`${T('update.downloading', { done: '4.0 KB', total: '8.0 KB' })} · 50.0%`);
    expect(primary().textContent).toBe(T('update.cancelDownload'));
  });

  it('D-104：totalBytes / downloadedBytes 为 null 时百分比恒 0.0%，缺项位「—」', () => {
    updateDialog!.__apply(availableState());
    updateDialog!.__apply(downloadingState(4096, null));
    expect(progressBar().style.width).toBe('0.0%');
    expect(progressText().textContent)
      .toBe(`${T('update.downloading', { done: '4.0 KB', total: '—' })} · 0.0%`);
    updateDialog!.__apply(downloadingState(0, 8192)); // downloadedBytes 0：真实 0%
    expect(progressText().textContent)
      .toBe(`${T('update.downloading', { done: '0 B', total: '8.0 KB' })} · 0.0%`);
  });

  it('字节格式化：0 位小数的大值 / 1 位小数的 KB / 越界字节钳到 100%', () => {
    updateDialog!.__apply(availableState());
    updateDialog!.__apply(downloadingState(0, 209715200));
    expect(progressText().textContent)
      .toBe(`${T('update.downloading', { done: '0 B', total: '200 MB' })} · 0.0%`);
    updateDialog!.__apply(downloadingState(1536, 2048));
    expect(progressText().textContent)
      .toBe(`${T('update.downloading', { done: '1.5 KB', total: '2.0 KB' })} · 75.0%`);
    updateDialog!.__apply(downloadingState(999999999, 1024));
    expect(progressBar().style.width).toBe('100.0%');
  });

  it('ready：进度区仍在、提示换「安装包已下载并校验…」、主按钮「立即安装」（D-104 缓存复用直 ready）', () => {
    updateDialog!.__apply(availableState());
    updateDialog!.__apply(availableState({
      phase: 'ready', downloadedBytes: 2621440, totalBytes: 2621440,
    }));
    expect(visible()).toBe(true);
    expect(hint().textContent).toBe(T('update.ready'));
    expect(primary().textContent).toBe(T('update.install'));
    expect(primary().disabled).toBe(false);
    expect(progressShell().getAttribute('hidden')).toBe('false');
    expect(progressText().textContent)
      .toBe(`${T('update.downloading', { done: '2.5 MB', total: '2.5 MB' })} · 100.0%`);
  });

  it('error：失败原因进提示条并染危险色；无 message 时落 —', () => {
    updateDialog!.__apply(availableState());
    updateDialog!.__apply(availableState({ phase: 'error', message: '签名不匹配' }));
    expect(hint().textContent).toBe(T('update.error', { reason: '签名不匹配' }));
    expect(String(hint().style.color)).toContain('var(--danger');
    updateDialog!.__apply(availableState({ phase: 'error' }));
    expect(hint().textContent).toBe(T('update.error', { reason: '—' }));
  });

  it('manual：无安装包 → 提示手动下载 + 主按钮禁用（发布页仍可用）', () => {
    updateDialog!.__apply(availableState({ canAutoInstall: false }));
    expect(hint().textContent).toBe(T('update.manual'));
    expect(primary().disabled).toBe(true);
    expect(pageBtn().disabled).toBe(false);
  });

  it('latest 为 null（回到 idle）→ 对话框隐藏', () => {
    updateDialog!.__apply(availableState());
    expect(visible()).toBe(true);
    updateDialog!.__apply({ phase: 'idle', latest: null });
    expect(visible()).toBe(false);
    expect(backdrop()!.style.display).toBe('none');
  });
});

describe('D-187 · 主按钮状态机：download → cancel → install 与陈旧回复丢弃', () => {
  it('download 在途：主按钮变「取消下载」且保持可点；busy 禁用发布页与跳过框', () => {
    updateDialog!.__apply(availableState());
    holdAction = true;
    primary().dispatch('click');
    expect(callsOn(CH_ACTION)).toHaveLength(1);
    expect(callsOn(CH_ACTION)[0]?.payload).toEqual({ action: 'download' });
    expect(primary().textContent).toBe(T('update.cancelDownload'));
    expect(primary().disabled).toBe(false); // 取消必须随时可点
    expect(pageBtn().disabled).toBe(true);
    expect(skipBox().disabled).toBe(true);
    expect(progressShell().getAttribute('hidden')).toBe('false'); // downloadPending 也算下载中
    expect(progressBar().style.width).toBe('0.0%');
  });

  it('取消先行连续流：cancelling 门闩 → 取消先应答复原 → 陈旧 download 回复丢弃（对齐 update-dialog-cancel）', async () => {
    updateDialog!.__apply(availableState());
    holdAction = true;
    primary().dispatch('click'); // download（挂起）
    primary().dispatch('click'); // downloadPending → cancel-download
    expect(callsOn(CH_ACTION)[1]?.payload).toEqual({ action: 'cancel-download' });
    expect(primary().textContent).toBe(T('update.cancelling'));
    expect(primary().disabled).toBe(true);
    primary().dispatch('click'); // cancelling → 守卫早退
    expect(callsOn(CH_ACTION)).toHaveLength(2);
    await settleAt(CH_ACTION, 1, { state: availableState() }); // 取消先回
    expect(primary().textContent).toBe(T('update.download')); // available 复原
    expect(pageBtn().disabled).toBe(false);
    await settleAt(CH_ACTION, 0, { state: availableState({ phase: 'ready' }) }); // 陈旧 download 后回
    expect(primary().textContent).toBe(T('update.download')); // ready 不生效（version 落后）
    expect(hint().textContent).toBe('');
  });

  it('download 正常应答 → 以回包 state 重绘进度；无 state 的回包走本地 paint', async () => {
    updateDialog!.__apply(availableState());
    holdAction = true;
    primary().dispatch('click'); // download
    await settleAt(CH_ACTION, 0, { state: downloadingState(1024, 4096) });
    expect(visible()).toBe(true);
    expect(progressBar().style.width).toBe('25.0%');
    expect(primary().textContent).toBe(T('update.cancelDownload')); // downloading 相位
    holdAction = true;
    primary().dispatch('click'); // downloading 相位 → cancel-download
    await settleAll(CH_ACTION, {}); // 无 state → paint() 分支：按当前模块状态重绘
    expect(primary().textContent).toBe(T('update.cancelDownload')); // 相位仍是 downloading
    expect(progressShell().getAttribute('hidden')).toBe('false');
  });

  it('ready 点击 → install（缓存复用免下载，D-104）；install 失败可原样重试', async () => {
    updateDialog!.__apply(availableState({
      phase: 'ready', downloadedBytes: 8192, totalBytes: 8192,
    }));
    holdAction = true;
    primary().dispatch('click');
    expect(callsOn(CH_ACTION).at(-1)?.payload).toEqual({ action: 'install' });
    expect(callsOn(CH_ACTION).some((c) => (c.payload as any)?.action === 'download')).toBe(false);
    await settleAt(CH_ACTION, 0, { ok: false, message: 'launch failed' });
    expect(hint().textContent).toBe(T('update.ready')); // paint() 保留 ready 提示
    expect(primary().disabled).toBe(false); // busy 已复位 → 可重试
    primary().dispatch('click');
    expect(callsOn(CH_ACTION).filter((c) => (c.payload as any)?.action === 'install')).toHaveLength(2);
    await settleAll(CH_ACTION, { state: availableState({ phase: 'ready' }) });
  });
});

describe('D-187 · 稍后 / 跳过版本 / 会话抑制（D-93）', () => {
  it('「稍后」：无勾选 → 仅会话抑制（写 sessionStorage）+ 立即隐藏、零 IPC', () => {
    updateDialog!.__apply(availableState());
    laterBtn().dispatch('click');
    expect(visible()).toBe(false);
    expect(session.get(DISMISS_KEY)).toBe('1.2.3');
    expect(callsOn(CH_ACTION)).toHaveLength(0);
    // 会话抑制：同版本 available 不再弹窗
    updateDialog!.__apply(availableState());
    expect(visible()).toBe(false);
    session.delete(DISMISS_KEY);
    updateDialog!.__apply(availableState());
    expect(visible()).toBe(true);
  });

  it('勾选「不再提示此版本」→ skip-version 动作；skippedVersion 只抑制该版本', async () => {
    updateDialog!.__apply(availableState());
    skipBox().checked = true;
    holdAction = true;
    laterBtn().dispatch('click');
    expect(callsOn(CH_ACTION).at(-1)?.payload).toEqual({ action: 'skip-version' });
    await settleAt(CH_ACTION, 0, { state: availableState({ skippedVersion: '1.2.3' }) });
    expect(visible()).toBe(false); // closeAfter
    session.clear();
    // 主进程每次 status 都回放持久化的 skippedVersion：同名 → 抑制；换版本 → 放行
    updateDialog!.__apply(availableState({ skippedVersion: '1.2.3' }));
    expect(visible()).toBe(false); // skippedVersion === latest.version → 跨会话抑制
    updateDialog!.__apply(availableState({
      latest: { version: '1.3.0', notes: 'next', publishedAt: '2026-11-13T00:00:00Z' },
      skippedVersion: '1.2.3',
    }));
    expect(visible()).toBe(true); // 抑制是版本限定的：新版本照常弹
  });

  it('遮罩点击：点在内容上不关；点在遮罩上等同「稍后」；勾选时转 skip-version', async () => {
    updateDialog!.__apply(availableState());
    backdrop()!.dispatch('click', { target: notesBox() }); // 内容 → 不关
    expect(visible()).toBe(true);
    backdrop()!.dispatch('click', { target: backdrop() }); // 遮罩 → 会话抑制 + 隐藏
    expect(visible()).toBe(false);
    expect(session.get(DISMISS_KEY)).toBe('1.2.3');
    session.clear();
    updateDialog!.__apply(availableState());
    skipBox().checked = true;
    holdAction = true;
    backdrop()!.dispatch('click', { target: backdrop() });
    expect(callsOn(CH_ACTION).at(-1)?.payload).toEqual({ action: 'skip-version' });
    await settleAt(CH_ACTION, 0, { state: availableState({ skippedVersion: '1.2.3' }) });
    expect(visible()).toBe(false);
  });

  it('latest 缺席：「稍后」不写会话；checking/idle 回落关闭正在读的对话框', () => {
    updateDialog!.__apply({ phase: 'idle', latest: null });
    laterBtn().dispatch('click'); // state.latest null → 不写会话
    expect(session.get(DISMISS_KEY)).toBeUndefined();
    expect(visible()).toBe(false);
    // available → checking 收敛：关闭正在读的对话框（previous.phase === 'available'）
    updateDialog!.__apply(availableState());
    expect(visible()).toBe(true);
    updateDialog!.__apply({ ...availableState(), phase: 'checking' });
    expect(visible()).toBe(false);
    updateDialog!.__apply({ ...availableState(), phase: 'idle' });
    expect(visible()).toBe(false);
  });

  it('已打开时的 available 重绘不重复挂载对话框；sessionStorage 抛错也安全', () => {
    updateDialog!.__apply(availableState());
    const bodyNode = globals!.document.body as UiNode;
    const before = bodyNode.children.length;
    updateDialog!.__apply(availableState({ downloadedBytes: 32 }));
    expect(bodyNode.children.length).toBe(before);
    // readSession/writeSession 的 try/catch：sessionStorage 抛错 → 抑制失效但页面不崩
    const win = globals!.window as any;
    const real = win.sessionStorage;
    win.sessionStorage = {
      getItem: () => { throw new Error('session broken'); },
      setItem: () => { throw new Error('session broken'); },
    };
    try {
      updateDialog!.__apply(availableState());
      expect(visible()).toBe(true);
      laterBtn().dispatch('click'); // writeSession 抛错被吞
      expect(visible()).toBe(false);
    } finally {
      win.sessionStorage = real;
    }
  });
});

describe('D-187 · act 降级与失败路径', () => {
  it('桥被拔：点击主按钮零 IPC、界面纹丝不动', () => {
    updateDialog!.__apply(availableState());
    const win = globals!.window as any;
    delete win.ytvdltBridge;
    try {
      primary().dispatch('click');
      expect(callsOn(CH_ACTION)).toHaveLength(0);
      expect(primary().textContent).toBe(T('update.download'));
    } finally {
      win.ytvdltBridge = bridgeStub;
    }
  });

  it('桥同步抛错：busy/在途标记立刻复位，按钮回到可点状态', () => {
    updateDialog!.__apply(availableState());
    const win = globals!.window as any;
    win.ytvdltBridge = { invoke: () => { throw new Error('sync boom'); } };
    primary().dispatch('click');
    expect(primary().textContent).toBe(T('update.download'));
    expect(primary().disabled).toBe(false);
    expect(pageBtn().disabled).toBe(false);
  });

  it('桥拒绝：catch 复位 + 重绘，可重试（失败重试语义）', async () => {
    updateDialog!.__apply(availableState());
    holdAction = true;
    primary().dispatch('click'); // download
    const entry = callsOn(CH_ACTION)[0];
    entry!.reject(new Error('ipc lost'));
    await tick();
    expect(primary().textContent).toBe(T('update.download'));
    expect(primary().disabled).toBe(false);
    // 重试成功 → 进入 downloading
    primary().dispatch('click');
    await settleAll(CH_ACTION, { state: downloadingState(10, 100) });
    expect(progressBar().style.width).toBe('10.0%');
  });
});

describe('D-187 · attach 轮询（D-141：1500ms 头班 + 800ms/4000ms 节流 + 可见性/取消闸门）', () => {
  it('attach 后 1500ms 头班触发一次 STATUS（载荷 {}），available 应答弹窗', async () => {
    holdStatus = true;
    updateDialog!.attach();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(1500);
    expect(callsOn(CH_STATUS)).toHaveLength(1);
    expect(callsOn(CH_STATUS)[0]?.payload).toEqual({});
    expect(visible()).toBe(false); // 应答前仍隐藏
    await settleAll(CH_STATUS, availableState());
    expect(visible()).toBe(true); // poll → apply → available 弹窗
  });

  it('安静期（available + 非 busy）节流 4s：800ms 内零轮询，第 4s 恰好一次', async () => {
    holdStatus = true;
    await vi.advanceTimersToNextTimerAsync(); // 烧掉按上一相位排的班，重排进 4s 节奏
    const c0 = callsOn(CH_STATUS).length;
    await vi.advanceTimersByTimeAsync(800);
    expect(callsOn(CH_STATUS).length).toBe(c0);
    await vi.advanceTimersByTimeAsync(3200);
    expect(callsOn(CH_STATUS).length).toBe(c0 + 1);
    await settleAll(CH_STATUS, availableState());
  });

  it('downloading 相位节流缩短到 800ms（进度条不冻结，D-141）', async () => {
    holdStatus = true;
    await vi.advanceTimersToNextTimerAsync(); // 一班挂起
    await settleAll(CH_STATUS, downloadingState(64, 1024)); // 相位 → downloading
    await vi.advanceTimersToNextTimerAsync(); // 烧掉按旧相位排的班（新班按 800ms 排）
    const c0 = callsOn(CH_STATUS).length;
    await vi.advanceTimersByTimeAsync(800);
    expect(callsOn(CH_STATUS).length).toBe(c0 + 1);
    await settleAll(CH_STATUS, downloadingState(65, 1024));
  });

  it('downloadPending 窗口（动作未应答）同样 800ms 轮询', async () => {
    holdStatus = true;
    await vi.advanceTimersToNextTimerAsync();
    await settleAll(CH_STATUS, availableState()); // 相位回 available 才能点「下载」
    holdAction = true;
    primary().dispatch('click'); // download 在途 → downloadPending
    await vi.advanceTimersToNextTimerAsync(); // 烧掉旧班（新班按 downloadPending → 800ms）
    const c0 = callsOn(CH_STATUS).length;
    await vi.advanceTimersByTimeAsync(800);
    expect(callsOn(CH_STATUS).length).toBe(c0 + 1);
    await settleAll(CH_STATUS, downloadingState(1, 2));
  });

  it('页面隐藏（visibilityState=hidden）暂停轮询但不停止节拍', async () => {
    holdStatus = true;
    globals!.document.visibilityState = 'hidden';
    await vi.advanceTimersToNextTimerAsync(); // 隐藏期间的 tick：不 poll 但重排
    const c0 = callsOn(CH_STATUS).length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(callsOn(CH_STATUS).length).toBe(c0); // 零轮询
    globals!.document.visibilityState = 'visible';
    await vi.advanceTimersToNextTimerAsync(); // 恢复后到点继续（间隔随相位，不依赖具体值）
    expect(callsOn(CH_STATUS).length).toBeGreaterThan(c0);
    await settleAll(CH_STATUS, availableState());
  });

  it('取消在途（cancelling / 陈旧 version）时 STATUS 应答被拦下：available 也不弹窗', async () => {
    holdStatus = true;
    updateDialog!.__apply({ phase: 'idle', latest: null }); // 先隐藏
    expect(visible()).toBe(false);
    holdAction = true;
    primary().dispatch('click'); // download（挂起）
    primary().dispatch('click'); // cancel-download（cancelling=true，挂起）
    await vi.advanceTimersByTimeAsync(5000); // 轮询照发（全部挂起）
    const polls = callsOn(CH_STATUS).filter((p) => !p.settled);
    expect(polls.length).toBeGreaterThan(0);
    await settleAll(CH_STATUS, availableState());
    expect(visible()).toBe(false); // cancelling / version 落后 → 不弹
    await settleAll(CH_ACTION, { state: availableState() }); // cancel 回包（download 回包是陈旧丢弃）
    expect(visible()).toBe(true); // cancel 回包 state 重绘 → available 弹窗
  });

  it('STATUS 拒绝被吞（离线不炸轮询循环）', async () => {
    holdStatus = true;
    expect(visible()).toBe(false);
    await vi.advanceTimersToNextTimerAsync(); // 一班挂起
    await settleAll(CH_STATUS, new Error('offline'), true);
    expect(visible()).toBe(false);
  });
});
