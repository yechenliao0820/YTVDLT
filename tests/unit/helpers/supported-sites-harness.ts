/**
 * Fake-DOM harness for the "supported sites" panel (D-134 A).
 *
 * The panel is a zero-dependency browser script shipped verbatim into the
 * renderer, so the only faithful test is executing the REAL file against a
 * minimal DOM. Kept separate from `queue-page-harness.ts` on purpose: that
 * harness has no `head`/`body`, no `insertBefore`, no `parentNode`/`nextSibling`
 * and no class-based `querySelectorAll`, and adding them there would put the
 * queue suites at risk for no benefit.
 *
 * What is real: `messages.js` (the shipped catalogue) and
 * `sites/supported-sites.js` itself. What is fake: `document` only. Every
 * assertion below therefore runs shipped code and shipped copy.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpolate } from '@ytvdlt/core';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const UI_SRC = join(ROOT, 'packages', 'ui', 'src');

const sources = {
  messages: readFileSync(join(UI_SRC, 'i18n', 'messages.js'), 'utf8'),
  sites: readFileSync(join(UI_SRC, 'sites', 'supported-sites.js'), 'utf8'),
};

interface Catalogue { MESSAGES: Record<string, Record<string, string>> }

export class FakeNode {
  tagName: string;
  attrs: Record<string, string> = {};
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  disabled = false;
  value = '';
  type = '';
  private _className = '';
  /** Mirror the real DOM: `el.className = x` also updates `getAttribute('class')`. */
  get className(): string { return this._className; }
  set className(v: string) { this._className = String(v); this.attrs['class'] = this._className; }
  listeners: Record<string, ((event?: unknown) => void)[]> = {};
  private text = '';

  constructor(tagName: string) { this.tagName = tagName; }

  get parentNode(): FakeNode | null { return this.parent; }
  get nextSibling(): FakeNode | null {
    if (this.parent === null) return null;
    const index = this.parent.children.indexOf(this);
    return index === -1 ? null : this.parent.children[index + 1] ?? null;
  }

  appendChild(child: FakeNode): FakeNode { child.parent = this; this.children.push(child); return child; }
  insertBefore(child: FakeNode, before: FakeNode | null): FakeNode {
    child.parent = this;
    const index = before === null ? -1 : this.children.indexOf(before);
    if (index === -1) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }
  removeChild(child: FakeNode): FakeNode {
    const index = this.children.indexOf(child);
    if (index !== -1) this.children.splice(index, 1);
    child.parent = null;
    return child;
  }
  /** Class-based lookup, which is all this panel ever asks for. */
  querySelectorAll(selector: string): FakeNode[] {
    const wanted = selector.startsWith('.') ? selector.slice(1) : selector;
    return this.descendants().filter((node) => node._className.split(/\s+/).indexOf(wanted) !== -1);
  }
  private descendants(): FakeNode[] {
    const out: FakeNode[] = [];
    const walk = (node: FakeNode): void => { node.children.forEach((c) => { out.push(c); walk(c); }); };
    walk(this);
    return out;
  }
  setAttribute(key: string, value: unknown): void { this.attrs[key] = String(value); }
  getAttribute(key: string): string | null { return this.attrs[key] ?? null; }
  removeAttribute(key: string): void { delete this.attrs[key]; }
  addEventListener(type: string, fn: (event?: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type: string, event: unknown = {}): void {
    (this.listeners[type] ?? []).slice().forEach((fn) => fn(event));
  }
  get textContent(): string {
    return this.children.length === 0
      ? this.text
      : this.children.map((child) => child.textContent).join('');
  }
  set textContent(value: string) { this.children = []; this.text = String(value); }
  get hidden(): boolean { return this.attrs['hidden'] !== undefined; }
}

export function findAll(node: FakeNode, predicate: (n: FakeNode) => boolean): FakeNode[] {
  const out: FakeNode[] = [];
  const walk = (current: FakeNode): void => {
    if (predicate(current)) out.push(current);
    current.children.forEach(walk);
  };
  walk(node);
  return out;
}

export function byId(root: FakeNode, id: string): FakeNode | null {
  return findAll(root, (node) => node.getAttribute('id') === id)[0] ?? null;
}

/** One `ExtractorInfo` row as the main process sends it. */
export function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'youtube', parent: '', broken: false, isGeneric: false, ...overrides };
}

/** A `SupportedSitesDto` as the main process sends it (never carries enginePath). */
export function catalogDto(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true, code: '', engineVersion: '2026.10.26',
    siteCount: 1308, subExtractorCount: 445, brokenCount: 136,
    hasGeneric: true, fetchedAt: '2026-11-11T00:00:00.000Z',
    rows: [row()], cached: false,
    ...overrides,
  };
}

export interface SitesHarness {
  doc: any;
  panel: any;
  calls: { channel: string; payload: unknown }[];
  body: FakeNode;
  head: FakeNode;
  anchor: FakeNode;
  entry: FakeNode | null;
  setReply(reply: unknown): void;
  setReplyOnce(reply: unknown): void;
  settle(): Promise<void>;
  summaryText(): string;
  statusText(): string;
  noteText(): string;
  listRows(): FakeNode[];
  overlay(): FakeNode | null;
  search(): FakeNode;
  sort(): FakeNode;
  refresh(): FakeNode;
}

export function sitesHarness(options: {
  live?: boolean;
  lang?: 'zh-CN' | 'en';
  mount?: boolean;
  reply?: unknown;
} = {}): SitesHarness {
  const sandbox: Record<string, any> = {};
  new Function('window', sources.messages)(sandbox);
  const catalogue = sandbox['YTVDLT_I18N'] as Catalogue;
  const locale = options.lang === 'en' ? 'en' : 'zh-CN';
  const table = catalogue.MESSAGES[locale] ?? {};

  const head = new FakeNode('head');
  const body = new FakeNode('body');
  const doc: any = {
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => { const n = new FakeNode('#text'); n.textContent = text; return n; },
    getElementById: (id: string) => byId(body, id),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => undefined,
    dispatchEvent: () => true,
  };
  doc.head = head;
  doc.body = body;
  doc.documentElement = new FakeNode('html');

  sandbox.document = doc;
  sandbox.window = sandbox;
  sandbox.Promise = Promise;
  sandbox.YTVDLT = {
    i18n: {
      t(key: string, params?: Record<string, unknown>) {
        const raw = table[key];
        return typeof raw === 'string' ? interpolate(raw, params ?? {}) : `MISSING:${key}`;
      },
    },
  };

  // The panel is loaded as a plain <script>, exactly like the real page.
  new Function('window', sources.sites)(sandbox);

  const calls: { channel: string; payload: unknown }[] = [];
  let reply: unknown = options.reply ?? catalogDto();
  let onceReply: unknown = undefined;

  const t = sandbox.YTVDLT.i18n.t;
  const panel = sandbox.YTVDLT.supportedSites.create({
    doc,
    t,
    call: (channel: string, payload: unknown) => {
      calls.push({ channel, payload });
      if (onceReply !== undefined) { const value = onceReply; onceReply = undefined; return Promise.resolve(value); }
      return Promise.resolve(reply);
    },
    notify: () => undefined,
  });

  // The queue page mounts into the header next to the paste box.
  const anchor = new FakeNode('form');
  body.appendChild(anchor);
  if (options.mount !== false) panel.mount(anchor, '../../styles/supported-sites.css');

  const overlayOf = () => byId(body, 'supported-sites-dialog');

  return {
    doc, panel, calls, body, head, anchor,
    entry: overlayOf() === null ? body.children.find((c) => c.getAttribute('id') === 'queue-sites-entry') ?? null : null,
    setReply(next: unknown) { reply = next; },
    setReplyOnce(next: unknown) { onceReply = next; },
    async settle() { for (let i = 0; i < 6; i += 1) await Promise.resolve(); },
    summaryText() {
      const overlay = overlayOf();
      if (overlay === null) return '';
      return byId(overlay, 'sites-status') === null ? '' : (findAll(overlay, (n) => n.className === 'sites-summary')[0]?.textContent ?? '');
    },
    statusText() {
      const overlay = overlayOf();
      if (overlay === null) return '';
      return byId(overlay, 'sites-status')?.textContent ?? '';
    },
    noteText() {
      const overlay = overlayOf();
      if (overlay === null) return '';
      return byId(overlay, 'sites-generic-note')?.textContent ?? '';
    },
    listRows() {
      const overlay = overlayOf();
      if (overlay === null) return [];
      const list = byId(overlay, 'sites-list');
      return list === null ? [] : list.querySelectorAll('.sites-row');
    },
    overlay() { return overlayOf(); },
    search() { const o = overlayOf(); return byId(o as FakeNode, 'sites-search') as FakeNode; },
    sort() { const o = overlayOf(); return byId(o as FakeNode, 'sites-sort') as FakeNode; },
    refresh() { const o = overlayOf(); return byId(o as FakeNode, 'sites-refresh') as FakeNode; },
  };
}

export function panelEntry(h: SitesHarness): FakeNode {
  const found = findAll(h.body, (n) => n.getAttribute('id') === 'queue-sites-entry');
  if (found.length !== 1) throw new Error(`expected exactly one entry button, got ${found.length}`);
  return found[0] as FakeNode;
}
