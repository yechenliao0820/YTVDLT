/**
 * D-187 · theme.js 真实行为单测（D-106 全局外观单一状态）。
 *
 * 【import 路线】共享装载架 helpers/ui-harness.ts 真实 `import()`，v8 覆盖率可见。
 * theme.js 无依赖、无 IIFE 之外的协作者：装载时只做一次同步 apply()（M3 默认态
 * 不写任何 DOM 属性 —— 截图基线保持像素一致的前提，本文件第一个用例就钉住它）。
 *
 * 【场景驱动】theme 的状态在每次调用时惰性读取 location.search / localStorage /
 * window.__YTVDLT_SETTINGS__ / matchMedia / ytvdltBridge —— 因此不需要 resetModules
 * 重装：直接改这些输入再调用 set/apply/sync/watch/listen 即可覆盖三态解析、
 * 优先级（查询 > 本地缓存 > 注入 > 默认）、system 跟随 OS 偏好、accent 的
 * hex/system/preset 三类与移除路径、SETTINGS_SET 持久化、dirty 保护、storage 跨窗跟随。
 *
 * 【测试侧桥接】harness 的 document.addEventListener 是空转 noop，这里替换成
 * 「记录 + 派发」以便断言 ytvdlt:appearance 事件（emitChange）；matchMedia 换成
 * 可编程桩（matches 可切换）以驱动 system 主题 / reduced 动效的运行时跟随。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installUiGlobals, loadUiModule, type UiGlobals, type UiNode } from './helpers/ui-harness.js';

let globals: UiGlobals | null = null;
let theme: any = null; // window.YTVDLTTheme

const win = () => globals!.window as Record<string, any>;
const doc = () => globals!.document as any;
const root = (): UiNode => globals!.document.documentElement as UiNode;
const callsTo = (channel: string) => globals!.bridgeCalls.filter((c) => c.channel === channel);
const flush = async (rounds = 10): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};

// 文档级监听记录（emitChange 派发 ytvdlt:appearance 时逐个调用）。
let docListeners: Record<string, Array<(event?: unknown) => void>> = {};
const docFire = (type: string, event?: unknown): void => {
  for (const fn of docListeners[type] ?? []) fn(event);
};

// CustomEvent 桩：emitChange 只读 detail。
class FakeCustomEvent { type: string; detail: unknown; constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } }

// 可编程 matchMedia：按查询串返回可翻转的 matches。
let mediaMatches = new Map<string, boolean>();
function setMedia(query: string, matches: boolean): void { mediaMatches.set(query, matches); }

// appearance 事件收集（document 派发由 docFire 触发）。
let lastEvents: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  vi.useFakeTimers();
  globals = installUiGlobals({
    bridge: { invoke: () => ({}) }, // 默认空应答；各用例按需改写
    location: { href: 'file:///C:/app/pages/queue/index.html', search: '', protocol: 'file:' },
    extraWindow: {
      CustomEvent: FakeCustomEvent as unknown as typeof CustomEvent,
      matchMedia: (query: string) => ({
        matches: mediaMatches.get(query) === true,
        addEventListener() { /* watch 注册；dispose 由测试侧手工触发 */ },
        removeEventListener() { /* noop */ },
        addListener() { /* 旧 API */ },
        removeListener() { /* 旧 API */ },
      }),
      setTimeout: (...args: unknown[]) => (globalThis as any).setTimeout(...(args as any[])),
      clearTimeout: (handle: unknown) => (globalThis as any).clearTimeout(handle as any),
    },
  });
  // 文档级监听记录 + 派发（emitChange → ytvdlt:appearance）
  docListeners = {};
  doc().addEventListener = (type: string, fn: (event?: unknown) => void) => { (docListeners[type] ??= []).push(fn); };
  doc().removeEventListener = (type: string, fn: (event?: unknown) => void) => {
    const bucket = docListeners[type] ?? [];
    const at = bucket.indexOf(fn);
    if (at >= 0) bucket.splice(at, 1);
  };
  doc().dispatchEvent = (event: any) => {
    if (event?.type === 'ytvdlt:appearance') lastEvents.push(event.detail as Record<string, unknown>);
    docFire(event.type, event);
  };
  await loadUiModule('theme/theme.js', globals);
  theme = win().YTVDLTTheme;
});

afterAll(() => {
  globals?.restore();
  globals = null;
  theme = null;
  vi.useRealTimers();
});

// 每个用例开始前把共享输入复位（localStorage / search / media / <html> 属性）。
function resetInputs(): void {
  win().localStorage.clear();
  win().location.search = '';
  delete (win() as any).__YTVDLT_SETTINGS__;
  mediaMatches = new Map();
  lastEvents = [];
  root().attrs = {};
  (root().style as any).removeProperty('--accent');
  (root().style as any).removeProperty('--accent-soft');
  globals!.bridgeCalls.length = 0;
}

// ---------------------------------------------------------------------------
// 族一 · 纯函数解析（normalize / resolve / effectiveAccent）
// ---------------------------------------------------------------------------
describe('D-187 · theme：三态解析与强调色纯函数', () => {
  it('normalizeTheme：合法值原样，非法值落回 system（normalizeMotion 未导出，经 apply 分支覆盖）', () => {
    expect(theme.normalizeTheme('light')).toBe('light');
    expect(theme.normalizeTheme('dark')).toBe('dark');
    expect(theme.normalizeTheme('system')).toBe('system');
    for (const bad of ['blue', '', undefined, null, 'DARK', 1]) {
      expect(theme.normalizeTheme(bad as never)).toBe('system');
    }
  });

  it('normalizeHex：#RRGGBB / RRGGBB → 小写补 #；其余一律 null', () => {
    expect(theme.normalizeHex('#FFAA00')).toBe('#ffaa00');
    expect(theme.normalizeHex('ffaa00')).toBe('#ffaa00');
    expect(theme.normalizeHex('  #aAbBcC  ')).toBe('#aabbcc');
    for (const bad of ['#fff', '#gggggg', 'ff', '', undefined, null, 123, '#aabbccdd']) {
      expect(theme.normalizeHex(bad as never)).toBeNull();
    }
  });

  it('normalizeAccent：hex > system > 预设；空与未知落回默认 blue', () => {
    expect(theme.normalizeAccent('#AABBCC')).toEqual({ kind: 'hex', value: '#aabbcc' });
    expect(theme.normalizeAccent('system')).toEqual({ kind: 'system', value: 'system' });
    for (const preset of theme.PRESETS) {
      expect(theme.normalizeAccent(preset)).toEqual({ kind: 'preset', value: preset });
    }
    for (const fallback of ['', '   ', 'bogus', undefined, null]) {
      expect(theme.normalizeAccent(fallback as never)).toEqual({ kind: 'preset', value: theme.DEFAULT_ACCENT });
    }
    expect(theme.DEFAULT_ACCENT).toBe('blue');
  });

  it('resolveTheme / resolveMotion：system 分支跟随 OS 偏好，显式值直通', () => {
    expect(theme.resolveTheme('system', true)).toBe('dark');
    expect(theme.resolveTheme('system', false)).toBe('light');
    expect(theme.resolveTheme('dark', false)).toBe('dark');
    expect(theme.resolveMotion('system', true)).toBe('reduced');
    expect(theme.resolveMotion('system', false)).toBe('full');
    expect(theme.resolveMotion('reduced', false)).toBe('reduced');
  });

  it('effectiveAccent：用户 hex 恒胜；system 跟随系统色，缺失落默认预设', () => {
    expect(theme.effectiveAccent({ kind: 'hex', value: '#123456' }, '#abcdef'))
      .toEqual({ kind: 'hex', value: '#123456' });
    expect(theme.effectiveAccent({ kind: 'system', value: 'system' }, '#abcdef'))
      .toEqual({ kind: 'hex', value: '#abcdef' });
    expect(theme.effectiveAccent({ kind: 'system', value: 'system' }, null))
      .toEqual({ kind: 'preset', value: 'blue' });
    expect(theme.effectiveAccent({ kind: 'preset', value: 'teal' }, '#abcdef'))
      .toEqual({ kind: 'preset', value: 'teal' });
  });
});

// ---------------------------------------------------------------------------
// 族二 · settings()/state()：查询 > 本地缓存 > 注入 > 默认 的四层优先级
// ---------------------------------------------------------------------------
describe('D-187 · theme：外观解析的四层优先级（D-106）', () => {
  it('无任何输入：三态全 system，accent 解析为 system 类（kinds 暴露给设置页）', () => {
    resetInputs();
    expect(theme.settings()).toEqual({ theme: 'system', accent: { kind: 'system', value: 'system' }, motion: 'system', systemAccent: null });
    expect(theme.state()).toEqual({ theme: 'system', accent: 'system', accentKind: 'system', motion: 'system', systemAccent: null });
  });

  it('注入 __YTVDLT_SETTINGS__ 是第二层兜底（含 systemAccent）', () => {
    resetInputs();
    (win() as any).__YTVDLT_SETTINGS__ = { theme: 'dark', accent: 'violet', motion: 'reduced', systemAccent: '#abc123' };
    expect(theme.state()).toEqual({ theme: 'dark', accent: 'violet', accentKind: 'preset', motion: 'reduced', systemAccent: '#abc123' });
    // 注入形状不对 → 当作空对象
    (win() as any).__YTVDLT_SETTINGS__ = 'nonsense';
    expect(theme.state().theme).toBe('system');
    (win() as any).__YTVDLT_SETTINGS__ = null;
    expect(theme.state().theme).toBe('system');
  });

  it('本地缓存（ytvdlt.appearance）压过注入；坏 JSON / 非对象 / 抛错一律回空', () => {
    resetInputs();
    (win() as any).__YTVDLT_SETTINGS__ = { theme: 'dark', accent: 'violet' };
    win().localStorage.setItem('ytvdlt.appearance', JSON.stringify({ theme: 'light', accent: '#ff0000', motion: 'full', systemAccent: '#00ff88' }));
    expect(theme.state()).toEqual({ theme: 'light', accent: '#ff0000', accentKind: 'hex', motion: 'full', systemAccent: '#00ff88' });
    // 本地缓存的 systemAccent 归一化：坏 hex 落回注入值
    win().localStorage.setItem('ytvdlt.appearance', JSON.stringify({ systemAccent: 'nothex' }));
    expect(theme.state().systemAccent).toBeNull();
    // 坏 JSON / 非对象 → {}
    win().localStorage.setItem('ytvdlt.appearance', '{oops');
    expect(theme.readLocal()).toEqual({});
    win().localStorage.setItem('ytvdlt.appearance', JSON.stringify('text'));
    expect(theme.readLocal()).toEqual({});
    win().localStorage.setItem('ytvdlt.appearance', JSON.stringify(null));
    expect(theme.readLocal()).toEqual({});
    // getItem 抛错 → {}（隐私模式 / file:// 降级）
    const originalGet = win().localStorage.getItem;
    win().localStorage.getItem = () => { throw new Error('denied'); };
    try { expect(theme.readLocal()).toEqual({}); } finally { win().localStorage.getItem = originalGet; }
  });

  it('URL 查询是最高层（无头截图套件的确定性渲染入口）', () => {
    resetInputs();
    win().localStorage.setItem('ytvdlt.appearance', JSON.stringify({ theme: 'light', accent: 'rose' }));
    win().location.search = '?theme=dark&accent=teal&motion=reduced';
    expect(theme.state()).toEqual({ theme: 'dark', accent: 'teal', accentKind: 'preset', motion: 'reduced', systemAccent: null });
    // 查询里不存在的键仍按 层级 走：accent 缺失 → 本地 rose
    win().location.search = '?theme=dark';
    expect(theme.state().accent).toBe('rose');
    // 查询值非法 → 归一化兜底
    win().location.search = '?theme=bogus&accent=not-a-color&motion=nope';
    expect(theme.state()).toEqual({ theme: 'system', accent: 'blue', accentKind: 'preset', motion: 'system', systemAccent: null });
    win().location.search = '';
  });
});

// ---------------------------------------------------------------------------
// 族三 · apply()：<html> 属性作画与移除路径（M3 默认零属性）
// ---------------------------------------------------------------------------
describe('D-187 · theme：apply() 的 DOM 作画与移除路径', () => {
  it('M3 默认态（light + blue + full）不写任何属性 —— 截图基线前提', () => {
    resetInputs();
    expect(theme.apply()).toEqual({ theme: 'light', accent: 'blue', accentKind: 'preset', motion: 'full' });
    expect(root().getAttribute('data-theme')).toBeNull();
    expect(root().getAttribute('data-motion')).toBeNull();
    expect(root().getAttribute('data-accent')).toBeNull();
    expect(root().style['--accent']).toBeUndefined();
  });

  it('dark / reduced / 非默认预设 → data-theme / data-motion / data-accent', () => {
    resetInputs();
    expect(theme.apply({ theme: 'dark' })).toMatchObject({ theme: 'dark' });
    expect(root().getAttribute('data-theme')).toBe('dark');
    expect(theme.apply({ theme: 'light', motion: 'reduced' })).toMatchObject({ motion: 'reduced' });
    expect(root().getAttribute('data-motion')).toBe('reduced');
    expect(theme.apply({ theme: 'light', motion: 'full', accent: 'teal' })).toMatchObject({ accent: 'teal' });
    expect(root().getAttribute('data-accent')).toBe('teal');
    expect(root().style['--accent']).toBeUndefined(); // 预设色走 CSS，不写内联
    // 回默认：移除路径（removeProperty / removeAttribute）
    expect(theme.apply({ theme: 'light', motion: 'full', accent: 'blue' })).toMatchObject({ accent: 'blue' });
    expect(root().getAttribute('data-accent')).toBeNull();
    expect(root().getAttribute('data-theme')).toBeNull();
  });

  it('hex 强调色 → data-accent=custom + --accent/--accent-soft 内联变量；system 跟随系统色', () => {
    resetInputs();
    expect(theme.apply({ theme: 'light', accent: { kind: 'hex', value: '#ff8800' } })).toMatchObject({ accent: '#ff8800', accentKind: 'hex' });
    expect(root().getAttribute('data-accent')).toBe('custom');
    expect(root().style['--accent']).toBe('#ff8800');
    expect(root().style['--accent-soft']).toBe('color-mix(in srgb, #ff8800 16%, transparent)');
    // system + 系统色存在 → 系统色胜出（注意：直调 apply 不做小写归一，
    // 归一化只发生在 sync()/set() 的入口处）
    expect(theme.apply({ theme: 'light', accent: 'system', systemAccent: '#00ffaa' }))
      .toMatchObject({ accent: '#00ffaa', accentKind: 'hex' });
    expect(root().style['--accent']).toBe('#00ffaa');
    // system + 系统色缺失 → 默认预设 blue → 移除内联变量
    expect(theme.apply({ theme: 'light', accent: 'system', systemAccent: null }))
      .toMatchObject({ accent: 'blue', accentKind: 'preset' });
    expect(root().style['--accent']).toBeUndefined();
    expect(root().getAttribute('data-accent')).toBeNull();
  });

  it('matchMedia 跟随 OS：dark 偏好 → system 解析为 dark；reduced 偏好同理；缺席/抛错回退', () => {
    resetInputs();
    setMedia('(prefers-color-scheme: dark)', true);
    expect(theme.apply({ theme: 'system' })).toMatchObject({ theme: 'dark' });
    setMedia('(prefers-color-scheme: dark)', false);
    setMedia('(prefers-reduced-motion: reduce)', true);
    expect(theme.apply({ theme: 'light', motion: 'system' })).toMatchObject({ motion: 'reduced' });
    setMedia('(prefers-reduced-motion: reduce)', false);
    // matchMedia 缺席 → media() 回退 false
    const originalMedia = win().matchMedia;
    delete (win() as any).matchMedia;
    try {
      expect(theme.apply({ theme: 'system' })).toMatchObject({ theme: 'light' });
    } finally { (win() as any).matchMedia = originalMedia; }
    // matchMedia 抛错 → 回退
    (win() as any).matchMedia = () => { throw new Error('denied'); };
    try {
      expect(theme.apply({ theme: 'system' })).toMatchObject({ theme: 'light' });
    } finally { (win() as any).matchMedia = originalMedia; }
  });

  it('无 document.documentElement（极端环境）→ apply 返回 null 不抛', () => {
    const originalDoc = win().document;
    (win() as any).document = null;
    try {
      expect(theme.apply()).toBeNull();
    } finally { (win() as any).document = originalDoc; }
  });
});

// ---------------------------------------------------------------------------
// 族四 · set()：写本地缓存 + SETTINGS_SET 持久化 + 事件广播 + dirty 保护
// ---------------------------------------------------------------------------
describe('D-187 · theme：set() 的写一处读处处纪律（D-106）', () => {
  it('set({theme,accent,motion})：本地缓存写入 + SETTINGS_SET 线上载荷只带给出的键', async () => {
    resetInputs();
    const result = theme.set({ theme: 'dark', accent: 'amber', motion: 'reduced' });
    expect(result).toEqual({ theme: 'dark', accent: 'amber', accentKind: 'preset', motion: 'reduced' });
    expect(JSON.parse(win().localStorage.getItem('ytvdlt.appearance') as string))
      .toEqual({ theme: 'dark', accent: 'amber', motion: 'reduced' });
    expect(callsTo('ytvdlt:settings:set')[0]?.payload).toEqual({ theme: 'dark', accent: 'amber', motion: 'reduced' });
    // 事件广播（storage 跨窗跟随的另一半）
    expect(lastEvents.at(-1)).toEqual({ theme: 'dark', accent: 'amber', motion: 'reduced' });
    // 局部补丁：只发对应键，未给的键保持当前值
    globals!.bridgeCalls.length = 0;
    lastEvents = [];
    theme.set({ accent: 'teal' });
    expect(callsTo('ytvdlt:settings:set')[0]?.payload).toEqual({ accent: 'teal' });
    expect(JSON.parse(win().localStorage.getItem('ytvdlt.appearance') as string))
      .toEqual({ theme: 'dark', accent: 'teal', motion: 'reduced' });
    // 非法值归一化后才落缓存
    theme.set({ theme: 'bogus', accent: '#AABBCC', motion: 'bogus' });
    expect(JSON.parse(win().localStorage.getItem('ytvdlt.appearance') as string))
      .toEqual({ theme: 'system', accent: '#aabbcc', motion: 'system' });
    expect(callsTo('ytvdlt:settings:set').at(-1)?.payload).toEqual({ theme: 'system', accent: '#aabbcc', motion: 'system' });
    await flush();
  });

  it('set({}) / set(null)：只写本地缓存，不发线上（空补丁无线上语义）；仍置 dirty', () => {
    resetInputs();
    theme.set({});
    expect(win().localStorage.getItem('ytvdlt.appearance')).toBeTruthy();
    expect(callsTo('ytvdlt:settings:set')).toHaveLength(0);
    theme.set(null);
    expect(callsTo('ytvdlt:settings:set')).toHaveLength(0);
  });

  it('无桥 / 桥同步抛错 / 桥拒绝：本地缓存与作画不受影响', async () => {
    resetInputs();
    const original = win().ytvdltBridge;
    delete win().ytvdltBridge;
    try {
      expect(theme.set({ theme: 'dark' })).toMatchObject({ theme: 'dark' });
      expect(callsTo('ytvdlt:settings:set')).toHaveLength(0);
      expect(win().localStorage.getItem('ytvdlt.appearance')).toBeTruthy();
    } finally { win().ytvdltBridge = original; }
    win().ytvdltBridge = { invoke: () => { throw new Error('boom'); } };
    try {
      expect(theme.set({ theme: 'light' })).toMatchObject({ theme: 'light' }); // 同步抛错被吞
    } finally { win().ytvdltBridge = original; }
    {
      win().ytvdltBridge = { invoke: () => Promise.reject(new Error('down')) };
      try {
        expect(theme.set({ accent: 'rose' })).toMatchObject({ accent: 'rose' });
        await flush(); // 拒绝被 .catch 吞掉，无 unhandled rejection
      } finally { win().ytvdltBridge = original; }
    }
    // setItem 抛错 → writeLocal 静默（config.json 仍在）
    const originalSet = win().localStorage.setItem;
    win().localStorage.setItem = () => { throw new Error('quota'); };
    try {
      expect(theme.set({ theme: 'dark' })).toMatchObject({ theme: 'dark' });
    } finally { win().localStorage.setItem = originalSet; }
    win().localStorage.clear();
  });

  it('dirty 保护：set 之后 sync() 仍会发问，但拒绝用旧快照覆盖新选择', async () => {
    resetInputs();
    theme.set({ theme: 'dark' });
    const snapshot = await theme.sync();
    expect(snapshot).toBeNull(); // in-flight 语义：用户的选择比 config.json 快照新
    // 快照查询发生了，只是应答被丢弃 —— 这正是「绝不覆盖」的实现方式
    expect(callsTo('ytvdlt:settings:get')).toHaveLength(1);
    expect(win().localStorage.getItem('ytvdlt.appearance')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 族五 · sync()：config.json 权威快照的落缓存与查询覆盖豁免
// （set() 会把模块级 dirty 置真且永不复位 —— 重装一个干净实例来测 sync。）
// ---------------------------------------------------------------------------
describe('D-187 · theme：sync() 拉权威快照（重启与跨页的唯一真相）', () => {
  it('重装干净实例（dirty=false 基线）', async () => {
    resetInputs(); // set() 写下的 localStorage 是重装实例的首帧输入，先清掉
    vi.resetModules();
    await loadUiModule('theme/theme.js', globals!);
    theme = win().YTVDLTTheme;
    expect(theme.state().theme).toBe('system');
  });

  it('快照落地：写缓存 + 作画 + 广播，返回 next；查询覆盖时直接豁免', async () => {
    resetInputs();
    win().ytvdltBridge = { invoke: (channel: string) => channel === 'ytvdlt:settings:get'
      ? { theme: 'dark', accent: '#12AB34', motion: 'reduced', systemAccent: '#ff00ff' }
      : {} };
    const next = await theme.sync();
    expect(next).toEqual({ theme: 'dark', accent: '#12ab34', motion: 'reduced', systemAccent: '#ff00ff' });
    expect(JSON.parse(win().localStorage.getItem('ytvdlt.appearance') as string)).toEqual(next);
    expect(root().getAttribute('data-theme')).toBe('dark');
    expect(root().style['--accent']).toBe('#12ab34');
    expect(lastEvents.at(-1)).toEqual({ theme: 'dark', accent: '#12ab34', motion: 'reduced', systemAccent: '#ff00ff' });
    // 查询覆盖 → 确定性渲染豁免：不发问也不落缓存
    resetInputs();
    win().location.search = '?theme=dark';
    expect(await theme.sync()).toBeNull();
    expect(callsTo('ytvdlt:settings:get')).toHaveLength(0);
    // accent-only 的查询同样豁免
    win().location.search = '?accent=teal';
    expect(await theme.sync()).toBeNull();
    win().location.search = '?motion=reduced';
    expect(await theme.sync()).toBeNull();
    win().location.search = '';
    // 快照形状：{} 是合法对象 → normalize 后走默认值（system / blue / system）
    resetInputs();
    win().ytvdltBridge = { invoke: () => ({}) }; // 空对象快照
    const defaults = await theme.sync();
    expect(defaults).toEqual({ theme: 'system', accent: 'system', motion: 'system', systemAccent: null });
    // null / 字符串快照 → 形状不对 → null（不写不画）
    win().ytvdltBridge = { invoke: () => null };
    expect(await theme.sync()).toBeNull();
    win().ytvdltBridge = { invoke: () => 'nonsense' };
    expect(await theme.sync()).toBeNull();
    // 拒绝 → catch → null
    win().ytvdltBridge = { invoke: () => Promise.reject(new Error('down')) };
    expect(await theme.sync()).toBeNull();
    resetInputs();
  });

  it('无桥：sync 立即返回 null，不发问', async () => {
    resetInputs();
    const original = win().ytvdltBridge;
    delete win().ytvdltBridge;
    try {
      expect(await theme.sync()).toBeNull();
      expect(callsTo('ytvdlt:settings:get')).toHaveLength(0);
    } finally { win().ytvdltBridge = original; }
  });
});

// ---------------------------------------------------------------------------
// 族六 · watch() / listen()：运行时跟随 OS 与跨窗口跟随
// ---------------------------------------------------------------------------
describe('D-187 · theme：watch（OS 偏好）与 listen（跨窗口 storage）', () => {
  it('watch：dark / reduced 两条查询都挂监听；变化回调触发重画；dispose 成对移除', () => {
    resetInputs();
    const registered: Array<{ query: string; handler: () => void }> = [];
    const removed: Array<{ query: string; handler: () => void }> = [];
    const originalMedia = win().matchMedia;
    (win() as any).matchMedia = (query: string) => ({
      matches: mediaMatches.get(query) === true,
      addEventListener(_type: string, handler: () => void) { registered.push({ query, handler }); },
      removeEventListener(_type: string, handler: () => void) { removed.push({ query, handler }); },
    });
    try {
      const seen: Array<Record<string, unknown>> = [];
      const dispose = theme.watch((result: Record<string, unknown>) => { seen.push(result); });
      expect(registered.map((r) => r.query).sort()).toEqual([
        '(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)',
      ]);
      // OS 翻转：handler 触发 → 重画 + onChange 回调
      setMedia('(prefers-color-scheme: dark)', true);
      registered[0].handler();
      expect(root().getAttribute('data-theme')).toBe('dark');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ theme: 'dark' });
      dispose();
      expect(removed).toHaveLength(2);
    } finally {
      (win() as any).matchMedia = originalMedia;
      mediaMatches = new Map();
    }
  });

  it('watch：无 onChange 也重画；mql 无 addEventListener（旧内核）→ dispose 安全；matchMedia 缺席 → noop', () => {
    resetInputs();
    const originalMedia = win().matchMedia;
    (win() as any).matchMedia = () => ({ matches: false }); // 无 add/removeEventListener
    try {
      const dispose = theme.watch(undefined);
      dispose(); // 空退订列表 → noop 不抛
    } finally { (win() as any).matchMedia = originalMedia; }
    delete (win() as any).matchMedia;
    try {
      const noop = theme.watch(() => undefined);
      expect(typeof noop).toBe('function');
      noop();
    } finally { (win() as any).matchMedia = originalMedia; }
  });

  it('listen：storage 事件按 key 过滤（ytvdlt.appearance 或 key=null 才跟随），dispose 退订', () => {
    resetInputs();
    const dispose = theme.listen();
    // 别的 key → 忽略
    win().dispatch('storage', { key: 'other.key' });
    expect(lastEvents).toHaveLength(0);
    // key=null（clear()）→ 跟随
    win().dispatch('storage', { key: null });
    expect(lastEvents).toHaveLength(1);
    // 本 key → 跟随并重画
    win().localStorage.setItem('ytvdlt.appearance', JSON.stringify({ theme: 'dark', accent: 'violet', motion: 'full' }));
    win().dispatch('storage', { key: 'ytvdlt.appearance' });
    expect(lastEvents).toHaveLength(2);
    expect(root().getAttribute('data-theme')).toBe('dark');
    expect(lastEvents[1]).toEqual({ theme: 'dark', accent: 'violet', accentKind: 'preset', motion: 'full', systemAccent: null });
    // 无变化（重画结果相同）→ 仍广播（apply 非 null）
    dispose();
    win().dispatch('storage', { key: 'ytvdlt.appearance' });
    expect(lastEvents).toHaveLength(2); // dispose 后不再跟随
  });

  it('listen：addEventListener 缺席（旧内核）→ 返回 noop', () => {
    const originalAdd = win().addEventListener;
    (win() as any).addEventListener = undefined;
    try {
      const noop = theme.listen();
      expect(typeof noop).toBe('function');
      noop();
    } finally { (win() as any).addEventListener = originalAdd; }
  });

  it('STORAGE_KEY 常量与本地缓存键一致（跨页契约）', () => {
    expect(theme.STORAGE_KEY).toBe('ytvdlt.appearance');
  });
});
