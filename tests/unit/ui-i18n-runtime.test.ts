/**
 * D-187 · i18n.js（运行时语言应用）真实行为单测 —— import 路线，v8 覆盖率可见。
 *
 * 既有 tests/unit/i18n.test.ts 用 `new Function` 沙箱审计 messages.js 字典本身
 * （键集合 / 占位符 / 短语表），对 `i18n.js` 的运行时行为只字未提；本文件用共享
 * 装载架 tests/unit/helpers/ui-harness.ts 真实 `import()` 装载 messages.js +
 * i18n.js，驱动 window.YTVDLT.i18n 暴露的测试面，覆盖：
 *   - 语言解析优先级：?lang= → __YTVDLT_SETTINGS__（locale/language）→ 默认 zh-CN；
 *   - t(key, params) 插值与缺键回退（zh 回退 → 键名兜底）；
 *   - data-i18n / data-i18n-placeholder / data-i18n-aria-label / data-i18n-title
 *     批量应用，含「占位符模板不落 DOM」「保留子节点只换首个文本节点」两条纪律；
 *   - 冻结短语表（zh → en）对 M3 对话框文本节点的整节点替换与 SCRIPT 跳过；
 *   - zh-CN 默认语言零写入（M3 基线冻结）、缺键统计、溢出统计、formatDate；
 *   - DOMContentLoaded 自动应用（readyState=loading 装载后派发事件触发）；
 *   - 双语字典一致性在 import 路线下重钉（与 messages.js 的键集合 / 占位符）。
 *
 * 【模块单例】i18n.js 在 import 时刻捕获 CATALOGUE（= messages.js 的 YTVDLT_I18N），
 * 之后 settings()/apply() 每次调用都现读 location.search / __YTVDLT_SETTINGS__ /
 * document，场景差异全部通过「改 search / 换注入 / 换注册的假节点」构造。
 * 【假 DOM】装载架的 uiNode 缺 firstChild/childNodes/nodeType/nodeValue，而
 * i18n.js 的 applyAttributes/translatePhrases 恰好要读写它们 —— domNode/textNode
 * 在测试侧补齐这些形状（不改 harness 文件），并用测试侧 querySelectorAll 实现
 * 属性选择器匹配（装载架默认返回空数组）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installUiGlobals, loadUiModule, uiNode, type UiGlobals, type UiNode } from './helpers/ui-harness.js';

let globals: UiGlobals | null = null;
let i18n: any = null; // window.YTVDLT.i18n
let catalogue: any = null; // window.YTVDLT_I18N（messages.js 附加）

const win = () => globals!.window as Record<string, any>;
const doc = () => globals!.document as Record<string, any>;
/** 期望文案从真实字典取（字典内容变化不脆断）。 */
const zh = (key: string): string => catalogue.MESSAGES['zh-CN'][key];
const en = (key: string): string => catalogue.MESSAGES.en[key];

// ---------------------------------------------------------------------------
// 测试侧假 DOM：补齐 i18n.js 需要的节点形状 + 属性选择器匹配。
// ---------------------------------------------------------------------------
/** 注册进假 document 的节点池；querySelectorAll 按选择器从池里筛。 */
const pool: UiNode[] = [];

function matchAlternative(node: UiNode, alt: string): boolean {
  // 注意：data-i18n 键名含数字（i18n），字符类必须包含 0-9。
  const attr = /^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/.exec(alt.trim());
  if (attr !== null) {
    const value = node.getAttribute(attr[1]);
    return attr[2] === undefined ? value !== null : value === attr[2];
  }
  if (alt.startsWith('.')) return node.classList.contains(alt.slice(1));
  return node.tagName === alt.trim().toUpperCase();
}

function matchesSelector(node: UiNode, selector: string): boolean {
  return selector.split(',').some((alt) => matchAlternative(node, alt));
}

/** i18n.js 会读写 firstChild / childNodes / nodeType，uiNode 没有这三样 —— 补齐。 */
function domNode(tag = 'div'): UiNode {
  const n = uiNode(tag);
  n.nodeType = 1;
  Object.defineProperty(n, 'firstChild', { get: () => n.children[0] ?? null, configurable: true });
  Object.defineProperty(n, 'childNodes', { get: () => n.children, configurable: true });
  return n;
}

/** 文本节点：nodeType=3 + nodeValue（translatePhrases / applyAttributes 的操作对象）。 */
function textNode(value: string): UiNode {
  const n = uiNode('#text');
  n.nodeType = 3;
  (n as unknown as { nodeValue: string }).nodeValue = value;
  return n;
}

function register(node: UiNode): UiNode {
  pool.push(node);
  return node;
}

beforeAll(async () => {
  globals = installUiGlobals({
    // i18n.js 不需要桥；readyState 故意给 'loading'：import 时 i18n.js 走
    // DOMContentLoaded 分支而不是立即 apply —— 自动应用行为由专属用例派发事件触发。
    readyState: 'loading',
    location: { href: 'file:///C:/app/pages/queue/index.html', search: '', protocol: 'file:' },
  });
  // 装载架的 document.addEventListener 是空转的；这里测试侧补一个记录器，
  // 让 DOMContentLoaded 自动应用分支可以真正被派发（纯测试侧协作桩）。
  const docListeners: Record<string, ((event?: unknown) => void)[]> = {};
  (doc() as any).addEventListener = (type: string, fn: (event?: unknown) => void): void => {
    (docListeners[type] ??= []).push(fn);
  };
  (doc() as any).__fire = (type: string, event?: unknown): void => {
    for (const fn of docListeners[type] ?? []) fn(event);
  };
  // 装载架的 querySelectorAll 只认 [data-x=…] 且只查 children；i18n.js 的四个
  // 查询都是文档级属性/标签选择器 —— 测试侧换成池筛选实现。
  (doc() as any).querySelectorAll = (selector: string): UiNode[] =>
    pool.filter((n) => matchesSelector(n, selector));
  // translatePhrases 从 doc.body 出发游走 —— body 也要有 childNodes 形状。
  const body = doc().body as UiNode;
  body.nodeType = 1;
  Object.defineProperty(body, 'childNodes', { get: () => body.children, configurable: true });
  Object.defineProperty(body, 'firstChild', { get: () => body.children[0] ?? null, configurable: true });

  await loadUiModule('i18n/messages.js', globals);
  await loadUiModule('i18n/i18n.js', globals);
  i18n = (win().YTVDLT as Record<string, any>).i18n;
  catalogue = win().YTVDLT_I18N;
});

afterAll(() => {
  globals?.restore();
  globals = null;
});

/** 每个用例结束把 search / 注入 / 池 / 文档标记复原，防止语言状态跨用例泄漏。 */
function resetLocaleState(): void {
  win().location.search = '';
  delete win().__YTVDLT_SETTINGS__;
  pool.length = 0;
  (doc().body as UiNode).children.length = 0;
  doc().documentElement.removeAttribute('lang');
  doc().documentElement.removeAttribute('data-lang');
  (doc().body as UiNode).removeAttribute('data-text-overflow');
  (doc().body as UiNode).removeAttribute('data-i18n-missing');
}

// ---------------------------------------------------------------------------
// 族一 · 语言解析优先级（?lang= → 注入设置 → 默认）与 normalizeLocale
// ---------------------------------------------------------------------------
describe('D-187 · i18n 语言解析优先级与 normalizeLocale', () => {
  it('normalizeLocale 把混乱的 OS locale 归一到两种发行语言，其余落默认', () => {
    expect(i18n.LOCALES).toEqual(['zh-CN', 'en']);
    expect(i18n.DEFAULT_LOCALE).toBe('zh-CN');
    expect(i18n.normalizeLocale('en')).toBe('en');
    expect(i18n.normalizeLocale('en-US')).toBe('en');
    expect(i18n.normalizeLocale('EN_us')).toBe('en');
    expect(i18n.normalizeLocale(' en-GB ')).toBe('en');
    expect(i18n.normalizeLocale('zh')).toBe('zh-CN');
    expect(i18n.normalizeLocale('zh-Hans-CN')).toBe('zh-CN');
    expect(i18n.normalizeLocale('zh_TW')).toBe('zh-CN');
    expect(i18n.normalizeLocale('fr-FR')).toBe('zh-CN');
    expect(i18n.normalizeLocale('')).toBe('zh-CN');
    expect(i18n.normalizeLocale(undefined)).toBe('zh-CN');
    expect(i18n.normalizeLocale(null)).toBe('zh-CN');
  });

  it('t() 优先级：?lang= 最高，其次 __YTVDLT_SETTINGS__.locale，再次 language，最后 zh-CN', () => {
    // ① 默认：zh-CN。
    expect(i18n.t('queue.title')).toBe(zh('queue.title'));
    // ② 注入设置.locale = en。
    win().__YTVDLT_SETTINGS__ = { locale: 'en' };
    expect(i18n.t('queue.title')).toBe(en('queue.title'));
    // ③ 注入设置没有 locale 但有 language（旧字段兼容）。
    win().__YTVDLT_SETTINGS__ = { language: 'en' };
    expect(i18n.t('queue.title')).toBe(en('queue.title'));
    // ④ ?lang= 压过注入设置（URL 是用户的显式选择）。
    win().__YTVDLT_SETTINGS__ = { locale: 'zh-CN' };
    win().location.search = '?lang=en-US';
    expect(i18n.t('queue.title')).toBe(en('queue.title'));
    // ⑤ ?lang= 是不认识的值：归一回默认，而不是照抄乱码。
    win().location.search = '?lang=fr';
    expect(i18n.t('queue.title')).toBe(zh('queue.title'));
    resetLocaleState();
  });

  it('t(key, params) 插值：已知占位符替换、未知/null 占位符保留、无参数原样', () => {
    expect(i18n.t('queue.tab.count', { n: 3 })).toBe('3');
    expect(i18n.t('queue.tab.count', {})).toBe('{n}');
    expect(i18n.t('queue.tab.count', { n: null })).toBe('{n}');
    expect(i18n.t('queue.tab.count')).toBe('{n}');
    expect(i18n.t('queue.tab.count', null)).toBe('{n}');
    // 数字 / 字符串参数都会被 String 化。
    expect(i18n.translator('zh-CN')('queue.tab.count', { n: 0 })).toBe('0');
  });

  it('缺键回退：en 缺 → zh 回退 → 都缺时兜底返回键名本身', () => {
    win().location.search = '?lang=en-US';
    // 双语字典键集合一致（族五重钉），所以正常键不会有回退差异；这里用真缺键。
    expect(i18n.t('no.such.key.anywhere')).toBe('no.such.key.anywhere');
    // translator(locale) 直连：locale 表缺键时回退默认语言表。
    expect(i18n.translator('en')('queue.title')).toBe(en('queue.title'));
    expect(i18n.translator('en')('queue.tab.count', { n: 5 })).toBe('5');
    resetLocaleState();
  });
});

// ---------------------------------------------------------------------------
// 族二 · data-i18n 批量应用（英文渲染 + 两条写入纪律 + 缺键统计）
// ---------------------------------------------------------------------------
describe('D-187 · apply() 对 data-i18n* 的批量应用纪律', () => {
  it('en 应用：文本/placeholder/aria-label/title 四类属性都换成英文', () => {
    const heading = register(domNode('h1'));
    heading.setAttribute('data-i18n', 'queue.title');
    const search = register(domNode('input'));
    search.setAttribute('data-i18n-placeholder', 'queue.search.placeholder');
    const tab = register(domNode('button'));
    tab.setAttribute('data-i18n-aria-label', 'nav.label');
    const save = register(domNode('span'));
    save.setAttribute('data-i18n-title', 'common.save');
    heading.textContent = '下载队列';
    search.setAttribute('placeholder', '搜索标题 / 上传者 / 任务 ID');

    const stats = i18n.apply({ locale: 'en' });
    expect(stats.locale).toBe('en');
    expect(stats.translated).toBe(4);
    expect(heading.textContent).toBe(en('queue.title'));
    expect(search.getAttribute('placeholder')).toBe(en('queue.search.placeholder'));
    expect(tab.getAttribute('aria-label')).toBe(en('nav.label'));
    expect(save.getAttribute('title')).toBe(en('common.save'));
    // 文档语言标记同步翻转。
    expect(doc().documentElement.getAttribute('lang')).toBe('en');
    expect(doc().documentElement.getAttribute('data-lang')).toBe('en');
    resetLocaleState();
  });

  it('en 应用：占位符模板键不落 DOM（页面已用 t(key,params) 渲染真实值）', () => {
    const counter = register(domNode('span'));
    counter.setAttribute('data-i18n', 'queue.tab.count');
    counter.textContent = '12'; // 页面先渲染的带参结果
    const stats = i18n.apply({ locale: 'en' });
    expect(stats.translated).toBe(1);
    expect(counter.textContent).toBe('12'); // 模板 '{n}' 绝不写上屏
    resetLocaleState();
  });

  it('en 应用：有子节点的元素只换首个文本节点；首个是元素则插入文本节点', () => {
    // ① 首子节点是文本（如带计数 <span> 的标签）：原位替换 nodeValue。
    const label1 = register(domNode('label'));
    label1.setAttribute('data-i18n', 'queue.title');
    const text = textNode('下载队列');
    label1.children.push(text);
    // ② 首子节点是元素：插入新文本节点，不抹掉子树。
    const label2 = register(domNode('label'));
    label2.setAttribute('data-i18n', 'queue.title');
    const icon = domNode('span');
    label2.children.push(icon);
    i18n.apply({ locale: 'en' });
    expect(text.nodeValue).toBe(en('queue.title'));
    expect(label1.children.length).toBe(1);
    expect(label2.children.length).toBe(2);
    expect(label2.children[0].textContent).toBe(en('queue.title'));
    expect(label2.children[1]).toBe(icon);
    resetLocaleState();
  });

  it('缺键是 bug 不是静默：stats.missing 收集 + body 计数标记，且不写 DOM', () => {
    const missing = register(domNode('button'));
    missing.setAttribute('data-i18n', 'no.such.key.anywhere');
    const present = register(domNode('h2'));
    present.setAttribute('data-i18n', 'queue.title');
    const stats = i18n.apply({ locale: 'en' });
    expect(stats.missing).toEqual(['no.such.key.anywhere']);
    expect(missing.textContent).toBe(''); // 键名不落 DOM（text === key 时跳过写入）
    expect(present.textContent).toBe(en('queue.title'));
    expect((doc().body as UiNode).getAttribute('data-i18n-missing')).toBe('1');
    resetLocaleState();
  });

  it('zh-CN 默认语言零写入（M3 基线冻结）：不翻属性、不碰文本、只算溢出', () => {
    const heading = register(domNode('h1'));
    heading.setAttribute('data-i18n', 'queue.title');
    heading.textContent = zh('queue.title');
    const stats = i18n.apply(); // 无参 → settings().locale → zh-CN
    expect(stats.locale).toBe('zh-CN');
    expect(stats.translated).toBe(0);
    expect(stats.missing).toEqual([]);
    expect(heading.textContent).toBe(zh('queue.title'));
    // 默认语言分支提前返回：lang 标记不被改写（保持 null —— 写 lang 是 en 分支的事）。
    expect(doc().documentElement.getAttribute('lang')).toBeNull();
    expect(doc().documentElement.getAttribute('data-lang')).toBeNull();
    expect((doc().body as UiNode).getAttribute('data-text-overflow')).toBeNull();
    expect((doc().body as UiNode).getAttribute('data-i18n-missing')).toBeNull();
    // 中文渲染原本就正确：overflow 只统计、不上屏。
    expect(typeof stats.overflow).toBe('number');
    resetLocaleState();
  });

  it('语言来回切换：en 应用后再 apply(zh-CN) 也不改 DOM（冻结纪律的双向一致）', () => {
    const heading = register(domNode('h1'));
    heading.setAttribute('data-i18n', 'queue.title');
    i18n.apply({ locale: 'en' });
    expect(heading.textContent).toBe(en('queue.title'));
    const back = i18n.apply({ locale: 'zh-CN' });
    expect(back.locale).toBe('zh-CN');
    expect(back.translated).toBe(0);
    expect(heading.textContent).toBe(en('queue.title')); // 不回写中文（等整页刷新）
    resetLocaleState();
  });
});

// ---------------------------------------------------------------------------
// 族三 · 冻结短语表（zh → en）对 M3 对话框文本节点的整节点替换
// ---------------------------------------------------------------------------
describe('D-187 · 冻结短语表 translatePhrases', () => {
  it('正文文本节点按短语表整节点替换，首尾空白原样保留，SCRIPT 内容跳过', () => {
    const body = doc().body as UiNode;
    const plain = textNode('格式选择');
    const padded = textNode('  格式选择  ');
    const untouched = textNode('这句不在短语表里');
    const script = domNode('script');
    const scriptText = textNode('格式选择');
    script.children.push(scriptText);
    body.children.push(plain, padded, untouched, script);

    const stats = i18n.apply({ locale: 'en' });
    expect(stats.translated).toBeGreaterThanOrEqual(2);
    expect(plain.nodeValue).toBe(catalogue.PHRASES['格式选择']);
    expect(padded.nodeValue).toBe(`  ${catalogue.PHRASES['格式选择']}  `);
    expect(untouched.nodeValue).toBe('这句不在短语表里');
    expect(scriptText.nodeValue).toBe('格式选择'); // SCRIPT/STYLE/PRE 永不翻译
    resetLocaleState();
  });

  it('短语表走元素树递归（嵌套节点的文本也被替换）', () => {
    const body = doc().body as UiNode;
    const outer = domNode('div');
    const inner = domNode('p');
    const deep = textNode('格式选择');
    inner.children.push(deep);
    outer.children.push(inner);
    body.children.push(outer);
    i18n.apply({ locale: 'en' });
    expect(deep.nodeValue).toBe(catalogue.PHRASES['格式选择']);
    resetLocaleState();
  });
});

// ---------------------------------------------------------------------------
// 族四 · 溢出统计 / formatDate / 缺文档守卫
// ---------------------------------------------------------------------------
describe('D-187 · countOverflow / formatDate / 守卫分支', () => {
  it('countOverflow：data-fit 优先精确测量；没有 data-fit 时回退默认选择器', () => {
    const docAny = doc() as any;
    // ① 有 data-fit 节点：只测它们。
    const fitted = register(domNode('button'));
    fitted.setAttribute('data-fit', '');
    fitted.scrollWidth = 300;
    fitted.clientWidth = 100;
    const wide = register(domNode('button'));
    wide.setAttribute('data-fit', '');
    wide.scrollWidth = 100;
    wide.clientWidth = 100; // 不溢出
    expect(i18n.countOverflow(docAny)).toBe(1);
    // ② 没有 data-fit：回退默认选择器（h1/h2/button/label/…）。
    pool.length = 0;
    const clipped = register(domNode('h2'));
    clipped.scrollWidth = 220;
    clipped.clientWidth = 200; // 差 20 > 1 → 溢出
    const fine = register(domNode('h2'));
    fine.scrollWidth = 201;
    fine.clientWidth = 200; // 差 1 → 不算（>1 才算）
    const exempt = register(domNode('div'));
    exempt.scrollWidth = 500;
    exempt.clientWidth = 100; // 不在选择器集里
    expect(i18n.countOverflow(docAny)).toBe(1);
    // apply() 把溢出数写上 body（en 分支）。
    const stats = i18n.apply({ locale: 'en' });
    expect(stats.overflow).toBe(1);
    expect((doc().body as UiNode).getAttribute('data-text-overflow')).toBe('1');
    resetLocaleState();
  });

  it('formatDate：T 换空格、毫秒与 Z 后缀剔除；非字符串输入返回空串', () => {
    expect(i18n.formatDate('2026-01-02T03:04:05.123Z')).toBe('2026-01-02 03:04:05');
    expect(i18n.formatDate('2026-01-02T03:04:05Z')).toBe('2026-01-02 03:04:05');
    expect(i18n.formatDate('2026-01-02 03:04:05')).toBe('2026-01-02 03:04:05');
    expect(i18n.formatDate(42)).toBe('');
    expect(i18n.formatDate(null)).toBe('');
  });

  it('document 缺失时 apply() 返回 null（静态预览的极端守卫）', () => {
    const previous = win().document;
    win().document = null;
    expect(i18n.apply({ locale: 'en' })).toBeNull();
    win().document = previous;
  });
});

// ---------------------------------------------------------------------------
// 族五 · DOMContentLoaded 自动应用（语言切换事件）与 import 路线字典重钉
// ---------------------------------------------------------------------------
describe('D-187 · 自动应用与双语字典一致性（import 路线重钉）', () => {
  it('readyState=loading 时挂 DOMContentLoaded，事件派发后按 ?lang= 自动应用整页', () => {
    win().location.search = '?lang=en-US';
    const heading = register(domNode('h1'));
    heading.setAttribute('data-i18n', 'queue.title');
    (doc() as any).__fire('DOMContentLoaded');
    expect(heading.textContent).toBe(en('queue.title'));
    expect(doc().documentElement.getAttribute('lang')).toBe('en');
    resetLocaleState();
  });

  it('双语字典：zh-CN 与 en 键集合完全一致、无空翻译、占位符逐键同形', () => {
    const zhKeys = Object.keys(catalogue.MESSAGES['zh-CN'] as Record<string, string>).sort();
    const enKeys = Object.keys(catalogue.MESSAGES.en as Record<string, string>).sort();
    expect(zhKeys.length).toBeGreaterThan(80);
    expect(enKeys).toEqual(zhKeys);
    const placeholders = (value: string): string[] =>
      [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]);
    const broken: string[] = [];
    for (const key of zhKeys) {
      const zhValue = catalogue.MESSAGES['zh-CN'][key] as string;
      const enValue = catalogue.MESSAGES.en[key] as string;
      if (zhValue.trim().length === 0 || enValue.trim().length === 0) broken.push(key);
      if (placeholders(zhValue).join(',') !== placeholders(enValue).join(',')) broken.push(key);
    }
    expect(broken).toEqual([]);
  });

  it('短语表与目录形状：PHRASES 非空、无空译文、抽查锚点（import 装载的同一份实例）', () => {
    const phrases = Object.entries(catalogue.PHRASES as Record<string, string>);
    expect(phrases.length).toBeGreaterThan(50);
    expect(phrases.filter(([zhText, enText]) => zhText.trim().length === 0 || enText.trim().length === 0))
      .toEqual([]);
    expect(catalogue.PHRASES['格式选择']).toBe('Format selection');
    // i18n.js 在 import 时刻捕获的就是这份目录 —— 不是复制品。
    expect(i18n.LOCALES).toBe(catalogue.LOCALES);
    expect(i18n.DEFAULT_LOCALE).toBe(catalogue.DEFAULT_LOCALE);
  });
});
