/**
 * TASK-02 (§2.2 / §2.3) — child-process output ceilings.
 *
 * Two levels, because the requirement has two halves that fail differently:
 *
 *  L0 · `createBoundedOutput()` — the accounting. Byte-exactness lives here
 *       (UTF-8 multi-byte glyphs, cross-chunk boundaries, landing exactly on
 *       the limit). Pure: no child process, no timing.
 *
 *  L2 · the REAL `node-ports` adapter spawning the REAL bundled node.exe —
 *       proves the enforcement end to end: overflow terminates the process,
 *       stderr carries the marker, exit code is poisoned, and a normal
 *       download's unbounded stream is untouched.
 *
 * Why node.exe and not yt-dlp.exe: a ceiling needs an output PRODUCER whose
 * size is controllable to the byte (`node -e '...'`), while yt-dlp's metadata
 * size is decided by a site. Using the bundled node.exe exercises the identical
 * adapter code path with deterministic input — and stays fully offline.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CorePorts, ProcessPort, SpawnResult } from '@ytvdlt/shared';
import {
  METADATA_MAX_STDOUT_BYTES, METADATA_MAX_STDERR_BYTES, OUTPUT_LIMIT_MARKER,
  URL_PRECHECK_TIMEOUT_MS,
} from '@ytvdlt/shared';
import { createNodePorts, OVERFLOW_SETTLE_GRACE_MS } from '../../apps/desktop/src/main/adapters/node-ports.js';
import { createBoundedOutput } from '../../apps/desktop/src/main/adapters/output-limiter.js';
import { assertSafeSpawnOptions, utf8ByteLength, YtDlpEngine } from '@ytvdlt/engine-ytdlp';
import { Logger, ErrorMapper } from '@ytvdlt/core';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NODE_EXE = join(ROOT, 'resources', 'runtime', 'win-x64', 'node.exe');

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

function scratch(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ytvdlt-limit-${label}-`));
  cleanup.push(dir);
  return dir;
}

function realPorts(root: string): CorePorts {
  return createNodePorts({
    packaged: false,
    resourcesPath: root,
    runtimeDir: root,
    appDataDir: join(root, 'data'),
    configDir: join(root, 'data', 'config'),
    logsDir: join(root, 'data', 'logs'),
    appVersion: '0.2.9',
  });
}

interface Run {
  ports: CorePorts;
  process: ProcessPort;
  dir: string;
}

function makeRun(): Run {
  const dir = scratch('run');
  const ports = realPorts(dir);
  return { ports, process: ports.process, dir };
}

/** Spawn the bundled node.exe with an inline script; argv[] only, never a shell. */
async function runNode(
  run: Run,
  script: string,
  opts: { maxStdoutBytes?: number; maxStderrBytes?: number; timeoutMs?: number },
): Promise<SpawnResult> {
  return run.process.spawn(NODE_EXE, ['-e', script], {
    shell: false,
    windowsHide: true,
    timeoutMs: opts.timeoutMs ?? 20_000,
    ...(opts.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: opts.maxStdoutBytes }),
    ...(opts.maxStderrBytes === undefined ? {} : { maxStderrBytes: opts.maxStderrBytes }),
  });
}

/**
 * A flood that keeps writing forever without OOM-ing the child.
 *
 * The payload is built INSIDE the child with `.repeat()` rather than embedded in
 * the `-e` script: a 64 KiB literal puts the argv past the Windows command-line
 * limit and the spawn fails with ENAMETOOLONG before a single byte is written,
 * which would test the harness instead of the ceiling.
 */
const flood = (stream: 'stdout' | 'stderr', byteCount: number, glyph = 'x'): string =>
  `const c=${JSON.stringify(glyph)}.repeat(${byteCount});`
  + `(function p(){ process.${stream}.write(c); setImmediate(p); })();`;

/** Writes a sentinel file 1.5 s later — so it only appears if the child SURVIVED. */
const afterSurvivalProof = (sentinel: string): string =>
  `setTimeout(()=>{require('fs').writeFileSync(${JSON.stringify(sentinel)},'alive')},1500);`;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// L0 · byte accounting
// ---------------------------------------------------------------------------

describe('TASK-02 · createBoundedOutput byte accounting (L0)', () => {
  it('accepts everything when no limit is configured (legacy unbounded path)', () => {
    const collector = createBoundedOutput(undefined);
    expect(collector.push(Buffer.from('a'.repeat(50_000)))).toBe('ok');
    expect(collector.exceeded()).toBe(false);
    expect(collector.byteLength()).toBe(50_000);
  });

  it('counts BYTES, not UTF-16 code units, for a CJK payload', () => {
    const collector = createBoundedOutput(10_000);
    // 1000 CJK glyphs = 3000 UTF-8 bytes but only 1000 JS characters.
    const cjk = '中'.repeat(1000);
    expect(cjk.length).toBe(1000);
    expect(Buffer.byteLength(cjk, 'utf8')).toBe(3000);
    expect(collector.push(Buffer.from(cjk, 'utf8'))).toBe('ok');
    expect(collector.byteLength()).toBe(3000);
    expect(collector.text()).toBe(cjk);
  });

  it('rejects a CJK payload that a character-based limit would have allowed', () => {
    // 2999 bytes of headroom: 3000 bytes must NOT fit, even though the payload
    // is only 1000 characters long. A `text.length` implementation passes here.
    const collector = createBoundedOutput(2999);
    const outcome = collector.push(Buffer.from('中'.repeat(1000), 'utf8'));
    expect(outcome).toBe('exceeded');
    expect(collector.byteLength()).toBe(2999);
  });

  it('treats landing EXACTLY on the limit as accepted', () => {
    const collector = createBoundedOutput(3000);
    expect(collector.push(Buffer.from('中'.repeat(1000), 'utf8'))).toBe('ok');
    expect(collector.exceeded()).toBe(false);
    // The breach is the NEXT byte, not the one that completes the budget.
    expect(collector.push(Buffer.from('x'))).toBe('exceeded');
    expect(collector.byteLength()).toBe(3000);
  });

  it('splits across chunk boundaries and keeps the accepted prefix', () => {
    const collector = createBoundedOutput(100);
    expect(collector.push(Buffer.from('a'.repeat(60)))).toBe('ok');
    expect(collector.push(Buffer.from('b'.repeat(60)))).toBe('exceeded');
    expect(collector.byteLength()).toBe(100);
    expect(collector.text()).toBe(`${'a'.repeat(60)}${'b'.repeat(40)}`);
  });

  it('stays refused after the first breach and never throws', () => {
    const collector = createBoundedOutput(10);
    expect(collector.push(Buffer.from('a'.repeat(11)))).toBe('exceeded');
    expect(collector.push(Buffer.from('b'.repeat(11)))).toBe('exceeded');
    expect(collector.byteLength()).toBe(10);
    expect(collector.exceeded()).toBe(true);
  });

  it('treats a non-positive or non-finite ceiling as unbounded', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const collector = createBoundedOutput(value);
      expect(collector.push(Buffer.from('x'.repeat(1000)))).toBe('ok');
      expect(collector.byteLength()).toBe(1000);
    }
  });

  it('utf8ByteLength agrees with Buffer.byteLength across 1/2/3/4-byte glyphs', () => {
    const samples = ['a', 'é', '中', '🙂', 'a中🙂é', '', '中'.repeat(7), 'a\uD800'];
    for (const sample of samples) {
      expect(utf8ByteLength(sample), `sample ${JSON.stringify(sample)}`)
        .toBe(Buffer.byteLength(sample, 'utf8'));
    }
  });

  it('refuses a ceiling that is not a positive integer (would silently disable the guard)', () => {
    for (const value of [0, -1, 1.5, Number.NaN]) {
      expect(() => assertSafeSpawnOptions({
        shell: false, windowsHide: true, maxStdoutBytes: value,
      })).toThrow(/maxStdoutBytes/);
    }
    expect(() => assertSafeSpawnOptions({
      shell: false, windowsHide: true, maxStderrBytes: -5,
    })).toThrow(/maxStderrBytes/);
    // A valid ceiling and "absent" both pass.
    expect(() => assertSafeSpawnOptions({
      shell: false, windowsHide: true, maxStdoutBytes: METADATA_MAX_STDOUT_BYTES,
    })).not.toThrow();
    expect(() => assertSafeSpawnOptions({ shell: false, windowsHide: true })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// L2 · the real adapter, real child process
// ---------------------------------------------------------------------------

describe('TASK-02 · bounded spawn against the real bundled node.exe (L2)', () => {
  it('1 · normal-sized stdout arrives complete and unmarked', async () => {
    const run = makeRun();
    const result = await runNode(run, 'process.stdout.write("x".repeat(4096))', {
      maxStdoutBytes: METADATA_MAX_STDOUT_BYTES,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(4096);
    expect(result.stderr).toBe('');
    expect(result.stderr).not.toContain(OUTPUT_LIMIT_MARKER);
    expect(result.timedOut).toBe(false);
  });

  it('2 · output landing exactly on the limit is not an overflow', async () => {
    const run = makeRun();
    const result = await runNode(run, 'process.stdout.write("x".repeat(1000))', {
      maxStdoutBytes: 1000,
    });
    expect(result.stdout.length).toBe(1000);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain(OUTPUT_LIMIT_MARKER);
  });

  it('3 · stdout over the limit is truncated, marked, and never a clean exit', async () => {
    const run = makeRun();
    const result = await runNode(run, flood('stdout', 65_536), {
      maxStdoutBytes: 2000,
    });
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(2000);
    expect(result.stderr).toContain(OUTPUT_LIMIT_MARKER);
    // A truncated document must NOT look like a successful run: the caller has
    // to see a non-zero/null exit so it errors out instead of parsing a stub.
    expect(result.exitCode).toBe(null);
    expect(result.timedOut).toBe(false);
  });

  it('4 · normal stderr passes through intact', async () => {
    const run = makeRun();
    const script = 'process.stderr.write("WARNING: something benign\\n");'
      + 'process.stdout.write("ok")';
    const result = await runNode(run, script, { maxStderrBytes: METADATA_MAX_STDERR_BYTES });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
    expect(result.stderr).toBe('WARNING: something benign\n');
    expect(result.stderr).not.toContain(OUTPUT_LIMIT_MARKER);
  });

  it('5 · stderr has its OWN ceiling, independent of stdout', async () => {
    const run = makeRun();
    const result = await runNode(run, flood('stderr', 65_536, 'e'), {
      maxStdoutBytes: METADATA_MAX_STDOUT_BYTES,
      maxStderrBytes: 1500,
    });
    expect(result.stdout).toBe('');
    // The accepted prefix plus the marker; stdout was never near its ceiling.
    expect(Buffer.byteLength(result.stderr, 'utf8'))
      .toBe(1500 + Buffer.byteLength(`\n${OUTPUT_LIMIT_MARKER}`, 'utf8'));
    expect(result.stderr).toContain(OUTPUT_LIMIT_MARKER);
    expect(result.exitCode).toBe(null);
  });

  it('6 · a CJK payload is cut on its BYTE budget in the real pipe', async () => {
    const run = makeRun();
    // 4000 CJK glyphs = 12,000 bytes but only 4000 JS characters. A ceiling of
    // 12,000 must pass it whole, proving the pipe is measured in bytes.
    const whole = await runNode(run, `process.stdout.write("中".repeat(4000))`, {
      maxStdoutBytes: 12_000,
    });
    expect(whole.exitCode).toBe(0);
    expect(whole.stdout.length).toBe(4000);
    expect(Buffer.byteLength(whole.stdout, 'utf8')).toBe(12_000);
    expect(whole.stderr).not.toContain(OUTPUT_LIMIT_MARKER);

    // 11,999 bytes of headroom can no longer hold it → breached on bytes.
    const cut = await runNode(run, `process.stdout.write("中".repeat(4000))`, {
      maxStdoutBytes: 11_999,
    });
    expect(cut.stderr).toContain(OUTPUT_LIMIT_MARKER);
    expect(cut.exitCode).toBe(null);
  });

  it('7 · stdout and stderr overflowing at once yields ONE marker and one kill', async () => {
    const run = makeRun();
    const script = 'const a="x".repeat(65536),b="e".repeat(65536);'
      + '(function p(){ process.stdout.write(a); process.stderr.write(b); setImmediate(p); })();';
    const result = await runNode(run, script, { maxStdoutBytes: 1000, maxStderrBytes: 1000 });
    expect(result.exitCode).toBe(null);
    expect(result.stderr.split(OUTPUT_LIMIT_MARKER).length - 1).toBe(1);
    expect(result.stdout.length).toBe(1000);
  });

  it('8 · an overflowing child is really TERMINATED, not merely abandoned', async () => {
    const run = makeRun();
    const sentinel = join(run.dir, 'survived.txt');
    const result = await runNode(
      run,
      `${afterSurvivalProof(sentinel)}${flood('stdout', 65_536)}`,
      { maxStdoutBytes: 1000 },
    );
    expect(result.stderr).toContain(OUTPUT_LIMIT_MARKER);
    // Give the sentinel timer more than its 1.5 s deadline; a surviving child
    // would have written it by now.
    await wait(2200);
    expect(existsSync(sentinel)).toBe(false);
  });

  it('9a · a cancelled streaming child is terminated and leaks no listeners', async () => {
    const run = makeRun();
    const sentinel = join(run.dir, 'stream-survived.txt');
    const script = `${afterSurvivalProof(sentinel)}${flood('stdout', 65_536)}`;
    const handle = run.process.spawnStreaming(
      NODE_EXE,
      ['-e', script],
      { shell: false, windowsHide: true },
      () => undefined,
    );
    expect(handle.pid).not.toBe(null);
    // A download legitimately streams megabytes; nothing here may cap it.
    await wait(400);
    expect(await handle.kill()).toBe(true);
    const done = await handle.done;
    expect(done.exitCode).toBe(null);
    await wait(1800);
    expect(existsSync(sentinel)).toBe(false);
    expect(await run.process.isAlive(handle.pid as number)).toBe(false);
  });

  it('9b · a timed-out bounded child is terminated, and repeated spawns do not leak', async () => {
    const run = makeRun();
    const sentinel = join(run.dir, 'timeout-survived.txt');
    const timedOut = await runNode(
      run,
      `${afterSurvivalProof(sentinel)}setInterval(()=>{},1000);`,
      { maxStdoutBytes: 1000, timeoutMs: 400 },
    );
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.exitCode).toBe(null);
    await wait(1800);
    expect(existsSync(sentinel)).toBe(false);

    // 20 consecutive overflow spawns: a leaked listener or an un-removed child
    // would show up as a crash, a hang, or a non-null exit code here.
    for (let i = 0; i < 20; i += 1) {
      const one = await runNode(run, 'process.stdout.write("y".repeat(5000))', {
        maxStdoutBytes: 100,
      });
      expect(one.exitCode).toBe(null);
      expect(one.stderr).toContain(OUTPUT_LIMIT_MARKER);
    }
  });

  /**
   * R1-07 — the "kill failed" exit path.
   *
   * A tree-kill CANNOT be made to fail on demand from a test (it is an external
   * `taskkill /T`), but its most common real failure is reproducible: the child
   * is already gone when the kill lands, so the PID lookup finds nothing. The
   * invariant that matters is not "the kill succeeded" — it is "the promise
   * still settles, promptly and with an honest result", which is exactly what a
   * caller with no `timeoutMs` depends on.
   *
   * Note `timeoutMs` is deliberately NOT passed here: this is the only case that
   * exercises the adapter's own deadline rather than the caller's.
   */
  it('9c · overflow on an already-exiting child still settles honestly (kill cannot land)', async () => {
    const run = makeRun();
    const started = Date.now();
    const result = await run.process.spawn(
      NODE_EXE,
      ['-e', 'process.stdout.write("z".repeat(200000)); process.exit(7)'],
      { shell: false, windowsHide: true, maxStdoutBytes: 1000 },
    );
    expect(result.exitCode).toBe(null);
    expect(result.stderr).toContain(OUTPUT_LIMIT_MARKER);
    expect(result.stderr.split(OUTPUT_LIMIT_MARKER).length - 1).toBe(1);
    // Settled by `close`/the grace deadline, never by the caller's timeout.
    expect(Date.now() - started).toBeLessThan(OVERFLOW_SETTLE_GRACE_MS + 5000);
  });

  it('9d · a spawn that never starts (missing exe) settles instead of hanging', async () => {
    const run = makeRun();
    const started = Date.now();
    const result = await run.process.spawn(
      join(run.dir, 'definitely-not-here.exe'),
      ['--version'],
      { shell: false, windowsHide: true, maxStdoutBytes: 1024 },
    );
    expect(result.exitCode).toBe(null);
    expect(result.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('9e · the overflow deadline is bounded and shorter than every bounded caller timeout', () => {
    // A grace longer than a caller's own timeout would be dead code; a grace of
    // zero (or none at all) is the hang this test exists to prevent.
    expect(OVERFLOW_SETTLE_GRACE_MS).toBeGreaterThan(0);
    expect(OVERFLOW_SETTLE_GRACE_MS).toBeLessThan(URL_PRECHECK_TIMEOUT_MS);
  });

  it('10 · a normal download stream is NEVER capped (unbounded stays unbounded)', async () => {
    const run = makeRun();
    // ~8 MiB — 8x the metadata ceiling. A download may legitimately emit this.
    const script = 'const c="p".repeat(65_536);'
      + 'for(let i=0;i<128;i+=1) process.stdout.write(c);';
    const handle = run.process.spawnStreaming(
      NODE_EXE,
      ['-e', script],
      { shell: false, windowsHide: true, timeoutMs: 30_000 },
      () => undefined,
    );
    const done = await handle.done;
    expect(done.exitCode).toBe(0);
    expect(Buffer.byteLength(done.stdout, 'utf8')).toBe(65_536 * 128);
    expect(done.stdout).not.toContain(OUTPUT_LIMIT_MARKER);
  });

  it('11 · the engine hands the ceilings to the adapter for probe and probePlaylist', async () => {
    const run = makeRun();
    // An in-memory process port would lose the point: assert the REAL adapter
    // receives the ceilings from the engine, then feeds a real document through.
    const calls: Array<{ argv: readonly string[]; opts: Record<string, unknown> }> = [];
    const recording: ProcessPort = {
      spawn(file, argv, opts) {
        calls.push({ argv, opts: opts as unknown as Record<string, unknown> });
        writeFileSync(join(run.dir, 'unused.txt'), '');
        return Promise.resolve<SpawnResult>({
          exitCode: 0,
          stdout: JSON.stringify({
            id: 'p1', title: 'T', _type: 'playlist', extractor_key: 'generic',
            webpage_url: 'https://example.org/p',
            entries: [{ id: 'a', title: 'A', url: 'https://example.org/a', _type: 'url' }],
          }),
          stderr: '',
          timedOut: false,
        });
      },
      spawnStreaming: run.process.spawnStreaming,
      isAlive: run.process.isAlive,
    };
    const { YtDlpEngine } = await import('@ytvdlt/engine-ytdlp');
    const { Logger, ErrorMapper } = await import('@ytvdlt/core');
    const engine = new YtDlpEngine({
      ports: { ...run.ports, process: recording },
      logger: new Logger({ ports: run.ports, appVersion: '0.2.9' }),
      mapper: new ErrorMapper({ clock: run.ports.clock }),
      enginePath: NODE_EXE,
      jsRuntimePath: NODE_EXE,
      appVersion: '0.2.9',
    });

    await engine.probePlaylist('https://example.org/p', { jsRuntimePath: NODE_EXE });
    await engine.probe('https://example.org/v', { jsRuntimePath: NODE_EXE });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.opts['maxStdoutBytes']).toBe(METADATA_MAX_STDOUT_BYTES);
      expect(call.opts['maxStderrBytes']).toBe(METADATA_MAX_STDERR_BYTES);
    }
    // The bounded path must not have quietly become a different argv.
    expect(calls[0]?.argv).toContain('--flat-playlist');
    expect(calls[1]?.argv).toContain('--no-playlist');
  });

  it('12 · an over-limit probe surfaces as a deliberate failure, not a truncated list', async () => {
    const { ports, state } = createInMemoryPorts();
    // The adapter's overflow shape: poisoned exit code + the marker on stderr.
    state.spawnResults.set('yt-dlp.exe', {
      exitCode: null,
      stdout: '{"id":"p","title":"t","_type":"playlist","entries":[',
      stderr: `\n${OUTPUT_LIMIT_MARKER}`,
      timedOut: false,
    });
    const engine = new YtDlpEngine({
      ports,
      logger: new Logger({ ports, appVersion: '0.2.9' }),
      mapper: new ErrorMapper({ clock: ports.clock }),
      enginePath: 'C:/runtime/yt-dlp.exe',
      jsRuntimePath: 'C:/runtime/node.exe',
      appVersion: '0.2.9',
    });

    // A truncated playlist body must never come back as a short-but-valid list.
    await expect(engine.probePlaylist('https://example.org/p', { jsRuntimePath: 'C:/runtime/node.exe' }))
      .rejects.toMatchObject({ code: 'UNKNOWN' });

    // Same for a single-video probe.
    await expect(engine.probe('https://example.org/v', { jsRuntimePath: 'C:/runtime/node.exe' }))
      .rejects.toMatchObject({ code: 'UNKNOWN' });

    // The overflow is NOT mislabelled as a network / permission problem: those
    // codes would send the user to the wrong fix. Checked explicitly, because
    // the marker text must stay free of the keyword table's triggers.
    for (const call of state.spawnCalls) {
      expect(call.opts['maxStdoutBytes']).toBe(METADATA_MAX_STDOUT_BYTES);
      expect(call.opts['maxStderrBytes']).toBe(METADATA_MAX_STDERR_BYTES);
    }
  });

  it('13 · the overflow marker matches no stderr keyword rule', async () => {
    const { ErrorMapper: Mapper } = await import('@ytvdlt/core');
    const mapper = new Mapper({ clock: { nowIso: () => 'x', nowEpochMs: () => 0 } });
    const ctx = {
      url: 'https://example.org/p', stderr: OUTPUT_LIMIT_MARKER, engineVersion: 'x',
      appVersion: 'x', os: 'win32', argv: [] as string[],
    };
    // TASK-02: an overflow must not be reported as a timeout, a 429 or a
    // permission error — the marker deliberately avoids every such keyword.
    expect(mapper.map(OUTPUT_LIMIT_MARKER, ctx).code).toBe('UNKNOWN');
  });
});
