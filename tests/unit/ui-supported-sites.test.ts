/**
 * ui-supported-sites.test.ts — supported-sites.js 真实行为单测（D-187 · packages/ui 纳入覆盖率统计）。
 *
 * 【为什么是 import 而不是 runInNewContext】runInNewContext 在 VM 沙箱里执行，
 * v8 覆盖率提供器看不到任何路径。本文件用共享装载架 tests/unit/helpers/
 * ui-harness.ts 真实 `import()` 源码，再驱动 window.YTVDLT.supportedSites.create()
 * 返回的实例（mount/open/setQuery/setSort/stateOf 等）。
 *
 * 【与既有 runInNewContext 测试的关系】supported-sites-panel.test.ts 钉住的语义
 * 在这里按 import 路线全部对齐保住：名单只来自 SUPPORTED_SITES DTO（无 enginePath、
 * 不出现任何路径）、失败绝不渲染成空名单（每个 code 一句稳定文案 + 控件禁用）、
 * GenericIE 说明行只在引擎真的报 generic 时出现（D-134）、refresh 只允许发
 * `refresh:true` 而冷开不带任何参数。
 *
 * 【与 harness 的适配】真实 DOM 里 `el.textContent = ''` 会移除子节点，harness 的
 * textContent 只是普通属性 —— 测试在列表节点上按场景补齐该语义（parentNode /
 * '.sites-row' 匹配同理），不改 harness 本体。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installUiGlobals, loadUiModule, type UiGlobals } from './helpers/ui-harness.js';

/** zh-CN 文案表：与 i18n/messages.js 同形（MISSING: 前缀用于自我暴露）。 */
const MESSAGES: Record<string, string> = {
  'sites.entry': '支持的网站',
  'sites.title': '支持的网站',
  'sites.close': '关闭',
  'sites.search': '搜索站点或解析器名称',
  'sites.sort.name': '按名称排序',
  'sites.sort.broken': '失效优先',
  'sites.refresh': '刷新',
  'sites.loading': '正在向下载引擎查询…',
  'sites.summary': '引擎 {version} · 站点 {sites} 个 · 子解析器 {subs} 个',
  'sites.summary.cached': '引擎 {version} · 站点 {sites} 个 · 子解析器 {subs} 个（缓存）',
  'sites.version.unknown': '版本未知',
  'sites.broken': '引擎标记为失效',
  'sites.genericBadge': '通用',
  'sites.generic.note': '通用解析器（generic）会对任意网页尝试查找媒体文件，这不代表所有网站都能下载成功。',
  'sites.emptyFilter': '没有匹配的站点。',
  'sites.more': '还有 {count} 条，点击展开',
  'sites.error.timeout': '下载引擎未在限时内响应，请稍后重试。',
  'sites.error.unavailable': '当前构建无法查询下载引擎，此处不提供站点名单。',
  'sites.error.empty': '引擎返回了空列表，可能是引擎文件异常。',
  'sites.error.tooLarge': '引擎输出的列表超出安全上限，已中止读取。',
  'sites.error.failed': '无法获取站点列表，请查看运行时自检。',
};

const t = (key: string, params?: Record<string, unknown>): string => {
  let text = MESSAGES[key] ?? `MISSING:${key}`;
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.split(`{${name}}`).join(String(value));
  }
  return text;
};

let globals: UiGlobals | null = null;
let doc: any;
let sites: any; // window.YTVDLT.supportedSites

const flush = async (rounds = 10): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};

/* ------------------------------------------------------- DTO 与 DOM 工具 -- */

interface DtoRow { name: string; parent?: string; broken?: boolean; isGeneric?: boolean }
const row = (name: string, extra: Omit<DtoRow, 'name'> = {}): DtoRow => ({ name, ...extra });
const catalogDto = (extra: Record<string, unknown> = {}) => ({
  ok: true,
  rows: [row('youtube')],
  engineVersion: '2026.10.26',
  siteCount: 1308,
  subExtractorCount: 445,
  brokenCount: 0,
  hasGeneric: true,
  cached: false,
  fetchedAt: '2026-11-14T00:00:00Z',
  ...extra,
});

const deepAll = (node: any, out: any[] = []): any[] => {
  for (const child of node.children ?? []) { out.push(child); deepAll(child, out); }
  return out;
};
const byIdIn = (root: any, id: string): any => deepAll(root).find((n) => n.getAttribute('id') === id) ?? null;
const byClassIn = (root: any, cls: string): any => deepAll(root).find((n) => n.className === cls) ?? null;
const overlays = (): any[] => deepAll(doc.body).filter((n) => n.className === 'sites-overlay');
const overlayOf = (): any => overlays().at(-1) ?? null;
/** harness 的 textContent 不聚合子节点；叶子文本要自己收集。 */
const fullText = (root: any): string => deepAll(root).map((n) => n.textContent).filter(Boolean).join('\n');
const rowText = (node: any): string => deepAll(node).map((n) => n.textContent).filter(Boolean).join(' ');
const listRows = (overlay: any): any[] => {
  const list = byIdIn(overlay, 'sites-list');
  return list ? list.children.filter((c: any) => c.className === 'sites-row') : [];
};
const rowNames = (overlay: any): string[] => listRows(overlay).map((n) => n.getAttribute('data-name'));

/** 真实 DOM 语义补丁：textContent 清空子节点；appendChild 回填 parentNode；
 *  '.sites-row' 的类名匹配（panel.rowCount 依赖它）。 */
function wireList(overlay: any): void {
  const list = byIdIn(overlay, 'sites-list');
  if (!list || list.__uiWired) return;
  list.__uiWired = true;
  let text = '';
  Object.defineProperty(list, 'textContent', {
    get: () => text,
    set: (value: string) => { text = value; list.children.length = 0; },
    configurable: true,
  });
  const rawAppend = list.appendChild.bind(list);
  list.appendChild = (child: any) => { child.parentNode = list; return rawAppend(child); };
  list.querySelectorAll = (selector: string) => selector === '.sites-row'
    ? list.children.filter((c: any) => c.className === 'sites-row')
    : [];
}

interface Panel {
  panel: any;
  calls: Array<{ channel: string; payload: any }>;
  setResponder(fn: (payload: any) => unknown): void;
}

function makePanel(initialDto?: Record<string, unknown>): Panel {
  const calls: Array<{ channel: string; payload: any }> = [];
  let responder: (payload: any) => unknown = () => initialDto ?? catalogDto({});
  const call = (channel: string, payload?: unknown) => {
    calls.push({ channel, payload });
    return Promise.resolve(responder(payload));
  };
  const panel = sites.create({ doc, t, call });
  return { panel, calls, setResponder: (fn) => { responder = fn; } };
}

/** 走 mount 出来的真实入口按钮打开面板；不自动 settle，方便断言 loading 中间态。 */
function opened(h: Panel) {
  const anchor = doc.createElement('button');
  const holder = doc.createElement('div');
  holder.appendChild(anchor);
  anchor.parentNode = holder;
  h.panel.mount(anchor, 'supported-sites.css');
  const entry = deepAll(holder).find((n) => n.getAttribute('id') === 'queue-sites-entry');
  entry.dispatch('click', { preventDefault() {} });
  const overlay = overlayOf();
  wireList(overlay);
  return { h, overlay, entry, anchor };
}

beforeAll(async () => {
  vi.useFakeTimers();
  globals = installUiGlobals({ bridge: null });
  doc = globals.document;
  // overlay 挂到 body、close() 要从 body 移除 —— appendChild 需要回填 parentNode
  const body = doc.body;
  const rawAppend = body.appendChild.bind(body);
  body.appendChild = (child: any) => { child.parentNode = body; return rawAppend(child); };
  await loadUiModule('sites/supported-sites.js', globals);
  sites = (globals.attached.YTVDLT as any).supportedSites;
});

afterAll(() => {
  globals?.restore();
  globals = null;
  vi.useRealTimers();
});

/* ---------------------------------------------------------------- 测试 -- */

describe('D-187 · supported-sites.js 装载与挂载（D-134 A）', () => {
  it('真实 import 后暴露 create 工厂与 PAGE_SIZE=60', () => {
    expect(typeof sites.create).toBe('function');
    expect(sites.PAGE_SIZE).toBe(60);
  });

  it('mount 在锚点后插入入口按钮并带样式表；重复 mount 只有一个入口', () => {
    const h = makePanel();
    const anchor = doc.createElement('button');
    const holder = doc.createElement('div');
    holder.appendChild(anchor);
    anchor.parentNode = holder;
    const before = doc.head.children.filter((n) => n.getAttribute('href') === 'supported-sites.css').length;
    h.panel.mount(anchor, 'supported-sites.css');
    const entries = deepAll(holder).filter((n) => n.getAttribute('id') === 'queue-sites-entry');
    expect(entries).toHaveLength(1);
    expect(entries[0].textContent).toBe('支持的网站');
    expect(doc.head.children.filter((n) => n.getAttribute('href') === 'supported-sites.css').length).toBe(before + 1);
    h.panel.mount(anchor, 'supported-sites.css');
    expect(deepAll(holder).filter((n) => n.getAttribute('id') === 'queue-sites-entry')).toHaveLength(1);
  });

  it('无锚点 / 锚点无父节点时安全返回', () => {
    const h = makePanel();
    expect(() => h.panel.mount(null, 'x.css')).not.toThrow();
    const orphan = doc.createElement('button');
    orphan.parentNode = null;
    expect(() => h.panel.mount(orphan, 'x.css')).not.toThrow();
  });
});

describe('打开与查询（通道 SUPPORTED_SITES）', () => {
  it('入口点击 → 冷查询不带任何参数，loading 中间态可见', async () => {
    const h = makePanel();
    const { overlay } = opened(h);
    expect(overlay).not.toBeNull();
    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(h.calls[0].channel).toBe('SUPPORTED_SITES');
    expect(h.calls[0].payload).toEqual({});
    expect(h.panel.stateOf()).toBe('loading');
    expect(byIdIn(overlay, 'sites-status').textContent).toBe('正在向下载引擎查询…');
    expect(byIdIn(overlay, 'sites-refresh').disabled).toBe(true);
    await flush();
    expect(h.panel.stateOf()).toBe('ready');
  });

  it('ready 后渲染行；ready 状态重开不再发查询、不叠加 overlay', async () => {
    const h = makePanel();
    const { overlay, entry } = opened(h);
    await flush();
    expect(rowNames(overlay)).toEqual(['youtube']);
    expect(byIdIn(overlay, 'sites-refresh').disabled).toBe(false);
    // shell() 必须复用同一个 overlay（此前测试的面板也会留在 body 里，按增量断言）
    const overlaysBefore = overlays().length;
    entry.dispatch('click', { preventDefault() {} });
    expect(h.calls).toHaveLength(1);
    expect(overlays().length).toBe(overlaysBefore);
    expect(overlayOf()).toBe(overlay);
  });

  it('关闭按钮 / 背景点击可关闭；点在面板内部不关闭；失败后重开会重新查询', async () => {
    const h = makePanel(catalogDto({ ok: false, code: 'ENGINE_FAILED', rows: [] }));
    const { overlay } = opened(h);
    await flush();
    expect(h.panel.stateOf()).toBe('failed');
    const close = deepAll(overlay).find((n) => n.className === 'sites-close');
    close.dispatch('click');
    expect(h.panel.isOpen()).toBe(false);

    h.panel.open(); // 失败态重开 → 重新 load
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].payload).toEqual({});
    expect(h.panel.stateOf()).toBe('failed');

    const overlay2 = overlayOf();
    wireList(overlay2);
    overlay2.dispatch('click', { target: overlay2 });
    expect(h.panel.isOpen()).toBe(false);

    h.panel.open();
    const overlay3 = overlayOf();
    overlay3.dispatch('click', { target: byClassIn(overlay3, 'sites-panel') });
    expect(h.panel.isOpen()).toBe(true);
  });

  it('关闭后 setQuery / setSort / rowCount 安全返回（listBox 已置空）', () => {
    const h = makePanel();
    opened(h);
    h.panel.close();
    expect(() => h.panel.setQuery('x')).not.toThrow();
    expect(() => h.panel.setSort('broken')).not.toThrow();
    expect(h.panel.rowCount()).toBe(0);
    expect(h.panel.isOpen()).toBe(false);
  });
});

describe('名单渲染：只来自 SUPPORTED_SITES DTO，不出现任何路径', () => {
  it('broken / generic / parent 标记与文案（默认按名称排序）', async () => {
    const h = makePanel(catalogDto({
      rows: [row('youtube'), row('brokenone', { broken: true }), row('generic', { isGeneric: true }), row('youtubetab:playlist', { parent: 'youtubetab' })],
    }));
    const { overlay } = opened(h);
    await flush();
    expect(rowNames(overlay)).toEqual(['brokenone', 'generic', 'youtube', 'youtubetab:playlist']);
    const find = (name: string) => listRows(overlay).find((n) => n.getAttribute('data-name') === name)!;
    expect(find('brokenone').getAttribute('data-broken')).toBe('1');
    expect(rowText(find('brokenone'))).toContain('引擎标记为失效');
    expect(find('generic').getAttribute('data-generic')).toBe('1');
    expect(rowText(find('generic'))).toContain('通用');
    expect(find('youtubetab:playlist').getAttribute('data-parent')).toBe('youtubetab');
    expect(rowText(find('youtubetab:playlist'))).toContain('youtubetab');
  });

  it('DTO 无 enginePath：请求载荷只有冷开 {}，渲染结果不出现路径；行集合与 DTO 完全一致', async () => {
    const h = makePanel(catalogDto({ rows: [row('youtube'), row('brokenone', { broken: true })] }));
    const { overlay } = opened(h);
    await flush();
    for (const call of h.calls) {
      expect(Object.keys(call.payload)).toEqual([]);
      expect(JSON.stringify(call.payload)).not.toContain('enginePath');
    }
    expect(fullText(overlay)).not.toMatch(/enginePath|\.exe|[A-Za-z]:[\\/]/);
    expect(rowNames(overlay).sort()).toEqual(['brokenone', 'youtube']);
  });

  it('摘要：版本 + 两个计数；cached 文案不同；版本空 → 版本未知', async () => {
    const fresh = makePanel(catalogDto({ siteCount: 1308, subExtractorCount: 445 }));
    const a = opened(fresh);
    await flush();
    expect(byClassIn(a.overlay, 'sites-summary').textContent).toBe('引擎 2026.10.26 · 站点 1308 个 · 子解析器 445 个');

    const cached = makePanel(catalogDto({ cached: true }));
    const b = opened(cached);
    await flush();
    expect(byClassIn(b.overlay, 'sites-summary').textContent).toBe('引擎 2026.10.26 · 站点 1308 个 · 子解析器 445 个（缓存）');

    const unknown = makePanel(catalogDto({ engineVersion: '' }));
    const c = opened(unknown);
    await flush();
    expect(byClassIn(c.overlay, 'sites-summary').textContent).toContain('版本未知');
    expect(byClassIn(c.overlay, 'sites-summary').textContent).not.toContain('MISSING:');
  });

  it('rows 形状不对时仍 ready，但列表给空过滤提示（不编造名单）', async () => {
    const h = makePanel({ ok: true });
    const { overlay } = opened(h);
    await flush();
    expect(h.panel.stateOf()).toBe('ready');
    expect(listRows(overlay)).toHaveLength(0);
    expect(byIdIn(overlay, 'sites-status').textContent).toBe('没有匹配的站点。');
  });
});

describe('搜索过滤 / 排序 / 分页', () => {
  it('搜索框过滤；无匹配给文案而不是空名单；input 事件同样驱动', async () => {
    const h = makePanel(catalogDto({ rows: [row('alpha'), row('beta')] }));
    const { overlay } = opened(h);
    await flush();
    h.panel.setQuery('alp');
    expect(rowNames(overlay)).toEqual(['alpha']);
    h.panel.setQuery('nope-nothing');
    expect(listRows(overlay)).toHaveLength(0);
    expect(byIdIn(overlay, 'sites-status').textContent).toBe('没有匹配的站点。');
    const search = byIdIn(overlay, 'sites-search');
    search.value = 'beta';
    search.dispatch('input');
    expect(rowNames(overlay)).toEqual(['beta']);
    search.value = '';
    search.dispatch('input');
    expect(rowNames(overlay)).toEqual(['alpha', 'beta']);
  });

  it('默认按名称排序；broken 排序把失效行提前；select change 同样生效', async () => {
    const h = makePanel(catalogDto({ rows: [row('zeta'), row('alpha'), row('mid', { broken: true })] }));
    const { overlay } = opened(h);
    await flush();
    expect(rowNames(overlay)).toEqual(['alpha', 'mid', 'zeta']);
    const sort = byIdIn(overlay, 'sites-sort');
    expect(sort.children.map((o: any) => o.getAttribute('value'))).toEqual(['name', 'broken']);
    expect(sort.children.map((o: any) => o.textContent)).toEqual([MESSAGES['sites.sort.name'], MESSAGES['sites.sort.broken']]);
    sort.value = 'broken';
    sort.dispatch('change');
    // broken 排序只比较失效标记（稳定排序）：失效行提前，其余保持引擎顺序
    expect(rowNames(overlay)).toEqual(['mid', 'zeta', 'alpha']);
    h.panel.setSort('name');
    expect(rowNames(overlay)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('分页：每页 60 条，“更多”逐页展开，展开完消失；summary 带 data-shown', async () => {
    const many = Array.from({ length: 130 }, (_v, i) => row(`site${String(i).padStart(4, '0')}`));
    const h = makePanel(catalogDto({ rows: many, hasGeneric: false }));
    const { overlay } = opened(h);
    await flush();
    expect(listRows(overlay)).toHaveLength(60);
    expect(byClassIn(overlay, 'sites-summary').getAttribute('data-shown')).toBe('60');
    let more = byIdIn(overlay, 'sites-more');
    expect(more.textContent).toBe('还有 70 条，点击展开');
    more.dispatch('click');
    expect(listRows(overlay)).toHaveLength(120);
    more = byIdIn(overlay, 'sites-more');
    expect(more.textContent).toBe('还有 10 条，点击展开');
    more.dispatch('click');
    expect(listRows(overlay)).toHaveLength(130);
    expect(byIdIn(overlay, 'sites-more')).toBeNull();
    expect(h.panel.rowCount()).toBe(130);
  });

  it('单页装得下时没有“更多”；resize() 暴露每页条数', async () => {
    const h = makePanel(catalogDto({ rows: [row('only')] }));
    const { overlay } = opened(h);
    await flush();
    expect(byIdIn(overlay, 'sites-more')).toBeNull();
    expect(h.panel.resize()).toBe(60);
    expect(h.panel.rowCount()).toBe(1);
  });
});

describe('GenericIE 说明行（D-134）', () => {
  it('引擎报 generic 才显示；没有时清空并隐藏（不留陈旧说明）', async () => {
    const withNote = makePanel(catalogDto({ hasGeneric: true }));
    const a = opened(withNote);
    await flush();
    const noteA = byIdIn(a.overlay, 'sites-generic-note');
    expect(noteA.textContent).toBe(MESSAGES['sites.generic.note']);
    expect(noteA.hasAttribute('hidden')).toBe(false);

    const without = makePanel(catalogDto({ hasGeneric: false }));
    const b = opened(without);
    await flush();
    const noteB = byIdIn(b.overlay, 'sites-generic-note');
    expect(noteB.textContent).toBe('');
    expect(noteB.getAttribute('hidden')).toBe('hidden');
  });
});

describe('失败呈现：绝不把失败渲染成空名单', () => {
  const cases: Array<[string, string]> = [
    ['ENGINE_TIMEOUT', MESSAGES['sites.error.timeout']],
    ['ENGINE_UNAVAILABLE', MESSAGES['sites.error.unavailable']],
    ['ENGINE_EMPTY', MESSAGES['sites.error.empty']],
    ['OUTPUT_LIMIT_EXCEEDED', MESSAGES['sites.error.tooLarge']],
    ['ENGINE_FAILED', MESSAGES['sites.error.failed']],
    ['SOMETHING_UNSEEN', MESSAGES['sites.error.failed']],
  ];

  for (const [code, expected] of cases) {
    it(`${code} → 独立稳定文案 + 控件禁用 + 零行`, async () => {
      const h = makePanel({ ok: false, code, rows: [], engineVersion: '', siteCount: 0, subExtractorCount: 0, brokenCount: 0, hasGeneric: false, cached: false, fetchedAt: '' });
      const { overlay } = opened(h);
      await flush();
      expect(h.panel.stateOf()).toBe('failed');
      expect(listRows(overlay)).toHaveLength(0);
      expect(byIdIn(overlay, 'sites-status').textContent).toBe(expected);
      expect(byIdIn(overlay, 'sites-status').textContent).not.toContain('MISSING:');
      // 失败时控件禁用而不是假装可用；刷新保持可点（重试入口）
      expect(byIdIn(overlay, 'sites-search').disabled).toBe(true);
      expect(byIdIn(overlay, 'sites-sort').disabled).toBe(true);
      expect(byIdIn(overlay, 'sites-refresh').disabled).toBe(false);
    });
  }

  it('载荷为 null 也按失败处理（不编造名单）', async () => {
    const h = makePanel();
    h.setResponder(() => null);
    const { overlay } = opened(h);
    await flush();
    expect(h.panel.stateOf()).toBe('failed');
    expect(byIdIn(overlay, 'sites-status').textContent).toBe(MESSAGES['sites.error.failed']);
    expect(listRows(overlay)).toHaveLength(0);
  });

  it('六个失败码映射出 5 种不同文案', async () => {
    const texts = new Set<string>();
    for (const [code] of cases) {
      const h = makePanel({ ok: false, code, rows: [] });
      opened(h);
      await flush();
      texts.add(byIdIn(overlayOf(), 'sites-status').textContent);
    }
    // timeout / unavailable / empty / tooLarge / failed 是五种不同处境
    expect(texts.size).toBe(5);
  });
});

describe('refresh 按钮：只带 refresh:true；进行中禁用并吞并发', () => {
  it('ready 后点刷新 → { refresh:true } 并重绘；挂起期间再点被吞', async () => {
    const h = makePanel();
    const { overlay } = opened(h);
    await flush();
    expect(rowNames(overlay)).toEqual(['youtube']);
    let release: (value: unknown) => void = () => {};
    h.setResponder(() => new Promise((resolve) => { release = resolve; }));
    const refresh = byIdIn(overlay, 'sites-refresh');
    let prevented = 0;
    refresh.dispatch('click', { preventDefault() { prevented += 1; } });
    expect(prevented).toBe(1);
    expect(h.calls[1].payload).toEqual({ refresh: true });
    expect(refresh.disabled).toBe(true);
    refresh.dispatch('click', { preventDefault() {} }); // loading 中 → 吞掉
    expect(h.calls).toHaveLength(2);
    release(catalogDto({ rows: [row('youtube'), row('vimeo')] }));
    await flush();
    expect(refresh.disabled).toBe(false);
    // 重绘按名称重排，旧行不残留
    expect(rowNames(overlay)).toEqual(['vimeo', 'youtube']);
  });

  it('刷新走的是 load(true)：失败码应答后回到失败态', async () => {
    const h = makePanel();
    const { overlay } = opened(h);
    await flush();
    h.setResponder(() => ({ ok: false, code: 'ENGINE_TIMEOUT', rows: [] }));
    byIdIn(overlay, 'sites-refresh').dispatch('click', { preventDefault() {} });
    await flush();
    expect(h.calls.at(-1)?.payload).toEqual({ refresh: true });
    expect(h.panel.stateOf()).toBe('failed');
    expect(byIdIn(overlayOf(), 'sites-status').textContent).toBe(MESSAGES['sites.error.timeout']);
  });
});
