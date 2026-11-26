import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * D-287 · “本版更新内容”: the notes bundled with the running build.
 *
 * Two independent surfaces are pinned here:
 *   1. `release-notes.js` — the data module (version lookup + both languages);
 *   2. the settings-page block that renders it — a repeated click must toggle
 *      the panel, never consume the notes once and lose them.
 */
const moduleSource = readFileSync('packages/ui/src/pages/settings/release-notes.js', 'utf8');
const pageSource = readFileSync('packages/ui/src/pages/settings/settings.js', 'utf8');

function loadBook(): any {
  const sandbox: Record<string, unknown> = {};
  runInNewContext(moduleSource, sandbox);
  return sandbox['YTVDLTReleaseNotes'];
}

function makeNode(id: string, hidden = 'true') {
  return {
    id,
    textContent: '',
    attributes: { hidden } as Record<string, string>,
    listeners: {} as Record<string, () => void>,
    setAttribute(key: string, value: string) { this.attributes[key] = value; },
    getAttribute(key: string) { return this.attributes[key]; },
    addEventListener(event: string, callback: () => void) { this.listeners[event] = callback; },
  };
}

function harness(options: {
  entry: { version: string; date: string; zh: string; en: string } | null;
  locale?: 'zh-CN' | 'en';
  label?: string;
}) {
  const nodes = new Map<string, ReturnType<typeof makeNode>>([
    ['settings-app-whatsnew', makeNode('settings-app-whatsnew')],
    ['settings-release-notes', makeNode('settings-release-notes')],
    ['settings-release-notes-head', makeNode('settings-release-notes-head')],
    ['settings-release-notes-body', makeNode('settings-release-notes-body')],
  ]);
  const doc = { getElementById: (id: string) => nodes.get(id) ?? null };
  const context: Record<string, unknown> = {
    doc,
    t: (key: string) => key,
    THEME_STATE: { locale: options.locale ?? 'zh-CN' },
    global: {
      document: doc,
      YTVDLTAppVersion: { label: () => options.label ?? 'v0.3.3' },
      YTVDLTReleaseNotes: { forVersion: () => options.entry },
    },
  };
  const start = pageSource.indexOf('    // D-287: "本版更新内容"');
  const end = pageSource.indexOf('    // The persisted values are the truth', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  runInNewContext(pageSource.slice(start, end), context);
  return {
    node: (id: string) => nodes.get(id)!,
    click: () => nodes.get('settings-app-whatsnew')!.listeners['click']?.(),
  };
}

const ENTRY = {
  version: '0.3.3',
  date: '2026-11-26',
  zh: '中文说明正文',
  en: 'English notes body',
};

describe('D-287 · bundled release notes data', () => {
  it('resolves the shipped version with or without a leading v', () => {
    const book = loadBook();
    expect(book).toBeDefined();
    expect(book.forVersion('0.3.3')).toBeTruthy();
    expect(book.forVersion('v0.3.3')).toBe(book.forVersion('0.3.3'));
    expect(book.forVersion('0.3.2')).toBeNull();
    expect(book.forVersion('')).toBeNull();
    expect(book.versions()).toContain('0.3.3');
  });

  it('carries both languages and a date for every entry', () => {
    for (const version of loadBook().versions() as string[]) {
      const entry = loadBook().forVersion(version);
      expect(entry.zh.length).toBeGreaterThan(80);
      expect(entry.en.length).toBeGreaterThan(80);
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('D-287 · settings page renders the notes repeatedly', () => {
  it('opens with the head/body for the running version, then closes on a second click', () => {
    const h = harness({ entry: ENTRY });
    h.click();
    expect(h.node('settings-release-notes').getAttribute('hidden')).toBe('false');
    expect(h.node('settings-app-whatsnew').getAttribute('aria-expanded')).toBe('true');
    expect(h.node('settings-release-notes-head').textContent).toBe('0.3.3 · 2026-11-26');
    expect(h.node('settings-release-notes-body').textContent).toBe(ENTRY.zh);

    // Closing hides the panel but never clears the text: reopening is the point.
    h.click();
    expect(h.node('settings-release-notes').getAttribute('hidden')).toBe('true');
    expect(h.node('settings-app-whatsnew').getAttribute('aria-expanded')).toBe('false');
    h.click();
    expect(h.node('settings-release-notes').getAttribute('hidden')).toBe('false');
    expect(h.node('settings-release-notes-body').textContent).toBe(ENTRY.zh);
  });

  it('follows the active language', () => {
    const h = harness({ entry: ENTRY, locale: 'en' });
    h.click();
    expect(h.node('settings-release-notes-body').textContent).toBe(ENTRY.en);
  });

  it('stays honest when this build carries no notes for the version', () => {
    const h = harness({ entry: null, label: 'v9.9.9' });
    h.click();
    expect(h.node('settings-release-notes').getAttribute('hidden')).toBe('false');
    expect(h.node('settings-release-notes-body').textContent).toBe('settings.app.notesEmpty');
  });
});
