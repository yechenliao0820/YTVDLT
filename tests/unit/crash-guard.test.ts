/**
 * M5 · crash guard (A-4.5-08).
 *
 * Acceptance reads: "注入异常 → 生成含版本信息的崩溃报告文件且不静默吞错；
 * 下次启动提示". Both halves are asserted here against the REAL `Logger`
 * (which owns redaction) and the in-memory filesystem:
 *   - a crash file contains appVersion / os / message and a redacted context;
 *   - `guard()` re-throws instead of swallowing;
 *   - the next start sees the unacknowledged report, and acknowledging it moves
 *     the file to `*.ack.json` instead of deleting the evidence.
 */
import { describe, it, expect } from 'vitest';
import { CrashGuard, Logger, isCrashFile, isAcknowledgedCrashFile } from '@ytvdlt/core';
import { createInMemoryPorts, type InMemoryPorts } from './helpers/in-memory-ports.js';

function setup(): { ports: InMemoryPorts; guard: CrashGuard } {
  const ports = createInMemoryPorts();
  const logger = new Logger({ ports: ports.ports, appVersion: '0.1.0' });
  const guard = new CrashGuard({ ports: ports.ports, logger, appVersion: '0.1.0' });
  return { ports, guard };
}

describe('crash guard · capture writes a versioned, redacted report', () => {
  it('records appVersion, os and the message', async () => {
    const { ports, guard } = setup();
    const path = await guard.capture(new Error('boom'), { source: 'unhandledRejection' });
    expect(path.startsWith(ports.state.env.logsDir)).toBe(true);
    const body = JSON.parse(ports.state.files.get(path) ?? '{}') as Record<string, unknown>;
    expect(body['appVersion']).toBe('0.1.0');
    expect(body['message']).toBe('boom');
    expect(body['os']).toBe('win32');
    expect(String(body['context'])).not.toContain('SUPERSECRET');
  });

  it('redacts credentials carried in the context', async () => {
    const { ports, guard } = setup();
    const path = await guard.capture(new Error('net'), {
      url: 'https://example.org/v?token=SUPERSECRET',
      headers: 'Cookie: SID=SUPERSECRET',
    });
    const raw = ports.state.files.get(path) ?? '';
    expect(raw).not.toContain('SUPERSECRET');
    expect(raw).toContain('net');
  });

  it('re-throws instead of swallowing, after writing the file', async () => {
    const { ports, guard } = setup();
    await expect(guard.guard({ source: 'main' }, async () => {
      throw new Error('fatal-boot');
    })).rejects.toThrow('fatal-boot');
    const written = [...ports.state.files.keys()].filter((path) => isCrashFile(path.split(/[\\/]/).pop() ?? ''));
    expect(written).toHaveLength(1);
    // The wrapped value still resolves normally when nothing throws.
    await expect(guard.guard({}, async () => 42)).resolves.toBe(42);
  });
});

describe('crash guard · next-start notice', () => {
  it('reports pending crashes and clears them only after acknowledgement', async () => {
    const { guard } = setup();
    expect(await guard.startupNotice()).toBeNull();

    const first = await guard.capture(new Error('one'));
    const notice = await guard.startupNotice();
    expect(notice?.count).toBe(1);
    expect(notice?.latest.message).toBe('one');
    expect(notice?.latest.acknowledged).toBe(false);

    expect(await guard.acknowledge(first)).toBe(true);
    expect(await guard.startupNotice()).toBeNull();
    // Evidence is renamed, never deleted.
    const history = await guard.history();
    expect(history).toHaveLength(1);
    expect(history[0]?.acknowledged).toBe(true);
    expect(history[0]?.fileName).toMatch(/\.ack\.json$/);
  });

  it('counts several pending crashes and returns the newest last', async () => {
    const { guard } = setup();
    await guard.capture(new Error('one'));
    await guard.capture(new Error('two'));
    const notice = await guard.startupNotice();
    expect(notice?.count).toBe(2);
    expect(notice?.latest.message).toBe('two');
    expect(await guard.acknowledge('/nope/crash-1.json')).toBe(false);
  });

  it('ignores non-crash files and tolerates a missing logs dir', async () => {
    expect(isCrashFile('crash-1762300800000.json')).toBe(true);
    expect(isCrashFile('crash-1762300800000.ack.json')).toBe(false);
    expect(isAcknowledgedCrashFile('crash-1762300800000.ack.json')).toBe(true);
    expect(isCrashFile('app.log')).toBe(false);

    const ports = createInMemoryPorts();
    const guard = new CrashGuard({
      ports: ports.ports,
      logger: new Logger({ ports: ports.ports, appVersion: '0.1.0' }),
      appVersion: '0.1.0',
    });
    // No logs directory yet -> an empty list, never an exception.
    expect(await guard.pending()).toEqual([]);
    expect(await guard.history()).toEqual([]);
  });
});
