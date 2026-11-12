import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync('packages/ui/src/pages/settings/settings.js', 'utf8');

function harness(phase: string, ok = true) {
  const nodes = new Map<string, any>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, {
      textContent: '', disabled: false, attributes: { 'data-update-state': phase },
      setAttribute(key: string, value: string) { this.attributes[key] = value; },
      getAttribute(key: string) { return this.attributes[key]; },
      removeAttribute() {},
      addEventListener(_event: string, callback: () => void) { this.click = callback; },
    });
    return nodes.get(id);
  };
  const calls: string[] = [];
  let complete: (value: unknown) => void = () => {};
  const state = { phase, currentVersion: '0.2.5', latest: { pageUrl: 'https://github.com/example' } };
  const context: any = {
    doc: { getElementById: node },
    t: (key: string) => key,
    setHidden() {}, offlineText: () => 'offline',
    invokeBridge(_channel: string, payload: { action?: string }) {
      if (!payload.action) return Promise.resolve(state);
      calls.push(payload.action);
      return new Promise((resolve) => { complete = resolve; });
    },
  };
  const section = source.slice(source.indexOf('  var APP_CHANNELS'), source.indexOf('  /* --- 0.2.1 (D-98)'));
  const wire = source.slice(source.indexOf("    var appCheck ="), source.indexOf("    var appPage ="));
  runInNewContext(section + '\n' + wire + '\nthis.paint = paintApp;', context);
  context.paint(state);
  return { calls, button: node('settings-app-update'), status: node('settings-app-state'),
    paint: () => context.paint(state),
    finish: async () => {
      complete({ ok, state, message: ok ? 'launched' : 'launch failed' });
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('settings application update action', () => {
  it.each([['idle', 'check', 'settings.app.check'], ['available', 'download', 'update.download'], ['ready', 'install', 'update.install']])(
    '%s dispatches %s with matching label', async (phase, action, label) => {
      const app = harness(phase);
      expect(app.button.textContent).toBe(label);
      app.button.click();
      app.button.click();
      app.paint();
      expect(app.calls).toEqual([action]);
      expect(app.button.disabled).toBe(true);
      await app.finish();
      expect(app.button.disabled).toBe(action === 'install');
    },
  );
  it('shows install failure and permits retry without downloading again', async () => {
    const app = harness('ready', false);
    app.button.click();
    await app.finish();
    expect(app.status.textContent).toBe('launch failed');
    expect(app.button.disabled).toBe(false);
    app.paint();
    expect(app.status.textContent).toBe('launch failed');
    app.button.click();
    expect(app.calls).toEqual(['install', 'install']);
  });
});

/**
 * D-141: the settings card froze for the whole download.
 *
 * `download` answers only when the transfer is over, so `data-update-state`
 * stays `available` while bytes are moving. The refresh timer gated on that
 * attribute alone, therefore it never read the status and the card never showed
 * a byte of progress — a jump straight from "available" to "install now".
 */
describe('settings application update refresh gate', () => {
  function gate(phase: string, appBusy: boolean): number {
    const block = {
      attributes: { 'data-update-state': phase },
      getAttribute(key: string) { return this.attributes[key] ?? null; },
    };
    let ticks: (() => void)[] = [];
    let reads = 0;
    const context: any = {
      appBusy,
      doc: {
        visibilityState: 'visible',
        getElementById: (id: string) => (id === 'settings-app-block' ? block : null),
      },
      readAppState: () => { reads += 1; },
      setInterval: (fn: () => void) => { ticks.push(fn); return 0; },
    };
    const anchor = source.indexOf('// The queue dialog polls the same state');
    const start = source.indexOf('setInterval(function () {', anchor);
    const end = source.indexOf('}, 1500);', start) + '}, 1500);'.length;
    expect(anchor).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(anchor);
    expect(end).toBeGreaterThan(start);
    runInNewContext(source.slice(start, end), context);
    ticks.forEach((tick) => tick());
    return reads;
  }

  it('keeps polling while the download action is still pending', () => {
    // Phase is `available` — the main process has not answered `download` yet.
    expect(gate('available', true)).toBe(1);
  });

  it('keeps polling while the main process reports downloading / checking', () => {
    expect(gate('downloading', false)).toBe(1);
    expect(gate('checking', false)).toBe(1);
  });

  it('stays quiet when nothing is in flight', () => {
    expect(gate('available', false)).toBe(0);
    expect(gate('idle', false)).toBe(0);
    expect(gate('ready', false)).toBe(0);
  });
});
