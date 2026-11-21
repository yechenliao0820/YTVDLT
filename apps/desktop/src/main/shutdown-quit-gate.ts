/**
 * shutdown-quit-gate — guards the hard-cleanup window against a SECOND quit
 * request (D-257, external audit P2).
 *
 * History: D-247 moved the real quit into an async cleanup (cancel in-flight
 * downloads within a 5 s budget -> drop preview tickets -> a 3 s race for the
 * private-history purge) and used `preventDefault` exactly once. The latch
 * (`cleanupStarted`) then let EVERY later `before-quit` pass unconditionally,
 * because that second quit was supposed to be the cleanup's own `app.quit()`.
 *
 * The audit found the hole: a USER-triggered quit inside that window takes the
 * same path. Menu 「退出」 -> `quitting = true` + cleanup starts -> Alt+F4 /
 * 点 X closes the window (the close is deliberately NOT intercepted while
 * `quitting`, D-60/D-197 untouched) -> the window is destroyed ->
 * `window-all-closed` -> `app.quit()` -> the second `before-quit` passed
 * straight through -> the process died mid-cleanup, cutting D-247's 5 s cancel
 * budget, D-255's queued-task snapshot-write wait and the 3 s private purge
 * (purgeCovers included, D-252) short.
 *
 * The gate's contract:
 * - the FIRST `before-quit`: prevented once, the cleanup promise starts;
 * - ANY further `before-quit` while that promise is in flight: prevented and
 *   SUSPENDED — ONE resume is queued on the settlement and calls `app.quit()`
 *   again once the cleanup has settled (repeated requests merge into that one
 *   resume, so the behaviour is idempotent);
 * - the cleanup's own final quit: `cleanupSettled` is flipped BEFORE
 *   `app.quit()` runs, so it — and the resumed request — pass straight
 *   through. No quit loop is possible: a quit that arrives after settlement is
 *   never prevented again;
 * - NO new timers: the gate adds no waiting of its own. It only defers the
 *   exit to the cleanup promise's settlement, which electron-entry already
 *   guarantees to be bounded (5 s cancel budget + 3 s purge race, D-247) — the
 *   budget semantics are unchanged, the second request just no longer amputates
 *   them.
 *
 * This file stays free of `electron` / `node:*` imports so the unit tests can
 * drive it with fakes that reproduce the real dispatch order (坑 37/41:
 * `app.quit()` emits `before-quit` synchronously; a prevented event aborts
 * that quit). Same seam rationale as bootstrap.ts (B1/D-39).
 */

/**
 * The slice of Electron's `App` the gate needs — the same shape
 * `ElectronLike['app']` (bootstrap.ts) already uses, so the real app from
 * electron-entry passes structurally and the unit-test fake is trivial.
 */
export interface QuitGateApp {
  on(event: string, listener: (...args: never[]) => void): void;
  quit(): void;
}

/**
 * Install the gate on the given app. `runCleanup` is the D-247/D-255 cleanup
 * (cancel in-flight downloads, drop preview tickets, bounded private purge);
 * the gate never inspects it — it only requires a promise that is guaranteed
 * to settle (electron-entry's try/finally + the 3 s race provide that).
 */
export function installShutdownQuitGate(app: QuitGateApp, runCleanup: () => Promise<void>): void {
  let cleanupStarted = false;
  /**
   * Flipped BEFORE the cleanup's own `app.quit()` fires — the pass-through
   * latch. Without it the cleanup's own quit would re-enter the gate and
   * deadlock the exit; with it, every quit after settlement is let through.
   */
  let cleanupSettled = false;
  /**
   * The in-flight cleanup, resolved the moment its final quit has been issued
   * (`settleAndQuit` ran). Suspended requests resume on THIS promise, so a
   * resumed quit is guaranteed to observe `cleanupSettled === true` — it can
   * never re-enter the gate's suspend branch.
   */
  let cleanupSettling: Promise<void> | null = null;
  /** D-257: repeated requests inside the window merge into ONE resumed quit. */
  let resumeQueued = false;

  const settleAndQuit = (): void => {
    cleanupSettled = true;
    app.quit();
  };

  app.on('before-quit', ((event: { preventDefault(): void }) => {
    // Settled (or never started): the quit passes through untouched. This is
    // the cleanup's own final quit, the resumed request, and any user quit
    // after the cleanup has finished — all ordinary quit paths again.
    if (cleanupSettled) return;
    if (cleanupStarted) {
      // D-257: a second quit request INSIDE the cleanup window must not pass
      // (the old unconditional `return` let it kill the process mid-cleanup).
      // Prevent it and queue ONE resume that fires app.quit() when the
      // in-flight cleanup settles — further requests change nothing.
      event.preventDefault();
      if (!resumeQueued) {
        resumeQueued = true;
        void cleanupSettling?.then(() => { app.quit(); });
      }
      return;
    }
    cleanupStarted = true;
    event.preventDefault();
    // settleAndQuit on BOTH paths: a rejected cleanup (a throwing dispose, a
    // broken preview cache) must still quit instead of wedging the exit, and
    // the derived promise then always FULFILS — the suspended resume above can
    // never inherit a rejection.
    cleanupSettling = runCleanup().then(settleAndQuit, settleAndQuit);
  }) as (...args: never[]) => void);
}
