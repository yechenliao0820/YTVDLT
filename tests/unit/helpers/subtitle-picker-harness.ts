/**
 * Fake-DOM harness for stage 5: the real zero-dependency browser scripts
 * (`messages.js`, `app-shell.js`, `subtitles/subtitle-picker.js`, `queue.js`)
 * are executed with `new Function`, exactly like queue-page-harness.ts does.
 *
 * Kept separate on purpose: the existing harness has no `head`/`body`,
 * `insertBefore`, `disabled` or a live subtitle factory, and changing it would
 * put unrelated suites at risk. What is real here is every shipped line of the
 * four scripts; only `document`, storage, location and the preload bridge are
 * faked.
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
  picker: readFileSync(join(UI_SRC, 'subtitles', 'subtitle-picker.js'), 'utf8'),
  queue: readFileSync(join(UI_SRC, 'pages', 'queue', 'queue.js'), 'utf8'),
};

interface Catalogue { MESSAGES: Record<string, Record<string, string>> }

export class Node {
  tagName: string;
  attrs: Record<string, string> = {};
  children: Node[] = [];
  style: Record<string, string> = {};
  parent: Node | null = null;
  className = '';
  checked = false;
  disabled = false;
  type = '';
  value = '';
  listeners: Record<string, ((event?: unknown) => void)[]> = {};
  private text = '';

  constructor(tagName: string) { this.tagName = tagName; }

  appendChild(child: Node): Node {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child: Node, before: Node | null): Node {
    child.parent = this;
    const index = before === null ? -1 : this.children.indexOf(before);
    if (index === -1) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }
  removeChild(child: Node): Node {
    const index = this.children.indexOf(child);
    if (index !== -1) this.children.splice(index, 1);
    child.parent = null;
    return child;
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
  get hidden(): boolean { return this.attrs['hidden'] === 'true'; }
}

export function find(node: Node, predicate: (n: Node) => boolean): Node[] {
  const out: Node[] = [];
  const walk = (current: Node): void => {
    if (predicate(current)) out.push(current);
    current.children.forEach(walk);
  };
  walk(node);
  return out;
}
export function byId(root: Node, id: string): Node | null {
  return find(root, (node) => node.getAttribute('id') === id)[0] ?? null;
}

export interface SubtitlePreviewFixture {
  previewId: string;
  media: { title: string; uploader: string | null; durationSec: number | null; extractorKey: string };
  tracks: {
    languageCode: string; languageName: string | null;
    manualAvailable: boolean; automaticAvailable: boolean;
    manualFormats: string[]; automaticFormats: string[];
  }[];
  manualLanguages: number;
  automaticLanguages: number;
  empty: boolean;
  expiresAt: string;
}

export function track(overrides: Partial<SubtitlePreviewFixture['tracks'][number]> = {}): SubtitlePreviewFixture['tracks'][number] {
  return {
    languageCode: 'en', languageName: 'English',
    manualAvailable: true, automaticAvailable: false,
    manualFormats: ['srt', 'vtt'], automaticFormats: [],
    ...overrides,
  };
}

export interface SubtitleHarness {
  doc: any;
  sandbox: Record<string, any>;
  queue: any;
  picker: any;
  calls: { channel: string; payload: unknown }[];
  root: Node;
  urlInput: Node;
  form: Node;
  body: Node;
  modal: Node;
  entry: Node;
  status: Node;
  setPreview(result: unknown): void;
  setEnqueue(result: unknown): void;
  setUrl(value: string): void;
  open(): void;
  settle(): Promise<void>;
  findInModal(predicate: (n: Node) => boolean): Node[];
  modalText(): string;
}

export function subtitleHarness(options: {
  live?: boolean;
  lang?: 'zh-CN' | 'en';
  url?: string;
  kind?: 'video' | 'audio';
  preview?: SubtitlePreviewFixture | { ok: false; code: string; message: string };
  enqueue?: unknown;
  now?: number;
  onInvoke?: (channel: string, payload: unknown) => unknown;
} = {}): SubtitleHarness {
  const sandbox: Record<string, any> = {};
  new Function('window', sources.messages)(sandbox);
  const catalogue = (sandbox as any)['YTVDLT_I18N'] as Catalogue;
  const locale = options.lang === 'en' ? 'en' : 'zh-CN';
  const table = catalogue.MESSAGES[locale] ?? {};

  const docListeners: Record<string, ((event?: unknown) => void)[]> = {};
  const doc: any = {
    visibilityState: 'visible',
    documentElement: new Node('html'),
    head: new Node('head'),
    body: new Node('body'),
    listeners: docListeners,
    addEventListener: (type: string, fn: (event?: unknown) => void) => {
      (docListeners[type] ??= []).push(fn);
    },
    fireKey: (type: string, event: unknown) => {
      (docListeners[type] ?? []).slice().forEach((fn) => fn(event));
    },
    dispatchEvent: () => true,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag: string) => new Node(tag),
    createTextNode: (text: string) => { const n = new Node('#text'); n.textContent = text; return n; },
  };
  const root = new Node('main');
  const form = new Node('form');
  const urlInput = new Node('input');
  urlInput.value = options.url ?? 'https://example.org/watch?v=abcdef';
  const pasteButton = new Node('button');
  const cards = new Node('div');
  const status = new Node('p');
  const registry: Record<string, Node> = {
    'queue-root': root,
    'queue-cards': cards,
    'queue-paste-form': form,
    'queue-url': urlInput,
    'queue-paste': pasteButton,
    'queue-status': status,
  };
  doc.getElementById = (id: string) => registry[id] ?? byId(doc.body, id) ?? null;

  sandbox.document = doc;
  sandbox.location = {
    search: (options.lang === 'en' ? '?lang=en' : '') + (options.kind === 'audio' ? '?kind=audio' : ''),
    href: 'file:///app/pages/queue/index.html',
    replace: () => undefined,
  };
  sandbox.localStorage = {
    getItem: () => null, setItem: () => undefined, removeItem: () => undefined,
  };
  sandbox.addEventListener = () => undefined;
  sandbox.Promise = Promise;
  sandbox.setTimeout = globalThis.setTimeout.bind(globalThis);
  sandbox.clearTimeout = globalThis.clearTimeout.bind(globalThis);
  sandbox.setInterval = globalThis.setInterval.bind(globalThis);
  sandbox.clearInterval = globalThis.clearInterval.bind(globalThis);
  sandbox.window = sandbox;

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
  // Pre-inject the real component factory, as a static <script> would do.
  new Function('window', sources.picker)(sandbox);

  const calls: { channel: string; payload: unknown }[] = [];
  let previewReply: unknown = options.preview ?? {
    ok: true,
    preview: {
      previewId: 'ticket-00000001',
      media: { title: 'Demo clip', uploader: 'Studio', durationSec: 125, extractorKey: 'Generic' },
      tracks: [track()],
      manualLanguages: 1, automaticLanguages: 0, empty: false,
      expiresAt: new Date((options.now ?? Date.now()) + 300_000).toISOString(),
    },
  };
  let enqueueReply: unknown = options.enqueue ?? { accepted: true, enqueued: true, taskIds: ['t-1'] };

  if (options.live !== false) {
    sandbox.ytvdltBridge = {
      invoke(channel: string, payload: unknown) {
        calls.push({ channel, payload });
        const custom = options.onInvoke?.(channel, payload);
        if (custom !== undefined) return Promise.resolve(custom);
        if (channel === 'ytvdlt:task:list') return Promise.resolve({ ok: true, items: [] });
        if (channel === 'ytvdlt:subtitle:preview') return Promise.resolve(previewReply);
        if (channel === 'ytvdlt:subtitle:previewCancel') return Promise.resolve({ ok: true, canceled: true });
        if (channel === 'ytvdlt:download:start') return Promise.resolve(enqueueReply);
        return Promise.resolve({ ok: true });
      },
    };
  } else {
    sandbox.__YTVDLT_TASKS__ = [];
  }

  new Function('window', sources.queue)(sandbox);
  const queue = sandbox['YTVDLTQueue'];
  const picker = queue.subtitlePicker();
  const modal = byId(doc.body, 'subtitle-modal') as Node;
  const entry = byId(form, 'queue-subtitle-open') as Node;

  return {
    doc, sandbox, queue, picker, calls, root, urlInput, form, body: doc.body as Node,
    modal, entry, status,
    setPreview(result: unknown) { previewReply = result; },
    setEnqueue(result: unknown) { enqueueReply = result; },
    setUrl(value: string) { urlInput.value = value; urlInput.fire('input', {}); },
    open() { entry.fire('click', { preventDefault() {}, stopPropagation() {} }); },
    async settle() { await vi.advanceTimersByTimeAsync(0); },
    findInModal(predicate: (n: Node) => boolean) { return find(modal, predicate); },
    modalText() { return modal.textContent; },
  };
}
