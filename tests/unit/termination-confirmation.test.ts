/**
 * D-137 (F-03) — a kill must be OBSERVED, not just issued.
 *
 * L2-local: the real `node-ports` adapter spawning the real bundled node.exe.
 * No network, no yt-dlp, no media. The child writes a sentinel file after 1.5 s,
 * so the file's absence is proof that the process tree actually stopped (§9
 * 坑 21: a bare `child.kill()` would leave it running).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TERMINATION_UNCONFIRMED_MARKER } from '@ytvdlt/shared';
import {
  createNodePorts, OVERFLOW_SETTLE_GRACE_MS,
} from '../../apps/desktop/src/main/adapters/node-ports.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NODE_EXE = join(ROOT, 'resources', 'runtime', 'win-x64', 'node.exe');
const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ytvdlt-kill-'));
  cleanup.push(dir);
  return dir;
}

function ports(root: string) {
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

describe('D-137 · termination marker', () => {
  it('is a neutral fixed string that cannot be misread as a network/permission error', () => {
    expect(TERMINATION_UNCONFIRMED_MARKER).toMatch(/^\[ytvdlt\]/);
    for (const word of [
      'timeout', 'timed out', 'denied', 'permission', 'network', '429',
      'proxy', 'cookie', 'unsupported', 'eacces', 'enoent',
    ]) {
      expect(TERMINATION_UNCONFIRMED_MARKER.toLowerCase()).not.toContain(word);
    }
  });
});

describe('D-137 · bounded, observed termination (real child)', () => {
  it('settles within the grace bound and leaves NO surviving process', async () => {
    const dir = scratch();
    const sentinel = join(dir, 'survived.txt');
    const script = 'setTimeout(()=>{require(\'fs\').writeFileSync('
      + JSON.stringify(sentinel) + ',\'alive\')},1500); setInterval(()=>{},1000);';

    const started = Date.now();
    const result = await ports(dir).process.spawn(NODE_EXE, ['-e', script], {
      shell: false,
      windowsHide: true,
      timeoutMs: 200,
      maxStdoutBytes: 1024,
    });
    const elapsed = Date.now() - started;

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    // Waiting for the kill answer is BOUNDED, not an infinite join.
    expect(elapsed).toBeLessThan(OVERFLOW_SETTLE_GRACE_MS + 3_000);
    // The kill succeeded and `close` was observed, so there must be no false
    // "unconfirmed" report on the healthy path.
    expect(result.stderr).not.toContain(TERMINATION_UNCONFIRMED_MARKER);

    await new Promise<void>((resolve) => setTimeout(resolve, 1_800));
    expect(existsSync(sentinel)).toBe(false);
  }, 20_000);
});
