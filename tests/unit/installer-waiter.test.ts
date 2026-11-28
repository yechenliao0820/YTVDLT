/**
 * D-291 · installer waiter handshake.
 *
 * `spawn` succeeding only proves a PowerShell PROCESS started. The waiter must
 * PROVE the script is running (ACK file) before the app quits; otherwise the
 * install is silently lost. These tests pin every branch of that decision,
 * including the kill of an unacknowledged waiter (it would otherwise launch the
 * installer 45 s later, behind the fallback).
 */
import { describe, it, expect } from 'vitest';
import {
  scheduleInstallerAfterExit, type WaiterChild,
} from '../../apps/desktop/src/main/installer-waiter.js';

class FakeChild implements WaiterChild {
  readonly pid = 4242;
  unrefCalls = 0;
  private handlers = new Map<string, (() => void)[]>();

  once(event: 'error' | 'exit', listener: () => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
  }

  unref(): void { this.unrefCalls += 1; }

  emit(event: 'error' | 'exit'): void {
    for (const handler of this.handlers.get(event) ?? []) handler();
  }
}

function waiterFixture(options: {
  readonly ackAfterMs?: number | null;
  readonly spawnThrows?: boolean;
}) {
  const child = new FakeChild();
  const killed: number[] = [];
  const removed: string[] = [];
  let ackAt = options.ackAfterMs === undefined ? 0 : options.ackAfterMs;
  const startedAt = Date.now();
  const scheduled = scheduleInstallerAfterExit('C:/Updates/YTVDLT Setup 0.3.4.exe', {
    pid: 777,
    spawn: () => {
      if (options.spawnThrows === true) throw new Error('EPERM');
      return child;
    },
    statIsFile: async () => {
      if (ackAt === null) return false;
      return Date.now() - startedAt >= ackAt;
    },
    remove: async (path) => { removed.push(path); },
    ackTimeoutMs: 60,
    pollMs: 5,
    killTree: (pid) => { killed.push(pid); },
  });
  return { scheduled, child, killed, removed };
}

describe('D-291 · installer waiter ACK handshake', () => {
  it('resolves true only after the ACK file exists, then removes it', async () => {
    const f = waiterFixture({ ackAfterMs: 10 });
    await expect(f.scheduled).resolves.toBe(true);
    expect(f.child.unrefCalls).toBe(1);
    expect(f.removed).toHaveLength(1);
    expect(f.removed[0]).toContain('installer-launch.');
    expect(f.removed[0]?.endsWith('.ack')).toBe(true);
    expect(f.killed).toEqual([]);
  });

  it('no ACK within the window: resolves false and KILLS the waiting child', async () => {
    const f = waiterFixture({ ackAfterMs: null });
    await expect(f.scheduled).resolves.toBe(false);
    // A live waiter would start the installer 45 s later, after the fallback.
    expect(f.killed).toEqual([4242]);
    expect(f.child.unrefCalls).toBe(0);
  });

  it('a spawn throw is reported as "not scheduled" (caller falls back)', async () => {
    const f = waiterFixture({ spawnThrows: true });
    await expect(f.scheduled).resolves.toBe(false);
    expect(f.killed).toEqual([]);
  });

  it('a child that exits before the ACK is a failure, not a success', async () => {
    const f = waiterFixture({ ackAfterMs: null });
    setTimeout(() => f.child.emit('exit'), 5);
    await expect(f.scheduled).resolves.toBe(false);
  });

  it('a child error before the ACK is a failure', async () => {
    const f = waiterFixture({ ackAfterMs: null });
    setTimeout(() => f.child.emit('error'), 5);
    await expect(f.scheduled).resolves.toBe(false);
  });
});
