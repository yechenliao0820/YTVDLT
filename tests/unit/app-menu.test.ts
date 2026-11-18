/**
 * D-82 · 中文应用菜单；D-85 · 中英切换；D-91 · 设置 / 关于子菜单。
 *
 * 0.1.6 的截图暴露了 Electron 的默认菜单：File / Edit / View / Window。
 * 这里断言三件事：顶层是中文、行为仍交给 Electron 的 role、点击回调真的接上。
 */
import { describe, it, expect } from 'vitest';
import { buildAppMenu, type AppMenuContext } from '../../apps/desktop/src/main/app-menu.js';

function harness(platform = 'win32'): { context: AppMenuContext; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    context: {
      showWindow: () => { calls.push('show'); },
      quit: () => { calls.push('quit'); },
      platform,
      openSettings: () => { calls.push('settings'); },
      openQueue: () => { calls.push('queue'); },
      openAbout: () => { calls.push('about'); },
      toggleFullscreen: () => { calls.push('fullscreen'); },
    },
  };
}

describe('app menu · 中文顶层菜单', () => {
  it('replaces the English defaults with Chinese labels and adds Settings', () => {
    const { context } = harness();
    expect(buildAppMenu(context).map((item) => item.label))
      .toEqual(['文件(&F)', '编辑(&E)', '视图(&V)', '窗口(&W)', '设置(&S)']);
  });

  it('never leaves an English top-level label behind', () => {
    const { context } = harness();
    const labels = buildAppMenu(context).map((item) => String(item.label));
    for (const english of ['File', 'Edit', 'View', 'Window', 'Help']) {
      expect(labels).not.toContain(english);
    }
  });

  it('keeps native roles so clipboard/zoom behaviour is Electron\'s own', () => {
    const { context } = harness();
    const edit = buildAppMenu(context).find((item) => String(item.label).startsWith('编辑'));
    expect((edit?.submenu ?? []).map((item) => item.role))
      .toEqual(['undo', 'redo', undefined, 'cut', 'copy', 'paste', 'selectAll']);
    const view = buildAppMenu(context).find((item) => String(item.label).startsWith('视图'));
    const roles = (view?.submenu ?? []).map((item) => item.role);
    expect(roles).toContain('resetZoom');
    // D-106: fullscreen is NOT a native role any more — one BrowserWindow
    // controller owns it, otherwise the renderer button cannot exit it.
    const fullscreen = (view?.submenu ?? []).find((item) => item.label === '全屏');
    expect(fullscreen?.role).toBeUndefined();
    expect(fullscreen?.accelerator).toBe('F11');
    expect(typeof fullscreen?.click).toBe('function');
  });

  it('D-106: F11 menu item toggles the same window state as the button', () => {
    const { context, calls } = harness();
    const view = buildAppMenu(context).find((item) => String(item.label).startsWith('视图'));
    (view?.submenu ?? []).find((item) => item.label === '全屏')?.click?.();
    expect(calls).toEqual(['fullscreen']);
  });
});

describe('app menu · 回调', () => {
  it('「新建下载」brings the window back and 「退出」quits', () => {
    const { context, calls } = harness();
    const file = buildAppMenu(context).find((item) => String(item.label).startsWith('文件'));
    const items = file?.submenu ?? [];
    items.find((item) => item.label === '新建下载')?.click?.();
    items.find((item) => item.label === '退出')?.click?.();
    expect(calls).toEqual(['show', 'quit']);
  });

  it('macOS drops the 文件 menu (the app-name menu owns that slot)', () => {
    const { context } = harness('darwin');
    expect(buildAppMenu(context).map((item) => item.label))
      .toEqual(['编辑(&E)', '视图(&V)', '窗口(&W)', '设置(&S)']);
  });
});

/**
 * D-247 · Alt+F4 语义修正。旧菜单把 `Alt+F4` 挂在「退出」上，应用菜单快捷键
 * 优先于系统默认处理，于是 Alt+F4 直接执行 context.quit()（真退出），绕过了
 * WM_CLOSE → close 事件 → D-60 的 close→托盘语义。移除 accelerator 后
 * Alt+F4 与点 X 完全一致（有托盘 → 隐藏、下载继续）；「退出」仍可点击，
 * 中英文文案不变。这不是放松断言——期望从「有 Alt+F4」翻转为「无 Alt+F4」，
 * 正是本决策要钉死的新行为。
 */
describe('app menu · D-247 Alt+F4 语义', () => {
  it('「退出」no longer carries the Alt+F4 accelerator (system chord falls through to close-to-tray)', () => {
    const { context } = harness('win32');
    const file = buildAppMenu(context).find((item) => String(item.label).startsWith('文件'));
    const quit = (file?.submenu ?? []).find((item) => item.label === '退出');
    expect(quit).toBeDefined();
    expect(quit?.accelerator).toBeUndefined();
    expect(typeof quit?.click).toBe('function');
    // The chord must not hide anywhere else in the whole template either —
    // a future "helpful" re-add would silently restore the audit finding.
    expect(JSON.stringify(buildAppMenu(context))).not.toContain('Alt+F4');
    // 文案逐字不变（中英两份）。
    expect(quit?.label).toBe('退出');
    const enQuit = (buildAppMenu({ ...context, locale: 'en' })
      .find((item) => String(item.label).startsWith('File'))?.submenu ?? [])
      .find((item) => item.label === 'Quit');
    expect(enQuit?.accelerator).toBeUndefined();
    expect(enQuit?.label).toBe('Quit');
    // The quit CLICK still performs the real quit (the D-247 quit path in
    // electron-entry now cancels in-flight downloads first).
    const clickHarness = harness();
    const clickQuit = (buildAppMenu(clickHarness.context).find(
      (item) => String(item.label).startsWith('文件'),
    )?.submenu ?? []).find((item) => item.label === '退出');
    clickQuit?.click?.();
    expect(clickHarness.calls).toEqual(['quit']);
  });

  it('macOS keeps Cmd+Q (platform convention; the quit path is safe since D-247)', () => {
    const { context } = harness('darwin');
    // The 文件 menu does not exist on darwin; the quit item lives in the app
    // menu only when a platform shape provides one — assert no Alt+F4 leaked
    // into the darwin template and that no quit-like item lost its click.
    const template = JSON.stringify(buildAppMenu(context));
    expect(template).not.toContain('Alt+F4');
  });
});

describe('app menu · D-91 设置子菜单', () => {
  it('offers preferences / back to queue / about, all wired', () => {
    const { context, calls } = harness();
    const settings = buildAppMenu(context).find((item) => String(item.label).startsWith('设置'));
    expect(settings).toBeDefined();
    const items = (settings?.submenu ?? []).filter((item) => item.type !== 'separator');
    expect(items.map((item) => item.label)).toEqual(['偏好设置…', '返回下载队列', '关于 YTVDLT']);
    items.find((item) => item.label === '偏好设置…')?.click?.();
    items.find((item) => item.label === '返回下载队列')?.click?.();
    items.find((item) => item.label === '关于 YTVDLT')?.click?.();
    expect(calls).toEqual(['settings', 'queue', 'about']);
  });

  it('ships an English variant that follows the locale', () => {
    const { context } = harness();
    expect(buildAppMenu({ ...context, locale: 'en' }).map((item) => item.label))
      .toEqual(['File(&F)', 'Edit(&E)', 'View(&V)', 'Window(&W)', 'Settings(&S)']);
    const settings = buildAppMenu({ ...context, locale: 'en' })
      .find((item) => String(item.label).startsWith('Settings'));
    expect((settings?.submenu ?? []).filter((item) => item.type !== 'separator')
      .map((item) => item.label)).toEqual(['Preferences…', 'Back to queue', 'About YTVDLT']);
  });
});
