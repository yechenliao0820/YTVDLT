/**
 * Tray model (M4-6) — pure menu/state logic, no `electron` import.
 *
 * `index.ts` / the future window bootstrap turns these descriptors into a real
 * `Tray`; keeping the decision logic here makes it testable without a binary
 * (D-39: no Electron dist in this offline environment).
 */
export interface TrayStats {
  /** Tasks occupying a slot (probe or transfer). */
  readonly active: number;
  /** Tasks waiting for a slot. */
  readonly pending: number;
  /** Tasks settled successfully in this session. */
  readonly completed: number;
  /** Tasks in `Error`. */
  readonly failed: number;
}

export interface TrayMenuItem {
  readonly id: 'show' | 'new-download' | 'cancel-all' | 'open-folder' | 'quit' | 'separator';
  readonly label: string;
  readonly enabled: boolean;
  readonly type: 'normal' | 'separator';
}

/** Menu is rebuilt on every stats change; disabled entries explain themselves. */
export function buildTrayMenu(stats: TrayStats): readonly TrayMenuItem[] {
  return [
    { id: 'show', label: '显示主窗口', enabled: true, type: 'normal' },
    { id: 'new-download', label: '新建下载…', enabled: true, type: 'normal' },
    { id: 'separator', label: '', enabled: false, type: 'separator' },
    { id: 'cancel-all', label: `取消全部（${stats.active + stats.pending}）`, enabled: stats.active + stats.pending > 0, type: 'normal' },
    { id: 'open-folder', label: '打开下载目录', enabled: true, type: 'normal' },
    { id: 'separator', label: '', enabled: false, type: 'separator' },
    { id: 'quit', label: '退出', enabled: true, type: 'normal' },
  ];
}

export function trayTooltip(stats: TrayStats): string {
  if (stats.active === 0 && stats.pending === 0) return 'YTVDLT · 空闲';
  const parts = [`运行 ${stats.active}`];
  if (stats.pending > 0) parts.push(`排队 ${stats.pending}`);
  return `YTVDLT · ${parts.join(' · ')}`;
}

export interface CloseIntent {
  readonly action: 'close' | 'minimize';
  readonly minimizeToTray: boolean;
  readonly active: number;
}

/**
 * "关窗最小化" policy: with the setting on, both close and minimize hide the
 * window; with it off, close really quits (minimize behaves natively).
 */
export function shouldHideToTray(intent: CloseIntent): boolean {
  if (!intent.minimizeToTray) return false;
  return intent.action === 'close' || intent.action === 'minimize';
}

/** Quit is only allowed when nothing is running (otherwise ask first). */
export function canQuit(stats: TrayStats): boolean {
  return stats.active === 0;
}
