/**
 * D-107 · queue card progress truthfulness (A-4.4-16 / A-4.4-21).
 *
 * Executes the REAL `queue.js` (plus the real `messages.js` and `app-shell.js`)
 * against the shared fake DOM from `helpers/queue-page-harness.ts` and audits:
 *
 *   1. Running + unknown percent keeps the D-102 wait animation — never "0.0%";
 *   2. a REAL 0 is legal data and renders as `0.0%` (null and 0 are different);
 *   3. real bytes without a percent are shown, no total/percent is invented;
 *   4. Canceled / Error without a number get an inert track (terminal wins);
 *   5. Idle / FetchingInfo / ReadyWithInfo each show their own stage copy;
 *   6. the live poll keeps `null` across `toTask()` and repaints on null → 0 → 42.5.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  harness, cardTask, dto, onlyCard, barOf, progressOf, hintOf, FakeNode,
} from './helpers/queue-page-harness.js';

describe('D-107 · Running with an unknown percent keeps the wait animation', () => {
  it('renders the indeterminate bar and never invents 0.0%', () => {
    const card = onlyCard(harness({ items: [cardTask({ percent: null })] }));
    expect(card.getAttribute('data-progress-mode')).toBe('unknown');
    const bar = barOf(card);
    expect(bar.getAttribute('data-mode')).toBe('indeterminate');
    expect(bar.getAttribute('data-percent')).toBeNull();
    expect(bar.getAttribute('role')).toBe('progressbar');
    expect(bar.getAttribute('aria-label')).toBe('正在准备，进度未知');
    expect(progressOf(card).textContent).toBe('准备下载');
    expect(card.textContent).not.toContain('%');
  });

  it('keeps the D-102 segment: one <i> with a stable id-derived phase', () => {
    const first = onlyCard(harness({ items: [cardTask({ percent: null })] }));
    const second = onlyCard(harness({ items: [cardTask({ percent: null })] }));
    const segment = (card: FakeNode): FakeNode | undefined => barOf(card).children[0];
    expect(barOf(first).children).toHaveLength(1);
    expect(segment(first)?.style['animationDelay']).toMatch(/^-\d+ms$/);
    expect(segment(first)?.style['animationDelay']).toBe(segment(second)?.style['animationDelay']);
  });

  it('shows real bytes while the percent is still unknown', () => {
    const card = onlyCard(harness({ items: [cardTask({ percent: null, downloadedBytes: 2048 })] }));
    expect(card.getAttribute('data-progress-mode')).toBe('unknown');
    expect(barOf(card).getAttribute('data-mode')).toBe('indeterminate');
    expect(progressOf(card).textContent).toBe('已下载 2.0 KB · 正在获取下载进度');
    expect(card.textContent).not.toContain('%');
  });
});

describe('D-107 · a real 0 is data, not "unknown"', () => {
  it('renders 0.0% with a numeric bar when the backend reported 0', () => {
    const card = onlyCard(harness({ items: [cardTask({ percent: 0 })] }));
    expect(card.getAttribute('data-progress-mode')).toBe('value');
    const bar = barOf(card);
    expect(bar.getAttribute('data-percent')).toBe('0');
    expect(bar.getAttribute('data-mode')).toBeNull();
    expect(progressOf(card).getAttribute('data-progress')).toBe('0');
    expect(progressOf(card).textContent).toBe('0.0%');
  });

  it('adds real bytes to a rounded-down 0.0% without inventing a number', () => {
    const card = onlyCard(harness({ items: [cardTask({ percent: 0, downloadedBytes: 1024, totalBytes: 1048576 })] }));
    expect(progressOf(card).textContent).toBe('0.0% · 1.0 KB / 1.0 MB');
  });

  it('renders a normal numeric card with size, speed and ETA', () => {
    const card = onlyCard(harness({
      items: [cardTask({ percent: 42.5, downloadedBytes: 1024, totalBytes: 2048, speed: 512, eta: 16 })],
    }));
    const text = progressOf(card).textContent;
    expect(text).toContain('42.5%');
    expect(text).toContain('1.0 KB / 2.0 KB');
    expect(text).toContain('512 B/s');
    expect(text).toContain('剩余 0:16');
  });
});

describe('D-107 · terminal states win over the animation', () => {
  it('Canceled without a number gets an inert track, not a fake 0%', () => {
    const card = onlyCard(harness({ items: [cardTask({ state: 'Canceled', percent: null })] }));
    expect(card.getAttribute('data-progress-mode')).toBe('none');
    const bar = barOf(card);
    expect(bar.getAttribute('data-mode')).toBe('idle');
    expect(bar.getAttribute('data-percent')).toBeNull();
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    expect(progressOf(card).textContent).toBe('无进度信息');
    expect(card.textContent).not.toContain('%');
  });

  it('Error without a number does the same, and the error code stays visible', () => {
    const card = onlyCard(harness({ items: [cardTask({ state: 'Error', percent: null, errorCode: 'HTTP_403' })] }));
    expect(card.getAttribute('data-progress-mode')).toBe('none');
    expect(barOf(card).getAttribute('data-mode')).toBe('idle');
    expect(card.textContent).toContain('HTTP_403');
    expect(progressOf(card).textContent).toBe('无进度信息');
  });

  it('Canceled / Error with a real number keep the last known progress', () => {
    const canceled = onlyCard(harness({ items: [cardTask({ state: 'Canceled', percent: 37 })] }));
    expect(canceled.getAttribute('data-progress-mode')).toBe('value');
    expect(progressOf(canceled).textContent).toBe('37.0%');
    const failed = onlyCard(harness({ items: [cardTask({ state: 'Error', percent: 12, errorCode: 'HTTP_403' })] }));
    expect(failed.getAttribute('data-progress-mode')).toBe('value');
    expect(progressOf(failed).textContent).toBe('12.0%');
  });

  it('Completed always reports 100% regardless of the last stored percent', () => {
    const card = onlyCard(harness({ items: [cardTask({ state: 'Completed', percent: 99, artifacts: 2 })] }));
    expect(progressOf(card).textContent).toBe('100.0%');
  });
});

describe('D-107 · stage copy reflects the real phase', () => {
  it('Idle is "queued", FetchingInfo is "reading link info", ReadyWithInfo is "parsed"', () => {
    const idle = onlyCard(harness({ items: [cardTask({ state: 'Idle', percent: null })] }));
    expect(idle.getAttribute('data-progress-mode')).toBe('waiting');
    expect(barOf(idle).getAttribute('data-mode')).toBe('indeterminate');
    expect(hintOf(idle).textContent).toBe('排队中');

    const fetching = onlyCard(harness({ items: [cardTask({ state: 'FetchingInfo', percent: null })] }));
    expect(fetching.getAttribute('data-progress-mode')).toBe('waiting');
    expect(hintOf(fetching).textContent).toBe('正在解析链接');

    const ready = onlyCard(harness({ items: [cardTask({ state: 'ReadyWithInfo', percent: null })] }));
    expect(ready.getAttribute('data-progress-mode')).toBe('waiting');
    expect(hintOf(ready).textContent).toBe('已解析，待开始');
  });

  it('English copy comes from the same catalogue', () => {
    const running = onlyCard(harness({ lang: 'en', items: [cardTask({ percent: null })] }));
    expect(progressOf(running).textContent).toBe('Preparing download');
    const fetching = onlyCard(harness({ lang: 'en', items: [cardTask({ state: 'FetchingInfo', percent: null })] }));
    expect(hintOf(fetching).textContent).toBe('Reading link info');
  });
});

describe('D-107 · the live poll keeps null and repaints on every real change', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('unknown → 0 → non-zero → terminal', async () => {
    vi.useFakeTimers();
    const h = harness({ live: true, items: [dto({ percent: null })] });
    // Nothing polled yet: the deterministic SAMPLE is on screen (6 cards).
    expect(h.cards.children.length).toBe(6);

    await h.settle();
    expect(onlyCard(h).getAttribute('data-progress-mode')).toBe('unknown');
    expect(onlyCard(h).textContent).not.toContain('0.0%');

    await h.setItems([dto({ percent: 0 })]);
    let card = onlyCard(h);
    expect(card.getAttribute('data-progress-mode')).toBe('value');
    expect(progressOf(card).textContent).toBe('0.0%');

    await h.setItems([dto({ percent: 42.5, downloadedBytes: 1024, totalBytes: 2048 })]);
    card = onlyCard(h);
    expect(card.getAttribute('data-progress-mode')).toBe('value');
    expect(progressOf(card).getAttribute('data-progress')).toBe('42.5');

    await h.setItems([dto({ state: 'Error', percent: null, errorCode: 'HTTP_403' })]);
    card = onlyCard(h);
    expect(card.getAttribute('data-progress-mode')).toBe('none');
    expect(card.textContent).toContain('HTTP_403');
  });
});
