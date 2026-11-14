import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * D-173: the task-log "copy log" button must go through the MAIN-process
 * clipboard channel (`ytvdlt:clipboard:write`). Since D-170 the packaged app
 * denies every renderer permission, so the old `navigator.clipboard.writeText`
 * call silently failed there. The page keeps its JSON action contract on
 * success and reports a user-visible failure sentence otherwise. Static DOM is
 * untouched (the copy branch only runs on click; the harness below provides
 * its own nodes, never the real index.html).
 */
const source = readFileSync('packages/ui/src/pages/task-log/task-log.js', 'utf8');

interface FakeNode {
  textContent: string;
  attributes: Record<string, string>;
  children: FakeNode[];
  click?: () => void;
  setAttribute(key: string, value: string): void;
  getAttribute(key: string): string | null;
  addEventListener(event: string, callback: () => void): void;
  appendChild(child: FakeNode): void;
}

function makeNode(): FakeNode {
  const node: FakeNode = {
    textContent: '',
    attributes: {},
    children: [],
    setAttribute(key: string, value: string) { node.attributes[key] = value; },
    getAttribute(key: string) { return node.attributes[key] ?? null; },
    addEventListener(_event: string, callback: () => void) { node.click = callback; },
    appendChild(child: FakeNode) { node.children.push(child); },
  };
  return node;
}

interface HarnessOptions {
  bridge?: { invoke(channel: string, payload: unknown): Promise<unknown> } | null;
  navigator?: { clipboard?: { writeText(text: string): Promise<void> } } | null;
  task?: { id: string; state: string; percent: number; lines: string[] };
}

function harness(options: HarnessOptions = {}) {
  const nodes = new Map<string, FakeNode>();
  const doc = {
    getElementById(id: string): FakeNode {
      if (!nodes.has(id)) nodes.set(id, makeNode());
      return nodes.get(id) as FakeNode;
    },
    createElement(): FakeNode { return makeNode(); },
  };
  const clipboardCalls: string[] = [];
  const bridgeCalls: { channel: string; payload: unknown }[] = [];
  const context: Record<string, unknown> = {
    document: doc,
    __YTVDLT_TASK__: options.task ?? {
      id: 't9', state: 'Error', percent: null,
      lines: ['[info] a', '[download] b'],
    },
    YTVDLT: { i18n: { t: (key: string) => `T(${key})` } },
  };
  if (options.bridge !== undefined) {
    context.ytvdltBridge = options.bridge === null ? undefined : {
      invoke: (channel: string, payload: unknown) => {
        bridgeCalls.push({ channel, payload });
        return options.bridge?.invoke(channel, payload);
      },
    };
  }
  if (options.navigator !== undefined) {
    context.navigator = options.navigator === null ? undefined : {
      clipboard: {
        writeText: (text: string) => { clipboardCalls.push(text); return Promise.resolve(); },
      },
    };
  }
  runInNewContext(source, context);
  const output = () => doc.getElementById('ytvdlt-output').textContent;
  return {
    clickCopy: () => doc.getElementById('log-copy').click?.(),
    bridgeCalls,
    clipboardCalls,
    output,
    linesNode: () => doc.getElementById('log-lines'),
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

describe('task-log copy · D-173 main-process clipboard channel', () => {
  it('sends the joined log through ytvdlt:clipboard:write and keeps the JSON contract', async () => {
    const app = harness({
      bridge: { invoke: async () => ({ ok: true }) },
    });
    app.clickCopy();
    await flush();
    expect(app.bridgeCalls).toHaveLength(1);
    expect(app.bridgeCalls[0].channel).toBe('ytvdlt:clipboard:write');
    expect(app.bridgeCalls[0].payload).toEqual({ text: '[info] a\n[download] b' });
    // Historical emit contract: the model carries `id`, so `taskId` is dropped
    // by JSON.stringify — success output stays byte-identical to before.
    expect(JSON.parse(app.output())).toEqual({ action: 'copy', accepted: false });
    expect(app.clipboardCalls).toEqual([]);
  });

  it('shows the failure sentence when the main process answers ok:false', async () => {
    const app = harness({
      bridge: { invoke: async () => ({ ok: false, code: 'CLIPBOARD_UNAVAILABLE' }) },
    });
    app.clickCopy();
    await flush();
    expect(app.output()).toBe('T(log.copy.failed)');
    expect(JSON.stringify(app.output())).not.toContain('"action"');
  });

  it('shows the failure sentence when the invoke rejects (payload over the cap)', async () => {
    const app = harness({
      bridge: { invoke: async () => { throw new Error('bounded text'); } },
    });
    app.clickCopy();
    await flush();
    expect(app.output()).toBe('T(log.copy.failed)');
  });

  it('falls back to navigator.clipboard only when the preload bridge is absent', async () => {
    const app = harness({
      bridge: null,
      navigator: { clipboard: { writeText: async () => undefined } },
    });
    app.clickCopy();
    await flush();
    expect(app.bridgeCalls).toEqual([]);
    expect(app.clipboardCalls).toEqual(['[info] a\n[download] b']);
    // Static-preview success keeps the historical JSON contract.
    expect(JSON.parse(app.output())).toEqual({ action: 'copy', accepted: false });
  });

  it('reports failure when neither the bridge nor navigator.clipboard exists', async () => {
    const app = harness({ bridge: null, navigator: null });
    app.clickCopy();
    await flush();
    expect(app.output()).toBe('T(log.copy.failed)');
  });
});
