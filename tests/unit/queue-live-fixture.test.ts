/**
 * D-141 · live mode must never paint the screenshot fixture.
 *
 * The queue page ships six deterministic sample rows so the screenshot suite
 * renders identically on every machine. In live mode those rows leaked into the
 * real window: boot ran a synchronous `render()` before the first `TASK_LIST`
 * reply, so `live.tasks` was still `null` and `tasks()` fell back to the
 * fixture. Every launch flashed six fake downloads, and because a language
 * switch is a full page reload it happened there too — most visible on a fresh
 * install that had never downloaded anything.
 *
 * These cases execute the REAL `queue.js` (shared fake-DOM harness) and pin the
 * three states a live boot may show: unknown (blank), the real list, or an
 * admitted failure — never the fixture.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { harness, dto, onlyCard } from './helpers/queue-page-harness.js';

afterEach(() => { vi.useRealTimers(); });

describe('D-141 · live boot paints nothing until the queue is known', () => {
  it('shows no cards (not the six sample rows) before the first reply', async () => {
    vi.useFakeTimers();
    const h = harness({ live: true, items: [] });
    expect(h.cards.children.length).toBe(0);
    expect(h.root.getAttribute('data-state')).toBe('loading');
  });

  it('lands on the real empty state when the queue really is empty', async () => {
    vi.useFakeTimers();
    const h = harness({ live: true, items: [] });
    await h.settle();
    expect(h.cards.children.length).toBe(0);
    expect(h.root.getAttribute('data-state')).toBe('empty');
  });

  it('paints only the real tasks once the reply lands', async () => {
    vi.useFakeTimers();
    const h = harness({ live: true, items: [dto({ percent: 42, downloadedBytes: 1024, totalBytes: 2048 })] });
    await h.settle();
    expect(h.cards.children.length).toBe(1);
    expect(h.root.getAttribute('data-state')).toBe('ready');
    expect(onlyCard(h).textContent).toContain('42');
  });

  it('keeps the sample rows out of the window across a language switch', async () => {
    vi.useFakeTimers();
    // Boot #1: the page the user is looking at when they click EN.
    const first = harness({
      live: true, withLanguageButtons: true,
      items: [dto({ percent: 42, downloadedBytes: 1024, totalBytes: 2048 })],
    });
    await first.settle();
    expect(first.cards.children.length).toBe(1);
    first.clickLanguage('en');
    expect(first.replacedUrl()).toContain('lang=en');

    // Boot #2: `location.replace()` reloads the page. The reload used to paint
    // the six fixture rows again — on a brand-new install with zero tasks.
    const reloaded = harness({ live: true, items: [], storedLocale: 'en', withLanguageButtons: true });
    expect(reloaded.cards.children.length).toBe(0);
    expect(reloaded.root.getAttribute('data-state')).toBe('loading');
    await reloaded.settle();
    expect(reloaded.cards.children.length).toBe(0);
    expect(reloaded.root.getAttribute('data-state')).toBe('empty');
  });

  it('admits failure instead of hanging blank when the first reply never lands', async () => {
    vi.useFakeTimers();
    const h = harness({
      live: true,
      items: [],
      onInvoke: (channel) => (channel === 'ytvdlt:task:list' ? new Promise(() => {}) : undefined),
    });
    expect(h.root.getAttribute('data-state')).toBe('loading');
    await vi.advanceTimersByTimeAsync(2600);
    // The watchdog must surface the retry state, not leave an empty shell.
    expect(h.root.getAttribute('data-state')).toBe('error');
    expect(h.cards.children.length).toBe(0);
  });

  it('recovers when a slow reply arrives after the watchdog fired', async () => {
    vi.useFakeTimers();
    let release: (value: unknown) => void = () => {};
    const h = harness({
      live: true,
      items: [dto({ percent: 7 })],
      onInvoke: (channel) => {
        if (channel !== 'ytvdlt:task:list') return undefined;
        return new Promise((resolve) => { release = resolve; });
      },
    });
    await vi.advanceTimersByTimeAsync(2600);
    expect(h.root.getAttribute('data-state')).toBe('error');
    release({ ok: true, items: [dto({ percent: 7 })] });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.root.getAttribute('data-state')).toBe('ready');
    expect(h.cards.children.length).toBe(1);
  });
});
