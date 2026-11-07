/**
 * M5-2 · keyboard shortcuts (A-4.1-02 / §6.8).
 *
 * Two things are verified here:
 *   1. the browser table (`packages/ui/src/shortcuts/shortcuts.js`) is byte-level
 *      in sync with the canonical core table — the UI is plain JS, so a parsed
 *      comparison is the only way to catch drift;
 *   2. the policy: Ctrl/Cmd mapping, the "never hijack editing keys" rule, the
 *      global prefill exception, conflict detection and `--url` deep links.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SHORTCUTS, parseAccelerator, isEditingTarget, matches, resolveShortcut,
  detectConflicts, editingSafeKeys, extractDeepLink, prefillIntent,
  type KeyEventLike, type ShortcutBinding, type ShortcutId,
} from '@ytvdlt/core';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Parse the browser mirror table out of the shipped plain-JS file. */
function uiTable(): ShortcutBinding[] {
  const source = readFileSync(`${ROOT}packages/ui/src/shortcuts/shortcuts.js`, 'utf8');
  const re = /\{\s*id:\s*'([^']+)',\s*accelerator:\s*'([^']+)',\s*scope:\s*'([^']+)',\s*editingSafe:\s*(true|false)\s*\}/g;
  const rows: ShortcutBinding[] = [];
  for (const match of source.matchAll(re)) {
    rows.push({
      id: match[1] as ShortcutId,
      accelerator: match[2] as string,
      scope: match[3] as 'app' | 'global',
      editingSafe: match[4] === 'true',
    });
  }
  return rows;
}

const none: KeyEventLike['target'] = null;
const input: KeyEventLike['target'] = { tagName: 'INPUT', isContentEditable: false };
const editable: KeyEventLike['target'] = { tagName: 'DIV', isContentEditable: true };

function event(partial: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, target: none, ...partial };
}

describe('shortcuts · canonical table', () => {
  it('ships all 11 documented accelerators (14 bindings incl. Ctrl+1..4)', () => {
    expect(DEFAULT_SHORTCUTS).toHaveLength(14);
    const accelerators = DEFAULT_SHORTCUTS.map((binding) => binding.accelerator);
    for (const expected of [
      'Ctrl+V', 'Ctrl+N', 'Ctrl+Enter', 'Ctrl+,', 'Ctrl+F', 'Ctrl+Shift+V',
      'Delete', 'Ctrl+R', 'Escape', 'F5', 'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4',
    ]) {
      expect(accelerators).toContain(expected);
    }
    expect(new Set(DEFAULT_SHORTCUTS.map((binding) => binding.id)).size).toBe(DEFAULT_SHORTCUTS.length);
  });

  it('has no conflicting accelerator', () => {
    expect(detectConflicts()).toEqual([]);
  });

  it('stays in sync with the browser mirror', () => {
    const ui = uiTable();
    expect(ui).toHaveLength(DEFAULT_SHORTCUTS.length);
    expect(ui).toEqual(DEFAULT_SHORTCUTS.map((binding) => ({ ...binding })));
  });

  it('marks exactly one global accelerator', () => {
    const global = DEFAULT_SHORTCUTS.filter((binding) => binding.scope === 'global');
    expect(global.map((binding) => binding.id)).toEqual(['global-prefill']);
  });
});

describe('shortcuts · accelerating parsing and matching', () => {
  it('parses modifiers and normalises key aliases', () => {
    expect(parseAccelerator('Ctrl+Shift+V')).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: 'v' });
    expect(parseAccelerator('CmdOrCtrl+Enter')).toEqual({ ctrl: true, shift: false, alt: false, meta: false, key: 'enter' });
    expect(parseAccelerator('Del').key).toBe('delete');
    expect(parseAccelerator('Esc').key).toBe('escape');
    expect(parseAccelerator('Ctrl+,').key).toBe(',');
  });

  it('matches Ctrl on Windows and Cmd on macOS', () => {
    expect(matches(event({ key: 'n', ctrlKey: true }), 'Ctrl+N', 'win32')).toBe(true);
    expect(matches(event({ key: 'n', metaKey: true }), 'Ctrl+N', 'darwin')).toBe(true);
    expect(matches(event({ key: 'n', ctrlKey: true }), 'Ctrl+N', 'darwin')).toBe(false);
    expect(matches(event({ key: 'n' }), 'Ctrl+N', 'win32')).toBe(false);
    expect(matches(event({ key: 'n', ctrlKey: true, shiftKey: true }), 'Ctrl+N', 'win32')).toBe(false);
  });

  it('resolves the documented bindings', () => {
    expect(resolveShortcut(event({ key: 'n', ctrlKey: true }))?.id).toBe('new-download');
    expect(resolveShortcut(event({ key: 'Enter', ctrlKey: true }))?.id).toBe('start');
    expect(resolveShortcut(event({ key: ',', ctrlKey: true }))?.id).toBe('settings');
    expect(resolveShortcut(event({ key: 'F5' }))?.id).toBe('refresh');
    expect(resolveShortcut(event({ key: 'Escape' }))?.id).toBe('close-dialog');
    expect(resolveShortcut(event({ key: '2', ctrlKey: true }))?.id).toBe('nav-2');
    expect(resolveShortcut(event({ key: 'z', ctrlKey: true }))).toBeNull();
  });
});

describe('shortcuts · input focus never hijacks editing keys', () => {
  it('detects editable targets', () => {
    expect(isEditingTarget(input)).toBe(true);
    expect(isEditingTarget({ tagName: 'textarea' })).toBe(true);
    expect(isEditingTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isEditingTarget(editable)).toBe(true);
    expect(isEditingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isEditingTarget(null)).toBe(false);
  });

  it('skips paste / search / delete / refresh while editing', () => {
    expect(resolveShortcut(event({ key: 'v', ctrlKey: true, target: input }))).toBeNull();
    expect(resolveShortcut(event({ key: 'f', ctrlKey: true, target: input }))).toBeNull();
    expect(resolveShortcut(event({ key: 'Delete', target: input }))).toBeNull();
    expect(resolveShortcut(event({ key: 'F5', target: input }))).toBeNull();
    // …but they still work when nothing is focused.
    expect(resolveShortcut(event({ key: 'v', ctrlKey: true }))?.id).toBe('paste-parse');
  });

  it('keeps the global prefill exception while editing', () => {
    const binding = resolveShortcut(event({ key: 'v', ctrlKey: true, shiftKey: true, target: input }));
    expect(binding?.id).toBe('global-prefill');
    expect(editingSafeKeys()).toContain('Ctrl+Shift+V');
  });
});

describe('shortcuts · --url deep link becomes a prefill intent', () => {
  it('accepts both --url=<link> and --url <link>', () => {
    expect(extractDeepLink(['electron.exe', '--url=https://example.org/v'])).toBe('https://example.org/v');
    expect(extractDeepLink(['--url', 'https://example.org/v'])).toBe('https://example.org/v');
    expect(extractDeepLink(['--url=file:///etc/passwd'])).toBeNull();
    expect(extractDeepLink(['--url'])).toBeNull();
    expect(extractDeepLink(['--other'])).toBeNull();
  });

  it('prefers argv over the hotkey and validates clipboard text', () => {
    expect(prefillIntent(['--url=https://a.test/v'], true, 'https://b.test/v'))
      .toEqual({ action: 'prefill', url: 'https://a.test/v', source: 'argv' });
    expect(prefillIntent([], true, '  https://b.test/v  '))
      .toEqual({ action: 'prefill', url: 'https://b.test/v', source: 'hotkey' });
    expect(prefillIntent([], true, 'ftp://b.test/v')).toBeNull();
    expect(prefillIntent([], false, 'https://b.test/v')).toBeNull();
  });
});
