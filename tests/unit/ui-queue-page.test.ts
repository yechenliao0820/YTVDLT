/**
 * D-187 · queue.js（下载队列页）真实行为单测 —— import 路线，v8 覆盖率可见。
 *
 * 决策背景：
 *  - 既有的 queue 系列语义单测（queue-progress / queue-failure / queue-live-fixture /
 *    star-prompt-ui / precheck-cancel-ui …）走 `helpers/queue-page-harness.ts` 的
 *    `new Function(...)` 沙箱：断言很好，但 VM 沙箱里的执行 v8 覆盖率统计不到。
 *    本文件改用共享装载架 `helpers/ui-harness.ts` 的 `loadUiModule()`（真实
 *    `await import()`），让 queue.js 进入 D-187 的覆盖率统计。
 *  - queue.js 是单实例 IIFE：模块注册表按测试文件缓存，`live.active` 在 import
 *    时刻由 `window.ytvdltBridge` 是否存在决定且之后不再翻转；而 `call()` 每次调用
 *    都惰性读取 `global.ytvdltBridge`。因此本文件固定以 **live 模式** 装载（注入
 *    可编程桥），场景差异通过「换桥实例 / 换应答数据 / 重置假节点状态」构造；
 *    引导期参数（`?prefill=` 深链、saved view）在 installUiGlobals 时一次性给定。
 *  - 桥是可编程桩：每个 IPC 调用登记为可手工应答的 deferred；TASK_LIST 与
 *    URL_SUPPORT_CHECK 默认自动应答（应答数据可换），其余按用例手工应答。
 *    afterEach 有安全网兜底应答残留调用，避免单实例的轮询循环 / 入队门闩
 *    泄漏到下一个用例（泄漏会让断言直接失败）。
 *  - 假定时器驱动 400ms/1.2s 轮询、2.5s 看门狗与 D-148 的 45s/60s 星标定时器；
 *    文档级事件（keydown / visibilitychange）在假 document 上不可派发，相关
 *    分支属已知残余（见文件尾注）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installUiGlobals, loadUiModule, type UiGlobals, type UiNode } from './helpers/ui-harness.js';

// ---------------------------------------------------------------------------
// 可编程 IPC 桥：所有调用登记为 deferred；handlers 命中则自动应答。
// ---------------------------------------------------------------------------
interface Deferred {
  channel: string;
  payload: unknown;
  settled: boolean;
  settle(value: unknown): void;
}
const pending: Deferred[] = [];
const handlers = new Map<string, (payload: any) => unknown>();
/** handler 返回该哨兵 = 调用保持挂起（留给用例手工应答）。 */
const HOLD = Symbol('hold');
const bridgeStub = {
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
    const entry: Deferred = {
      channel,
      payload,
      settled: false,
      settle(value: unknown) {
        if (entry.settled) return;
        entry.settled = true;
        resolve(value);
      },
    };
    void reject;
    pending.push(entry);
    const handler = handlers.get(channel);
    if (handler !== undefined) {
      try {
        const answer = handler(payload);
        if (answer !== HOLD) entry.settle(answer);
      } catch { /* 由用例自行构造失败桥 */ }
    }
    return promise;
  },
};

// 各通道应答数据（用例可改写）。
let replyItems: Array<Record<string, unknown>> = [];
let currentVerdict: unknown = { state: 'SUPPORTED', blocks: false };
let checkHold = false;
let starShow = false;
// 字幕选择器（Stage 5）的可编程选择票与应答消息；挂载后由族七用例驱动。
let currentSelection: unknown = null;
let ticketMessage: string | null = null;
let pickerRef: any = null;

const TASK_LIST = 'ytvdlt:task:list';
const TASK_ACTION = 'ytvdlt:task:action';
const DOWNLOAD_START = 'ytvdlt:download:start';
const SETTINGS_SET = 'ytvdlt:settings:set';
const URL_SUPPORT_CHECK = 'ytvdlt:sites:check';
const URL_SUPPORT_CHECK_CANCEL = 'ytvdlt:sites:checkCancel';
const STAR_PROMPT_CHECK = 'ytvdlt:starPrompt:check';
const STAR_PROMPT_ACTION = 'ytvdlt:starPrompt:action';

let globals: UiGlobals | null = null;
let queue: any = null;
let harnessBridge: unknown = null;
/** 引导期被扣住、由专属用例手工应答的调用（安全网跳过它们）。 */
const protectedBoot = new Set<Deferred>();

// ---------------------------------------------------------------------------
// 小工具：假节点检索 / IPC 断言 / 假定时器轮询。
// ---------------------------------------------------------------------------
const win = () => globals!.window;
const node = (id: string): UiNode => globals!.nodes.get(id) as UiNode;
const body = (): UiNode => globals!.document.body as UiNode;
const callsTo = (channel: string) => globals!.bridgeCalls.filter((c) => c.channel === channel);
const cls = (n: UiNode): string => String((n as unknown as { className?: string }).className ?? '');

function deepAll(root: UiNode, predicate: (n: UiNode) => boolean): UiNode[] {
  const found: UiNode[] = [];
  const walk = (current: UiNode): void => {
    if (predicate(current)) found.push(current);
    for (const child of current.children) walk(child);
  };
  walk(root);
  return found;
}
function deepFind(root: UiNode, predicate: (n: UiNode) => boolean): UiNode | null {
  return deepAll(root, predicate)[0] ?? null;
}
function cardByIdOrNull(id: string): UiNode | null {
  // harness 的 textContent='' 不清空 children（全量重绘会残留旧卡），因此取
  // 「最后一个」同 id 卡片 —— 即当前这次 render 的产物。
  const matches = node('queue-cards').children.filter((c) => c.getAttribute('data-task-id') === id);
  return matches[matches.length - 1] ?? null;
}
function cardById(id: string): UiNode {
  const card = cardByIdOrNull(id);
  expect(card, `应存在任务卡片 ${id}`).toBeTruthy();
  return card as UiNode;
}
function buttonOf(card: UiNode, action: string): UiNode | null {
  return deepFind(card, (n) => n.tagName === 'BUTTON' && n.getAttribute('data-action') === action);
}
function lineOf(card: UiNode): UiNode {
  const line = deepFind(card, (n) => cls(n).split(/\s+/).includes('card-progress'));
  expect(line, '卡片应有进度行').toBeTruthy();
  return line as UiNode;
}
function barOf(card: UiNode): UiNode {
  const bar = deepFind(card, (n) => cls(n) === 'bar');
  expect(bar, '卡片应有进度条').toBeTruthy();
  return bar as UiNode;
}
function fillOf(card: UiNode): UiNode {
  const fill = barOf(card).children[0];
  expect(fill, '数值条应有填充节点').toBeTruthy();
  return fill as UiNode;
}
function badgeOf(card: UiNode): UiNode {
  const badge = deepFind(card, (n) => cls(n) === 'badge');
  expect(badge, '卡片应有状态徽标').toBeTruthy();
  return badge as UiNode;
}
function bodyChildById(id: string): UiNode | null {
  // Star prompt 的 backdrop 用普通 `.id` 赋值（不走 setAttribute），两者都查。
  return body().children.find((c) => (c as unknown as { id?: string }).id === id
    || c.getAttribute('id') === id) ?? null;
}
function modalBackdrop(): UiNode | null {
  return body().children.find((n) => cls(n).split(/\s+/).includes('modal-backdrop')) ?? null;
}
/** TASK_LIST 的自动应答数据（轮询读它）。 */
function setList(items: Array<Record<string, unknown>>): void { replyItems = items; }
async function drain(): Promise<void> {
  for (let i = 0; i < 80; i += 1) await Promise.resolve();
}
/** 手工应答当前挂起的某通道调用（如引导期被扣住的首个 TASK_LIST）。 */
async function settleChannel(channel: string, answer: unknown | ((payload: any) => unknown)): Promise<void> {
  for (const entry of pending.filter((p) => p.channel === channel && !p.settled)) {
    entry.settle(typeof answer === 'function' ? (answer as (payload: any) => unknown)(entry.payload) : answer);
  }
  await drain();
}
/** 触发恰好一次轮询（页面的下一个 setTimeout；星标定时器到期也只会重调度）。 */
async function pollOnce(): Promise<void> {
  const before = callsTo(TASK_LIST).length;
  for (let i = 0; i < 8 && callsTo(TASK_LIST).length === before; i += 1) {
    await vi.advanceTimersToNextTimerAsync();
  }
  expect(callsTo(TASK_LIST).length, 'pollOnce 应触发一次新的 TASK_LIST 轮询').toBeGreaterThan(before);
  await drain();
}
/** 期望文案统一从真实 i18n 取（语言表内容变化不脆断）。 */
function T(key: string, params?: Record<string, unknown>): string {
  return String((win().YTVDLT.shell as { t(k: string, p?: Record<string, unknown>): string }).t(key, params));
}
/** `TASK_LIST` 的 wire DTO（字段名与主进程一致：speedBps / etaSec / artifactCount…）。 */
function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't1', state: 'Running', kind: 'video', title: 'Sample', uploader: 'Uploader',
    duration: 100, percent: null, speedBps: 0, etaSec: null, downloadedBytes: null,
    totalBytes: null, thumbPath: null, artifactCount: 0, errorCode: null, failureKind: null,
    ...overrides,
  };
}

beforeAll(async () => {
  vi.useFakeTimers();
  globals = installUiGlobals({
    // 注入桥 → queue.js 以 live 模式启动（live.active 在 import 时刻定格）。
    bridge: bridgeStub as unknown as { invoke(channel: string, payload?: unknown): Promise<unknown> },
    location: {
      href: 'file:///C:/app/pages/queue/index.html',
      // D-114/D-83：`?prefill=` 深链在引导期走 shell.prefill 分支。
      search: '?prefill=https%3A%2F%2Fexample.com%2Fwatch%3Fv%3Dabc',
      protocol: 'file:',
    },
    // 真浏览器 window 自带 setTimeout；harness 没有而 queue.js 的轮询循环 /
    // restoreView 滚动恢复 / 星标定时器都走 `global.setTimeout`。闭包按调用时
    // 取 globalThis 上的实现 —— 即 vi.useFakeTimers() 的假定时器。
    extraWindow: {
      setTimeout: (...args: unknown[]) => (globalThis as any).setTimeout(...args),
      clearTimeout: (handle: unknown) => (globalThis as any).clearTimeout(handle),
    },
  });
  // ui-harness 的 appendChild 是单向的；queue.js 关闭动态浮层时读 `parentNode`
  // 再 `removeChild`，这里补上父链（纯测试侧协作桩，不改 harness 文件）。
  const bodyNode = body();
  const rawAppend = bodyNode.appendChild.bind(bodyNode);
  bodyNode.appendChild = (child: UiNode) => {
    (child as unknown as { parentNode?: UiNode }).parentNode = bodyNode;
    return rawAppend(child);
  };
  // D-106：预置一份 saved view，引导期 restoreView() 才有数据可恢复。
  win().localStorage.setItem('ytvdlt.queue.view', JSON.stringify({
    tab: 'all', query: '', sort: 'newest', kind: 'video', selected: ['t-done-4'], scroll: 123,
  }));
  // 页面脚本顺序装载真实协作者（与 index.html 一致的队列页前缀），再装 queue.js。
  await loadUiModule('i18n/messages.js', globals);
  await loadUiModule('i18n/i18n.js', globals);
  await loadUiModule('theme/theme.js', globals);
  await loadUiModule('shell/app-version.js', globals);
  await loadUiModule('shell/app-nav.js', globals);
  await loadUiModule('ipc-bridge.js', globals);
  await loadUiModule('shortcuts/shortcuts.js', globals);
  await loadUiModule('app-shell.js', globals);
  await loadUiModule('pages/queue/queue.js', globals);
  queue = win().YTVDLTQueue;
  harnessBridge = win().ytvdltBridge;
  // 引导期首个 TASK_LIST 已被扣住（无 handler）；之后的轮询自动应答。
  handlers.set(TASK_LIST, () => ({ ok: true, items: replyItems }));
  handlers.set(URL_SUPPORT_CHECK, () => (checkHold ? HOLD : currentVerdict));
  handlers.set(SETTINGS_SET, () => ({ ok: true }));
  // 引导期的两个挂起调用交给专属用例应答。
  for (const channel of [TASK_LIST, 'ytvdlt:settings:get']) {
    const entry = pending.find((p) => p.channel === channel && !p.settled);
    if (entry) protectedBoot.add(entry);
  }
});

afterAll(() => {
  globals?.restore();
  globals = null;
  queue = null;
  vi.useRealTimers();
});

afterEach(async () => {
  // 换桥用例（IPC_ERROR / 桥不可用）失败时也要还原，避免污染后续用例。
  win().ytvdltBridge = harnessBridge;
  // 安全网：兜底应答残留挂起调用，防止单实例的轮询循环 / 入队门闩跨用例卡死。
  // 引导期被扣住的两个调用（首个 TASK_LIST / SETTINGS_GET 回读）有专属用例，
  // 不在网内替答（否则 D-141 的 loading 态与无痕回读分支会被吞掉）。
  for (let round = 0; round < 6; round += 1) {
    const leftovers = pending.filter((p) => !p.settled && !protectedBoot.has(p));
    if (leftovers.length === 0) break;
    for (const entry of leftovers) entry.settle({ ok: true });
    await drain();
  }
  expect(
    pending.some((p) => !p.settled && !protectedBoot.has(p)),
    '安全网之后不应再有挂起的 IPC 调用',
  ).toBe(false);
});

// ---------------------------------------------------------------------------
// 族一 · 装载面与 D-141 引导三态（还不知道 / 看门狗认错 / 真实空队列）
// ---------------------------------------------------------------------------
describe('D-187 · queue.js 装载面与 D-141 引导三态（live 单实例）', () => {
  // 注意：本用例必须是文件首个 it —— 引导期被扣住的首个 TASK_LIST 只在这里
  // 应答，afterEach 安全网才会放行后续用例的挂起调用。
  it('D-141 三态机：首帧「还知道」→ 看门狗认错 → 慢答复恢复，绝不画样例任务', async () => {
    // ① 首个 TASK_LIST 之前：loading 态、零卡片、零样例。
    expect(node('queue-root').getAttribute('data-state')).toBe('loading');
    expect(node('queue-cards').getAttribute('hidden')).toBe('true');
    expect(node('queue-cards').children.length).toBe(0);
    for (const sample of queue.sample as Array<{ id: string }>) {
      expect(cardByIdOrNull(sample.id), `样例任务 ${sample.id} 不得出现在 live 窗口`).toBeNull();
    }
    // 首呼即发出，且带一次性的文件状态刷新标记（D-120）。
    const first = callsTo(TASK_LIST);
    expect(first.length).toBe(1);
    expect(first[0]?.payload).toEqual({ tab: 'all', refreshFileStatus: true });
    // ② 首个回复永不到达：看门狗在 2.5s 承认失败，而不是永远空白。
    await vi.advanceTimersByTimeAsync(2600);
    expect(node('queue-root').getAttribute('data-state')).toBe('error');
    expect(node('queue-error').getAttribute('hidden')).toBe('false');
    expect(node('queue-cards').getAttribute('hidden')).toBe('true');
    expect(callsTo(TASK_LIST).length).toBe(1); // 轮询停在等待首答，不空转
    // ③ 慢答复落地：wasError 分支必须强制重绘（哪怕数据与占位一致）。
    await settleChannel(TASK_LIST, { ok: true, items: [] });
    expect(node('queue-root').getAttribute('data-state')).toBe('empty');
  });

  it('真实 import 后在假 window 上暴露完整 YTVDLTQueue 测试面（D-187/D-148）', () => {
    expect(queue).toBeTruthy();
    for (const key of [
      'render', 'selectTab', 'tabOf', 'filterTasks', 'counts', 'sample', 'snapshot',
      'setKind', 'choice', 'locale', 'switchLocale', 'requestDelete', 'clearHistory', 'model',
      'subtitlePicker', 'mountSubtitlePicker', 'txtImport', 'mountTxtImport', 'ensureTxtImport',
      'playlistImport', 'mountPlaylistImport', 'ensurePlaylistImport',
      'startRealDownload', 'enqueueSingleDownload', 'downloadPayload',
      'starPrompt', 'scheduleStarPrompt', 'maybeCheckStarPrompt', 'showStarPrompt', 'closeStarPrompt',
    ]) {
      expect(queue[key], `YTVDLTQueue.${key} 应存在`).toBeDefined();
    }
  });

  it('真实空队列渲染 empty 变体、并发横幅与引导帧快照（D-141）', () => {
    expect(node('queue-empty').getAttribute('hidden')).toBe('false');
    expect(node('queue-empty').getAttribute('data-variant')).toBe('empty');
    expect(node('queue-cards').getAttribute('hidden')).toBe('true');
    expect(node('queue-cards').children.length).toBe(0);
    expect(node('queue-root').getAttribute('data-concurrency')).toBe('0/3');
    // snapshot 是引导帧（未知态）的渲染结果：空列表，不是六条样例。
    expect(queue.snapshot.counts).toEqual({ all: 0, downloading: 0, finished: 0, canceled: 0 });
    expect(queue.snapshot.list).toEqual([]);
  });

  it('queue-retry 的 live 分支重新拉取队列（不带刷新标记的普通轮询载荷）', async () => {
    const before = callsTo(TASK_LIST).length;
    node('queue-retry').dispatch('click');
    await drain();
    expect(callsTo(TASK_LIST).length).toBe(before + 1);
    expect(callsTo(TASK_LIST).at(-1)?.payload).toEqual({ tab: 'all' });
    expect(node('queue-root').getAttribute('data-state')).toBe('empty');
  });

  it('引导期恢复 saved view（D-106）并把 ?prefill= 深链填进粘贴框（D-114）', () => {
    expect(queue.model.tab).toBe('all');
    expect(queue.model.query).toBe('');
    expect(queue.model.sort).toBe('newest');
    expect(queue.model.selected).toEqual({ 't-done-4': true });
    expect(node('queue-sort').value).toBe('newest');
    // restoreView 的滚动恢复走 setTimeout(0)，已被看门狗用例的时钟推进触发。
    expect(node('queue-body').scrollTop).toBe(123);
    // 深链只填框、不把链接本身写进 DOM。
    expect(node('queue-url').value).toBe('https://example.com/watch?v=abc');
    expect(node('queue-root').getAttribute('data-prefilled')).toBe('true');
    expect(node('queue-root').getAttribute('data-prefill-host')).toBe('example.com');
  });
});

// ---------------------------------------------------------------------------
// 族二 · live 渲染与卡片投影（D-112 / D-107 / D-115 / D-109 / D-120 / D-95/D-96）
// ---------------------------------------------------------------------------
describe('D-187 · live 列表投影与卡片渲染纪律', () => {
  it('wire DTO 投影成卡片：状态徽标 / 分类归属 / 并发横幅 / 页脚计数（D-95）', async () => {
    setList([wire({
      id: 't-run', state: 'Running', title: 'Run', percent: 42,
      speedBps: 4_200_000, etaSec: 96, downloadedBytes: 94_371_840, totalBytes: 224_694_080, artifactCount: 2,
    })]);
    await pollOnce();
    const card = cardById('t-run');
    expect(card.getAttribute('data-state')).toBe('Running');
    expect(card.getAttribute('data-tab')).toBe('downloading');
    expect(card.getAttribute('data-progress-mode')).toBe('value');
    expect(badgeOf(card).textContent).toBe(T('task.state.Running'));
    expect(node('queue-root').getAttribute('data-concurrency')).toBe('1/3');
    expect(node('queue-foot-count').textContent).toBe('1 / 1');
    // Running 卡：有详情入口；file/folder 仅 Completed 提供（D-120）。
    expect(buttonOf(card, 'detail')).toBeTruthy();
    expect(buttonOf(card, 'file')).toBeNull();
    expect(buttonOf(card, 'folder')).toBeNull();
  });

  it('进度行按「百分比 · 大小 · 速度 · 剩余」组合，缺项独立掉落（D-95）', async () => {
    setList([wire({
      id: 't-run', state: 'Running', percent: 42,
      speedBps: 4_200_000, etaSec: 96, downloadedBytes: 94_371_840, totalBytes: 224_694_080,
    })]);
    await pollOnce();
    const shell = win().YTVDLT.shell;
    const expected = [
      '42.0%',
      String(shell.t('queue.card.size', { done: shell.formatBytes(94_371_840), total: shell.formatBytes(224_694_080) })),
      String(shell.formatSpeed(4_200_000)),
      String(shell.t('queue.card.eta', { eta: shell.formatEta(96) })),
    ].join(' · ');
    expect(lineOf(cardById('t-run')).textContent).toBe(expected);
  });

  it('D-162/D-164：live 取消可用性与 TaskQueue 能力逐状态对齐', async () => {
    setList([
      wire({ id: 'a-run', state: 'Running', percent: 10 }),
      wire({ id: 'b-fetch', state: 'FetchingInfo' }),
      wire({ id: 'c-parked', state: 'Idle', pending: true }),
      wire({ id: 'd-ready', state: 'ReadyWithInfo' }),
      wire({ id: 'e-error', state: 'Error', errorCode: 'HTTP_403' }),
      wire({ id: 'f-done', state: 'Completed', percent: 100 }),
      wire({ id: 'g-cancel', state: 'Canceled', percent: 5 }),
    ]);
    await pollOnce();
    // Running：可取消、不可重试；transfer 未结束不可删（remove: !running）。
    expect(buttonOf(cardById('a-run'), 'cancel')).toBeTruthy();
    expect(buttonOf(cardById('a-run'), 'remove')).toBeNull();
    expect(buttonOf(cardById('a-run'), 'retry')).toBeNull();
    // D-162：解析中已带 AbortSignal，可取消；删除同样不可用。
    expect(buttonOf(cardById('b-fetch'), 'cancel')).toBeTruthy();
    expect(buttonOf(cardById('b-fetch'), 'remove')).toBeNull();
    // D-164：FIFO 排队（pending 标记）可取消。
    expect(buttonOf(cardById('c-parked'), 'cancel')).toBeTruthy();
    // ReadyWithInfo 是零长度相位，没有可杀的句柄；已停转 → 可删。
    expect(buttonOf(cardById('d-ready'), 'cancel')).toBeNull();
    expect(buttonOf(cardById('d-ready'), 'remove')).toBeTruthy();
    // 终态：Error/Canceled 可重试，Completed 有 file/folder 入口。
    expect(buttonOf(cardById('e-error'), 'retry')).toBeTruthy();
    expect(buttonOf(cardById('e-error'), 'cancel')).toBeNull();
    expect(buttonOf(cardById('f-done'), 'file')).toBeTruthy();
    expect(buttonOf(cardById('f-done'), 'folder')).toBeTruthy();
    expect(buttonOf(cardById('f-done'), 'retry')).toBeNull();
    expect(buttonOf(cardById('g-cancel'), 'retry')).toBeTruthy();
    // 每张卡都有详情入口。
    expect(buttonOf(cardById('g-cancel'), 'detail')).toBeTruthy();
  });

  it('D-107：Running 且 percent=null 保持 unknown 模式，不编造 0%', async () => {
    setList([
      wire({ id: 'u1', state: 'Running', percent: null }),
      wire({ id: 'u2', state: 'Running', percent: null, downloadedBytes: 4096 }),
    ]);
    await pollOnce();
    const shell = win().YTVDLT.shell;
    const card1 = cardById('u1');
    expect(card1.getAttribute('data-progress-mode')).toBe('unknown');
    expect(barOf(card1).getAttribute('data-mode')).toBe('indeterminate');
    const line1 = lineOf(card1);
    expect(line1.getAttribute('data-progress')).toBe('unknown');
    expect(line1.textContent).toBe(String(shell.t('queue.card.connecting')));
    expect(String(line1.textContent)).not.toContain('%');
    // 已有真实字节的 unknown：字节 + 「正在获取下载进度」，依旧不写百分比。
    const line2 = lineOf(cardById('u2'));
    expect(line2.textContent).toBe([
      String(shell.t('queue.card.downloaded', { done: shell.formatBytes(4096) })),
      String(shell.t('queue.card.measuring')),
    ].join(' · '));
    expect(String(line2.textContent)).not.toContain('%');
  });

  it('D-115：merging/postprocess/verifying 显示 working 黄条；阶段文案原位切换', async () => {
    setList([wire({ id: 'w1', state: 'Running', percent: 100, stage: 'merging' })]);
    await pollOnce();
    const card = cardById('w1');
    expect(card.getAttribute('data-progress-mode')).toBe('working');
    expect(card.getAttribute('data-stage')).toBe('merging');
    expect(barOf(card).getAttribute('data-tone')).toBe('work');
    expect(lineOf(card).textContent).toBe(T('queue.stage.merging'));
    expect(lineOf(card).getAttribute('data-progress')).toBe('working');
    // merging → verifying：模式不变（working），只在原位换文案、不重建卡片。
    setList([wire({ id: 'w1', state: 'Running', percent: 100, stage: 'verifying' })]);
    await pollOnce();
    expect(cardById('w1')).toBe(card);
    expect(lineOf(card).textContent).toBe(T('queue.stage.finalizing'));
  });

  it('D-190：working 阶段原位补丁同步卡片根 data-stage（不只改阶段文案）', async () => {
    setList([wire({ id: 'w2', state: 'Running', percent: 100, stage: 'merging' })]);
    await pollOnce();
    const card = cardById('w2');
    expect(card.getAttribute('data-stage')).toBe('merging');
    // merging → verifying 不重建卡片：走 patchProgress 的 working 分支。
    setList([wire({ id: 'w2', state: 'Running', percent: 100, stage: 'verifying' })]);
    await pollOnce();
    expect(cardById('w2')).toBe(card);
    expect(card.getAttribute('data-stage')).toBe('verifying');
    expect(lineOf(card).textContent).toBe(T('queue.stage.finalizing'));
  });

  it('D-112：同形二次推送不重建卡片（封面不闪）、数值原位补丁、thumb 变化才重建', async () => {
    setList([wire({ id: 'p1', state: 'Running', percent: 42 })]);
    await pollOnce();
    const card1 = cardById('p1');
    expect(fillOf(card1).style.width).toBe('42%');
    // 进度变化：paintKey 不变 → patchProgress 原位补丁，同一节点。
    setList([wire({ id: 'p1', state: 'Running', percent: 57 })]);
    await pollOnce();
    expect(cardById('p1')).toBe(card1);
    expect(fillOf(card1).style.width).toBe('57%');
    expect(lineOf(card1).getAttribute('data-progress')).toBe('57');
    // 同进度二次推送：progressKey 也不变 → 完全不重绘。
    setList([wire({ id: 'p1', state: 'Running', percent: 57 })]);
    await pollOnce();
    expect(cardById('p1')).toBe(card1);
    expect(fillOf(card1).style.width).toBe('57%');
    // thumbPath 变化属于 DOM 形状变化 → 全量重绘、新节点。
    setList([wire({ id: 'p1', state: 'Running', percent: 57, thumbPath: 'C:\\a b\\c.jpg' })]);
    await pollOnce();
    expect(cardById('p1')).not.toBe(card1);
    expect(deepFind(cardById('p1'), (n) => n.tagName === 'IMG')).toBeTruthy();
  });

  it('D-109：failureKind 稳定桶 → 文案键；未知桶落 unknown；非 Error 不显简报', async () => {
    setList([
      wire({ id: 'f1', state: 'Error', errorCode: 'HTTP_403', failureKind: 'forbidden' }),
      wire({ id: 'f2', state: 'Error', failureKind: 'bogus-kind' }),
      wire({ id: 'f3', state: 'Error' }),
      wire({ id: 'f4', state: 'Canceled', failureKind: 'network', percent: null }),
    ]);
    await pollOnce();
    const brief1 = deepFind(cardById('f1'), (n) => cls(n) === 'card-failure');
    expect(brief1?.getAttribute('data-failure-kind')).toBe('forbidden');
    expect(brief1?.textContent).toBe(T('queue.failure.forbidden'));
    const brief2 = deepFind(cardById('f2'), (n) => cls(n) === 'card-failure');
    expect(brief2?.getAttribute('data-failure-kind')).toBe('unknown');
    expect(brief2?.textContent).toBe(T('queue.failure.unknown'));
    expect(deepFind(cardById('f3'), (n) => cls(n) === 'card-failure')?.getAttribute('data-failure-kind')).toBe('unknown');
    // 取消不算失败：无论后端带没带 failureKind。
    expect(deepFind(cardById('f4'), (n) => cls(n) === 'card-failure')).toBeNull();
  });

  it('D-120：Completed 卡的文件状态提示只对坏观察出现；subtitleOutcome 投影双值', async () => {
    setList([
      wire({ id: 'p-miss', state: 'Completed', percent: 100, fileStatus: 'missing' }),
      wire({ id: 'p-ok', state: 'Completed', percent: 100, fileStatus: 'present' }),
      wire({ id: 'p-run', state: 'Running', percent: 1, fileStatus: 'missing' }),
      wire({ id: 's-miss', state: 'Completed', percent: 100, subtitleOutcome: 'missing' }),
      wire({ id: 's-bad', state: 'Completed', percent: 100, subtitleOutcome: 'weird' }),
    ]);
    await pollOnce();
    const fileHint = deepFind(cardById('p-miss'), (n) => cls(n) === 'card-file-state');
    expect(fileHint?.getAttribute('data-file-status')).toBe('missing');
    expect(fileHint?.textContent).toBe(T('queue.file.missing'));
    expect(deepFind(cardById('p-ok'), (n) => cls(n) === 'card-file-state')).toBeNull();
    expect(deepFind(cardById('p-run'), (n) => cls(n) === 'card-file-state')).toBeNull();
    const subHint = deepFind(cardById('s-miss'), (n) => n.getAttribute('data-subtitle-outcome') === 'missing');
    expect(subHint?.textContent).toBe(T('subtitle.outcome.missing'));
    expect(deepFind(cardById('s-bad'), (n) => n.getAttribute('data-subtitle-outcome') !== null)).toBeNull();
  });

  it('封面：本地路径转 file:// URL；加载失败回落字母徽标（D-96）', async () => {
    // 带 Running 锚：轮询窗口里队列始终「忙」，D-148 的星标定时器只重调度。
    setList([
      wire({ id: 'th0', state: 'Running', percent: 3 }),
      wire({ id: 'th1', state: 'Completed', percent: 100, thumbPath: 'C:\\a b\\c.jpg', title: 'Sintel' }),
    ]);
    await pollOnce();
    const card = cardById('th1');
    const thumb = deepFind(card, (n) => cls(n) === 'thumb');
    expect(thumb?.getAttribute('data-thumb')).toBe('image');
    const img = deepFind(card, (n) => n.tagName === 'IMG');
    expect((img as unknown as { src?: string })?.src).toBe('file:///C:/a%20b/c.jpg');
    img?.dispatch('error');
    expect(thumb?.getAttribute('data-thumb')).toBe('letter');
    expect(thumb?.textContent).toBe('S');
  });

  it('tabOf / counts / filterTasks 纯函数与 model.sort 视图排序（D-87）', async () => {
    expect(queue.tabOf('Completed')).toBe('finished');
    expect(queue.tabOf('Canceled')).toBe('canceled');
    expect(queue.tabOf('Error')).toBe('canceled');
    expect(queue.tabOf('Running')).toBe('downloading');
    const list = [
      { id: 'x1', state: 'Running', title: 'Beta', uploader: 'U1' },
      { id: 'x2', state: 'Completed', title: 'Alpha', uploader: 'U2' },
      { id: 'x3', state: 'Canceled', title: 'Gamma', uploader: 'U3' },
    ];
    expect(queue.counts(list)).toEqual({ all: 3, downloading: 1, finished: 1, canceled: 1 });
    expect(queue.filterTasks(list, 'finished', '').map((t: any) => t.id)).toEqual(['x2']);
    expect(queue.filterTasks(list, 'all', 'u3').map((t: any) => t.id)).toEqual(['x3']);
    expect(queue.filterTasks(list, 'all', 'x2').map((t: any) => t.id)).toEqual(['x2']);
    expect(queue.filterTasks(list, 'all', '没有这个词')).toEqual([]);
    // 渲染排序：name/state 有确定序；oldest 当前与 newest 同为 reverse（疑似缺陷，
    // 见报告——这里固定现状防止漂移）。
    setList([
      wire({ id: 'x1', state: 'Running', title: 'Beta', percent: 1 }),
      wire({ id: 'x2', state: 'Completed', title: 'Alpha', percent: 100 }),
      wire({ id: 'x3', state: 'Canceled', title: 'Gamma' }),
    ]);
    await pollOnce();
    queue.model.sort = 'name';
    expect(queue.render().visible.map((t: any) => t.id)).toEqual(['x2', 'x1', 'x3']);
    queue.model.sort = 'state';
    expect(queue.render().visible.map((t: any) => t.id)).toEqual(['x3', 'x2', 'x1']);
    const oldestOrder = queue.render().visible.map((t: any) => t.id);
    queue.model.sort = 'newest';
    expect(queue.render().visible.map((t: any) => t.id)).toEqual(oldestOrder);
    queue.model.sort = 'newest';
  });

  it('D-190：oldest 保持到达顺序、newest 反转，两者互为逆序（排序方向回归）', async () => {
    setList([
      wire({ id: 'x1', state: 'Running', title: 'Beta', percent: 1 }),
      wire({ id: 'x2', state: 'Completed', title: 'Alpha', percent: 100 }),
      wire({ id: 'x3', state: 'Canceled', title: 'Gamma' }),
    ]);
    await pollOnce();
    // 列表按最旧在前到达：oldest 应保持原序，修复前它和 newest 同为 reverse。
    queue.model.sort = 'oldest';
    const oldest = queue.render().visible.map((t: any) => t.id);
    expect(oldest).toEqual(['x1', 'x2', 'x3']);
    queue.model.sort = 'newest';
    const newest = queue.render().visible.map((t: any) => t.id);
    expect(newest).toEqual(['x3', 'x2', 'x1']);
    expect(newest).toEqual([...oldest].reverse());
    queue.model.sort = 'newest'; // 复位，避免污染后续用例
  });

  it('搜索框输入过滤 + 无结果时的 filter 空态变体（D-87）', async () => {
    setList([wire({ id: 'q1', state: 'Running', title: 'Sintel', percent: 1 })]);
    await pollOnce();
    const search = node('queue-search');
    search.value = '绝不匹配的词';
    search.dispatch('input');
    expect(queue.model.query).toBe('绝不匹配的词');
    expect(node('queue-root').getAttribute('data-state')).toBe('empty');
    expect(node('queue-empty').getAttribute('data-variant')).toBe('filter');
    expect(node('queue-cards').getAttribute('hidden')).toBe('true');
    search.value = '';
    search.dispatch('input');
    expect(node('queue-root').getAttribute('data-state')).toBe('ready');
    expect(cardByIdOrNull('q1')).toBeTruthy();
  });

  it('?empty=1 查询开关：tasks() 直接返回空（视图层空态，与 live 数据无关）', () => {
    win().location.search = '?empty=1';
    const result = queue.render();
    expect(result.list).toEqual([]);
    expect(node('queue-empty').getAttribute('data-variant')).toBe('empty');
    win().location.search = '?prefill=https%3A%2F%2Fexample.com%2Fwatch%3Fv%3Dabc';
  });

  it('?error=1 查询开关：错误态压过数据态，卡片隐藏', () => {
    win().location.search = '?error=1';
    queue.render();
    expect(node('queue-root').getAttribute('data-state')).toBe('error');
    expect(node('queue-error').getAttribute('hidden')).toBe('false');
    expect(node('queue-cards').getAttribute('hidden')).toBe('true');
    win().location.search = '?prefill=https%3A%2F%2Fexample.com%2Fwatch%3Fv%3Dabc';
  });
});

// ---------------------------------------------------------------------------
// 族三 · 卡片动作 act()（D-76 / D-114 / D-120）
// ---------------------------------------------------------------------------
describe('D-187 · 卡片动作经 TASK_ACTION 下发并按稳定码回显', () => {
  it('Running 卡点取消 → TASK_ACTION cancel + 完成通知 + 强制文件状态刷新', async () => {
    setList([wire({ id: 'act1', state: 'Running', percent: 10 })]);
    await pollOnce();
    buttonOf(cardById('act1'), 'cancel')?.dispatch('click');
    expect(callsTo(TASK_ACTION).at(-1)?.payload).toEqual({ taskId: 'act1', action: 'cancel' });
    await settleChannel(TASK_ACTION, { ok: true });
    expect(node('queue-status').textContent).toBe(T('queue.notify.actionDone', { action: 'cancel' }));
    expect(callsTo(TASK_LIST).at(-1)?.payload).toMatchObject({ refreshFileStatus: true });
  });

  it('Error 卡点重试 → TASK_ACTION retry', async () => {
    setList([wire({ id: 'act2', state: 'Error', errorCode: 'X' }), wire({ id: 'act0', state: 'Running', percent: 2 })]);
    await pollOnce();
    buttonOf(cardById('act2'), 'retry')?.dispatch('click');
    expect(callsTo(TASK_ACTION).at(-1)?.payload).toEqual({ taskId: 'act2', action: 'retry' });
    await settleChannel(TASK_ACTION, { ok: true });
    expect(node('queue-status').textContent).toBe(T('queue.notify.actionDone', { action: 'retry' }));
  });

  it('Completed 卡 folder/file：ok+missing 的诚实提示与 FILE_MISSING 稳定码（D-120）', async () => {
    setList([wire({ id: 'act3', state: 'Completed', percent: 100 }), wire({ id: 'act0', state: 'Running', percent: 2 })]);
    await pollOnce();
    buttonOf(cardById('act3'), 'folder')?.dispatch('click');
    expect(callsTo(TASK_ACTION).at(-1)?.payload).toEqual({ taskId: 'act3', action: 'open-folder' });
    await settleChannel(TASK_ACTION, { ok: true, fileStatus: 'missing' });
    expect(node('queue-status').textContent).toBe(T('queue.open.folderOpenedMissing'));
    buttonOf(cardById('act3'), 'file')?.dispatch('click');
    expect(callsTo(TASK_ACTION).at(-1)?.payload).toEqual({ taskId: 'act3', action: 'open-file' });
    await settleChannel(TASK_ACTION, { ok: false, code: 'FILE_MISSING' });
    expect(node('queue-status').textContent).toBe(T('queue.open.fileMissing'));
  });

  it('详情跳转携带 taskId 与 ?lang= 后缀（D-114 版本交接的队列侧）', async () => {
    win().localStorage.setItem('ytvdlt.locale', 'en');
    setList([wire({ id: 'act4', state: 'Completed', percent: 100 }), wire({ id: 'act0', state: 'Running', percent: 2 })]);
    await pollOnce();
    buttonOf(cardById('act4'), 'detail')?.dispatch('click');
    expect(String(win().location.href)).toBe(
      '../task-detail/index.html?taskId=' + encodeURIComponent('act4') + '&lang=en',
    );
    win().localStorage.removeItem('ytvdlt.locale');
    win().location.href = 'file:///C:/app/pages/queue/index.html';
  });

  it('动作失败且无 message/code 时回退通用 IPC 文案', async () => {
    setList([wire({ id: 'act5', state: 'Canceled' }), wire({ id: 'act0', state: 'Running', percent: 2 })]);
    await pollOnce();
    buttonOf(cardById('act5'), 'retry')?.dispatch('click');
    await settleChannel(TASK_ACTION, { ok: false });
    expect(node('queue-status').textContent)
      .toBe(T('queue.notify.actionFailed', { action: 'retry', reason: T('queue.notify.ipc') }));
  });

  it('focus / pageshow 把文件状态标记为过期，下一次轮询带 refreshFileStatus（D-120）', async () => {
    setList([wire({ id: 'act6', state: 'Running', percent: 1 })]);
    await pollOnce(); // 清掉上一次的 stale 标记
    win().dispatch('focus');
    await pollOnce();
    expect(callsTo(TASK_LIST).at(-1)?.payload).toMatchObject({ refreshFileStatus: true });
    win().dispatch('pageshow');
    await pollOnce();
    expect(callsTo(TASK_LIST).at(-1)?.payload).toMatchObject({ refreshFileStatus: true });
  });
});

// ---------------------------------------------------------------------------
// 族四 · 任务管理：删除 / 清空 / 选择 / 无痕（D-87 / D-116 / D-88）
// ---------------------------------------------------------------------------
describe('D-187 · 任务管理与 D-116 单确认对话框纪律', () => {
  it('空选择提示；live 下 requestDelete 打开删除确认且默认「只删记录」', () => {
    queue.requestDelete([]);
    expect(node('queue-status').textContent).toBe(T('queue.notify.noSelection'));
    queue.requestDelete(['m-1']);
    expect(node('queue-modal').getAttribute('hidden')).toBe('false');
    expect(node('queue-modal-title').textContent).toBe(T('queue.delete.title'));
    expect(node('queue-modal-message').textContent).toBe(T('queue.delete.message'));
    expect(node('queue-modal-count').textContent).toBe(T('queue.delete.count', { n: 1 }));
    expect(node('queue-modal-note').textContent).toBe(T('queue.delete.filesHint'));
    expect(node('queue-modal-with-files').checked).toBe(false); // D-116：每次打开都不勾选
    expect(String((node('queue-modal-confirm') as any).className)).toBe('primary');
    expect(node('queue-modal-confirm').textContent).toBe(T('queue.delete.confirm'));
    expect(node('queue-modal-check').getAttribute('data-risk')).toBe('false');
    expect(node('queue-modal-risk').getAttribute('hidden')).toBe('true');
    node('queue-modal-cancel').dispatch('click');
    expect(node('queue-modal').getAttribute('hidden')).toBe('true');
  });

  it('勾选 withFiles：确认按钮转危险态，确认后下发 TASK_ACTION withFiles:true', async () => {
    queue.requestDelete(['m-2']);
    const box = node('queue-modal-with-files');
    box.checked = true;
    box.dispatch('change');
    const confirm = node('queue-modal-confirm');
    expect(String((confirm as any).className)).toBe('danger');
    expect(confirm.textContent).toBe(T('queue.delete.confirmFiles'));
    expect(node('queue-modal-check').getAttribute('data-risk')).toBe('true');
    expect(node('queue-modal-risk').getAttribute('hidden')).toBe('false');
    confirm.dispatch('click');
    await drain(); // performRemoval 的调用在微任务里登记
    const dispatched = callsTo(TASK_ACTION).at(-1);
    expect(dispatched?.payload).toEqual({ taskId: 'm-2', action: 'remove', withFiles: true });
    await settleChannel(TASK_ACTION, { ok: true, filesTrashed: 1 });
    expect(node('queue-status').textContent).toBe(T('queue.status.filesRemoved', { n: 1 }));
    expect(node('queue-modal').getAttribute('hidden')).toBe('true');
    // D-120：主进程刚重查过路径，刷新必须带 refreshFileStatus。
    expect(callsTo(TASK_LIST).at(-1)?.payload).toMatchObject({ refreshFileStatus: true });
  });

  it('不勾选确认：纯记录删除语义；真实失败按 reason 简报（D-120）', async () => {
    queue.requestDelete(['m-3']);
    node('queue-modal-confirm').dispatch('click');
    await drain();
    const dispatched = callsTo(TASK_ACTION).at(-1)?.payload as Record<string, unknown>;
    expect(dispatched).toEqual({ taskId: 'm-3', action: 'remove' });
    expect('withFiles' in dispatched).toBe(false);
    await settleChannel(TASK_ACTION, { ok: false, reason: 'EBUSY' });
    expect(node('queue-status').textContent).toBe(T('queue.status.failed', { reason: 'EBUSY' }));
  });

  it('文件早已不在 / 共享产物被跳过时给出诚实简报而不是失败', async () => {
    queue.requestDelete(['m-4']);
    node('queue-modal-with-files').checked = true;
    node('queue-modal-with-files').dispatch('change');
    node('queue-modal-confirm').dispatch('click');
    await drain();
    await settleChannel(TASK_ACTION, { ok: true, filesMissing: 2, filesTrashed: 0 });
    expect(node('queue-status').textContent).toBe(T('queue.delete.filesAlreadyGone'));
    queue.requestDelete(['m-5']);
    node('queue-modal-with-files').checked = true;
    node('queue-modal-with-files').dispatch('change');
    node('queue-modal-confirm').dispatch('click');
    await drain();
    await settleChannel(TASK_ACTION, { ok: true, sharedSkipped: 1 });
    expect(node('queue-status').textContent).toBe(T('queue.delete.filesShared'));
  });

  it('取消 / 背景点击关闭对话框，且重开不残留勾选（D-116）', () => {
    queue.requestDelete(['m-6']);
    node('queue-modal-with-files').checked = true;
    node('queue-modal-with-files').dispatch('change');
    node('queue-modal-cancel').dispatch('click');
    expect(node('queue-modal').getAttribute('hidden')).toBe('true');
    expect(node('queue-modal-with-files').checked).toBe(false);
    // 点击落在遮罩本身 → 关闭；落在内容上 → 不关。
    queue.requestDelete(['m-7']);
    node('queue-modal').dispatch('click', { target: node('queue-modal') });
    expect(node('queue-modal').getAttribute('hidden')).toBe('true');
    queue.requestDelete(['m-8']);
    node('queue-modal').dispatch('click', { target: node('queue-modal-title') });
    expect(node('queue-modal').getAttribute('hidden')).toBe('false');
    node('queue-modal-cancel').dispatch('click');
  });

  it('清空历史只收集 HISTORY_STATES、clear 模式文案、逐个 remove（D-116）', async () => {
    setList([
      wire({ id: 'h1', state: 'Completed', percent: 100 }),
      wire({ id: 'h2', state: 'Canceled' }),
      wire({ id: 'h3', state: 'Error', errorCode: 'X' }),
      wire({ id: 'h4', state: 'Running', percent: 1 }),
    ]);
    await pollOnce();
    node('queue-clear-history').dispatch('click');
    expect(node('queue-modal').getAttribute('hidden')).toBe('false');
    expect(node('queue-modal-title').textContent).toBe(T('queue.clear.title'));
    expect(node('queue-modal-message').textContent).toBe(T('queue.clear.message'));
    expect(node('queue-modal-count').textContent).toBe(T('queue.delete.count', { n: 3 }));
    expect(node('queue-modal-note').textContent).toBe(T('queue.clear.filesHint'));
    expect(node('queue-modal-confirm').textContent).toBe(T('queue.clear.confirm'));
    expect(node('queue-modal-confirm').textContent).toBe(T('queue.clear.confirm'));
    node('queue-modal-confirm').dispatch('click');
    // performRemoval 逐个串行 remove：上一条的回复落地后才会发出下一条。
    const removedIds: string[] = [];
    for (let round = 0; round < 6; round += 1) {
      await drain();
      const open = pending.filter((p) => p.channel === TASK_ACTION && !p.settled);
      if (open.length === 0) break;
      for (const entry of open) {
        removedIds.push((entry.payload as { taskId: string }).taskId);
        entry.settle({ ok: true });
      }
    }
    expect(removedIds.sort()).toEqual(['h1', 'h2', 'h3']);
    await settleChannel(TASK_ACTION, { ok: true });
    expect(node('queue-status').textContent).toBe(T('queue.status.cleared'));
  });

  it('没有可清空的历史时提示为空，不弹对话框', async () => {
    setList([wire({ id: 'h9', state: 'Running', percent: 1 })]);
    await pollOnce();
    queue.clearHistory();
    expect(node('queue-status').textContent).toBe(T('queue.clear.empty'));
    expect(node('queue-modal').getAttribute('hidden')).not.toBe('false');
  });

  it('全选 / 单选复选框联动工具栏与卡片选中态，删除选中走确认框（D-87）', async () => {
    setList([
      wire({ id: 'sel1', state: 'Running', title: 'Sel One', percent: 1 }),
      wire({ id: 'sel2', state: 'Completed', title: 'Sel Two', percent: 100 }),
    ]);
    await pollOnce();
    queue.model.selected = {}; // 清掉引导期恢复的已删任务选择，回到零选择基线
    queue.render();
    expect(node('queue-delete-selected').disabled).toBe(true);
    const all = node('queue-select-all');
    all.checked = true;
    all.dispatch('change');
    expect(cardById('sel1').getAttribute('data-selected')).toBe('true');
    expect(cardById('sel2').getAttribute('data-selected')).toBe('true');
    expect(node('queue-selected-count').textContent).toBe(T('queue.selected.count', { n: 2 }));
    expect(node('queue-delete-selected').disabled).toBe(false);
    node('queue-delete-selected').dispatch('click');
    expect(node('queue-modal-count').textContent).toBe(T('queue.delete.count', { n: 2 }));
    node('queue-modal-cancel').dispatch('click');
    // 单选 → 半选态；再全不选。
    all.checked = false;
    all.dispatch('change');
    expect(cardById('sel1').getAttribute('data-selected')).toBe('false');
    const check = deepFind(cardById('sel1'), (n) => cls(n) === 'card-check');
    check!.checked = true;
    check!.dispatch('change');
    expect(cardById('sel1').getAttribute('data-selected')).toBe('true');
    expect(all.indeterminate).toBe(true);
    expect(node('queue-selected-count').textContent).toBe(T('queue.selected.count', { n: 1 }));
    all.checked = false;
    all.dispatch('change');
    expect(all.indeterminate).toBe(false);
  });

  it('无痕模式：SETTINGS_GET 回读覆盖本地缓存，change 下发 SETTINGS_SET（D-88）', async () => {
    const box = node('queue-private-mode');
    expect(box.checked).toBe(false); // 本地无缓存
    await settleChannel('ytvdlt:settings:get', { privateMode: true });
    expect(box.checked).toBe(true); // 主进程快照胜出并回写本地
    expect(win().localStorage.getItem('ytvdlt.privateMode')).toBe('true');
    box.checked = false;
    box.dispatch('change');
    expect(callsTo(SETTINGS_SET).at(-1)?.payload).toEqual({ privateMode: false });
    expect(node('queue-status').textContent).toBe(T('queue.status.privateOff'));
  });

  it('排序下拉持久化 ytvdlt.sort，非法值回退 newest', async () => {
    setList([
      wire({ id: 'srt1', state: 'Running', title: 'B', percent: 1 }),
      wire({ id: 'srt2', state: 'Completed', title: 'A', percent: 100 }),
    ]);
    await pollOnce();
    const sort = node('queue-sort');
    sort.value = 'oldest';
    sort.dispatch('change');
    expect(queue.model.sort).toBe('oldest');
    expect(win().localStorage.getItem('ytvdlt.sort')).toBe('oldest');
    sort.value = '不是合法值';
    sort.dispatch('change');
    expect(queue.model.sort).toBe('newest');
    expect(win().localStorage.getItem('ytvdlt.sort')).toBe('newest');
  });

  it('右键菜单：定位显示、delete 入口转 requestDelete、folder/detail 入口（D-87）', async () => {
    setList([
      wire({ id: 'ctx1', state: 'Running', percent: 1 }),
      wire({ id: 'ctx2', state: 'Completed', percent: 100 }),
    ]);
    await pollOnce();
    const menu = node('queue-context-menu');
    cardById('ctx1').dispatch('contextmenu', { preventDefault() { /* 已拦截 */ }, clientX: 12, clientY: 34 });
    expect(menu.getAttribute('hidden')).toBe('false');
    expect(String(menu.style.left)).toBe('12px');
    expect(String(menu.style.top)).toBe('34px');
    // delete 入口
    menu.dispatch('click', {
      target: { closest: () => ({ getAttribute: (key: string) => (key === 'data-ctx' ? 'delete' : null) }) },
    });
    expect(menu.getAttribute('hidden')).toBe('true');
    expect(node('queue-modal').getAttribute('hidden')).toBe('false');
    expect(node('queue-modal-count').textContent).toBe(T('queue.delete.count', { n: 1 }));
    node('queue-modal-cancel').dispatch('click');
    // folder 入口（Completed 卡才有 folder 能力）
    cardById('ctx2').dispatch('contextmenu', { preventDefault() { /* 已拦截 */ }, clientX: 5, clientY: 6 });
    menu.dispatch('click', {
      target: { closest: () => ({ getAttribute: (key: string) => (key === 'data-ctx' ? 'folder' : null) }) },
    });
    expect(callsTo(TASK_ACTION).at(-1)?.payload).toEqual({ taskId: 'ctx2', action: 'open-folder' });
    await settleChannel(TASK_ACTION, { ok: true });
    // detail 入口
    cardById('ctx2').dispatch('contextmenu', { preventDefault() { /* 已拦截 */ }, clientX: 5, clientY: 6 });
    menu.dispatch('click', {
      target: { closest: () => ({ getAttribute: (key: string) => (key === 'data-ctx' ? 'detail' : null) }) },
    });
    expect(String(win().location.href)).toContain('../task-detail/index.html?taskId=' + encodeURIComponent('ctx2'));
    win().location.href = 'file:///C:/app/pages/queue/index.html';
  });
});

// ---------------------------------------------------------------------------
// 族五 · 入队与预检（D-83 / D-137 / D-139 / D-160 / T5）
// ---------------------------------------------------------------------------
describe('D-187 · 单链接入队：payload 组装与预检生命周期', () => {
  it('downloadPayload：视频/音频形状随控件联动（D-83）', () => {
    queue.setKind('video');
    queue.choice.videoQuality = 'best';
    expect(queue.downloadPayload('https://example.com/v')).toEqual({
      url: 'https://example.com/v', kind: 'video', quality: 'best',
    });
    node('queue-quality').value = '720p';
    node('queue-quality').dispatch('change');
    expect(queue.choice.videoQuality).toBe('720p');
    expect(queue.downloadPayload('https://example.com/v').quality).toBe('720p');
    queue.setKind('audio');
    queue.choice.audioQuality = '192';
    node('queue-audio-format').value = 'mp3';
    node('queue-audio-format').dispatch('change');
    expect(queue.choice.audioFormat).toBe('mp3');
    expect(queue.downloadPayload('https://example.com/v')).toEqual({
      url: 'https://example.com/v', kind: 'audio', audioQuality: '192', audioFormat: 'mp3',
    });
    queue.setKind('什么都不是'); // 非法类型回退 video
    queue.setKind('video');
  });

  it('非法链接只提示，不发任何 IPC', () => {
    const before = globals!.bridgeCalls.length;
    queue.startRealDownload('ftp://不是链接');
    expect(node('queue-status').textContent).toBe(T('queue.notify.invalidUrl'));
    expect(node('ytvdlt-output').getAttribute('data-last-action')).toBe('live');
    expect(globals!.bridgeCalls.length).toBe(before);
  });

  it('SUPPORTED 判定直通 DOWNLOAD_START：载荷携带本次 operationId；取消条随回复退场（D-160）', async () => {
    currentVerdict = { state: 'SUPPORTED', blocks: false };
    node('queue-url').value = 'https://example.com/ok';
    queue.startRealDownload('https://example.com/ok');
    await drain();
    const check = callsTo(URL_SUPPORT_CHECK).at(-1)?.payload as Record<string, unknown>;
    expect(check.url).toBe('https://example.com/ok');
    expect(typeof check.operationId).toBe('string');
    // 预检窗口内取消条挂在 body（D-139：动态 DOM，静态基线零节点）。
    const bar = bodyChildById('queue-precheck-bar');
    expect(bar).toBeTruthy();
    // 判定通过 → DOWNLOAD_START 已发出，取消条仍在（等 enqueue 回复才收）。
    const start = callsTo(DOWNLOAD_START).at(-1)?.payload as Record<string, unknown>;
    expect(start).toMatchObject({
      url: 'https://example.com/ok', kind: 'video', quality: queue.choice.videoQuality,
    });
    expect(start.operationId).toBe(check.operationId);
    expect(bodyChildById('queue-precheck-bar')).toBeTruthy();
    await settleChannel(DOWNLOAD_START, { accepted: true, enqueued: true, taskIds: ['n1'] });
    expect(node('queue-status').textContent).toBe(T('queue.notify.enqueued', { n: 1 }));
    expect(node('queue-url').value).toBe('');
    expect(bodyChildById('queue-precheck-bar')).toBeNull();
  });

  it('blocks=true 的稳定码把链接挡在门外（D-137：site/item/未知原因三分）', async () => {
    const before = callsTo(DOWNLOAD_START).length;
    currentVerdict = { blocks: true, code: 'SITE_UNSUPPORTED' };
    queue.startRealDownload('https://example.com/bad-site');
    await drain();
    expect(node('queue-status').textContent).toBe(T('queue.precheck.blocked.site'));
    currentVerdict = { blocks: true, code: 'ITEM_UNSUPPORTED' };
    queue.startRealDownload('https://example.com/bad-item');
    await drain();
    expect(node('queue-status').textContent).toBe(T('queue.precheck.blocked.item'));
    currentVerdict = { blocks: true, code: 'WHATEVER', message: '引擎说不行' };
    queue.startRealDownload('https://example.com/bad-other');
    await drain();
    expect(node('queue-status').textContent)
      .toBe(T('queue.notify.enqueueFailed', { reason: '引擎说不行' }));
    expect(callsTo(DOWNLOAD_START).length).toBe(before);
  });

  it('PRECHECK_CANCELLED 判定终止一切：无确认框、无 DOWNLOAD_START（T5/D-160）', async () => {
    const before = callsTo(DOWNLOAD_START).length;
    currentVerdict = { code: 'PRECHECK_CANCELLED' };
    queue.startRealDownload('https://example.com/cc');
    await drain();
    expect(node('queue-status').textContent).toBe(T('queue.precheck.cancelled'));
    expect(callsTo(DOWNLOAD_START).length).toBe(before);
    expect(bodyChildById('queue-precheck-bar')).toBeNull();
  });

  it('NO_MEDIA 判定弹确认框：取消不入队；继续则入队并附 noMedia 提示（D-139）', async () => {
    currentVerdict = { state: 'NO_MEDIA', blocks: false };
    queue.startRealDownload('https://example.com/nm');
    await drain();
    const backdrop = modalBackdrop();
    expect(backdrop).toBeTruthy();
    const title = deepFind(backdrop!, (n) => n.tagName === 'H2');
    expect(title?.textContent).toBe(T('queue.precheck.confirm.title'));
    const message = deepFind(backdrop!, (n) => n.tagName === 'P');
    expect(message?.textContent).toBe(T('queue.precheck.confirm.noMedia'));
    const cancel = deepFind(backdrop!, (n) => n.tagName === 'BUTTON' && n.textContent === T('queue.precheck.confirm.cancel'));
    cancel?.dispatch('click');
    expect(modalBackdrop()).toBeNull();
    expect(node('queue-modal').getAttribute('hidden')).not.toBe('false');
    // 继续 → 入队 + NO_MEDIA 附注（D-137：非阻断判定的解释拼进成功提示）。
    queue.startRealDownload('https://example.com/nm2');
    await drain();
    const proceed = deepFind(modalBackdrop()!, (n) => n.tagName === 'BUTTON' && String((n as any).className) === 'primary');
    proceed?.dispatch('click');
    expect(callsTo(DOWNLOAD_START).at(-1)?.payload).toMatchObject({ url: 'https://example.com/nm2' });
    await settleChannel(DOWNLOAD_START, {
      accepted: true, enqueued: true, taskIds: ['n2'],
      support: { state: 'NO_MEDIA', blocks: false },
    });
    expect(node('queue-status').textContent)
      .toBe(T('queue.notify.enqueued', { n: 1 }) + ' · ' + T('queue.precheck.noMediaNotice'));
  });

  it('入队进行中重复提交被门闩忽略（enqueueing）', async () => {
    checkHold = true;
    queue.startRealDownload('https://example.com/dup');
    await drain();
    const checks = callsTo(URL_SUPPORT_CHECK).length;
    queue.startRealDownload('https://example.com/dup-2');
    expect(callsTo(URL_SUPPORT_CHECK).length).toBe(checks);
    await settleChannel(URL_SUPPORT_CHECK, { state: 'SUPPORTED', blocks: false });
    await settleChannel(DOWNLOAD_START, { accepted: true, enqueued: true, taskIds: ['dup'] });
    checkHold = false;
  });

  it('预检窗口点取消：checkCancel 带本次 operationId，判答复到达后不入队（T5）', async () => {
    const before = callsTo(DOWNLOAD_START).length;
    checkHold = true;
    queue.startRealDownload('https://example.com/stop');
    await drain();
    const operationId = (callsTo(URL_SUPPORT_CHECK).at(-1)?.payload as Record<string, unknown>).operationId;
    const bar = bodyChildById('queue-precheck-bar')!;
    const stop = deepFind(bar, (n) => n.getAttribute('id') === 'queue-precheck-cancel')!;
    stop.dispatch('click');
    expect(callsTo(URL_SUPPORT_CHECK_CANCEL).at(-1)?.payload).toEqual({ operationId });
    expect(stop.getAttribute('disabled')).toBe('disabled');
    expect(deepFind(bar, (n) => n.getAttribute('id') === 'queue-precheck-bar-text')?.textContent)
      .toBe(T('queue.precheck.cancelling'));
    // 判答复到达：用户已说停 → 就地终止。
    await settleChannel(URL_SUPPORT_CHECK, { state: 'SUPPORTED', blocks: false });
    expect(node('queue-status').textContent).toBe(T('queue.precheck.cancelled'));
    expect(callsTo(DOWNLOAD_START).length).toBe(before);
    expect(bodyChildById('queue-precheck-bar')).toBeNull();
    checkHold = false;
  });

  it('桥拒绝 / 同步抛错时 call() 归一化成 IPC_ERROR，入队失败走统一文案', async () => {
    const liveBridge = win().ytvdltBridge;
    win().ytvdltBridge = { invoke: () => Promise.reject(new Error('ipc-down')) };
    queue.startRealDownload('https://example.com/reject');
    await drain();
    // 拒绝路径：reason 归一化成 error.message 原文。
    expect(node('queue-status').textContent)
      .toBe(T('queue.notify.enqueueFailed', { reason: 'ipc-down' }));
    win().ytvdltBridge = { invoke: () => { throw new Error('sync-boom'); } };
    queue.startRealDownload('https://example.com/throw');
    await drain();
    // 同步抛错路径：try/catch 归一化，reason 是通用 IPC 文案。
    expect(node('queue-status').textContent)
      .toBe(T('queue.notify.enqueueFailed', { reason: T('queue.notify.ipc') }));
    win().ytvdltBridge = liveBridge;
  });

  it('桥不可用：走静态 legacy 直发分支，call 返回 BRIDGE_UNAVAILABLE（不发 wire 调用）', async () => {
    const liveBridge = win().ytvdltBridge;
    const beforeCheck = callsTo(URL_SUPPORT_CHECK).length;
    win().ytvdltBridge = null;
    queue.startRealDownload('https://example.com/legacy');
    await drain();
    // legacy 分支没有预检。
    expect(callsTo(URL_SUPPORT_CHECK).length).toBe(beforeCheck);
    expect(node('queue-status').textContent)
      .toBe(T('queue.notify.enqueueFailed', { reason: T('queue.notify.bridge') }));
    win().ytvdltBridge = liveBridge;
  });
});

// ---------------------------------------------------------------------------
// 族五点五 · 粘贴入口的 live 显式处理（D-80：不再依赖原生表单语义）
// ---------------------------------------------------------------------------
describe('D-187 · 粘贴入口在 live 模式下的显式入队（D-80）', () => {
  it('queue-paste-form submit：preventDefault 后走 startRealDownload 预检链路', async () => {
    currentVerdict = { state: 'SUPPORTED', blocks: false };
    node('queue-url').value = 'https://example.com/form';
    node('queue-paste-form').dispatch('submit', { preventDefault() { /* 已拦截 */ } });
    await drain();
    expect(callsTo(URL_SUPPORT_CHECK).at(-1)?.payload).toMatchObject({ url: 'https://example.com/form' });
    await settleChannel(DOWNLOAD_START, { accepted: true, enqueued: true, taskIds: ['form1'] });
    expect(node('queue-url').value).toBe('');
  });

  it('queue-paste 点击：live 下显式 preventDefault 并入队（回车之外的路径）', () => {
    const before = globals!.bridgeCalls.length;
    node('queue-url').value = 'ftp://bad';
    node('queue-paste').dispatch('click', { preventDefault() { /* 已拦截 */ } });
    expect(node('queue-status').textContent).toBe(T('queue.notify.invalidUrl'));
    expect(globals!.bridgeCalls.length).toBe(before);
  });

  it('queue-new 点击：空框提示先粘贴，有内容则入队（非法链接就地拒绝）', () => {
    node('queue-url').value = '';
    node('queue-new').dispatch('click');
    expect(node('queue-status').textContent).toBe(T('queue.notify.pasteHint'));
    node('queue-url').value = 'ftp://bad';
    node('queue-new').dispatch('click');
    expect(node('queue-status').textContent).toBe(T('queue.notify.invalidUrl'));
    node('queue-url').value = '';
  });

  it('queue-empty-cta 点击：空框提示粘贴，有内容则走入队链路', async () => {
    currentVerdict = { state: 'SUPPORTED', blocks: false };
    node('queue-url').value = '';
    node('queue-empty-cta').dispatch('click');
    expect(node('queue-status').textContent).toBe(T('queue.notify.pasteHint'));
    node('queue-url').value = 'https://example.com/cta';
    node('queue-empty-cta').dispatch('click');
    await drain();
    expect(callsTo(URL_SUPPORT_CHECK).at(-1)?.payload).toMatchObject({ url: 'https://example.com/cta' });
    await settleChannel(DOWNLOAD_START, { accepted: true, enqueued: true, taskIds: ['cta1'] });
    node('queue-url').value = '';
  });
});

// ---------------------------------------------------------------------------
// 族六 · 语言切换与视图持久化（D-85 / D-106）
// ---------------------------------------------------------------------------
describe('D-187 · 语言切换整页重载语义与视图持久化', () => {
  it('locale()：?lang= 优先（en 前缀规则），其次持久化值（D-85）', () => {
    win().location.search = '?lang=en-US';
    expect(queue.locale()).toBe('en');
    win().location.search = '?lang=fr';
    expect(queue.locale()).toBe('zh-CN');
    win().location.search = '?prefill=https%3A%2F%2Fexample.com%2Fwatch%3Fv%3Dabc';
    win().localStorage.setItem('ytvdlt.locale', 'en');
    expect(queue.locale()).toBe('en');
    win().localStorage.removeItem('ytvdlt.locale');
    expect(queue.locale()).toBe('zh-CN');
  });

  it('switchLocale：持久化 + SETTINGS_SET + location.replace 整页重载（D-85）', () => {
    const replaced: string[] = [];
    (win().location as { replace?: (url: string) => void }).replace = (url: string) => { replaced.push(url); };
    queue.switchLocale('en');
    expect(win().localStorage.getItem('ytvdlt.locale')).toBe('en');
    expect(callsTo(SETTINGS_SET).at(-1)?.payload).toEqual({ language: 'en' });
    const base = String(win().location.href).replace(/[?&]lang=[^&]*/g, '');
    expect(replaced.at(-1)).toBe(base + '?lang=en');
    queue.switchLocale('zh-CN');
    expect(replaced.at(-1)).toBe(base); // 中文回到不带 lang 的地址
    queue.switchLocale('什么');
    expect(win().localStorage.getItem('ytvdlt.locale')).toBe('zh-CN');
  });

  it('saveView：分类切换 / 滚动 / pagehide 都把视图快照交给 nav（D-106）', () => {
    queue.selectTab('finished');
    const saved = JSON.parse(win().localStorage.getItem('ytvdlt.queue.view') as string);
    expect(saved.tab).toBe('finished');
    expect(Array.isArray(saved.selected)).toBe(true);
    node('queue-body').scrollTop = 321;
    node('queue-body').dispatch('scroll');
    const saved2 = JSON.parse(win().localStorage.getItem('ytvdlt.queue.view') as string);
    expect(saved2.scroll).toBe(321);
    win().dispatch('pagehide');
    expect(win().localStorage.getItem('ytvdlt.queue.view')).toBeTruthy();
    queue.selectTab('all'); // 复位，后续用例回到全部
  });

  it('非法分类不生效；全屏按钮绑定到 nav 权威（D-106）', () => {
    queue.selectTab('不存在的分类');
    expect(queue.model.tab).toBe('all');
    expect(node('queue-fullscreen').listeners.click?.length ?? 0).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 族七 · TXT / playlist / 支持站点挂载面（D-129 / D-130 / D-134 / Stage 5）
// ---------------------------------------------------------------------------
describe('D-187 · live 组件挂载面：惰性 script 标签与工厂注入', () => {
  it('引导即为四个 live 组件创建惰性 script 标签，且组件一律未挂载（冻结基线零节点）', () => {
    const srcs = (globals!.document.head as UiNode).children
      .filter((n) => n.tagName === 'SCRIPT')
      .map((n) => n.getAttribute('src'));
    expect(srcs).toEqual(expect.arrayContaining([
      '../../subtitles/subtitle-picker.js',
      '../../txt-import/txt-import.js',
      '../../playlists/playlist-import.js',
      '../../sites/supported-sites.js',
    ]));
    expect(queue.subtitlePicker()).toBeNull();
    expect(queue.txtImport()).toBeNull();
    expect(queue.playlistImport()).toBeNull();
  });

  it('字幕选择器：error 先提示不可用，load 后按注入工厂挂载并联 url/kind（Stage 5）', () => {
    const tag = deepFind(
      globals!.document.head as UiNode,
      (n) => n.getAttribute('src') === '../../subtitles/subtitle-picker.js',
    )!;
    tag.dispatch('error');
    expect(node('queue-status').textContent).toBe(T('subtitle.error.unavailable'));
    const configs: any[] = [];
    const picker = {
      mountCalls: [] as unknown[],
      urlChanged: [] as string[],
      kindCalls: 0,
      mount(...args: unknown[]) { this.mountCalls.push(args); },
      onUrlChanged(url: string) { this.urlChanged.push(url); },
      setKind() { this.kindCalls += 1; },
      getSelection: () => currentSelection,
      onEnqueueResult: () => ticketMessage,
    };
    pickerRef = picker;
    (win().YTVDLT as Record<string, unknown>).subtitles = { create: (config: unknown) => { configs.push(config); return picker; } };
    tag.dispatch('load');
    expect(queue.subtitlePicker()).toBe(picker);
    expect(picker.mountCalls[0]).toEqual([
      node('queue-paste-form'), '../../styles/subtitles.css', node('queue-paste'),
    ]);
    const config = configs[0];
    expect(config.doc).toBe(globals!.document);
    expect(config.getUrl()).toBe(node('queue-url').value);
    expect(config.getKind()).toBe('video');
    // 输入框联动：URL 变化必须通知 picker 失效票据。
    node('queue-url').value = 'https://example.com/changed';
    node('queue-url').dispatch('input');
    expect(picker.urlChanged.at(-1)).toBe('https://example.com/changed');
    node('queue-url').value = '';
    // 音频模式不能嵌字幕 → setKind 门同步。
    queue.setKind('audio');
    expect(picker.kindCalls).toBe(1);
    queue.setKind('video');
  });

  it('TXT 导入：load 后挂载，config 携带 getChoice/refresh/回退入口（D-129）', async () => {
    queue.mountSubtitlePicker(); // 无参守卫：不抛、不重复挂载
    const configs: any[] = [];
    let mountArgs: unknown[] = [];
    (win().YTVDLT as Record<string, unknown>).txtImport = {
      create: (config: unknown) => {
        configs.push(config);
        return { mount: (...args: unknown[]) => { mountArgs = args; } };
      },
    };
    deepFind(globals!.document.head as UiNode, (n) => n.getAttribute('src') === '../../txt-import/txt-import.js')!
      .dispatch('load');
    expect(queue.txtImport()).toBeTruthy();
    expect(mountArgs).toEqual([node('queue-paste-form'), '../../styles/txt-import.css']);
    // 批次必须继承与单链接一致的类型/清晰度选择。
    queue.setKind('audio');
    queue.choice.audioQuality = '128';
    const inherited = configs[0].getChoice();
    expect(inherited).toEqual({
      kind: 'audio',
      videoQuality: queue.choice.videoQuality,
      audioQuality: '128',
      audioFormat: queue.choice.audioFormat,
    });
    queue.setKind('video');
    // refresh 接线即页面的真实 refresh。
    const before = callsTo(TASK_LIST).length;
    configs[0].refresh();
    await drain();
    expect(callsTo(TASK_LIST).length).toBeGreaterThan(before);
    queue.mountTxtImport({ create() { throw new Error('不应二次挂载'); } }); // 已挂载 → 守卫
    queue.ensureTxtImport(); // 已挂载 → 守卫
  });

  it('playlist 选择器挂载 + startRealDownload 路由：isPlaylistLike → open，否则走单链接（D-130）', async () => {
    let playlistLike = true;
    const opened: string[] = [];
    let mountArgs: unknown[] = [];
    let playlistConfig: any = null;
    (win().YTVDLT as Record<string, unknown>).playlists = {
      create: (config: unknown) => {
        playlistConfig = config;
        return {
          mount: (...args: unknown[]) => { mountArgs = args; },
          isPlaylistLike: (url: string) => playlistLike,
          open: (url: string) => { opened.push(url); },
        };
      },
    };
    deepFind(globals!.document.head as UiNode, (n) => n.getAttribute('src') === '../../playlists/playlist-import.js')!
      .dispatch('load');
    expect(queue.playlistImport()).toBeTruthy();
    expect(mountArgs).toEqual([node('queue-paste-form'), '../../styles/playlist-import.css']);
    // 批量入队同样继承当前类型/清晰度选择。
    queue.setKind('audio');
    queue.choice.audioQuality = '64';
    expect(playlistConfig.getChoice()).toEqual({
      kind: 'audio',
      videoQuality: queue.choice.videoQuality,
      audioQuality: '64',
      audioFormat: queue.choice.audioFormat,
    });
    queue.setKind('video');
    // 回退入口 / 读框是 playlist 配置的接线面。
    playlistConfig.startSingleDownload('ftp://bad');
    expect(node('queue-status').textContent).toBe(T('queue.notify.invalidUrl'));
    expect(playlistConfig.readUrl()).toBe(node('queue-url').value);
    // 播放列表形 URL → open，不经过单链接预检。
    const beforeCheck = callsTo(URL_SUPPORT_CHECK).length;
    queue.startRealDownload('https://example.com/playlist');
    expect(opened).toEqual(['https://example.com/playlist']);
    expect(callsTo(URL_SUPPORT_CHECK).length).toBe(beforeCheck);
    // 非播放列表 URL → 回退单链接（配置里的 startSingleDownload 也要能走通）。
    currentVerdict = { state: 'SUPPORTED', blocks: false };
    playlistLike = false;
    playlistConfig.startSingleDownload('https://example.com/plain');
    await drain();
    expect(callsTo(URL_SUPPORT_CHECK).length).toBe(beforeCheck + 1);
    expect(callsTo(URL_SUPPORT_CHECK).at(-1)?.payload).toMatchObject({ url: 'https://example.com/plain' });
    await settleChannel(DOWNLOAD_START, { accepted: true, enqueued: true, taskIds: ['pl'] });
    queue.ensurePlaylistImport(); // 已挂载 → 守卫
  });

  it('支持站点面板：error 复位后仍可 load 挂载（D-134）', () => {
    const tag = deepFind(
      globals!.document.head as UiNode,
      (n) => n.getAttribute('src') === '../../sites/supported-sites.js',
    )!;
    tag.dispatch('error'); // 载入失败静默复位（真实标签只会触发其一，这里覆盖两个分支）
    let mountedArgs: unknown[] = [];
    (win().YTVDLT as Record<string, unknown>).supportedSites = {
      create: () => ({ mount: (...args: unknown[]) => { mountedArgs = args; } }),
    };
    tag.dispatch('load');
    expect(mountedArgs).toEqual([node('queue-paste-form'), '../../styles/supported-sites.css']);
  });

  it('字幕票：selection 有效时载荷携带六个字幕键；selection=false 直接拒绝', () => {
    currentSelection = {
      previewId: 'pv1', subtitleLanguages: ['zh-Hans'], subtitleAutoCaptions: true,
      subtitleConvertTo: 'srt', subtitleEmbed: false, subtitleKeepFile: true,
    };
    expect(queue.downloadPayload('https://example.com/sub')).toEqual({
      url: 'https://example.com/sub', kind: 'video', quality: queue.choice.videoQuality,
      previewId: 'pv1', subtitleLanguages: ['zh-Hans'], subtitleAutoCaptions: true,
      subtitleConvertTo: 'srt', subtitleEmbed: false, subtitleKeepFile: true,
    });
    currentSelection = false;
    expect(queue.downloadPayload('https://example.com/sub')).toBeNull();
    currentSelection = null;
  });

  it('字幕票失效：onEnqueueResult 的消息优先于成功提示，输入框不清空', async () => {
    currentVerdict = { state: 'SUPPORTED', blocks: false };
    ticketMessage = '字幕票已失效，本次未带字幕。';
    node('queue-url').value = 'https://example.com/ticket';
    queue.startRealDownload('https://example.com/ticket');
    await drain();
    await settleChannel(DOWNLOAD_START, { accepted: true, enqueued: true, taskIds: ['s1'] });
    expect(node('queue-status').textContent).toBe('字幕票已失效，本次未带字幕。');
    expect(node('queue-url').value).toBe('https://example.com/ticket'); // 早退：不清框
    ticketMessage = null;
  });

  it('带字幕选择器的成功入队：清空输入并通知 picker 票据失效', async () => {
    currentVerdict = { state: 'SUPPORTED', blocks: false };
    node('queue-url').value = 'https://example.com/with-picker';
    queue.startRealDownload('https://example.com/with-picker');
    await drain();
    await settleChannel(DOWNLOAD_START, { accepted: true, enqueued: true, taskIds: ['s2'] });
    expect(node('queue-status').textContent).toBe(T('queue.notify.enqueued', { n: 1 }));
    expect(node('queue-url').value).toBe('');
    expect(pickerRef.urlChanged.at(-1)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 族八 · Star prompt（D-148：首答武装、忙不打扰、每会话一次 CHECK、枚举应答）
// ---------------------------------------------------------------------------
describe('D-187 · D-148 Star prompt 生命周期', () => {
  it('忙队列下定时器只重调度，绝不发出 CHECK（红钱：不打断下载）', async () => {
    handlers.set(STAR_PROMPT_CHECK, () => ({ show: starShow }));
    setList([wire({ id: 'busy1', state: 'Running', percent: 10 })]);
    await pollOnce();
    expect(queue.starPrompt().scheduled).toBe(true);
    queue.maybeCheckStarPrompt(); // 忙 → 只重调度
    expect(queue.starPrompt().checked).toBe(false);
    expect(queue.starPrompt().scheduled).toBe(true);
    expect(callsTo(STAR_PROMPT_CHECK).length).toBe(0);
    // 定时器到点时队列仍忙 → 依旧只重调度。
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callsTo(STAR_PROMPT_CHECK).length).toBe(0);
    expect(queue.starPrompt().checked).toBe(false);
    expect(queue.starPrompt().scheduled).toBe(true);
  });

  it('空闲队列到点 CHECK 恰好一次；show=false 不弹窗（D-148）', async () => {
    starShow = false;
    setList([wire({ id: 'idle1', state: 'Completed', percent: 100 })]);
    await pollOnce();
    for (let i = 0; i < 5 && queue.starPrompt().checked === false; i += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(queue.starPrompt().checked).toBe(true);
    expect(callsTo(STAR_PROMPT_CHECK).length).toBeGreaterThanOrEqual(1);
    expect(callsTo(STAR_PROMPT_CHECK)[0]?.payload).toEqual({});
    expect(queue.starPrompt().shown).toBe(false);
    expect(bodyChildById('ytvdlt-star-prompt')).toBeNull();
  });

  it('showStarPrompt：对话框挂到 body，三个枚举应答 + 背景点击=later，应答后关闭', async () => {
    queue.showStarPrompt();
    const backdrop = bodyChildById('ytvdlt-star-prompt');
    expect(backdrop).toBeTruthy();
    expect(backdrop?.getAttribute('role')).toBe('dialog');
    expect(backdrop?.getAttribute('aria-modal')).toBe('true');
    const buttons = deepAll(backdrop!, (n) => n.tagName === 'BUTTON');
    expect(buttons.map((b) => b.textContent)).toEqual([
      T('starPrompt.star'), T('starPrompt.later'), T('starPrompt.never'),
    ]);
    // 应答只在 IPC 回复落地后关闭对话框；利用这个窗口断言三个枚举与背景 later。
    buttons[0]?.dispatch('click');
    buttons[1]?.dispatch('click');
    buttons[2]?.dispatch('click');
    backdrop?.dispatch('click', { target: backdrop });
    const actions = callsTo(STAR_PROMPT_ACTION).slice(-4).map((c) => (c.payload as { action: string }).action);
    expect(actions).toEqual(['star', 'later', 'never', 'later']);
    for (const button of buttons) expect((button as any).disabled).toBe(true);
    await settleChannel(STAR_PROMPT_ACTION, { ok: true });
    expect(queue.starPrompt().dialogOpen).toBe(false);
    expect(bodyChildById('ytvdlt-star-prompt')).toBeNull();
  });

  it('每会话一次：应答后再 show / 再 check 都是空操作，终态快照稳定（D-148）', () => {
    queue.showStarPrompt();
    expect(queue.starPrompt().dialogOpen).toBe(false); // shown=true → 不再弹
    queue.maybeCheckStarPrompt(); // checked=true → 不再问
    queue.scheduleStarPrompt(1000); // checked=true → 不再排程
    expect(queue.starPrompt()).toEqual({ shown: true, checked: true, dialogOpen: false, scheduled: false });
  });
});

// ---------------------------------------------------------------------------
// 已知残余（不追覆盖率）：
//  - `emit()` 及其调用分支只在「无桥静态预览点击」下可达，live 单实例到不了；
//  - `shell.boot` 注册的快捷键回调（paste-parse / new-download / search /
//    nav-1..4 / refresh）需要真实 keydown，假 document 的事件监听是空转的；
//  - 文档级监听（菜单外点关闭 / Escape / visibilitychange）同理；
//  - `subtitlePicker` 配置里的 onSelectionChange 由真实 picker 组件调用。
// 这些分支由 runInNewContext 系语义测试与冻结截图基线守护。
// ---------------------------------------------------------------------------
