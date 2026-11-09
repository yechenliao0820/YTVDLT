/**
 * D-109 · 下载列表里的失败简报（A-4.4-16 / A-4.4-21）。
 *
 * Executes the REAL `queue.js` + real `messages.js` + real `app-shell.js` through
 * the shared fake DOM. The point of these assertions is the CONTRACT of the new
 * element, not its pixels:
 *
 *   - it lives INSIDE the existing `.card-meta` row that carries the red
 *     `[data-state="Error"]` badge and the error code, to the RIGHT of them,
 *     and that whole row is ABOVE the progress bar;
 *   - it appears only for `Error`; canceled / queued / retrying / running never
 *     get one;
 *   - the text is one of five shipped sentences (never raw stderr / URL / path);
 *   - zh / en follow the page's existing locale mechanism.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  harness, cardTask, dto, onlyCard, failureBriefOf, metaRowOf, barOf,
  findAll, FakeNode,
} from './helpers/queue-page-harness.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const QUEUE_HTML = readFileSync(
  join(ROOT, 'packages', 'ui', 'src', 'pages', 'queue', 'index.html'), 'utf8',
);

const ZH = {
  network: '网络连接失败',
  service: '服务暂时不可用',
  forbidden: '无法访问该内容',
  save: '保存文件失败',
  unknown: '下载失败，请查看详情',
};
const EN = {
  network: 'Network connection failed',
  service: 'Service temporarily unavailable',
  forbidden: 'Unable to access this content',
  save: 'Unable to save the file',
  unknown: 'Download failed. See details',
};

const failed = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  cardTask({ state: 'Error', percent: 12, errorCode: 'HTTP_403', failureKind: 'forbidden', ...overrides });

/** Buttons on a card, by `data-action`. */
function actionsOf(card: FakeNode): string[] {
  return findAll(card, (n) => n.tagName === 'button')
    .map((button) => button.getAttribute('data-action') ?? '')
    .filter((action) => action !== '');
}

describe('D-109 · the brief is inside the red error row, above the progress bar', () => {
  it('renders to the RIGHT of the error code, in the same .card-meta row', () => {
    const card = onlyCard(harness({ items: [failed()] }));
    const brief = failureBriefOf(card);
    expect(brief).not.toBeNull();
    expect(brief?.textContent).toBe(ZH.forbidden);
    expect(brief?.getAttribute('data-failure-kind')).toBe('forbidden');

    const row = metaRowOf(card);
    expect(row.getAttribute('class')).toBe('card-meta');
    // The red failure info is still there, unchanged.
    const badge = findAll(row, (n) => n.className === 'badge')[0];
    expect(badge?.getAttribute('data-state')).toBe('Error');
    expect(row.textContent).toContain('HTTP_403');
    expect(row.textContent.indexOf('HTTP_403')).toBeLessThan(row.textContent.indexOf(ZH.forbidden));
    // ...and the brief is the LAST child of that row: right of badge + code.
    expect(row.children[row.children.length - 1]).toBe(brief);
    expect(row.children.indexOf(brief as FakeNode)).toBeGreaterThan(row.children.indexOf(badge as FakeNode));
  });

  it('sits ABOVE the progress bar and never replaces the technical details', () => {
    const card = onlyCard(harness({ items: [failed()] }));
    const main = findAll(card, (n) => n.className === 'card-main')[0] as FakeNode;
    const row = metaRowOf(card);
    const bar = barOf(card);
    expect(main.children.indexOf(row)).toBeLessThan(main.children.indexOf(bar));
    // "进度文字" / 错误代码 / 详情入口 / 操作按钮全部保留。
    expect(findAll(card, (n) => n.className === 'card-meta card-progress')).toHaveLength(1);
    expect(actionsOf(card)).toContain('detail');
    expect(actionsOf(card)).toContain('retry');
    expect(actionsOf(card)).toContain('remove');
    expect(card.textContent).toContain('HTTP_403');
    // The brief is an addition to the row — no new card-level container.
    expect(findAll(card, (n) => n.className === 'card-failure')).toHaveLength(1);
  });

  it('the shipped CSS wraps long copy without shifting the cards', () => {
    const metaRule = /\.card-meta\s*\{([^}]*)\}/.exec(QUEUE_HTML)?.[1] ?? '';
    const briefRule = /\.card-failure\s*\{([^}]*)\}/.exec(QUEUE_HTML)?.[1] ?? '';
    // Pure inline flow: no inline-block box (which would change the line box
    // baseline and push every card below it down), no absolute positioning.
    expect(briefRule).toContain('color: var(--ink)');
    expect(briefRule).toContain('font-weight: 700');
    expect(briefRule).not.toContain('display:');
    expect(briefRule).not.toContain('position:');
    expect(briefRule).not.toContain('white-space: nowrap');
    // The row owns the long-token fallback; normal short copy is unchanged.
    expect(metaRule).toContain('overflow-wrap: anywhere');
    expect(metaRule).toContain('font-size: 12px');
  });
});

describe('D-109 · only real failures get a brief', () => {
  it.each([
    ['Idle'], ['FetchingInfo'], ['ReadyWithInfo'], ['Running'], ['Canceled'], ['Completed'],
  ])('state %s shows no failure brief', (state) => {
    const card = onlyCard(harness({
      items: [cardTask({ state, errorCode: 'HTTP_403', failureKind: 'forbidden' })],
    }));
    expect(failureBriefOf(card)).toBeNull();
    expect(card.textContent).not.toContain('下载失败');
    expect(card.textContent).not.toContain(ZH.unknown);
  });

  it('a canceled task keeps its own badge and code, never "download failed"', () => {
    const card = onlyCard(harness({
      items: [cardTask({ state: 'Canceled', percent: 37, errorCode: 'UNKNOWN', failureKind: 'unknown' })],
    }));
    expect(metaRowOf(card).textContent).toContain('已取消');
    expect(failureBriefOf(card)).toBeNull();
    expect(actionsOf(card)).toContain('retry');
  });

  it('a task being retried (state back to ReadyWithInfo) drops the brief', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ live: true, items: [dto(failed())] });
      await h.settle();
      expect(failureBriefOf(onlyCard(h))?.textContent).toBe(ZH.forbidden);

      await h.setItems([dto({ state: 'ReadyWithInfo', percent: null, errorCode: null, failureKind: null })]);
      expect(failureBriefOf(onlyCard(h))).toBeNull();
      expect(onlyCard(h).getAttribute('data-progress-mode')).toBe('waiting');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('D-109 · reliable categories, honest fallback', () => {
  it.each([
    ['network', 'NETWORK_TIMEOUT', ZH.network],
    ['network', 'DNS_FAILURE', ZH.network],
    ['service', 'HTTP_429', ZH.service],
    ['forbidden', 'HTTP_403', ZH.forbidden],
    ['save', 'DISK_FULL', ZH.save],
    ['save', 'PERMISSION_DENIED', ZH.save],
    ['unknown', 'UNKNOWN', ZH.unknown],
    ['unknown', 'FORMAT_UNAVAILABLE', ZH.unknown],
    ['unknown', 'UNSUPPORTED_SITE', ZH.unknown],
  ])('%s / %s → %s', (kind, code, expected) => {
    const card = onlyCard(harness({ items: [failed({ failureKind: kind, errorCode: code })] }));
    expect(failureBriefOf(card)?.textContent).toBe(expected);
    expect(failureBriefOf(card)?.getAttribute('data-failure-kind')).toBe(kind);
  });

  it('a failed task with no usable bucket shows the generic brief', () => {
    for (const kind of [null, undefined, '', 'bogus', 'queue.failure.forbidden']) {
      const card = onlyCard(harness({ items: [failed({ failureKind: kind })] }));
      expect(failureBriefOf(card)?.textContent).toBe(ZH.unknown);
      expect(failureBriefOf(card)?.getAttribute('data-failure-kind')).toBe('unknown');
    }
  });

  it('a failed task with no error code at all still shows the generic brief', () => {
    const card = onlyCard(harness({ items: [failed({ errorCode: null, failureKind: null })] }));
    expect(failureBriefOf(card)?.textContent).toBe(ZH.unknown);
  });
});

describe('D-109 · the brief never leaks technical or sensitive data', () => {
  it('never echoes a URL, token, cookie, local path or raw yt-dlp output', () => {
    const secret = 'https://site.test/v?token=SECRET123&sig=abc';
    const card = onlyCard(harness({
      items: [failed({
        title: `C:\\Users\\leolee\\Downloads\\private [${secret}]`,
        uploader: 'Cookie: session=SECRET123',
        errorCode: 'C:\\Users\\leolee\\AppData\\SECRET123',
        failureKind: secret,
      })],
    }));
    const brief = failureBriefOf(card);
    expect(brief?.textContent).toBe(ZH.unknown);
    for (const marker of ['SECRET123', 'token=', 'Cookie', 'C:\\', 'https://', 'site.test']) {
      expect(brief?.textContent ?? '').not.toContain(marker);
    }
    expect(brief?.getAttribute('data-failure-kind')).toBe('unknown');
    // The brief is always one of the five fixed sentences — never free text.
    expect(Object.values(ZH)).toContain(brief?.textContent);
  });

  it('keeps the original error code and the detail / retry / log entry', () => {
    const card = onlyCard(harness({ items: [failed({ errorCode: 'PERMISSION_DENIED' })] }));
    expect(metaRowOf(card).textContent).toContain('PERMISSION_DENIED');
    expect(actionsOf(card)).toContain('detail');
    expect(actionsOf(card)).toContain('retry');
    expect(failureBriefOf(card)?.textContent).toBe(ZH.forbidden);
  });
});

describe('D-109 · bilingual copy follows the existing locale mechanism', () => {
  it.each(Object.entries(ZH))('zh-CN %s', (kind, zh) => {
    const card = onlyCard(harness({ items: [failed({ failureKind: kind })] }));
    expect(failureBriefOf(card)?.textContent).toBe(zh);
  });

  it.each(Object.entries(EN))('en %s', (kind, en) => {
    const card = onlyCard(harness({ lang: 'en', items: [failed({ failureKind: kind })] }));
    expect(failureBriefOf(card)?.textContent).toBe(en);
  });

  it('language switch reloads the page (existing pattern) and the new page paints English', async () => {
    vi.useFakeTimers();
    try {
      const first = harness({
        live: true, withLanguageButtons: true, items: [dto(failed())],
      });
      await first.settle();
      expect(failureBriefOf(onlyCard(first))?.textContent).toBe(ZH.forbidden);

      // The real button stores the choice, persists it and reloads with ?lang=en.
      first.clickLanguage('en');
      expect(first.storage.get('ytvdlt.locale')).toBe('en');
      expect(first.calls.some((c) => c.channel === 'ytvdlt:settings:set'
        && (c.payload as { language?: string }).language === 'en')).toBe(true);
      expect(first.replacedUrl()).toContain('lang=en');

      // A fresh page load resolves the catalogue in the new language.
      const reloaded = harness({
        live: true, storedLocale: 'en', withLanguageButtons: true, items: [dto(failed())],
      });
      await reloaded.settle();
      expect(failureBriefOf(onlyCard(reloaded))?.textContent).toBe(EN.forbidden);

      // Switching back removes ?lang= and returns to Chinese on the next load.
      reloaded.clickLanguage('zh-CN');
      expect(reloaded.storage.get('ytvdlt.locale')).toBe('zh-CN');
      expect(reloaded.replacedUrl()).not.toContain('lang=');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('D-109 · long copy and narrow cards keep the structure intact', () => {
  const longTitle = '一个非常非常非常长的中文视频标题'.repeat(8);
  const longEn = 'A very very very long English video title '.repeat(6);

  it.each([
    ['long Chinese title', longTitle, 'HTTP_429'],
    ['long English title', longEn, 'NETWORK_TIMEOUT'],
    ['long error code', 'X'.repeat(180), 'ARTIFACT_INCOMPLETE'],
  ])('%s does not add, move or duplicate the brief', (_label, title, code) => {
    const card = onlyCard(harness({
      items: [failed({ title, errorCode: code, failureKind: 'service' })],
    }));
    expect(findAll(card, (n) => n.className === 'card-failure')).toHaveLength(1);
    const row = metaRowOf(card);
    expect(row.children[row.children.length - 1]).toBe(failureBriefOf(card));
    expect(failureBriefOf(card)?.textContent).toBe(ZH.service);
    // title, badge, bar, progress line and buttons are all still in one card.
    expect(findAll(card, (n) => n.className === 'card-title')).toHaveLength(1);
    expect(findAll(card, (n) => n.className === 'bar')).toHaveLength(1);
    expect(findAll(card, (n) => n.className === 'card-meta card-progress')).toHaveLength(1);
    expect(actionsOf(card)).toContain('detail');
  });

  it('the raw brief never grows with the error text (CSS truncates it)', () => {
    const card = onlyCard(harness({
      items: [failed({ title: longEn, errorCode: 'Y'.repeat(400), failureKind: 'unknown' })],
    }));
    const brief = failureBriefOf(card);
    expect(brief?.textContent).toHaveLength(ZH.unknown.length);
    expect(brief?.textContent).toBe(ZH.unknown);
  });
});
