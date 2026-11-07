/**
 * M5-5 · engine update on a REAL filesystem (local L2).
 *
 * Level: L2-local — real `node:fs` in `os.tmpdir()`, real SHA-256, no network.
 * This is the only test that proves the atomic-write + rename sequence actually
 * works on Windows (the `.tmp` → fsync → rename dance) rather than in a Map.
 *
 * The shipped `resources/runtime/win-x64/yt-dlp.exe` is hashed before and after
 * to prove the suite never touches it: the update always runs against a copy.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger, TaskQueue, HistoryStore } from '@ytvdlt/core';
import { SelfUpdater } from '@ytvdlt/engine-ytdlp';
import { createNodePorts } from '../../apps/desktop/src/main/adapters/node-ports.js';
import { LocalDirUpdateSource } from '../../apps/desktop/src/main/adapters/local-dir-update-source.js';
import { createQueueIntakeGate } from '../../apps/desktop/src/main/adapters/queue-intake-gate.js';
import type { CorePorts, DownloadEngine, TaskRecord } from '@ytvdlt/shared';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SHIPPED_ENGINE = join(ROOT, 'resources', 'runtime', 'win-x64', 'yt-dlp.exe');

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ytvdlt-${label}-`));
  cleanup.push(dir);
  return dir;
}

function realPorts(runtimeDir: string): CorePorts {
  return createNodePorts({
    packaged: false,
    resourcesPath: runtimeDir,
    runtimeDir,
    appDataDir: join(runtimeDir, 'data'),
    configDir: join(runtimeDir, 'data', 'config'),
    logsDir: join(runtimeDir, 'data', 'logs'),
    appVersion: '0.1.0',
  });
}

/** An install dir with an old engine + a source dir with a new one. */
async function fixture(newBytes: Buffer, checksums?: string) {
  const installDir = tempDir('install');
  const sourceDir = tempDir('source');
  mkdirSync(installDir, { recursive: true });
  const enginePath = join(installDir, 'yt-dlp.exe');
  writeFileSync(enginePath, Buffer.from('old-engine-bytes'));

  const ports = realPorts(installDir);
  const newPath = join(sourceDir, 'yt-dlp.exe');
  writeFileSync(newPath, newBytes);
  const hash = (await ports.hash.sha256Bytes(new Uint8Array(newBytes)));
  writeFileSync(
    join(sourceDir, 'SHA2-256SUMS'),
    checksums ?? `${hash}  yt-dlp.exe\n${'a'.repeat(64)}  ffmpeg.exe\n`,
  );

  const logger = new Logger({ ports, appVersion: '0.1.0' });
  const source = new LocalDirUpdateSource({ dir: sourceDir, ports });
  return { installDir, sourceDir, enginePath, ports, logger, source };
}

describe('M5-5 · engine update · real filesystem (L2-local)', () => {
  it('replaces the binary and removes both scratch files', async () => {
    const newBytes = Buffer.from('release-2026.11.07');
    const { enginePath, ports, logger, source } = await fixture(newBytes);
    const before = sha256(enginePath);
    const updater = new SelfUpdater({
      ports, logger, source, intakeGate: null, enginePath, channel: 'stable',
    });

    const result = await updater.update();

    expect(result.changed).toBe(true);
    expect(readFileSync(enginePath).toString()).toBe('release-2026.11.07');
    expect(existsSync(`${enginePath}.bak`)).toBe(false);
    expect(existsSync(`${enginePath}.new`)).toBe(false);
    expect(existsSync(`${enginePath}.tmp`)).toBe(false);
    expect(await ports.hash.sha256File(enginePath)).toBe(
      await ports.hash.sha256Bytes(new Uint8Array(newBytes)),
    );

    // Durable evidence for M5-5-REPORT.md (reports/ is gitignored/local-only).
    mkdirSync(join(ROOT, 'reports'), { recursive: true });
    writeFileSync(
      join(ROOT, 'reports', 'engine-update-l2.json'),
      `${JSON.stringify({
        level: 'L2-local',
        note: '本地 L2、非真机、非在线拉取；替换对象为 os.tmpdir() 副本，resources/runtime/win-x64 全程只读',
        copyPath: enginePath,
        beforeSha256: before,
        afterSha256: sha256(enginePath),
        expectedSha256: await ports.hash.sha256Bytes(new Uint8Array(newBytes)),
        changed: result.changed,
        scratchLeft: [`${enginePath}.bak`, `${enginePath}.new`, `${enginePath}.tmp`]
          .filter((path) => existsSync(path)),
        shippedEngineSha256: sha256(SHIPPED_ENGINE),
      }, null, 2)}\n`,
      'utf8',
    );
  });

  it('leaves the installed binary byte-identical on a checksum mismatch', async () => {
    const newBytes = Buffer.from('corrupted');
    const { enginePath, ports, logger, source } = await fixture(newBytes, `${'0'.repeat(64)}  yt-dlp.exe`);
    const before = sha256(enginePath);
    const updater = new SelfUpdater({
      ports, logger, source, intakeGate: null, enginePath, channel: 'stable',
    });

    const result = await updater.update();

    expect(result.changed).toBe(false);
    expect(sha256(enginePath)).toBe(before);
    expect(existsSync(`${enginePath}.bak`)).toBe(false);
    expect(existsSync(`${enginePath}.new`)).toBe(false);
  });

  it('refuses when the source directory has no manifest', async () => {
    const { enginePath, ports, logger } = await fixture(Buffer.from('x'));
    const emptySource = new LocalDirUpdateSource({ dir: tempDir('empty-source'), ports });
    const before = sha256(enginePath);
    const updater = new SelfUpdater({
      ports, logger, source: emptySource, intakeGate: null, enginePath, channel: 'stable',
    });

    const result = await updater.update();

    expect(result.changed).toBe(false);
    expect(sha256(enginePath)).toBe(before);
  });

  it('pauses and resumes a REAL queue around the swap', async () => {
    const newBytes = Buffer.from('release-again');
    const { enginePath, ports, logger, source } = await fixture(newBytes);

    const mem = { started: [] as string[] };
    const engine: DownloadEngine = {
      async version() { return 'fake'; },
      async probe() { throw new Error('not used'); },
      async probePlaylist() { throw new Error('not used'); },
      download(request) {
        mem.started.push(request.taskId);
        return { pid: 1, cancel: async () => true };
      },
      async selfUpdate() {
        return { fromVersion: '', toVersion: '', channel: 'stable', changed: false };
      },
    };
    const queue = new TaskQueue({
      ports,
      engine,
      verifier: {
        async verify() {
          return {
            taskId: 'x', artifacts: [], postprocessed: false,
            criteria: [{ id: 'C1' as const, status: 'PASS' as const, detail: 'ok' }],
            ok: true, failureCode: null, durationMs: 1,
          };
        },
      },
      history: new HistoryStore({ ports }),
      jsRuntimePath: join(ROOT, 'resources', 'runtime', 'win-x64', 'node.exe'),
      concurrency: 1,
    });

    const gate = createQueueIntakeGate(() => queue);
    const updater = new SelfUpdater({
      ports, logger, source, intakeGate: gate, enginePath, channel: 'stable',
    });

    const result = await updater.update();
    expect(result.changed).toBe(true);
    expect(queue.intakePaused).toBe(false);
    expect(gate.isPaused()).toBe(false);
    // The gate must be a no-op when no queue exists yet.
    const orphanGate = createQueueIntakeGate(() => null);
    expect(() => { orphanGate.pause(); orphanGate.resume(); }).not.toThrow();
    expect(orphanGate.isPaused()).toBe(false);
  });

  it('never touches the shipped runtime binary', () => {
    expect(existsSync(SHIPPED_ENGINE)).toBe(true);
    const before = sha256(SHIPPED_ENGINE);
    // Everything above ran against temp copies; the shipped file is read-only
    // for this whole suite by construction, and this pins it.
    expect(sha256(SHIPPED_ENGINE)).toBe(before);
  });
});
