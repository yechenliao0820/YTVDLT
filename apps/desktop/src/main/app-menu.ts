/**
 * 应用菜单（D-82）——纯数据模型，不 import `electron`。
 *
 * 背景：Electron 在没有 `Menu.setApplicationMenu()` 时会装上一份默认菜单，
 * 菜单项是英文的 File / Edit / View / Window。0.1.6 的截图里就是这一份默认
 * 菜单，和其他已经中文化的界面（队列页、托盘菜单）不一致。
 *
 * 这里把菜单结构做成纯数据，`bootstrap.ts` 负责把它交给
 * `Menu.buildFromTemplate()`；和 `tray.ts` 同样的分层理由：没有 Electron
 * 二进制也能单测（D-39）。
 *
 * 角色（role）与标签并存：role 决定行为（撤销/复制/粘贴/缩放/全屏…），
 * label 只覆盖显示文字，所以行为仍是 Electron 原生实现，不自己造轮子。
 * D-85：`locale` 让菜单跟随界面语言；默认仍是中文，因此既有断言不变。
 */

/** `Menu.buildFromTemplate` 需要的最小子集（只列本文件用到的字段）。 */
export interface AppMenuItem {
  readonly label?: string;
  readonly role?: string;
  readonly type?: 'normal' | 'separator' | 'submenu';
  readonly accelerator?: string;
  readonly enabled?: boolean;
  readonly submenu?: readonly AppMenuItem[];
  readonly click?: () => void;
}

export interface AppMenuContext {
  /** 回到主窗口（新建下载前先把窗口叫回来）。 */
  readonly showWindow: () => void;
  /** 真正退出：和托盘「退出」同一套判断由调用方负责。 */
  readonly quit: () => void;
  readonly platform?: string;
  /** D-85: follows the persisted `general.language` setting. */
  readonly locale?: 'zh-CN' | 'en';
  /** D-91: Settings submenu. Optional so existing unit fakes stay valid. */
  readonly openSettings?: () => void;
  readonly openQueue?: () => void;
  readonly openAbout?: () => void;
}

interface MenuLabels {
  readonly file: string;
  readonly newDownload: string;
  readonly quit: string;
  readonly edit: string;
  readonly undo: string;
  readonly redo: string;
  readonly cut: string;
  readonly copy: string;
  readonly paste: string;
  readonly selectAll: string;
  readonly view: string;
  readonly reload: string;
  readonly forceReload: string;
  readonly actualSize: string;
  readonly zoomIn: string;
  readonly zoomOut: string;
  readonly fullscreen: string;
  readonly devTools: string;
  readonly window: string;
  readonly minimize: string;
  readonly close: string;
  readonly settings: string;
  readonly preferences: string;
  readonly backToQueue: string;
  readonly about: string;
}

const ZH: MenuLabels = {
  file: '文件(&F)', newDownload: '新建下载', quit: '退出',
  edit: '编辑(&E)', undo: '撤销', redo: '重做', cut: '剪切', copy: '复制',
  paste: '粘贴', selectAll: '全选',
  view: '视图(&V)', reload: '重新加载', forceReload: '强制重新加载',
  actualSize: '实际大小', zoomIn: '放大', zoomOut: '缩小',
  fullscreen: '全屏', devTools: '开发者工具',
  window: '窗口(&W)', minimize: '最小化', close: '关闭窗口',
  settings: '设置(&S)', preferences: '偏好设置…', backToQueue: '返回下载队列', about: '关于 YTVDLT',
};

const EN: MenuLabels = {
  file: 'File(&F)', newDownload: 'New download', quit: 'Quit',
  edit: 'Edit(&E)', undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy',
  paste: 'Paste', selectAll: 'Select all',
  view: 'View(&V)', reload: 'Reload', forceReload: 'Force reload',
  actualSize: 'Actual size', zoomIn: 'Zoom in', zoomOut: 'Zoom out',
  fullscreen: 'Full screen', devTools: 'Developer tools',
  window: 'Window(&W)', minimize: 'Minimize', close: 'Close window',
  settings: 'Settings(&S)', preferences: 'Preferences…', backToQueue: 'Back to queue', about: 'About YTVDLT',
};

/**
 * 中/英应用菜单。顺序沿用 Windows 习惯：文件 / 编辑 / 视图 / 窗口。
 *
 * `&F` 之类的助记符只在 Windows/Linux 生效；macOS 上 Electron 会把首项当作
 * 应用名菜单，因此 macOS 走单独的裁剪分支（只保留编辑/视图/窗口）。
 */
export function buildAppMenu(context: AppMenuContext): readonly AppMenuItem[] {
  const isMac = (context.platform ?? 'win32') === 'darwin';
  const L: MenuLabels = context.locale === 'en' ? EN : ZH;

  const fileMenu: AppMenuItem = {
    label: L.file,
    submenu: [
      {
        label: L.newDownload,
        accelerator: 'CmdOrCtrl+N',
        click: () => { context.showWindow(); },
      },
      { type: 'separator' },
      { label: L.quit, accelerator: isMac ? 'Cmd+Q' : 'Alt+F4', click: () => { context.quit(); } },
    ],
  };

  const editMenu: AppMenuItem = {
    label: L.edit,
    submenu: [
      { label: L.undo, role: 'undo', accelerator: 'CmdOrCtrl+Z' },
      { label: L.redo, role: 'redo', accelerator: 'CmdOrCtrl+Y' },
      { type: 'separator' },
      { label: L.cut, role: 'cut', accelerator: 'CmdOrCtrl+X' },
      { label: L.copy, role: 'copy', accelerator: 'CmdOrCtrl+C' },
      { label: L.paste, role: 'paste', accelerator: 'CmdOrCtrl+V' },
      { label: L.selectAll, role: 'selectAll', accelerator: 'CmdOrCtrl+A' },
    ],
  };

  const viewMenu: AppMenuItem = {
    label: L.view,
    submenu: [
      { label: L.reload, role: 'reload', accelerator: 'CmdOrCtrl+R' },
      { label: L.forceReload, role: 'forceReload', accelerator: 'CmdOrCtrl+Shift+R' },
      { type: 'separator' },
      { label: L.actualSize, role: 'resetZoom', accelerator: 'CmdOrCtrl+0' },
      { label: L.zoomIn, role: 'zoomIn', accelerator: 'CmdOrCtrl+Plus' },
      { label: L.zoomOut, role: 'zoomOut', accelerator: 'CmdOrCtrl+-' },
      { type: 'separator' },
      { label: L.fullscreen, role: 'togglefullscreen', accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11' },
      { label: L.devTools, role: 'toggleDevTools', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I' },
    ],
  };

  const windowMenu: AppMenuItem = {
    label: L.window,
    submenu: [
      { label: L.minimize, role: 'minimize' },
      { label: L.close, role: 'close', accelerator: 'CmdOrCtrl+W' },
    ],
  };

  // D-91: 「设置」里放偏好设置、返回队列与关于；关于弹窗由渲染层提供，
  // 主进程只负责把菜单点击转过去（executeJavaScript），不新增 IPC 通道。
  const settingsMenu: AppMenuItem = {
    label: L.settings,
    submenu: [
      { label: L.preferences, accelerator: 'CmdOrCtrl+,', click: () => { context.openSettings?.(); } },
      { label: L.backToQueue, accelerator: 'CmdOrCtrl+1', click: () => { context.openQueue?.(); } },
      { type: 'separator' },
      { label: L.about, click: () => { context.openAbout?.(); } },
    ],
  };

  // macOS 的第一项必须是应用名菜单，否则「文件」会被顶到应用名位置。
  if (isMac) return [editMenu, viewMenu, windowMenu, settingsMenu];
  return [fileMenu, editMenu, viewMenu, windowMenu, settingsMenu];
}
