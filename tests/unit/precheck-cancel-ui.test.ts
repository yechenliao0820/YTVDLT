/**
 * T5 — the pre-check cancel affordances in the REAL shipped UI components.
 *
 * Executes `txt-import.js` / `playlist-import.js` verbatim against a tiny fake
 * DOM (same harness style as txt-import-ui / playlist-import-ui), so these are
 * user-visible-contract tests, not implementation mocks:
 *
 *   - during the enqueue round-trip a cancel button is rendered and clicking it
 *     fires `URL_SUPPORT_CHECK_CANCEL` (zero payload);
 *   - the progress readout polls `URL_SUPPORT_CHECK_STATUS` and shows
 *     "checked / total";
 *   - a `cancelled: true` reply renders 「已取消，未入队」 and never a success;
 *   - closing the dialog while the pre-check runs also fires the cancel;
 *   - the new i18n keys exist in BOTH locales with matching placeholders.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { subtitleHarness } from './helpers/subtitle-picker-harness.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpolate } from '@ytvdlt/core';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const UI_SRC = join(ROOT, 'packages', 'ui', 'src');
const TXT_COMPONENT = readFileSync(join(UI_SRC, 'txt-import', 'txt-import.js'), 'utf8');
const PL_COMPONENT = readFileSync(join(UI_SRC, 'playlists', 'playlist-import.js'), 'utf8');
const CATALOGUE = readFileSync(join(UI_SRC, 'i18n', 'messages.js'), 'utf8');

type Listener = (event?: { preventDefault?: () => void }) => void;

class FakeNode {
  readonly attrs: Record<string, string> = {};
  readonly children: FakeNode[] = [];
  readonly listeners: Record<string, Listener[]> = {};
  parentNode: FakeNode | null = null;
  checked = false;
  value = '';
  private text = '';

  constructor(readonly tagName: string, private readonly owner: FakeDoc) {}

  set className(v: string) { this.attrs['class'] = String(v); }
  get className(): string { return this.attrs['class'] ?? ''; }
  setAttribute(key: string, v: unknown): void {
    this.attrs[key] = String(v);
    if (key === 'id') this.owner.byId.set(String(v), this);
  }
  getAttribute(key: string): string | null { return this.attrs[key] ?? null; }
  removeAttribute(key: string): void { delete this.attrs[key]; }
  appendChild(child: FakeNode): FakeNode {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(node: FakeNode, ref: FakeNode | null): FakeNode {
    node.parentNode = this;
    const at = ref === null ? this.children.length : this.children.indexOf(ref);
    this.children.splice(at < 0 ? this.children.length : at, 0, node);
    return node;
  }
  removeChild(node: FakeNode): FakeNode {
    const at = this.children.indexOf(node);
    if (at !== -1) this.children.splice(at, 1);
    node.parentNode = null;
    return node;
  }
  get nextSibling(): FakeNode | null {
    if (this.parentNode === null) return null;
    const at = this.parentNode.children.indexOf(this);
    return this.parentNode.children[at + 1] ?? null;
  }
  addEventListener(type: string, fn: Listener): void { (this.listeners[type] ??= []).push(fn); }
  querySelector(selector: string): FakeNode | null {
    return selector.startsWith('#') ? this.owner.byId.get(selector.slice(1)) ?? null : null;
  }
  get textContent(): string {
    return this.children.length === 0
      ? this.text : this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) { this.children = []; this.text = String(v); }
  click(): void { (this.listeners['click'] ?? []).forEach((fn) => fn({ preventDefault() {} })); }
  change(): void { (this.listeners['change'] ?? []).forEach((fn) => fn()); }
}

class FakeDoc {
  readonly byId = new Map<string, FakeNode>();
  readonly head = new FakeNode('head', this);
  readonly body = new FakeNode('body', this);
  createElement(tag: string): FakeNode { return new FakeNode(tag, this); }
  getElementById(id: string): FakeNode | null { return this.byId.get(id) ?? null; }
}

interface Call { channel: string; payload: Record<string, unknown> }

function messages(): Record<string, Record<string, string>> {
  const sandbox: Record<string, unknown> = {};
  new Function('window', CATALOGUE)(sandbox);
  return (sandbox['YTVDLT_I18N'] as { MESSAGES: Record<string, Record<string, string>> }).MESSAGES;
}

const MESSAGES = messages();

function t(key: string, params?: Record<string, unknown>): string {
  const raw = MESSAGES['zh-CN']?.[key];
  return typeof raw === 'string' ? interpolate(raw, params ?? {}) : key;
}

const tick = async (): Promise<void> => { await new Promise((r) => setImmediate(r)); };
const dwell = async (ms: number): Promise<void> => { await new Promise((r) => setTimeout(r, ms)); };

const V = (n: number): string => `https://www.youtube.com/watch?v=video${n}`;

function txtPreview(): Record<string, unknown> {
  return {
    ok: true, canceled: false, code: '', fileName: 'links.txt',
    importId: 'import-ticket-0001', totalLines: 2, blankCount: 0,
    validCount: 2, invalidCount: 0, duplicateCount: 0, playlistCount: 0,
    maxUrls: 200,
    items: [
      { line: 1, text: V(1), status: 'valid', reason: 'OK' },
      { line: 2, text: V(2), status: 'valid', reason: 'OK' },
    ],
  };
}

const CANCELLED_ENQUEUE = {
  ok: false, code: 'PRECHECK_CANCELLED', cancelled: true,
  requested: 2, enqueued: 0, failed: 2, taskIds: [], failures: [],
};

/** Shared mutable call environment both harnesses drive. */
interface Env {
  calls: Call[];
  notices: string[];
  enqueueGates: Array<(value: unknown) => void>;
  status: Record<string, unknown>;
  statusCalls: number;
}

function makeEnv(): Env {
  return { calls: [], notices: [], enqueueGates: [], status: { active: false, checked: 0, total: 0 }, statusCalls: 0 };
}

function makeCall(env: Env, special: (channel: string) => Promise<unknown> | undefined) {
  return (channel: string, payload: Record<string, unknown>): Promise<unknown> => {
    env.calls.push({ channel, payload });
    const handled = special(channel);
    if (handled !== undefined) return handled;
    if (channel === 'URL_SUPPORT_CHECK_STATUS') {
      env.statusCalls += 1;
      return Promise.resolve(env.status);
    }
    if (channel === 'URL_SUPPORT_CHECK_CANCEL') return Promise.resolve({ ok: true, cancelled: true });
    return Promise.resolve({ ok: true });
  };
}

function mountTxt(env: Env, componentSource: string): {
  doc: FakeDoc; component: {
    mount(anchor: FakeNode, css: string): void; open(): void; close(): void; isOpen(): boolean;
  };
} {
  const doc = new FakeDoc();
  const sandbox: Record<string, unknown> = {};
  new Function('window', componentSource)(sandbox);
  const factory = (sandbox['YTVDLT'] as {
    txtImport: { create(o: Record<string, unknown>): any };
  }).txtImport;
  const component = factory.create({
    doc,
    t,
    call: makeCall(env, (channel) => {
      if (channel === 'TXT_IMPORT_PICK') return Promise.resolve(txtPreview());
      if (channel === 'TXT_IMPORT_ENQUEUE') {
        return new Promise((resolve) => { env.enqueueGates.push(resolve); });
      }
      return undefined;
    }),
    notify: (text: string) => { env.notices.push(text); },
    getChoice: () => ({ kind: 'video', videoQuality: '1080p', audioQuality: 'best', audioFormat: 'auto' }),
    refresh: () => undefined,
    pollMs: 5,
  });
  const anchor = doc.createElement('form');
  anchor.setAttribute('id', 'queue-paste-form');
  doc.body.appendChild(anchor);
  component.mount(anchor, '../../styles/txt-import.css');
  return { doc, component };
}

function mountPlaylist(env: Env): {
  doc: FakeDoc; component: {
    mount(anchor: FakeNode, css: string): void; open(url: string): void; cancel(): void; close(): void;
  };
} {
  const doc = new FakeDoc();
  const sandbox: Record<string, unknown> = {};
  new Function('window', PL_COMPONENT)(sandbox);
  const factory = (sandbox['YTVDLT'] as {
    playlists: { create(o: Record<string, unknown>): any };
  }).playlists;
  const component = factory.create({
    doc,
    t,
    call: makeCall(env, (channel) => {
      if (channel === 'PLAYLIST_PREVIEW') {
        return Promise.resolve({
          ok: true, code: '', previewId: 'preview-ticket-0001', title: '合集',
          extractorKey: 'youtube:playlist', declaredCount: 2, fetchedCount: 2,
          availableCount: 2, unavailableCount: 0, totalDurationSec: 120,
          entries: [
            { id: 'ep1', title: 'A', position: 1, durationSec: 60, available: true },
            { id: 'ep2', title: 'B', position: 2, durationSec: 60, available: true },
          ],
          truncated: false, expiresAt: '',
        });
      }
      if (channel === 'PLAYLIST_BATCH_ENQUEUE') {
        return new Promise((resolve) => { env.enqueueGates.push(resolve); });
      }
      return undefined;
    }),
    notify: (text: string) => { env.notices.push(text); },
    getChoice: () => ({ kind: 'video', videoQuality: '1080p', audioQuality: 'best', audioFormat: 'auto' }),
    refresh: () => undefined,
    startSingleDownload: () => undefined,
    readUrl: () => 'https://www.youtube.com/playlist?list=PL1',
    pollMs: 5,
  });
  const anchor = doc.createElement('form');
  anchor.setAttribute('id', 'queue-paste-form');
  doc.body.appendChild(anchor);
  component.mount(anchor, '../../styles/playlist-import.css');
  return { doc, component };
}

// ---------------------------------------------------------------------------

describe('T5 · TXT import dialog: cancel during the pre-check', () => {
  it('shows a cancel button while waiting; clicking it fires the zero-payload cancel channel', async () => {
    const env = makeEnv();
    const { doc, component } = mountTxt(env, TXT_COMPONENT);
    doc.byId.get('queue-import-txt')?.click();
    await tick();
    doc.byId.get('txt-import-confirm')?.click();
    await tick();

    // The wait row exists with a cancel button and no result yet.
    const stop = doc.byId.get('txt-import-cancel-precheck');
    expect(stop).toBeDefined();
    expect(doc.byId.get('txt-import-wait-progress')?.textContent).toBe(t('queue.precheck.checking'));

    stop?.click();
    await tick();
    const cancel = env.calls.find((c) => c.channel === 'URL_SUPPORT_CHECK_CANCEL');
    expect(cancel).toBeDefined();
    // D-160: the cancel names THIS submission's scope, never a batch/URL/ticket.
    expect(cancel?.payload).toEqual({ operationId: expect.any(String) });
    expect(doc.byId.get('txt-import-cancel-precheck')?.getAttribute('disabled')).toBe('disabled');
    expect(doc.byId.get('txt-import-wait-progress')?.textContent).toBe(t('queue.precheck.cancelling'));

    // The reply arrives: cancelled, nothing queued — never a success line.
    env.enqueueGates[0]?.({ ...CANCELLED_ENQUEUE });
    await tick();
    const body = doc.byId.get('txt-import-body');
    expect(body?.textContent).toContain(t('queue.precheck.cancelledBatch'));
    expect(body?.textContent).not.toContain(t('queue.import.result', { requested: 2, enqueued: 2, failed: 0 }));
    expect(env.notices).toContain(t('queue.precheck.cancelledBatch'));
  });

  it('the progress readout polls STATUS and shows "checked / total"', async () => {
    const env = makeEnv();
    const { doc, component } = mountTxt(env, TXT_COMPONENT);
    doc.byId.get('queue-import-txt')?.click();
    await tick();
    doc.byId.get('txt-import-confirm')?.click();
    env.status = { active: true, checked: 1, total: 2 };
    await dwell(30);

    expect(doc.byId.get('txt-import-wait-progress')?.textContent)
      .toBe(t('queue.precheck.progress', { checked: 1, total: 2 }));

    env.status = { active: true, checked: 2, total: 2 };
    await dwell(30);
    expect(doc.byId.get('txt-import-wait-progress')?.textContent)
      .toBe(t('queue.precheck.progress', { checked: 2, total: 2 }));

    // Termination: an inactive status stops the polling for good.
    env.status = { active: false, checked: 2, total: 2 };
    await dwell(30);
    const polls = env.statusCalls;
    await dwell(30);
    expect(env.statusCalls).toBe(polls);
    void component;
  });

  it('closing the dialog while the pre-check runs also cancels it', async () => {
    const env = makeEnv();
    const { doc, component } = mountTxt(env, TXT_COMPONENT);
    doc.byId.get('queue-import-txt')?.click();
    await tick();
    doc.byId.get('txt-import-confirm')?.click();
    await tick();
    component.close();
    await tick();
    expect(env.calls.some((c) => c.channel === 'URL_SUPPORT_CHECK_CANCEL')).toBe(true);
  });
});

describe('T5 · playlist dialog: cancel during the pre-check', () => {
  it('shows a cancel button; clicking it fires the cancel channel; the reply says nothing was queued', async () => {
    const env = makeEnv();
    const { doc, component } = mountPlaylist(env);
    component.open('https://www.youtube.com/playlist?list=PL1');
    await tick();
    doc.byId.get('pl-confirm')?.click();
    await tick();

    const stop = doc.byId.get('pl-cancel-precheck');
    expect(stop).toBeDefined();
    stop?.click();
    await tick();
    const cancel = env.calls.find((c) => c.channel === 'URL_SUPPORT_CHECK_CANCEL');
    expect(cancel).toBeDefined();
    expect(cancel?.payload).toEqual({ operationId: expect.any(String) });

    env.enqueueGates[0]?.({ ...CANCELLED_ENQUEUE });
    await tick();
    const body = doc.byId.get('pl-body');
    expect(body?.textContent).toContain(t('queue.precheck.cancelledBatch'));
    expect(env.notices).toContain(t('queue.precheck.cancelledBatch'));
  });

  it('pressing the dialog cancel (×) while the pre-check runs cancels the batch too', async () => {
    const env = makeEnv();
    const { doc, component } = mountPlaylist(env);
    component.open('https://www.youtube.com/playlist?list=PL1');
    await tick();
    doc.byId.get('pl-confirm')?.click();
    await tick();
    component.cancel();
    await tick();
    expect(env.calls.some((c) => c.channel === 'URL_SUPPORT_CHECK_CANCEL')).toBe(true);
    void doc;
  });
});

describe('T5 · the cancellation copy exists in BOTH locales', () => {
  const KEYS = [
    'queue.precheck.cancel',
    'queue.precheck.cancelling',
    'queue.precheck.progress',
    'queue.precheck.cancelled',
    'queue.precheck.cancelledBatch',
  ];

  it('every new key exists in zh-CN and en with matching placeholders', () => {
    const zh = MESSAGES['zh-CN'] ?? {};
    const en = MESSAGES['en'] ?? {};
    for (const key of KEYS) {
      expect(typeof zh[key], `zh-CN missing ${key}`).toBe('string');
      expect(typeof en[key], `en missing ${key}`).toBe('string');
      const placeholders = (value: string): string[] =>
        (value.match(/\{[a-z]+\}/g) ?? []).sort();
      expect(placeholders(en[key] as string)).toEqual(placeholders(zh[key] as string));
    }
  });
});

describe('T5 · a CANCELLED single-link verdict never enqueues', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('stops before DOWNLOAD_START even when THIS view never pressed cancel', async () => {
    // CANCEL has no batch id: another live view can be the one that stops an
    // in-flight check. The reply must still be terminal — no "add it anyway"
    // modal and no download behind the user's back.
    const h = subtitleHarness({
      onInvoke: (channel: string) => channel === 'ytvdlt:sites:check'
        ? {
          url: 'https://example.org/watch?v=abcdef', state: 'CANCELLED',
          code: 'PRECHECK_CANCELLED', extractor: '', cached: false,
          blocks: false, reason: '',
        }
        : undefined,
    });
    h.form.fire('submit', { preventDefault() {} });
    await h.settle();
    await h.settle();

    expect(h.calls.some((c) => c.channel === 'ytvdlt:sites:check')).toBe(true);
    expect(h.calls.filter((c) => c.channel === 'ytvdlt:download:start')).toEqual([]);
  });
});
