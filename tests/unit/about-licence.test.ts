/**
 * D-121 · the Settings > About licence pane must be factually correct.
 *
 * Three invariants, all of which the old copy violated:
 *  1. The embedded English licence is a VERBATIM copy of the repository
 *     LICENSE's English part — not a paraphrase, not a link to a file that
 *     only lists third-party notices.
 *  2. "This software" and "bundled components" are stated separately, with
 *     every component's own licence named.
 *  3. The software is NOT called open source / MIT: the license explicitly
 *     says source-available, non-commercial.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const license = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
const settingsHtml = readFileSync(join(ROOT, 'packages', 'ui', 'src', 'pages', 'settings', 'index.html'), 'utf8');
const aboutJs = readFileSync(join(ROOT, 'packages', 'ui', 'src', 'about', 'about.js'), 'utf8');
const messagesJs = readFileSync(join(ROOT, 'packages', 'ui', 'src', 'i18n', 'messages.js'), 'utf8');

/** The LICENSE is: preamble --- English --- Chinese --- notes. */
function englishPart(): string {
  const parts = license.split('\n---\n');
  if (parts.length < 3) throw new Error('LICENSE no longer has the expected bilingual structure');
  return `${parts[0]}\n---\n${parts[1]}`.trim();
}

function embeddedText(): string {
  const match = /<pre id="about-licence-text">([\s\S]*?)<\/pre>/.exec(settingsHtml);
  if (match === null) throw new Error('no embedded English licence in Settings > About');
  return (match[1] ?? '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .trim();
}

function catalogue(): Record<string, Record<string, string>> {
  const sandbox: Record<string, any> = {};
  // eslint-disable-next-line no-new-func
  new Function('window', messagesJs)(sandbox);
  return sandbox['YTVDLT_I18N'].MESSAGES;
}

describe('D-121 · verbatim English licence in Settings > About', () => {
  it('is byte-for-byte the English part of the repository LICENSE', () => {
    expect(embeddedText()).toBe(englishPart());
  });

  it('carries the title, copyright, preamble and all six clauses', () => {
    const text = embeddedText();
    expect(text.startsWith('YTVDLT Non-Commercial License 1.0')).toBe(true);
    expect(text).toContain('Copyright (c) 2026 LeoLee. All rights reserved.');
    expect(text).toContain('the Simplified Chinese text prevails');
    for (const clause of [
      '### 1. Grant of Rights', '### 2. Prohibited Conduct', '### 3. Commercial Licensing',
      '### 4. Termination', '### 5. Disclaimer of Warranty', '### 6. Third-Party Components',
    ]) expect(text).toContain(clause);
    expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    expect(text).toContain('does not alter those terms');
  });

  it('does NOT include the Chinese text or the author notes (English only)', () => {
    const text = embeddedText();
    expect(text).not.toContain('## 简体中文');
    expect(text).not.toContain('这不是 MIT');
    expect(text).not.toContain('## Notes (not part of the license terms)');
  });

  it('is inside a collapsed, scrollable block so the pane keeps its layout', () => {
    expect(settingsHtml).toContain('<details class="about-licence-full" id="about-licence-full">');
    expect(settingsHtml).not.toContain('<details class="about-licence-full" id="about-licence-full" open');
    expect(settingsHtml).toContain('white-space: pre-wrap');
    expect(settingsHtml).toContain('max-height: 320px');
  });
});

describe('D-121 · own licence vs. each component licence', () => {
  it('names the software licence explicitly and separately', () => {
    expect(settingsHtml).toContain('data-i18n="about.license.own"');
    expect(settingsHtml).toContain('YTVDLT Non-Commercial License 1.0');
    expect(settingsHtml).toContain('about-licence-row own');
  });

  it('lists all five bundled components with their own licences', () => {
    for (const [component, licence] of [
      ['yt-dlp', 'Unlicense'],
      ['FFmpeg / ffprobe', 'LGPL-3.0'],
      ['aria2c', 'GPL-2.0-or-later'],
      ['Electron', 'MIT'],
      ['Node.js', 'MIT'],
    ] as const) {
      expect(settingsHtml).toContain(`<span>${component}</span><span class="lic-id">${licence}</span>`);
    }
  });

  it('points to the real third-party notice file, not a made-up target', () => {
    expect(settingsHtml).toContain('docs/THIRD_PARTY_NOTICES.md');
    expect(readFileSync(join(ROOT, 'docs', 'THIRD_PARTY_NOTICES.md'), 'utf8')).toContain('GPL-2.0-or-later');
  });

  it('never calls this software open source or MIT', () => {
    const messages = catalogue();
    expect(messages['zh-CN']?.['about.license.title']).not.toMatch(/开源/);
    expect(messages['en']?.['about.license.title']).not.toMatch(/open source/i);
    expect(messages['zh-CN']?.['about.license.ownNote']).toContain('不是 OSI 开源');
    expect(messages['en']?.['about.license.ownNote']).toContain('not MIT');
  });
});

describe('D-121 · bilingual completeness', () => {
  const keys = [
    'about.license.title', 'about.license.body',
    'about.license.col.component', 'about.license.col.licence', 'about.license.col.use',
    'about.license.own', 'about.license.ownNote',
    'about.license.use.ytdlp', 'about.license.use.ffmpeg', 'about.license.use.aria2c',
    'about.license.use.electron', 'about.license.use.node',
    'about.license.full', 'about.license.fullHint', 'about.license.thirdParty',
    'about.license.fullWhere',
  ];

  it('every new key exists, is non-empty and is actually translated in both locales', () => {
    const messages = catalogue();
    for (const key of keys) {
      const zh = messages['zh-CN']?.[key];
      const en = messages['en']?.[key];
      expect(typeof zh, key).toBe('string');
      expect(typeof en, key).toBe('string');
      expect((zh ?? '').length, key).toBeGreaterThan(0);
      expect((en ?? '').length, key).toBeGreaterThan(0);
      expect(zh, key).not.toBe(en);
    }
  });

  it('every data-i18n key in the About pane resolves in both catalogues', () => {
    const messages = catalogue();
    const section = settingsHtml.slice(settingsHtml.indexOf('id="section-about"'));
    const keys = [...section.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1] ?? '');
    expect(keys.length).toBeGreaterThan(8);
    for (const key of keys) {
      expect(typeof messages['zh-CN']?.[key], `zh:${key}`).toBe('string');
      expect(typeof messages['en']?.[key], `en:${key}`).toBe('string');
    }
  });

  it('the compact About dialog points to the full text instead of duplicating it', () => {
    expect(aboutJs).toContain("t('about.license.fullWhere')");
    expect(aboutJs).not.toContain('about-licence-text');
  });
});
