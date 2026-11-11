/**
 * TASK-03 A (D-134) — the "supported sites" panel, run as the REAL shipped
 * script against a fake DOM.
 *
 * WHAT THIS SUITE IS GUARDING
 *
 *   1. There is NO hardcoded site list anywhere in the shipped file. That is the
 *      whole point of the feature: a shipped list goes stale silently and looks
 *      exactly like a correct one. The first test reads the source and fails if
 *      a site name or a fallback array ever appears.
 *
 *   2. A failure is NEVER rendered as an empty list. "Could not ask the engine"
 *      and "the engine supports nothing" must not look the same on screen, so
 *      each failure code maps to its own sentence and the controls go disabled.
 *
 *   3. The GenericIE note appears ONLY when the engine actually reports
 *      `generic`. A note about a row that is not in the list is noise.
 *
 *   4. The panel asks the engine exactly, with no renderer-chosen parameters —
 *      no path, no version, no argv. `refresh` is the only key it may send.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sitesHarness, catalogDto, row, findAll, panelEntry } from './helpers/supported-sites-harness.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE = join(ROOT, 'packages', 'ui', 'src', 'sites', 'supported-sites.js');

async function opened(h = sitesHarness({ mount: true })) {
  panelEntry(h).fire('click', { preventDefault() {} });
  await h.settle();
  return h;
}

describe('TASK-03 A · the panel ships no site list of its own', () => {
  it('names no extractor and holds no fallback array', () => {
    const text = readFileSync(SOURCE, 'utf8');
    // Any of these appearing as content would mean a shipped, staleable list.
    for (const site of ['youtube', 'vimeo', 'twitter', 'bilibili', 'zdf', 'viki', 'dailymotion']) {
      expect(text.toLowerCase()).not.toContain(site);
    }
    // No literal array of names either (the only arrays here are UI key pairs).
    expect(text).not.toMatch(/=\s*\[\s*['"][A-Za-z0-9_.-]+['"]\s*,/);
  });

  it('says so from the engine on failure instead of inventing rows', async () => {
    const h = await opened(sitesHarness({
      mount: true,
      reply: { ok: false, code: 'ENGINE_FAILED', rows: [], engineVersion: '', siteCount: 0, subExtractorCount: 0, brokenCount: 0, hasGeneric: false, cached: false, fetchedAt: '' },
    }));
    expect(h.listRows()).toHaveLength(0);
    expect(h.statusText()).not.toBe('');
    expect(h.statusText()).not.toMatch(/MISSING:/);
  });
});

describe('TASK-03 A · entry point and loading', () => {
  it('mounts one entry button next to the anchor and opens on click', async () => {
    const h = sitesHarness({ mount: true });
    expect(panelEntry(h).textContent).not.toMatch(/MISSING:/);
    expect(h.overlay()).toBeNull();
    const h2 = await opened(h);
    expect(h2.overlay()).not.toBeNull();
    expect(h2.calls[0]?.channel).toBe('SUPPORTED_SITES');
  });

  it('sends NO parameters on a cold open, and only `refresh` on refresh', async () => {
    const h = await opened();
    // A cold open must not let the renderer steer the engine in any way.
    expect(h.calls[0]?.payload).toEqual({});
    h.refresh().fire('click', { preventDefault() {} });
    await h.settle();
    expect(h.calls[1]?.payload).toEqual({ refresh: true });
    for (const call of h.calls) {
      for (const key of ['enginePath', 'engineVersion', 'argv', 'cookiesFile', 'url']) {
        expect(JSON.stringify(call.payload)).not.toContain(key);
      }
    }
  });

  it('shows the engine version and both counts, never a bare number', async () => {
    const h = await opened(sitesHarness({
      mount: true,
      reply: catalogDto({ engineVersion: '2026.10.26', siteCount: 1308, subExtractorCount: 445 }),
    }));
    const summary = h.summaryText();
    expect(summary).toContain('2026.10.26');
    expect(summary).toContain('1308');
    expect(summary).toContain('445');
  });

  it('renders the cached summary differently from a fresh one', async () => {
    const fresh = await opened(sitesHarness({ mount: true, reply: catalogDto({ cached: false }) }));
    const cached = await opened(sitesHarness({ mount: true, reply: catalogDto({ cached: true }) }));
    expect(cached.summaryText()).not.toBe(fresh.summaryText());
  });

  it('falls back to a version placeholder when the engine reports none', async () => {
    const h = await opened(sitesHarness({ mount: true, reply: catalogDto({ engineVersion: '' }) }));
    expect(h.summaryText()).not.toMatch(/MISSING:/);
    expect(h.summaryText().length).toBeGreaterThan(0);
  });
});

describe('TASK-03 A · rows, search, sort and paging', () => {
  it('paints rows and marks broken / generic rows from the engine flags', async () => {
    const h = await opened(sitesHarness({
      mount: true,
      reply: catalogDto({
        rows: [
          row({ name: 'youtube' }),
          row({ name: 'brokenone', broken: true }),
          row({ name: 'generic', isGeneric: true }),
          row({ name: 'youtubetab:playlist', parent: 'youtubetab' }),
        ],
      }),
    }));
    const rows = h.listRows();
    expect(rows).toHaveLength(4);
    const broken = rows.find((n) => n.getAttribute('data-name') === 'brokenone');
    expect(broken?.getAttribute('data-broken')).toBe('1');
    const generic = rows.find((n) => n.getAttribute('data-name') === 'generic');
    expect(generic?.getAttribute('data-generic')).toBe('1');
    const sub = rows.find((n) => n.getAttribute('data-name') === 'youtubetab:playlist');
    expect(sub?.getAttribute('data-parent')).toBe('youtubetab');
  });

  it('filters by the search box and reports an empty result as a message, not a blank list', async () => {
    const h = await opened(sitesHarness({
      mount: true,
      reply: catalogDto({ rows: [row({ name: 'alpha' }), row({ name: 'beta' })] }),
    }));
    h.panel.setQuery('alp');
    expect(h.listRows().map((n) => n.getAttribute('data-name'))).toEqual(['alpha']);
    h.panel.setQuery('nope-nothing');
    expect(h.listRows()).toHaveLength(0);
    // A blank list would read as "no sites"; a message says the filter matched none.
    expect(h.statusText()).not.toBe('');
    expect(h.statusText()).not.toMatch(/MISSING:/);
  });

  it('puts the engine-broken rows first under the broken sort', async () => {
    const h = await opened(sitesHarness({
      mount: true,
      reply: catalogDto({
        rows: [row({ name: 'healthy' }), row({ name: 'brokenone', broken: true })],
      }),
    }));
    h.panel.setSort('broken');
    const names = h.listRows().map((n) => n.getAttribute('data-name'));
    expect(names[0]).toBe('brokenone');
  });

  it('sorts by name under the default sort', async () => {
    const h = await opened(sitesHarness({
      mount: true,
      reply: catalogDto({ rows: [row({ name: 'zeta' }), row({ name: 'alpha' })] }),
    }));
    const names = h.listRows().map((n) => n.getAttribute('data-name'));
    expect(names).toEqual(['alpha', 'zeta']);
  });

  it('pages the list and offers more only while rows remain', async () => {
    const many = Array.from({ length: 130 }, (_v, i) => row({ name: `site${String(i).padStart(4, '0')}` }));
    const h = await opened(sitesHarness({ mount: true, reply: catalogDto({ rows: many }) }));
    const page = h.panel.resize();
    expect(h.listRows()).toHaveLength(page);
    // The "more" affordance exists exactly because rows remain unpainted.
    const more = findAll(h.overlay() as never, (n) => n.getAttribute('id') === 'sites-more')[0];
    expect(more).toBeDefined();
    more?.fire('click', {});
    expect(h.listRows().length).toBeGreaterThan(page);
    expect(h.listRows().length).toBeLessThanOrEqual(page * 2);
  });

  it('shows no "more" affordance when every row fits on one page', async () => {
    const h = await opened(sitesHarness({ mount: true, reply: catalogDto({ rows: [row()] }) }));
    const more = findAll(h.overlay() as never, (n) => n.getAttribute('id') === 'sites-more');
    expect(more).toHaveLength(0);
  });
});

describe('TASK-03 A · the GenericIE note', () => {
  it('appears only when the engine actually reports `generic`', async () => {
    const withGeneric = await opened(sitesHarness({ mount: true, reply: catalogDto({ hasGeneric: true }) }));
    expect(withGeneric.noteText().length).toBeGreaterThan(0);
    expect(withGeneric.noteText()).not.toMatch(/MISSING:/);

    const without = await opened(sitesHarness({ mount: true, reply: catalogDto({ hasGeneric: false }) }));
    // Not merely hidden — the text is cleared, so a stale note cannot linger.
    expect(without.noteText()).toBe('');
  });
});

describe('TASK-03 A · failures are never an empty list', () => {
  const cases: [string, string][] = [
    ['ENGINE_TIMEOUT', 'timeout'],
    ['ENGINE_UNAVAILABLE', 'unavailable'],
    ['ENGINE_EMPTY', 'empty'],
    ['OUTPUT_LIMIT_EXCEEDED', 'tooLarge'],
    ['ENGINE_FAILED', 'failed'],
    ['SOMETHING_UNSEEN', 'failed'],
  ];

  for (const [code, label] of cases) {
    it(`maps ${code} to its own sentence and disables the controls`, async () => {
      const h = await opened(sitesHarness({
        mount: true,
        reply: { ok: false, code, rows: [], engineVersion: '', siteCount: 0, subExtractorCount: 0, brokenCount: 0, hasGeneric: false, cached: false, fetchedAt: '' },
      }));
      expect(h.listRows()).toHaveLength(0);
      expect(h.statusText()).not.toBe('');
      expect(h.statusText()).not.toMatch(/MISSING:/);
      // A working-looking search box over an empty list implies "no sites".
      expect(h.search().disabled).toBe(true);
      expect(h.sort().disabled).toBe(true);
      expect(h.refresh().disabled).toBe(false);
      expect(label.length).toBeGreaterThan(0);
    });
  }

  it('gives every failure code a DISTINCT sentence', async () => {
    const texts = new Set<string>();
    for (const [code] of cases) {
      const h = await opened(sitesHarness({
        mount: true,
        reply: { ok: false, code, rows: [], engineVersion: '', siteCount: 0, subExtractorCount: 0, brokenCount: 0, hasGeneric: false, cached: false, fetchedAt: '' },
      }));
      texts.add(h.statusText());
    }
    // timeout / unavailable / empty / tooLarge / failed are five different
    // situations; collapsing them would make the screen unactionable.
    expect(texts.size).toBe(5);
  });
});

describe('TASK-03 A · the panel is reloadable after a failure', () => {
  it('retries on reopen after a failure instead of staying dead', async () => {
    const h = sitesHarness({
      mount: true,
      reply: { ok: false, code: 'ENGINE_FAILED', rows: [], engineVersion: '', siteCount: 0, subExtractorCount: 0, brokenCount: 0, hasGeneric: false, cached: false, fetchedAt: '' },
    });
    panelEntry(h).fire('click', { preventDefault() {} });
    await h.settle();
    expect(h.panel.stateOf()).toBe('failed');

    // The engine comes back: the next open must re-ask, not serve the failure.
    h.setReply(catalogDto({ rows: [row({ name: 'recovered' })] }));
    h.panel.open();
    await h.settle();
    expect(h.panel.stateOf()).toBe('ready');
    expect(h.listRows().map((n) => n.getAttribute('data-name'))).toEqual(['recovered']);
  });

  it('closes from the close button and can be reopened', async () => {
    const h = await opened();
    const close = findAll(h.overlay() as never, (n) => n.getAttribute('aria-label') !== null && n.tagName === 'button')[0];
    close?.fire('click', {});
    expect(h.overlay()).toBeNull();
    h.panel.open();
    await h.settle();
    expect(h.overlay()).not.toBeNull();
  });
});
