/**
 * Shared fake-DOM harness for the queue page (`pages/queue/queue.js`).
 *
 * The page is a zero-dependency browser script, so the only faithful way to test
 * it is to execute the REAL file against a minimal DOM. Two suites need that
 * (`queue-progress.test.ts` for D-107, `queue-failure.test.ts` for D-109), so the
 * harness lives here instead of being copied.
 *
 * What is real: `messages.js` (the shipped catalogue), `app-shell.js` (label /
 * format helpers) and `queue.js` itself. What is fake: `document`, storage,
 * `location` and the preload bridge — deliberately tiny, so a missing method is
 * a loud failure rather than a silent pass.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { interpolate } from '@ytvdlt/core';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const UI_SRC = join(ROOT, 'packages', 'ui', 'src');

const sources = {
  messages: readFileSync(join(UI_SRC, 'i18n', 'messages.js'), 'utf8'),
  shell: readFileSync(join(UI_SRC, 'app-shell.js'), 'utf8'),
  queue: readFileSync(join(UI_SRC, 'pages', 'queue', 'queue.js'), 'utf8'),
};

interface Catalogue {
  MESSAGES: Record<string, Record<string, string>>;
}

export class FakeNode {
  tagName: string;
  attrs: Record<string, string> = {};
  children: FakeNode[] = [];
  style: Record<string, string> = {};
  private _className = '';
  /** Mirror real DOM: `el.className = x` also makes `getAttribute('class')` work. */
  get className(): string { return this._className; }
  set className(value: string) {
    this._className = String(value);
    this.attrs['class'] = this._className;
  }
  checked = false;
  type = '';
  value = '';
  listeners: Record<string, ((event?: unknown) => void)[]> = {};
  private text = '';

  constructor(tagName: string) { this.tagName = tagName; }

  appendChild(child: FakeNode): FakeNode { this.children.push(child); return child; }
  setAttribute(key: string, value: unknown): void { this.attrs[key] = String(value); }
  getAttribute(key: string): string | null { return this.attrs[key] ?? null; }
  removeAttribute(key: string): void { delete this.attrs[key]; }
  addEventListener(type: string, fn: (event?: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  get textContent(): string {
    return this.children.length === 0
      ? this.text
      : this.children.map((child) => child.textContent).join('');
  }
  set textContent(value: string) { this.children = []; this.text = String(value); }
}

export interface QueuePageHarness {
  cards: FakeNode;
  root: FakeNode;
  queue: any;
  storage: Map<string, string>;
  calls: { channel: string; payload: unknown }[];
  /** The URL the page asked to reload after a language switch (null if none). */
  replacedUrl(): string | null;
  /** Fire the real language button's click listener. */
  clickLanguage(locale: 'en' | 'zh-CN'): void;
  /** Replace the next TASK_LIST reply and run exactly one 1.2 s poll. */
  setItems(items: readonly unknown[]): Promise<void>;
  /** Let the load-time refresh settle without waiting for a poll. */
  settle(): Promise<void>;
}

export function harness(options: {
  items?: readonly unknown[];
  live?: boolean;
  lang?: 'zh-CN' | 'en';
  storedLocale?: 'zh-CN' | 'en';
  withLanguageButtons?: boolean;
  /**
   * D-116: extra elements the page looks up by id (the delete dialog). The
   * harness only registers the queue shell by default, so a suite that drives
   * the modal has to supply its nodes.
   */
  elements?: Record<string, FakeNode>;
  /**
   * D-120: per-channel reply override. Return `undefined` to fall back to
   * the default fake reply. Lets a suite prove what the page does with a
   * `FILE_MISSING` / `filesMissing` result without touching the bridge shape.
   */
  onInvoke?: (channel: string, payload: unknown) => unknown;
} = {}): QueuePageHarness {
  const sandbox: Record<string, any> = {};
  new Function('window', sources.messages)(sandbox);
  const catalogue = sandbox['YTVDLT_I18N'] as Catalogue;
  // A page load resolves the locale from ?lang= first, then the stored value.
  const effectiveLocale: 'zh-CN' | 'en' = options.lang === 'en'
    || (options.lang === undefined && options.storedLocale === 'en') ? 'en' : 'zh-CN';
  const table = catalogue.MESSAGES[effectiveLocale] ?? {};

  const root = new FakeNode('main');
  const cards = new FakeNode('div');
  const registry: Record<string, FakeNode> = { 'queue-root': root, 'queue-cards': cards };
  Object.assign(registry, options.elements ?? {});
  // A live list mutated in place: `bridge.invoke` reads it on every poll.
  const replies: { items: readonly unknown[] } = { items: options.items ?? [] };
  const storage = new Map<string, string>();
  if (options.storedLocale !== undefined) storage.set('ytvdlt.locale', options.storedLocale);
  const calls: { channel: string; payload: unknown }[] = [];
  let replaced: string | null = null;
  const languageButtons = (options.withLanguageButtons === true ? ['zh-CN', 'en'] : [])
    .map((value) => {
      const button = new FakeNode('button');
      button.setAttribute('data-locale', value);
      return button;
    });

  const doc = {
    visibilityState: 'visible',
    documentElement: new FakeNode('html'),
    getElementById: (id: string) => registry[id] ?? null,
    querySelector: () => null,
    querySelectorAll: (selector: string) => (selector.indexOf('#queue-lang') !== -1
      ? languageButtons : [] as FakeNode[]),
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => {
      const node = new FakeNode('#text');
      node.textContent = text;
      return node;
    },
    addEventListener: () => undefined,
    dispatchEvent: () => true,
  };

  sandbox.document = doc;
  sandbox.location = {
    search: options.lang === 'en' ? '?lang=en' : '',
    href: 'file:///app/pages/queue/index.html',
    replace(url: string) { replaced = url; },
  };
  sandbox.localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
  };
  sandbox.addEventListener = () => undefined;
  sandbox.Promise = Promise;
  // D-112: the page schedules its own poll cadence with setTimeout. Bind the
  // host timers (vitest fake timers patch the globals) so `advanceTimersByTime`
  // drives the real loop instead of throwing inside the page.
  sandbox.setTimeout = globalThis.setTimeout.bind(globalThis);
  sandbox.clearTimeout = globalThis.clearTimeout.bind(globalThis);
  sandbox.setInterval = globalThis.setInterval.bind(globalThis);
  sandbox.clearInterval = globalThis.clearInterval.bind(globalThis);
  sandbox.window = sandbox;
  if (options.live !== true) sandbox.__YTVDLT_TASKS__ = options.items ?? [];

  // Real catalogue + interpolate, so assertions check shipped copy, not keys.
  sandbox.YTVDLT = {
    i18n: {
      t(key: string, params?: Record<string, unknown>) {
        const raw = table[key];
        return typeof raw === 'string' ? interpolate(raw, params ?? {}) : `MISSING:${key}`;
      },
    },
    shortcuts: { on: () => undefined, install: () => () => undefined, extractDeepLink: () => null },
  };
  new Function('window', sources.shell)(sandbox);

  if (options.live === true) {
    sandbox.ytvdltBridge = {
      invoke(channel: string, payload: unknown) {
        calls.push({ channel, payload });
        const custom = options.onInvoke?.(channel, payload);
        if (custom !== undefined) return Promise.resolve(custom);
        return Promise.resolve(channel === 'ytvdlt:task:list' ? { ok: true, items: replies.items } : { ok: true });
      },
    };
  }
  new Function('window', sources.queue)(sandbox);

  return {
    cards,
    root,
    queue: sandbox['YTVDLTQueue'],
    storage,
    calls,
    replacedUrl: () => replaced,
    clickLanguage(wanted: 'en' | 'zh-CN') {
      const button = languageButtons.find((entry) => entry.getAttribute('data-locale') === wanted);
      if (button === undefined) throw new Error(`no language button for ${wanted}`);
      (button.listeners['click'] ?? []).forEach((fn) => fn());
    },
    async settle() { await vi.advanceTimersByTimeAsync(0); },
    async setItems(items: readonly unknown[]) {
      replies.items = items;
      // The page polls every 1.2 s; fake timers let one poll run to completion.
      await vi.advanceTimersByTimeAsync(1200);
    },
  };
}

/** Renderer-shaped record — exactly what `tasks()` returns in non-live mode. */
export function cardTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't1', state: 'Running', kind: 'video', title: 'Sample', uploader: 'Uploader',
    duration: 100, percent: null, speed: 0, eta: null, downloadedBytes: null,
    totalBytes: null, thumbPath: null, artifacts: 0, errorCode: null,
    failureKind: null,
    // D-115: `null` = no reliable phase, which is what an old snapshot yields.
    stage: null,
    ...overrides,
  };
}

/** `TASK_LIST` payload shape — what the main process actually sends. */
export function dto(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const task = cardTask(overrides);
  return {
    id: task['id'], state: task['state'], kind: task['kind'], title: task['title'],
    uploader: task['uploader'], duration: task['duration'], percent: task['percent'],
    speedBps: task['speed'], etaSec: task['eta'], downloadedBytes: task['downloadedBytes'],
    totalBytes: task['totalBytes'], thumbPath: task['thumbPath'],
    artifactCount: task['artifacts'], errorCode: task['errorCode'],
    failureKind: task['failureKind'],
    // D-115: the wire field the queue reads; omitted only when the caller did
    // not set one, so the "no information" path stays testable.
    ...(task['stage'] === null ? {} : { stage: task['stage'] }),
    // D-120: absent by default -> the static preview paints NO file hint.
    ...(typeof task['fileStatus'] === 'string' ? { fileStatus: task['fileStatus'] } : {}),
    ...(typeof task['dirStatus'] === 'string' ? { dirStatus: task['dirStatus'] } : {}),
  };
}

export function findAll(node: FakeNode, predicate: (n: FakeNode) => boolean): FakeNode[] {
  const found: FakeNode[] = [];
  const walk = (current: FakeNode): void => {
    if (predicate(current)) found.push(current);
    current.children.forEach(walk);
  };
  walk(node);
  return found;
}

export function onlyCard(h: QueuePageHarness): FakeNode {
  const cards = h.cards.children.filter((child) => child.getAttribute('data-task-id') !== null);
  if (cards.length !== 1) throw new Error(`expected exactly one card, got ${cards.length}`);
  return cards[0] as FakeNode;
}

export function cardById(h: QueuePageHarness, id: string): FakeNode {
  const card = h.cards.children.find((child) => child.getAttribute('data-task-id') === id);
  if (card === undefined) throw new Error(`no card for ${id}`);
  return card;
}

export function barOf(card: FakeNode): FakeNode {
  const bars = findAll(card, (n) => n.className === 'bar');
  if (bars.length !== 1) throw new Error(`expected exactly one bar, got ${bars.length}`);
  return bars[0] as FakeNode;
}

export function progressOf(card: FakeNode): FakeNode {
  const lines = findAll(card, (n) => n.className === 'card-meta card-progress');
  if (lines.length !== 1) throw new Error(`expected exactly one progress line, got ${lines.length}`);
  return lines[0] as FakeNode;
}

/** The plain `.card-meta` hint under the wait bar (the last meta line, no progress attr). */
export function hintOf(card: FakeNode): FakeNode {
  const lines = findAll(card, (n) => n.className === 'card-meta' && n.getAttribute('data-progress') === null);
  if (lines.length === 0) throw new Error('expected a hint line under the wait bar');
  return lines[lines.length - 1] as FakeNode;
}

/** The status/meta row that carries the Error badge and the error code. */
export function metaRowOf(card: FakeNode): FakeNode {
  const rows = findAll(card, (n) => n.className === 'card-meta'
    && n.children.some((child) => child.className === 'badge'));
  if (rows.length !== 1) throw new Error(`expected exactly one badge row, got ${rows.length}`);
  return rows[0] as FakeNode;
}

/** D-109: the failure brief, or `null` when the card must not show one. */
export function failureBriefOf(card: FakeNode): FakeNode | null {
  const spans = findAll(card, (n) => n.className === 'card-failure');
  if (spans.length > 1) throw new Error(`expected at most one failure brief, got ${spans.length}`);
  return spans[0] ?? null;
}

/** Index of a node among its parent's children (-1 when detached). */
export function indexIn(parent: FakeNode, node: FakeNode): number {
  return parent.children.indexOf(node);
}
