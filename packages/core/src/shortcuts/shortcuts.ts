/**
 * Shortcut policy (M5-2, §6.8) — the canonical table + matching rules.
 *
 * `packages/ui/src/shortcuts/shortcuts.js` is the browser mirror; a unit test
 * parses that file and fails if the two tables diverge (no silent drift).
 *
 * Rules:
 *   - `Ctrl` means `Cmd` on macOS (`CmdOrCtrl` in Electron terms);
 *   - "输入框聚焦时不劫持编辑键": paste / search / delete / refresh are skipped
 *     while a text field, textarea, select or contenteditable has focus;
 *   - `Ctrl+Shift+V` is a GLOBAL accelerator: it must fire while editing,
 *     because its purpose is to prefill the paste box from the clipboard;
 *   - `--url=<link>` deep links prefill the same box on cold start (A-4.1-02).
 */
export type ShortcutId =
  | 'paste-parse' | 'new-download' | 'start' | 'settings' | 'search'
  | 'global-prefill' | 'cancel-selected' | 'retry' | 'close-dialog' | 'refresh'
  | 'nav-1' | 'nav-2' | 'nav-3' | 'nav-4';

export interface ShortcutBinding {
  readonly id: ShortcutId;
  readonly accelerator: string;
  readonly scope: 'app' | 'global';
  /** true = still fires while a text field has focus. */
  readonly editingSafe: boolean;
}

export const DEFAULT_SHORTCUTS: readonly ShortcutBinding[] = [
  { id: 'paste-parse', accelerator: 'Ctrl+V', scope: 'app', editingSafe: false },
  { id: 'new-download', accelerator: 'Ctrl+N', scope: 'app', editingSafe: true },
  { id: 'start', accelerator: 'Ctrl+Enter', scope: 'app', editingSafe: true },
  { id: 'settings', accelerator: 'Ctrl+,', scope: 'app', editingSafe: true },
  { id: 'search', accelerator: 'Ctrl+F', scope: 'app', editingSafe: false },
  { id: 'global-prefill', accelerator: 'Ctrl+Shift+V', scope: 'global', editingSafe: true },
  { id: 'cancel-selected', accelerator: 'Delete', scope: 'app', editingSafe: false },
  { id: 'retry', accelerator: 'Ctrl+R', scope: 'app', editingSafe: true },
  { id: 'close-dialog', accelerator: 'Escape', scope: 'app', editingSafe: true },
  { id: 'refresh', accelerator: 'F5', scope: 'app', editingSafe: false },
  { id: 'nav-1', accelerator: 'Ctrl+1', scope: 'app', editingSafe: true },
  { id: 'nav-2', accelerator: 'Ctrl+2', scope: 'app', editingSafe: true },
  { id: 'nav-3', accelerator: 'Ctrl+3', scope: 'app', editingSafe: true },
  { id: 'nav-4', accelerator: 'Ctrl+4', scope: 'app', editingSafe: true },
];

export interface Accelerator {
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
  readonly key: string;
}

export interface KeyEventLike {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly target?: { readonly tagName?: string; readonly isContentEditable?: boolean } | null;
}

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** `Ctrl+Shift+V` -> a comparable combo (`CmdOrCtrl` = `Ctrl`). */
export function parseAccelerator(accelerator: string): Accelerator {
  const combo = { ctrl: false, shift: false, alt: false, meta: false, key: '' };
  const parts = String(accelerator).split('+').map((part) => part.trim().toLowerCase());
  let key = '';
  for (const part of parts) {
    if (part === 'ctrl' || part === 'cmdorctrl' || part === 'commandorcontrol') combo.ctrl = true;
    else if (part === 'shift') combo.shift = true;
    else if (part === 'alt' || part === 'option') combo.alt = true;
    else if (part === 'meta' || part === 'cmd' || part === 'command') combo.meta = true;
    else if (part.length > 0) key = part;
  }
  return {
    ctrl: combo.ctrl, shift: combo.shift, alt: combo.alt, meta: combo.meta,
    key: key === 'del' ? 'delete' : key === 'esc' ? 'escape' : key,
  };
}

export function isEditingTarget(target: KeyEventLike['target']): boolean {
  if (target === null || target === undefined) return false;
  if (target.isContentEditable === true) return true;
  return typeof target.tagName === 'string' && EDITABLE_TAGS.has(target.tagName.toUpperCase());
}

function eventKey(event: KeyEventLike): string {
  const key = String(event.key ?? '').toLowerCase();
  if (key === 'del') return 'delete';
  if (key === 'esc') return 'escape';
  return key;
}

export function matches(event: KeyEventLike, accelerator: string, platform = 'win32'): boolean {
  const combo = parseAccelerator(accelerator);
  const metaPlatform = platform === 'darwin';
  const ctrlExpected = combo.ctrl || (combo.meta && metaPlatform);
  const ctrlSeen = metaPlatform ? event.metaKey === true : event.ctrlKey === true;
  if (ctrlExpected !== ctrlSeen) return false;
  if (combo.meta && !metaPlatform) return false;
  if (combo.shift !== (event.shiftKey === true)) return false;
  if (combo.alt !== (event.altKey === true)) return false;
  return eventKey(event) === combo.key;
}

/** First matching binding wins; the editing guard is applied before the match. */
export function resolveShortcut(
  event: KeyEventLike,
  platform = 'win32',
  bindings: readonly ShortcutBinding[] = DEFAULT_SHORTCUTS,
): ShortcutBinding | null {
  const editing = isEditingTarget(event.target);
  for (const binding of bindings) {
    if (!matches(event, binding.accelerator, platform)) continue;
    if (editing && !binding.editingSafe) continue;
    return binding;
  }
  return null;
}

/** Two bindings on the same accelerator would make dispatch order-dependent. */
export function detectConflicts(
  bindings: readonly ShortcutBinding[] = DEFAULT_SHORTCUTS,
): readonly { readonly accelerator: string; readonly ids: readonly ShortcutId[] }[] {
  const byAccelerator = new Map<string, ShortcutId[]>();
  for (const binding of bindings) {
    const key = binding.accelerator.toLowerCase();
    const list = byAccelerator.get(key) ?? [];
    list.push(binding.id);
    byAccelerator.set(key, list);
  }
  return [...byAccelerator.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([accelerator, ids]) => ({ accelerator, ids }));
}

/** Keys that must NOT be swallowed while the user is editing text. */
export function editingSafeKeys(): readonly string[] {
  return DEFAULT_SHORTCUTS.filter((binding) => binding.editingSafe).map((binding) => binding.accelerator);
}

export interface DeepLinkIntent {
  readonly action: 'prefill';
  readonly url: string;
  readonly source: 'argv' | 'hotkey';
}

const HTTP_RE = /^https?:\/\/[^\s]+$/i;

/** `--url=<link>` / `--url <link>` -> prefill intent; non-http(s) is ignored. */
export function extractDeepLink(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg.startsWith('--url=')) {
      const value = arg.slice('--url='.length);
      return HTTP_RE.test(value) ? value : null;
    }
    if (arg === '--url') {
      const next = argv[index + 1];
      if (next === undefined) return null;
      const value = String(next);
      return HTTP_RE.test(value) ? value : null;
    }
  }
  return null;
}

/**
 * Cold start with `--url` and the `Ctrl+Shift+V` hotkey both funnel into the
 * same intent so the renderer only implements one path (A-4.1-02).
 */
export function prefillIntent(
  argv: readonly string[],
  hotkeyPressed: boolean,
  clipboardText?: string,
): DeepLinkIntent | null {
  const fromArgv = extractDeepLink(argv);
  if (fromArgv !== null) return { action: 'prefill', url: fromArgv, source: 'argv' };
  if (!hotkeyPressed) return null;
  const text = String(clipboardText ?? '').trim();
  if (!HTTP_RE.test(text)) return null;
  return { action: 'prefill', url: text, source: 'hotkey' };
}
