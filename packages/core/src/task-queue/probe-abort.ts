/**
 * D-162: a probe needs an abort surface, but `@ytvdlt/core` compiles without
 * the DOM lib (or `@types/node` globals), exactly like `packages/shared` — see
 * `SpawnAbortSignal`'s comment. This factory keeps the platform detail here:
 * the real runtime (`AbortController` in Electron main / Node 22) is used when
 * present, and a plain flag-shaped signal is used otherwise (unit tests).
 *
 * The adapters only ever read `signal.aborted` and listen for `'abort'`, which
 * both shapes satisfy.
 */
import type { SpawnAbortSignal } from '@ytvdlt/shared';

export interface ProbeAbort {
  readonly signal: SpawnAbortSignal;
  abort(): void;
}

interface AbortCtor {
  new (): { readonly signal: SpawnAbortSignal; abort(): void };
}

export function createProbeAbort(): ProbeAbort {
  const ctor = (globalThis as unknown as { AbortController?: AbortCtor }).AbortController;
  if (ctor !== undefined) {
    const controller = new ctor();
    return { signal: controller.signal, abort: (): void => { controller.abort(); } };
  }
  let aborted = false;
  const signal: SpawnAbortSignal = {
    get aborted(): boolean { return aborted; },
    addEventListener(): void { /* the fallback is polled, never notified */ },
    removeEventListener(): void { /* nothing to remove */ },
  };
  return { signal, abort: (): void => { aborted = true; } };
}
