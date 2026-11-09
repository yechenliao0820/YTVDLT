/**
 * D-114: the renderer's single source of truth for "which build is running".
 *
 * The bug this replaces: the version only travelled as `?v=`, so any navigation
 * that rebuilt the URL dropped it and the About box / footer / Settings fell
 * back to a hard-coded `0.2.2`. These tests cover the three sources in order of
 * authority (APP_INFO > URL hint > unknown) and the honesty rule: no value is
 * ever invented.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeNode } from './helpers/queue-page-harness.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE = readFileSync(join(ROOT, 'packages', 'ui', 'src', 'shell', 'app-version.js'), 'utf8');

interface Page {
  version(): string;
  label(): string;
  source(): string;
  query(): string;
  refresh(): Promise<string>;
  onChange(fn: (version: string, label: string) => void): () => void;
  /** Read back one of the painted placeholders. */
  painted(id: string): string;
}

function loadPage(options: {
  search?: string;
  reply?: { version?: string } | null;
  bridgeFails?: boolean;
  noBridge?: boolean;
} = {}): Page {
  const nodes: Record<string, FakeNode> = {
    'queue-version': new FakeNode('span'),
    'settings-meta': new FakeNode('span'),
    'about-version': new FakeNode('span'),
  };
  const sandbox: Record<string, any> = {};
  sandbox.document = {
    documentElement: new FakeNode('html'),
    getElementById: (id: string) => nodes[id] ?? null,
  };
  sandbox.location = { search: options.search ?? '' };
  if (options.noBridge !== true) {
    sandbox.ytvdltBridge = {
      invoke: () => (options.bridgeFails === true
        ? Promise.reject(new Error('channel unavailable'))
        : Promise.resolve(options.reply === undefined ? { version: '' } : options.reply)),
    };
  }
  sandbox.window = sandbox;
  new Function('window', SOURCE)(sandbox);
  const api = sandbox['YTVDLTAppVersion'] as Page;
  return {
    ...api,
    version: api.version,
    label: api.label,
    painted: (id: string) => nodes[id]?.textContent ?? '',
  } as Page;
}

describe('D-114 app version registry', () => {
  it('shows the URL hint on the first frame (no flash of "—")', () => {
    const page = loadPage({ search: '?v=0.2.5&lang=zh-CN', noBridge: true });
    expect(page.version()).toBe('0.2.5');
    expect(page.label()).toBe('v0.2.5');
    expect(page.painted('queue-version')).toBe('v0.2.5');
  });

  it('shows an explicit placeholder when nothing is known', () => {
    const page = loadPage({ search: '', noBridge: true });
    expect(page.version()).toBe('');
    expect(page.label()).toBe('v—');
    expect(page.painted('queue-version')).toBe('v—');
    expect(page.painted('about-version')).toBe('—');
  });

  it('never invents a version — the old 0.2.2 literal is gone', () => {
    const page = loadPage({ search: '', reply: { version: '' } });
    expect(page.version()).toBe('');
    expect(page.label()).not.toContain('0.2.2');
  });

  it('the main process wins over the URL hint, even when they disagree', async () => {
    const page = loadPage({ search: '?v=0.2.5', reply: { version: '9.9.9' } });
    expect(page.version()).toBe('0.2.5');
    await Promise.resolve();
    await Promise.resolve();
    expect(page.version()).toBe('9.9.9');
    expect(page.painted('settings-meta')).toBe('v9.9.9');
    expect(page.source()).toBe('ipc');
  });

  it('an empty authoritative answer clears a stale hint instead of keeping it', async () => {
    const page = loadPage({ search: '?v=0.2.2', reply: { version: '' } });
    await page.refresh();
    expect(page.version()).toBe('');
    expect(page.label()).toBe('v—');
  });

  it('a failed channel keeps the hint (no downgrade to "unknown")', async () => {
    const page = loadPage({ search: '?v=0.2.5', bridgeFails: true });
    await page.refresh().catch(() => undefined);
    expect(page.version()).toBe('0.2.5');
  });

  it('rejects a malformed / oversized version string', async () => {
    const page = loadPage({ search: '', reply: { version: 'x'.repeat(200) } });
    await page.refresh();
    expect(page.version()).toBe('');
  });

  it('notifies listeners so an open About box repaints without a reload', async () => {
    const page = loadPage({ search: '', reply: { version: '1.0.0' } });
    const seen: string[] = [];
    page.onChange((_version, label) => seen.push(label));
    await page.refresh();
    expect(seen).toEqual(['v1.0.0']);
  });

  it('exposes an encoded query value for navigation helpers', () => {
    const page = loadPage({ search: '?v=0.2.5', noBridge: true });
    expect(page.query()).toBe('0.2.5');
  });

  it('asks the main process at most once per page load', async () => {
    const spy = vi.fn(() => Promise.resolve({ version: '0.2.5' }));
    const sandbox: Record<string, any> = {};
    sandbox.document = {
      documentElement: new FakeNode('html'),
      getElementById: () => null,
    };
    sandbox.location = { search: '' };
    sandbox.ytvdltBridge = { invoke: spy };
    sandbox.window = sandbox;
    new Function('window', SOURCE)(sandbox);
    const api = sandbox['YTVDLTAppVersion'] as Page;
    await api.refresh();
    await api.refresh();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
