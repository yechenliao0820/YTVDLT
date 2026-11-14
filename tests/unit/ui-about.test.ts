/**
 * D-187 · about.js（版本徽标 + 关于弹窗）真实行为单测 —— import 路线，v8 覆盖率可见。
 *
 * 既有 tests/unit/about-licence.test.ts（D-121）只审计 Settings 页的许可内嵌与
 * about.js 源码文本；本文件用共享装载架 tests/unit/helpers/ui-harness.ts 真实
 * `import()` 装载 messages.js + i18n.js + shell/app-version.js + about.js，驱动
 * window.YTVDLTAbout 暴露的 API，覆盖：
 *   - 版本来源链（D-114）：YTVDLTAppVersion 是唯一权威，URL ?v= 只是回退提示；
 *     两者皆无时徽标是诚实的 `v—`，绝不再编造一个看起来可信的旧版本号；
 *   - APP_INFO 晚到：onChange(paintVersion) 接线让「已构建的弹窗」不刷新页面
 *     就地重绘（版本行 / 三个页面徽标）；
 *   - 弹窗构建纪律：role=dialog / aria-modal / 隐藏态启动 / 内容全部来自真实
 *     i18n 键（appName/tagline/版本/作者/runtime/许可三段/footer/close）；
 *     D-121：紧凑弹窗不含逐字许可全文，只指路「设置 → 关于」；
 *   - 关闭通道：close 按钮 / Esc（document keydown）/ 遮罩自身点击。
 *
 * 【模块单例】about.js 是单实例 IIFE：`doc`/版本读取在 import 时刻定格，但
 * `t()` 与 versionSource() 每次调用都现读 window —— 场景差异（版本注册表缺席、
 * ?v= 参数）通过「临时删 YTVDLTAppVersion / 改 location.search」构造。
 * 【测试侧协作桩】装载架的 document.addEventListener 是空转的，而 about.js 在
 * import 时就注册 Esc 监听 —— beforeAll 里补一个记录器让按键可派发；桥用可编程
 * deferred，把 `ytvdlt:app:info` 的权威应答扣住交给专属用例放行。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installUiGlobals, loadUiModule, type UiGlobals, type UiNode } from './helpers/ui-harness.js';

interface Deferred {
  channel: string;
  payload: unknown;
  settled: boolean;
  settle(value: unknown): void;
}
const pending: Deferred[] = [];
const bridgeStub = {
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    let resolve!: (value: unknown) => void;
    const promise = new Promise<unknown>((res) => { resolve = res; });
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
    pending.push(entry);
    return promise;
  },
};

let globals: UiGlobals | null = null;
let about: any = null; // window.YTVDLTAbout
let appVersion: any = null; // window.YTVDLTAppVersion
let docListeners: Record<string, ((event?: unknown) => void)[]> = {};
/** 引导期被扣住、由专属用例放行的调用（安全网跳过它们）。 */
const protectedBoot = new Set<Deferred>();

const win = () => globals!.window as Record<string, any>;
const doc = () => globals!.document as Record<string, any>;
const body = (): UiNode => doc().body as UiNode;
const node = (id: string): UiNode => globals!.nodes.get(id) as UiNode;
/** 期望文案统一从真实 i18n 取（语言表内容变化不脆断）。 */
const T = (key: string): string => String((win().YTVDLT as any).i18n.t(key));

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
/** about.js 的 backdrop 用普通 `.id` 赋值（不走 setAttribute），两者都查。 */
function backdrop(): UiNode | null {
  return body().children.find((c) => (c as unknown as { id?: string }).id === 'ytvdlt-about'
    || c.getAttribute('id') === 'ytvdlt-about') ?? null;
}
function backdropOf(state: 'open' | 'closed'): UiNode {
  const found = backdrop();
  expect(found, '关于弹窗应已构建并挂在 body 上').toBeTruthy();
  expect(found!.getAttribute('hidden'), state === 'open' ? '弹窗应处于打开态' : '弹窗应处于隐藏态')
    .toBe(state === 'open' ? 'false' : 'true');
  return found as UiNode;
}
/** 版本行（dl 里第一对 dt/dd 的 dd），about.js 的 versionValue 直引用。 */
function versionValueOf(dialog: UiNode): UiNode {
  const grid = deepFind(dialog, (n) => n.tagName === 'DL');
  expect(grid, '关于弹窗应有版本/作者 dl 表').toBeTruthy();
  const dd = (grid as UiNode).children.filter((n) => n.tagName === 'DD')[0];
  expect(dd, '版本行应有 dd 值单元').toBeTruthy();
  return dd as UiNode;
}
async function drain(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}
/** 放行当前挂起的 ytvdlt:app:info 应答（D-114 权威版本）。 */
async function settleAppInfo(answer: unknown): Promise<void> {
  for (const entry of pending.filter((p) => p.channel === 'ytvdlt:app:info' && !p.settled)) {
    entry.settle(answer);
  }
  await drain();
}

beforeAll(async () => {
  globals = installUiGlobals({
    bridge: bridgeStub as unknown as { invoke(channel: string, payload?: unknown): Promise<unknown> },
    // 不带 ?v= 提示：首帧只能诚实地显示 v—（D-114），权威值由专属用例放行。
    location: { href: 'file:///C:/app/pages/settings/index.html', search: '', protocol: 'file:' },
  });
  // 装载架的 document.addEventListener 是空转的；about.js 在 import 时注册
  // Esc keydown —— 测试侧补一个记录器让按键可派发（不改 harness 文件）。
  docListeners = {};
  (doc() as any).addEventListener = (type: string, fn: (event?: unknown) => void): void => {
    (docListeners[type] ??= []).push(fn);
  };
  // 与设置页脚本顺序一致：字典 → 运行时 → 版本注册表 → 关于弹窗。
  await loadUiModule('i18n/messages.js', globals);
  await loadUiModule('i18n/i18n.js', globals);
  await loadUiModule('shell/app-version.js', globals);
  await loadUiModule('about/about.js', globals);
  about = win().YTVDLTAbout;
  appVersion = win().YTVDLTAppVersion;
  // 引导期的 app:info 询问交给「APP_INFO 晚到」专属用例放行，安全网不替答
  // （替答 {} 会触发 D-114 的「主机答不上 → 丢弃提示」分支，污染后续用例）。
  const bootInfo = pending.find((p) => p.channel === 'ytvdlt:app:info' && !p.settled);
  if (bootInfo) protectedBoot.add(bootInfo);
});

afterAll(() => {
  globals?.restore();
  globals = null;
  about = null;
  appVersion = null;
});

afterEach(async () => {
  // 安全网：兜底应答残留挂起调用；引导期被扣住的 app:info 不在网内替答。
  for (const entry of pending.filter((p) => !p.settled && !protectedBoot.has(p))) entry.settle({});
  await drain();
});

// ---------------------------------------------------------------------------
// 族一 · 版本来源链（D-114）：注册表权威 → ?v= 回退 → 诚实的 v—
// ---------------------------------------------------------------------------
describe('D-187 · 版本来源链与 APP_INFO 晚到重绘（D-114）', () => {
  it('首帧无任何版本信息：三个页面徽标与 getter 都是诚实的 v—，不编造旧版本号', () => {
    expect(node('queue-version').textContent).toBe('v—');
    expect(node('settings-meta').textContent).toBe('v—');
    expect(node('about-version').textContent).toBe('v—');
    expect(about.version).toBe('');
    expect(about.label).toBe('v—');
    expect(doc().documentElement.getAttribute('data-app-version')).toBe('');
    // 权威应答已被扣住（装载期 app-version 的 refresh 就发出过一次询问）。
    expect(pending.some((p) => p.channel === 'ytvdlt:app:info' && !p.settled)).toBe(true);
  });

  it('Esc 在弹窗从未打开时按下：close() 兜底构建（隐藏态），不炸不弹', () => {
    for (const fn of docListeners.keydown ?? []) fn({ key: 'Escape' });
    backdropOf('closed');
  });

  it('APP_INFO 晚到：已构建的弹窗版本行与三个徽标就地重绘，无需刷新/重开', async () => {
    about.open();
    const dialog = backdropOf('open');
    expect(versionValueOf(dialog).textContent).toBe('v—');
    await settleAppInfo({ version: '0.3.1' });
    // 页面徽标 + 弹窗内版本行同步换成权威值；getter 是活值不是装载期快照。
    expect(node('queue-version').textContent).toBe('v0.3.1');
    expect(node('settings-meta').textContent).toBe('v0.3.1');
    expect(node('about-version').textContent).toBe('v0.3.1');
    expect(versionValueOf(dialog).textContent).toBe('v0.3.1');
    expect(about.version).toBe('0.3.1');
    expect(about.label).toBe('v0.3.1');
    expect(appVersion.source()).toBe('ipc');
    expect(doc().documentElement.getAttribute('data-app-version')).toBe('0.3.1');
  });

  it('版本注册表缺席时回退 ?v= 提示；没有参数就回到 v—（D-114 的最后防线）', () => {
    const registry = win().YTVDLTAppVersion;
    try {
      win().YTVDLTAppVersion = undefined;
      win().location.search = '?v=7.7.7';
      expect(about.version).toBe('7.7.7');
      expect(about.label).toBe('v7.7.7');
      win().location.search = '';
      expect(about.version).toBe('');
      expect(about.label).toBe('v—');
    } finally {
      win().YTVDLTAppVersion = registry;
      win().location.search = '';
    }
  });
});

// ---------------------------------------------------------------------------
// 族二 · 弹窗构建与内容（D-91 / D-121）
// ---------------------------------------------------------------------------
describe('D-187 · 关于弹窗内容与 D-121 许可指路纪律', () => {
  it('弹窗内容全部来自真实 i18n 键；紧凑弹窗不含逐字许可全文，只指路设置页', () => {
    const dialog = backdropOf('open');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // 头部：logo + 应用名 + 标语。
    const mark = deepFind(dialog, (n) => String((n as unknown as { innerHTML?: string }).innerHTML ?? '').includes('<svg'));
    expect(mark, '关于弹窗应有内联 SVG 徽标').toBeTruthy();
    expect(deepFind(dialog, (n) => n.tagName === 'STRONG')?.textContent).toBe(T('about.appName'));
    expect(deepFind(dialog, (n) => n.tagName === 'SPAN' && n.textContent === T('about.tagline'))).toBeTruthy();
    // 版本行 / 作者行（dl 表）。
    const grid = deepFind(dialog, (n) => n.tagName === 'DL') as UiNode;
    expect(grid.children.map((n) => n.textContent)).toEqual([
      T('about.version'), 'v0.3.1', T('about.author'), T('about.author.name'),
    ]);
    // 运行时说明与许可三段（D-121：正文 + 指路，无逐字全文）。
    expect(deepFind(dialog, (n) => n.tagName === 'P' && n.textContent === T('about.runtime'))).toBeTruthy();
    expect(deepFind(dialog, (n) => n.tagName === 'H3')?.textContent).toBe(T('about.license.title'));
    expect(deepFind(dialog, (n) => n.textContent === T('about.license.body'))).toBeTruthy();
    expect(deepFind(dialog, (n) => n.textContent === T('about.license.fullWhere'))).toBeTruthy();
    const dialogText = deepAll(dialog, () => true).map((n) => n.textContent).join('\n');
    expect(dialogText).not.toContain('### 1. Grant of Rights');
    expect(dialogText).not.toContain('about-licence-text');
    // 页脚 + 关闭按钮。
    expect(deepFind(dialog, (n) => n.textContent === T('about.footer'))).toBeTruthy();
    const closeButton = deepFind(dialog, (n) => n.tagName === 'BUTTON');
    expect(closeButton?.textContent).toBe(T('common.close'));
    expect((closeButton as unknown as { type?: string }).type).toBe('button');
  });

  it('open 幂等、close/open 复用同一节点（不重复 append、不重建 DOM）', () => {
    const first = backdropOf('open');
    about.open();
    about.open();
    expect(body().children.filter((c) => backdrop() === c)).toHaveLength(1);
    expect(backdrop()).toBe(first);
    about.close();
    backdropOf('closed');
    about.open();
    expect(backdrop()).toBe(first); // 复用，不重建
    expect(backdropOf('open').getAttribute('hidden')).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// 族三 · 关闭通道：close 按钮 / Esc / 遮罩点击
// ---------------------------------------------------------------------------
describe('D-187 · 关于弹窗的三条关闭通道', () => {
  it('close 按钮点击关闭弹窗', () => {
    const dialog = backdropOf('open');
    const closeButton = deepFind(dialog, (n) => n.tagName === 'BUTTON') as UiNode;
    closeButton.dispatch('click');
    backdropOf('closed');
  });

  it('Esc 关闭打开中的弹窗；其他按键不关', () => {
    about.open();
    for (const fn of docListeners.keydown ?? []) fn({ key: 'F5' });
    expect(backdropOf('open').getAttribute('hidden')).toBe('false');
    for (const fn of docListeners.keydown ?? []) fn({ key: 'Escape' });
    backdropOf('closed');
  });

  it('遮罩点击：落在遮罩自身关闭，落在内容盒上不关（aria-modal 纪律）', () => {
    about.open();
    const dialog = backdropOf('open');
    const box = dialog.children[0];
    dialog.dispatch('click', { target: box });
    expect(backdropOf('open').getAttribute('hidden')).toBe('false');
    dialog.dispatch('click', { target: dialog });
    backdropOf('closed');
  });
});
