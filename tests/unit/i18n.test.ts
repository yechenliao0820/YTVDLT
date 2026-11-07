/**
 * M5-2 · i18n (A-4.4-21).
 *
 * The catalogue is a browser script (`packages/ui/src/i18n/messages.js`), so the
 * test executes the REAL shipped file in a sandbox and audits it:
 *   - every key the app requires exists in zh-CN AND en;
 *   - `{placeholder}` names are identical across locales (a mismatch would
 *     render a literal "{n}" in one language);
 *   - every `data-i18n` key used by a page exists in the catalogue;
 *   - the legacy phrase table has no empty / duplicated source string.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOCALES, DEFAULT_LOCALE, TASK_STATES, NOTIFICATION_KINDS,
  normalizeLocale, localeLabel, stateKey, notificationKeys,
  requiredKeys, missingKeys, interpolate, placeholdersOf, isLocaleDependentValue,
} from '@ytvdlt/core';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const UI_SRC = join(ROOT, 'packages', 'ui', 'src');

interface Catalogue {
  LOCALES: readonly string[];
  DEFAULT_LOCALE: string;
  MESSAGES: Record<string, Record<string, string>>;
  PHRASES: Record<string, string>;
}

/** Execute the shipped browser script with a fake `window`. */
function loadCatalogue(): Catalogue {
  const source = readFileSync(join(UI_SRC, 'i18n', 'messages.js'), 'utf8');
  const sandbox: Record<string, unknown> = {};
  // eslint-disable-next-line no-new-func
  new Function('window', source)(sandbox);
  return sandbox['YTVDLT_I18N'] as Catalogue;
}

function walkHtml(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkHtml(full));
    else if (entry.endsWith('.html')) out.push(full);
  }
  return out;
}

/** Every `data-i18n*` key referenced by the markup. */
function referencedKeys(): readonly string[] {
  const keys = new Set<string>();
  for (const file of walkHtml(UI_SRC)) {
    const html = readFileSync(file, 'utf8');
    for (const match of html.matchAll(/data-i18n(?:-placeholder|-aria-label|-title)?="([^"]+)"/g)) {
      if (match[1] !== undefined) keys.add(match[1]);
    }
  }
  return [...keys].sort();
}

const catalogue = loadCatalogue();

describe('i18n · locale normalisation', () => {
  it('maps messy OS locales onto the two shipped locales', () => {
    expect(LOCALES).toEqual(['zh-CN', 'en']);
    expect(DEFAULT_LOCALE).toBe('zh-CN');
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('EN_us')).toBe('en');
    expect(normalizeLocale('en')).toBe('en');
    expect(normalizeLocale('zh-Hans-CN')).toBe('zh-CN');
    expect(normalizeLocale('zh')).toBe('zh-CN');
    expect(normalizeLocale('fr-FR')).toBe('zh-CN');
    expect(normalizeLocale(undefined)).toBe('zh-CN');
    expect(localeLabel('en')).toBe('English');
    expect(localeLabel('zh-CN')).toBe('简体中文');
  });

  it('derives state / notification keys from the state machine, not a hand list', () => {
    expect(stateKey('Running')).toBe('task.state.Running');
    expect(TASK_STATES).toContain('ReadyWithInfo');
    expect(notificationKeys('progress')).toEqual({
      titleKey: 'notification.progress.title',
      bodyKey: 'notification.progress.body',
    });
    expect(NOTIFICATION_KINDS).toHaveLength(4);
  });
});

describe('i18n · shipped catalogue is complete', () => {
  it('ships both locales with identical key sets', () => {
    const zh = Object.keys(catalogue.MESSAGES['zh-CN'] ?? {}).sort();
    const en = Object.keys(catalogue.MESSAGES['en'] ?? {}).sort();
    expect(zh.length).toBeGreaterThan(80);
    expect(en).toEqual(zh);
  });

  it.each(LOCALES)('covers every required key (%s)', (locale) => {
    const available = Object.keys(catalogue.MESSAGES[locale] ?? {});
    expect(missingKeys(available)).toEqual([]);
  });

  it('keeps {placeholders} identical across locales', () => {
    const zh = catalogue.MESSAGES['zh-CN'] ?? {};
    const en = catalogue.MESSAGES['en'] ?? {};
    const mismatched: string[] = [];
    for (const [key, value] of Object.entries(zh)) {
      const english = en[key];
      if (english === undefined) continue;
      if (placeholdersOf(value).join(',') !== placeholdersOf(english).join(',')) mismatched.push(key);
    }
    expect(mismatched).toEqual([]);
  });

  it('never ships an empty translation', () => {
    const empty: string[] = [];
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(catalogue.MESSAGES[locale] ?? {})) {
        if (value.trim().length === 0) empty.push(`${locale}:${key}`);
      }
    }
    expect(empty).toEqual([]);
  });

  it('covers every key referenced by the markup', () => {
    const keys = referencedKeys();
    expect(keys.length).toBeGreaterThan(20);
    const missing = keys.filter((key) => catalogue.MESSAGES['zh-CN']?.[key] === undefined
      || catalogue.MESSAGES['en']?.[key] === undefined);
    expect(missing).toEqual([]);
  });

  it('has a non-empty legacy phrase table for the frozen dialogs', () => {
    const phrases = Object.entries(catalogue.PHRASES ?? {});
    expect(phrases.length).toBeGreaterThan(50);
    expect(phrases.filter(([zh, en]) => zh.trim().length === 0 || en.trim().length === 0)).toEqual([]);
    // Duplicate source strings would silently shadow each other in the object.
    const sources = phrases.map(([zh]) => zh);
    expect(new Set(sources).size).toBe(sources.length);
    expect(catalogue.PHRASES['格式选择']).toBe('Format selection');
  });
});

describe('i18n · interpolation', () => {
  it('replaces known placeholders and keeps unknown ones', () => {
    expect(interpolate('{n} 项', { n: 3 })).toBe('3 项');
    expect(interpolate('{a}-{b}', { a: 'x', b: 2 })).toBe('x-2');
    expect(interpolate('{a}-{b}', { a: 'x' })).toBe('x-{b}');
    expect(interpolate('plain')).toBe('plain');
    expect(placeholdersOf('{percent}% · {speed}')).toEqual(['percent', 'speed']);
    expect(placeholdersOf('no placeholders')).toEqual([]);
  });

  it('flags non-ASCII values where the caller expects a machine value', () => {
    expect(isLocaleDependentValue('简体中文')).toBe(true);
    expect(isLocaleDependentValue('English')).toBe(false);
    expect(isLocaleDependentValue('en')).toBe(false);
    expect(isLocaleDependentValue('https://example.org/v')).toBe(false);
  });
});
