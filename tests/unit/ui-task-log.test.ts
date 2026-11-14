/**
 * D-187 · task-log.js（任务日志页）真实行为单测 —— import 路线，v8 覆盖率可见。
 *
 * 既有 tests/unit/task-log-copy.test.ts（D-173）用 runInNewContext 沙箱钉住了
 * 剪贴板通道语义，但 VM 沙箱的执行覆盖率统计不到；本文件用共享装载架
 * tests/unit/helpers/ui-harness.ts 真实 `import()` messages.js + i18n.js +
 * task-log.js，让页面脚本本身进入 D-187 覆盖率统计，并覆盖：
 *   - 引导渲染：__YTVDLT_TASK__ → 标题/状态行/data-state/逐行 <span data-line>/
 *     data-line-count/?grep= 过滤/retry 可用性（Error → 可重试）；
 *   - 按钮只产出动作 JSON 的契约（emit → #ytvdlt-output）：copy/cancel/retry，
 *     且 taskId 因模型携带 id 被 JSON.stringify 丢弃（与 D-173 历史契约一致）；
 *   - D-173 复制走主进程通道 ytvdlt:clipboard:write：ok:true → JSON 契约；
 *     ok:false / reject / 同步抛错 / 非_thenable 应答 → 可见失败反馈
 *     （真实 i18n 文案 log.copy.failed）；
 *   - 无桥回退 navigator.clipboard（静态预览）：成功 / 拒绝 / 非_thenable /
 *     同步抛错 / 双双缺席；
 *   - task() 的注入兜底：注入缺 lines 或无注入时回退内置 SAMPLE。
 *
 * 【模块单例】task-log.js 是单实例 IIFE：引导期的模型 / grep / 空态开关在
 * import 时刻定格 —— 本文件固定「Error 任务 + ?grep=download」装载（能同时覆盖
 * 行渲染、过滤与可重试路径）；copyLog 每次点击都现读 ytvdltBridge/navigator，
 * 场景差异通过「换桥 / 换 navigator」构造，用例间自行还原。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installUiGlobals, loadUiModule, type UiGlobals, type UiNode } from './helpers/ui-harness.js';

const TASK = {
  id: 't42',
  state: 'Error',
  percent: 55,
  lines: [
    '[00:00:01] [info] 开始解析 https://example.org/v',
    '[00:00:02] [download] Destination: C:/V/fixture.mp4',
    '[00:00:03] [download] 42.0% of 10.00MiB',
    '[00:00:04] [info] 校验产物 C1–C12',
  ],
};
/** ?grep=download 过滤后的引导期生效行（与 TASK.lines 顺序一致）。 */
const FILTERED = TASK.lines.filter((line) => line.includes('download'));

let globals: UiGlobals | null = null;
let logPage: any = null; // window.YTVDLTLog

const win = () => globals!.window as Record<string, any>;
const node = (id: string): UiNode => globals!.nodes.get(id) as UiNode;
/** 期望文案从真实 i18n 取（语言表内容变化不脆断）。 */
const T = (key: string): string => String((win().YTVDLT as any).i18n.t(key));

/** 点击某动作按钮（引导期已挂好 click 监听）。 */
function clickAction(action: 'copy' | 'cancel' | 'retry'): void {
  node(`log-${action}`).dispatch('click');
}
/** #ytvdlt-output 的当前内容（emit 的 JSON 落点）。 */
function output(): string {
  return node('ytvdlt-output').textContent;
}
/** 微任务排空：copyLog 的 then 回调要走完。 */
async function drain(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}
/** 换桥场景的安全网：用例结束还原桥与 navigator。 */
function resetCollaborators(): void {
  delete win().ytvdltBridge;
  win().navigator = { userAgent: 'vitest-ui-harness' };
}

beforeAll(async () => {
  globals = installUiGlobals({
    bridge: null, // task-log 页不装载 ipc-bridge.js；复制通道由 copyLog 直呼 wire 字符串
    injected: { __YTVDLT_TASK__: TASK },
    location: {
      href: 'file:///C:/app/pages/task-log/index.html',
      search: '?grep=download',
      protocol: 'file:',
    },
  });
  // 与任务日志页脚本顺序一致：字典 → 运行时 → 页面。
  await loadUiModule('i18n/messages.js', globals);
  await loadUiModule('i18n/i18n.js', globals);
  await loadUiModule('pages/task-log/task-log.js', globals);
  logPage = win().YTVDLTLog;
});

afterAll(() => {
  globals?.restore();
  globals = null;
  logPage = null;
});

afterEach(() => {
  resetCollaborators();
});

// ---------------------------------------------------------------------------
// 族一 · 引导渲染：任务模型 → 标题/状态/逐行 span/?grep= 过滤/空态开关
// ---------------------------------------------------------------------------
describe('D-187 · 引导渲染与 ?grep= 过滤', () => {
  it('任务模型投影：标题/状态行/data-state/retry 可用性来自注入任务', () => {
    expect(node('log-title').textContent).toBe(`任务日志 · ${TASK.id}`);
    expect(node('log-state').textContent).toBe('Error · 55%');
    expect(node('ytvdlt-task-log').getAttribute('data-state')).toBe('error');
    // Error 是可重试态：aria-disabled=false。
    expect(node('log-retry').getAttribute('aria-disabled')).toBe('false');
  });

  it('逐行渲染：每行一个 .ln span、data-line 从 1 计、计数标记反映过滤后行数', () => {
    const linesHost = node('log-lines');
    expect(linesHost.getAttribute('hidden')).toBe('false');
    expect(linesHost.getAttribute('data-line-count')).toBe(String(FILTERED.length));
    expect(linesHost.children).toHaveLength(FILTERED.length);
    FILTERED.forEach((line, index) => {
      const span = linesHost.children[index];
      expect(String((span as unknown as { className?: string }).className)).toBe('ln');
      expect(span.getAttribute('data-line')).toBe(String(index + 1));
      expect(span.textContent).toBe(line);
    });
    // 空态/错误态开关未被激活（?empty=0）：隐藏，不抢状态。
    expect(node('log-empty').getAttribute('hidden')).toBe('true');
    expect(node('log-error').getAttribute('hidden')).toBe('true');
  });

  it('task()：有注入返回注入模型；注入缺 lines / 无注入回退内置 SAMPLE', () => {
    expect(logPage.task()).toBe(TASK);
    win().__YTVDLT_TASK__ = { id: 'shape-only' };
    expect(logPage.task()).not.toBe(TASK);
    expect(logPage.task().id).toBe('t1'); // SAMPLE 的 id
    delete win().__YTVDLT_TASK__;
    const sample = logPage.task();
    expect(sample.id).toBe('t1');
    expect(sample.state).toBe('Running');
    expect(sample.percent).toBe(42);
    expect(Array.isArray(sample.lines)).toBe(true);
    expect(sample.lines.length).toBeGreaterThan(0);
    win().__YTVDLT_TASK__ = TASK;
  });
});

// ---------------------------------------------------------------------------
// 族二 · 动作 JSON 契约（emit → #ytvdlt-output）
// ---------------------------------------------------------------------------
describe('D-187 · 动作 JSON 契约（cancel / retry / copy）', () => {
  it('cancel 点击：#ytvdlt-output 写出 accepted:true 的动作 JSON', () => {
    clickAction('cancel');
    expect(JSON.parse(output())).toEqual({ action: 'cancel', accepted: true });
  });

  it('retry 点击（Error 可重试）：同一通道写出 retry 动作 JSON', () => {
    clickAction('retry');
    expect(JSON.parse(output())).toEqual({ action: 'retry', accepted: true });
  });

  it('copy 成功（D-173 历史契约）：taskId 被丢弃，accepted:false，格式为两空格缩进', async () => {
    win().ytvdltBridge = { invoke: async () => ({ ok: true }) };
    clickAction('copy');
    await drain();
    const parsed = JSON.parse(output());
    expect(parsed).toEqual({ action: 'copy', accepted: false });
    expect('taskId' in parsed).toBe(false);
    expect(output()).toContain('\n  "action": "copy"'); // null, 2 缩进
  });
});

// ---------------------------------------------------------------------------
// 族三 · D-173：复制走主进程 ytvdlt:clipboard:write 通道 + 失败可见反馈
// ---------------------------------------------------------------------------
describe('D-187 · 复制的主进程剪贴板通道（D-173）', () => {
  it('ok:true：载荷为过滤后日志的 \n 连接，通道名精确匹配', async () => {
    const calls: Array<{ channel: string; payload: unknown }> = [];
    win().ytvdltBridge = {
      invoke(channel: string, payload?: unknown): Promise<unknown> {
        calls.push({ channel, payload });
        return Promise.resolve({ ok: true });
      },
    };
    clickAction('copy');
    await drain();
    expect(calls).toHaveLength(1);
    expect(calls[0].channel).toBe('ytvdlt:clipboard:write');
    expect(calls[0].payload).toEqual({ text: FILTERED.join('\n') });
    expect(JSON.parse(output())).toEqual({ action: 'copy', accepted: false });
  });

  it('ok:false：输出换成可见失败文案，不含任何动作 JSON', async () => {
    win().ytvdltBridge = { invoke: async () => ({ ok: false, code: 'CLIPBOARD_UNAVAILABLE' }) };
    clickAction('copy');
    await drain();
    expect(output()).toBe(T('log.copy.failed'));
    expect(output()).not.toContain('"action"');
  });

  it('invoke 拒绝 / 同步抛错 / 返回非_thenable：三种失败形态都给可见反馈', async () => {
    // ① 拒绝（载荷超上限等）。
    win().ytvdltBridge = { invoke: () => Promise.reject(new Error('bounded text')) };
    clickAction('copy');
    await drain();
    expect(output()).toBe(T('log.copy.failed'));
    // ② 同步抛错。
    win().ytvdltBridge = { invoke: () => { throw new Error('sync-boom'); } };
    clickAction('copy');
    await drain();
    expect(output()).toBe(T('log.copy.failed'));
    // ③ 应答不是 promise（桥实现不合规）→ 直接判失败，不误报成功。
    win().ytvdltBridge = { invoke: () => 42 as unknown as Promise<unknown> };
    clickAction('copy');
    await drain();
    expect(output()).toBe(T('log.copy.failed'));
  });
});

// ---------------------------------------------------------------------------
// 族四 · 无桥回退 navigator.clipboard（静态预览）与双双缺席
// ---------------------------------------------------------------------------
describe('D-187 · 无桥回退 navigator.clipboard（静态预览）', () => {
  it('桥缺席时走 navigator.clipboard.writeText，成功保持 JSON 契约、不发 IPC', async () => {
    const written: string[] = [];
    win().navigator = { clipboard: { writeText: async (text: string) => { written.push(text); } } };
    clickAction('copy');
    await drain();
    expect(written).toEqual([FILTERED.join('\n')]);
    expect(JSON.parse(output())).toEqual({ action: 'copy', accepted: false });
  });

  it('navigator.clipboard 拒绝 / 同步抛错 / 返回非_thenable：三种失败形态都给可见反馈', async () => {
    // ① 拒绝。
    win().navigator = { clipboard: { writeText: () => Promise.reject(new Error('denied')) } };
    clickAction('copy');
    await drain();
    expect(output()).toBe(T('log.copy.failed'));
    // ② 同步抛错。
    win().navigator = {
      clipboard: { writeText: () => { throw new Error('sync-boom'); } },
    };
    clickAction('copy');
    await drain();
    expect(output()).toBe(T('log.copy.failed'));
    // ③ 返回非_thenable（旧浏览器实现）→ 视为已写入，走成功契约。
    win().navigator = { clipboard: { writeText: () => undefined } };
    clickAction('copy');
    await drain();
    expect(JSON.parse(output())).toEqual({ action: 'copy', accepted: false });
  });

  it('桥与 navigator.clipboard 双双缺席：立即给出可见失败反馈', () => {
    clickAction('copy');
    expect(output()).toBe(T('log.copy.failed'));
    expect(JSON.stringify(output())).not.toContain('"action"');
  });
});
