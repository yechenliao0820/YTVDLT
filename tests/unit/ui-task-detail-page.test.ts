/**
 * D-187 · pages/task-detail/task-detail.js（任务详情页）真实行为单测 —— import 路线，v8 覆盖率可见。
 *
 * 【为什么是 import 而不是 runInNewContext】既有语义单测 task-detail-live-fixture.test.ts
 * （D-141 live 不闪截图夹具、D-146 live 取消矩阵）与 task-detail.test.ts（主进程七动作）
 * 分别走 VM 沙箱 / 纯主进程，v8 覆盖率统计不到页面脚本本身；本文件用共享装载架
 * tests/unit/helpers/ui-harness.ts（installUiGlobals + 真实 `await import()`）把页面
 * 脚本纳入覆盖率统计，并按 import 路线保住上述钉点。
 *
 * 【三个世界】task-detail.js 是单实例 IIFE：`live`（桥存在且 ?taskId= 非空）与
 * `current` 等状态在 import 时刻定格，ESM 注册表按文件缓存。为同时覆盖静态基线
 * 分支与 live 分支，本文件按顺序装载三个世界 —— 每个世界先 restore 上一批全局、
 * `vi.resetModules()` 清模块注册表、重装 globals 后重新 import：
 *   A. 静态 SAMPLE（无桥无注入）→ file:// 截图基线分支：paint(SAMPLE) + emit；
 *   B. 静态注入任务 + ?empty=1 → task() 注入分支 + showMissing(true)；
 *   C. live（可编程桥 + ?taskId=t9）→ blankFixture / TASK_DETAIL / 七动作 /
 *      D-87 删除确认框 / D-80 返回链接。
 *
 * 【测试面】页面自暴露 `YTVDLTDetail = { availability, actions, live, current }`；
 * 桥是可编程 deferred（TASK_DETAIL 支持挂起引导调用、按序应答队列与拒绝/抛错模式），
 * 语义对齐 task-detail-live-fixture.test.ts 钉过的 D-141/D-146 矩阵。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  installUiGlobals, loadUiModule, uiNode,
  type UiGlobals, type UiNode,
} from './helpers/ui-harness.js';

type TestNode = UiNode & { parentNode: TestNode | null };

const ACTIONS = ['open-file', 'open-folder', 'copy-url', 'copy-error-report', 'cancel', 'remove', 'retry'];

/** 每个世界都要预置的页面静态节点（index.html 的 id 集合）。 */
const PAGE_IDS = [
  'ytvdlt-task-detail', 'detail-empty', 'detail-body', 'detail-actions',
  'detail-id', 'detail-state', 'detail-progress', 'detail-code',
  'detail-artifacts', 'detail-url', 'ytvdlt-output',
] as const;

let globals: UiGlobals | null = null;
let T: (key: string, params?: Record<string, unknown>) => string;

/**
 * 世界级文档增强（纯测试侧协作桩，不改 harness）：
 *  - getElementById 对未知 id 返回 null（真实 DOM 如此；否则 `detail-back` 的
 *    防重复守卫会被 harness 的自动建节点骗过，返回链接永远装不上）；
 *  - createElement 产出的节点带 id 访问器并注册进 byId 表（remove-modal / back）；
 *  - querySelector 稳定解析 `[data-action="…"]`（paint 与事件绑定必须命中同一节点）。
 */
let byId: (id: string) => TestNode | null = () => null;

function enhanceDoc(g: UiGlobals): void {
  const localById = new Map<string, TestNode>();
  const doc = g.document as any;
  const rawCreate = doc.createElement.bind(doc);
  doc.createElement = (tag?: string): TestNode => {
    const n = rawCreate(tag ?? 'div') as TestNode;
    Object.defineProperty(n, 'id', {
      get: () => n.attrs['id'] ?? '',
      set: (value: string) => { n.attrs['id'] = String(value); localById.set(String(value), n); },
      configurable: true,
    });
    return n;
  };
  doc.getElementById = (id: string): UiNode | null => g.nodes.get(id) ?? localById.get(id) ?? null;
  const actionNodes = new Map<string, TestNode>();
  for (const action of ACTIONS) {
    const button = doc.createElement('button') as TestNode;
    button.setAttribute('data-action', action);
    actionNodes.set(action, button);
  }
  doc.querySelector = (selector: string): UiNode | null => {
    const m = /\[data-action="([^"]+)"\]/.exec(String(selector));
    return m === null ? null : actionNodes.get(m[1]) ?? null;
  };
  byId = (id: string) => localById.get(id) ?? null;
}

function seededElements(): Record<string, UiNode> {
  return Object.fromEntries(PAGE_IDS.map((id) => [id, uiNode(id === 'ytvdlt-output' ? 'pre' : 'div')]));
}

async function tick(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function detail(key: string): TestNode {
  return globals!.nodes.get(key) as TestNode;
}
function actionNode(action: string): TestNode {
  return (globals!.document.querySelector(`[data-action="${action}"]`) ?? null) as TestNode;
}
function ariaOf(action: string): string | null {
  return actionNode(action).getAttribute('aria-disabled');
}
function outputText(): string {
  return String(detail('ytvdlt-output').textContent);
}

// ---------------------------------------------------------------------------

describe('D-187 · 世界 A：静态 SAMPLE 基线（file:// 截图路径，无桥）', () => {
  let page: any; // YTVDLTDetail

  beforeAll(async () => {
    vi.useFakeTimers();
    globals = installUiGlobals({ bridge: null, elements: seededElements() });
    enhanceDoc(globals);
    await loadUiModule('i18n/messages.js', globals);
    await loadUiModule('i18n/i18n.js', globals);
    await loadUiModule('pages/task-detail/task-detail.js', globals);
    const win = globals.window as any;
    T = (key, params) => String(win.YTVDLT.i18n.t(key, params));
    page = win.YTVDLTDetail;
  });

  afterAll(() => {
    globals?.restore();
    globals = null;
    vi.useRealTimers();
  });

  it('真实 import 后暴露 YTVDLTDetail 测试面；SAMPLE 夹具直接呈现（截图基线不变）', () => {
    expect(page).toBeTruthy();
    expect(page.live).toBe(false);
    expect(page.actions).toEqual(ACTIONS);
    expect(page.current.model).toMatchObject({ id: 't1', state: 'Error', percent: 42 });
    expect(detail('detail-id').textContent).toBe('t1');
    expect(detail('detail-state').textContent).toBe('Error');
    expect(detail('detail-progress').textContent).toBe('42%');
    expect(detail('detail-code').textContent).toBe('HTTP_403');
    expect(detail('detail-artifacts').textContent).toBe('C:/V/fixture.mp4');
    expect(detail('detail-url').textContent).toBe('https://example.org/v?token=***');
    expect(detail('ytvdlt-task-detail').getAttribute('data-state')).toBe('error');
    // live 专属注入不出现：无返回链接、无删除确认框
    expect(byId('detail-back')).toBeNull();
    expect(byId('detail-remove-modal')).toBeNull();
  });

  it('七个动作的 aria-disabled 按静态旧规则矩阵（Error 卡：cancel 不可用）', () => {
    expect(ariaOf('open-file')).toBe('false');
    expect(ariaOf('open-folder')).toBe('false');
    expect(ariaOf('copy-url')).toBe('false');
    expect(ariaOf('copy-error-report')).toBe('false');
    expect(ariaOf('cancel')).toBe('true');
    expect(ariaOf('remove')).toBe('false');
    expect(ariaOf('retry')).toBe('false');
  });

  it('emit：可用动作产出动作 JSON（逐一验证），不可用动作零输出', () => {
    const output = detail('ytvdlt-output');
    output.textContent = '{}';
    actionNode('cancel').dispatch('click'); // current.enabled.cancel = false → 守卫
    expect(outputText()).toBe('{}');
    for (const action of ['open-file', 'open-folder', 'copy-url', 'copy-error-report', 'remove', 'retry'] as const) {
      actionNode(action).dispatch('click');
      expect(JSON.parse(outputText())).toEqual({ action, taskId: 't1', accepted: true });
    }
  });

  it('availability 纯函数：静态分支（旧规则，含 ReadyWithInfo 可取消）与 live 分支（D-146/D-162/D-164）', () => {
    const { availability } = page;
    // 静态分支（截图基线语义）：Running/FetchingInfo/ReadyWithInfo 可取消
    expect(availability({ state: 'Running', artifacts: [] }, false)).toMatchObject({
      'open-file': false, 'open-folder': false, 'copy-url': true,
      'copy-error-report': false, cancel: true, remove: false, retry: false,
    });
    expect(availability({ state: 'FetchingInfo', artifacts: [] }, false).cancel).toBe(true);
    expect(availability({ state: 'ReadyWithInfo', artifacts: [] }, false).cancel).toBe(true);
    expect(availability({ state: 'Queued', artifacts: [] }, false).cancel).toBe(false);
    expect(availability({ state: 'Canceled', artifacts: [] }, false).retry).toBe(true);
    // live 分支（D-146 矩阵）：下载句柄存在才可取消
    expect(availability({ state: 'Running', artifacts: [] }, true).cancel).toBe(true);
    expect(availability({ state: 'FetchingInfo', artifacts: [] }, true).cancel).toBe(true);
    expect(availability({ state: 'Idle', pending: true, artifacts: [] }, true).cancel).toBe(true);
    expect(availability({ state: 'Idle', artifacts: [] }, true).cancel).toBe(false);
    expect(availability({ state: 'ReadyWithInfo', artifacts: [] }, true).cancel).toBe(false);
    expect(availability({ state: 'Completed', artifacts: ['C:/x.mp4'] }, true)).toMatchObject({
      'open-file': true, 'open-folder': true, cancel: false, remove: true, retry: false,
    });
  });
});

describe('D-187 · 世界 B：静态注入任务 + ?empty=1（task() 注入分支与缺任务态）', () => {
  beforeAll(async () => {
    vi.useFakeTimers();
    vi.resetModules(); // 清掉世界 A 的模块实例：task-detail.js 的 live/current 随 import 定格
    globals = installUiGlobals({
      bridge: null,
      location: { href: 'file:///C:/app/pages/task-detail/index.html', search: '?taskId=inj-1&empty=1', protocol: 'file:' },
      injected: {
        __YTVDLT_TASK__: {
          id: 'inj-1', state: 'Running', percent: 7, errorCode: null,
          artifacts: ['C:/a/1.mp4', 'C:/a/2.mp4'], url: 'https://example.org/inj',
        },
      },
      elements: seededElements(),
    });
    enhanceDoc(globals);
    await loadUiModule('i18n/messages.js', globals);
    await loadUiModule('i18n/i18n.js', globals);
    await loadUiModule('pages/task-detail/task-detail.js', globals);
    const win = globals.window as any;
    T = (key, params) => String(win.YTVDLT.i18n.t(key, params));
  });

  afterAll(() => {
    globals?.restore();
    globals = null;
    vi.useRealTimers();
  });

  it('__YTVDLT_TASK__ 注入优先于 SAMPLE：注入记录整卡呈现', () => {
    expect(detail('detail-id').textContent).toBe('inj-1');
    expect(detail('detail-state').textContent).toBe('Running');
    expect(detail('detail-progress').textContent).toBe('7%');
    expect(detail('detail-code').textContent).toBe('—'); // errorCode null → 占位
    expect(detail('detail-artifacts').textContent).toBe('C:/a/1.mp4\nC:/a/2.mp4');
    expect(detail('detail-url').textContent).toBe('https://example.org/inj');
    // 静态旧规则：Running 可取消、不可删、不可重试；有产物 → 文件入口可用
    expect(ariaOf('cancel')).toBe('false');
    expect(ariaOf('remove')).toBe('true');
    expect(ariaOf('retry')).toBe('true');
    expect(ariaOf('copy-error-report')).toBe('true');
    expect(ariaOf('open-file')).toBe('false');
    expect(ariaOf('open-folder')).toBe('false');
  });

  it('?empty=1：缺任务态压过记录状态（body/actions 隐藏、empty 显形），emit 照常可走', () => {
    const root = detail('ytvdlt-task-detail');
    expect(root.getAttribute('data-state')).toBe('empty'); // showMissing(true) 最后生效
    expect(detail('detail-body').getAttribute('hidden')).toBe('true');
    expect(detail('detail-actions').getAttribute('hidden')).toBe('true');
    expect(detail('detail-empty').getAttribute('hidden')).toBe('false');
    detail('ytvdlt-output').textContent = '{}';
    actionNode('copy-url').dispatch('click');
    expect(JSON.parse(outputText())).toEqual({ action: 'copy-url', taskId: 'inj-1', accepted: true });
  });
});

describe('D-187 · 世界 C：live 模式（D-141 不闪夹具 / D-146 取消矩阵 / D-87 删除确认 / D-80 返回链接）', () => {
  const REAL_TASK = {
    id: 't9', state: 'Error', percent: 12, errorCode: 'HTTP_403',
    artifacts: ['C:/real/video.mp4'], url: 'https://example.org/real',
  };
  const DEFAULT_DETAIL = { found: true, task: REAL_TASK };
  const QUEUE_URL_NAV = '../queue/index.html?lang=en';
  const DETAIL_HREF = 'file:///C:/app/pages/task-detail/index.html';

  // ---- 可编程桥：全部调用登记为 deferred；TASK_DETAIL 支持挂起 / 队列 / 拒绝 / 抛错 ----
  interface Deferred { channel: string; payload: unknown; settled: boolean; settle(v: unknown): void; }
  const pending: Deferred[] = [];
  let bootDetailEntry: Deferred | null = null; // 引导期 TASK_DETAIL：D-141 专属用例手工应答
  const bridgeState = {
    holdDetail: true,
    detailQueue: [] as unknown[],
    detailDefault: DEFAULT_DETAIL as unknown,
    detailMode: 'auto' as 'auto' | 'reject' | 'throw',
    actionReply: { ok: true } as unknown,
    actionMode: 'auto' as 'auto' | 'reject' | 'throw',
  };
  const bridgeStub = {
    invoke(channel: string, payload?: unknown): Promise<unknown> {
      if (bridgeState.actionMode === 'throw' || bridgeState.detailMode === 'throw') {
        throw new Error('sync boom');
      }
      let resolve!: (value: unknown) => void;
      const promise = new Promise<unknown>((res) => { resolve = res; });
      const entry: Deferred = {
        channel, payload, settled: false,
        settle(v: unknown) { if (!entry.settled) { entry.settled = true; resolve(v); } },
      };
      pending.push(entry);
      if (channel === 'ytvdlt:task:detail') {
        if (bridgeState.detailMode === 'reject') entry.settle({ ok: false, message: 'detail down' });
        else if (!bridgeState.holdDetail) {
          const reply = bridgeState.detailQueue.length > 0
            ? bridgeState.detailQueue.shift()
            : bridgeState.detailDefault;
          entry.settle(reply);
        }
        return promise;
      }
      if (bridgeState.actionMode === 'reject') entry.settle({ ok: false, message: 'boom' });
      else entry.settle(bridgeState.actionReply);
      return promise;
    },
  };
  const callsOn = (channel: string) => pending.filter((p) => p.channel === channel);
  async function settleDetailAt(index: number, value: unknown): Promise<void> {
    const entry = pending.filter((p) => p.channel === 'ytvdlt:task:detail')[index];
    if (entry === undefined) throw new Error(`no pending detail[${index}]`);
    if (entry.settled) throw new Error(`detail[${index}] already settled`);
    entry.settle(value);
    await tick();
  }

  let page: any;
  let win: any;
  let navStub: { pageUrl(p: string): string };

  beforeAll(async () => {
    vi.useFakeTimers();
    vi.resetModules(); // 清掉世界 B 的模块实例：live 分支需要在本世界窗口重新定格
    globals = installUiGlobals({
      bridge: bridgeStub as unknown as { invoke(c: string, p?: unknown): Promise<unknown> },
      location: { href: DETAIL_HREF, search: '?taskId=t9', protocol: 'file:' },
      elements: seededElements(),
      extraWindow: { YTVDLTNav: { pageUrl: (p: string) => `../${p}/index.html?lang=en` } },
    });
    enhanceDoc(globals);
    await loadUiModule('i18n/messages.js', globals);
    await loadUiModule('i18n/i18n.js', globals);
    await loadUiModule('pages/task-detail/task-detail.js', globals);
    win = globals.window;
    T = (key, params) => String(win.YTVDLT.i18n.t(key, params));
    page = win.YTVDLTDetail;
    navStub = win.YTVDLTNav;
    // 引导期 TASK_DETAIL 保持挂起，交给 D-141 专属用例应答（安全网跳过它）
    bootDetailEntry = pending.find((p) => p.channel === 'ytvdlt:task:detail' && !p.settled) ?? null;
  });

  afterAll(() => {
    globals?.restore();
    globals = null;
    vi.useRealTimers();
  });

  afterEach(async () => {
    for (let round = 0; round < 4; round += 1) {
      const leftovers = pending.filter((p) => !p.settled && p !== bootDetailEntry);
      if (leftovers.length === 0) break;
      for (const entry of leftovers) entry.settle(DEFAULT_DETAIL);
      await tick();
    }
    // 引导期 TASK_DETAIL 未被专属用例应答前保留在登记表里（settleDetailAt 靠序号寻址）；
    // 其余已应答登记一律丢弃，让序号只反映当前用例。
    const keepBoot = bootDetailEntry !== null && !bootDetailEntry.settled ? bootDetailEntry : null;
    if (keepBoot === null) bootDetailEntry = null;
    pending.length = 0;
    if (keepBoot !== null) pending.push(keepBoot);
    bridgeState.holdDetail = false;
    bridgeState.detailQueue = [];
    bridgeState.detailDefault = DEFAULT_DETAIL;
    bridgeState.detailMode = 'auto';
    bridgeState.actionReply = { ok: true };
    bridgeState.actionMode = 'auto';
    win.YTVDLTNav = navStub;
    delete win.history;
    win.location.href = DETAIL_HREF;
    await tick();
  });

  it('D-141：live 起步擦掉夹具 —— 六字段全 —、data-state=loading、七动作全禁用、返回链接已注入', () => {
    expect(page.live).toBe(true);
    for (const key of ['detail-id', 'detail-state', 'detail-progress', 'detail-code', 'detail-artifacts', 'detail-url']) {
      expect(detail(key).textContent).toBe('—');
    }
    expect(detail('ytvdlt-task-detail').getAttribute('data-state')).toBe('loading');
    for (const action of ACTIONS) expect(ariaOf(action)).toBe('true');
    // D-80：返回链接只在 live 注入，排在宿主最前
    const back = byId('detail-back');
    expect(back).toBeTruthy();
    expect(back!.getAttribute('data-action')).toBe('back');
    expect(back!.textContent).toBe('← 返回队列');
    expect(detail('ytvdlt-task-detail').children[0]).toBe(back);
    // 引导期恰好一次 TASK_DETAIL，且载荷只带 taskId
    expect(callsOn('ytvdlt:task:detail')).toHaveLength(1);
    expect(callsOn('ytvdlt:task:detail')[0]?.payload).toEqual({ taskId: 't9' });
  });

  it('TASK_DETAIL 回答后渲染真实记录，aria 按可用性翻面（D-141：绝不回落夹具 t1）', async () => {
    await settleDetailAt(0, { found: true, task: REAL_TASK });
    expect(detail('detail-id').textContent).toBe('t9');
    expect(detail('detail-state').textContent).toBe('Error');
    expect(detail('detail-progress').textContent).toBe('12%');
    expect(detail('detail-code').textContent).toBe('HTTP_403');
    expect(detail('detail-artifacts').textContent).toBe('C:/real/video.mp4');
    expect(detail('detail-url').textContent).toBe('https://example.org/real');
    expect(detail('ytvdlt-task-detail').getAttribute('data-state')).toBe('error');
    expect(detail('detail-body').getAttribute('hidden')).toBe('false');
    expect(detail('detail-actions').getAttribute('hidden')).toBe('false');
    expect(detail('detail-empty').getAttribute('hidden')).toBe('true');
    // D-146/D-76 live 矩阵：Error → cancel 不可、remove/retry 可、文件入口可
    expect(ariaOf('open-file')).toBe('false');
    expect(ariaOf('open-folder')).toBe('false');
    expect(ariaOf('copy-url')).toBe('false');
    expect(ariaOf('copy-error-report')).toBe('false');
    expect(ariaOf('cancel')).toBe('true');
    expect(ariaOf('remove')).toBe('false');
    expect(ariaOf('retry')).toBe('false');
    expect(page.current.model).toBe(REAL_TASK);
  });

  it('TASK_DETAIL 未找到 → 缺任务态（body/actions 隐藏、empty 显形、字段保留真实值）', async () => {
    bridgeState.detailQueue = [{ found: false }];
    actionNode('retry').dispatch('click'); // ok 应答触发 load(t9) → 用队列里的 found:false
    await tick();
    expect(detail('ytvdlt-task-detail').getAttribute('data-state')).toBe('empty');
    expect(detail('detail-body').getAttribute('hidden')).toBe('true');
    expect(detail('detail-actions').getAttribute('hidden')).toBe('true');
    expect(detail('detail-empty').getAttribute('hidden')).toBe('false');
    expect(detail('detail-id').textContent).toBe('t9'); // 不被清成夹具
  });

  it('TASK_DETAIL 拒绝 / 桥同步抛错 → invoke 归一化成 ok:false → 同样缺任务态', async () => {
    bridgeState.detailMode = 'reject';
    actionNode('retry').dispatch('click'); // ok 动作 → load → detail 被拒
    await tick();
    expect(detail('ytvdlt-task-detail').getAttribute('data-state')).toBe('empty');
    bridgeState.detailMode = 'throw';
    actionNode('retry').dispatch('click');
    await tick();
    expect(detail('ytvdlt-task-detail').getAttribute('data-state')).toBe('empty');
    // 动作本身也走同一归一化：失败简报可见
    bridgeState.detailMode = 'auto';
    expect(outputText()).toContain('未执行：');
  });

  it('retry 动作：TASK_ACTION 载荷、成功简报、随后自动回读 TASK_DETAIL', async () => {
    actionNode('retry').dispatch('click');
    const dispatched = callsOn('ytvdlt:task:action').at(-1);
    expect(dispatched?.payload).toEqual({ taskId: 't9', action: 'retry' });
    await tick();
    expect(outputText()).toBe('已执行：retry');
    const detailCalls = callsOn('ytvdlt:task:detail');
    expect(detailCalls.length).toBeGreaterThanOrEqual(1);
    expect(detailCalls.at(-1)?.payload).toEqual({ taskId: 't9' });
  });

  it('copy-url 带 clipboardText → 「（已复制到剪贴板）」；四个只读动作的成功简报', async () => {
    bridgeState.actionReply = { ok: true, clipboardText: 'https://example.org/real' };
    actionNode('copy-url').dispatch('click');
    await tick();
    expect(outputText()).toBe('已执行：copy-url（已复制到剪贴板）');
    bridgeState.actionReply = { ok: true };
    actionNode('open-file').dispatch('click');
    await tick();
    expect(outputText()).toBe('已执行：open-file');
    actionNode('open-folder').dispatch('click');
    await tick();
    expect(outputText()).toBe('已执行：open-folder');
    actionNode('copy-error-report').dispatch('click');
    await tick();
    expect(outputText()).toBe('已执行：copy-error-report');
  });

  it('失败矩阵：message 优先 / code 次之 / 全无落「未知原因」；失败不回读详情', async () => {
    bridgeState.actionReply = { ok: false, message: '引擎拒绝', code: 'X' };
    actionNode('retry').dispatch('click'); // Error 卡 retry 可用
    await tick();
    expect(outputText()).toBe('「retry」未执行：引擎拒绝');
    bridgeState.actionReply = { ok: false, code: 'FILE_MISSING' };
    actionNode('open-file').dispatch('click');
    await tick();
    expect(outputText()).toBe('「open-file」未执行：FILE_MISSING');
    const detailCallsBefore = callsOn('ytvdlt:task:detail').length;
    bridgeState.actionReply = { ok: false };
    actionNode('copy-url').dispatch('click'); // copy-url 恒可用
    await tick();
    expect(outputText()).toBe('「copy-url」未执行：未知原因');
    expect(callsOn('ytvdlt:task:detail').length).toBe(detailCallsBefore); // 失败不刷新
  });

  it('D-146：ReadyWithInfo 无下载句柄 → cancel 禁用且点击零派发；Running 可取消', async () => {
    bridgeState.detailQueue = [{
      found: true,
      task: { id: 't9', state: 'ReadyWithInfo', percent: null, errorCode: null, artifacts: [], url: 'https://example.org/real' },
    }];
    actionNode('copy-url').dispatch('click'); // copy-url 恒可用：借成功动作触发 load 换状态
    await tick();
    expect(ariaOf('cancel')).toBe('true');
    const before = callsOn('ytvdlt:task:action').length;
    actionNode('cancel').dispatch('click');
    expect(callsOn('ytvdlt:task:action').length).toBe(before); // 守卫吞掉
    // Running：cancel 可用并派发
    bridgeState.detailQueue = [{
      found: true,
      task: { id: 't9', state: 'Running', percent: 3, errorCode: null, artifacts: [], url: 'https://example.org/real' },
    }];
    actionNode('copy-url').dispatch('click');
    await tick();
    expect(ariaOf('cancel')).toBe('false');
    actionNode('cancel').dispatch('click');
    await tick();
    expect(callsOn('ytvdlt:task:action').at(-1)?.payload).toEqual({ taskId: 't9', action: 'cancel' });
  });

  it('D-120：无产物 → open-file / open-folder 禁用且点击零派发', async () => {
    bridgeState.detailQueue = [{
      found: true,
      task: { id: 't9', state: 'Completed', percent: 100, errorCode: null, artifacts: [], url: 'https://example.org/real' },
    }];
    actionNode('copy-url').dispatch('click');
    await tick();
    expect(ariaOf('open-file')).toBe('true');
    expect(ariaOf('open-folder')).toBe('true');
    const before = callsOn('ytvdlt:task:action').length;
    actionNode('open-file').dispatch('click');
    actionNode('open-folder').dispatch('click');
    expect(callsOn('ytvdlt:task:action').length).toBe(before);
  });

  it('D-87 删除确认框：三键语义（取消 / 仅记录 / 连文件），withFiles 进载荷并跳队列页', async () => {
    const modal = () => byId('detail-remove-modal')!;
    actionNode('remove').dispatch('click'); // live remove → 打开确认框而非直接派发
    expect(modal().getAttribute('role')).toBe('dialog');
    expect(modal().getAttribute('aria-modal')).toBe('true');
    expect(modal().getAttribute('hidden')).toBe('false');
    const box = modal().children[0];
    expect(box.children[0].textContent).toBe(T('queue.delete.title'));
    expect(box.children[1].textContent).toBe(T('queue.delete.message'));
    expect(box.children[2].textContent).toBe(T('queue.delete.filesHint'));
    const buttons = box.children[3].children;
    expect(buttons.map((b) => b.textContent)).toEqual([
      T('queue.delete.cancel'), T('queue.delete.onlyHistory'), T('queue.delete.withFiles'),
    ]);
    // 取消键：只关框，零派发
    buttons[0].dispatch('click');
    expect(modal().getAttribute('hidden')).toBe('true');
    expect(callsOn('ytvdlt:task:action')).toHaveLength(0);
    // 仅删除历史记录 → TASK_ACTION remove（无 withFiles）→ 成功后跳队列页（D-114 nav）
    actionNode('remove').dispatch('click');
    buttons[1].dispatch('click');
    await tick();
    expect(callsOn('ytvdlt:task:action').at(-1)?.payload).toEqual({ taskId: 't9', action: 'remove' });
    expect('withFiles' in (callsOn('ytvdlt:task:action').at(-1)?.payload ?? {})).toBe(false);
    expect(String(win.location.href)).toBe(QUEUE_URL_NAV);
    // 同时删除本地文件 → withFiles: true（D-87：主进程负责移入回收站）
    win.location.href = DETAIL_HREF;
    actionNode('remove').dispatch('click');
    byId('detail-remove-modal')!.children[0].children[3].children[2].dispatch('click');
    await tick();
    expect(callsOn('ytvdlt:task:action').at(-1)?.payload)
      .toEqual({ taskId: 't9', action: 'remove', withFiles: true });
    expect(String(win.location.href)).toBe(QUEUE_URL_NAV);
  });

  it('删除确认框：点遮罩关闭、点内容不关；失败应答不跳页', async () => {
    actionNode('remove').dispatch('click');
    const modal = byId('detail-remove-modal')!;
    modal.dispatch('click', { target: modal.children[0] }); // 内容 → 不关
    expect(modal.getAttribute('hidden')).toBe('false');
    modal.dispatch('click', { target: modal }); // 遮罩 → 关
    expect(modal.getAttribute('hidden')).toBe('true');
    // 删除失败 → 停在原页（不 location.href）
    bridgeState.actionReply = { ok: false, message: '文件被占用' };
    actionNode('remove').dispatch('click');
    byId('detail-remove-modal')!.children[0].children[3].children[1].dispatch('click');
    await tick();
    expect(outputText()).toBe('「remove」未执行：文件被占用');
    expect(String(win.location.href)).toBe(DETAIL_HREF);
  });

  it('D-80 返回链接：有历史 → history.back；无历史 → nav 队列页；nav 缺席 → 相对路径回退', () => {
    const back = byId('detail-back')!;
    back.dispatch('click'); // 无 history → nav.pageUrl('queue')
    expect(String(win.location.href)).toBe(QUEUE_URL_NAV);
    win.location.href = DETAIL_HREF;
    const backSpy = vi.fn();
    win.history = { length: 2, back: backSpy };
    back.dispatch('click');
    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(String(win.location.href)).toBe(DETAIL_HREF);
    win.history = { length: 1, back: vi.fn() }; // 单页历史 → 仍走 href
    back.dispatch('click');
    expect(String(win.location.href)).toBe(QUEUE_URL_NAV);
    win.location.href = DETAIL_HREF;
    delete win.YTVDLTNav; // nav 缺席 → queueUrl 回退
    back.dispatch('click');
    expect(String(win.location.href)).toBe('../queue/index.html');
  });

  it('invoke 同步抛错 / 拒绝 → 稳定失败简报，界面不崩且可重试', async () => {
    bridgeState.actionMode = 'throw';
    actionNode('copy-url').dispatch('click'); // copy-url 恒可用，不受当前状态影响
    await tick();
    expect(outputText()).toBe('「copy-url」未执行：Error: sync boom');
    bridgeState.actionMode = 'reject';
    actionNode('copy-url').dispatch('click');
    await tick();
    expect(outputText()).toBe('「copy-url」未执行：boom');
    // 恢复自动应答后动作照常（失败重试语义）
    bridgeState.actionMode = 'auto';
    actionNode('copy-url').dispatch('click');
    await tick();
    expect(outputText()).toBe('已执行：copy-url');
  });

  it('detailQueue 逐条应答：成功动作后的回读按序换状态（Running 可取消 / Completed 不可重试）', async () => {
    bridgeState.detailQueue = [
      { found: true, task: { ...REAL_TASK, state: 'Running' } },
      { found: true, task: { ...REAL_TASK, state: 'Completed', artifacts: ['C:/real/video.mp4'] } },
    ];
    actionNode('copy-url').dispatch('click'); // ok → load → 队列第 1 条
    await tick();
    expect(detail('detail-state').textContent).toBe('Running');
    expect(detail('ytvdlt-task-detail').getAttribute('data-state')).toBe('running');
    expect(ariaOf('cancel')).toBe('false');
    actionNode('copy-url').dispatch('click'); // 再来一次 → 队列第 2 条
    await tick();
    expect(detail('detail-state').textContent).toBe('Completed');
    expect(ariaOf('retry')).toBe('true'); // Completed 不可重试
    expect(ariaOf('open-file')).toBe('false'); // Completed 有产物 → 文件入口可用
  });
});
