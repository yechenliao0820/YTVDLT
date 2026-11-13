/**
 * D-141 · the task-detail page must not show the screenshot fixture in live mode.
 *
 * `index.html` ships fixture values (`t1 / Error / 42% / C:/V/fixture.mp4`)
 * because the frozen screenshot baseline depends on them. In live mode the page
 * used to render exactly those until `TASK_DETAIL` answered — so every hop from
 * the queue flashed a fake task, and its action buttons were armed against a
 * task id (`t1`) that does not exist. Live load now blanks the fields, keeps the
 * actions inert, and only paints the record the main process returns.
 *
 * D-146 · same page: live cancel availability must match what `TaskQueue`
 * can actually do. The cancellable handle exists for the download stage only,
 * so live mode arms cancel for Running / Queued (the queue page's D-76 rule)
 * and keeps it inert during FetchingInfo / ReadyWithInfo. The static fixture
 * branch keeps the legacy rule — file:// screenshot baselines stay untouched.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync('packages/ui/src/pages/task-detail/task-detail.js', 'utf8');

interface FakeNode {
  textContent: string;
  attrs: Record<string, string>;
  children: FakeNode[];
  listeners: Record<string, (() => void)[]>;
  style: Record<string, string>;
  setAttribute(key: string, value: string): void;
  getAttribute(key: string): string | null;
  removeAttribute(key: string): void;
  addEventListener(type: string, fn: () => void): void;
  insertBefore(node: FakeNode, ref: FakeNode | null): void;
  readonly firstChild: FakeNode | null;
}

function node(): FakeNode {
  const target: FakeNode = {
    textContent: '', attrs: {}, children: [], listeners: {}, style: {},
    setAttribute(key, value) { this.attrs[key] = value; },
    getAttribute(key) { return this.attrs[key] ?? null; },
    removeAttribute(key) { delete this.attrs[key]; },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    insertBefore(child) { this.children.unshift(child); },
    get firstChild() { return this.children[0] ?? null; },
  };
  return target;
}

const ACTIONS = ['open-file', 'open-folder', 'copy-url', 'copy-error-report', 'cancel', 'remove', 'retry'];

function boot(options: {
  live?: boolean;
  taskId?: string;
  detail?: unknown;
  neverSettle?: boolean;
}): {
  nodes: Map<string, FakeNode>;
  actions: Map<string, FakeNode>;
  flush: () => Promise<void>;
  calls: Array<{ channel: string; payload: unknown }>;
  sandbox: Record<string, unknown>;
} {
  const nodes = new Map<string, FakeNode>();
  const actions = new Map<string, FakeNode>();
  const calls: Array<{ channel: string; payload: unknown }> = [];
  for (const id of ['detail-id', 'detail-state', 'detail-progress', 'detail-code',
    'detail-artifacts', 'detail-url', 'detail-body', 'detail-actions', 'detail-empty',
    'ytvdlt-task-detail', 'ytvdlt-output']) {
    nodes.set(id, node());
  }
  for (const action of ACTIONS) {
    const button = node();
    button.attrs['data-action'] = action;
    actions.set(action, button);
  }

  let resolveDetail: (value: unknown) => void = () => {};
  const pending = options.neverSettle === true
    ? new Promise(() => {})
    : new Promise((resolve) => { resolveDetail = resolve; });

  const doc = {
    getElementById: (id: string) => nodes.get(id) ?? null,
    querySelector: (selector: string) => {
      const match = /\[data-action="([^"]+)"\]/.exec(selector);
      return match === null ? null : (actions.get(match[1] as string) ?? null);
    },
    createElement: () => node(),
    addEventListener: () => undefined,
  };

  const sandbox: Record<string, unknown> = {
    document: doc,
    location: {
      search: options.taskId === undefined ? '' : `?taskId=${options.taskId}`,
      href: 'file:///app/pages/task-detail/index.html',
      replace: () => undefined,
    },
    history: { back: () => undefined },
    addEventListener: () => undefined,
    YTVDLTNav: { pageUrl: (page: string) => `../${page}/index.html` },
    YTVDLT: { i18n: { t: (key: string) => key } },
  };
  if (options.live === true) {
    sandbox['ytvdltBridge'] = {
      invoke: (channel: string, payload: unknown) => {
        calls.push({ channel, payload });
        return channel === 'ytvdlt:task:detail' ? pending : Promise.resolve({ ok: true });
      },
    };
  } else {
    sandbox['__YTVDLT_TASK__'] = options.detail;
  }
  runInNewContext(source, sandbox);

  if (options.neverSettle !== true) {
    resolveDetail(options.detail ?? { found: true, task: options.detail });
  }

  return {
    nodes,
    actions,
    calls,
    sandbox,
    flush: () => new Promise((resolve) => { setTimeout(resolve, 0); }),
  };
}

describe('D-141 · live load never shows the screenshot fixture', () => {
  it('blanks every field and keeps the actions inert until TASK_DETAIL answers', () => {
    const { nodes, actions } = boot({ live: true, taskId: 't9', neverSettle: true });
    expect(nodes.get('detail-id')?.textContent).toBe('—');
    expect(nodes.get('detail-state')?.textContent).toBe('—');
    expect(nodes.get('detail-progress')?.textContent).toBe('—');
    expect(nodes.get('detail-artifacts')?.textContent).toBe('—');
    expect(nodes.get('detail-url')?.textContent).toBe('—');
    expect(nodes.get('ytvdlt-task-detail')?.getAttribute('data-state')).toBe('loading');
    for (const action of ACTIONS) {
      expect(actions.get(action)?.getAttribute('aria-disabled')).toBe('true');
    }
  });

  it('paints the real record once the reply lands', async () => {
    const { nodes, actions, calls, flush } = boot({
      live: true,
      taskId: 't9',
      detail: {
        found: true,
        task: {
          id: 't9', state: 'Error', percent: 12, errorCode: 'HTTP_403',
          artifacts: ['C:/real/video.mp4'], url: 'https://example.org/real',
        },
      },
    });
    await flush();
    expect(nodes.get('detail-id')?.textContent).toBe('t9');
    expect(nodes.get('detail-state')?.textContent).toBe('Error');
    expect(nodes.get('detail-artifacts')?.textContent).toBe('C:/real/video.mp4');
    expect(nodes.get('ytvdlt-task-detail')?.getAttribute('data-state')).toBe('error');
    expect(actions.get('retry')?.getAttribute('aria-disabled')).toBe('false');

    // The fixture's id must never be armed: an action dispatches the REAL record.
    (actions.get('retry')?.listeners['click'] ?? [])[0]?.();
    await flush();
    const dispatched = calls.filter((entry) => entry.channel === 'ytvdlt:task:action');
    expect(dispatched).toHaveLength(1);
    expect((dispatched[0]?.payload as { taskId?: string }).taskId).toBe('t9');
  });

  it('keeps the fixture rendering for the file:// screenshot path', () => {
    // No bridge and no injected record: this is the baseline path, and the
    // shipped `index.html` values are what the frozen screenshots compare.
    const { nodes, actions } = boot({ taskId: undefined });
    expect(nodes.get('detail-id')?.textContent).toBe('t1');
    expect(nodes.get('detail-state')?.textContent).toBe('Error');
    expect(nodes.get('detail-artifacts')?.textContent).toBe('C:/V/fixture.mp4');
    expect(actions.get('retry')?.getAttribute('aria-disabled')).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// D-146 · live cancel availability aligned with the queue's real capability.
// ---------------------------------------------------------------------------
type Availability = (model: { state: string }, liveMode?: boolean) => Record<string, unknown>;

function pageOf(sandbox: Record<string, unknown>): { availability: Availability } {
  return sandbox['YTVDLTDetail'] as { availability: Availability };
}

describe('D-146 · live cancel availability matches what TaskQueue can do', () => {
  const detailFor = (state: string, pending = false) => ({
    found: true,
    task: {
      id: 't9', state, percent: 0, errorCode: null, artifacts: [], url: 'https://example.org/v',
      ...(pending ? { pending: true } : {}),
    },
  });

  // D-162 REVISES the D-146 rule: the probe now carries an AbortSignal, so
  // `FetchingInfo` is cancellable and the button must be armed. `ReadyWithInfo`
  // is still inert — it is a zero-length phase with no process to kill.
  it('live: FetchingInfo arms cancel (D-162 probe handle); ReadyWithInfo stays inert', async () => {
    const fetching = boot({ live: true, taskId: 't9', detail: detailFor('FetchingInfo') });
    await fetching.flush();
    expect(fetching.actions.get('cancel')?.getAttribute('aria-disabled')).toBe('false');

    const ready = boot({ live: true, taskId: 't9', detail: detailFor('ReadyWithInfo') });
    await ready.flush();
    expect(ready.actions.get('cancel')?.getAttribute('aria-disabled')).toBe('true');
  });

  // D-164 REVISES the D-76 rule: the queue's parked-task marker is `pending`,
  // not the non-existent `Queued` state string that never matched anything.
  it('live: Running and FIFO-parked (pending) tasks arm cancel', async () => {
    for (const model of [{ state: 'Running', pending: false }, { state: 'Idle', pending: true }]) {
      const { actions, flush } = boot({
        live: true, taskId: 't9', detail: detailFor(model.state, model.pending),
      });
      await flush();
      expect(actions.get('cancel')?.getAttribute('aria-disabled')).toBe('false');
    }
  });

  it('live: clicking cancel on a probe-stage task dispatches no TASK_ACTION', async () => {
    const { actions, calls, flush } = boot({ live: true, taskId: 't9', detail: detailFor('ReadyWithInfo') });
    await flush();
    (actions.get('cancel')?.listeners['click'] ?? [])[0]?.();
    await flush();
    expect(calls.filter((entry) => entry.channel === 'ytvdlt:task:action')).toHaveLength(0);
  });

  it('availability contract: live branch = Running | FetchingInfo | pending', () => {
    const { sandbox } = boot({ live: true, taskId: 't9', detail: detailFor('Running') });
    const { availability } = pageOf(sandbox);
    expect(availability({ state: 'Running' }, true).cancel).toBe(true);
    expect(availability({ state: 'FetchingInfo' }, true).cancel).toBe(true);
    expect(availability({ state: 'Idle', pending: true }, true).cancel).toBe(true);
    // A restored-but-never-run task is also `Idle`; without the marker it must
    // NOT offer a cancel the queue would refuse.
    expect(availability({ state: 'Idle' }, true).cancel).toBe(false);
    expect(availability({ state: 'ReadyWithInfo' }, true).cancel).toBe(false);
  });

  it('static fixture branch keeps the legacy rule (screenshot baseline behaviour)', () => {
    const { sandbox } = boot({
      detail: { id: 't1', state: 'Error', percent: 42, artifacts: ['C:/V/fixture.mp4'], url: 'https://example.org/v' },
    });
    const { availability } = pageOf(sandbox);
    // Legacy rule unchanged: Running / FetchingInfo / ReadyWithInfo armed,
    // Queued NOT (that is the old detail-page rule, kept for the baseline).
    expect(availability({ state: 'Running' }).cancel).toBe(true);
    expect(availability({ state: 'FetchingInfo' }).cancel).toBe(true);
    expect(availability({ state: 'ReadyWithInfo' }).cancel).toBe(true);
    expect(availability({ state: 'Queued' }).cancel).toBe(false);
    // SAMPLE renders state 'Error': disabled under BOTH rules, so even if the
    // branch selection ever drifted the file:// DOM could not change.
    expect(availability({ state: 'Error' }, true).cancel).toBe(false);
    expect(availability({ state: 'Error' }, false).cancel).toBe(false);
  });
});
