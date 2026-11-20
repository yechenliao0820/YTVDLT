/**
 * D-257 · the second quit request can no longer bypass the hard-cleanup window
 * (external audit P2, `shutdown-quit-gate`).
 *
 * The audited scenario (verified against electron-entry.ts before the fix):
 * menu 「退出」 sets `quitting = true` and starts the D-247 cleanup (first
 * `before-quit` prevented). While the cleanup promise is in flight the user
 * presses Alt+F4 / clicks X — the close is deliberately NOT intercepted while
 * quitting (D-60/D-197 untouched) — the window is destroyed,
 * `window-all-closed` fires `app.quit()`, and the OLD latch
 * (`if (cleanupStarted) return;`) let that SECOND `before-quit` straight
 * through: the process died mid-cleanup, cutting D-247's 5 s cancel budget,
 * D-255's queued-task snapshot-write wait and the 3 s private purge (purgeCovers
 * included, D-252) short.
 *
 * The gate contract under test:
 *   - first quit: prevented once, the cleanup starts;
 *   - any quit INSIDE the cleanup window: prevented and suspended — ONE resume
 *     is queued on the settlement (repeated requests merge, idempotent);
 *   - the cleanup's own final quit AND the resumed request pass through,
 *     because `cleanupSettled` is flipped before `app.quit()` runs;
 *   - after settlement any further quit passes immediately and the cleanup
 *     never restarts (the old pass-through behaviour, outside the window).
 *
 * Fake discipline (坑 37/41 — fakes must reproduce the real dispatch order):
 * `app.quit()` emits `before-quit` SYNCHRONOUSLY with a fresh preventable
 * event, and a prevented event ABORTS that quit — exactly what real Electron
 * does. The gate module is electron-free, so no binary is needed (B1/D-39).
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  installShutdownQuitGate, type QuitGateApp,
} from '../../apps/desktop/src/main/shutdown-quit-gate.js';

class FakeQuitApp implements QuitGateApp {
  /** Every `app.quit()` call (real Electron emits a `before-quit` for each). */
  quitRequests = 0;
  /** Quit requests whose `before-quit` was NOT prevented = the process really exits. */
  quitProceeds = 0;

  private readonly listeners: Array<(...args: never[]) => void> = [];

  on(event: string, listener: (...args: never[]) => void): void {
    if (event === 'before-quit') this.listeners.push(listener);
  }

  /** Real Electron: `before-quit` is emitted synchronously inside `quit()`. */
  quit(): void {
    this.quitRequests += 1;
    let prevented = false;
    const event = { preventDefault: (): void => { prevented = true; } };
    for (const listener of [...this.listeners]) {
      (listener as (event: { preventDefault(): void }) => void)(event);
    }
    // A prevented `before-quit` aborts the quit sequence — the process stays
    // alive. Modelling this is what makes `quitProceeds` a meaningful count.
    if (!prevented) this.quitProceeds += 1;
  }
}

interface Harness {
  app: FakeQuitApp;
  /** How many times the cleanup body started (must stay 1 for the whole test). */
  runs: number;
  /** Settle the in-flight cleanup (resolve path). */
  resolve: () => void;
  /** Settle the in-flight cleanup (rejection path). */
  reject: (cause: unknown) => void;
}

/** A cleanup the test controls manually — mirrors an in-flight cancel/purge. */
function harness(): Harness {
  const app = new FakeQuitApp();
  const h: Harness = {
    app,
    runs: 0,
    resolve: () => undefined,
    reject: () => undefined,
  };
  installShutdownQuitGate(app, () => {
    h.runs += 1;
    return new Promise<void>((resolve, reject) => {
      h.resolve = resolve;
      h.reject = reject;
    });
  });
  return h;
}

/** Drain the promise chains (settle quit -> suspended resume -> ...). */
async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('D-257 · shutdown quit gate', () => {
  it('audit scenario: a second quit inside the cleanup window is prevented, not passed through', async () => {
    const h = harness();
    // Menu 「退出」: the first quit is prevented exactly once and the cleanup starts.
    h.app.quit();
    expect(h.app.quitRequests).toBe(1);
    expect(h.app.quitProceeds).toBe(0);
    expect(h.runs).toBe(1);

    // Alt+F4 -> window destroyed -> window-all-closed -> app.quit() DURING the
    // window. The old latch passed this straight through and killed the
    // process mid-cleanup; the gate must prevent it.
    h.app.quit();
    expect(h.app.quitRequests).toBe(2);
    expect(h.app.quitProceeds).toBe(0);

    // The cleanup settles: its own quit passes through, and the suspended
    // request resumes quit as well (both observe cleanupSettled === true).
    h.resolve();
    await flush();
    expect(h.app.quitProceeds).toBe(2);
    expect(h.runs).toBe(1);
  });

  it('repeated requests inside the window merge into ONE resumed quit (idempotent)', async () => {
    const h = harness();
    h.app.quit(); // first — starts the cleanup
    h.app.quit(); // menu again
    h.app.quit(); // tray quit
    h.app.quit(); // window-all-closed
    expect(h.app.quitProceeds).toBe(0);
    expect(h.runs).toBe(1); // repeated requests never restart the cleanup

    h.resolve();
    await flush();
    // 1 settle quit + 1 merged resume — NOT one quit per request, no loop,
    // no growth with the request count.
    expect(h.app.quitProceeds).toBe(2);
  });

  it('after settlement a further quit passes through immediately (outside the window)', async () => {
    const h = harness();
    h.app.quit();
    h.resolve();
    await flush();
    expect(h.app.quitProceeds).toBe(1); // the cleanup's own settle quit

    // A user quit AFTER the cleanup settled is an ordinary quit again: no
    // preventDefault, no suspension, and the cleanup must not restart.
    // (quitRequests is 3 = the user's first quit + the gate's settle quit +
    // this one; the settle quit is itself an app.quit() request.)
    h.app.quit();
    expect(h.app.quitRequests).toBe(3);
    expect(h.app.quitProceeds).toBe(2);
    expect(h.runs).toBe(1);
  });

  it('no-task fast path: an immediate cleanup settles and quits without suspension', async () => {
    // hostRef === null shape (D-247 fast path): the cleanup body returns
    // without any external event; the quit must still go through promptly.
    const app = new FakeQuitApp();
    let runs = 0;
    installShutdownQuitGate(app, async () => { runs += 1; });
    app.quit();
    expect(runs).toBe(1);
    expect(app.quitProceeds).toBe(0); // still inside the (instant) window
    await flush();
    expect(app.quitProceeds).toBe(1); // settle quit went through
  });

  it('a rejected cleanup still settles the gate and quits (never wedges the exit)', async () => {
    const h = harness();
    h.app.quit();
    // A throwing dispose / broken preview cache must not strand the quit: the
    // gate settles on the rejection path too (and the suspended resume never
    // inherits the rejection — no unhandled rejection either way).
    h.reject(new Error('dispose failed'));
    await flush();
    expect(h.app.quitProceeds).toBe(1);
    h.app.quit(); // post-settlement passes through
    expect(h.app.quitProceeds).toBe(2);
  });
});

describe('D-257 · electron-entry wiring pin', () => {
  it('electron-entry installs the gate; the old unconditional pass-through is gone', async () => {
    // Wiring pin (source gate, same style as app-update-service.test.ts D-253):
    // reverting electron-entry to the inline `if (cleanupStarted) return;`
    // latch would quietly reopen the audited bypass while this module keeps
    // passing — the production wiring itself must be pinned too.
    const source = await readFile(
      new URL('../../apps/desktop/src/main/electron-entry.ts', import.meta.url), 'utf8',
    );
    expect(source).toContain('installShutdownQuitGate(app');
    expect(source).not.toContain('if (cleanupStarted) return;');
    // D-247/D-255 cancel and the D-247/D-252 3 s purge race stay INSIDE the
    // gated cleanup body (budget semantics unchanged by D-257).
    expect(source).toContain('cancelRunningTasksForShutdown(queue)');
    expect(source).toContain('setTimeout(resolve, 3000)');
  });
});
