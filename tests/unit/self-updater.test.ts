/**
 * M5-5 · engine self-update orchestration (D-62, §3.3).
 *
 * What is pinned here is the damage control, not the happy path:
 *   - a checksum mismatch writes NOTHING (original binary untouched, no `.new`);
 *   - the `.bak` is written before the target is touched and survives a rollback;
 *   - a failed `rename()` or a bad post-swap hash restores the old binary;
 *   - `resume()` runs in `finally` (and on the `queue-busy` early return), so
 *     an update can never wedge the queue.
 *
 * Level: L0 (in-memory ports). The real-filesystem run is `engine-update-local`.
 */
import { describe, it, expect } from 'vitest';
import { Logger } from '@ytvdlt/core';
import { SelfUpdater, parseChecksums, QUEUE_IDLE_TIMEOUT_MS } from '@ytvdlt/engine-ytdlp';
import type {
  CorePorts, EngineUpdateSource, QueueIntakeGate,
} from '@ytvdlt/shared';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const ENGINE = 'C:/runtime/yt-dlp.exe';
const OLD_BYTES = new TextEncoder().encode('old-engine');
const NEW_BYTES = new TextEncoder().encode('new-engine');

function sourceOf(overrides: Partial<EngineUpdateSource> & { checksums?: string } = {}): EngineUpdateSource {
  const { checksums = '', ...rest } = overrides;
  return {
    kind: 'local-dir',
    async fetchChecksums() { return checksums; },
    async fetchEngineBinary() { return NEW_BYTES; },
    ...rest,
  };
}

function gateOf(): QueueIntakeGate & { readonly calls: string[] } {
  const calls: string[] = [];
  let paused = false;
  return {
    calls,
    pause() { paused = true; calls.push('pause'); },
    resume() { paused = false; calls.push('resume'); },
    isPaused() { return paused; },
  };
}

/** D-171 variant: a gate that also answers `waitForIdle`, like the real intake gate. */
function gateWithIdleOf(idle: boolean): QueueIntakeGate & {
  readonly calls: string[];
  readonly timeouts: number[];
} {
  const calls: string[] = [];
  const timeouts: number[] = [];
  let paused = false;
  return {
    calls,
    timeouts,
    pause() { paused = true; calls.push('pause'); },
    resume() { paused = false; calls.push('resume'); },
    isPaused() { return paused; },
    waitForIdle(timeoutMs: number) {
      timeouts.push(timeoutMs);
      return Promise.resolve(idle);
    },
  };
}

/** D-196 variant: `waitForIdle` rejects BEFORE the swap's try/finally. */
function gateWithIdleReject(): QueueIntakeGate & { readonly calls: string[] } {
  const calls: string[] = [];
  let paused = false;
  return {
    calls,
    pause() { paused = true; calls.push('pause'); },
    resume() { paused = false; calls.push('resume'); },
    isPaused() { return paused; },
    async waitForIdle() { throw new Error('idle probe failed'); },
  };
}

async function setup(options: {
  checksums?: string;
  bytes?: Uint8Array;
  source?: Partial<EngineUpdateSource>;
  fs?: Partial<CorePorts['fs']>;
  hash?: Partial<CorePorts['hash']>;
  engineExists?: boolean;
  intakeGate?: QueueIntakeGate;
} = {}) {
  const mem = createInMemoryPorts();
  const bytes = options.bytes ?? NEW_BYTES;
  const hash = await mem.ports.hash.sha256Bytes(bytes);
  mem.state.spawnResults.set('yt-dlp.exe', {
    exitCode: 0, stdout: '2026.11.06\n', stderr: '', timedOut: false,
  });
  if (options.engineExists !== false) mem.state.bytes.set(ENGINE, OLD_BYTES);

  const ports: CorePorts = {
    ...mem.ports,
    fs: { ...mem.ports.fs, ...(options.fs ?? {}) },
    hash: { ...mem.ports.hash, ...(options.hash ?? {}) },
  };
  const logger = new Logger({ ports, appVersion: '0.1.0' });
  const gate = options.intakeGate ?? gateOf();
  const updater = new SelfUpdater({
    ports,
    logger,
    source: sourceOf({ checksums: options.checksums ?? `${hash}  yt-dlp.exe\n`, ...(options.source ?? {}) }),
    intakeGate: gate,
    enginePath: ENGINE,
    channel: 'stable',
  });
  return { mem, updater, gate, hash };
}

const textOf = (mem: ReturnType<typeof createInMemoryPorts>, path: string): string | undefined => {
  const bytes = mem.state.bytes.get(path);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
};

describe('M5-5 · parseChecksums', () => {
  it('reads the line for the requested file and ignores everything else', () => {
    const text = `${'a'.repeat(64)}  ffmpeg.exe\n${'b'.repeat(64)}  yt-dlp.exe\n${'c'.repeat(64)}  node.exe`;
    expect(parseChecksums(text, 'yt-dlp.exe')).toEqual({ sha256: 'b'.repeat(64), fileName: 'yt-dlp.exe' });
    expect(parseChecksums(text, 'missing.exe')).toBeNull();
  });

  it('accepts the binary-mode star prefix and is case-insensitive', () => {
    const text = `${'D'.repeat(64)} *YT-DLP.EXE`;
    expect(parseChecksums(text, 'yt-dlp.exe')?.sha256).toBe('d'.repeat(64));
  });

  it('rejects malformed hashes and blank input', () => {
    expect(parseChecksums('deadbeef  yt-dlp.exe', 'yt-dlp.exe')).toBeNull();
    expect(parseChecksums('', 'yt-dlp.exe')).toBeNull();
  });
});

describe('M5-5 · happy path', () => {
  it('backs up, swaps, verifies and cleans up', async () => {
    const { mem, updater, gate } = await setup();
    const result = await updater.update();
    expect(result.changed).toBe(true);
    expect(result.channel).toBe('stable');
    expect(textOf(mem, ENGINE)).toBe('new-engine');
    expect(mem.state.bytes.has(`${ENGINE}.new`)).toBe(false);
    expect(mem.state.bytes.has(`${ENGINE}.bak`)).toBe(false);
    expect(gate.calls).toEqual(['pause', 'resume']);
    expect(gate.isPaused()).toBe(false);
  });

  it('works when there is no installed binary yet (fresh install, no backup)', async () => {
    const { mem, updater } = await setup({ engineExists: false });
    const result = await updater.update();
    expect(result.changed).toBe(true);
    expect(textOf(mem, ENGINE)).toBe('new-engine');
    expect(mem.state.bytes.has(`${ENGINE}.bak`)).toBe(false);
  });

  it('writes an info log line with both versions', async () => {
    const { mem, updater } = await setup();
    await updater.update();
    const entry = mem.state.logLines.find((line) => line.includes('component updated'));
    expect(entry).toBeDefined();
    expect(entry).toContain('2026.11.06');
  });
});

describe('M5-5 · refusal paths write nothing', () => {
  it('refuses on checksum mismatch and leaves the original binary intact', async () => {
    const { mem, updater, gate } = await setup({ checksums: `${'0'.repeat(64)}  yt-dlp.exe` });
    const result = await updater.update();
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('checksum-mismatch');
    expect(textOf(mem, ENGINE)).toBe('old-engine');
    expect(mem.state.bytes.has(`${ENGINE}.new`)).toBe(false);
    expect(mem.state.bytes.has(`${ENGINE}.bak`)).toBe(false);
    // No swap is attempted, so intake is never paused: a bad download must not
    // stall the queue even briefly.
    expect(gate.calls).toEqual([]);
    expect(mem.state.logLines.some((line) => line.includes('checksum mismatch'))).toBe(true);
  });

  it('refuses when the manifest has no line for yt-dlp.exe', async () => {
    const { mem, updater } = await setup({ checksums: `${'a'.repeat(64)}  ffmpeg.exe` });
    const result = await updater.update();
    expect(result.changed).toBe(false);
    expect(textOf(mem, ENGINE)).toBe('old-engine');
    expect(mem.state.logLines.some((line) => line.includes('no checksum line'))).toBe(true);
  });

  it('refuses when the manifest cannot be fetched at all', async () => {
    const { mem, updater } = await setup({
      source: { async fetchChecksums() { throw new Error('ECONNREFUSED'); } },
    });
    const result = await updater.update();
    expect(result.changed).toBe(false);
    expect(textOf(mem, ENGINE)).toBe('old-engine');
    expect(mem.state.logLines.some((line) => line.includes('checksum manifest unavailable'))).toBe(true);
  });
});

describe('M5-5 · rollback', () => {
  it('restores the backup when the swap rename fails', async () => {
    const { mem, updater } = await setup({
      fs: {
        async rename(from: string, to: string) {
          if (from.endsWith('.new')) throw new Error('EBUSY');
          mem.state.bytes.set(to, mem.state.bytes.get(from) ?? new Uint8Array());
          mem.state.bytes.delete(from);
        },
      },
    });
    const result = await updater.update();
    expect(result.changed).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(textOf(mem, ENGINE)).toBe('old-engine');
    expect(mem.state.logLines.some((line) => line.includes('rolling back'))).toBe(true);
  });

  it('rolls back when the post-swap hash does not match', async () => {
    let swapped = false;
    const { mem, updater } = await setup({
      fs: {
        async rename(from: string, to: string) {
          mem.state.bytes.set(to, mem.state.bytes.get(from) ?? new Uint8Array());
          mem.state.bytes.delete(from);
          if (from.endsWith('.new')) swapped = true;
        },
      },
      hash: {
        async sha256File() { return swapped ? 'f'.repeat(64) : '0'.repeat(64); },
      },
    });
    const result = await updater.update();
    expect(result.changed).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(textOf(mem, ENGINE)).toBe('old-engine');
    expect(mem.state.logLines.some((line) => line.includes('post-swap checksum mismatch'))).toBe(true);
  });

  it('always resumes intake, even when the update throws', async () => {
    const { updater, gate } = await setup({
      fs: { async writeBytesAtomic() { throw new Error('EACCES'); } },
    });
    const result = await updater.update();
    expect(result.changed).toBe(false);
    expect(gate.calls).toEqual(['pause', 'resume']);
    expect(gate.isPaused()).toBe(false);
  });
});

describe('D-171 · queue idle gate (waitForIdle)', () => {
  it('defers the swap and still resumes intake when the queue never goes idle', async () => {
    const { mem, updater, gate } = await setup({ intakeGate: gateWithIdleOf(false) });
    const result = await updater.update();
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('queue-busy');
    expect(textOf(mem, ENGINE)).toBe('old-engine');
    expect(mem.state.bytes.has(`${ENGINE}.new`)).toBe(false);
    expect(mem.state.bytes.has(`${ENGINE}.bak`)).toBe(false);
    // The regression this pins: the busy return sits before the try/finally,
    // so it must resume on its own — a missed call parks the queue forever.
    expect(gate.calls).toEqual(['pause', 'resume']);
    expect(gate.isPaused()).toBe(false);
    expect(gate.timeouts).toEqual([QUEUE_IDLE_TIMEOUT_MS]);
    expect(mem.state.logLines.some((line) => line.includes('queue still busy'))).toBe(true);
  });

  it('waits for idle through the gate and swaps once it reports idle', async () => {
    const { mem, updater, gate } = await setup({ intakeGate: gateWithIdleOf(true) });
    const result = await updater.update();
    expect(result.changed).toBe(true);
    expect(textOf(mem, ENGINE)).toBe('new-engine');
    expect(mem.state.bytes.has(`${ENGINE}.new`)).toBe(false);
    expect(mem.state.bytes.has(`${ENGINE}.bak`)).toBe(false);
    expect(gate.calls).toEqual(['pause', 'resume']);
    expect(gate.isPaused()).toBe(false);
    expect(gate.timeouts).toEqual([QUEUE_IDLE_TIMEOUT_MS]);
  });

  it('D-196 · waitForIdle 拒绝时仍恢复队列入口，且组件文件一字未动', async () => {
    // 修前异常在进入 try/finally 之前传播，resume() 不执行 → 队列永久暂停。
    const gate = gateWithIdleReject();
    const { mem, updater } = await setup({ intakeGate: gate });
    await expect(updater.update()).rejects.toThrow(/idle probe failed/);
    expect(gate.calls).toEqual(['pause', 'resume']);
    expect(gate.isPaused()).toBe(false);
    expect(textOf(mem, ENGINE)).toBe('old-engine');
    expect(mem.state.bytes.has(`${ENGINE}.new`)).toBe(false);
    expect(mem.state.bytes.has(`${ENGINE}.bak`)).toBe(false);
  });
});
