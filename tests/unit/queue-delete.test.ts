/**
 * D-116: the delete dialog.
 *
 * The old dialog had two primary buttons side by side ("only the record" /
 * "also the files") with the destructive one permanently red. The contract now
 * is: one confirm button, one checkbox that starts unticked, and the button
 * only turns red once the user ticks it.
 *
 * Every assertion here is about a state the USER can see — the checkbox, the
 * button class, the confirm copy, and the payload that actually reaches the
 * main process (`withFiles`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  FakeNode, cardById, dto, findAll, harness, type QueuePageHarness,
} from './helpers/queue-page-harness.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

interface Dialog {
  backdrop: FakeNode;
  box: FakeNode;
  check: FakeNode;
  risk: FakeNode;
  confirm: FakeNode;
  cancel: FakeNode;
  title: FakeNode;
  count: FakeNode;
  note: FakeNode;
  clear: FakeNode;
}

function makeDialog(): Dialog {
  const check = new FakeNode('input');
  check.type = 'checkbox';
  const dialog: Dialog = {
    backdrop: new FakeNode('div'),
    box: new FakeNode('label'),
    check,
    risk: new FakeNode('small'),
    confirm: new FakeNode('button'),
    cancel: new FakeNode('button'),
    title: new FakeNode('h2'),
    count: new FakeNode('p'),
    note: new FakeNode('p'),
    clear: new FakeNode('button'),
  };
  check.checked = false;
  // The shipped markup carries this copy with a `data-i18n` key; the fake DOM
  // has no catalogue, so the initial text is set here to mirror index.html.
  dialog.risk.textContent = '该任务的本地文件（视频、音频、字幕等）将移入回收站。';
  return dialog;
}

function elementsOf(dialog: Dialog): Record<string, FakeNode> {
  return {
    'queue-modal': dialog.backdrop,
    'queue-modal-check': dialog.box,
    'queue-modal-with-files': dialog.check,
    'queue-modal-risk': dialog.risk,
    'queue-modal-confirm': dialog.confirm,
    'queue-modal-cancel': dialog.cancel,
    'queue-modal-title': dialog.title,
    'queue-modal-count': dialog.count,
    'queue-modal-note': dialog.note,
    'queue-clear-history': dialog.clear,
  };
}

/** Let the removal promise chain settle without spinning the page's poll loop. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function click(node: FakeNode): void {
  (node.listeners['click'] ?? []).forEach((fn) => fn({ target: node }));
}

function change(node: FakeNode): void {
  (node.listeners['change'] ?? []).forEach((fn) => fn({ target: node }));
}

async function page(items: readonly unknown[] = [
  dto({ id: 'c1', state: 'Completed', percent: 100 }),
], lang: 'zh-CN' | 'en' = 'zh-CN') {
  const dialog = makeDialog();
  const h = harness({ items, live: true, lang, elements: elementsOf(dialog) });
  await h.settle();
  await h.setItems(items);
  return { h, dialog };
}

function removeButtonOf(h: QueuePageHarness, id: string): FakeNode {
  const card = cardById(h, id);
  const buttons = findAll(card, (n) => n.getAttribute('data-action') === 'remove');
  if (buttons.length !== 1) throw new Error(`expected exactly one remove button, got ${buttons.length}`);
  return buttons[0] as FakeNode;
}

describe('D-116 delete confirmation', () => {
  it('opens unticked with a neutral (primary) confirm button', async () => {
    const { h, dialog } = await page();
    click(removeButtonOf(h, 'c1'));

    expect(dialog.backdrop.getAttribute('hidden')).toBe('false');
    expect(dialog.check.checked).toBe(false);
    expect(dialog.confirm.className).toBe('primary');
    expect(dialog.confirm.textContent).toBe('删除');
    expect(dialog.box.getAttribute('data-risk')).toBe('false');
    // Risk copy is hidden until the box is ticked.
    expect(dialog.risk.getAttribute('hidden')).toBe('true');
  });

  it('turns the confirm button red and shows the risk copy once ticked', async () => {
    const { h, dialog } = await page();
    click(removeButtonOf(h, 'c1'));
    dialog.check.checked = true;
    change(dialog.check);

    expect(dialog.confirm.className).toBe('danger');
    expect(dialog.confirm.textContent).toBe('删除并移入回收站');
    expect(dialog.box.getAttribute('data-risk')).toBe('true');
    expect(dialog.risk.getAttribute('hidden')).toBe('false');
    expect(dialog.risk.textContent).toContain('视频');
  });

  it('unticking goes back to the safe state', async () => {
    const { h, dialog } = await page();
    click(removeButtonOf(h, 'c1'));
    dialog.check.checked = true;
    change(dialog.check);
    dialog.check.checked = false;
    change(dialog.check);
    expect(dialog.confirm.className).toBe('primary');
    expect(dialog.risk.getAttribute('hidden')).toBe('true');
  });

  it('re-opening the dialog always starts unticked', async () => {
    const { h, dialog } = await page();
    click(removeButtonOf(h, 'c1'));
    dialog.check.checked = true;
    change(dialog.check);
    // Cancel and open again.
    click(dialog.cancel);
    expect(dialog.check.checked).toBe(false);
    click(removeButtonOf(h, 'c1'));
    expect(dialog.check.checked).toBe(false);
    expect(dialog.confirm.className).toBe('primary');
  });

  it('cancel performs no removal at all', async () => {
    const { h, dialog } = await page();
    click(removeButtonOf(h, 'c1'));
    click(dialog.cancel);
    await flush();
    const actions = h.calls.filter((call) => call.channel === 'ytvdlt:task:action');
    expect(actions).toHaveLength(0);
  });

  it('confirming without the tick removes the record only', async () => {
    const { h, dialog } = await page();
    click(removeButtonOf(h, 'c1'));
    click(dialog.confirm);
    await flush();
    const actions = h.calls.filter((call) => call.channel === 'ytvdlt:task:action');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.payload).toMatchObject({ taskId: 'c1', action: 'remove' });
    expect(actions[0]?.payload).not.toHaveProperty('withFiles');
  });

  it('confirming with the tick asks the main process to recycle the files', async () => {
    const { h, dialog } = await page();
    click(removeButtonOf(h, 'c1'));
    dialog.check.checked = true;
    change(dialog.check);
    click(dialog.confirm);
    await flush();
    const actions = h.calls.filter((call) => call.channel === 'ytvdlt:task:action');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.payload).toMatchObject({ taskId: 'c1', action: 'remove', withFiles: true });
  });

  it('clear-history also starts unticked and never deletes files by default', async () => {
    const { h, dialog } = await page();
    click(dialog.clear);
    expect(dialog.check.checked).toBe(false);
    expect(dialog.confirm.className).toBe('primary');
    expect(dialog.confirm.textContent).toBe('确认清空');

    click(dialog.confirm);
    await flush();
    const actions = h.calls.filter((call) => call.channel === 'ytvdlt:task:action');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.payload).not.toHaveProperty('withFiles');
  });

  it('clear-history may opt in to recycling, with a red button', async () => {
    const { h, dialog } = await page();
    click(dialog.clear);
    dialog.check.checked = true;
    change(dialog.check);
    expect(dialog.confirm.className).toBe('danger');
    expect(dialog.confirm.textContent).toBe('清空并移入回收站');

    click(dialog.confirm);
    await flush();
    const actions = h.calls.filter((call) => call.channel === 'ytvdlt:task:action');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.payload).toMatchObject({ withFiles: true });
  });

  it('speaks English in the English build', async () => {
    const { h, dialog } = await page([
      dto({ id: 'c1', state: 'Completed', percent: 100 }),
    ], 'en');
    click(removeButtonOf(h, 'c1'));
    expect(dialog.confirm.textContent).toBe('Delete');
    dialog.check.checked = true;
    change(dialog.check);
    expect(dialog.confirm.textContent).toBe('Delete and recycle files');
  });

  // D-203: when the main process refuses the whole withFiles batch
  // (request-less record), the page must show the real refusal — never a
  // success, and never a silent fallback that deletes the history anyway.
  it('a FILE_DELETE_FAILED refusal is reported and the record stays listed', async () => {
    const dialog = makeDialog();
    const status = new FakeNode('p');
    const reason = '无法验证产物文件归属（任务缺少可用的下载请求信息），为防止误删已拒绝回收本地文件';
    const h = harness({
      items: [dto({ id: 'c1', state: 'Completed', percent: 100 })],
      live: true, lang: 'zh-CN',
      elements: { ...elementsOf(dialog), 'queue-status': status },
      onInvoke: (channel, payload) => {
        if (channel === 'ytvdlt:task:action' && (payload as { withFiles?: unknown }).withFiles === true) {
          return { ok: false, code: 'FILE_DELETE_FAILED', failureKind: 'file-cleanup', reason };
        }
        return undefined;
      },
    });
    await h.settle();
    await h.setItems([dto({ id: 'c1', state: 'Completed', percent: 100 })]);
    click(removeButtonOf(h, 'c1'));
    dialog.check.checked = true;
    change(dialog.check);
    click(dialog.confirm);
    await flush();

    const actions = h.calls.filter((call) => call.channel === 'ytvdlt:task:action');
    expect(actions).toHaveLength(1); // exactly the refused withFiles call
    expect(actions[0]?.payload).toMatchObject({ taskId: 'c1', action: 'remove', withFiles: true });
    // The shipped failure copy names the real reason and the kept record.
    expect(status.textContent).toContain('本地文件清理失败');
    expect(status.textContent).toContain(reason);
    expect(status.textContent).toContain('任务记录已保留');
  });
});
