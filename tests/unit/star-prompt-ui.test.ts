/**
 * D-148 · the Star prompt as it is wired into the REAL queue page script.
 *
 * The page is a zero-dependency browser script, so the shipped `queue.js` is
 * executed against the shared fake-DOM harness. What this suite pins:
 *   - the prompt is LIVE-ONLY: a static file:// page (screenshot baselines)
 *     gains no timer, no IPC call and no DOM node;
 *   - the timer is armed by the FIRST real TASK_LIST reply (D-141: never fake
 *     data) and fires ~45 s later;
 *   - a queue with a Running/FetchingInfo task is never interrupted — the
 *     check waits for an idle moment (the red line);
 *   - exactly ONE `STAR_PROMPT_CHECK` per session, zero-payload, mapped to the
 *     exact wire string;
 *   - the dialog is created dynamically on <body>, removed after the answer,
 *     and every answer maps to one `{action}` enum value — never a URL.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { harness, type FakeNode, type QueuePageHarness } from './helpers/queue-page-harness.js';

const CHECK = 'ytvdlt:starPrompt:check';
const ACTION = 'ytvdlt:starPrompt:action';

function starCalls(h: QueuePageHarness, channel: string): { payload: unknown }[] {
  return h.calls.filter((call) => call.channel === channel).map((call) => ({ payload: call.payload }));
}

/** FakeNode keeps setAttribute values in attrs but honours plain `.id = x` too. */
function nodeId(node: FakeNode): string {
  const attr = node.getAttribute('id');
  if (attr !== null) return attr;
  const direct = (node as unknown as { id?: string }).id;
  return typeof direct === 'string' ? direct : '';
}

function dialog(h: QueuePageHarness): FakeNode | null {
  return h.body.children.find((node) => nodeId(node) === 'ytvdlt-star-prompt') ?? null;
}

function dialogTitle(h: QueuePageHarness): string {
  const backdrop = dialog(h);
  if (backdrop === null) return '';
  const found: FakeNode[] = [];
  const walk = (node: FakeNode): void => {
    if (nodeId(node) === 'ytvdlt-star-prompt-title') found.push(node);
    node.children.forEach(walk);
  };
  walk(backdrop);
  return found.length === 0 ? '' : (found[0]?.textContent ?? '');
}

/** The three buttons, in DOM order: star / later / never. */
function dialogButtons(h: QueuePageHarness): FakeNode[] {
  const backdrop = dialog(h);
  if (backdrop === null) return [];
  const buttons: FakeNode[] = [];
  const walk = (node: FakeNode): void => {
    if (node.tagName === 'button') buttons.push(node);
    node.children.forEach(walk);
  };
  walk(backdrop);
  return buttons;
}

function click(node: FakeNode, event: unknown = {}): void {
  (node.listeners['click'] ?? []).forEach((fn) => fn(event));
}

describe('star prompt · static preview stays untouched (frozen baselines)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('schedules nothing, calls nothing and renders no node without a bridge', async () => {
    const h = harness({ live: false });
    await h.settle();
    // Even an explicit check request is refused in non-live mode.
    h.queue.maybeCheckStarPrompt();
    await h.settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.queue.starPrompt()).toEqual({ shown: false, checked: false, dialogOpen: false, scheduled: false });
    expect(starCalls(h, CHECK)).toHaveLength(0);
    expect(starCalls(h, ACTION)).toHaveLength(0);
    expect(dialog(h)).toBeNull();
    expect(h.body.children).toHaveLength(0);
  });
});

describe('star prompt · live mode, idle queue', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('arms the timer only after the first TASK_LIST reply and checks after ~45 s', async () => {
    const h = harness({
      live: true,
      items: [],
      onInvoke: (channel) => (channel === CHECK ? { show: true } : undefined),
    });
    // Before any reply lands, nothing is armed.
    expect(h.queue.starPrompt().scheduled).toBe(false);
    await h.settle();
    expect(starCalls(h, CHECK)).toHaveLength(0);
    expect(h.queue.starPrompt().scheduled).toBe(true);

    // At T+44.9 s still nothing; at T+45 s the single CHECK goes out.
    await vi.advanceTimersByTimeAsync(44_000);
    expect(starCalls(h, CHECK)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_100);
    const checks = starCalls(h, CHECK);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.payload).toEqual({});
    // show:true -> the dialog is appended to <body> with the shipped zh copy.
    expect(dialog(h)).not.toBeNull();
    expect(dialogTitle(h)).toBe('觉得这个版本怎么样？');
    const buttons = dialogButtons(h);
    expect(buttons.map((button) => button.textContent)).toEqual(['去 Star', '以后再说', '不再提醒']);
    // Merely showing must not record anything yet.
    expect(starCalls(h, ACTION)).toHaveLength(0);
  });

  it('answers with the button enum (never a URL) and removes the dialog on answer', async () => {
    const h = harness({
      live: true,
      items: [],
      onInvoke: (channel) => (channel === CHECK ? { show: true } : undefined),
    });
    await h.settle();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(dialog(h)).not.toBeNull();
    const buttons = dialogButtons(h);

    click(buttons[1] as FakeNode); // "以后再说"
    await h.settle();
    const answers = starCalls(h, ACTION);
    expect(answers).toHaveLength(1);
    expect(answers[0]?.payload).toEqual({ action: 'later' });
    // The dialog is REMOVED, not hidden: <body> is clean again.
    expect(dialog(h)).toBeNull();
    expect(h.body.children).toHaveLength(0);
    // The session is done: no second CHECK, no second prompt.
    h.queue.maybeCheckStarPrompt();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(starCalls(h, CHECK)).toHaveLength(1);
    expect(starCalls(h, ACTION)).toHaveLength(1);
    expect(dialog(h)).toBeNull();
  });

  it("star and never record their enum values; the dimmed backdrop counts as 'later'", async () => {
    for (const [buttonIndex, action] of [[0, 'star'], [2, 'never']] as const) {
      const h = harness({
        live: true,
        items: [],
        onInvoke: (channel) => (channel === CHECK ? { show: true } : undefined),
      });
      await h.settle();
      await vi.advanceTimersByTimeAsync(45_000);
      click(dialogButtons(h)[buttonIndex] as FakeNode);
      await h.settle();
      expect(starCalls(h, ACTION)).toEqual([{ payload: { action } }]);
      expect(dialog(h)).toBeNull();
    }

    const h = harness({
      live: true,
      items: [],
      onInvoke: (channel) => (channel === CHECK ? { show: true } : undefined),
    });
    await h.settle();
    await vi.advanceTimersByTimeAsync(45_000);
    click(dialog(h) as FakeNode, { target: dialog(h) });
    await h.settle();
    expect(starCalls(h, ACTION)).toEqual([{ payload: { action: 'later' } }]);
    expect(dialog(h)).toBeNull();
  });

  it('show:false closes the subject for the whole session', async () => {
    const h = harness({
      live: true,
      items: [],
      onInvoke: (channel) => (channel === CHECK ? { show: false } : undefined),
    });
    await h.settle();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(starCalls(h, CHECK)).toHaveLength(1);
    expect(dialog(h)).toBeNull();
    // The page must not keep asking: one CHECK per session, period.
    h.queue.maybeCheckStarPrompt();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(starCalls(h, CHECK)).toHaveLength(1);
    expect(dialog(h)).toBeNull();
  });
});

describe('star prompt · never interrupts a task in flight', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each(['Running', 'FetchingInfo'] as const)('waits while a %s task is active', async (state) => {
    const h = harness({
      live: true,
      items: [{ id: 't1', state, kind: 'video', title: 'Busy' }],
      onInvoke: (channel) => (channel === CHECK ? { show: true } : undefined),
    });
    await h.settle();
    // 45 s fire time with a busy queue: no CHECK, the request stays scheduled.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(starCalls(h, CHECK)).toHaveLength(0);
    expect(dialog(h)).toBeNull();
    expect(h.queue.starPrompt().scheduled).toBe(true);

    // The queue goes idle -> the retry fires one CHECK, then the dialog.
    h.setItems([{ id: 't1', state: 'Completed', kind: 'video', title: 'Done' }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(starCalls(h, CHECK)).toHaveLength(1);
    expect(dialog(h)).not.toBeNull();
    expect(starCalls(h, ACTION)).toHaveLength(0);
  });

  it('never arms at all when the first TASK_LIST never lands', async () => {
    const h = harness({
      live: true,
      items: [],
      onInvoke: (channel) => (channel === 'ytvdlt:task:list' ? { ok: false, code: 'X' } : undefined),
    });
    await h.settle();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.queue.starPrompt().scheduled).toBe(false);
    expect(starCalls(h, CHECK)).toHaveLength(0);
    expect(dialog(h)).toBeNull();
  });
});
