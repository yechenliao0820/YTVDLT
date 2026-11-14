/**
 * D-187 · txt-import 真实行为单测（packages/ui 纳入覆盖率统计）。
 *
 * 旧的 tests/unit/txt-import-ui.test.ts 用 `new Function` 沙箱执行源码，v8
 * 覆盖率统计不到；本文件改用共享装载架 tests/unit/helpers/ui-harness.ts
 * （installUiGlobals + 真实 `import()`）加载 packages/ui/src/txt-import/txt-import.js，
 * 再通过模块自暴露的 `YTVDLT.txtImport.create(...)` 测试面驱动真实行为：
 * 选文件 → 预览（六项统计 + 明细列表）→ 确认入队（票据参数 + D-129 真实
 * requested/enqueued/failed 计数）→ 预检等待行（T5 轮询 / 取消）→ 关闭清理。
 *
 * 场景间用 create({ doc, t, call, notify, getChoice, refresh, pollMs }) 注入
 * 各自的假 doc 与假 bridge 回包；pollMs 注入小值并配合 vi fake timers 驱动
 * URL_SUPPORT_CHECK_STATUS 轮询，不需要真实 500 ms 等待。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  installUiGlobals, loadUiModule, uiNode,
  type UiGlobals, type UiNode,
} from './helpers/ui-harness.js';

type TestNode = UiNode & { parentNode: TestNode | null };

/** 共享装载架的节点是"无父节点"的独立对象；这里补上 parentNode 跟踪与 `#id` 查询。 */
function node(tag = 'div'): TestNode {
  const n = uiNode(tag) as unknown as TestNode;
  n.parentNode = null;
  const appendChild = n.appendChild.bind(n);
  n.appendChild = (child: UiNode): UiNode => {
    (child as TestNode).parentNode = n;
    return appendChild(child);
  };
  const insertBefore = n.insertBefore.bind(n);
  n.insertBefore = (child: UiNode, ref?: UiNode | null): UiNode => {
    (child as TestNode).parentNode = n;
    return insertBefore(child, ref);
  };
  const removeChild = n.removeChild.bind(n);
  n.removeChild = (child: UiNode): UiNode => {
    (child as TestNode).parentNode = null;
    return removeChild(child);
  };
  const baseQueryAll = n.querySelectorAll.bind(n);
  n.querySelectorAll = (selector: string): UiNode[] => {
    const idMatch = /^#([A-Za-z0-9_-]+)$/.exec(selector.trim());
    if (idMatch === null) return baseQueryAll(selector);
    const found: UiNode[] = [];
    const walk = (current: UiNode): void => {
      for (const child of current.children) {
        if (child.getAttribute('id') === idMatch[1]) found.push(child);
        walk(child);
      }
    };
    walk(n);
    return found;
  };
  return n;
}

interface FakeDocEnv {
  doc: Record<string, any>;
  head: TestNode;
  body: TestNode;
}

function makeDoc(): FakeDocEnv {
  const docListeners: Record<string, ((event?: unknown) => void)[]> = {};
  const head = node('head');
  const body = node('body');
  const doc: Record<string, any> = {
    head,
    body,
    createElement(tag?: string): TestNode { return node(tag ?? 'div'); },
    addEventListener(type: string, fn: (event?: unknown) => void): void {
      (docListeners[type] ??= []).push(fn);
    },
    removeEventListener(type: string, fn: (event?: unknown) => void): void {
      const bucket = docListeners[type] ?? [];
      const at = bucket.indexOf(fn);
      if (at >= 0) bucket.splice(at, 1);
    },
  };
  void docListeners;
  return { doc, head, body };
}

/** 参数化假 i18n：带参数时把参数 JSON 内联进文案（null 参数与真 i18n 一样视为无参数）。 */
function t(key: string, params?: Record<string, unknown> | null): string {
  return params === undefined || params === null ? key : `${key}${JSON.stringify(params)}`;
}

function findById(root: UiNode, id: string): TestNode | null {
  if (root.getAttribute('id') === id) return root as TestNode;
  for (const child of root.children) {
    const hit = findById(child, id);
    if (hit !== null) return hit;
  }
  return null;
}

/** 装载架节点的 textContent 是普通属性（不聚合子树），断言用需要自己拼。 */
function textOf(root: UiNode): string {
  let out = typeof root.textContent === 'string' ? root.textContent : '';
  for (const child of root.children) out += textOf(child);
  return out;
}

function allNodes(root: UiNode): UiNode[] {
  const out: UiNode[] = [root];
  for (const child of root.children) out.push(...allNodes(child));
  return out;
}

async function tick(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

// ---- 类型与夹具 -----------------------------------------------------------

interface TxtController {
  mount(anchor: unknown, cssHref: string): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
  currentPreview(): unknown;
}

interface TxtFactory {
  create(options: Record<string, unknown>): TxtController;
}

function previewFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true, canceled: false, code: '', fileName: 'links.txt',
    importId: 'import-ticket-0001', totalLines: 6, blankCount: 1,
    validCount: 3, invalidCount: 1, duplicateCount: 1, playlistCount: 1, maxUrls: 200,
    items: [
      { line: 1, text: 'https://www.youtube.com/watch?v=v1', status: 'valid' },
      { line: 2, text: 'https://www.youtube.com/watch?v=v2', status: 'valid' },
      { line: 3, text: 'nope', status: 'invalid' },
      { line: 4, text: 'https://www.youtube.com/watch?v=v1', status: 'duplicate' },
      { line: 5, text: 'https://www.youtube.com/playlist?list=PL1', status: 'playlist' },
      { line: 7, text: 'x'.repeat(3000), status: 'too-long' },
      { line: 8, text: 'mystery', status: 'mystery' },
    ],
    ...overrides,
  };
}

// ---- 场景装载 -------------------------------------------------------------

let globals: UiGlobals | null = null;
let txtImportFactory: TxtFactory;

beforeAll(async () => {
  vi.useFakeTimers();
  globals = installUiGlobals({ bridge: null });
  await loadUiModule('txt-import/txt-import.js', globals);
  txtImportFactory = (globals.window as any).YTVDLT.txtImport as TxtFactory;
});

afterAll(() => {
  globals?.restore();
  globals = null;
  vi.useRealTimers();
});

interface TxtBoot {
  component: TxtController;
  calls: Array<{ channel: string; payload: unknown }>;
  notices: string[];
  refreshed: () => number;
  entry: TestNode | null;
  byId(id: string): TestNode | null;
  head: TestNode;
  body: TestNode;
  doc: Record<string, any>;
  setPick(reply: unknown): void;
  setStatus(reply: unknown): void;
  clickEntry(): void;
}

function boot(options: {
  pick?: unknown;
  enqueue?: unknown;
  choice?: Record<string, unknown> | null;
  pollMs?: number;
  literalT?: boolean;
  mount?: boolean;
  onCall?: (channel: string, payload: unknown) => unknown;
} = {}): TxtBoot {
  const env = makeDoc();
  const calls: Array<{ channel: string; payload: unknown }> = [];
  const notices: string[] = [];
  let refreshedCount = 0;
  let pickReply: unknown = options.pick !== undefined ? options.pick : previewFixture();
  let enqueueReply: unknown = options.enqueue ?? {
    ok: true, code: '', requested: 3, enqueued: 3, failed: 0,
    taskIds: ['a', 'b', 'c'], failures: [],
  };
  let statusReply: unknown = { active: false };

  const component = txtImportFactory.create({
    doc: env.doc,
    t: options.literalT === true ? (key: string) => key : t,
    call(channel: string, payload: unknown): Promise<unknown> {
      calls.push({ channel, payload });
      const custom = options.onCall?.(channel, payload);
      if (custom !== undefined) return Promise.resolve(custom);
      if (channel === 'TXT_IMPORT_PICK') return Promise.resolve(pickReply);
      if (channel === 'TXT_IMPORT_ENQUEUE') return Promise.resolve(enqueueReply);
      if (channel === 'URL_SUPPORT_CHECK_STATUS') return Promise.resolve(statusReply);
      return Promise.resolve({ ok: true, canceled: true });   // URL_SUPPORT_CHECK_CANCEL 等
    },
    notify(text: string): void { notices.push(String(text)); },
    getChoice: options.choice === null
      ? undefined
      : (): Record<string, unknown> => options.choice ?? { kind: 'video', videoQuality: '1080p' },
    refresh(): void { refreshedCount += 1; },
    pollMs: options.pollMs ?? 10,
  });

  const parent = env.doc.createElement('div') as TestNode;
  const anchor = env.doc.createElement('form') as TestNode;
  parent.appendChild(anchor);
  if (options.mount !== false) component.mount(anchor, '../styles/txt-import.css');

  const byId = (id: string): TestNode | null => {
    for (const root of [env.body, env.head, parent]) {
      const hit = findById(root, id);
      if (hit !== null) return hit;
    }
    return null;
  };

  return {
    component,
    calls,
    notices,
    refreshed: () => refreshedCount,
    entry: byId('queue-import-txt'),
    byId,
    head: env.head,
    body: env.body,
    doc: env.doc,
    setPick(reply: unknown) { pickReply = reply; },
    setStatus(reply: unknown) { statusReply = reply; },
    clickEntry() { byId('queue-import-txt')?.dispatch('click', {}); },
  };
}

function clickId(b: TxtBoot, id: string): void {
  const target = b.byId(id);
  if (target === null) throw new Error(`missing #${id}`);
  target.dispatch('click', {});
}

async function openReady(b: TxtBoot, pick?: Record<string, unknown>): Promise<TxtBoot> {
  if (pick !== undefined) b.setPick(pick);
  b.clickEntry();
  await tick();
  return b;
}

function enqueueGate(): { gate: Promise<unknown>; resolve: (value: unknown) => void } {
  let resolve: (value: unknown) => void = () => {};
  const gate = new Promise((res) => { resolve = res; });
  return { gate, resolve };
}

// ---------------------------------------------------------------------------

describe('D-187 · txt-import boots under the import harness', () => {
  it('exposes the YTVDLT.txtImport surface after a real import', () => {
    expect(typeof txtImportFactory.create).toBe('function');
    expect(Object.keys(globals!.attached)).toContain('YTVDLT');
  });
});

describe('txt-import · mounting', () => {
  it('mount builds one labelled entry button and a stylesheet link, with zero IPC', () => {
    const b = boot();
    expect(b.entry?.getAttribute('id')).toBe('queue-import-txt');
    expect(b.entry?.getAttribute('type')).toBe('button');
    expect(b.entry?.getAttribute('data-i18n')).toBe('queue.import.button');
    expect(b.entry?.textContent).toBe('queue.import.button');
    expect(b.head.children[0].getAttribute('rel')).toBe('stylesheet');
    expect(b.head.children[0].getAttribute('href')).toBe('../styles/txt-import.css');
    expect(b.calls).toEqual([]);
    expect(b.component.isOpen()).toBe(false);
    expect(b.component.currentPreview()).toBeNull();
  });

  it('mount guards: null anchor and detached anchor mount nothing, a live anchor mounts', () => {
    const b = boot({ mount: false });
    b.component.mount(null, '../styles/txt-import.css');
    expect(b.byId('queue-import-txt')).toBeNull();
    const detached = b.doc.createElement('form') as TestNode;
    detached.parentNode = null;                                              // 模拟未插入文档
    b.component.mount(detached, '../styles/txt-import.css');
    expect(b.byId('queue-import-txt')).toBeNull();
    const parent = b.doc.createElement('div') as TestNode;
    const anchor = b.doc.createElement('form') as TestNode;
    parent.appendChild(anchor);
    b.component.mount(anchor, '../styles/txt-import.css');
    expect(findById(parent, 'queue-import-txt')).not.toBeNull();             // 挂进了测试自己的锚点树
    expect(b.calls).toEqual([]);                                             // 挂载零 IPC
  });

  it('re-mounting is idempotent: exactly one entry button exists', () => {
    const b = boot();
    const parent = b.doc.createElement('div') as TestNode;
    const anchor = b.doc.createElement('form') as TestNode;
    parent.appendChild(anchor);
    b.component.mount(anchor, '../styles/txt-import.css');
    const siblings = (b.entry!.parentNode as TestNode).children
      .filter((n) => n.getAttribute('id') === 'queue-import-txt');
    expect(siblings).toHaveLength(1);
  });
});

describe('txt-import · pick and preview', () => {
  it('entry click sends TXT_IMPORT_PICK with an empty payload and never enqueues first', async () => {
    const b = boot();
    b.clickEntry();
    expect(b.calls).toEqual([{ channel: 'TXT_IMPORT_PICK', payload: {} }]);
    expect(b.component.isOpen()).toBe(true);
    expect(textOf(b.byId('txt-import-body') as TestNode)).toContain('queue.import.picking');
    await tick();
    expect(b.calls.some((c) => c.channel === 'TXT_IMPORT_ENQUEUE')).toBe(false);
    expect(b.component.currentPreview()).not.toBeNull();
  });

  it('open is ignored while busy and currentPreview becomes readable after the reply', async () => {
    let resolvePick: (value: unknown) => void = () => {};
    const b = boot({
      onCall: (channel) => channel === 'TXT_IMPORT_PICK'
        ? new Promise((resolve) => { resolvePick = resolve; })
        : undefined,
    });
    b.clickEntry();
    b.clickEntry();                                                          // busy：忽略
    expect(b.calls).toHaveLength(1);
    resolvePick(previewFixture());
    await tick();
    expect(b.byId('txt-import-list')).not.toBeNull();
    expect(b.component.currentPreview()).toMatchObject({ importId: 'import-ticket-0001' });
  });

  it('preview renders file name, six stat buckets, detail rows and status badges', async () => {
    const b = await openReady(boot());
    const bodyText = textOf(b.byId('txt-import-body') as TestNode);
    expect(bodyText).toContain('links.txt');
    for (const key of ['queue.import.totalLines', 'queue.import.valid', 'queue.import.invalid',
      'queue.import.duplicate', 'queue.import.playlist', 'queue.import.blank', 'queue.import.urls']) {
      expect(bodyText, key).toContain(key);
    }
    const list = b.byId('txt-import-list') as TestNode;
    expect(list.children).toHaveLength(7);
    const tooLong = list.children.find((row) => row.getAttribute('data-status') === 'too-long') as TestNode;
    expect(tooLong.children[1].textContent).toBe('queue.import.status.tooLong');
    const unknown = list.children.find((row) => row.getAttribute('data-status') === 'mystery') as TestNode;
    expect(unknown.children[1].textContent).toBe('queue.import.status.invalid');       // 未知状态回退
    expect(b.byId('txt-import-confirm')?.getAttribute('disabled')).toBeNull();
    expect(b.byId('txt-import-cancel')).not.toBeNull();
  });

  it('stat cells carry ok/warn classes and playlist rows raise the hint', async () => {
    const b = await openReady(boot());
    const grid = allNodes(b.byId('txt-import-body') as TestNode)
      .find((n) => n.className === 'txt-import-stats') as TestNode;
    expect(grid.children.some((cell) => cell.className === 'txt-import-stat ok')).toBe(true);
    expect(grid.children.some((cell) => cell.className === 'txt-import-stat warn')).toBe(true);
    expect(textOf(b.byId('txt-import-body') as TestNode)).toContain('queue.import.playlistHint');
  });

  it('no valid URLs / too many URLs disable confirm and explain why', async () => {
    const b = await openReady(boot(), previewFixture({
      code: 'TOO_MANY_URLS', maxUrls: 3, importId: '',
      totalLines: 5, validCount: 0, invalidCount: 0, duplicateCount: 0, playlistCount: 0, blankCount: 5,
      items: [],
    }));
    expect(b.byId('txt-import-confirm')?.getAttribute('disabled')).toBe('disabled');
    const bodyText = textOf(b.byId('txt-import-body') as TestNode);
    expect(bodyText).toContain('queue.import.emptyList');
    expect(bodyText).toContain('queue.import.limit{"max":3}');
    expect(bodyText).toContain('queue.import.error.TOO_MANY_URLS{"code":"TOO_MANY_URLS"}');
  });

  it('a cancelled native dialog closes silently with a single IPC call', async () => {
    const b = await openReady(boot(), previewFixture({ ok: true, canceled: true, fileName: '', items: [] }));
    expect(b.component.isOpen()).toBe(false);
    expect(b.calls).toHaveLength(1);
  });

  it('a failed read shows the mapped error plus a close button and never enqueues', async () => {
    const b = await openReady(boot(), previewFixture({ ok: false, code: 'READ_FAILED', importId: '' }));
    expect(textOf(b.byId('txt-import-body') as TestNode))
      .toContain('queue.import.error.READ_FAILED{"code":"READ_FAILED"}');
    expect(b.calls.some((c) => c.channel === 'TXT_IMPORT_ENQUEUE')).toBe(false);
    const foot = b.byId('txt-import-foot') as TestNode;
    foot.children[foot.children.length - 1].dispatch('click', {});
    expect(b.component.isOpen()).toBe(false);
  });

  it('error text fallback chain: message first, unknown code, generic key, IPC notice', async () => {
    const withMessage = await openReady(boot(), previewFixture({ ok: false, message: 'boom', importId: '' }));
    expect(textOf(withMessage.byId('txt-import-body') as TestNode)).toContain('boom');

    const literal = await openReady(
      boot({ literalT: true }),
      previewFixture({ ok: false, code: 'READ_FAILED', importId: '' }),
    );
    expect(textOf(literal.byId('txt-import-body') as TestNode)).toContain('queue.import.error.generic');

    const unknownCode = await openReady(boot(), previewFixture({ ok: false, importId: '' }));
    expect(textOf(unknownCode.byId('txt-import-body') as TestNode))
      .toContain('queue.import.error.UNKNOWN{"code":"UNKNOWN"}');

    const noResult = boot();
    noResult.setPick(undefined);                                             // bridge 回了 undefined
    noResult.clickEntry();
    await tick();
    expect(textOf(noResult.byId('txt-import-body') as TestNode)).toContain('queue.notify.ipc');
  });
});

describe('txt-import · confirm and enqueue', () => {
  it('confirm sends importId + kind/quality and a D-160 operationId', async () => {
    const b = await openReady(boot());
    clickId(b, 'txt-import-confirm');
    expect(b.calls.map((c) => c.channel)).toEqual(['TXT_IMPORT_PICK', 'TXT_IMPORT_ENQUEUE']);
    const payload = b.calls[1].payload as Record<string, unknown>;
    expect(payload.importId).toBe('import-ticket-0001');
    expect(payload.kind).toBe('video');
    expect(payload.quality).toBe('1080p');
    expect(String(payload.operationId)).toMatch(/^txt-/);
    await tick();
  });

  it('an audio choice carries audioQuality/audioFormat and no quality key', async () => {
    const b = boot({ choice: { kind: 'audio', audioQuality: 'best', audioFormat: 'm4a' } });
    await openReady(b);
    clickId(b, 'txt-import-confirm');
    const payload = b.calls[1].payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      kind: 'audio', audioQuality: 'best', audioFormat: 'm4a', importId: 'import-ticket-0001',
    });
    expect(payload.quality).toBeUndefined();
    await tick();
  });

  it('without getChoice the payload falls back to a plain video submission', async () => {
    const b = boot({ choice: null });
    await openReady(b);
    clickId(b, 'txt-import-confirm');
    expect(b.calls[1].payload).toEqual({
      importId: 'import-ticket-0001', kind: 'video', operationId: expect.any(String),
    });
    await tick();
  });

  it('D-129: the result line carries the real requested / enqueued / failed counts', async () => {
    const b = boot({
      enqueue: {
        ok: false, code: 'PARTIAL_SUCCESS', requested: 3, enqueued: 2, failed: 1,
        taskIds: ['a', 'b'], failures: [{ url: 'https://v9', reason: 'ENQUEUE_FAILED' }],
      },
    });
    await openReady(b);
    clickId(b, 'txt-import-confirm');
    await tick();
    const bodyText = textOf(b.byId('txt-import-body') as TestNode);
    expect(bodyText).toContain('queue.import.result{"requested":3,"enqueued":2,"failed":1}');
    expect(bodyText).toContain('https://v9 — ENQUEUE_FAILED');
    expect(bodyText).toContain('queue.import.error.PARTIAL_SUCCESS{"code":"PARTIAL_SUCCESS"}');
    expect(b.notices[0]).toContain('"enqueued":2');
    expect(b.refreshed()).toBe(1);
    const foot = b.byId('txt-import-foot') as TestNode;
    foot.children[foot.children.length - 1].dispatch('click', {});           // 完成 → 关闭
    expect(b.component.isOpen()).toBe(false);
  });

  it('R1-03: the pre-check tally shows bucket counts, the skipped note and named URLs', async () => {
    const b = boot({
      enqueue: {
        ok: true, code: '', requested: 5, enqueued: 5, failed: 0, taskIds: [], failures: [],
        precheck: {
          examined: 4, supported: 2, unsupported: 0, noMedia: 1, indeterminate: 1, skipped: 1,
          unsupportedUrls: [], noMediaUrls: ['https://v2'], indeterminateUrls: ['https://v3'],
        },
      },
    });
    await openReady(b);
    clickId(b, 'txt-import-confirm');
    await tick();
    const bodyText = textOf(b.byId('txt-import-body') as TestNode);
    expect(bodyText).toContain('"supported":2');
    expect(bodyText).toContain('"unsupported":0');
    expect(bodyText).toContain('"noMedia":1');
    expect(bodyText).toContain('"indeterminate":1');
    expect(bodyText).toContain('"skipped":1');
    expect(bodyText).toContain('queue.precheck.skippedNote{"skipped":1}');
    expect(bodyText).toContain('queue.precheck.noMedia — https://v2');
    expect(bodyText).toContain('queue.precheck.indeterminate — https://v3');
  });

  it('a cancelled batch reads as a stop, not a failure tally', async () => {
    const b = boot({
      enqueue: { cancelled: true, ok: false, requested: 5, enqueued: 0, failed: 0, failures: [] },
    });
    await openReady(b);
    clickId(b, 'txt-import-confirm');
    await tick();
    const bodyText = textOf(b.byId('txt-import-body') as TestNode);
    expect(bodyText).toContain('queue.precheck.cancelledBatch');
    expect(bodyText).not.toContain('queue.import.result');
    expect(b.notices[0]).toBe('queue.precheck.cancelledBatch');
    expect(b.refreshed()).toBe(1);
  });

  it('confirm guards: a busy double-click enqueues once and a stale button click is ignored', async () => {
    const { gate, resolve } = enqueueGate();
    const b = boot({
      onCall: (channel) => channel === 'TXT_IMPORT_ENQUEUE' ? gate : undefined,
    });
    await openReady(b);
    clickId(b, 'txt-import-confirm');
    clickId(b, 'txt-import-confirm');                                        // busy：忽略
    expect(b.calls.filter((c) => c.channel === 'TXT_IMPORT_ENQUEUE')).toHaveLength(1);
    resolve({ ok: true, code: '', requested: 3, enqueued: 3, failed: 0, failures: [] });
    await tick();
    clickId(b, 'txt-import-confirm');                                        // preview 已清空：忽略
    expect(b.calls.filter((c) => c.channel === 'TXT_IMPORT_ENQUEUE')).toHaveLength(1);
    expect(b.component.currentPreview()).toBeNull();
  });

  it('the cancel button closes without enqueueing or refreshing', async () => {
    const b = await openReady(boot());
    clickId(b, 'txt-import-cancel');
    expect(b.component.isOpen()).toBe(false);
    expect(b.calls).toHaveLength(1);
    expect(b.refreshed()).toBe(0);
  });
});

describe('txt-import · T5 pre-check wait row and polling', () => {
  it('the wait row appears on confirm, disables the button and is removed by the reply', async () => {
    const { gate, resolve } = enqueueGate();
    const b = boot({ onCall: (channel) => channel === 'TXT_IMPORT_ENQUEUE' ? gate : undefined });
    await openReady(b);
    clickId(b, 'txt-import-confirm');
    const waitRow = b.byId('txt-import-wait');
    expect(waitRow).not.toBeNull();
    expect(textOf(waitRow as TestNode)).toContain('queue.precheck.checking');
    expect(b.byId('txt-import-confirm')?.getAttribute('disabled')).toBe('disabled');
    resolve({ ok: true, code: '', requested: 3, enqueued: 3, failed: 0, failures: [] });
    await tick();
    expect(b.byId('txt-import-wait')).toBeNull();
    expect(b.component.isOpen()).toBe(true);
  });

  it('the STATUS poll drives the readout and stops explicitly when inactive', async () => {
    const { gate, resolve } = enqueueGate();
    const b = boot({ onCall: (channel) => channel === 'TXT_IMPORT_ENQUEUE' ? gate : undefined });
    await openReady(b);
    clickId(b, 'txt-import-confirm');
    const operationId = (b.calls[1].payload as Record<string, unknown>).operationId;
    const progress = () => b.byId('txt-import-wait-progress') as TestNode;
    const statusCalls = () => b.calls.filter((c) => c.channel === 'URL_SUPPORT_CHECK_STATUS');
    expect(statusCalls()).toHaveLength(0);

    b.setStatus({ active: true });                                           // 缺 checked/total：不更新读数
    await vi.advanceTimersByTimeAsync(10);
    expect(statusCalls()).toHaveLength(1);
    expect(b.calls[2].payload).toEqual({ operationId });
    expect(progress().textContent).toBe('queue.precheck.checking');

    b.setStatus({ active: true, checked: 3, total: 5 });
    await vi.advanceTimersByTimeAsync(10);
    expect(progress().textContent).toBe('queue.precheck.progress{"checked":3,"total":5}');

    b.setStatus({ active: false });                                          // 批次结束：停止轮询
    await vi.advanceTimersByTimeAsync(10);
    expect(statusCalls()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(50);
    expect(statusCalls()).toHaveLength(3);                                   // interval 已被清除

    resolve({ ok: true, code: '', requested: 3, enqueued: 3, failed: 0, failures: [] });
    await tick();
    expect(b.byId('txt-import-wait')).toBeNull();
  });

  it('the wait-row cancel button cancels with the same operationId and locks itself', async () => {
    const { gate, resolve } = enqueueGate();
    const b = boot({ onCall: (channel) => channel === 'TXT_IMPORT_ENQUEUE' ? gate : undefined });
    await openReady(b);
    clickId(b, 'txt-import-confirm');
    const operationId = (b.calls[1].payload as Record<string, unknown>).operationId;
    clickId(b, 'txt-import-cancel-precheck');
    expect(b.calls[2]).toEqual({ channel: 'URL_SUPPORT_CHECK_CANCEL', payload: { operationId } });
    expect(b.byId('txt-import-cancel-precheck')?.getAttribute('disabled')).toBe('disabled');
    expect((b.byId('txt-import-wait-progress') as TestNode).textContent).toBe('queue.precheck.cancelling');
    resolve({ ok: true, code: '', requested: 3, enqueued: 3, failed: 0, failures: [] });
    await tick();
    expect(b.byId('txt-import-wait')).toBeNull();
  });
});

describe('txt-import · close and cleanup', () => {
  it('closing before the reply still cancels the pre-check and shows the late reply honestly', async () => {
    const { gate, resolve } = enqueueGate();
    const b = boot({ onCall: (channel) => channel === 'TXT_IMPORT_ENQUEUE' ? gate : undefined });
    await openReady(b);
    clickId(b, 'txt-import-confirm');
    const operationId = (b.calls[1].payload as Record<string, unknown>).operationId;
    b.component.close();
    expect(b.component.isOpen()).toBe(false);
    expect(b.calls[2]).toEqual({ channel: 'URL_SUPPORT_CHECK_CANCEL', payload: { operationId } });
    expect(b.byId('txt-import-wait')).toBeNull();                            // 等待行一并清理
    resolve({ ok: true, code: '', requested: 3, enqueued: 3, failed: 0, failures: [] });
    await tick();
    expect(b.component.isOpen()).toBe(true);                                 // 迟到回执以新壳如实呈现
    expect(b.notices[0]).toContain('"enqueued":3');
    expect(b.refreshed()).toBe(1);
  });

  it('an idle close sends no CANCEL, detaches the overlay and is idempotent', async () => {
    const b = await openReady(boot());
    const overlay = b.byId('txt-import-dialog') as TestNode;
    const head = overlay.children[0].children[0] as TestNode;                // box → head
    head.children[head.children.length - 1].dispatch('click', {});           // 头部 × 按钮
    expect(b.component.isOpen()).toBe(false);
    expect(b.calls.map((c) => c.channel)).toEqual(['TXT_IMPORT_PICK']);
    expect(b.byId('txt-import-body')).toBeNull();                            // 遮罩已脱离文档
    b.component.close();                                                     // 幂等
    expect(b.component.isOpen()).toBe(false);
    expect(b.calls).toHaveLength(1);
  });
});
