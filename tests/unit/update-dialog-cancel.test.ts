import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

it('offers cancellation immediately and ignores a stale download response', async () => {
  const nodes = new Map<string, any>();
  function element() {
    const node: any = { style: {}, attributes: {}, children: [], textContent: '', disabled: false,
      appendChild(child: any) { this.children.push(child); },
      setAttribute(key: string, value: string) { this.attributes[key] = value; },
      getAttribute(key: string) { return this.attributes[key]; },
      addEventListener(_event: string, handler: () => void) { this.click = handler; } };
    Object.defineProperty(node, 'id', { set(value) { nodes.set(value, node); } });
    return node;
  }
  const calls: string[] = [];
  const pending = new Map<string, (value: unknown) => void>();
  const available = { phase: 'available', latest: { version: '1', notes: '' }, currentVersion: '0',
    canAutoInstall: true, downloadedBytes: 0, totalBytes: null, skippedVersion: '' };
  const window: any = { document: { createElement: element, body: element(), readyState: 'loading', addEventListener() {} },
    ytvdltBridge: { invoke(_channel: string, payload: { action: string }) {
      calls.push(payload.action);
      return new Promise((resolve) => pending.set(payload.action, resolve));
    } }, YTVDLT: { i18n: { t: (key: string) => key } } };
  runInNewContext(readFileSync('packages/ui/src/updates/update-dialog.js', 'utf8'), { window });
  window.YTVDLTUpdateDialog.__apply(available);
  const button = nodes.get('ytvdlt-update-primary');
  button.click();
  expect(button.textContent).toBe('update.cancelDownload');
  expect(button.disabled).toBe(false);
  button.click();
  expect(button.disabled).toBe(true);
  expect(calls).toEqual(['download', 'cancel-download']);
  pending.get('cancel-download')!({ state: available });
  await new Promise((resolve) => setImmediate(resolve));
  pending.get('download')!({ state: { ...available, phase: 'ready' } });
  await new Promise((resolve) => setImmediate(resolve));
  expect(button.textContent).toBe('update.download');
});
