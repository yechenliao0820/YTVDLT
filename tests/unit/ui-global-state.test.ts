/**
 * D-106 · global UI state (A-4.4-20 / A-M5-00).
 *
 * The shipped browser scripts have no bundler, so this test executes the REAL
 * `theme.js` / `app-nav.js` with a fake `window` and audits the four behaviours
 * the owner reported broken:
 *   1. one theme state shared by every page, persisted to config.json AND a
 *      synchronous local cache (no light flash on page jumps / restarts);
 *   2. query overrides still win (frozen screenshot renders);
 *   3. navigation builds a deterministic queue/settings URL and keeps the
 *      queue view (tab / search / sort / kind / selection / scroll);
 *   4. fullscreen goes through ONE window-level IPC channel, never two states.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const UI_SRC = join(ROOT, 'packages', 'ui', 'src');
const themeSource = readFileSync(join(UI_SRC, 'theme', 'theme.js'), 'utf8');
const navSource = readFileSync(join(UI_SRC, 'shell', 'app-nav.js'), 'utf8');

interface Call { channel: string; payload: Record<string, unknown> }
interface FakeButton {
  id: string;
  textContent: string;
  attrs: Record<string, string>;
  listeners: Record<string, (() => void)[]>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  addEventListener(type: string, fn: () => void): void;
}

function fakeButton(id: string): FakeButton {
  const attrs: Record<string, string> = {};
  const listeners: Record<string, (() => void)[]> = {};
  return {
    id,
    textContent: '',
    attrs,
    listeners,
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return attrs[k] ?? null; },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
  };
}

function fakeElement(tag: string): any {
  const base: any = fakeButton(tag);
  base.children = [];
  base.firstChild = null;
  base.appendChild = (child: unknown) => { base.children.push(child); };
  base.insertBefore = () => { /* no-op */ };
  return base;
}

interface Harness {
  sandbox: Record<string, any>;
  theme: any;
  nav: any;
  attrs: Map<string, string>;
  calls: Call[];
  replies: Record<string, unknown>;
  buttons: Map<string, FakeButton>;
  windowListeners: Record<string, ((event: unknown) => void)[]>;
  docListeners: Record<string, ((event: unknown) => void)[]>;
  local: Map<string, string>;
  session: Map<string, string>;
}

function harness(options: {
  search?: string;
  href?: string;
  pathname?: string;
  local?: Record<string, string>;
  session?: Record<string, string>;
  prefersDark?: boolean;
  bridge?: boolean;
} = {}): Harness {
  const attrs = new Map<string, string>();
  const styleProps = new Map<string, string>();
  const calls: Call[] = [];
  const replies: Record<string, unknown> = {};
  const buttons = new Map<string, FakeButton>();
  const windowListeners: Record<string, ((event: unknown) => void)[]> = {};
  const docListeners: Record<string, ((event: unknown) => void)[]> = {};
  const local = new Map<string, string>(Object.entries(options.local ?? {}));
  const session = new Map<string, string>(Object.entries(options.session ?? {}));

  const storage = (backing: Map<string, string>) => ({
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => { backing.set(k, String(v)); },
    removeItem: (k: string) => { backing.delete(k); },
  });

  const documentElement = {
    setAttribute(k: string, v: string) { attrs.set(k, String(v)); },
    removeAttribute(k: string) { attrs.delete(k); },
    getAttribute(k: string) { return attrs.get(k) ?? null; },
    style: {
      setProperty(k: string, v: string) { styleProps.set(k, v); },
      removeProperty(k: string) { styleProps.delete(k); },
    },
  };

  const host = fakeElement('queue-root');
  buttons.set('queue-root', host);
  const doc = {
    documentElement,
    readyState: 'loading',
    getElementById(id: string) { return buttons.get(id) ?? null; },
    createElement(tag: string) { return fakeElement(tag); },
    insertBefore() { /* no-op */ },
    appendChild() { /* no-op */ },
    addEventListener(type: string, fn: (event: unknown) => void) {
      (docListeners[type] ??= []).push(fn);
    },
    dispatchEvent() { return true; },
  };

  const sandbox: Record<string, any> = {
    document: doc,
    location: {
      search: options.search ?? '',
      href: options.href ?? 'file:///C:/app/pages/queue/index.html',
      pathname: options.pathname ?? '/C:/app/pages/queue/index.html',
      assign() { /* no-op */ },
    },
    localStorage: storage(local),
    sessionStorage: storage(session),
    matchMedia(q: string) {
      return {
        matches: q.indexOf('prefers-color-scheme: dark') !== -1 && options.prefersDark === true,
        addEventListener() { /* no-op */ },
        removeEventListener() { /* no-op */ },
      };
    },
    addEventListener(type: string, fn: (event: unknown) => void) {
      (windowListeners[type] ??= []).push(fn);
    },
    removeEventListener() { /* no-op */ },
    URLSearchParams,
    Promise,
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(type: string, init: { detail?: unknown } = {}) { this.type = type; this.detail = init.detail; }
    },
  };
  if (options.bridge !== false) {
    sandbox.ytvdltBridge = {
      invoke(channel: string, payload: Record<string, unknown>) {
        calls.push({ channel, payload });
        return Promise.resolve(replies[channel] ?? { ok: true });
      },
    };
  }
  sandbox.window = sandbox;
  // eslint-disable-next-line no-new-func
  new Function('window', themeSource)(sandbox);
  // eslint-disable-next-line no-new-func
  new Function('window', navSource)(sandbox);
  // Force the shell install so keydown / fullscreenchange listeners exist, as
  // they do in a real page. DOMContentLoaded is never fired by the fake doc.
  (sandbox.YTVDLTNav as { install: () => void }).install();
  return {
    sandbox, theme: sandbox.YTVDLTTheme, nav: sandbox.YTVDLTNav,
    attrs, calls, replies, buttons, windowListeners, docListeners, local, session,
  };
}

describe('D-106 · one global appearance state', () => {
  it('ships the neutral default with no data-* attribute (M3 baseline)', () => {
    const h = harness({ bridge: false });
    expect(h.theme.state().theme).toBe('system');
    expect(h.theme.state().accent).toBe('system');
    expect(h.attrs.has('data-theme')).toBe(false);
  });

  it('query overrides beat both the local cache and injected settings', () => {
    const h = harness({ search: '?theme=dark&accent=teal', local: { 'ytvdlt.appearance': JSON.stringify({ theme: 'light' }) } });
    expect(h.attrs.get('data-theme')).toBe('dark');
    expect(h.attrs.get('data-accent')).toBe('teal');
    expect(h.theme.state().theme).toBe('dark');
  });

  it('set() writes the local cache, repaints and persists through SETTINGS_SET', async () => {
    const h = harness();
    h.theme.set({ theme: 'dark', accent: 'violet' });
    expect(h.attrs.get('data-theme')).toBe('dark');
    expect(h.attrs.get('data-accent')).toBe('violet');
    expect(JSON.parse(h.local.get('ytvdlt.appearance') ?? '{}')).toMatchObject({ theme: 'dark', accent: 'violet' });
    await Promise.resolve();
    expect(h.calls).toEqual([{ channel: 'ytvdlt:settings:set', payload: { theme: 'dark', accent: 'violet' } }]);
  });

  it('a fresh page (restart / navigation) starts dark with no light flash', () => {
    const first = harness();
    first.theme.set({ theme: 'dark' });
    const snapshot = first.local.get('ytvdlt.appearance') ?? '{}';
    const second = harness({ bridge: false, local: { 'ytvdlt.appearance': snapshot } });
    expect(second.attrs.get('data-theme')).toBe('dark');
  });

  it('sync() re-reads config.json and never overrides a query render', async () => {
    const h = harness();
    h.replies['ytvdlt:settings:get'] = { theme: 'dark', accent: 'teal', motion: 'reduced', systemAccent: null };
    const result = await h.theme.sync();
    expect(result).toMatchObject({ theme: 'dark', accent: 'teal', motion: 'reduced' });
    expect(h.attrs.get('data-theme')).toBe('dark');
    expect(h.attrs.get('data-motion')).toBe('reduced');
    expect(JSON.parse(h.local.get('ytvdlt.appearance') ?? '{}').theme).toBe('dark');

    const queried = harness({ search: '?theme=light' });
    expect(await queried.theme.sync()).toBeNull();
    expect(queried.calls.some((c) => c.channel === 'ytvdlt:settings:get')).toBe(false);
  });

  it('跟随系统 resolves from the OS media query, not a stale page value', () => {
    const h = harness({ prefersDark: true, bridge: false });
    expect(h.attrs.get('data-theme')).toBe('dark');
  });

  it('an in-flight sync() cannot overwrite a newer user choice', async () => {
    const h = harness();
    h.replies['ytvdlt:settings:get'] = { theme: 'light', accent: 'blue', motion: 'full' };
    h.theme.set({ theme: 'dark' });
    expect(await h.theme.sync()).toBeNull();
    expect(h.attrs.get('data-theme')).toBe('dark');
  });

  it('a storage event from another window repaints this one', () => {
    const h = harness({ bridge: false });
    h.local.set('ytvdlt.appearance', JSON.stringify({ theme: 'dark' }));
    h.theme.listen();
    (h.windowListeners['storage'] ?? []).forEach((fn) => fn({ key: 'ytvdlt.appearance' }));
    expect(h.attrs.get('data-theme')).toBe('dark');
  });
});

describe('D-106 · navigation, view state and one fullscreen authority', () => {
  it('builds a clean queue URL from the settings page, keeping only lang/v', () => {
    const h = harness({
      href: 'file:///C:/app/pages/settings/index.html?case=settings-appearance&lang=en&v=0.2.3',
      search: '?case=settings-appearance&lang=en&v=0.2.3',
      pathname: '/C:/app/pages/settings/index.html',
    });
    expect(h.nav.pageUrl('queue')).toBe('file:///C:/app/pages/queue/index.html?lang=en&v=0.2.3');
    expect(h.nav.pageUrl('settings')).toBe('file:///C:/app/pages/settings/index.html?lang=en&v=0.2.3');
  });

  it('round-trips the queue view (tab / search / sort / kind / selection / scroll)', () => {
    const h = harness({ bridge: false });
    const view = { tab: 'finished', query: 'lofi', sort: 'name', kind: 'audio', selected: ['t-1'], scroll: 340 };
    expect(h.nav.saveView(view)).toBe(true);
    expect(h.session.has('ytvdlt.queue.view')).toBe(true);
    expect(h.nav.restoreView()).toEqual(view);
  });

  it('go() runs the leave callbacks before navigating so state is never lost', () => {
    const h = harness({ bridge: false });
    const seen: string[] = [];
    h.nav.onLeave(() => { seen.push('saved'); });
    h.sandbox.location.assign = () => { seen.push('navigated'); };
    h.nav.go('settings');
    expect(seen).toEqual(['saved', 'navigated']);
  });

  it('toggleFullscreen asks the ONE window channel and follows its reply', async () => {
    const h = harness();
    const button = fakeButton('ytvdlt-nav-fullscreen');
    h.buttons.set('ytvdlt-nav-fullscreen', button);
    h.nav.bindFullscreenButton('ytvdlt-nav-fullscreen');
    h.replies['ytvdlt:window:fullscreen'] = { ok: true, fullscreen: true };
    h.sandbox.location.href = 'file:///C:/app/pages/queue/index.html';
    await h.sandbox.YTVDLTShell.toggleFullscreen();
    expect(h.calls).toEqual([{ channel: 'ytvdlt:window:fullscreen', payload: { action: 'set', value: true } }]);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('data-fullscreen')).toBe('true');
    expect(button.textContent).toContain('退出全屏');
  });

  it('Escape exits fullscreen, and the main-process push updates the button', async () => {
    const h = harness();
    const button = fakeButton('ytvdlt-nav-fullscreen');
    h.buttons.set('ytvdlt-nav-fullscreen', button);
    h.nav.bindFullscreenButton('ytvdlt-nav-fullscreen');
    h.sandbox.YTVDLTShell.setFullscreenState(true);
    const keyHandlers = h.docListeners['keydown'] ?? [];
    expect(keyHandlers.length).toBeGreaterThan(0);
    keyHandlers.forEach((fn) => fn({ key: 'Escape', preventDefault() { /* no-op */ } }));
    await Promise.resolve();
    expect(h.calls[h.calls.length - 1]).toEqual({ channel: 'ytvdlt:window:fullscreen', payload: { action: 'set', value: false } });
  });

  it('without a bridge it degrades to the HTML Fullscreen API (static preview)', () => {
    const h = harness({ bridge: false });
    h.nav.toggleFullscreen();
    expect(h.calls).toEqual([]);
    expect(h.nav.state.fullscreen).toBe(true);
  });
});
