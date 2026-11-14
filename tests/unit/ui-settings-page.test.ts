/**
 * ui-settings-page.test.ts — settings.js 真实行为单测（D-187 · packages/ui 纳入覆盖率统计）。
 *
 * 【为什么是 import 而不是 runInNewContext】runInNewContext 在 VM 沙箱里执行，
 * v8 覆盖率提供器看不到任何路径（D-187 前整个 ui 包只有 63 条语句被统计）。
 * 本文件用共享装载架 tests/unit/helpers/ui-harness.ts 真实 `import()` 源码，
 * 驱动 window.YTVDLTSettings 暴露的测试面与真实 DOM 行为。
 *
 * 【与既有 runInNewContext 测试的关系】settings-app-update.test.ts（D-93/D-104
 * 更新按钮状态机、D-141 轮询闸门）与 settings-autostart-repaint.test.ts（D-166/
 * D-178 快照重绘）钉住的语义在这里按 import 路线全部对齐保住；两份旧测试不改不删。
 *
 * 【模块单例】ESM 注册表按文件缓存，settings.js 在 beforeAll 只启动一次：
 * 用例按顺序编排，通过可替换的 bridge 应答函数在各场景间切换“线上/离线世界”，
 * 共享同一批 DOM 节点（listeners 在启动时挂好，之后只是驱动）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installUiGlobals, loadUiModule, type UiGlobals } from './helpers/ui-harness.js';

/** zh-CN 文案表：与 i18n/messages.js 的模板保持同形（t() 的占位符替换要真跑）。 */
const MESSAGES: Record<string, string> = {
  'settings.app.current': '当前 v{version}',
  'settings.app.check': '检查更新',
  'settings.app.checking': '正在检查…',
  'settings.app.uptodate': '已是最新版本',
  'settings.app.available': '新版本 {version} 可用',
  'settings.app.error': '检查失败：{reason}',
  'settings.app.page': '打开发布页',
  'update.download': '下载并安装',
  'update.install': '立即安装',
  'update.ready': '安装包已下载并校验，点击「立即安装」启动安装程序。',
  'update.downloading': '正在下载 {done} / {total}',
  'settings.engine.installed': '已安装 {version}',
  'settings.engine.missing': '未找到 yt-dlp.exe',
  'settings.engine.latest': '远端最新 {version}',
  'settings.engine.unknown': '尚未查询远端版本',
  'settings.engine.available': '可更新：{from} → {to}',
  'settings.engine.uptodate': '已是最新',
  'settings.engine.nofeed': '未配置更新源',
  'settings.engine.updating': '正在更新…',
  'settings.engine.done': '已更新到 {version}',
  'settings.engine.failed': '更新失败：{reason}',
  'settings.engine.checkFailed': '检查失败：{reason}',
  'settings.paths.hint': '视频与音频可以存在不同文件夹；选择时会检查目录是否可写，不可写不会保存。',
  'settings.paths.saved': '已保存：{path}',
  'settings.paths.failed': '无法保存：{reason}',
  'settings.cache.filesUnit': '{n} 个',
  'settings.cache.offline': '离线：未连接主进程，无法读取缓存',
  'settings.cache.unavailable': '此构建未启用封面缓存',
  'settings.cache.hint': '仅清理封面图片；被下载任务使用的封面不会删除，文件移入回收站可还原。',
  'settings.cache.pruning': '正在清理…',
  'settings.cache.prune': '立即清理',
  'settings.cache.result': '{before} → {after}（释放 {freed}）',
  'settings.cache.failed': '清理失败：{reason}',
  'settings.templates.unavailable': '当前构建不可用。',
  'settings.templates.rejected': '有 {n} 条模板在加载时被拒绝。',
  'settings.templates.saved': '已保存。',
  'settings.templates.deleted': '已删除。',
  'settings.templates.invalid': '模板未通过校验：{reason}',
  'settings.templates.missing': '请填写名称，并至少给一个参数。',
  'settings.templates.delete': '删除',
  'settings.component.idle': '组件：{list}',
};

let globals: UiGlobals | null = null;
let doc: any;
let win: any;
let settings: any; // window.YTVDLTSettings
/** 各场景切换的 bridge 应答函数（invokeBridge 每次调用都现读 ytvdltBridge）。 */
let reply: (channel: string, payload?: any) => unknown = () => ({});
let pathButtons: any[] = [];
let navParts: Array<{ link: any; section: any; top: number }> = [];
let resizeObservers: any[] = [];
let bootShellCalls: Array<Record<string, () => void>> = [];
let themeSetCalls: any[] = [];
let themeApplyCalls: any[] = [];
let autostartBeforeSnapshot: boolean | undefined;
let realBridge: { invoke(channel: string, payload?: unknown): unknown } | null = null;
let locationReplace: any;
let themeState: any = null; // theme 协作者 stub 的内部状态（apply/set 都落在它上面）

const node = (id: string): any => doc.getElementById(id);
const callsOn = (channel: string) => (globals?.bridgeCalls ?? []).filter((c) => c.channel === channel);
const lastCall = (channel: string) => callsOn(channel).at(-1);
/** 应用更新 status 通道的固定应答。 */
const statusOf = (state: unknown) => (channel: string) => (channel === 'ytvdlt:appUpdate:status' ? state : {});
const flush = async (rounds = 10): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};

beforeAll(async () => {
  vi.useFakeTimers();
  reply = bootReply;

  themeState = { theme: 'system', accent: 'system', motion: 'system', systemAccent: null };
  class ResizeObserverStub {
    callback: () => void;
    observed: any[] = [];
    constructor(callback: () => void) {
      this.callback = callback;
      resizeObservers.push(this);
    }
    observe(target: unknown): void { this.observed.push(target); }
  }

  globals = installUiGlobals({
    bridge: { invoke: (channel: string, payload?: unknown) => reply(channel, payload) },
    injected: {
      // 打包环境不会注入它；这里同时给 autostart=true 验证“注入兜底 → 快照纠正”。
      __YTVDLT_SETTINGS__: {
        autostart: true,
        autoCheckAppUpdate: false,
        autoCheckEngineUpdate: false,
        locale: 'zh-CN',
        theme: 'system',
        accent: 'system',
        motion: 'system',
        systemAccent: null,
      },
    },
    extraWindow: {
      // theme.js 协作者 stub：state/apply/set 三件套，set 走 theme.js 的
      // D-106 契约（写 SETTINGS_SET 的正是 theme.js，不是 settings.js）。
      YTVDLTTheme: {
        state: () => ({ ...themeState }),
        apply: (patch: any) => {
          themeApplyCalls.push({ ...patch });
          mergeAppearance(patch);
          return { ...themeState };
        },
        set: (patch: any) => {
          themeSetCalls.push({ ...patch });
          mergeAppearance(patch);
          win?.ytvdltBridge?.invoke?.('ytvdlt:settings:set', { ...patch });
          return { ...themeState };
        },
      },
      YTVDLTAppVersion: { query: () => '9.9.9' },
      YTVDLT_I18N: { DEFAULT_LOCALE: 'zh-CN', MESSAGES: { 'zh-CN': MESSAGES } },
      YTVDLT: { shell: { boot: (map: Record<string, () => void>) => { bootShellCalls.push(map); } } },
      ResizeObserver: ResizeObserverStub,
    },
  });
  doc = globals.document;
  win = globals.window;
  realBridge = win.ytvdltBridge;
  locationReplace = vi.fn();
  win.location.replace = locationReplace;

  buildDom();
  patchDocumentLookups();

  await loadUiModule('pages/settings/settings.js', globals);
  settings = globals.attached.YTVDLTSettings;
  // SETTINGS_GET 快照故意挂起：先抓“注入兜底”下的 autostart 初值，再放行快照。
  autostartBeforeSnapshot = node('settings-autostart').checked;
  releaseSnapshot({
    autostart: false,
    autoCheckAppUpdate: true,
    autoCheckEngineUpdate: false,
    theme: 'dark',
    videoDir: 'C:/vid',
    audioDir: 'C:/aud',
  });
  await flush();
});

afterAll(() => {
  globals?.restore();
  globals = null;
  vi.useRealTimers();
});

beforeEach(() => {
  globals?.bridgeCalls.splice(0);
  themeSetCalls.length = 0;
});

/* ---------------------------------------------------------------- 工具 -- */

let releaseSnapshot: (value: unknown) => void = () => {};

function bootReply(channel: string): unknown {
  switch (channel) {
    case 'ytvdlt:settings:get':
      return new Promise((resolve) => { releaseSnapshot = resolve; });
    case 'ytvdlt:component:status':
      return {
        components: [{
          id: 'yt-dlp', label: 'yt-dlp', installed: true,
          version: '2025.01.01', latestVersion: '2025.01.15',
          feedUrl: 'https://example/feed', versionApiUrl: 'https://example/api',
        }],
      };
    case 'ytvdlt:appUpdate:status':
      return { phase: 'idle', currentVersion: '0.2.5' };
    case 'ytvdlt:thumbnail:cache':
      return { ok: true, status: { bytes: 0, files: 0, reclaimableBytes: 0, enabled: false, maxBytes: 0 } };
    case 'ytvdlt:template:list':
      return { templates: [], rejectedAtLoad: [] };
    default:
      return {};
  }
}

function mergeAppearance(patch: any): void {
  if (patch && typeof patch === 'object') {
    for (const key of ['theme', 'accent', 'motion'] as const) {
      if (patch[key] !== undefined) themeState[key] = patch[key];
    }
  }
}

function buildDom(): void {
  const segment = (boxId: string, attr: string, values: string[]) => {
    const box = node(boxId);
    for (const value of values) {
      const button = doc.createElement('button');
      button.setAttribute(attr, value);
      box.appendChild(button);
    }
    return box;
  };
  segment('settings-theme', 'data-theme', ['light', 'dark', 'system']);
  segment('settings-accent', 'data-accent', ['system', 'blue', 'teal', 'violet', 'amber', 'rose']);
  segment('settings-language', 'data-locale', ['zh-CN', 'en']);

  pathButtons = ([['pick', 'video'], ['reset', 'video'], ['open', 'video'], ['pick', 'audio']] as const).map(
    ([action, kind]) => {
      const button = doc.createElement('button');
      button.setAttribute('data-path-action', action);
      button.setAttribute('data-path-kind', kind);
      return button;
    },
  );

  const limit = node('settings-cache-limit');
  limit.options = [{ value: '0' }, { value: '104857600' }, { value: '524288000' }, { value: '1073741824' }];

  const host = node('settings-scroll');
  host.getBoundingClientRect = () => ({ top: 100 });
  host.scrollHeight = 1800; // 内层列真实溢出：最大 scrollTop = 1000
  const nav = node('settings-nav');
  for (const [target, contentTop] of [['nav-appearance', 120], ['nav-paths', 500], ['nav-updates', 900]] as const) {
    const link = doc.createElement('a');
    link.setAttribute('data-nav-target', target);
    nav.appendChild(link);
    const section = node(target);
    // rect 随 scrollTop 平移（滚动把内容往上推）：offset = contentTop - hostRect.top
    section.getBoundingClientRect = () => ({ top: contentTop - host.scrollTop });
    navParts.push({ link, section, top: contentTop });
  }

  // renderTemplates 用 `list.textContent = ''` 清单 —— 真实 DOM 里这会移除子节点，
  // harness 的 textContent 只是普通属性，这里在模板列表节点上补齐该语义。
  const templateList = node('settings-template-list');
  let templateListText = '';
  Object.defineProperty(templateList, 'textContent', {
    get: () => templateListText,
    set: (value: string) => { templateListText = value; templateList.children.length = 0; },
    configurable: true,
  });

  // harness 的 appendChild 不回填 parentNode（harness 注释允许按场景覆写）；
  // switchLocale 需要的 location.replace 已在 beforeAll 补上。
}

function patchDocumentLookups(): void {
  const matchAttr = (candidate: any, key: string, value?: string) => {
    const actual = candidate.attrs[key];
    return value === undefined ? actual !== undefined : actual === value;
  };
  const resolve = (selector: string): any[] => {
    const text = String(selector).trim();
    let m = /^#([A-Za-z0-9_-]+)\s*\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/.exec(text);
    if (m) {
      const box = globals!.nodes.get(m[1]);
      return box ? box.children.filter((c: any) => matchAttr(c, m![2], m![3])) : [];
    }
    m = /^\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/.exec(text);
    if (m) return pathButtons.filter((c) => matchAttr(c, m![1], m![2]));
    return [];
  };
  doc.querySelectorAll = (selector: string) => resolve(selector);
  doc.querySelector = (selector: string) => resolve(selector)[0] ?? null;
}

/* ---------------------------------------------------------------- 测试 -- */

describe('D-187 · settings.js 装载与启动快照（D-166 / D-178 对齐）', () => {
  it('真实 import 启动并暴露 YTVDLTSettings 测试面', () => {
    expect(settings).toBeDefined();
    expect(typeof settings.paintTheme).toBe('function');
    expect(typeof settings.switchLocale).toBe('function');
    expect(settings.state).toEqual({ theme: 'system', accent: 'system', motion: 'system', locale: 'zh-CN' });
    // shell 协作：YTVDLT.shell.boot({ settings: fn })；shell 在启动时回调一次
    expect(Object.keys(bootShellCalls[0])).toEqual(['settings']);
    expect(() => bootShellCalls[0].settings()).not.toThrow();
  });

  it('autostart 初值来自注入兜底，SETTINGS_GET 快照落地后被注册表真值纠正', () => {
    expect(autostartBeforeSnapshot).toBe(true);
    expect(node('settings-autostart').checked).toBe(false);
    // 快照同时重绘两个自动检查开关（方向各异）与路径行
    expect(node('settings-app-auto').checked).toBe(true);
    expect(node('settings-engine-auto').checked).toBe(false);
    expect(node('settings-path-video').textContent).toBe('C:/vid');
    expect(node('settings-path-audio').textContent).toBe('C:/aud');
    expect(node('settings-path-video').getAttribute('title')).toBe('C:/vid');
    // 启动 paintTheme + 快照重绘各 apply 一次
    expect(themeApplyCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('启动时各面板拿到首轮状态', () => {
    // 引擎：已安装且远端可查 → idle + 已是最新
    expect(node('settings-engine-current').textContent).toBe('已安装 2025.01.01');
    expect(node('settings-engine-latest').textContent).toBe('远端最新 2025.01.15');
    expect(node('settings-components').getAttribute('data-component-state')).toBe('idle');
    expect(node('settings-components').textContent).toBe('已是最新 · yt-dlp 2025.01.01');
    expect(node('settings-engine-update').disabled).toBe(false);
    expect(node('settings-engine-check').disabled).toBe(false);
    // 应用更新：idle → 检查更新；快照没带 latest.pageUrl → 发布页按钮隐藏
    expect(node('settings-app-current').textContent).toBe('当前 v0.2.5');
    expect(node('settings-app-state').textContent).toBe('已是最新版本');
    expect(node('settings-app-update').textContent).toBe('检查更新');
    expect(node('settings-app-block').getAttribute('data-update-state')).toBe('idle');
    expect(node('settings-app-page').getAttribute('hidden')).toBe('true');
    // 缓存：空快照照常回填
    expect(node('settings-cache-bytes').textContent).toBe('0 B');
    expect(node('settings-cache-files').textContent).toBe('0 个');
    expect(node('settings-cache-auto').checked).toBe(false);
    expect(node('settings-cache-limit').value).toBe('0');
    expect(node('settings-cache-prune').disabled).toBe(false);
    expect(node('settings-cache-note').getAttribute('data-cache-state')).toBe('idle');
    // 模板：空名单、无拒绝
    expect(node('settings-template-list').children).toHaveLength(0);
    expect(node('settings-template-empty').hidden).toBe(false);
    expect(node('settings-template-note').textContent).toBe('');
  });
});

describe('主题 / 强调色 / 动效三态走 SETTINGS_SET（D-106，不是 CONFIG_SET）', () => {
  it('点击主题段控 → theme.js set → ytvdlt:settings:set，aria-pressed 与根属性联动', () => {
    const dark = node('settings-theme').children.find((b: any) => b.getAttribute('data-theme') === 'dark');
    dark.click();
    expect(themeSetCalls).toEqual([{ theme: 'dark' }]);
    expect(lastCall('ytvdlt:settings:set')?.payload).toEqual({ theme: 'dark' });
    // 全链路只允许 SETTINGS_SET：CONFIG_SET 是 M3 fixture 通道，绝不能再出现
    for (const call of globals!.bridgeCalls) expect(call.channel).not.toContain('config');
    expect(node('settings-root').getAttribute('data-theme-value')).toBe('dark');
    expect(node('ytvdlt-output').getAttribute('hidden')).toBe('false');
    expect(node('ytvdlt-output').getAttribute('data-last-action')).toBe('theme');
    expect(JSON.parse(node('ytvdlt-output').textContent)).toEqual({ action: 'theme', value: 'dark' });
    expect(dark.getAttribute('aria-pressed')).toBe('true');
    const light = node('settings-theme').children.find((b: any) => b.getAttribute('data-theme') === 'light');
    expect(light.getAttribute('aria-pressed')).toBe('false');
  });

  it('点击强调色段控 → set({accent}) → SETTINGS_SET；aria-pressed 独占', () => {
    const teal = node('settings-accent').children.find((b: any) => b.getAttribute('data-accent') === 'teal');
    teal.click();
    expect(themeSetCalls[0]).toEqual({ accent: 'teal' });
    expect(lastCall('ytvdlt:settings:set')?.payload).toEqual({ accent: 'teal' });
    expect(node('settings-root').getAttribute('data-accent-value')).toBe('teal');
    const pressed = node('settings-accent').children.filter((b: any) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(pressed[0].getAttribute('data-accent')).toBe('teal');
  });

  it('motion 下拉 change → persistMotion → SETTINGS_SET', () => {
    const motion = node('settings-motion');
    motion.value = 'reduced';
    motion.dispatch('change');
    expect(lastCall('ytvdlt:settings:set')?.payload).toEqual({ motion: 'reduced' });
    expect(node('settings-root').getAttribute('data-motion-value')).toBe('reduced');
    expect(JSON.parse(node('ytvdlt-output').textContent)).toEqual({ action: 'motion', value: 'reduced' });
  });

  it('theme.set 缺失时走本地兜底：仍落 THEME_STATE 并 emit，但不发任何通道', () => {
    const original = win.YTVDLTTheme.set;
    win.YTVDLTTheme.set = undefined;
    try {
      const before = globals!.bridgeCalls.length;
      node('settings-accent').children.find((b: any) => b.getAttribute('data-accent') === 'violet').click();
      const motion = node('settings-motion');
      motion.value = 'full';
      motion.dispatch('change');
      node('settings-theme').children.find((b: any) => b.getAttribute('data-theme') === 'light').click();
      expect(globals!.bridgeCalls.length).toBe(before);
      expect(JSON.parse(node('ytvdlt-output').textContent)).toEqual({ action: 'theme', value: 'light' });
    } finally {
      win.YTVDLTTheme.set = original;
    }
  });
});

describe('下载位置 PATH_ACTION（D-98：渲染端永远不发路径字符串）', () => {
  it('pick：请求只带 action/kind，成功后回填行与确认条', async () => {
    reply = () => ({ ok: true, path: 'D:/media', paths: { videoDir: 'D:/media', audioDir: 'D:/music' } });
    pathButtons[0].click();
    await flush();
    expect(lastCall('ytvdlt:path:action')?.payload).toEqual({ action: 'pick', kind: 'video' });
    expect(JSON.stringify(lastCall('ytvdlt:path:action')?.payload)).not.toMatch(/dir|path/i);
    expect(node('settings-path-video').textContent).toBe('D:/media');
    expect(node('settings-path-audio').textContent).toBe('D:/music');
    expect(node('settings-path-note').textContent).toBe('已保存：D:/media');
    expect(node('settings-path-note').getAttribute('data-path-state')).toBe('ok');
    expect(node('settings-path-note').getAttribute('data-i18n')).toBeNull();
  });

  it('canceled / 失败 / 拒绝：行不动，提示条给稳定文案', async () => {
    reply = () => ({ canceled: true });
    pathButtons[0].click();
    await flush();
    expect(node('settings-path-note').textContent).toBe('已保存：D:/media');

    reply = () => ({ ok: false, error: '目录不可写' });
    pathButtons[0].click();
    await flush();
    expect(node('settings-path-note').textContent).toBe('无法保存：目录不可写');
    expect(node('settings-path-note').getAttribute('data-path-state')).toBe('error');
    expect(node('settings-path-video').textContent).toBe('D:/media');

    reply = () => Promise.reject(new Error('ipc down'));
    pathButtons[0].click();
    await flush();
    expect(node('settings-path-note').textContent).toBe('无法保存：Error: ipc down');
  });

  it('open 只提示不写行；audio 行按钮带 audio kind；空 paths 回填占位符', async () => {
    reply = () => ({ ok: true });
    pathButtons[2].click();
    await flush();
    expect(node('settings-path-note').textContent).toBe(MESSAGES['settings.paths.hint']);
    expect(node('settings-path-note').getAttribute('data-path-state')).toBe('idle');

    reply = () => ({ ok: true, path: 'D:/m', paths: {} });
    pathButtons[3].click();
    await flush();
    expect(lastCall('ytvdlt:path:action')?.payload).toEqual({ action: 'pick', kind: 'audio' });
    expect(node('settings-path-note').textContent).toBe('已保存：D:/m');
    // paths 里没有 videoDir/audioDir → 占位符 “—”，title 同步清空
    expect(node('settings-path-video').textContent).toBe('—');
    expect(node('settings-path-video').getAttribute('title')).toBe('');
  });

  it('无桥接时给离线提示（error 态）', () => {
    delete win.ytvdltBridge;
    try {
      pathButtons[1].click();
      expect(node('settings-path-note').textContent).toBe('离线：未连接主进程，无法检查更新');
      expect(node('settings-path-note').getAttribute('data-path-state')).toBe('error');
    } finally {
      win.ytvdltBridge = realBridge;
    }
  });
});

describe('yt-dlp 引擎面板状态（D-94）', () => {
  const ytDlp = (extra: Record<string, unknown> = {}) => ({
    id: 'yt-dlp', label: 'yt-dlp', installed: true, version: '2025.01.01', latestVersion: '2025.01.15',
    feedUrl: 'https://example/feed', versionApiUrl: 'https://example/api', ...extra,
  });
  /** 换 status 应答后借一次成功的 check（其内部 refreshComponents）重绘引擎面板。 */
  async function repaintWith(component: unknown, checkResult: unknown = { updateAvailable: false }) {
    reply = (channel) => channel === 'ytvdlt:component:check'
      ? { results: [checkResult] }
      : channel === 'ytvdlt:component:status' ? { components: [component] } : {};
    node('settings-engine-check').dispatch('click');
    await flush();
  }

  it('可更新 → available 文案带 from→to；按钮可用', async () => {
    await repaintWith(ytDlp({ updateAvailable: true }), { updateAvailable: true, installedVersion: '2025.01.01', latestVersion: '2025.01.15' });
    expect(node('settings-components').getAttribute('data-component-state')).toBe('available');
    expect(node('settings-components').textContent).toBe('可更新：2025.01.01 → 2025.01.15');
    expect(node('settings-engine-update').disabled).toBe(false);
    expect(node('settings-engine-check').disabled).toBe(false);
  });

  it('已是最新 → idle + 版本清单；未安装 / 远端未知 → 各自文案', async () => {
    await repaintWith(ytDlp());
    expect(node('settings-components').textContent).toBe('已是最新 · yt-dlp 2025.01.01');
    await repaintWith(ytDlp({ installed: false }));
    expect(node('settings-engine-current').textContent).toBe('未找到 yt-dlp.exe');
    await repaintWith(ytDlp({ latestVersion: '' }));
    expect(node('settings-engine-latest').textContent).toBe('尚未查询远端版本');
    expect(node('settings-components').textContent).toBe('组件：yt-dlp 2025.01.01');
  });

  it('无更新源 / 空名单 / 非引擎组件 → no-source 或首个组件兜底', async () => {
    await repaintWith(ytDlp({ feedUrl: '', versionApiUrl: '' }));
    expect(node('settings-components').getAttribute('data-component-state')).toBe('no-source');
    expect(node('settings-components').textContent).toBe('未配置更新源');
    expect(node('settings-engine-update').disabled).toBe(true);
    // 注意：checkEngine 末尾的 .then 会把 check 按钮重新启用（覆盖 paintEngine
    // 的禁用）—— 这是有意钉住的先后顺序行为。

    reply = (channel) => channel === 'ytvdlt:component:check'
      ? { results: [{ updateAvailable: false }] }
      : channel === 'ytvdlt:component:status' ? { components: [] } : {};
    node('settings-engine-check').dispatch('click');
    await flush();
    expect(node('settings-components').textContent).toBe('未配置更新源');
    expect(node('settings-engine-update').disabled).toBe(true);

    reply = (channel) => channel === 'ytvdlt:component:check'
      ? { results: [{ updateAvailable: false }] }
      : channel === 'ytvdlt:component:status'
        ? { components: [{ id: 'ffmpeg', label: 'ffmpeg', installed: true, version: '6.0', feedUrl: 'https://f' }] }
        : {};
    node('settings-engine-check').dispatch('click');
    await flush();
    expect(node('settings-components').textContent).toBe('组件：ffmpeg 6.0');
    expect(node('settings-engine-update').disabled).toBe(false);
  });
});

describe('引擎检查按钮（component:check）', () => {
  it('点击 → checking → 成功应答回读状态并恢复按钮', async () => {
    reply = (channel) => channel === 'ytvdlt:component:check'
      ? { results: [{ updateAvailable: true, installedVersion: '2025.01.01', latestVersion: '2025.02.01' }] }
      : channel === 'ytvdlt:component:status'
        ? { components: [{ id: 'yt-dlp', label: 'yt-dlp', installed: true, version: '2025.01.01', latestVersion: '2025.02.01', feedUrl: 'https://f', updateAvailable: true }] }
        : {};
    node('settings-engine-check').dispatch('click');
    expect(node('settings-engine-check').disabled).toBe(true);
    expect(node('settings-components').getAttribute('data-component-state')).toBe('checking');
    expect(node('settings-components').textContent).toBe('正在检查…');
    expect(lastCall('ytvdlt:component:check')?.payload).toEqual({});
    await flush();
    // 回读 status 也报 updateAvailable → available 稳定可见
    expect(node('settings-components').getAttribute('data-component-state')).toBe('available');
    expect(node('settings-components').textContent).toBe('可更新：2025.01.01 → 2025.02.01');
    expect(node('settings-engine-check').disabled).toBe(false);
    expect(callsOn('ytvdlt:component:status').length).toBeGreaterThan(0);
  });

  it('空结果列表 → 走进 catch（源码对空数组取 [0] 后直接读 .error，见报告），按钮恢复', async () => {
    reply = (channel) => channel === 'ytvdlt:component:check' ? { results: [] } : {};
    node('settings-engine-check').dispatch('click');
    await flush();
    // 真实源码 bug：results 为空数组时 result 是 undefined（不是 null），
    // `result.error` 抛 TypeError 被 .catch 兜成检查失败 —— 本测试按现状钉住。
    expect(node('settings-components').getAttribute('data-component-state')).toBe('failed');
    expect(node('settings-components').textContent).toContain('TypeError');
    expect(node('settings-engine-check').disabled).toBe(false);
  });

  it('应答没有 results 数组 → failed「尚未查询远端版本」', async () => {
    reply = (channel) => channel === 'ytvdlt:component:check' ? {} : {};
    node('settings-engine-check').dispatch('click');
    await flush();
    expect(node('settings-components').getAttribute('data-component-state')).toBe('failed');
    expect(node('settings-components').textContent).toBe('尚未查询远端版本');
  });

  it('检查错误 / 拒绝 → failed 文案，按钮恢复', async () => {
    reply = (channel) => channel === 'ytvdlt:component:check' ? { results: [{ error: 'feed 404' }] } : {};
    node('settings-engine-check').dispatch('click');
    await flush();
    expect(node('settings-components').getAttribute('data-component-state')).toBe('failed');
    expect(node('settings-components').textContent).toBe('检查失败：feed 404');

    reply = (channel) => channel === 'ytvdlt:component:check' ? Promise.reject(new Error('timeout')) : {};
    node('settings-engine-check').dispatch('click');
    await flush();
    expect(node('settings-components').textContent).toBe('检查失败：Error: timeout');
    expect(node('settings-engine-check').disabled).toBe(false);
  });
});

describe('引擎更新按钮（component:update）', () => {
  /** update 应答是值、末尾回读 status 挂起 —— done/failed 文案不被回读覆盖，稳定可断言。 */
  function updateReply(result: unknown): void {
    reply = (channel) => channel === 'ytvdlt:component:update' ? result : new Promise(() => {});
  }

  it('成功且发生变更 → done 文案带新版本；末尾回读 status 被触发', async () => {
    updateReply({ ok: true, results: [{ changed: true, toVersion: '2025.02.01' }] });
    node('settings-engine-update').dispatch('click');
    expect(node('settings-engine-update').disabled).toBe(true);
    expect(node('settings-components').getAttribute('data-component-state')).toBe('running');
    expect(node('settings-components').textContent).toBe('正在更新…');
    expect(lastCall('ytvdlt:component:update')?.payload).toEqual({});
    await flush();
    expect(node('settings-components').getAttribute('data-component-state')).toBe('done');
    expect(node('settings-components').textContent).toBe('已更新到 2025.02.01');
    // 回读 status 已发起（本场景挂起，所以 done 文案不被 paintEngine 覆盖）
    expect(callsOn('ytvdlt:component:status').length).toBeGreaterThan(0);
  });

  it('up-to-date（带/不带 ok）→ done 已是最新', async () => {
    updateReply({ ok: false, reason: 'up-to-date' });
    node('settings-engine-update').dispatch('click');
    await flush();
    expect(node('settings-components').textContent).toBe('已是最新');
    updateReply({ reason: 'up-to-date' });
    node('settings-engine-update').dispatch('click');
    await flush();
    expect(node('settings-components').textContent).toBe('已是最新');
  });

  it('失败结果 / 无结果 / 拒绝 → failed 文案', async () => {
    updateReply({ ok: false, results: [{ error: '磁盘满' }] });
    node('settings-engine-update').dispatch('click');
    await flush();
    expect(node('settings-components').textContent).toBe('更新失败：磁盘满');
    updateReply({ ok: false });
    node('settings-engine-update').dispatch('click');
    await flush();
    expect(node('settings-components').textContent).toBe('更新失败：unknown');
    updateReply(Promise.reject(new Error('boom')));
    node('settings-engine-update').dispatch('click');
    await flush();
    expect(node('settings-components').textContent).toBe('更新失败：Error: boom');
  });

  it('末尾回读 status 被拒绝 → offline 状态', async () => {
    reply = (channel) => channel === 'ytvdlt:component:update' ? { ok: true, results: [] } : Promise.reject(new Error('status down'));
    node('settings-engine-update').dispatch('click');
    await flush();
    expect(node('settings-components').getAttribute('data-component-state')).toBe('offline');
    expect(node('settings-components').textContent).toBe('离线：未连接主进程，无法检查更新');
  });
});

describe('封面缓存控制（D-103，单通道 ytvdlt:thumbnail:cache）', () => {
  it('set-auto：走通道，policy 应答回填勾选与上限，随后回读 status', async () => {
    reply = (channel, payload: any) => payload?.action === 'set-auto'
      ? { policy: { enabled: true, maxBytes: 123456789 } }
      : payload?.action === 'status' ? { ok: true, status: { bytes: 2621440, files: 7, reclaimableBytes: 12000 } } : {};
    const auto = node('settings-cache-auto');
    auto.checked = true;
    auto.dispatch('change');
    expect(lastCall('ytvdlt:thumbnail:cache')?.payload).toEqual({ action: 'set-auto', enabled: true });
    await flush();
    expect(auto.checked).toBe(true);
    const limit = node('settings-cache-limit');
    // 123456789 不在四个预设里 → 动态补 option（挂在 children 上），下拉不得与 config.json 脱节
    expect(limit.children.some((o: any) => o.value === '123456789')).toBe(true);
    expect(limit.value).toBe('123456789');
    expect(node('settings-cache-bytes').textContent).toBe('2.5 MB');
    expect(node('settings-cache-files').textContent).toBe('7 个');
    expect(node('settings-cache-reclaim').textContent).toBe('11.7 KB');
    expect(node('settings-cache-note').getAttribute('data-cache-state')).toBe('idle');
  });

  it('set-max-bytes：合法值走通道并命中预设；0 / NaN 不发请求', async () => {
    reply = (channel, payload: any) => payload?.action === 'set-max-bytes'
      ? { policy: { maxBytes: 524288000 } }
      : payload?.action === 'status' ? { ok: true, status: { enabled: true, maxBytes: 524288000 } } : {};
    const limit = node('settings-cache-limit');
    limit.value = '524288000';
    limit.dispatch('change');
    expect(lastCall('ytvdlt:thumbnail:cache')?.payload).toEqual({ action: 'set-max-bytes', maxBytes: 524288000 });
    await flush();
    expect(limit.value).toBe('524288000');
    expect(node('settings-cache-auto').checked).toBe(true);
    // 只有数字的 policy 不动占用区
    expect(node('settings-cache-bytes').textContent).toBe('2.5 MB');
    const before = globals!.bridgeCalls.length;
    limit.value = 'abc';
    limit.dispatch('change');
    limit.value = '0';
    limit.dispatch('change');
    expect(globals!.bridgeCalls.length).toBe(before);
  });

  it('prune：按钮进入进行中态，报告给前后对比，末尾恢复并 keepNote 回读', async () => {
    reply = (channel, payload: any) => payload?.action === 'prune'
      ? { report: { ok: true, bytesBefore: 2048, bytesAfter: 0, freedBytes: 2048 } }
      : payload?.action === 'status' ? { ok: true, status: { bytes: 0, files: 0 } } : {};
    const prune = node('settings-cache-prune');
    prune.dispatch('click');
    expect(prune.disabled).toBe(true);
    expect(prune.textContent).toBe('正在清理…');
    expect(node('settings-cache-note').textContent).toBe('正在清理…');
    expect(node('settings-cache-note').getAttribute('data-cache-state')).toBe('idle');
    expect(lastCall('ytvdlt:thumbnail:cache')?.payload).toEqual({ action: 'prune' });
    await flush();
    expect(node('settings-cache-note').textContent).toBe('2.0 KB → 0 B（释放 2.0 KB）');
    expect(node('settings-cache-note').getAttribute('data-cache-state')).toBe('ok');
    expect(prune.textContent).toBe('立即清理');
    expect(prune.disabled).toBe(false);
    // keepNote=true：回读 status 后结果条不被覆盖
    expect(callsOn('ytvdlt:thumbnail:cache').some((c) => (c.payload as any)?.action === 'status')).toBe(true);
    expect(node('settings-cache-note').textContent).toBe('2.0 KB → 0 B（释放 2.0 KB）');
  });

  it('prune 报告失败 → failed 提示；末尾回读 status 不可用 → 三个控件禁用', async () => {
    reply = (channel, payload: any) => payload?.action === 'prune'
      ? { report: { ok: false }, message: 'shell.trashItem 不可用' }
      : { ok: false };
    node('settings-cache-prune').dispatch('click');
    await flush();
    // 中间的“清理失败”提示会被末尾回读覆盖 —— 最终呈现是不可用 + 控件禁用
    expect(node('settings-cache-note').textContent).toBe('此构建未启用封面缓存');
    expect(node('settings-cache-note').getAttribute('data-cache-state')).toBe('error');
    expect(node('settings-cache-auto').disabled).toBe(true);
    expect(node('settings-cache-limit').disabled).toBe(true);
    expect(node('settings-cache-prune').disabled).toBe(true);
  });

  it('prune 报告失败（回读挂起）→ 失败文案稳定可见，按钮恢复', async () => {
    reply = (channel, payload: any) => payload?.action === 'prune'
      ? { report: { ok: false }, message: 'shell.trashItem 不可用' }
      : new Promise(() => {});
    const prune = node('settings-cache-prune');
    prune.dispatch('click');
    await flush();
    expect(node('settings-cache-note').textContent).toBe('清理失败：shell.trashItem 不可用');
    expect(prune.textContent).toBe('立即清理');
    expect(prune.disabled).toBe(false);
    expect(callsOn('ytvdlt:thumbnail:cache').some((c) => (c.payload as any)?.action === 'status')).toBe(true);
  });

  it('prune 请求被拒绝 → failed 文案，按钮恢复', async () => {
    reply = (channel, payload: any) => payload?.action === 'prune' ? Promise.reject(new Error('ipc lost')) : new Promise(() => {});
    const prune = node('settings-cache-prune');
    prune.dispatch('click');
    await flush();
    expect(node('settings-cache-note').textContent).toBe('清理失败：Error: ipc lost');
    expect(prune.textContent).toBe('立即清理');
    expect(prune.disabled).toBe(false);
  });

  it('status 拒绝 / set-auto 拒绝 → failed 提示 + 控件禁用', async () => {
    reply = (channel, payload: any) => payload?.action === 'status' ? Promise.reject(new Error('bridge gone')) : {};
    node('settings-cache-prune').dispatch('click'); // 借 prune 的末尾回读触发失败的 status
    await flush();
    expect(node('settings-cache-note').textContent).toBe('清理失败：Error: bridge gone');
    expect(node('settings-cache-auto').disabled).toBe(true);
    reply = (channel, payload: any) => payload?.action === 'set-auto' ? Promise.reject(new Error('offline')) : {};
    const auto = node('settings-cache-auto');
    auto.checked = !auto.checked;
    auto.dispatch('change');
    await flush();
    expect(node('settings-cache-note').textContent).toBe('清理失败：Error: offline');
  });

  it('无桥接：prune / set-auto / set-max-bytes 都给离线提示', () => {
    delete win.ytvdltBridge;
    try {
      const prune = node('settings-cache-prune');
      prune.dispatch('click');
      expect(node('settings-cache-note').textContent).toBe('离线：未连接主进程，无法读取缓存');
      expect(prune.disabled).toBe(false); // 离线分支会恢复按钮
      const auto = node('settings-cache-auto');
      auto.checked = !auto.checked;
      auto.dispatch('change');
      expect(node('settings-cache-note').textContent).toBe('离线：未连接主进程，无法读取缓存');
      const limit = node('settings-cache-limit');
      limit.value = '104857600';
      limit.dispatch('change');
      expect(node('settings-cache-note').textContent).toBe('离线：未连接主进程，无法读取缓存');
    } finally {
      win.ytvdltBridge = realBridge;
    }
  });
});

describe('命令模板面板（D-139）', () => {
  it('保存成功 → 清表单 + 重载名单渲染行与拒绝计数；删除走通道并再次重载', async () => {
    reply = (channel, payload: any) => channel === 'ytvdlt:template:save'
      ? { created: { id: payload?.name } }
      : channel === 'ytvdlt:template:list'
        ? { templates: [{ id: 't1', name: '仅字幕', args: ['--write-subs'] }], rejectedAtLoad: [{}] }
        : {};
    const name = node('settings-template-name');
    const args = node('settings-template-args');
    name.value = '仅字幕';
    args.value = '--write-subs\n\n  --sub-langs en  \n';
    node('settings-template-save').dispatch('click');
    await flush();
    // 每行一个参数：空行与首尾空白都被吞掉
    expect(lastCall('ytvdlt:template:save')?.payload).toEqual({ name: '仅字幕', args: ['--write-subs', '--sub-langs en'] });
    expect(name.value).toBe('');
    expect(args.value).toBe('');
    const list = node('settings-template-list');
    expect(list.children).toHaveLength(1);
    const row = list.children[0];
    expect(row.className).toBe('template-item');
    expect(row.children[0].tagName).toBe('B');
    expect(row.children[0].textContent).toBe('仅字幕');
    expect(row.children[1].tagName).toBe('CODE');
    expect(row.children[1].textContent).toBe('--write-subs');
    expect(row.children[2].type).toBe('button');
    expect(row.children[2].textContent).toBe('删除');
    expect(node('settings-template-empty').hidden).toBe(true);
    // 保存成功后的重载把“拒绝计数”提示写上（覆盖掉已保存提示）
    expect(node('settings-template-note').textContent).toBe('有 1 条模板在加载时被拒绝。');

    reply = (channel) => channel === 'ytvdlt:template:delete'
      ? { removed: true }
      : channel === 'ytvdlt:template:list' ? { templates: [], rejectedAtLoad: [] } : {};
    row.children[2].dispatch('click');
    await flush();
    expect(lastCall('ytvdlt:template:delete')?.payload).toEqual({ id: 't1' });
    expect(node('settings-template-note').textContent).toBe('已删除。');
    expect(node('settings-template-list').children).toHaveLength(0);
    expect(node('settings-template-empty').hidden).toBe(false);
  });

  it('空表单 / 校验拒绝 / 通道拒绝 / 名单形状不对 → 稳定文案', async () => {
    const name = node('settings-template-name');
    const args = node('settings-template-args');
    name.value = '  ';
    args.value = '\n\n';
    node('settings-template-save').dispatch('click');
    expect(node('settings-template-note').textContent).toBe('请填写名称，并至少给一个参数。');

    name.value = '危险模板';
    args.value = '--x';
    reply = (channel) => channel === 'ytvdlt:template:save' ? { message: '危险参数被拒绝' } : {};
    node('settings-template-save').dispatch('click');
    await flush();
    expect(node('settings-template-note').textContent).toBe('模板未通过校验：危险参数被拒绝');
    expect(name.value).toBe('危险模板'); // 失败不清表单

    reply = (channel) => channel === 'ytvdlt:template:save' ? Promise.reject(new Error('bad')) : {};
    node('settings-template-save').dispatch('click');
    await flush();
    expect(node('settings-template-note').textContent).toBe('模板未通过校验：Error: bad');

    // 保存成功但名单应答形状不对 → 不可用文案
    reply = (channel, payload: any) => channel === 'ytvdlt:template:save'
      ? { created: { id: payload?.name } }
      : {};
    args.value = '--ok';
    node('settings-template-save').dispatch('click');
    await flush();
    expect(node('settings-template-note').textContent).toBe('当前构建不可用。');
  });

  it('空 id 的删除请求被吞掉；removed !== true → invalid 文案', async () => {
    let listReply: unknown = { templates: [{ id: '', name: 'ghost', args: ['--a'] }], rejectedAtLoad: [] };
    reply = (channel) => channel === 'ytvdlt:template:list'
      ? listReply
      : channel === 'ytvdlt:template:save' ? { created: { id: 'x' } }
        : channel === 'ytvdlt:template:delete' ? { removed: true } : {};
    node('settings-template-name').value = 'ghost';
    node('settings-template-args').value = '--a';
    node('settings-template-save').dispatch('click');
    await flush();
    const ghostRow = node('settings-template-list').children[0];
    expect(ghostRow.children[0].textContent).toBe('ghost');
    const before = callsOn('ytvdlt:template:delete').length;
    ghostRow.children[2].dispatch('click');
    await flush();
    expect(callsOn('ytvdlt:template:delete').length).toBe(before);

    listReply = { templates: [{ id: 't9', name: 'x', args: [] }], rejectedAtLoad: [] };
    reply = (channel) => channel === 'ytvdlt:template:list'
      ? listReply
      : channel === 'ytvdlt:template:save' ? { created: { id: 'x' } }
        : channel === 'ytvdlt:template:delete' ? { removed: false } : {};
    node('settings-template-name').value = 'x';
    node('settings-template-args').value = '--a';
    node('settings-template-save').dispatch('click');
    await flush();
    node('settings-template-list').children[0].children[2].dispatch('click');
    await flush();
    expect(node('settings-template-note').textContent).toBe('模板未通过校验：');
  });

  it('删除被拒绝 → 不可用文案', async () => {
    reply = (channel) => channel === 'ytvdlt:template:list'
      ? { templates: [{ id: 't8', name: 'x', args: [] }], rejectedAtLoad: [] }
      : channel === 'ytvdlt:template:save' ? { created: { id: 'x' } }
        : channel === 'ytvdlt:template:delete' ? Promise.reject(new Error('no')) : {};
    node('settings-template-name').value = 'x';
    node('settings-template-args').value = '--a';
    node('settings-template-save').dispatch('click');
    await flush();
    node('settings-template-list').children[0].children[2].dispatch('click');
    await flush();
    expect(node('settings-template-note').textContent).toBe('当前构建不可用。');
  });
});

describe('目录侧边栏与滚动联动（D-99，内层 .settings-scroll）', () => {
  it('初始高亮第一屏；滚动移动高亮；到底部强制最后一项', () => {
    const host = node('settings-scroll');
    const nav = node('settings-nav');
    const [first, second, last] = navParts;
    expect(nav.getAttribute('data-active')).toBe('nav-appearance');
    expect(nav.getAttribute('data-scrollable')).toBe('1');
    expect(first.link.getAttribute('aria-current')).toBe('true');
    expect(second.link.getAttribute('aria-current')).toBe('false');
    expect(last.link.getAttribute('aria-current')).toBe('false');

    host.scrollTop = 420; // probe = 448 → 第二段（偏移 400）
    host.dispatch('scroll');
    expect(nav.getAttribute('data-active')).toBe('nav-paths');
    expect(second.link.getAttribute('aria-current')).toBe('true');

    // 手册坑 10 的下半句：列真实溢出时，到底部（scrollTop + clientHeight >=
    // scrollHeight - 4）即使尾段标题没过探针线也必须高亮最后一项
    host.scrollTop = 998; // 998 + 800 >= 1800 - 4
    host.dispatch('scroll');
    expect(nav.getAttribute('data-active')).toBe('nav-updates');
    expect(last.link.getAttribute('aria-current')).toBe('true');
  });

  it('点击目录项：preventDefault + 滚动 + 乐观高亮；reduced 时 behavior=auto；无 scrollTo 时直接赋值', () => {
    const host = node('settings-scroll');
    const nav = node('settings-nav');
    host.scrollTop = 0;
    doc.documentElement.setAttribute('data-motion', 'reduced');
    const scrollTo = vi.fn();
    host.scrollTo = scrollTo;
    const preventDefault = vi.fn();
    navParts[1].link.dispatch('click', { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: 396, behavior: 'auto' });
    expect(navParts[1].link.getAttribute('aria-current')).toBe('true');

    doc.documentElement.setAttribute('data-motion', 'full');
    navParts[2].link.dispatch('click', { preventDefault: vi.fn() });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 796, behavior: 'smooth' });
    delete host.scrollTo;
    navParts[0].link.dispatch('click', { preventDefault: vi.fn() });
    expect(host.scrollTop).toBe(16);
    expect(navParts[0].link.getAttribute('aria-current')).toBe('true');
    expect(navParts[1].link.getAttribute('aria-current')).toBe('false');
  });

  it('resize / load / ResizeObserver 都会触发重测（观察宿主与各分区）', () => {
    const host = node('settings-scroll');
    const nav = node('settings-nav');
    host.scrollTop = 500;
    win.dispatch('resize');
    expect(nav.getAttribute('data-active')).toBe('nav-paths');
    win.dispatch('load');
    expect(nav.getAttribute('data-active')).toBe('nav-paths');
    const observer = resizeObservers[0];
    expect(observer.observed).toHaveLength(4);
    expect(observer.observed).toContain(host);
    host.scrollTop = 0;
    observer.callback();
    expect(nav.getAttribute('data-active')).toBe('nav-appearance');
  });
});

describe('开关持久化（D-166：autostart 失败回弹，开关不说谎）', () => {
  it('autostart 变更 → settings:set；应答拒绝则回弹', async () => {
    const autostart = node('settings-autostart');
    autostart.checked = true;
    autostart.dispatch('change');
    expect(lastCall('ytvdlt:settings:set')?.payload).toEqual({ autostart: true });
    reply = (channel) => channel === 'ytvdlt:settings:set' ? Promise.reject(new Error('registry')) : {};
    autostart.checked = false;
    autostart.dispatch('change');
    await flush();
    expect(lastCall('ytvdlt:settings:set')?.payload).toEqual({ autostart: false });
    expect(autostart.checked).toBe(true);
  });

  it('同步抛错同样回弹', () => {
    const autostart = node('settings-autostart');
    const original = win.ytvdltBridge;
    win.ytvdltBridge = { invoke: () => { throw new Error('sync'); } };
    try {
      autostart.checked = false;
      autostart.dispatch('change');
      expect(autostart.checked).toBe(true);
    } finally {
      win.ytvdltBridge = original;
    }
  });

  it('appAuto / engineAuto 变更 → settings:set 对应键', () => {
    reply = () => ({}); // 上一场景泄漏的拒绝应答会变成未处理 rejection，这里复位
    const appAuto = node('settings-app-auto');
    appAuto.checked = false;
    appAuto.dispatch('change');
    expect(lastCall('ytvdlt:settings:set')?.payload).toEqual({ autoCheckAppUpdate: false });
    const engineAuto = node('settings-engine-auto');
    engineAuto.checked = true;
    engineAuto.dispatch('change');
    expect(lastCall('ytvdlt:settings:set')?.payload).toEqual({ autoCheckEngineUpdate: true });
  });
});

describe('应用本体更新状态机（D-93 / D-104 对齐）', () => {
  it('status 各 phase 的文案矩阵（含字节格式化、无 total 占位、pageUrl 显隐）', async () => {
    const page = node('settings-app-page');
    const paint = async (state: unknown) => {
      reply = statusOf(state);
      page.dispatch('click'); // open-page → resolve 后回读 status → 重绘
      await flush();
    };

    await paint({ phase: 'available', currentVersion: '0.2.5', latest: { version: '1.2.3', pageUrl: 'https://example/release' } });
    expect(node('settings-app-state').textContent).toBe('新版本 1.2.3 可用');
    expect(node('settings-app-update').textContent).toBe('下载并安装');
    expect(node('settings-app-block').getAttribute('data-update-state')).toBe('available');
    expect(page.getAttribute('hidden')).toBe('false');
    expect(page.textContent).toBe('打开发布页');

    await paint({ phase: 'downloading', downloadedBytes: 4096, totalBytes: 8192 });
    expect(node('settings-app-state').textContent).toBe('正在下载 4.0 KB / 8.0 KB');
    await paint({ phase: 'downloading', downloadedBytes: 4096 });
    expect(node('settings-app-state').textContent).toBe('正在下载 4.0 KB / —');

    await paint({ phase: 'ready', currentVersion: '0.2.5' });
    expect(node('settings-app-state').textContent).toBe(MESSAGES['update.ready']);
    expect(node('settings-app-update').textContent).toBe('立即安装');

    await paint({ phase: 'error', message: '签名不匹配' });
    expect(node('settings-app-state').textContent).toBe('检查失败：签名不匹配');

    await paint({ phase: 'weird', message: '主进程自定义消息' });
    expect(node('settings-app-state').textContent).toBe('主进程自定义消息');
  });

  it('status 拒绝 → paintApp(null)：离线文案 + 检查按钮禁用', async () => {
    reply = (channel, payload: any) => (payload && payload.action ? {} : Promise.reject(new Error('status down')));
    node('settings-app-page').dispatch('click');
    await flush();
    expect(node('settings-app-state').textContent).toBe('离线：未连接主进程，无法检查更新');
    expect(node('settings-app-update').disabled).toBe(true);
  });

  it('click 映射 idle→check / available→download / ready→install；appBusy 吞掉并发点击；失败可重试', async () => {
    const button = node('settings-app-update');
    node('settings-app-block').setAttribute('data-update-state', 'idle');
    let releaseAction: (value: unknown) => void = () => {};
    reply = () => new Promise((resolve) => { releaseAction = resolve; });

    button.click();
    button.click(); // appBusy → 吞掉
    expect(callsOn('ytvdlt:appUpdate:action')).toHaveLength(1);
    expect(callsOn('ytvdlt:appUpdate:action')[0].payload).toEqual({ action: 'check' });
    expect(button.disabled).toBe(true);

    releaseAction({ ok: true, state: { phase: 'available', latest: { version: '1.2.3' } } });
    await flush();
    expect(node('settings-app-block').getAttribute('data-update-state')).toBe('available');
    button.click(); // available → download
    expect(callsOn('ytvdlt:appUpdate:action')).toHaveLength(2);
    // D-141：download 未应答期间，状态条保持 available
    await flush();
    expect(node('settings-app-state').textContent).toBe('新版本 1.2.3 可用');
    releaseAction({ ok: true, state: { phase: 'downloading', downloadedBytes: 1536, totalBytes: 2621440 } });
    await flush();
    expect(node('settings-app-state').textContent).toBe('正在下载 1.5 KB / 2.5 MB');

    // 轮询把 phase 推到 ready（顺带覆盖 downloading 轮询分支）
    reply = statusOf({ phase: 'ready', currentVersion: '0.2.5' });
    vi.advanceTimersByTime(1500);
    await flush();
    expect(node('settings-app-update').textContent).toBe('立即安装');
    button.click(); // ready → install
    await flush();
    expect((callsOn('ytvdlt:appUpdate:action').at(-1)?.payload as any).action).toBe('install');

    // install 失败 → 反馈 + 可重试（老测试钉住的语义）。注意 appAction 开始时会
    // 清空 appFeedback，所以重绘必须走轮询（readAppState），不能借 open-page。
    let releaseInstall: (value: unknown) => void = () => {};
    reply = () => new Promise((resolve) => { releaseInstall = resolve; });
    button.click();
    await flush();
    releaseInstall({ ok: false, message: 'launch failed' });
    await flush();
    reply = statusOf({ phase: 'ready', currentVersion: '0.2.5' });
    node('settings-app-block').setAttribute('data-update-state', 'downloading');
    vi.advanceTimersByTime(1500); // downloading 阶段轮询 → 回读 status → 重绘
    await flush();
    expect(node('settings-app-state').textContent).toBe('launch failed');
    expect(button.disabled).toBe(false);
    // 第二次 install 直接被拒 → appAction 的 catch（appBusy 复位 + 错误反馈）
    let releaseInstall2: (value: unknown) => void = () => {};
    reply = () => new Promise((resolve) => { releaseInstall2 = resolve; });
    button.click();
    await flush();
    releaseInstall2(Promise.reject(new Error('ipc lost')));
    await flush();
    reply = statusOf({ phase: 'ready', currentVersion: '0.2.5' });
    node('settings-app-block').setAttribute('data-update-state', 'downloading');
    vi.advanceTimersByTime(1500);
    await flush();
    expect(node('settings-app-state').textContent).toBe('检查失败：Error: ipc lost');
    expect(button.disabled).toBe(false);
    // install 一共点了三次：第一次（ready→install 映射）应答空对象，随后两次失败重试
    expect(callsOn('ytvdlt:appUpdate:action').filter((c) => (c.payload as any)?.action === 'install')).toHaveLength(3);
  });
});

describe('轮询闸门（D-141：appBusy 是 download 未应答期间的唯一信号）', () => {
  it('安静期（available + 非 busy）不轮询', async () => {
    reply = statusOf({ phase: 'available', currentVersion: '0.2.5', latest: { version: '1.2.3' } });
    node('settings-app-page').dispatch('click');
    await flush();
    expect(node('settings-app-block').getAttribute('data-update-state')).toBe('available');
    globals!.bridgeCalls.length = 0;
    vi.advanceTimersByTime(3000);
    await flush();
    expect(callsOn('ytvdlt:appUpdate:status')).toHaveLength(0);
    expect(callsOn('ytvdlt:appUpdate:action')).toHaveLength(0);
  });

  it('appBusy / downloading 阶段持续轮询；隐藏页签暂停', async () => {
    let releaseAction: (value: unknown) => void = () => {};
    reply = (channel, payload: any) => payload && payload.action
      ? new Promise((resolve) => { releaseAction = resolve; })
      : { phase: 'downloading', downloadedBytes: 8192, totalBytes: 8192 };
    node('settings-app-block').setAttribute('data-update-state', 'available');
    node('settings-app-update').click(); // download 挂起，appBusy=true
    globals!.bridgeCalls.length = 0;
    vi.advanceTimersByTime(1500);
    await flush();
    expect(callsOn('ytvdlt:appUpdate:status')).toHaveLength(1);
    // D-141 的用户价值：download 未应答期间进度照常可见
    expect(node('settings-app-state').textContent).toBe('正在下载 8.0 KB / 8.0 KB');

    (doc as any).visibilityState = 'hidden';
    globals!.bridgeCalls.length = 0;
    vi.advanceTimersByTime(3000);
    await flush();
    expect(callsOn('ytvdlt:appUpdate:status')).toHaveLength(0);
    (doc as any).visibilityState = 'visible';

    releaseAction({ ok: true, state: { phase: 'downloading', downloadedBytes: 8192, totalBytes: 8192 } });
    await flush();
    globals!.bridgeCalls.length = 0;
    vi.advanceTimersByTime(1500); // phase=downloading + 非 busy → 继续轮询
    await flush();
    expect(callsOn('ytvdlt:appUpdate:status')).toHaveLength(1);
  });

  it('ready / idle 阶段安静', async () => {
    reply = statusOf({ phase: 'ready', currentVersion: '0.2.5' });
    node('settings-app-page').dispatch('click');
    await flush();
    globals!.bridgeCalls.length = 0;
    vi.advanceTimersByTime(3000);
    await flush();
    expect(callsOn('ytvdlt:appUpdate:status')).toHaveLength(0);
    reply = statusOf({ phase: 'idle', currentVersion: '0.2.5' });
    node('settings-app-page').dispatch('click');
    await flush();
    globals!.bridgeCalls.length = 0;
    vi.advanceTimersByTime(3000);
    await flush();
    expect(callsOn('ytvdlt:appUpdate:status')).toHaveLength(0);
  });
});

describe('无桥接降级（离线文案与按钮禁用语义）', () => {
  it('应用更新面板：无桥 → 离线文案 + 检查按钮禁用；block 属性不动', () => {
    delete win.ytvdltBridge;
    try {
      node('settings-app-block').setAttribute('data-update-state', 'ready');
      node('settings-app-update').click(); // ready → install → 无桥
      expect(node('settings-app-state').textContent).toBe('离线：未连接主进程，无法检查更新');
      expect(node('settings-app-update').disabled).toBe(true);
      expect(node('settings-app-block').getAttribute('data-update-state')).toBe('ready');
      node('settings-app-page').dispatch('click'); // open-page 无桥 → 同样离线
      expect(node('settings-app-state').textContent).toBe('离线：未连接主进程，无法检查更新');
    } finally {
      win.ytvdltBridge = realBridge;
    }
  });

  it('引擎面板：check / update 无桥 → 离线（按钮保持禁用是已知行为，见报告）', () => {
    delete win.ytvdltBridge;
    try {
      node('settings-engine-check').dispatch('click');
      expect(node('settings-components').getAttribute('data-component-state')).toBe('offline');
      expect(node('settings-components').textContent).toBe('离线：未连接主进程，无法检查更新');
      node('settings-engine-update').dispatch('click');
      expect(node('settings-components').getAttribute('data-component-state')).toBe('offline');
    } finally {
      win.ytvdltBridge = realBridge;
    }
  });

  it('更新应答落地前桥被拔 → 末尾回读走 refreshComponents 离线分支', async () => {
    let releaseUpdate: (value: unknown) => void = () => {};
    reply = (channel) => channel === 'ytvdlt:component:update' ? new Promise((resolve) => { releaseUpdate = resolve; }) : {};
    node('settings-engine-update').dispatch('click');
    delete win.ytvdltBridge;
    try {
      releaseUpdate({ ok: true, results: [] });
      await flush();
      expect(node('settings-components').getAttribute('data-component-state')).toBe('offline');
      expect(node('settings-engine-update').disabled).toBe(true);
    } finally {
      win.ytvdltBridge = realBridge;
    }
  });

  it('模板面板：无桥 → 不可用文案', () => {
    delete win.ytvdltBridge;
    try {
      node('settings-template-name').value = 'x';
      node('settings-template-args').value = '--a';
      node('settings-template-save').dispatch('click');
      expect(node('settings-template-note').textContent).toBe('当前构建不可用。');
    } finally {
      win.ytvdltBridge = realBridge;
    }
  });

  it('bridge.invoke 同步抛错 → invokeBridge 吞掉按离线处理', () => {
    win.ytvdltBridge = { invoke: () => { throw new Error('sync boom'); } };
    try {
      node('settings-engine-check').dispatch('click');
      expect(node('settings-components').getAttribute('data-component-state')).toBe('offline');
    } finally {
      win.ytvdltBridge = realBridge;
    }
  });

  it('prune 应答落地前桥被拔 → 末尾回读走 refreshCache 离线分支', async () => {
    let releasePrune: (value: unknown) => void = () => {};
    reply = (channel, payload: any) => payload?.action === 'prune' ? new Promise((resolve) => { releasePrune = resolve; }) : new Promise(() => {});
    const prune = node('settings-cache-prune');
    prune.dispatch('click');
    delete win.ytvdltBridge;
    try {
      releasePrune({ report: { ok: true, bytesBefore: 0, bytesAfter: 0, freedBytes: 0 } });
      await flush();
      expect(node('settings-cache-note').textContent).toBe('离线：未连接主进程，无法读取缓存');
      expect(node('settings-cache-auto').disabled).toBe(true);
      expect(node('settings-cache-limit').disabled).toBe(true);
      expect(node('settings-cache-prune').disabled).toBe(true);
    } finally {
      win.ytvdltBridge = realBridge;
    }
  });

  it('模板保存应答落地前桥被拔 → loadTemplates 走离线分支', async () => {
    let releaseSave: (value: unknown) => void = () => {};
    reply = (channel) => channel === 'ytvdlt:template:save' ? new Promise((resolve) => { releaseSave = resolve; }) : new Promise(() => {});
    node('settings-template-name').value = 'x';
    node('settings-template-args').value = '--a';
    node('settings-template-save').dispatch('click');
    delete win.ytvdltBridge;
    try {
      releaseSave({ created: { id: 'x' } });
      await flush();
      expect(node('settings-template-name').value).toBe('');
      expect(node('settings-template-note').textContent).toBe('当前构建不可用。');
    } finally {
      win.ytvdltBridge = realBridge;
    }
  });
});

describe('D-93 缓存复用：status 直接 ready → 免下载直接 install；install 成功后按钮保持禁用', () => {
  it('ready 无需 download；install 成功 → appBusy 保持、按钮禁用、轮询继续', async () => {
    const button = node('settings-app-update');
    reply = statusOf({ phase: 'ready', currentVersion: '0.2.5', latest: { pageUrl: 'https://example/release' } });
    node('settings-app-page').dispatch('click');
    await flush();
    expect(node('settings-app-block').getAttribute('data-update-state')).toBe('ready');
    expect(node('settings-app-update').textContent).toBe('立即安装');
    expect(node('settings-app-page').getAttribute('hidden')).toBe('false');
    globals!.bridgeCalls.length = 0;

    let releaseInstall: (value: unknown) => void = () => {};
    reply = (channel, payload: any) => (payload && payload.action ? new Promise((resolve) => { releaseInstall = resolve; }) : {});
    button.click(); // ready → install
    await flush();
    releaseInstall({ ok: true, message: 'launched' });
    await flush();
    expect(button.disabled).toBe(true); // 安装已启动 → 保持禁用（appBusy 唯一保持）
    expect(node('settings-app-state').textContent).toBe('launched');
    expect(callsOn('ytvdlt:appUpdate:action').some((c) => (c.payload as any)?.action === 'download')).toBe(false);
    // appBusy 卡住期间轮询仍在跑
    globals!.bridgeCalls.length = 0;
    vi.advanceTimersByTime(1500);
    await flush();
    expect(callsOn('ytvdlt:appUpdate:status')).toHaveLength(1);
  });
});

describe('语言切换（重载语义 + D-85 SETTINGS_SET）', () => {
  it('切到 en：携带 v= 的 URL 替换、settings:set、localStorage、emit；offlineText 随 locale 走英文', () => {
    node('settings-language').children.find((b: any) => b.getAttribute('data-locale') === 'en').click();
    expect(locationReplace).toHaveBeenCalledWith('file:///C:/app/pages/queue/index.html?v=9.9.9&lang=en');
    expect(lastCall('ytvdlt:settings:set')?.payload).toEqual({ language: 'en' });
    expect(win.localStorage.getItem('ytvdlt.locale')).toBe('en');
    expect(JSON.parse(node('ytvdlt-output').textContent)).toEqual({ action: 'language', value: 'en' });
    expect(settings.state.locale).toBe('en');

    delete win.ytvdltBridge;
    try {
      pathButtons[1].click();
    } finally {
      win.ytvdltBridge = realBridge;
    }
    expect(node('settings-path-note').textContent).toBe('Offline: main process not connected');

    // 真实页面会整页重载；测试内恢复 zh-CN 让文件内其余断言稳定
    settings.state.locale = 'zh-CN';
  });

  it('切回 zh-CN：URL 不带 lang 参数，仍补 v= 提示', () => {
    node('settings-language').children.find((b: any) => b.getAttribute('data-locale') === 'zh-CN').click();
    expect(locationReplace).toHaveBeenLastCalledWith('file:///C:/app/pages/queue/index.html?v=9.9.9');
    expect(lastCall('ytvdlt:settings:set')?.payload).toEqual({ language: 'zh-CN' });
  });
});
