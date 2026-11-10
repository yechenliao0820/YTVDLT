/**
 * D-120 · download TASK CARD: local-file state hint + honest action feedback.
 *
 * Runs the real `queue.js` against the shared fake DOM. Every assertion is a
 * state the user can see on the card / status line, not an internal variable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  FakeNode, barOf, cardById, dto, findAll, harness, onlyCard, type QueuePageHarness,
} from './helpers/queue-page-harness.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

interface Dialog { backdrop: FakeNode; check: FakeNode; confirm: FakeNode; box: FakeNode; status: FakeNode }

function makeDialog(): Dialog {
  const check = new FakeNode('input');
  check.type = 'checkbox';
  check.checked = false;
  return {
    backdrop: new FakeNode('div'),
    check,
    confirm: new FakeNode('button'),
    box: new FakeNode('label'),
    status: new FakeNode('div'),
  };
}

function elementsOf(dialog: Dialog): Record<string, FakeNode> {
  return {
    'queue-modal': dialog.backdrop,
    'queue-modal-with-files': dialog.check,
    'queue-modal-check': dialog.box,
    'queue-modal-confirm': dialog.confirm,
    'queue-status': dialog.status,
  };
}

async function page(
  items: readonly unknown[],
  lang: 'zh-CN' | 'en' = 'zh-CN',
  onInvoke?: (channel: string, payload: unknown) => unknown,
) {
  const dialog = makeDialog();
  const h = harness({ items, live: true, lang, elements: elementsOf(dialog), onInvoke });
  await h.settle();
  await h.setItems(items);
  return { h, dialog };
}

function stateNode(h: QueuePageHarness, id: string): FakeNode | null {
  const found = findAll(cardById(h, id), (n) => n.className === 'card-file-state');
  return found.length === 0 ? null : found[0] as FakeNode;
}

function buttonOf(h: QueuePageHarness, id: string, action: string): FakeNode {
  const found = findAll(cardById(h, id), (n) => n.getAttribute('data-action') === action);
  if (found.length !== 1) throw new Error(`expected one ${action} button, got ${found.length}`);
  return found[0] as FakeNode;
}

const click = (node: FakeNode) => (node.listeners['click'] ?? []).forEach((fn) => fn({ target: node }));
const change = (node: FakeNode) => (node.listeners['change'] ?? []).forEach((fn) => fn({ target: node }));
const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };

const done = (fileStatus?: string) => dto({
  id: 'c1', state: 'Completed', percent: 100,
  ...(fileStatus === undefined ? {} : { fileStatus, dirStatus: fileStatus === 'missing' ? 'present' : fileStatus }),
});

describe('D-120 · lightweight card state', () => {
  it('1. a missing file shows a hint on the CARD, not the checkbox or page', async () => {
    const { h } = await page([done('missing')]);
    const node = stateNode(h, 'c1');
    expect(node?.textContent).toBe('本地文件已不存在');
    expect(node?.getAttribute('data-file-status')).toBe('missing');
    expect(cardById(h, 'c1').getAttribute('data-state')).toBe('Completed');
    expect(cardById(h, 'c1').getAttribute('data-task-id')).toBe('c1');
  });

  it('2. a present file keeps the original finished look (no hint)', async () => {
    const { h } = await page([done('present')]);
    expect(stateNode(h, 'c1')).toBeNull();
  });

  it('3. an unprobed record paints nothing (static preview baselines unchanged)', async () => {
    const { h } = await page([done()]);
    expect(stateNode(h, 'c1')).toBeNull();
  });

  it('4. a running task is never marked, even if a stale status arrives', async () => {
    const { h } = await page([dto({ id: 'r1', state: 'Running', percent: 30, fileStatus: 'missing' })]);
    expect(stateNode(h, 'r1')).toBeNull();
  });

  it('5. inaccessible / unavailable / invalid are distinct copies', async () => {
    for (const [status, copy] of [
      ['inaccessible', '本地文件无法访问'],
      ['unavailable', '本地文件状态暂时无法确定'],
      ['invalid', '本地文件路径无效'],
    ] as const) {
      const { h } = await page([done(status)]);
      expect(stateNode(h, 'c1')?.textContent).toBe(copy);
    }
  });

  it('6. the hint does not hide the cover, title, progress bar or buttons', async () => {
    const { h } = await page([done('missing')]);
    const card = cardById(h, 'c1');
    expect(findAll(card, (n) => n.className === 'thumb').length).toBeGreaterThan(0);
    expect(findAll(card, (n) => n.className === 'card-title').length).toBe(1);
    expect(barOf(card).getAttribute('data-mode')).toBe('done');
    expect(findAll(card, (n) => n.getAttribute('data-action') === 'folder')).toHaveLength(1);
    expect(findAll(card, (n) => n.getAttribute('data-action') === 'remove')).toHaveLength(1);
  });

  it('7. English copy follows the locale', async () => {
    const { h } = await page([done('missing')], 'en');
    expect(stateNode(h, 'c1')?.textContent).toBe('Local file is missing');
  });

  it('8. an external deletion appears after re-entering / refreshing the queue', async () => {
    const { h } = await page([done('present')]);
    expect(stateNode(h, 'c1')).toBeNull();
    await h.setItems([done('missing')]);
    expect(stateNode(h, 'c1')?.textContent).toBe('本地文件已不存在');
    // And a restored file clears the hint again.
    await h.setItems([done('present')]);
    expect(stateNode(h, 'c1')).toBeNull();
  });

  it('9. the first list request asks main for a fresh probe; plain polls do not', async () => {
    const { h } = await page([done('present')]);
    const lists = h.calls.filter((call) => call.channel === 'ytvdlt:task:list');
    expect(lists.length).toBeGreaterThan(0);
    expect((lists[0]?.payload as Record<string, unknown>)['refreshFileStatus']).toBe(true);
    expect(lists.slice(1).every((call) => (call.payload as Record<string, unknown>)['refreshFileStatus'] === undefined)).toBe(true);
  });
});

describe('D-120 · open-file on the task card', () => {
  it('the live card exposes an "open file" button; static preview does not', async () => {
    const { h } = await page([done('present')]);
    expect(findAll(cardById(h, 'c1'), (n) => n.getAttribute('data-action') === 'file')).toHaveLength(1);
    const staticHarness = harness({ items: [done('present')] });
    expect(findAll(onlyCard(staticHarness), (n) => n.getAttribute('data-action') === 'file')).toHaveLength(0);
  });

  it('clicking it sends action=open-file through the existing TASK_ACTION channel', async () => {
    const { h } = await page([done('present')]);
    const before = h.calls.length;
    click(buttonOf(h, 'c1', 'file'));
    await flush();
    const action = h.calls.slice(before).find((call) => call.channel === 'ytvdlt:task:action');
    expect(action?.payload).toMatchObject({ taskId: 'c1', action: 'open-file' });
  });

  it('a deleted file produces the exact "cannot open" notice', async () => {
    const { h, dialog } = await page([done('missing')], 'zh-CN', (channel) =>
      channel === 'ytvdlt:task:action' ? { ok: false, code: 'FILE_MISSING', message: 'x' } : undefined);
    click(buttonOf(h, 'c1', 'file'));
    await flush();
    expect(dialog.status.textContent).toContain('无法打开文件：该视频文件已不存在于原保存位置');
  });

  it('permission / volume errors on open-file are NOT reported as a deleted file', async () => {
    for (const [code, copy] of [
      ['FILE_INACCESSIBLE', '没有访问权限'],
      ['FILE_UNAVAILABLE', '暂时无法确认文件状态'],
      ['NO_ARTIFACT', '任务记录中没有有效的本地文件路径'],
    ] as const) {
      const { h, dialog } = await page([done('missing')], 'zh-CN', (channel) =>
        channel === 'ytvdlt:task:action' ? { ok: false, code, message: 'x' } : undefined);
      click(buttonOf(h, 'c1', 'file'));
      await flush();
      expect(dialog.status.textContent).toContain(copy);
      expect(dialog.status.textContent).not.toContain('该视频文件已不存在');
    }
  });

  it('English open-file notice', async () => {
    const { h, dialog } = await page([done('missing')], 'en', (channel) =>
      channel === 'ytvdlt:task:action' ? { ok: false, code: 'FILE_MISSING', message: 'x' } : undefined);
    click(buttonOf(h, 'c1', 'file'));
    await flush();
    expect(dialog.status.textContent).toContain('Cannot open the file');
  });
});

describe('D-120 · open-file / open-folder feedback', () => {
  it('file gone but folder present: still opens the folder, with an honest notice', async () => {
    const { h, dialog } = await page([done('missing')], 'zh-CN', (channel) =>
      channel === 'ytvdlt:task:action' ? { ok: true, fileStatus: 'missing' } : undefined);
    click(buttonOf(h, 'c1', 'folder'));
    await flush();
    expect(dialog.status.textContent).toContain('已为你打开原保存文件夹');
  });

  it('both file and folder gone: says the folder is gone, not "done"', async () => {
    const { h, dialog } = await page([done('missing')], 'zh-CN', (channel) =>
      channel === 'ytvdlt:task:action' ? { ok: false, code: 'FOLDER_MISSING', message: 'x' } : undefined);
    click(buttonOf(h, 'c1', 'folder'));
    await flush();
    expect(dialog.status.textContent).toContain('原下载文件夹已不存在或无法访问');
  });

  it('permission / volume errors never print the "file missing" copy', async () => {
    for (const [code, copy] of [
      ['FOLDER_INACCESSIBLE', '原下载文件夹无法访问'],
      ['FOLDER_UNAVAILABLE', '暂时无法确认原下载文件夹状态'],
      ['NO_ARTIFACT', '任务记录中没有有效的本地文件路径'],
    ] as const) {
      const { h, dialog } = await page([done('missing')], 'zh-CN', (channel) =>
        channel === 'ytvdlt:task:action' ? { ok: false, code, message: 'x' } : undefined);
      click(buttonOf(h, 'c1', 'folder'));
      await flush();
      expect(dialog.status.textContent).toContain(copy);
      expect(dialog.status.textContent).not.toContain('该视频文件已不存在');
    }
  });

  it('English notices use the English catalogue', async () => {
    const { h, dialog } = await page([done('missing')], 'en', (channel) =>
      channel === 'ytvdlt:task:action' ? { ok: false, code: 'FOLDER_MISSING', message: 'x' } : undefined);
    click(buttonOf(h, 'c1', 'folder'));
    await flush();
    expect(dialog.status.textContent).toContain('original download folder');
  });

  it('an open action asks for a fresh stat on the following refresh', async () => {
    const { h } = await page([done('missing')]);
    const before = h.calls.length;
    click(buttonOf(h, 'c1', 'folder'));
    await flush();
    const lists = h.calls.slice(before).filter((call) => call.channel === 'ytvdlt:task:list');
    expect(lists.some((call) => (call.payload as Record<string, unknown>)['refreshFileStatus'] === true)).toBe(true);
  });
});

describe('D-120 · delete feedback', () => {
  async function removeWithFiles(
    result: unknown,
    lang: 'zh-CN' | 'en' = 'zh-CN',
  ) {
    const { h, dialog } = await page([done('missing')], lang, (channel) =>
      channel === 'ytvdlt:task:action' ? result : undefined);
    click(buttonOf(h, 'c1', 'remove'));
    dialog.check.checked = true;
    change(dialog.check);
    click(dialog.confirm);
    await flush();
    return dialog.status.textContent;
  }

  it('a file that was already gone still lets the history be deleted', async () => {
    const copy = await removeWithFiles({ ok: true, filesMissing: 1, filesTrashed: 0, sharedSkipped: 0 });
    expect(copy).toContain('本地文件已不存在，已清理任务历史记录');
  });

  it('a shared file is kept; the record is still removed', async () => {
    const copy = await removeWithFiles({ ok: true, filesMissing: 0, filesTrashed: 0, sharedSkipped: 1 });
    expect(copy).toContain('仍被其他任务引用');
  });

  it('a REAL filesystem failure reports the reason and the fallback, not success', async () => {
    const copy = await removeWithFiles({ ok: false, code: 'FILE_DELETE_FAILED', reason: 'EBUSY: locked', message: 'x' });
    expect(copy).toContain('EBUSY');
    expect(copy).toContain('仅删除历史记录');
  });

  it('English delete feedback', async () => {
    const copy = await removeWithFiles({ ok: true, filesMissing: 1, filesTrashed: 0, sharedSkipped: 0 }, 'en');
    expect(copy).toContain('already gone');
  });
});
