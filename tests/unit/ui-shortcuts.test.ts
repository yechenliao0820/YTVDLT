/**
 * D-187 · shortcuts.js（M5 键盘快捷键浏览器镜像）真实行为单测 —— import 路线，
 * v8 覆盖率可见。
 *
 * 既有 tests/unit/shortcuts.test.ts 用文本解析把浏览器表与 @ytvdlt/core 权威表
 * 对齐（同步性守门），但 `runInNewContext`/纯解析看不见运行时行为；本文件用共享
 * 装载架 tests/unit/helpers/ui-harness.ts 真实 `import()` shortcuts.js，驱动
 * window.YTVDLT.shortcuts 暴露的完整测试面，覆盖：
 *   - 注册表形状：14 条绑定、id 唯一、恰好一条 global 作用域（global-prefill）、
 *     editingSafe 标志逐条钉死；
 *   - parseAccelerator / matches：Ctrl 组合键、CmdOrCtrl/Cmd/Meta 别名、
 *     Del/Esc 事件键别名、修饰键严格相等、macOS（navigator.platform 与
 *     __YTVDLT_PLATFORM__ 两个来源）下 Ctrl→Cmd 映射；
 *   - 「输入焦点永不劫持编辑键」守卫：INPUT/TEXTAREA/SELECT/contenteditable，
 *     以及 global-prefill 的编辑例外；
 *   - install/on/off 生命周期：keydown 分发 → resolve → handler → preventDefault
 *     的完整链路、handler 覆盖与卸载、dispose 移除监听、非法 doc 的 noop 兜底；
 *   - extractDeepLink 的 `--url=` 深链解析（A-4.1-02，与 core extractDeepLink
 *     对齐的浏览器侧镜像）。
 *
 * 【F11 说明】全屏切换不在 shortcuts.js 的表里：它由原生菜单承担
 * （apps/desktop/src/main/app-menu.ts 的 `F11` accelerator，queue.foot.hint 文案
 * 只是提示），页面侧只有 nav 的全屏按钮 —— 本文件只钉 shortcuts.js 真实拥有的表。
 *
 * 【模块单例】shortcuts.js 的所有函数都惰性读 global（注入表 / 平台 / navigator），
 * 场景差异通过「临时改 win 注入 / 换 navigator」构造，用例间自行还原。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installUiGlobals, loadUiModule, uiNode, type UiGlobals, type UiNode } from './helpers/ui-harness.js';

let globals: UiGlobals | null = null;
let shortcuts: any = null; // window.YTVDLT.shortcuts

const win = () => globals!.window as Record<string, any>;

interface KeyEvent {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  target?: unknown;
  preventDefault?: () => void;
}

function event(partial: Partial<KeyEvent> & { key: string }): KeyEvent {
  return { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...partial };
}

/** 安装到假文档上的 keydown 全链路桩：返回分发函数与 preventDefault 记录。 */
function keyHarness(): { doc: UiNode; fire(e: KeyEvent): void; prevented(): number } {
  const doc = uiNode('div');
  let prevented = 0;
  return {
    doc,
    fire(e: KeyEvent): void {
      doc.dispatch('keydown', { ...e, preventDefault: () => { prevented += 1; } });
    },
    prevented: () => prevented,
  };
}

beforeAll(async () => {
  globals = installUiGlobals({
    // shortcuts.js 不需要桥、不在 import 期触碰 DOM —— 最小假窗口即可。
    bridge: null,
    location: { href: 'file:///C:/app/pages/queue/index.html', search: '', protocol: 'file:' },
  });
  await loadUiModule('shortcuts/shortcuts.js', globals);
  shortcuts = (win().YTVDLT as Record<string, any>).shortcuts;
});

afterAll(() => {
  globals?.restore();
  globals = null;
});

/** 每个用例结束清理注入（平台 / 自定义表 / navigator）。 */
function resetInjections(): void {
  delete win().__YTVDLT_PLATFORM__;
  delete win().__YTVDLT_SHORTCUTS__;
  win().navigator = { userAgent: 'vitest-ui-harness' };
}

// ---------------------------------------------------------------------------
// 族一 · 注册表形状（与 core 权威表同形的浏览器镜像）
// ---------------------------------------------------------------------------
describe('D-187 · 快捷键注册表形状', () => {
  it('14 条绑定：id 唯一、文档化的加速键齐全、恰好一条 global 作用域', () => {
    const table = shortcuts.DEFAULT_BINDINGS as Array<Record<string, unknown>>;
    expect(table).toHaveLength(14);
    const ids = table.map((b) => b.id);
    expect(new Set(ids).size).toBe(14);
    expect(table.map((b) => b.accelerator)).toEqual([
      'Ctrl+V', 'Ctrl+N', 'Ctrl+Enter', 'Ctrl+,', 'Ctrl+F', 'Ctrl+Shift+V',
      'Delete', 'Ctrl+R', 'Escape', 'F5', 'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4',
    ]);
    expect(table.filter((b) => b.scope === 'global').map((b) => b.id)).toEqual(['global-prefill']);
  });

  it('editingSafe 标志逐条钉死：粘贴/搜索/删除/刷新拒绝编辑态，其余放行', () => {
    const editingSafe = Object.fromEntries(
      (shortcuts.DEFAULT_BINDINGS as Array<{ id: string; editingSafe: boolean }>)
        .map((b) => [b.id, b.editingSafe]),
    );
    expect(editingSafe).toEqual({
      'paste-parse': false,
      'new-download': true,
      start: true,
      settings: true,
      search: false,
      'global-prefill': true,
      'cancel-selected': false,
      retry: true,
      'close-dialog': true,
      refresh: false,
      'nav-1': true,
      'nav-2': true,
      'nav-3': true,
      'nav-4': true,
    });
  });

  it('bindings()：默认返回内建表；__YTVDLT_SHORTCUTS__ 注入非空数组时整体接管，空数组回退', () => {
    expect(shortcuts.bindings()).toBe(shortcuts.DEFAULT_BINDINGS);
    const custom = [{ id: 'custom-x', accelerator: 'Ctrl+9', scope: 'app', editingSafe: true }];
    win().__YTVDLT_SHORTCUTS__ = custom;
    expect(shortcuts.bindings()).toBe(custom);
    win().__YTVDLT_SHORTCUTS__ = [];
    expect(shortcuts.bindings()).toBe(shortcuts.DEFAULT_BINDINGS);
    delete win().__YTVDLT_SHORTCUTS__;
  });
});

// ---------------------------------------------------------------------------
// 族二 · 加速键解析与匹配（Ctrl 组合键 / 别名 / macOS）
// ---------------------------------------------------------------------------
describe('D-187 · parseAccelerator 与 matches', () => {
  it('parseAccelerator：修饰键归位、key 小写、Ctrl+/Cmd/CmdOrCtrl/Meta 全识别', () => {
    expect(shortcuts.parseAccelerator('Ctrl+Shift+V')).toEqual({
      ctrl: true, shift: true, alt: false, meta: false, key: 'v',
    });
    expect(shortcuts.parseAccelerator('CmdOrCtrl+Enter')).toEqual({
      ctrl: true, shift: false, alt: false, meta: false, key: 'enter',
    });
    expect(shortcuts.parseAccelerator('Meta+Q').meta).toBe(true);
    expect(shortcuts.parseAccelerator('Cmd+Q').meta).toBe(true);
    expect(shortcuts.parseAccelerator('Alt+Shift+P').alt).toBe(true);
    expect(shortcuts.parseAccelerator('Ctrl + N')).toEqual({ ctrl: true, shift: false, alt: false, meta: false, key: 'n' });
    expect(shortcuts.parseAccelerator('Ctrl+,').key).toBe(',');
    expect(shortcuts.parseAccelerator('F5').key).toBe('f5');
    // 未知 token 一律当 key 处理（表内不会有，但解析不炸）。
    expect(shortcuts.parseAccelerator('Weird+X').key).toBe('x');
  });

  it('matches：Windows 下 Ctrl 生效；修饰键严格相等；事件键别名 Del/Esc 与大小写归一', () => {
    expect(shortcuts.matches(event({ key: 'n', ctrlKey: true }), 'Ctrl+N')).toBe(true);
    expect(shortcuts.matches(event({ key: 'N', ctrlKey: true }), 'Ctrl+N')).toBe(true);
    expect(shortcuts.matches(event({ key: 'n' }), 'Ctrl+N')).toBe(false);
    expect(shortcuts.matches(event({ key: 'n', ctrlKey: true, shiftKey: true }), 'Ctrl+N')).toBe(false);
    expect(shortcuts.matches(event({ key: 'n', ctrlKey: true, altKey: true }), 'Ctrl+N')).toBe(false);
    expect(shortcuts.matches(event({ key: 'v', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+V')).toBe(true);
    expect(shortcuts.matches(event({ key: 'Delete' }), 'Delete')).toBe(true);
    expect(shortcuts.matches(event({ key: 'Del' }), 'Delete')).toBe(true);
    expect(shortcuts.matches(event({ key: 'Escape' }), 'Escape')).toBe(true);
    expect(shortcuts.matches(event({ key: 'Esc' }), 'Escape')).toBe(true);
    expect(shortcuts.matches(event({ key: 'F5' }), 'F5')).toBe(true);
    expect(shortcuts.matches(event({ key: 'Enter', ctrlKey: true }), 'Ctrl+Enter')).toBe(true);
    expect(shortcuts.matches(event({ key: ',', ctrlKey: true }), 'Ctrl+,')).toBe(true);
  });

  it('macOS：navigator.platform=Mac* 时 Ctrl 映射为 Cmd；__YTVDLT_PLATFORM__ 优先', () => {
    // ① navigator.platform 来源。
    win().navigator = { platform: 'MacIntel' };
    expect(shortcuts.matches(event({ key: 'n', metaKey: true }), 'Ctrl+N')).toBe(true);
    expect(shortcuts.matches(event({ key: 'n', ctrlKey: true }), 'Ctrl+N')).toBe(false);
    delete win().__YTVDLT_PLATFORM__;
    // ② 注入平台优先于 navigator（打包壳显式告知 darwin）。
    win().__YTVDLT_PLATFORM__ = 'darwin';
    expect(shortcuts.matches(event({ key: 'n', metaKey: true }), 'Ctrl+N')).toBe(true);
    win().navigator = { platform: 'Win32' };
    expect(shortcuts.matches(event({ key: 'n', metaKey: true }), 'Ctrl+N')).toBe(true);
    win().__YTVDLT_PLATFORM__ = 'win32';
    expect(shortcuts.matches(event({ key: 'n', ctrlKey: true }), 'Ctrl+N')).toBe(true);
    expect(shortcuts.matches(event({ key: 'n', metaKey: true }), 'Ctrl+N')).toBe(false);
    resetInjections();
  });

  it('isEditingTarget：四类可编辑目标 + contenteditable；null 安全', () => {
    expect(shortcuts.isEditingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(shortcuts.isEditingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(shortcuts.isEditingTarget({ tagName: 'SELECT' })).toBe(true);
    expect(shortcuts.isEditingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(shortcuts.isEditingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(shortcuts.isEditingTarget({ tagName: 'DIV' })).toBe(false);
    expect(shortcuts.isEditingTarget(null)).toBe(false);
    expect(shortcuts.isEditingTarget(undefined)).toBe(false);
    // D-190: 对齐 core/src/shortcuts/shortcuts.ts 的归一逻辑。真实 DOM 的
    // tagName 恒大写，但 XML 文档 / 测试替身可能给小写或非字符串。
    expect(shortcuts.isEditingTarget({ tagName: 'input' })).toBe(true);
    expect(shortcuts.isEditingTarget({ tagName: 'textarea' })).toBe(true);
    expect(shortcuts.isEditingTarget({ tagName: 'Select' })).toBe(true);
    expect(shortcuts.isEditingTarget({ tagName: undefined })).toBe(false);
    expect(shortcuts.isEditingTarget({ tagName: 42 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 族三 · 编辑守卫与 resolve（输入框焦点时不触发）
// ---------------------------------------------------------------------------
describe('D-187 · resolve 的输入焦点守卫', () => {
  const input = { tagName: 'INPUT', isContentEditable: false };
  const textarea = { tagName: 'TEXTAREA', isContentEditable: false };
  const editable = { tagName: 'DIV', isContentEditable: true };
  const plain = { tagName: 'DIV', isContentEditable: false };

  it('编辑态拒绝 paste-parse / search / cancel-selected / refresh', () => {
    expect(shortcuts.resolve(event({ key: 'v', ctrlKey: true, target: input }))).toBeNull();
    expect(shortcuts.resolve(event({ key: 'f', ctrlKey: true, target: input }))).toBeNull();
    expect(shortcuts.resolve(event({ key: 'Delete', target: input }))).toBeNull();
    expect(shortcuts.resolve(event({ key: 'F5', target: textarea }))).toBeNull();
    expect(shortcuts.resolve(event({ key: 'v', ctrlKey: true, target: editable }))).toBeNull();
    expect(shortcuts.resolve(event({ key: 'Delete', target: editable }))).toBeNull();
  });

  it('editingSafe 绑定在编辑态照常触发；global-prefill 是唯一例外也是设计使然', () => {
    expect(shortcuts.resolve(event({ key: 'v', ctrlKey: true, shiftKey: true, target: input }))?.id)
      .toBe('global-prefill');
    expect(shortcuts.resolve(event({ key: 'n', ctrlKey: true, target: textarea }))?.id).toBe('new-download');
    expect(shortcuts.resolve(event({ key: 'Enter', ctrlKey: true, target: input }))?.id).toBe('start');
    expect(shortcuts.resolve(event({ key: 'Escape', target: input }))?.id).toBe('close-dialog');
    expect(shortcuts.resolve(event({ key: 'r', ctrlKey: true, target: input }))?.id).toBe('retry');
    expect(shortcuts.resolve(event({ key: '2', ctrlKey: true, target: input }))?.id).toBe('nav-2');
  });

  it('非编辑态解析全部文档化绑定；未注册组合键返回 null', () => {
    expect(shortcuts.resolve(event({ key: 'v', ctrlKey: true, target: plain }))?.id).toBe('paste-parse');
    expect(shortcuts.resolve(event({ key: 'n', ctrlKey: true, target: plain }))?.id).toBe('new-download');
    expect(shortcuts.resolve(event({ key: ',', ctrlKey: true, target: plain }))?.id).toBe('settings');
    expect(shortcuts.resolve(event({ key: 'f', ctrlKey: true, target: plain }))?.id).toBe('search');
    expect(shortcuts.resolve(event({ key: 'Delete', target: plain }))?.id).toBe('cancel-selected');
    expect(shortcuts.resolve(event({ key: 'F5', target: plain }))?.id).toBe('refresh');
    expect(shortcuts.resolve(event({ key: '4', ctrlKey: true, target: plain }))?.id).toBe('nav-4');
    expect(shortcuts.resolve(event({ key: 'z', ctrlKey: true, target: plain }))).toBeNull();
    expect(shortcuts.resolve(event({ key: 'F11', target: plain }))).toBeNull(); // 全屏归原生菜单管
  });

  it('注入表接管解析：未列入注入表的加速键一律不解析', () => {
    win().__YTVDLT_SHORTCUTS__ = [{ id: 'custom-x', accelerator: 'Ctrl+9', scope: 'app', editingSafe: true }];
    expect(shortcuts.resolve(event({ key: '9', ctrlKey: true, target: plain }))?.id).toBe('custom-x');
    expect(shortcuts.resolve(event({ key: 'n', ctrlKey: true, target: plain }))).toBeNull();
    // 显式传表优先于注入（resolve 的第二参数）。
    expect(shortcuts.resolve(event({ key: 'n', ctrlKey: true, target: plain }), shortcuts.DEFAULT_BINDINGS)?.id)
      .toBe('new-download');
    delete win().__YTVDLT_SHORTCUTS__;
  });
});

// ---------------------------------------------------------------------------
// 族四 · install/on/off 生命周期与 extractDeepLink（A-4.1-02）
// ---------------------------------------------------------------------------
describe('D-187 · install/on/off 生命周期', () => {
  it('install + on：keydown 全链路 resolve → handler → preventDefault', () => {
    const harness = keyHarness();
    const dispose = shortcuts.install(harness.doc);
    expect(typeof dispose).toBe('function');
    const seen: string[] = [];
    shortcuts.on('new-download', (e: unknown) => { seen.push('new-download'); void e; });
    harness.fire({ key: 'n', ctrlKey: true, target: { tagName: 'DIV' } });
    expect(seen).toEqual(['new-download']);
    expect(harness.prevented()).toBe(1);
    shortcuts.on('new-download', () => seen.push('second'));
    harness.fire({ key: 'n', ctrlKey: true, target: { tagName: 'DIV' } });
    expect(seen).toEqual(['new-download', 'second']); // 后注册覆盖前者
    expect(typeof shortcuts.on('new-download', () => { /* noop */ })).toBe('function');
  });

  it('off 卸载后：keydown 不再派发 handler，也不 preventDefault（放行浏览器默认行为）', () => {
    const harness = keyHarness();
    shortcuts.install(harness.doc);
    const seen: string[] = [];
    const off = shortcuts.on('paste-parse', () => seen.push('paste'));
    harness.fire({ key: 'v', ctrlKey: true, target: { tagName: 'DIV' } });
    expect(seen).toEqual(['paste']);
    expect(harness.prevented()).toBe(1);
    off();
    harness.fire({ key: 'v', ctrlKey: true, target: { tagName: 'DIV' } });
    expect(seen).toEqual(['paste']);
    expect(harness.prevented()).toBe(1); // 无 handler → 不拦截
  });

  it('编辑守卫在 install 链路同样生效；无 handler 的绑定不拦截', () => {
    const harness = keyHarness();
    shortcuts.install(harness.doc);
    const seen: string[] = [];
    shortcuts.on('paste-parse', () => seen.push('paste'));
    harness.fire({ key: 'v', ctrlKey: true, target: { tagName: 'INPUT' } });
    expect(seen).toEqual([]);
    expect(harness.prevented()).toBe(0);
    // Escape 有绑定（close-dialog）但没注册 handler → 不拦截、不派发。
    harness.fire({ key: 'Escape', target: { tagName: 'DIV' } });
    expect(harness.prevented()).toBe(0);
    // 无匹配绑定 → 同样不拦截。
    harness.fire({ key: 'z', ctrlKey: true, target: { tagName: 'DIV' } });
    expect(harness.prevented()).toBe(0);
  });

  it('dispose 移除 keydown 监听；非法 doc 返回 noop 兜底', () => {
    const harness = keyHarness();
    const dispose = shortcuts.install(harness.doc);
    const seen: string[] = [];
    shortcuts.on('new-download', () => seen.push('n'));
    dispose();
    harness.fire({ key: 'n', ctrlKey: true, target: { tagName: 'DIV' } });
    expect(seen).toEqual([]);
    // install(null) / install({}) / 二次 install 都安全。
    expect(typeof shortcuts.install(null)).toBe('function');
    expect(typeof shortcuts.install({} as unknown as UiNode)).toBe('function');
    shortcuts.install(null)();
  });

  it('on 返回的 off 是幂等的（重复调用不炸）', () => {
    const off = shortcuts.on('nav-1', () => { /* noop */ });
    off();
    off();
  });
});

// ---------------------------------------------------------------------------
// 族五 · --url= 深链解析（A-4.1-02）
// ---------------------------------------------------------------------------
describe('D-187 · extractDeepLink 深链解析（A-4.1-02）', () => {
  it('接受 --url=<link> 与 --url <link> 两种形态；非 http(s) 一律拒绝', () => {
    expect(shortcuts.extractDeepLink(['electron.exe', '--url=https://example.org/v']))
      .toBe('https://example.org/v');
    expect(shortcuts.extractDeepLink(['--url', 'https://example.org/v'])).toBe('https://example.org/v');
    expect(shortcuts.extractDeepLink(['--url=HTTP://EXAMPLE.ORG/V'])).toBe('HTTP://EXAMPLE.ORG/V');
    expect(shortcuts.extractDeepLink(['--url=file:///etc/passwd'])).toBeNull();
    expect(shortcuts.extractDeepLink(['--url=ftp://x'])).toBeNull();
    expect(shortcuts.extractDeepLink(['--url='])).toBeNull();
    expect(shortcuts.extractDeepLink(['--url'])).toBeNull();
    expect(shortcuts.extractDeepLink(['--url', 'file:///etc/passwd'])).toBeNull();
    expect(shortcuts.extractDeepLink(['--other', 'https://example.org/v'])).toBeNull();
    expect(shortcuts.extractDeepLink([])).toBeNull();
    // 非 argv 输入（字符串 / null）按空表处理。
    expect(shortcuts.extractDeepLink(undefined as unknown as string[])).toBeNull();
    expect(shortcuts.extractDeepLink('--url=https://x' as unknown as string[])).toBeNull();
    // `--url` 形态取的是下一个参数，且遇到 `--url=` 命中即停（首个生效）。
    expect(shortcuts.extractDeepLink(['--url=https://first.example/v', '--url=https://second.example/v']))
      .toBe('https://first.example/v');
  });
});
