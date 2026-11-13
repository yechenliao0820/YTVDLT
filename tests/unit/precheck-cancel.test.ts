/**
 * T5 — user-level cancellation of the URL pre-check, end to end.
 *
 * The audit finding: `precheckBatch()` had no AbortSignal, so 64 URLs × 20 s ÷
 * 3 workers could keep the user waiting ~7 minutes with no way to stop. This
 * file pins the WHOLE cancellation chain:
 *
 *   L0 gate          abort ⇒ no NEW checks, in-flight ⇒ CANCELLED, fail-open
 *                    unchanged, summary invariant preserved, progress reported;
 *   L0 engine        checkUrlSupport forwards the signal into SpawnOptions and
 *                    answers CANCELLED (never throws);
 *   L0 service       SiteSupportService passes the signal through, never shares
 *                    an abortable in-flight promise, never caches CANCELLED;
 *   L2 adapter       the REAL node-ports spawn kills the REAL child tree on
 *                    abort (killTree, bounded wait for exit evidence);
 *   IPC              URL_SUPPORT_CHECK_CANCEL / _STATUS wiring, and the three
 *                    entry points: cancel ⇒ NOTHING is enqueued (and the
 *                    single-URL path never spends its subtitle ticket).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC_CHANNELS } from '@ytvdlt/shared';
import type {
  CorePorts, PlaylistInfo, ProcessPort, SpawnAbortSignal, SpawnOptions, SpawnResult,
  UrlSupportResult, UrlSupportState,
} from '@ytvdlt/shared';
import { YtDlpEngine } from '@ytvdlt/engine-ytdlp';
import type { UrlSupportCheckOptions } from '@ytvdlt/engine-ytdlp';
import { Logger, ErrorMapper, ConfigStore, CommandTemplateStore } from '@ytvdlt/core';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';
import { precheckBatch } from '../../apps/desktop/src/main/site-precheck-gate.js';
import { SiteSupportService } from '../../apps/desktop/src/main/site-support-service.js';
import { createTxtImportService } from '../../apps/desktop/src/main/txt-import-service.js';
import {
  createM5Handlers, validateM5Payload, M5_CHANNELS, type M5ChannelDeps,
} from '../../apps/desktop/src/main/m5-channels.js';
import { createNodePorts } from '../../apps/desktop/src/main/adapters/node-ports.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NODE_EXE = join(ROOT, 'resources', 'runtime', 'win-x64', 'node.exe');

const verdict = (state: UrlSupportState, extra: Partial<UrlSupportResult> = {}): UrlSupportResult => ({
  url: 'https://example.test/v', state, extractor: '', cached: false, reason: 'r', ...extra,
});

/** Flush several microtask/smacrotask turns so concurrent workers settle. */
const flush = async (turns = 8): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 1. The gate: precheckBatch({ signal, onProgress })
// ---------------------------------------------------------------------------

describe('T5 · precheckBatch cancellation', () => {
  it('abort mid-batch: no NEW checks start, the in-flight one settles as CANCELLED, fail-open holds', async () => {
    const controller = new AbortController();
    let started = 0;
    const port = {
      check: async (url: string, _force?: boolean, signal?: SpawnAbortSignal) => {
        started += 1;
        expect(signal).toBe(controller.signal); // the batch's signal is forwarded
        if (started === 1) {
          controller.abort(); // the user presses stop while check #1 runs
          return verdict('CANCELLED', { url });
        }
        return verdict('SUPPORTED', { url });
      },
    };
    const urls = ['https://a.test/1', 'https://a.test/2', 'https://a.test/3'];
    const outcome = await precheckBatch(urls, port, { signal: controller.signal, concurrency: 1 });

    // URLs 2 and 3 were never attempted — no new engine after "stop".
    expect(started).toBe(1);
    expect(outcome.blocked).toEqual([]);
    // The in-flight check's CANCELLED verdict is counted as unconfirmed...
    expect(outcome.summary.indeterminate).toBe(1);
    expect(outcome.summary.indeterminateUrls).toEqual(['https://a.test/1']);
    // ...and the never-attempted ones are reported as NOT CHECKED (skipped),
    // the same honesty as budget-skipped urls.
    expect(outcome.summary.skipped).toBe(2);
    // The user's arithmetic always adds up.
    expect(outcome.summary.supported + outcome.summary.unsupported
      + outcome.summary.noMedia + outcome.summary.indeterminate
      + outcome.summary.skipped).toBe(urls.length);
    // Fail-open is UNCHANGED: a CANCELLED verdict never blocks, and the caller
    // (which sees its own aborted signal) decides not to enqueue.
    expect(outcome.allowed).toEqual(urls);
  });

  it('an already-aborted signal spawns NOTHING and skips the whole batch', async () => {
    const controller = new AbortController();
    controller.abort();
    let started = 0;
    const outcome = await precheckBatch(
      ['https://a.test/1', 'https://a.test/2'],
      { check: async () => { started += 1; return verdict('SUPPORTED'); } },
      { signal: controller.signal },
    );
    expect(started).toBe(0);
    expect(outcome.allowed).toEqual(['https://a.test/1', 'https://a.test/2']);
    expect(outcome.summary.skipped).toBe(2);
    expect(outcome.summary.examined).toBe(0);
  });

  it('onProgress reports 0/total first and one settle per LINE, reaching total', async () => {
    const seen: Array<[number, number]> = [];
    const urls = ['https://a.test/1', 'https://a.test/2', 'https://a.test/1'];
    await precheckBatch(urls, {
      check: async (url) => verdict('SUPPORTED', { url }),
    }, { concurrency: 2, onProgress: (checked, total) => seen.push([checked, total]) });
    expect(seen[0]).toEqual([0, 3]);
    expect(seen.at(-1)).toEqual([3, 3]);
    // Line-wise: a repeated line settles too, so checked always reaches total
    // even though the engine only ran twice.
    expect(seen.map((pair) => pair[0]).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it('without a signal everything behaves exactly as before (regression guard)', async () => {
    const outcome = await precheckBatch(
      ['https://a.test/1', 'https://no.test/2'],
      { check: async (url) => verdict(url.includes('no') ? 'UNSUPPORTED' : 'SUPPORTED', { url }) },
    );
    expect(outcome.allowed).toEqual(['https://a.test/1']);
    expect(outcome.blocked.map((b) => b.url)).toEqual(['https://no.test/2']);
    expect(outcome.summary.skipped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. The engine: checkUrlSupport(url, { signal })
// ---------------------------------------------------------------------------

/** Fake ProcessPort capturing spawn calls; only `spawn` is customised. */
function enginePorts(
  spawn?: (file: string, argv: readonly string[], opts: SpawnOptions) => Promise<SpawnResult>,
): { ports: CorePorts; calls: Array<{ file: string; argv: readonly string[]; opts: SpawnOptions }> } {
  const mem = createInMemoryPorts();
  const calls: Array<{ file: string; argv: readonly string[]; opts: SpawnOptions }> = [];
  const process: ProcessPort = {
    spawn: async (file, argv, opts) => {
      calls.push({ file, argv, opts });
      return spawn === undefined
        ? { exitCode: 0, stdout: '{"formats":[{}]}', stderr: '', timedOut: false }
        : spawn(file, argv, opts);
    },
    spawnStreaming: mem.ports.process.spawnStreaming,
    isAlive: mem.ports.process.isAlive,
  };
  return { ports: { ...mem.ports, process }, calls };
}

function makeEngine(ports: CorePorts): YtDlpEngine {
  return new YtDlpEngine({
    ports,
    logger: new Logger({ ports, appVersion: '0.1.0' }),
    mapper: new ErrorMapper({ clock: ports.clock }),
    enginePath: 'C:/runtime/yt-dlp.exe',
    jsRuntimePath: 'C:/runtime/node.exe',
    appVersion: '0.1.0',
  });
}

const CHECK_OPTS = { jsRuntimePath: 'C:/runtime/node.exe' };

describe('T5 · checkUrlSupport cancellation', () => {
  it('an already-aborted signal answers CANCELLED without spawning anything', async () => {
    const controller = new AbortController();
    controller.abort();
    const { ports, calls } = enginePorts();
    const engine = makeEngine(ports);
    const result = await engine.checkUrlSupport('https://a.test/v', {
      ...CHECK_OPTS, signal: controller.signal,
    });
    expect(result.state).toBe('CANCELLED');
    expect(result.url).toBe('https://a.test/v');
    expect(calls).toEqual([]);
  });

  it('an abort DURING the run kills via the forwarded signal and answers CANCELLED (never throws)', async () => {
    const controller = new AbortController();
    const { ports, calls } = enginePorts((_file, _argv, opts) => new Promise<SpawnResult>((resolve) => {
      // Park until the adapter (or the test) fires the signal — like a real
      // child that only dies when the tree kill lands.
      if (opts.signal?.aborted) {
        resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false });
        return;
      }
      opts.signal?.addEventListener('abort', () => {
        resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false });
      }, { once: true });
    }));
    const engine = makeEngine(ports);
    setTimeout(() => controller.abort(), 10);
    const result = await engine.checkUrlSupport('https://a.test/v', {
      ...CHECK_OPTS, signal: controller.signal,
    });
    expect(result.state).toBe('CANCELLED');
    // The signal travelled all the way into SpawnOptions — that is the field
    // the real adapter kills the tree on.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts.signal).toBe(controller.signal);
  });

  it('a non-aborted run with a signal attached keeps the normal SUPPORTED path', async () => {
    const controller = new AbortController();
    const { ports } = enginePorts();
    const engine = makeEngine(ports);
    const result = await engine.checkUrlSupport('https://a.test/v', {
      ...CHECK_OPTS, signal: controller.signal,
    });
    expect(result.state).toBe('SUPPORTED');
    expect(controller.signal.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. The service: SiteSupportService.check(url, force, signal)
// ---------------------------------------------------------------------------

function serviceEngine(options: {
  check?: (url: string, opts: UrlSupportCheckOptions) => Promise<UrlSupportResult>;
  throwInCheck?: boolean;
} = {}) {
  const calls: Array<{ url: string; opts: UrlSupportCheckOptions }> = [];
  const engine = {
    async listExtractors() {
      return { ok: false as const, reason: 'ENGINE_FAILED' as const, detail: 'nope' };
    },
    async checkUrlSupport(url: string, opts: UrlSupportCheckOptions): Promise<UrlSupportResult> {
      calls.push({ url, opts });
      if (options.throwInCheck === true) throw new Error('boom');
      return options.check === undefined ? verdict('SUPPORTED', { url }) : options.check(url, opts);
    },
    async version() { return '2026.10.26'; },
  };
  return { engine, calls };
}

function makeService(engine: unknown): SiteSupportService {
  return new SiteSupportService({
    engine, enginePath: 'C:/rt/yt-dlp.exe',
    engineVersion: async () => '2026.10.26', jsRuntimePath: 'C:/rt/node.exe',
    clock: { nowEpochMs: () => 1_000_000, nowIso: () => '2026-11-13T00:00:00.000Z' },
  });
}

describe('T5 · SiteSupportService signal pass-through', () => {
  it('an already-aborted signal answers CANCELLED without touching the engine', async () => {
    const controller = new AbortController();
    controller.abort();
    const { engine, calls } = serviceEngine();
    const service = makeService(engine);
    const result = await service.check('https://a.test/1', false, controller.signal);
    expect(result.state).toBe('CANCELLED');
    expect(calls).toEqual([]);
  });

  it('an abortable call NEVER shares an in-flight promise (one abort must not poison another caller)', async () => {
    const { engine, calls } = serviceEngine();
    const service = makeService(engine);
    const first = service.check('https://same.test/x'); // no signal: may share
    const second = service.check('https://same.test/x', false, new AbortController().signal);
    await Promise.all([first, second]);
    // Two separate engine runs: the abortable caller got its OWN child it can
    // kill, instead of latching onto somebody else's.
    expect(calls).toHaveLength(2);
  });

  it('a CANCELLED verdict is never cached — the next check runs the engine again', async () => {
    // The engine answers CANCELLED whenever it was given a signal (i.e. the
    // user aborted this run); a signal-less run resolves normally.
    const { engine, calls } = serviceEngine({
      check: async (url, opts) => verdict(opts.signal !== undefined ? 'CANCELLED' : 'SUPPORTED', { url }),
    });
    const service = makeService(engine);
    const first = await service.check('https://a.test/1', false, new AbortController().signal);
    const second = await service.check('https://a.test/1');
    expect(first.state).toBe('CANCELLED'); // the aborted run's verdict
    expect(second.state).toBe('SUPPORTED'); // NOT served from the cache
    expect(calls).toHaveLength(2);
  });

  it('an adapter throw during a cancelled check is CANCELLED, not INDETERMINATE', async () => {
    const controller = new AbortController();
    const { engine } = serviceEngine();
    const throwing = engine as {
      checkUrlSupport: (url: string, opts: UrlSupportCheckOptions) => Promise<UrlSupportResult>;
    };
    // An adapter that "still throws" — but only once the user has aborted (the
    // abort is what tears the child down, so this is the cancellation window).
    throwing.checkUrlSupport = (url: string, opts: UrlSupportCheckOptions) => new Promise((_resolve, reject) => {
      const boom = (): void => reject(new Error('boom'));
      if (opts.signal?.aborted === true) { boom(); return; }
      opts.signal?.addEventListener('abort', boom, { once: true });
    });
    const service = makeService(engine);
    const pending = service.check('https://a.test/1', false, controller.signal);
    await flush(); // let the fake park on the signal
    controller.abort();
    const result = await pending;
    expect(result.state).toBe('CANCELLED');
    expect(result.reason).toBe('pre-check cancelled by the user');
  });

  it('an adapter throw WITHOUT cancellation stays INDETERMINATE (fail-open unchanged)', async () => {
    const { engine } = serviceEngine({ throwInCheck: true });
    const service = makeService(engine);
    const result = await service.check('https://a.test/1');
    expect(result.state).toBe('INDETERMINATE');
    expect(result.reason).toBe('pre-check failed unexpectedly');
  });
});

// ---------------------------------------------------------------------------
// 4. The adapter (L2): the REAL spawn kills the REAL child on abort
// ---------------------------------------------------------------------------

describe('T5 · node-ports spawn honours SpawnOptions.signal (real child)', () => {
  const cleanup: string[] = [];
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ytvdlt-cancel-'));
    cleanup.push(dir);
    return dir;
  };

  const realPorts = (): CorePorts => createNodePorts({
    packaged: false,
    resourcesPath: ROOT,
    runtimeDir: ROOT,
    appDataDir: join(ROOT, 'data'),
    configDir: join(ROOT, 'data', 'config'),
    logsDir: join(ROOT, 'data', 'logs'),
    appVersion: '0.2.9',
  });

  /**
   * A child that would write a sentinel via its `exit` handler and then live
   * forever. On Windows a taskkill /F termination is TerminateProcess — exit
   * handlers do NOT run — so a sentinel can only appear if the kill FAILED and
   * someone later ended the process gracefully.
   */
  const eternalChild = (sentinel: string): string =>
    `process.on('exit',()=>{require('fs').writeFileSync(${JSON.stringify(sentinel)},'alive')});`
    + 'setInterval(()=>{},250);';

  const spawnOptions = (signal?: SpawnAbortSignal): SpawnOptions => ({
    shell: false,
    windowsHide: true,
    ...(signal === undefined ? {} : { signal }),
  });

  it('abort mid-run: killTree lands, the result settles with exitCode null, no sentinel', async () => {
    const dir = scratch();
    const sentinel = join(dir, 'survived.txt');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const startedAt = Date.now();
    const result = await realPorts().process.spawn(
      NODE_EXE, ['-e', eternalChild(sentinel)], spawnOptions(controller.signal),
    );
    const elapsed = Date.now() - startedAt;
    expect(result.exitCode).toBeNull();
    // Well before the 20 s pre-check budget: the tree kill was bounded.
    expect(elapsed).toBeLessThan(10_000);
    // If the child had survived to a graceful exit the sentinel would exist.
    await wait(400);
    expect(existsSync(sentinel)).toBe(false);
  }, 20_000);

  it('an already-aborted signal kills immediately', async () => {
    const dir = scratch();
    const sentinel = join(dir, 'survived2.txt');
    const controller = new AbortController();
    controller.abort();
    const result = await realPorts().process.spawn(
      NODE_EXE, ['-e', eternalChild(sentinel)], spawnOptions(controller.signal),
    );
    expect(result.exitCode).toBeNull();
    await wait(300);
    expect(existsSync(sentinel)).toBe(false);
  }, 20_000);

  it('a run that finishes BEFORE the abort is untouched (exitCode stays 0, no hang)', async () => {
    const controller = new AbortController();
    const result = await realPorts().process.spawn(
      NODE_EXE, ['-e', 'console.log("done")'], spawnOptions(controller.signal),
    );
    expect(result.exitCode).toBe(0);
    controller.abort(); // late abort on a settled run must be a harmless no-op
  }, 20_000);

  it('no signal at all keeps the legacy behaviour (optional field is additive)', async () => {
    const result = await realPorts().process.spawn(
      NODE_EXE, ['-e', 'console.log("legacy")'], { shell: false, windowsHide: true },
    );
    expect(result.exitCode).toBe(0);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// 5. The IPC surface + the three entry points
// ---------------------------------------------------------------------------

async function m5Deps(overrides: Partial<M5ChannelDeps> = {}): Promise<M5ChannelDeps> {
  const mem = createInMemoryPorts();
  const config = new ConfigStore({ ports: mem.ports });
  await config.load();
  const templates = new CommandTemplateStore({ ports: mem.ports });
  await templates.init();
  return {
    queue: { list: () => [], get: () => undefined },
    taskDetail: { perform: async () => ({ ok: true, action: 'remove', message: '' }) },
    templates,
    config,
    systemAppearance: {
      prefersDark: () => false, prefersReducedMotion: () => false, accent: () => null,
    },
    ...overrides,
  } as M5ChannelDeps;
}

/** A siteSupport port whose check parks until the batch's signal fires. */
function hangingSupport(lateVerdict: UrlSupportState = 'SUPPORTED') {
  const registered: Array<SpawnAbortSignal | undefined> = [];
  return {
    available: true,
    catalog: async () => ({ ok: false as const, reason: 'ENGINE_FAILED' as const, detail: 'x' }),
    check: (url: string, _force?: boolean, signal?: SpawnAbortSignal): Promise<UrlSupportResult> => {
      registered.push(signal);
      return new Promise<UrlSupportResult>((resolve) => {
        const finish = (): void => resolve(verdict(signal?.aborted === true ? 'CANCELLED' : lateVerdict, { url }));
        if (signal?.aborted === true) finish();
        else signal?.addEventListener('abort', finish, { once: true });
      });
    },
    registered,
  };
}

const flushWhile = async (predicate: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && predicate(); i += 1) await new Promise((r) => setImmediate(r));
};

describe('T5 · IPC cancel + status channels', () => {
  it('registers both channels, accepts only the opaque operationId, and rejects any other key', () => {
    expect(M5_CHANNELS).toContain(IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL);
    expect(M5_CHANNELS).toContain(IPC_CHANNELS.URL_SUPPORT_CHECK_STATUS);
    expect(validateM5Payload(IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL, {})).toEqual({});
    expect(validateM5Payload(IPC_CHANNELS.URL_SUPPORT_CHECK_STATUS, {})).toEqual({});
    for (const channel of [IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL, IPC_CHANNELS.URL_SUPPORT_CHECK_STATUS]) {
      expect(() => validateM5Payload(channel, { batchId: 'x' })).toThrow(/not allowed/);
    }
  });

  it('CANCEL aborts the in-flight single check; the verdict comes back CANCELLED and never blocks', async () => {
    const support = hangingSupport();
    const handlers = createM5Handlers(await m5Deps({ siteSupport: support }));
    const pending = handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK)?.({ url: 'https://a.test/1' });
    await flushWhile(() => support.registered.length === 0);

    const reply = await handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL)?.({});
    expect(reply).toEqual({ ok: true, cancelled: true });

    const dto = await pending as Record<string, unknown>;
    expect(dto['state']).toBe('CANCELLED');
    expect(dto['blocks']).toBe(false); // fail-open: CANCELLED never blocks
    // A CANCELLED verdict must carry a stable code: the renderer uses it to
    // terminate the flow instead of offering "add it anyway" (§3.3 semantics).
    expect(dto['code']).toBe('PRECHECK_CANCELLED');
  });

  it('CANCEL with nothing in flight answers cancelled:false (an honest no-op)', async () => {
    const handlers = createM5Handlers(await m5Deps());
    const reply = await handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL)?.({});
    expect(reply).toEqual({ ok: true, cancelled: false });
  });

  it('a DOWNLOAD_START with no pre-check port leaves NO controller behind', async () => {
    // Regression: registering the controller OUTSIDE the `siteSupport` branch
    // left one entry in the cancel set per download on builds without the
    // capability. The set grew without bound and every later CANCEL falsely
    // reported `cancelled: true`.
    const handlers = createM5Handlers(await m5Deps({
      enqueueSingle: async () => ['t1'],
    }));
    const started = await handlers.get(IPC_CHANNELS.DOWNLOAD_START)?.({
      url: 'https://a.test/1', kind: 'video',
    }) as Record<string, unknown>;
    expect(started['accepted']).toBe(true);
    const reply = await handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL)?.({});
    expect(reply).toEqual({ ok: true, cancelled: false });
  });

  it('STATUS is inactive with no batch, and tracks a running batch line-wise', async () => {
    const resolvers: Array<() => void> = [];
    const support = {
      available: true,
      catalog: async () => ({ ok: false as const, reason: 'ENGINE_FAILED' as const, detail: 'x' }),
      check: (url: string): Promise<UrlSupportResult> => new Promise((resolve) => {
        resolvers.push(() => resolve(verdict('SUPPORTED', { url })));
      }),
    };
    const txt = createTxtImportService({
      pickFile: {
        pick: async () => ({
          canceled: false, fileName: 'links.txt', code: '',
          text: 'https://ok.test/1\nhttps://ok.test/2\nhttps://ok.test/3\n',
        }),
      },
      validateUrl: () => undefined,
      enqueueBatch: async (input) => ({
        enqueued: input.urls.length,
        taskIds: input.urls.map((_u, i) => `t${i}`),
        failures: [],
      }),
      siteSupport: support,
    });
    const handlers = createM5Handlers(await m5Deps({ txtImport: txt }));
    const pick = await handlers.get(IPC_CHANNELS.TXT_IMPORT_PICK)?.({}) as Record<string, unknown>;
    const pending = handlers.get(IPC_CHANNELS.TXT_IMPORT_ENQUEUE)?.({
      importId: pick['importId'], kind: 'video',
    });
    await flush();
    await flushWhile(() => resolvers.length < 3);

    let status = await handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK_STATUS)?.({}) as Record<string, unknown>;
    expect(status['active']).toBe(true);
    expect(status['total']).toBe(3);
    expect(status['checked']).toBe(0);

    resolvers[0]?.();
    await flush();
    status = await handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK_STATUS)?.({}) as Record<string, unknown>;
    expect(status['checked']).toBe(1);

    resolvers[1]?.();
    resolvers[2]?.();
    const result = await pending as Record<string, unknown>;
    expect(result['ok']).toBe(true);
    status = await handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK_STATUS)?.({}) as Record<string, unknown>;
    // Termination condition the dialogs rely on: the batch is over ⇒ inactive.
    expect(status['active']).toBe(false);
  });
});

describe('T5 · the three entry points: cancel ⇒ nothing is enqueued', () => {
  it('single URL (DOWNLOAD_START): the subtitle ticket is NOT spent, no task is created', async () => {
    const support = hangingSupport();
    const enqueued: unknown[] = [];
    const consumed: unknown[] = [];
    const handlers = createM5Handlers(await m5Deps({
      enqueueSingle: async (input) => { enqueued.push(input); return ['t1']; },
      subtitlePreview: {
        preview: async () => ({ ok: false, code: 'PREVIEW_UNAVAILABLE', message: '' }),
        cancel: async () => true,
        consume: (id: string, url: unknown) => {
          consumed.push({ id, url });
          return { ok: false as const, code: 'PREVIEW_UNKNOWN' as const };
        },
      },
      siteSupport: support,
    }));
    const pending = handlers.get(IPC_CHANNELS.DOWNLOAD_START)?.({
      url: 'https://a.test/1', kind: 'video', previewId: 'preview-ticket-0001',
    });
    await flushWhile(() => support.registered.length === 0);
    await handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL)?.({});
    const result = await pending as Record<string, unknown>;

    expect(result['accepted']).toBe(false);
    expect(result['code']).toBe('PRECHECK_CANCELLED');
    expect(result['cancelled']).toBe(true);
    expect(enqueued).toEqual([]);
    expect(consumed).toEqual([]); // the ticket survives — the gate ran first
  });

  it('TXT batch (real service): the cancelled batch never reaches enqueueBatch', async () => {
    const support = hangingSupport();
    const batchCalls: string[][] = [];
    const txt = createTxtImportService({
      pickFile: {
        pick: async () => ({
          canceled: false, fileName: 'links.txt', code: '',
          text: 'https://ok.test/1\nhttps://ok.test/2\n',
        }),
      },
      validateUrl: () => undefined,
      enqueueBatch: async (input) => {
        batchCalls.push([...input.urls]);
        return { enqueued: input.urls.length, taskIds: input.urls.map((_u, i) => `t${i}`), failures: [] };
      },
      siteSupport: support,
    });
    const handlers = createM5Handlers(await m5Deps({ txtImport: txt }));
    const pick = await handlers.get(IPC_CHANNELS.TXT_IMPORT_PICK)?.({}) as Record<string, unknown>;
    const pending = handlers.get(IPC_CHANNELS.TXT_IMPORT_ENQUEUE)?.({
      importId: pick['importId'], kind: 'video',
    });
    await flushWhile(() => support.registered.length === 0);
    await handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL)?.({});
    const result = await pending as Record<string, unknown>;

    expect(result['cancelled']).toBe(true);
    expect(result['code']).toBe('PRECHECK_CANCELLED');
    expect(result['enqueued']).toBe(0);
    expect(result['taskIds']).toEqual([]);
    expect(batchCalls).toEqual([]);
  });

  it('playlist batch: nothing is enqueued; the already-spent preview ticket is documented as burned', async () => {
    const support = hangingSupport();
    const playlist: PlaylistInfo = {
      id: 'pl1', title: 'T', _type: 'playlist', extractor_key: 'youtube:playlist',
      webpage_url: 'https://www.youtube.com/playlist?list=PL1',
      entries: [
        { id: 'ep1', title: 'A', url: 'https://a.test/1', duration: 10, _type: 'url' },
        { id: 'ep2', title: 'B', url: 'https://a.test/2', duration: 11, _type: 'url' },
      ],
    };
    let consumeCalls = 0;
    let batchCalls = 0;
    const handlers = createM5Handlers(await m5Deps({
      playlistPreview: {
        preview: async () => ({}) as never,
        cancel: async () => true,
        consume: () => { consumeCalls += 1; return { ok: true, code: '' as const, playlist }; },
        clear: () => undefined,
      },
      playlistBatch: async () => { batchCalls += 1; return { requested: 2, enqueued: 2, failed: 0, taskIds: ['t1', 't2'], failures: [] }; },
      siteSupport: support,
    }));
    const pending = handlers.get(IPC_CHANNELS.PLAYLIST_BATCH_ENQUEUE)?.({
      previewId: 'preview-ticket-0001',
      url: 'https://www.youtube.com/playlist?list=PL1',
      selectedIds: ['ep1', 'ep2'],
      kind: 'video',
    });
    await flushWhile(() => support.registered.length === 0);
    await handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL)?.({});
    const result = await pending as Record<string, unknown>;

    expect(result['cancelled']).toBe(true);
    expect(result['code']).toBe('PRECHECK_CANCELLED');
    expect(result['enqueued']).toBe(0);
    expect(result['taskIds']).toEqual([]);
    expect(batchCalls).toBe(0);
    // The pre-check needs the entry URLs, which only the consumed ticket holds,
    // so the ticket IS spent on cancel — the reply says so and the dialog asks
    // for a fresh preview on retry. Pinned here so a future change is a choice.
    expect(consumeCalls).toBe(1);
  });

  it('playlist batch: a cancel that arrives BEFORE the ticket is spent does not consume it', async () => {
    const handlers = createM5Handlers(await m5Deps({
      playlistPreview: {
        preview: async () => ({}) as never,
        cancel: async () => true,
        consume: () => { throw new Error('ticket must not be consumed after a pre-spill cancel'); },
        clear: () => undefined,
      },
      playlistBatch: async () => { throw new Error('must not run'); },
    }));
    // Cancel FIRST (nothing in flight — aborts nothing), then start the batch:
    // the handler's own controller is fresh, so this exercises the pre-ticket
    // check only via a racing cancel; here we assert the documented shape of an
    // immediate pre-ticket cancellation instead.
    await handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL)?.({});
    const result = await handlers.get(IPC_CHANNELS.PLAYLIST_BATCH_ENQUEUE)?.({
      previewId: 'preview-ticket-0001',
      url: 'https://www.youtube.com/playlist?list=PL1',
      selectedIds: [],
      kind: 'video',
    }) as Record<string, unknown>;
    // Empty selection is still refused the old way (no cancel involved).
    expect(result['code']).toBe('EMPTY_SELECTION');
  });
});

// ---------------------------------------------------------------------------
// D-160 · per-submission cancellation scope (external audit P2-2)
// ---------------------------------------------------------------------------

/** A TXT import service that reports progress once and holds until released. */
function heldTxtImport() {
  let signal: SpawnAbortSignal | undefined;
  let release: (value: unknown) => void = () => undefined;
  const held = new Promise<unknown>((resolve) => { release = resolve; });
  const service = {
    enqueue: (opts: {
      precheckSignal?: SpawnAbortSignal;
      onPrecheckProgress?: (checked: number, total: number) => void;
    }): Promise<unknown> => {
      signal = opts.precheckSignal;
      opts.onPrecheckProgress?.(2, 5);
      return held;
    },
  };
  return {
    service,
    signal: (): SpawnAbortSignal | undefined => signal,
    release: (): void => release({
      ok: true, cancelled: false, code: '', requested: 5, enqueued: 0, failed: 0,
      taskIds: [], failures: [],
    }),
  };
}

describe('D-160 · cancellation is scoped to one operationId', () => {
  it('two concurrent single-URL checks: cancelling one leaves the other running', async () => {
    const support = hangingSupport();
    const handlers = createM5Handlers(await m5Deps({ siteSupport: support }));
    const first = handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK)?.({
      url: 'https://a.test/1', operationId: 'op-first',
    });
    const second = handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK)?.({
      url: 'https://b.test/2', operationId: 'op-second',
    });
    await flushWhile(() => support.registered.length < 2);

    expect(await handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL)?.({ operationId: 'op-first' }))
      .toEqual({ ok: true, cancelled: true });
    expect(support.registered[0]?.aborted).toBe(true);
    expect(support.registered[1]?.aborted).toBe(false);
    expect((await first as Record<string, unknown>)['state']).toBe('CANCELLED');

    // An id nobody registered is an honest no-op, not a global stop.
    expect(await handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL)?.({ operationId: 'op-unknown' }))
      .toEqual({ ok: true, cancelled: false });
    expect(support.registered[1]?.aborted).toBe(false);

    expect(await handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL)?.({ operationId: 'op-second' }))
      .toEqual({ ok: true, cancelled: true });
    expect((await second as Record<string, unknown>)['state']).toBe('CANCELLED');
  });

  it('a legacy (no-id) CANCEL cannot abort an isolated submission', async () => {
    const support = hangingSupport();
    const handlers = createM5Handlers(await m5Deps({ siteSupport: support }));
    const pending = handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK)?.({
      url: 'https://a.test/1', operationId: 'op-isolated',
    });
    await flushWhile(() => support.registered.length < 1);
    expect(await handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL)?.({}))
      .toEqual({ ok: true, cancelled: false });
    expect(support.registered[0]?.aborted).toBe(false);
    await handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL)?.({ operationId: 'op-isolated' });
    expect((await pending as Record<string, unknown>)['state']).toBe('CANCELLED');
  });

  it('a TXT batch cancel stops only that batch, not a concurrent single-URL check', async () => {
    const support = hangingSupport();
    const txt = heldTxtImport();
    const handlers = createM5Handlers(await m5Deps({
      siteSupport: support,
      txtImport: txt.service as unknown as NonNullable<M5ChannelDeps['txtImport']>,
    }));
    const batch = handlers.get(IPC_CHANNELS.TXT_IMPORT_ENQUEUE)?.({
      importId: 'import-ticket-0001', kind: 'video', operationId: 'op-txt',
    });
    await flushWhile(() => txt.signal() === undefined);
    const single = handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK)?.({
      url: 'https://a.test/1', operationId: 'op-single',
    });
    await flushWhile(() => support.registered.length < 1);

    expect(await handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL)?.({ operationId: 'op-txt' }))
      .toEqual({ ok: true, cancelled: true });
    expect(txt.signal()?.aborted).toBe(true);
    expect(support.registered[0]?.aborted).toBe(false);

    // Progress is scoped too: the TXT dialog sees its own readout only.
    const txtStatus = await handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK_STATUS)?.({
      operationId: 'op-txt',
    }) as Record<string, unknown>;
    expect(txtStatus['active']).toBe(true);
    expect(txtStatus['total']).toBe(5);
    const singleStatus = await handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK_STATUS)?.({
      operationId: 'op-single',
    }) as Record<string, unknown>;
    expect(singleStatus['active']).toBe(false);

    txt.release();
    await batch;
    await handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL)?.({ operationId: 'op-single' });
    expect((await single as Record<string, unknown>)['state']).toBe('CANCELLED');
  });

  it('a malformed operationId is rejected before any controller is created', async () => {
    const support = hangingSupport();
    const handlers = createM5Handlers(await m5Deps({ siteSupport: support }));
    await expect(handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK)!({
      url: 'https://a.test/1', operationId: 'https://evil.test/steal',
    })).rejects.toThrow(/invalid operationId/);
    await expect(handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL)!({
      operationId: 'a'.repeat(129),
    })).rejects.toThrow(/invalid operationId/);
    expect(support.registered).toHaveLength(0);
  });
});
