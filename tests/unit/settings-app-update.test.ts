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
