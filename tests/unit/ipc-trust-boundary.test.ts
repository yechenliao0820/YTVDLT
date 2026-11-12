/**
 * D-137 (F-04) — IPC caller / page boundary. L0 pure functions: no Electron
 * binary, no network, no real window. The bootstrap wiring itself is asserted in
 * bootstrap.test.ts; here we pin down the ACCEPT / REFUSE predicate.
 */
import { describe, it, expect } from 'vitest';
import {
  assertTrustedIpcSender, isTrustedLocalPage, type BrowserWindowLike,
} from '../../apps/desktop/src/main/bootstrap.js';

const PAGE_URL = 'file:///app/pages/queue/index.html';
const SETTINGS_URL = 'file:///app/pages/settings/index.html';
const webContents = { id: 'the-one-window' };
const otherWebContents = { id: 'some-other-window' };

function windowWith(sender: unknown): BrowserWindowLike {
  return { webContents: sender } as unknown as BrowserWindowLike;
}

function invocation(frame: {
  readonly url?: string;
  readonly parent?: unknown;
} | null, sender: unknown = webContents) {
  return { sender, senderFrame: frame };
}

describe('D-137 · trusted local page predicate', () => {
  it('accepts local pages, the settings page and locale reloads', () => {
    expect(isTrustedLocalPage(PAGE_URL, PAGE_URL)).toBe(true);
    expect(isTrustedLocalPage(SETTINGS_URL, PAGE_URL)).toBe(true);
    expect(isTrustedLocalPage(`${PAGE_URL}?lang=en&prefill=x`, PAGE_URL)).toBe(true);
  });

  it('accepts the packaged app scheme without allowing remote origins', () => {
    expect(isTrustedLocalPage('app://queue?lang=en', 'app://queue')).toBe(true);
    expect(isTrustedLocalPage('https://evil.test/', 'app://queue')).toBe(false);
    expect(isTrustedLocalPage('https://evil.test/', PAGE_URL)).toBe(false);
  });

  it('refuses executable/data URLs, cross-scheme pages and malformed input', () => {
    expect(isTrustedLocalPage('javascript:alert(1)', PAGE_URL)).toBe(false);
    expect(isTrustedLocalPage('data:text/html,<script>', PAGE_URL)).toBe(false);
    expect(isTrustedLocalPage('http://127.0.0.1/', PAGE_URL)).toBe(false);
    expect(isTrustedLocalPage('', PAGE_URL)).toBe(false);
    expect(isTrustedLocalPage('not a url', PAGE_URL)).toBe(false);
  });
});

describe('D-137 · IPC sender assertion', () => {
  it('accepts the application window main frame on a local page', () => {
    expect(() => assertTrustedIpcSender(
      invocation({ url: PAGE_URL, parent: null }), windowWith(webContents), PAGE_URL,
    )).not.toThrow();
  });

  it('refuses another webContents, a subframe and a missing frame', () => {
    const window = windowWith(webContents);
    expect(() => assertTrustedIpcSender(
      invocation({ url: PAGE_URL, parent: null }, otherWebContents), window, PAGE_URL,
    )).toThrow(/sender is not the application window/);
    expect(() => assertTrustedIpcSender(
      invocation({ url: PAGE_URL, parent: {} }), window, PAGE_URL,
    )).toThrow(/subframe/);
    expect(() => assertTrustedIpcSender(
      invocation(null), window, PAGE_URL,
    )).toThrow(/no sender frame/);
    expect(() => assertTrustedIpcSender(
      { senderFrame: undefined, sender: webContents }, window, PAGE_URL,
    )).toThrow(/no sender frame/);
  });

  it('refuses a remote page and a missing invocation context', () => {
    const window = windowWith(webContents);
    expect(() => assertTrustedIpcSender(
      invocation({ url: 'https://evil.test/', parent: null }), window, PAGE_URL,
    )).toThrow(/untrusted page/);
    expect(() => assertTrustedIpcSender(null, window, PAGE_URL))
      .toThrow(/no invocation context/);
    expect(() => assertTrustedIpcSender(undefined, window, PAGE_URL))
      .toThrow(/no invocation context/);
    expect(() => assertTrustedIpcSender(
      { senderFrame: { url: PAGE_URL, parent: null } }, window, PAGE_URL,
    )).toThrow(/sender is not the application window/);
  });

  it('still verifies the frame when no window reference is available', () => {
    expect(() => assertTrustedIpcSender(
      invocation({ url: PAGE_URL, parent: null }), null, PAGE_URL,
    )).not.toThrow();
    expect(() => assertTrustedIpcSender(
      invocation({ url: 'https://evil.test/', parent: null }), null, PAGE_URL,
    )).toThrow(/untrusted page/);
  });
});
