/**
 * D-187 · shared import-based harness for `packages/ui` scripts.
 *
 * The UI sources are classic `<script>` files with **no ES imports/exports**:
 * each one is an IIFE that receives the global `window` and attaches a
 * test/smoke surface to it (`YTVDLT*` keys, e.g. the queue's `mountTxtImport` /
 * `startRealDownload`, the star-prompt exposures added in D-148). Loading them
 * with a real `await import()` — instead of the `runInNewContext` sandbox the
 * older UI tests use — is what makes the v8 coverage provider see the code at
 * all: scripts executed inside a VM context never reach the coverage report
 * (measured before D-187: 63 statements across the whole UI package).
 *
 * The harness installs just enough browser globals for the modules to boot
 * under Node (fake `document` / `window` / `localStorage` / `location` …),
 * returns the fake node map, and snapshots which `YTVDLT*` keys the module
 * attached during import so tests can drive the exposed API directly.
 *
 * Module registry note: vitest isolates module registries per test file, so a
 * module imported here executes once per file — its boot side effects run at
 * import time and the returned API is the single instance tests drive.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface UiNode {
  tagName: string;
  textContent: string;
  value: string;
  innerHTML: string;
  disabled: boolean;
  hidden: boolean;
  checked: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  style: Record<string, string> & { setProperty(key: string, value: string): void };
  classList: {
    add(...names: string[]): void;
    remove(...names: string[]): void;
    toggle(name: string, force?: boolean): void;
    contains(name: string): boolean;
  };
  dataset: Record<string, string>;
  attrs: Record<string, string>;
  children: UiNode[];
  listeners: Record<string, ((event?: unknown) => void)[]>;
  setAttribute(key: string, value: string): void;
  getAttribute(key: string): string | null;
  removeAttribute(key: string): void;
  hasAttribute(key: string): boolean;
  addEventListener(type: string, fn: (event?: unknown) => void): void;
  removeEventListener(type: string, fn: (event?: unknown) => void): void;
  dispatch(type: string, event?: unknown): void;
  click(): void;
  appendChild(child: UiNode): UiNode;
  insertBefore(child: UiNode, ref?: UiNode | null): UiNode;
  removeChild(child: UiNode): UiNode;
  remove(): void;
  replaceChildren(...nodes: UiNode[]): void;
  focus(): void;
  blur(): void;
  querySelectorAll(selector: string): UiNode[];
}

/** A fake DOM element generous enough for the UI scripts' imperative needs. */
export function uiNode(tagName = 'div'): UiNode {
  const classes = new Set<string>();
  const listeners: Record<string, ((event?: unknown) => void)[]> = {};
  const children: UiNode[] = [];
  const node: UiNode = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    value: '',
    innerHTML: '',
    disabled: false,
    hidden: false,
    checked: false,
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 800,
    style: Object.assign(Object.create(null), {
      setProperty(key: string, value: string) { node.style[key] = value; },
      removeProperty(key: string) { delete node.style[key]; },
    }),
    classList: {
      add(...names: string[]) { for (const n of names) classes.add(n); },
      remove(...names: string[]) { for (const n of names) classes.delete(n); },
      toggle(name: string, force?: boolean) {
        const want = force === undefined ? !classes.has(name) : force;
        if (want) classes.add(name); else classes.delete(name);
      },
      contains(name: string) { return classes.has(name); },
    },
    dataset: {},
    attrs: {},
    children,
    listeners,
    setAttribute(key, value) { node.attrs[key] = value; },
    getAttribute(key) { return node.attrs[key] ?? null; },
    removeAttribute(key) { delete node.attrs[key]; },
    hasAttribute(key) { return key in node.attrs; },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) {
      const bucket = listeners[type] ?? [];
      const at = bucket.indexOf(fn);
      if (at >= 0) bucket.splice(at, 1);
    },
    dispatch(type, event) { for (const fn of listeners[type] ?? []) fn(event); },
    click() { node.dispatch('click'); },
    querySelector(selector: string): UiNode | null {
      const found = node.querySelectorAll(selector);
      return found.length > 0 ? found[0] : null;
    },
    appendChild(child) { children.push(child); return child; },
    insertBefore(child) { children.unshift(child); return child; },
    removeChild(child) {
      const at = children.indexOf(child);
      if (at >= 0) children.splice(at, 1);
      return child;
    },
    remove() { /* detached from parent by the test when needed */ },
    replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
    focus() { /* tracked by tests via listeners if needed */ },
    blur() { /* noop */ },
    querySelectorAll(selector) {
      // Minimal matcher: [data-x="y"], [data-x], #id, .class — enough for the
      // imperative queries the UI scripts make; tests extend when needed.
      const attr = /^\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/.exec(selector.trim());
      if (!attr) return [];
      const [, key, value] = attr;
      return children.filter((c) => value === undefined
        ? (c.attrs[key] ?? c.dataset[key.replace(/^data-/i, '').replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())]) !== undefined
        : (c.attrs[key] ?? c.dataset[key.replace(/^data-/i, '').replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())]) === value);
    },
  };
  return node;
}

export interface UiGlobalsOptions {
  /** Pre-seeded elements by id (auto-created on first query otherwise). */
  elements?: Record<string, UiNode>;
  /** Shape assigned to `window.ytvdltBridge` (null = static/no-bridge mode). */
  bridge?: { invoke(channel: string, payload?: unknown): Promise<unknown> } | null;
  /** `__YTVDLT_*` injected fixtures (`__YTVDLT_TASKS__`, `__YTVDLT_SETTINGS__`…). */
  injected?: Record<string, unknown>;
  /** `document.readyState` (defaults to 'complete'). */
  readyState?: string;
  /** Extra `YTVDLT*` collaborator stubs (theme/nav/shell/app-version…). */
  extraWindow?: Record<string, unknown>;
  /** window.location (defaults to a file:// queue-ish page with empty search). */
  location?: { href?: string; search?: string; protocol?: string };
}

export interface UiGlobals {
  window: Record<string, any>;
  document: Record<string, any>;
  nodes: Map<string, UiNode>;
  /** `YTVDLT*`-style keys attached to the fake window (filled during import). */
  attached: Record<string, unknown>;
  bridgeCalls: Array<{ channel: string; payload: unknown }>;
  restore(): void;
}

const ORIGINAL: Record<string, { existed: boolean; value?: unknown }> = {};

/**
 * Synchronous-XHR stand-in for `fixtures/probe-fixture.js` (D-170 CSP allows
 * `connect-src file:` precisely because that loader reads the recorded L1
 * dialog JSONs with a sync XHR — handbook pit 34). Each requested path is
 * resolved exactly the way the browser resolves it — relative to
 * `packages/ui/src/fixtures/`, where the loader's `../../../../tests/e2e/`
 * base then lands on the real recorded JSONs — so the dialogs boot with
 * genuine recorded data, not invented shapes.
 */
class FakeXMLHttpRequest {
  status = 0;
  readyState = 0;
  responseText = '';
  private url = '';
  open(_method: string, url: string, _sync?: boolean): void { this.url = url; }
  send(): void {
    try {
      this.responseText = readFileSync(resolve('packages/ui/src/fixtures', this.url), 'utf8');
      this.status = 200;
    } catch {
      this.status = 404;
    }
    this.readyState = 4;
  }
}

function setGlobal(key: string, value: unknown): void {
  // Node ≥21 exposes `navigator` (and ≥22 `localStorage`) as getter-only
  // built-ins — a plain assignment throws, so every install goes through
  // defineProperty; `configurable` keeps `restore()` able to undo it.
  Object.defineProperty(globalThis, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

/**
 * Installs fake browser globals on the Node worker. Per-file vitest isolation
 * means each test file starts from a clean module registry; call this before
 * the first `loadUiModule()` of the file (typically in `beforeAll`) and
 * `restore()` in `afterAll`.
 */
export function installUiGlobals(options: UiGlobalsOptions = {}): UiGlobals {
  const nodes = new Map<string, UiNode>();
  for (const [id, node] of Object.entries(options.elements ?? {})) nodes.set(id, node);
  const bridgeCalls: Array<{ channel: string; payload: unknown }> = [];
  const attached: Record<string, unknown> = {};

  const document: Record<string, any> = {
    readyState: options.readyState ?? 'complete',
    getElementById(id: string): UiNode {
      if (!nodes.has(id)) nodes.set(id, uiNode());
      return nodes.get(id) as UiNode;
    },
    createElement(tag = 'div'): UiNode { return uiNode(tag); },
    createTextNode(text: string): UiNode { const n = uiNode('#text'); n.textContent = text; return n; },
    // Boot-time lookups the pages make before any test drives them. Returning
    // a fresh node keeps imperative callers alive; behavioural tests override
    // these per scenario when they need specific elements back.
    querySelector(_selector: string): UiNode { return uiNode(); },
    querySelectorAll(_selector: string): UiNode[] { return [] },
    addEventListener(_type: string, _fn: (event?: unknown) => void): void { /* document-level listeners tracked per test */ },
    removeEventListener(_type: string, _fn: (event?: unknown) => void): void { /* noop */ },
    body: uiNode('body'),
    documentElement: uiNode('html'),
    head: uiNode('head'),
  };

  const localStorageData = new Map<string, string>();
  const localStorage = {
    getItem(key: string): string | null { return localStorageData.get(key) ?? null; },
    setItem(key: string, value: string): void { localStorageData.set(key, String(value)); },
    removeItem(key: string): void { localStorageData.delete(key); },
    clear(): void { localStorageData.clear(); },
  };

  const location = {
    href: options.location?.href ?? 'file:///C:/app/pages/queue/index.html',
    search: options.location?.search ?? '',
    protocol: options.location?.protocol ?? 'file:',
  };

  const bridge = options.bridge === undefined
    ? null
    : (options.bridge === null
      ? null
      : {
        invoke(channel: string, payload?: unknown): Promise<unknown> {
          bridgeCalls.push({ channel, payload });
          return options.bridge!.invoke(channel, payload);
        },
      });

  const winListeners: Record<string, ((event?: unknown) => void)[]> = {};
  const win: Record<string, any> = {
    document,
    location,
    localStorage,
    addEventListener(type: string, fn: (event?: unknown) => void): void {
      (winListeners[type] ??= []).push(fn);
    },
    removeEventListener(type: string, fn: (event?: unknown) => void): void {
      const bucket = winListeners[type] ?? [];
      const at = bucket.indexOf(fn);
      if (at >= 0) bucket.splice(at, 1);
    },
    dispatch(type: string, event?: unknown): void {
      for (const fn of winListeners[type] ?? []) fn(event);
    },
    navigator: { userAgent: 'vitest-ui-harness', clipboard: undefined },
    requestAnimationFrame(cb: () => void): number {
      return setTimeout(() => cb(), 0) as unknown as number;
    },
    getComputedStyle(el: UiNode) {
      return { getPropertyValue: (key: string) => el.style?.[key] ?? '' };
    },
    matchMedia(): { matches: boolean; addEventListener(): void; addListener(): void } {
      return { matches: false, addEventListener() { /* noop */ }, addListener() { /* noop */ } };
    },
    ...options.extraWindow,
  };
  if (bridge !== null) win.ytvdltBridge = bridge;
  for (const [key, value] of Object.entries(options.injected ?? {})) win[key] = value;

  // Snapshot the keys that exist BEFORE import so `attached` can be derived.
  const before = new Set(Object.keys(win));
  (win as any).__uiHarnessSnapshot = () => {
    const added: Record<string, unknown> = {};
    for (const key of Object.keys(win)) {
      if (!before.has(key) && key !== '__uiHarnessSnapshot') added[key] = win[key];
    }
    return added;
  };

  const globalsToInstall: Record<string, unknown> = {
    window: win,
    document,
    localStorage,
    location,
    navigator: win.navigator,
    XMLHttpRequest: FakeXMLHttpRequest,
  };
  for (const [key, value] of Object.entries(globalsToInstall)) {
    if (!(key in ORIGINAL)) {
      ORIGINAL[key] = { existed: key in globalThis, value: (globalThis as any)[key] };
    }
    setGlobal(key, value);
  }

  return {
    window: win,
    document,
    nodes,
    attached,
    bridgeCalls,
    restore() {
      for (const [key, record] of Object.entries(ORIGINAL)) {
        if (record.existed) setGlobal(key, record.value);
        else delete (globalThis as any)[key];
      }
    },
  };
}

/**
 * Loads a UI source module with a real `import()` so the v8 coverage provider
 * instruments it. `relPath` is relative to `packages/ui/src/`. After the
 * import, `globals.attached` carries the `YTVDLT*` keys the module added to
 * the fake window (populated lazily via `collectAttached()` below).
 */
export async function loadUiModule(relPath: string, globals: UiGlobals): Promise<Record<string, unknown>> {
  for (const key of Object.keys(globals.attached)) delete globals.attached[key];
  const url = pathToFileURL(resolve('packages/ui/src', relPath)).href;
  const ns = await import(url);
  const snapshot = (globals.window as any).__uiHarnessSnapshot as () => Record<string, unknown>;
  for (const [key, value] of Object.entries(snapshot())) globals.attached[key] = value;
  return ns;
}
