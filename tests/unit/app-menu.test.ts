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
    expect((view?.submenu ?? []).map((item) => item.role))
      .toContain('togglefullscreen');
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
