/**
 * D-115: what a card shows once the bytes are done but the task is not.
 *
 * The failure this replaces: at 100% the card kept rendering a numeric bar and
 * the "下载中" badge while ffmpeg merged or the verifier ran, so a long merge
 * looked like a hang. These tests drive the REAL page script against the fake
 * DOM and assert the visual mode, the tone and the copy — a bare `percent`
 * assertion would not catch a wrong label.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  barOf, cardById, dto, findAll, harness, progressOf,
  type FakeNode, type QueuePageHarness,
} from './helpers/queue-page-harness.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function render(items: readonly unknown[], lang: 'zh-CN' | 'en' = 'zh-CN'): Promise<QueuePageHarness> {
  const h = harness({ items, live: true, lang });
  await h.settle();
  await h.setItems(items);
  return h;
}

function progressTextOf(card: FakeNode): string {
  return progressOf(card).textContent;
}

describe('D-115 post-transfer card states', () => {
  it('shows the yellow indeterminate bar and "合并视频中" for a merging task', async () => {
    const h = await render([dto({ id: 'm1', state: 'Running', percent: 100, stage: 'merging' })]);
    const card = cardById(h, 'm1');
    expect(card.getAttribute('data-progress-mode')).toBe('working');
    expect(card.getAttribute('data-stage')).toBe('merging');
    const bar = barOf(card);
    expect(bar.getAttribute('data-mode')).toBe('indeterminate');
    expect(bar.getAttribute('data-tone')).toBe('work');
    // Never a number: two streams each reach 100% and neither means done.
    expect(bar.getAttribute('data-percent')).toBeNull();
    expect(progressTextOf(card)).toBe('合并视频中');
  });

  it('says "整理中" for post-processing and verification', async () => {
    const h = await render([
      dto({ id: 'p1', state: 'Running', percent: 100, stage: 'postprocess' }),
      dto({ id: 'v1', state: 'Running', percent: 100, stage: 'verifying' }),
    ]);
    expect(progressTextOf(cardById(h, 'p1'))).toBe('整理中');
    expect(progressTextOf(cardById(h, 'v1'))).toBe('整理中');
    expect(barOf(cardById(h, 'v1')).getAttribute('data-tone')).toBe('work');
  });

  it('uses English copy when the page is in English', async () => {
    const h = await render([
      dto({ id: 'm1', state: 'Running', percent: 100, stage: 'merging' }),
      dto({ id: 'p1', state: 'Running', percent: 100, stage: 'postprocess' }),
    ], 'en');
    expect(progressTextOf(cardById(h, 'm1'))).toBe('Merging video');
    expect(progressTextOf(cardById(h, 'p1'))).toBe('Finalizing');
  });

  it('keeps the numeric bar while a transfer is still running', async () => {
    const h = await render([dto({ id: 'd1', state: 'Running', percent: 42, stage: 'downloading' })]);
    const card = cardById(h, 'd1');
    expect(card.getAttribute('data-progress-mode')).toBe('value');
    expect(barOf(card).getAttribute('data-tone')).toBeNull();
  });

  it('does not invent a phase when the backend sends none (old snapshot)', async () => {
    const h = await render([dto({ id: 'old', state: 'Running', percent: 100 })]);
    const card = cardById(h, 'old');
    // 100% with no stage stays a numeric bar — the previous behaviour.
    expect(card.getAttribute('data-progress-mode')).toBe('value');
    expect(findAll(card, (n) => n.getAttribute('data-tone') === 'work')).toHaveLength(0);
  });

  it('paints a completed task green and full', async () => {
    const h = await render([dto({ id: 'c1', state: 'Completed', percent: 100 })]);
    const card = cardById(h, 'c1');
    const bar = barOf(card);
    expect(bar.getAttribute('data-mode')).toBe('done');
    expect(bar.getAttribute('data-tone')).toBe('done');
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect(card.getAttribute('data-progress-mode')).toBe('complete');
  });

  it('an error during post-processing still reads as Error, not as "merging"', async () => {
    const h = await render([dto({
      id: 'e1', state: 'Error', percent: 100, stage: 'merging', errorCode: 'FFMPEG_FAILED',
    })]);
    const card = cardById(h, 'e1');
    expect(card.getAttribute('data-progress-mode')).toBe('value');
    expect(card.getAttribute('data-stage')).toBeNull();
  });
});
