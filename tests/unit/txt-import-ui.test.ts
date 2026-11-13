/**
 * TXT import · REAL renderer component against a tiny fake DOM.
 *
 * The shipped `txt-import.js` is executed verbatim (no re-implementation), so
 * these cases verify the user-visible contract: a preview is shown, nothing
 * downloads until confirm, cancel does nothing, and the final message carries
 * the real enqueue numbers rather than a rounded-up "success".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpolate } from '@ytvdlt/core';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const UI_SRC = join(ROOT, 'packages', 'ui', 'src');
const COMPONENT = readFileSync(join(UI_SRC, 'txt-import', 'txt-import.js'), 'utf8');
const CATALOGUE = readFileSync(join(UI_SRC, 'i18n', 'messages.js'), 'utf8');

type Listener = (event?: { preventDefault?: () => void }) => void;

class FakeNode {
  readonly attrs: Record<string, string> = {};
  readonly children: FakeNode[] = [];
  readonly listeners: Record<string, Listener[]> = {};
  parentNode: FakeNode | null = null;
  private text = '';

  constructor(readonly tagName: string, private readonly owner: FakeDoc) {}

  set className(value: string) { this.attrs['class'] = String(value); }
  get className(): string { return this.attrs['class'] ?? ''; }
  setAttribute(key: string, value: unknown): void {
    this.attrs[key] = String(value);
    if (key === 'id') this.owner.byId.set(String(value), this);
  }
  getAttribute(key: string): string | null { return this.attrs[key] ?? null; }
  appendChild(child: FakeNode): FakeNode {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(node: FakeNode, ref: FakeNode | null): FakeNode {
    node.parentNode = this;
    const at = ref === null ? this.children.length : this.children.indexOf(ref);
    this.children.splice(at < 0 ? this.children.length : at, 0, node);
    return node;
  }
  removeChild(node: FakeNode): FakeNode {
    const at = this.children.indexOf(node);
    if (at !== -1) this.children.splice(at, 1);
    node.parentNode = null;
    return node;
  }
  get nextSibling(): FakeNode | null {
    if (this.parentNode === null) return null;
    const at = this.parentNode.children.indexOf(this);
    return this.parentNode.children[at + 1] ?? null;
  }
  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }
  querySelector(selector: string): FakeNode | null {
    return selector.startsWith('#') ? this.owner.byId.get(selector.slice(1)) ?? null : null;
  }
  get textContent(): string {
    return this.children.length === 0
      ? this.text
      : this.children.map((child) => child.textContent).join('');
  }
  set textContent(value: string) { this.children = []; this.text = String(value); }
  click(): void { (this.listeners['click'] ?? []).forEach((fn) => fn({ preventDefault() {} })); }
}

class FakeDoc {
  readonly byId = new Map<string, FakeNode>();
  readonly head = new FakeNode('head', this);
  readonly body = new FakeNode('body', this);
  createElement(tag: string): FakeNode { return new FakeNode(tag, this); }
}

interface Call { channel: string; payload: Record<string, unknown> }

function catalogue(): Record<string, Record<string, string>> {
  const sandbox: Record<string, unknown> = {};
  new Function('window', CATALOGUE)(sandbox);
  return (sandbox['YTVDLT_I18N'] as { MESSAGES: Record<string, Record<string, string>> }).MESSAGES;
}

const MESSAGES = catalogue();

function t(key: string, params?: Record<string, unknown>): string {
  const raw = MESSAGES['zh-CN']?.[key];
  return typeof raw === 'string' ? interpolate(raw, params ?? {}) : key;
}

const V = (n: number): string => `https://www.youtube.com/watch?v=video${String(n).padStart(3, '0')}`;

function preview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true, canceled: false, code: '', fileName: 'links.txt',
    importId: 'import-ticket-0001', totalLines: 6, blankCount: 1,
    validCount: 3, invalidCount: 1, duplicateCount: 1, playlistCount: 1,
    maxUrls: 200,
    items: [
      { line: 1, text: V(1), status: 'valid', reason: 'OK' },
      { line: 2, text: V(2), status: 'valid', reason: 'OK' },
      { line: 3, text: 'nope', status: 'invalid', reason: 'INVALID_URL' },
      { line: 4, text: V(1), status: 'duplicate', reason: 'DUPLICATE_URL' },
      { line: 5, text: 'https://www.youtube.com/playlist?list=PL1', status: 'playlist', reason: 'PLAYLIST_URL' },
    ],
    ...overrides,
  };
}

function harness(replies: {
  pick?: Record<string, unknown>;
  enqueue?: Record<string, unknown>;
}) {
  const doc = new FakeDoc();
  const calls: Call[] = [];
  const notices: string[] = [];
  let refreshed = 0;
  const sandbox: Record<string, unknown> = {};
  new Function('window', COMPONENT)(sandbox);

  const call = (channel: string, payload: Record<string, unknown>): Promise<unknown> => {
    calls.push({ channel, payload });
    if (channel === 'TXT_IMPORT_PICK') return Promise.resolve(replies.pick ?? preview());
    if (channel === 'TXT_IMPORT_ENQUEUE') {
      return Promise.resolve(replies.enqueue ?? {
        ok: true, code: '', requested: 3, enqueued: 3, failed: 0,
        taskIds: ['a', 'b', 'c'], failures: [],
      });
    }
    return Promise.resolve({ ok: false, code: 'UNEXPECTED' });
  };

  const component = (sandbox['YTVDLT'] as {
    txtImport: { create(options: Record<string, unknown>): {
      mount(anchor: FakeNode, css: string): void;
      open(): void;
      close(): void;
      isOpen(): boolean;
      currentPreview(): unknown;
    } },
  }).txtImport.create({
    doc,
    t,
    call,
    notify: (text: string) => notices.push(text),
    getChoice: () => ({ kind: 'video', videoQuality: '1080p', audioQuality: 'best', audioFormat: 'auto' }),
    refresh: () => { refreshed += 1; },
  });

  const parent = doc.createElement('div');
  const anchor = doc.createElement('form');
  anchor.setAttribute('id', 'queue-paste-form');
  parent.appendChild(anchor);
  component.mount(anchor, '../../styles/txt-import.css');
  const entry = doc.byId.get('queue-import-txt');
  return { doc, calls, notices, component, entry, refreshed: () => refreshed };
}

const tick = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
};

describe('TXT import UI · preview before any download', () => {
  it('mounts one labelled entry button without adding a static node to the page', () => {
    const h = harness({});
    expect(h.entry).toBeDefined();
    expect(h.entry?.getAttribute('data-i18n')).toBe('queue.import.button');
    expect(h.entry?.textContent).toBe('导入 TXT');
    expect(h.calls).toEqual([]);
  });

  it('opens the native picker but NEVER enqueues until the user confirms', async () => {
    const h = harness({});
    h.entry?.click();
    await tick();
    expect(h.calls.map((c) => c.channel)).toEqual(['TXT_IMPORT_PICK']);
    expect(h.calls[0]?.payload).toEqual({});
    expect(h.calls.some((c) => c.channel === 'TXT_IMPORT_ENQUEUE')).toBe(false);
  });

  it('shows the file name, all six counts and the URL list', async () => {
    const h = harness({});
    h.entry?.click();
    await tick();
    const body = h.doc.byId.get('txt-import-body');
    const text = body?.textContent ?? '';
    expect(text).toContain('links.txt');
    expect(text).toContain('总行数');
    expect(text).toContain('有效 URL');
    expect(text).toContain('无效 URL');
    expect(text).toContain('重复 URL');
    expect(text).toContain('播放列表');
    expect(text).toContain(V(1));
    expect(text).toContain('URL 列表');
    const list = h.doc.byId.get('txt-import-list');
    expect(list?.children).toHaveLength(5);
    expect(h.doc.byId.get('txt-import-confirm')?.getAttribute('disabled')).toBeNull();
  });

  it('cancel closes the dialog and still enqueues nothing', async () => {
    const h = harness({});
    h.entry?.click();
    await tick();
    h.doc.byId.get('txt-import-cancel')?.click();
    expect(h.component.isOpen()).toBe(false);
    expect(h.calls.some((c) => c.channel === 'TXT_IMPORT_ENQUEUE')).toBe(false);
    expect(h.refreshed()).toBe(0);
  });

  it('a preview with no valid URL cannot be confirmed', async () => {
    const h = harness({ pick: preview({ code: 'NO_VALID_URL', validCount: 0, importId: '', items: [] }) });
    h.entry?.click();
    await tick();
    expect(h.doc.byId.get('txt-import-confirm')?.getAttribute('disabled')).toBe('disabled');
    expect(h.doc.byId.get('txt-import-body')?.textContent).toContain('没有有效的单视频链接');
  });

  it('a cancelled native dialog closes without an error or a download', async () => {
    const h = harness({ pick: { ok: true, canceled: true, code: '', fileName: '', items: [] } });
    h.entry?.click();
    await tick();
    expect(h.component.isOpen()).toBe(false);
    expect(h.calls).toHaveLength(1);
  });
});

describe('TXT import UI · confirm and honest results', () => {
  it('confirm sends only the import id + existing download enums', async () => {
    const h = harness({});
    h.entry?.click();
    await tick();
    h.doc.byId.get('txt-import-confirm')?.click();
    await tick();
    expect(h.calls.map((c) => c.channel)).toEqual(['TXT_IMPORT_PICK', 'TXT_IMPORT_ENQUEUE']);
    expect(h.calls[1]?.payload).toEqual({
      importId: 'import-ticket-0001', kind: 'video', quality: '1080p',
      operationId: expect.any(String), // D-160: this submission's cancel scope
    });
  });

  it('shows the real requested / enqueued / failed numbers and refreshes the queue', async () => {
    const h = harness({
      enqueue: {
        ok: false, code: 'PARTIAL_SUCCESS', requested: 3, enqueued: 2, failed: 1,
        taskIds: ['a', 'b'],
        failures: [{ url: V(3), reason: 'ENQUEUE_FAILED' }],
      },
    });
    h.entry?.click();
    await tick();
    h.doc.byId.get('txt-import-confirm')?.click();
    await tick();
    const text = h.doc.byId.get('txt-import-body')?.textContent ?? '';
    expect(text).toContain('共 3 条，成功加入 2 个任务，失败 1 个');
    expect(text).toContain(V(3));
    expect(text).toContain('部分任务加入成功');
    expect(h.notices[0]).toContain('成功加入 2 个任务');
    expect(h.refreshed()).toBe(1);
  });

  /**
   * R1-03 - the pre-check tally.
   *
   * Requirement: "分类统计（支持/不支持/不确定各几条 + 具体 URL）". The renderer
   * must show those numbers, must not print "not checked" as "supported", and
   * must name the urls in the non-blocking buckets (those do NOT appear in
   * `failures`, so without this block they were invisible).
   */
  it('renders the three-way pre-check tally and the urls it could not confirm', async () => {
    const h = harness({
      enqueue: {
        ok: true, code: '', requested: 5, enqueued: 5, failed: 0,
        taskIds: ['a', 'b', 'c', 'd', 'e'], failures: [],
        precheck: {
          examined: 4, supported: 2, unsupported: 0, noMedia: 1, indeterminate: 1,
          skipped: 1,
          unsupportedUrls: [], noMediaUrls: [V(2)], indeterminateUrls: [V(3)],
        },
      },
    });
    h.entry?.click();
    await tick();
    h.doc.byId.get('txt-import-confirm')?.click();
    await tick();
    const text = h.doc.byId.get('txt-import-body')?.textContent ?? '';
    expect(text).toContain('链接预检');
    expect(text).toContain('支持 2');
    expect(text).toContain('不支持 0');
    expect(text).toContain('无媒体 1');
    expect(text).toContain('未确认 1');
    expect(text).toContain('未检查 1');
    // The skipped count is called out separately: it must never read as covered.
    expect(text).toContain('没有经过预检');
    // Named urls for the buckets that are not failures.
    expect(text).toContain('无媒体 — ' + V(2));
    expect(text).toContain('未确认 — ' + V(3));
  });

  it('omits the pre-check block entirely when the build has no pre-check port', async () => {
    const h = harness({
      enqueue: {
        ok: true, code: '', requested: 3, enqueued: 3, failed: 0,
        taskIds: ['a', 'b', 'c'], failures: [],
      },
    });
    h.entry?.click();
    await tick();
    h.doc.byId.get('txt-import-confirm')?.click();
    await tick();
    const text = h.doc.byId.get('txt-import-body')?.textContent ?? '';
    // No tally means "we did not check", and the UI must not invent a 0/0/0 line
    // that would read as "everything confirmed".
    expect(text).not.toContain('链接预检');
  });

  it('a failed IPC call shows the error and never claims success', async () => {
    const h = harness({ pick: { ok: false, code: 'FILE_TOO_LARGE', items: [] } });
    h.entry?.click();
    await tick();
    const text = h.doc.byId.get('txt-import-body')?.textContent ?? '';
    expect(text).toContain('文件过大');
    expect(h.calls.some((c) => c.channel === 'TXT_IMPORT_ENQUEUE')).toBe(false);
  });
});
