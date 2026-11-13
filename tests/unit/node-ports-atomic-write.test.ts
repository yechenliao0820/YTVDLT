/**
 * D-145 · atomic-write replace step on a REAL filesystem (L2-local).
 *
 * Level: L2-local — real `node:fs` in `os.tmpdir()`; ONLY the final rename is
 * intercepted (`vi.spyOn(fs.promises, 'rename')`, same object the adapter
 * destructures) to simulate the Windows lock churn (antivirus / indexer
 * holding the target open) that motivated D-145.
 *
 * What is pinned here:
 *   - the target is replaced by ONE rename and `fs.rm` is never aimed at the
 *     target — the old rm-then-rename window must stay closed;
 *   - a rename failure leaves the OLD file intact and removes the `.tmp`
 *     scratch file (the audit's required regression case);
 *   - EPERM / EBUSY / EACCES are retried a bounded number of times; anything
 *     else (ENOENT) is not retried;
 *   - a successful replace leaves no `.tmp` behind;
 *   - T2: every write uses a UNIQUE scratch name (`<path>.<pid>-<n>.tmp`) —
 *     concurrent writers to one target can no longer share (and truncate) the
 *     same tmp, and a failure BEFORE the rename cleans up its own scratch.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  promises as fsPromises,
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  createNodePorts,
  ATOMIC_REPLACE_MAX_RETRIES,
  ATOMIC_REPLACE_RETRY_DELAY_MS,
} from '../../apps/desktop/src/main/adapters/node-ports.js';
import type { FileSystemPort } from '@ytvdlt/shared';

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

let fsPort: FileSystemPort;
beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'ytvdlt-atomic-write-'));
  cleanup.push(root);
  fsPort = createNodePorts({
    packaged: false,
    resourcesPath: root,
    runtimeDir: root,
    appDataDir: join(root, 'data'),
    configDir: join(root, 'data', 'config'),
    logsDir: join(root, 'data', 'logs'),
    appVersion: '0.0.0-test',
  }).fs;
});

/** A realistic OS-shaped fs error, as `fs.rename` would reject with. */
const fsError = (code: string): Error =>
  Object.assign(new Error(`${code}: simulated ${code} during rename (D-145 test)`), {
    code, errno: -1, syscall: 'rename',
  });

let renameSpy: MockInstance<typeof fsPromises.rename>;
let rmSpy: MockInstance<typeof fsPromises.rm>;
beforeEach(() => {
  // spyOn keeps the original implementation unless overridden, so untouched
  // tests exercise the REAL rename against os.tmpdir().
  renameSpy = vi.spyOn(fsPromises, 'rename');
  rmSpy = vi.spyOn(fsPromises, 'rm');
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Every rename the adapter attempted, as (from, to) pairs. */
const renameTargets = (): Array<readonly [string, string]> =>
  renameSpy.mock.calls.map((call) => [call[0], call[1]] as const);
/** Every `fs.rm` the adapter attempted — must only ever aim at `.tmp` files. */
const rmTargets = (): string[] => rmSpy.mock.calls.map((call) => call[0]);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** T2: the unique scratch name the adapter generates — `<path>.<pid>-<seq>.tmp`. */
const tmpPatternOf = (path: string): RegExp =>
  new RegExp(`^${escapeRegExp(path)}\\.\\d+-\\d+\\.tmp$`);
/** The legacy collision-prone name that must never exist again. */
const legacyTmpOf = (path: string): string => `${path}.tmp`;

describe('D-145 · atomic write replace step · real filesystem (L2-local)', () => {
  it('writeTextAtomic: replaces the target via one rename, no .tmp left, target never rm-ed', async () => {
    const path = join(cleanup[0] ?? '', 'text-ok.json');
    writeFileSync(path, 'old-config');

    await fsPort.writeTextAtomic(path, 'new-config');

    expect(readFileSync(path, 'utf8')).toBe('new-config');
    expect(existsSync(legacyTmpOf(path))).toBe(false);
    expect(renameTargets()).toHaveLength(1);
    const [tmpFrom, tmpTo] = renameTargets()[0] as readonly [string, string];
    expect(tmpFrom).toMatch(tmpPatternOf(path));
    expect(tmpTo).toBe(path);
    expect(existsSync(tmpFrom)).toBe(false);
    expect(rmTargets()).toEqual([]);
  });

  it('writeTextAtomic: rename failing with EPERM leaves the OLD config intact and cleans the tmp (audit case)', async () => {
    const path = join(cleanup[0] ?? '', 'text-fail.json');
    writeFileSync(path, 'old-config');
    renameSpy.mockRejectedValue(fsError('EPERM'));

    await expect(fsPort.writeTextAtomic(path, 'new-config')).rejects.toThrow(/EPERM/);

    // The only good copy survived every failed attempt.
    expect(readFileSync(path, 'utf8')).toBe('old-config');
    // The scratch file did not outlive the failure.
    expect(existsSync(legacyTmpOf(path))).toBe(false);
    // Bounded: one attempt + ATOMIC_REPLACE_MAX_RETRIES retries, all aimed at
    // the SAME unique tmp → target pair. No rm ever touched the target.
    expect(renameSpy.mock.calls.length).toBe(ATOMIC_REPLACE_MAX_RETRIES + 1);
    const tmps = renameTargets().map(([from]) => from);
    for (const tmp of tmps) expect(tmp).toMatch(tmpPatternOf(path));
    expect(new Set(tmps).size).toBe(1);
    expect(rmTargets()).toEqual([tmps[0]]);
  });

  it('writeTextAtomic: one transient EPERM then the real rename succeeds', async () => {
    const path = join(cleanup[0] ?? '', 'text-retry.json');
    writeFileSync(path, 'old-config');
    renameSpy.mockRejectedValueOnce(fsError('EPERM'));

    await fsPort.writeTextAtomic(path, 'new-config');

    expect(readFileSync(path, 'utf8')).toBe('new-config');
    expect(existsSync(legacyTmpOf(path))).toBe(false);
    expect(renameSpy.mock.calls.length).toBe(2);
    expect(renameTargets()[0]?.[0]).toMatch(tmpPatternOf(path));
    expect(rmTargets()).toEqual([]);
  });

  it('writeTextAtomic: EBUSY and EACCES are retried like EPERM', async () => {
    const path = join(cleanup[0] ?? '', 'text-errno-set.json');
    writeFileSync(path, 'old-config');
    renameSpy.mockRejectedValueOnce(fsError('EBUSY'));
    renameSpy.mockRejectedValueOnce(fsError('EACCES'));

    await fsPort.writeTextAtomic(path, 'new-config');

    expect(readFileSync(path, 'utf8')).toBe('new-config');
    expect(renameSpy.mock.calls.length).toBe(3);
    expect(rmTargets()).toEqual([]);
  });

  it('writeTextAtomic: a non-transient error (ENOENT) is rethrown without retries', async () => {
    const path = join(cleanup[0] ?? '', 'text-enoent.json');
    writeFileSync(path, 'old-config');
    renameSpy.mockRejectedValueOnce(fsError('ENOENT'));

    await expect(fsPort.writeTextAtomic(path, 'new-config')).rejects.toThrow(/ENOENT/);

    expect(readFileSync(path, 'utf8')).toBe('old-config');
    expect(renameSpy.mock.calls.length).toBe(1);
    expect(rmTargets()).toEqual([renameTargets()[0]?.[0]]);
  });

  it('writeBytesAtomic: replaces the target via one rename, no .tmp left, target never rm-ed', async () => {
    const path = join(cleanup[0] ?? '', 'bytes-ok.bin');
    writeFileSync(path, Buffer.from([9, 9, 9]));
    const replacement = Buffer.from([1, 2, 3]);

    await fsPort.writeBytesAtomic(path, new Uint8Array(replacement));

    expect(Buffer.from(readFileSync(path)).equals(replacement)).toBe(true);
    expect(existsSync(legacyTmpOf(path))).toBe(false);
    expect(renameTargets()).toHaveLength(1);
    const [tmpFrom, tmpTo] = renameTargets()[0] as readonly [string, string];
    expect(tmpFrom).toMatch(tmpPatternOf(path));
    expect(tmpTo).toBe(path);
    expect(existsSync(tmpFrom)).toBe(false);
    expect(rmTargets()).toEqual([]);
  });

  it('writeBytesAtomic: rename failing with EPERM leaves the OLD bytes intact and cleans the tmp', async () => {
    const path = join(cleanup[0] ?? '', 'bytes-fail.bin');
    const original = Buffer.from([9, 9, 9]);
    writeFileSync(path, original);
    renameSpy.mockRejectedValue(fsError('EPERM'));

    await expect(
      fsPort.writeBytesAtomic(path, new Uint8Array(Buffer.from([1, 2, 3]))),
    ).rejects.toThrow(/EPERM/);

    expect(Buffer.from(readFileSync(path)).equals(original)).toBe(true);
    expect(existsSync(legacyTmpOf(path))).toBe(false);
    expect(renameSpy.mock.calls.length).toBe(ATOMIC_REPLACE_MAX_RETRIES + 1);
    expect(renameTargets().every(([from]) => tmpPatternOf(path).test(from))).toBe(true);
    expect(rmTargets()).toEqual([renameTargets()[0]?.[0]]);
  });

  it('writeBytesAtomic: one transient failure then the real rename succeeds', async () => {
    const path = join(cleanup[0] ?? '', 'bytes-retry.bin');
    writeFileSync(path, Buffer.from([9, 9, 9]));
    const replacement = Buffer.from([4, 5, 6]);
    renameSpy.mockRejectedValueOnce(fsError('EPERM'));

    await fsPort.writeBytesAtomic(path, new Uint8Array(replacement));

    expect(Buffer.from(readFileSync(path)).equals(replacement)).toBe(true);
    expect(existsSync(legacyTmpOf(path))).toBe(false);
    expect(renameSpy.mock.calls.length).toBe(2);
    expect(rmTargets()).toEqual([]);
  });

  it('retry bound stays on the tens-of-milliseconds scale (D-145)', () => {
    expect(ATOMIC_REPLACE_MAX_RETRIES).toBeGreaterThan(0);
    expect(ATOMIC_REPLACE_MAX_RETRIES * ATOMIC_REPLACE_RETRY_DELAY_MS).toBeLessThan(1_000);
  });
});

describe('T2 · unique atomic-write tmp names · real filesystem (L2-local)', () => {
  it('10 concurrent writeTextAtomic calls to ONE target use pairwise-distinct tmp names', async () => {
    const path = join(cleanup[0] ?? '', 'text-concurrent.json');
    writeFileSync(path, 'old-config');
    const openSpy = vi.spyOn(fsPromises, 'open');
    const contents = Array.from({ length: 10 }, (_, i) => `content-${i}`);

    await Promise.all(contents.map((text) => fsPort.writeTextAtomic(path, text)));

    const tmpNames = openSpy.mock.calls.map((call) => call[0]);
    expect(tmpNames).toHaveLength(contents.length);
    // No two in-flight writes ever shared a scratch file.
    expect(new Set(tmpNames).size).toBe(tmpNames.length);
    for (const name of tmpNames) expect(name).toMatch(tmpPatternOf(path));
    // The target holds ONE of the written contents in full — never torn
    // bytes, never the pre-existing content.
    expect(contents).toContain(readFileSync(path, 'utf8'));
    // The legacy collision name never existed; no scratch outlives the writes.
    expect(existsSync(legacyTmpOf(path))).toBe(false);
    const leftovers = readdirSync(dirname(path))
      .filter((name) => name.startsWith(basename(path)));
    expect(leftovers).toEqual([basename(path)]);
  });

  it('10 concurrent writeBytesAtomic calls to ONE target also get distinct tmp names', async () => {
    const path = join(cleanup[0] ?? '', 'bytes-concurrent.bin');
    writeFileSync(path, Buffer.from([0]));
    const openSpy = vi.spyOn(fsPromises, 'open');
    const payloads = Array.from({ length: 10 }, (_, i) => new Uint8Array([i, i, i]));

    await Promise.all(payloads.map((data) => fsPort.writeBytesAtomic(path, data)));

    const tmpNames = openSpy.mock.calls.map((call) => call[0]);
    expect(new Set(tmpNames).size).toBe(tmpNames.length);
    for (const name of tmpNames) expect(name).toMatch(tmpPatternOf(path));
    const finalBytes = [...readFileSync(path)];
    const candidates = payloads.map((p) => [...p].join(','));
    expect(candidates).toContain(finalBytes.join(','));
  });

  it('a failure BEFORE the rename cleans up its own tmp and never touches the target', async () => {
    const path = join(cleanup[0] ?? '', 'text-writefail.json');
    writeFileSync(path, 'old-config');
    // Hand back a real handle whose writeFile rejects (simulated EIO mid-write).
    const openSpy = vi.spyOn(fsPromises, 'open');
    openSpy.mockImplementationOnce(async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await fsPromises.open(...args);
      return Object.assign(handle, {
        writeFile: async () => {
          throw Object.assign(new Error('EIO: simulated write failure'), { code: 'EIO' });
        },
      });
    });

    await expect(fsPort.writeTextAtomic(path, 'new-config')).rejects.toThrow(/EIO/);

    expect(readFileSync(path, 'utf8')).toBe('old-config');
    const ownTmp = openSpy.mock.calls[0]?.[0];
    expect(ownTmp).toMatch(tmpPatternOf(path));
    expect(existsSync(ownTmp as string)).toBe(false);
    expect(rmTargets()).toEqual([ownTmp]);
  });
});
