/** A-M2-22 · TaskStore snapshot persistence + crash recovery. */
/** T3 · structural validation: damaged records are isolated, not fatal. */
import { describe, it, expect } from 'vitest';
import {
  TaskStore, TaskQueue, HistoryStore, restoreTasks, countInterrupted,
  type IArtifactVerifier,
} from '@ytvdlt/core';
import type { DownloadEngine, TaskRecord, TaskSnapshot } from '@ytvdlt/shared';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');

const record = (id: string, state: TaskRecord['state'], lastPercent: number | null = null): TaskRecord => ({
  id, url: 'https://example.org/v', kind: 'video', state,
  createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
  mediaInfo: null, request: null, artifacts: [], lastPercent, error: null,
  privateMode: false, postprocessed: false,
});

const snapshot = (tasks: TaskRecord[]): TaskSnapshot => ({
  schemaVersion: 1, savedAt: '2026-11-05T00:00:00.000Z', tasks,
});

const setup = () => {
  const mem = createInMemoryPorts();
  return { mem, store: new TaskStore({ ports: mem.ports }) };
};

describe('A-M2-22 TaskStore · snapshot round-trip', () => {
  it('saves and loads a snapshot unchanged', async () => {
    const { store } = setup();
    await store.save(snapshot([record('t1', 'Completed')]));
    const loaded = await store.load();
    expect(loaded.tasks).toHaveLength(1);
    expect(loaded.tasks[0]?.state).toBe('Completed');
    expect(loaded.schemaVersion).toBe(1);
  });

  it('returns an empty snapshot when the file is missing or corrupt', async () => {
    const { mem, store } = setup();
    expect((await store.load()).tasks).toEqual([]);
    mem.state.files.set(`${mem.state.env.configDir}/tasks.json`, '{"tasks":"nope"}');
    expect((await store.load()).tasks).toEqual([]);
  });
});

describe('A-M2-22 · recovery on the recorded snapshot fixture', () => {
  it('Running→Canceled (42% kept) and FetchingInfo→Canceled from tasks-snapshot.json', async () => {
    const { mem, store } = setup();
    mem.state.files.set(`${mem.state.env.configDir}/tasks.json`, fixture('tasks-snapshot.json'));
    const loaded = await store.load();
    expect(loaded.tasks).toHaveLength(3);
    const recovered = store.recover(loaded);
    const byId = Object.fromEntries(recovered.tasks.map((t) => [t.id, t]));
    expect(byId['t1']?.state).toBe('Canceled');
    expect(byId['t1']?.lastPercent).toBe(42);
    expect(byId['t2']?.state).toBe('Canceled');
    expect(byId['t3']?.state).toBe('Completed');
  });
});

describe('A-M2-22 · recovery converts interrupted states to Canceled', () => {
  it('Running/FetchingInfo become Canceled while lastPercent is preserved', () => {
    const { store } = setup();
    const recovered = store.recover(snapshot([
      record('running', 'Running', 42),
      record('fetching', 'FetchingInfo', 7),
      record('done', 'Completed', 100),
      record('canceled', 'Canceled', 12),
      record('error', 'Error', null),
    ]));
    const byId = Object.fromEntries(recovered.tasks.map((t) => [t.id, t]));
    expect(byId['running']?.state).toBe('Canceled');
    expect(byId['running']?.lastPercent).toBe(42);
    expect(byId['fetching']?.state).toBe('Canceled');
    expect(byId['fetching']?.lastPercent).toBe(7);
    expect(byId['done']?.state).toBe('Completed');
    expect(byId['canceled']?.state).toBe('Canceled');
    expect(byId['error']?.state).toBe('Error');
    expect(recovered.savedAt).toBe('2026-11-05T00:00:00.000Z');
  });
});

// --- T3 · structural validation of snapshot records (isolate, never crash) ---

/** Minimal structurally-complete record shape for hand-built bad entries. */
const rawBase = {
  url: 'https://example.org/v', kind: 'video',
  createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
  mediaInfo: null, request: null, artifacts: [], lastPercent: null, error: null,
  privateMode: false, postprocessed: false,
};

/** Write a snapshot with arbitrary (possibly damaged) task entries. */
const writeRawTasks = (
  mem: ReturnType<typeof createInMemoryPorts>,
  tasks: unknown[],
): void => {
  mem.state.files.set(
    `${mem.state.env.configDir}/tasks.json`,
    JSON.stringify({ schemaVersion: 1, savedAt: '2026-11-05T00:00:00.000Z', tasks }),
  );
};

describe('T3 · load() isolates structurally invalid records', () => {
  it('a null entry is dropped and counted, recovery stays safe', async () => {
    const { mem, store } = setup();
    writeRawTasks(mem, [null]);
    const loaded = await store.load();
    expect(loaded.tasks).toEqual([]);
    expect(store.lastLoadSkippedCount).toBe(1);
    expect(() => store.recover(loaded)).not.toThrow();
    expect(store.recover(loaded).tasks).toEqual([]);
  });

  it('a record with a missing or non-enum state is dropped', async () => {
    const { mem, store } = setup();
    writeRawTasks(mem, [
      { ...rawBase, id: 'missing-state' },
      { ...rawBase, id: 'unknown-state', state: 'Queued' },
      { ...rawBase, id: 'numeric-state', state: 5 },
      { ...rawBase, id: 'ok', state: 'Completed' },
    ]);
    const loaded = await store.load();
    expect(loaded.tasks.map((t) => t.id)).toEqual(['ok']);
    expect(store.lastLoadSkippedCount).toBe(3);
  });

  it('a record whose artifacts is not an array is dropped', async () => {
    const { mem, store } = setup();
    writeRawTasks(mem, [
      { ...rawBase, id: 'string-artifacts', state: 'Completed', artifacts: 'C:/out/x.mp4' },
      { ...rawBase, id: 'number-artifacts', state: 'Completed', artifacts: 7 },
      { ...rawBase, id: 'object-artifacts', state: 'Completed', artifacts: { path: 'C:/x' } },
      { ...rawBase, id: 'ok', state: 'Completed', artifacts: ['C:/out/ok.mp4'] },
    ]);
    const loaded = await store.load();
    expect(loaded.tasks.map((t) => t.id)).toEqual(['ok']);
    expect(store.lastLoadSkippedCount).toBe(3);
  });

  it('a record without a usable id or url is dropped', async () => {
    const { mem, store } = setup();
    writeRawTasks(mem, [
      { ...rawBase, state: 'Completed' },
      { ...rawBase, id: '', state: 'Completed' },
      { ...rawBase, id: 42, state: 'Completed' },
      { id: 'no-url', state: 'Completed', artifacts: [] },
      { ...rawBase, id: 'ok', state: 'Idle' },
    ]);
    const loaded = await store.load();
    expect(loaded.tasks.map((t) => t.id)).toEqual(['ok']);
    expect(store.lastLoadSkippedCount).toBe(4);
  });

  it('an older record without artifacts stays valid (only a WRONG type isolates)', async () => {
    const { mem, store } = setup();
    writeRawTasks(mem, [{
      id: 'old', url: 'https://example.org/v', kind: 'video', state: 'Completed',
      createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
      mediaInfo: null, request: null, lastPercent: null, error: null,
      privateMode: false, postprocessed: false,
    }]);
    const loaded = await store.load();
    expect(loaded.tasks).toHaveLength(1);
    expect(store.lastLoadSkippedCount).toBe(0);
  });

  it('a valid snapshot reports zero skips and round-trips unchanged', async () => {
    const { mem, store } = setup();
    mem.state.files.set(`${mem.state.env.configDir}/tasks.json`, fixture('tasks-snapshot.json'));
    const loaded = await store.load();
    expect(loaded.tasks).toHaveLength(3);
    expect(store.lastLoadSkippedCount).toBe(0);
    expect(loaded.tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });
});

describe('T3 · mixed good/bad snapshot on the recovery path', () => {
  it('loadRecovered keeps and recovers the good records, skips the bad ones', async () => {
    const { mem, store } = setup();
    writeRawTasks(mem, [
      null,
      { ...rawBase, id: 'bad-state', state: 'QUEUED' },
      record('running', 'Running', 42),
      { ...record('done', 'Completed', 100), artifacts: 'oops' },
      record('fetching', 'FetchingInfo', 7),
    ]);
    const recovered = await store.loadRecovered();
    expect(store.lastLoadSkippedCount).toBe(3);
    expect(recovered.tasks.map((t) => t.id)).toEqual(['running', 'fetching']);
    expect(recovered.tasks.map((t) => t.state)).toEqual(['Canceled', 'Canceled']);
    expect(recovered.tasks[0]?.lastPercent).toBe(42);
    expect(recovered.tasks[1]?.lastPercent).toBe(7);
  });
});

describe('T3 · defence in depth for recover() and countInterrupted', () => {
  it('recover() filters invalid records instead of throwing', () => {
    const { store } = setup();
    const damaged = {
      schemaVersion: 1, savedAt: '2026-11-05T00:00:00.000Z',
      tasks: [null, record('good', 'Running', 42), 'junk', 5],
    } as unknown as TaskSnapshot;
    const recovered = store.recover(damaged);
    expect(recovered.tasks).toHaveLength(1);
    expect(recovered.tasks[0]?.id).toBe('good');
    expect(recovered.tasks[0]?.state).toBe('Canceled');
    expect(recovered.tasks[0]?.lastPercent).toBe(42);
  });

  it('recover() survives a snapshot without a tasks array', () => {
    const { store } = setup();
    expect(store.recover(null as unknown as TaskSnapshot).tasks).toEqual([]);
    expect(store.recover({} as unknown as TaskSnapshot).tasks).toEqual([]);
    expect(store.recover({ schemaVersion: 1, savedAt: 'x', tasks: 'nope' } as unknown as TaskSnapshot).tasks).toEqual([]);
  });

  it('countInterrupted skips garbage entries instead of throwing', () => {
    const damaged = {
      schemaVersion: 1, savedAt: 'x',
      tasks: [null, record('running', 'Running'), record('canceled', 'Canceled'), {}],
    } as unknown as TaskSnapshot;
    expect(countInterrupted(damaged)).toBe(1);
    expect(countInterrupted({ schemaVersion: 1, savedAt: 'x', tasks: [] })).toBe(0);
  });
});

// --- T2 · save() serialisation + lastSaveError (concurrent write race) ---

/** Which task ids one serialized write carried (for order assertions). */
const taskIdsOf = (text: string): string => {
  try {
    const parsed = JSON.parse(text) as { tasks?: Array<{ id?: string }> };
    return (parsed.tasks ?? []).map((t) => t.id ?? '?').join('+');
  } catch { return '?'; }
};

/**
 * Wrap the in-memory fs so tests can observe (a) the WRITE ORDER and (b) that
 * no two writes ever overlapped on disk — the L0 proof of "严格按调用顺序逐个
 * 落盘，不并发写盘".
 */
const instrumentWriteOrder = (mem: ReturnType<typeof createInMemoryPorts>) => {
  const order: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const inner = mem.ports.fs.writeTextAtomic.bind(mem.ports.fs);
  mem.ports.fs.writeTextAtomic = async (path: string, text: string): Promise<void> => {
    order.push(taskIdsOf(text));
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await inner(path, text);
    } finally {
      inFlight -= 1;
    }
  };
  return { order, maxConcurrentWrites: (): number => maxInFlight };
};

describe('T2 · save() serialisation', () => {
  it('10 concurrent saves all resolve; disk holds the LAST-enqueued snapshot, written in call order', async () => {
    const { mem, store } = setup();
    const { order, maxConcurrentWrites } = instrumentWriteOrder(mem);
    const snapshots = Array.from({ length: 10 }, (_, i) => snapshot([record(`t${i}`, 'Completed')]));

    await Promise.all(snapshots.map((s) => store.save(s)));

    // Every save resolved (Promise.all would have thrown otherwise).
    // Strictly sequential writes, strictly in call order: no interleaving.
    expect(maxConcurrentWrites()).toBe(1);
    expect(order).toEqual(Array.from({ length: 10 }, (_, i) => `t${i}`));
    // The final file content is the LAST snapshot that was queued.
    const loaded = await store.load();
    expect(loaded.tasks.map((t) => t.id)).toEqual(['t9']);
    expect(loaded.schemaVersion).toBe(1);
  });

  it('a failing fs keeps save() rejecting AND records lastSaveError; a later success clears it', async () => {
    const { mem, store } = setup();
    const inner = mem.ports.fs.writeTextAtomic.bind(mem.ports.fs);
    let fail = true;
    mem.ports.fs.writeTextAtomic = async (path: string, text: string): Promise<void> => {
      if (fail) throw new Error('EACCES: simulated snapshot write failure');
      await inner(path, text);
    };

    // External promise contract unchanged: the caller still sees the rejection.
    await expect(store.save(snapshot([record('t1', 'Completed')]))).rejects.toThrow(/EACCES/);
    expect(store.lastSaveError?.message).toContain('EACCES');

    fail = false;
    await store.save(snapshot([record('t2', 'Completed')]));
    expect(store.lastSaveError).toBeNull();
    expect((await store.load()).tasks.map((t) => t.id)).toEqual(['t2']);
  });

  it('a failed save does not poison the queue: later saves still land on disk', async () => {
    const { mem, store } = setup();
    const inner = mem.ports.fs.writeTextAtomic.bind(mem.ports.fs);
    let writes = 0;
    mem.ports.fs.writeTextAtomic = async (path: string, text: string): Promise<void> => {
      writes += 1;
      if (writes === 1) throw new Error('first write fails');
      await inner(path, text);
    };

    const outcomes = await Promise.all([
      store.save(snapshot([record('bad', 'Completed')])).then(() => 'resolved', () => 'rejected'),
      store.save(snapshot([record('good', 'Completed')])).then(() => 'resolved', () => 'rejected'),
    ]);
    expect(outcomes).toEqual(['rejected', 'resolved']);
    // The write queued after the failed one still executed, in order.
    expect((await store.load()).tasks.map((t) => t.id)).toEqual(['good']);
  });

  it('lastSaveError is null before any save happened', () => {
    const { store } = setup();
    expect(store.lastSaveError).toBeNull();
  });
});

describe('T3 · full boot path over a damaged snapshot', () => {
  /** Engine whose only job is to prove the boot never downloads. */
  const bootEngine: DownloadEngine = {
    async version() { return 'fake'; },
    async probe() { throw new Error('boot must not probe'); },
    async probePlaylist() { throw new Error('boot must not probe'); },
    download() { throw new Error('boot must not download'); },
    async selfUpdate() { return { fromVersion: '', toVersion: '', channel: 'stable', changed: false }; },
  };
  const bootVerifier: IArtifactVerifier = {
    async verify() { throw new Error('boot must not verify'); },
  };

  it('restoreTasks restores only the good records and reports the skipped count', async () => {
    const { mem, store } = setup();
    writeRawTasks(mem, [
      null,
      record('live', 'Running', 37),
      { ...record('broken', 'Completed'), artifacts: 7 },
    ]);
    const queue = new TaskQueue({
      ports: mem.ports,
      engine: bootEngine,
      verifier: bootVerifier,
      history: new HistoryStore({ ports: mem.ports }),
      taskStore: store,
      jsRuntimePath: 'C:/runtime/node.exe',
      persistIntervalMs: 0,
    });
    expect(await restoreTasks(queue, store)).toEqual({
      restored: 1, interrupted: 1, skipped: 0, empty: false,
      load: {
        status: 'invalid-records',
        skippedRecords: 2,
        backupPath: expect.stringContaining('tasks.corrupt-'),
        writeBlocked: false,
        error: '2 record(s) failed the structural guard',
      },
    });
    expect(store.lastLoadSkippedCount).toBe(2);
    expect(queue.get('live')?.state).toBe('Canceled');
    expect(queue.get('live')?.lastPercent).toBe(37);
    expect(queue.list()).toHaveLength(1);
  });
});

// --- D-159 · a damaged snapshot must stay recoverable -----------------------

type Mem = ReturnType<typeof createInMemoryPorts>;

interface DegradedWarning {
  level: string;
  scope: string;
  event: string;
  payload: {
    status: string;
    skippedRecords: number;
    backupPath: string | null;
    writeBlocked: boolean;
    repairedFields?: number;
    error: string | null;
  };
}

const SNAPSHOT = (mem: Mem): string => `${mem.state.env.configDir}/tasks.json`;

/** `writeBytesAtomic` keeps the real bytes in `state.bytes`; the text fallback writes `files`. */
const backupTextOf = (mem: Mem, path: string): string => {
  const bytes = mem.state.bytes.get(path);
  if (bytes !== undefined) return Buffer.from(bytes).toString('utf8');
  return mem.state.files.get(path) ?? '';
};

const backupKeys = (mem: Mem): string[] =>
  [...new Set([...mem.state.files.keys(), ...mem.state.bytes.keys()])]
    .filter((key) => key.includes('.corrupt-'));

const degradedWarnings = (mem: Mem): DegradedWarning[] =>
  mem.state.logLines
    .map((line): DegradedWarning | null => {
      try { return JSON.parse(line) as DegradedWarning; } catch { return null; }
    })
    .filter((line): line is DegradedWarning => line !== null && line.event === 'snapshot.load.degraded');

const D159_ENGINE: DownloadEngine = {
  async version() { return 'fake'; },
  async probe() { throw new Error('boot must not probe'); },
  async probePlaylist() { throw new Error('boot must not probe'); },
  download() { throw new Error('boot must not download'); },
  async selfUpdate() { return { fromVersion: '', toVersion: '', channel: 'stable', changed: false }; },
};

const D159_VERIFIER: IArtifactVerifier = {
  async verify() { throw new Error('boot must not verify'); },
};

/** A real `TaskQueue` wired to the real store — the production boot chain. */
const bootQueue = (mem: Mem, store: Parameters<typeof restoreTasks>[1]): TaskQueue => new TaskQueue({
  ports: mem.ports,
  engine: D159_ENGINE,
  verifier: D159_VERIFIER,
  history: new HistoryStore({ ports: mem.ports }),
  taskStore: store,
  jsRuntimePath: 'C:/runtime/node.exe',
  persistIntervalMs: 0,
});

const TRUNCATED_JSON = '{"schemaVersion":1,"savedAt":"2026-11-05T00:00:00.000Z","tasks":[{"id":"t1"';

describe('D-159 · load() classifies failures and protects the original', () => {
  it('missing file → healthy "missing", no warning, no backup', async () => {
    const { mem, store } = setup();
    expect((await store.load()).tasks).toEqual([]);
    expect(store.lastLoadDiagnostic).toEqual({
      status: 'missing', skippedRecords: 0, backupPath: null, writeBlocked: false, error: null,
    });
    expect(degradedWarnings(mem)).toHaveLength(0);
    expect(backupKeys(mem)).toHaveLength(0);
  });

  it('valid snapshot → healthy "ok", save() unaffected', async () => {
    const { mem, store } = setup();
    mem.state.files.set(SNAPSHOT(mem), JSON.stringify(snapshot([record('t1', 'Completed')])));
    expect((await store.load()).tasks).toHaveLength(1);
    expect(store.lastLoadDiagnostic.status).toBe('ok');
    expect(degradedWarnings(mem)).toHaveLength(0);
    expect(backupKeys(mem)).toHaveLength(0);
    await store.save(snapshot([record('t2', 'Completed')]));
    expect(store.lastSaveError).toBeNull();
  });

  it('corrupt JSON → byte-for-byte backup of the ORIGINAL text + WARNING', async () => {
    const { mem, store } = setup();
    mem.state.files.set(SNAPSHOT(mem), TRUNCATED_JSON);
    expect((await store.load()).tasks).toEqual([]);

    const diagnostic = store.lastLoadDiagnostic;
    expect(diagnostic.status).toBe('corrupt');
    expect(diagnostic.writeBlocked).toBe(false);
    expect(diagnostic.backupPath).toMatch(/tasks\.corrupt-/);
    // The exact damaged bytes are still retrievable — nothing was re-serialised.
    expect(backupTextOf(mem, diagnostic.backupPath ?? '')).toBe(TRUNCATED_JSON);
    expect(mem.state.files.get(SNAPSHOT(mem))).toBe(TRUNCATED_JSON);

    const warnings = degradedWarnings(mem);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.level).toBe('WARNING');
    expect(warnings[0]?.scope).toBe('task-store');
    expect(warnings[0]?.payload).toEqual({
      status: 'corrupt',
      skippedRecords: 0,
      backupPath: diagnostic.backupPath,
      writeBlocked: false,
      error: expect.any(String),
    });
  });

  it('a broken top-level shape (tasks is not an array) is also corrupt + backed up', async () => {
    const { mem, store } = setup();
    const damaged = '{"schemaVersion":1,"tasks":"nope"}';
    mem.state.files.set(SNAPSHOT(mem), damaged);
    expect((await store.load()).tasks).toEqual([]);
    expect(store.lastLoadDiagnostic.status).toBe('corrupt');
    expect(backupTextOf(mem, store.lastLoadDiagnostic.backupPath ?? '')).toBe(damaged);
  });

  it('a null root and a non-Error throw are both handled without crashing the boot', async () => {
    const { mem, store } = setup();
    mem.state.files.set(SNAPSHOT(mem), 'null');
    expect((await store.load()).tasks).toEqual([]);
    expect(store.lastLoadDiagnostic.status).toBe('corrupt');

    const second = setup();
    second.mem.ports.fs.readText = async () => { throw 'locked by another process'; };
    expect((await second.store.load()).tasks).toEqual([]);
    expect(second.store.lastLoadDiagnostic.status).toBe('read-error');
    expect(second.store.lastLoadDiagnostic.error).toBe('locked by another process');
  });

  it('isolated records are backed up BEFORE the filtered snapshot can be written', async () => {
    const { mem, store } = setup();
    const damaged = JSON.stringify({
      schemaVersion: 1, savedAt: '2026-11-05T00:00:00.000Z',
      tasks: [null, { ...rawBase, id: 'bad', state: 'QUEUED' }, record('good', 'Completed')],
    });
    mem.state.files.set(SNAPSHOT(mem), damaged);
    const loaded = await store.load();

    expect(loaded.tasks.map((t) => t.id)).toEqual(['good']);
    expect(store.lastLoadSkippedCount).toBe(2);
    const diagnostic = store.lastLoadDiagnostic;
    expect(diagnostic.status).toBe('invalid-records');
    expect(diagnostic.skippedRecords).toBe(2);
    expect(diagnostic.writeBlocked).toBe(false);
    // The dropped bad records are still recoverable from the untouched copy.
    expect(backupTextOf(mem, diagnostic.backupPath ?? '')).toBe(damaged);
    expect(degradedWarnings(mem)[0]?.payload.skippedRecords).toBe(2);
  });

  it('a non-ENOENT read failure blocks EVERY later save; the original stays untouched', async () => {
    const { mem, store } = setup();
    mem.state.files.set(SNAPSHOT(mem), TRUNCATED_JSON);
    mem.ports.fs.readText = async () => { throw new Error('EACCES: simulated read failure'); };

    expect((await store.load()).tasks).toEqual([]);
    const diagnostic = store.lastLoadDiagnostic;
    expect(diagnostic.status).toBe('read-error');
    expect(diagnostic.writeBlocked).toBe(true);
    expect(diagnostic.backupPath).toBeNull();
    expect(diagnostic.error).toContain('EACCES');
    expect(degradedWarnings(mem)[0]?.payload.writeBlocked).toBe(true);

    await expect(store.save(snapshot([record('new', 'Completed')]))).rejects.toThrow(/SNAPSHOT_WRITE_BLOCKED/);
    expect(store.lastSaveError?.message).toContain('SNAPSHOT_WRITE_BLOCKED');
    expect(mem.state.files.get(SNAPSHOT(mem))).toBe(TRUNCATED_JSON);
  });

  it('a Node-style ENOENT (code) is a first run, not a read failure', async () => {
    const { mem, store } = setup();
    mem.ports.fs.readText = async () => {
      const error = new Error('ENOENT: no such file or directory') as Error & { code: string };
      error.code = 'ENOENT';
      throw error;
    };
    expect((await store.load()).tasks).toEqual([]);
    expect(store.lastLoadDiagnostic.status).toBe('missing');
    expect(store.lastLoadDiagnostic.writeBlocked).toBe(false);
    expect(degradedWarnings(mem)).toHaveLength(0);
  });

  it('a failed backup (no bytes, no text) blocks writes and keeps the original', async () => {
    const { mem, store } = setup();
    mem.state.files.set(SNAPSHOT(mem), TRUNCATED_JSON);
    mem.ports.fs.readBytes = async () => { throw new Error('readBytes unavailable'); };
    mem.ports.fs.writeBytesAtomic = async () => { throw new Error('ENOSPC'); };
    mem.ports.fs.writeTextAtomic = async () => { throw new Error('ENOSPC'); };

    expect((await store.load()).tasks).toEqual([]);
    expect(store.lastLoadDiagnostic.status).toBe('corrupt');
    expect(store.lastLoadDiagnostic.backupPath).toBeNull();
    expect(store.lastLoadDiagnostic.writeBlocked).toBe(true);
    await expect(store.save(snapshot([]))).rejects.toThrow(/SNAPSHOT_WRITE_BLOCKED/);
    expect(mem.state.files.get(SNAPSHOT(mem))).toBe(TRUNCATED_JSON);
  });

  it('an exhausted backup-name allocator also blocks writes', async () => {
    const { mem, store } = setup();
    mem.state.files.set(SNAPSHOT(mem), TRUNCATED_JSON);
    mem.ports.fs.exists = async () => true;
    expect((await store.load()).tasks).toEqual([]);
    expect(store.lastLoadDiagnostic.writeBlocked).toBe(true);
  });

  it('two loads in the same clock tick produce two distinct backups', async () => {
    const { mem, store } = setup();
    mem.state.files.set(SNAPSHOT(mem), TRUNCATED_JSON);
    await store.load();
    await store.load();
    const keys = backupKeys(mem);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[1]).toMatch(/-2\.json$/);
    expect(backupTextOf(mem, keys[0] ?? '')).toBe(TRUNCATED_JSON);
    expect(backupTextOf(mem, keys[1] ?? '')).toBe(TRUNCATED_JSON);
  });

  it('once a backup succeeds, save() works again (the guard is not sticky)', async () => {
    const { mem, store } = setup();
    mem.state.files.set(SNAPSHOT(mem), TRUNCATED_JSON);
    await store.load();
    expect(store.lastLoadDiagnostic.writeBlocked).toBe(false);
    await store.save(snapshot([record('after', 'Completed')]));
    expect((await store.load()).tasks.map((t) => t.id)).toEqual(['after']);
    expect(store.lastLoadDiagnostic.status).toBe('ok');
  });

  it('a dead log sink cannot break load()', async () => {
    const { mem, store } = setup();
    mem.state.files.set(SNAPSHOT(mem), TRUNCATED_JSON);
    mem.ports.logSink.appendJsonl = async () => { throw new Error('log sink down'); };
    expect((await store.load()).tasks).toEqual([]);
    expect(store.lastLoadDiagnostic.status).toBe('corrupt');
    expect(store.lastLoadDiagnostic.backupPath).not.toBeNull();
  });
});

describe('D-159 · full boot chain over a damaged snapshot', () => {
  it('corrupt JSON → restoreTasks() keeps the original bytes retrievable', async () => {
    const { mem, store } = setup();
    mem.state.files.set(SNAPSHOT(mem), TRUNCATED_JSON);
    const result = await restoreTasks(bootQueue(mem, store), store);

    expect(result.restored).toBe(0);
    expect(result.empty).toBe(true);
    expect(result.load.status).toBe('corrupt');
    expect(result.load.writeBlocked).toBe(false);
    // The boot wrote an empty snapshot back, but ONLY after a verified copy.
    expect(JSON.parse(mem.state.files.get(SNAPSHOT(mem)) ?? '{}').tasks).toEqual([]);
    expect(backupTextOf(mem, result.load.backupPath ?? '')).toBe(TRUNCATED_JSON);
  });

  it('invalid records → the boot report carries skippedRecords and the backup keeps them', async () => {
    const { mem, store } = setup();
    const damaged = JSON.stringify({
      schemaVersion: 1, savedAt: '2026-11-05T00:00:00.000Z',
      tasks: [null, record('good', 'Running', 33)],
    });
    mem.state.files.set(SNAPSHOT(mem), damaged);
    const result = await restoreTasks(bootQueue(mem, store), store);

    expect(result.restored).toBe(1);
    expect(result.load.status).toBe('invalid-records');
    expect(result.load.skippedRecords).toBe(1);
    expect(backupTextOf(mem, result.load.backupPath ?? '')).toBe(damaged);
    const persisted = JSON.parse(mem.state.files.get(SNAPSHOT(mem)) ?? '{}') as TaskSnapshot;
    expect(persisted.tasks.map((t) => t.id)).toEqual(['good']);
    expect(persisted.tasks[0]?.state).toBe('Canceled');
    expect(degradedWarnings(mem)[0]?.payload.skippedRecords).toBe(1);
  });

  it('read error → restoreTasks() does NOT overwrite tasks.json at all', async () => {
    const { mem, store } = setup();
    mem.state.files.set(SNAPSHOT(mem), TRUNCATED_JSON);
    mem.ports.fs.readText = async () => { throw new Error('EBUSY: file locked'); };

    const result = await restoreTasks(bootQueue(mem, store), store);
    expect(result.restored).toBe(0);
    expect(result.load.status).toBe('read-error');
    expect(result.load.writeBlocked).toBe(true);
    // queue.restore() still called persistSnapshot(); the store refused it.
    expect(mem.state.files.get(SNAPSHOT(mem))).toBe(TRUNCATED_JSON);
    expect(store.lastSaveError?.message).toContain('SNAPSHOT_WRITE_BLOCKED');
  });

  it('backup failure → restoreTasks() does NOT overwrite tasks.json at all', async () => {
    const { mem, store } = setup();
    mem.state.files.set(SNAPSHOT(mem), TRUNCATED_JSON);
    mem.ports.fs.readBytes = async () => { throw new Error('readBytes unavailable'); };
    mem.ports.fs.writeBytesAtomic = async () => { throw new Error('ENOSPC'); };
    mem.ports.fs.writeTextAtomic = async () => { throw new Error('ENOSPC'); };

    const result = await restoreTasks(bootQueue(mem, store), store);
    expect(result.load.status).toBe('corrupt');
    expect(result.load.writeBlocked).toBe(true);
    expect(mem.state.files.get(SNAPSHOT(mem))).toBe(TRUNCATED_JSON);
  });

  it('a legacy store without diagnostics reports "unknown", never a false "ok"', async () => {
    const { mem } = setup();
    const legacy = {
      async load(): Promise<TaskSnapshot> { return snapshot([record('legacy', 'Idle')]); },
      async save(): Promise<void> { /* legacy no-op */ },
      recover(raw: TaskSnapshot): TaskSnapshot { return raw; },
    };
    const result = await restoreTasks(bootQueue(mem, legacy), legacy);
    expect(result.restored).toBe(1);
    expect(result.load.status).toBe('unknown');
  });
});

// --- D-161 · deep (but non-destructive) validation of nested fields ---------

/** A structurally valid record with one or more nested fields deliberately broken. */
const damagedRecord = (patch: Record<string, unknown>): Record<string, unknown> => ({
  ...(record('t1', 'Completed') as unknown as Record<string, unknown>),
  ...patch,
});

describe('D-161 · key nested fields are validated at load time', () => {
  it('bad artifacts entries are dropped, the TASK itself survives, repairs are counted', async () => {
    const { mem, store } = setup();
    writeRawTasks(mem, [damagedRecord({ artifacts: ['C:/ok.mp4', null, 7, '', { path: 'x' }] })]);
    const loaded = await store.load();
    expect(loaded.tasks).toHaveLength(1);
    expect(loaded.tasks[0]?.artifacts).toEqual(['C:/ok.mp4']);
    expect(store.lastLoadSkippedCount).toBe(0);
    expect(store.lastLoadRepairedCount).toBe(4);
    expect(store.lastLoadDiagnostic.status).toBe('repaired-fields');
    expect(store.lastLoadDiagnostic.repairedFields).toBe(4);
  });

  it('kind / timestamps / progress numbers / booleans are normalised to safe values', async () => {
    const { mem, store } = setup();
    writeRawTasks(mem, [damagedRecord({
      kind: 'movie', createdAt: 42, updatedAt: null,
      lastPercent: '37%', lastDownloadedBytes: '12', lastSpeedBps: {},
      privateMode: 'yes', postprocessed: 1,
    })]);
    const task = (await store.load()).tasks[0];
    expect(task?.kind).toBe('video');
    expect(task?.createdAt).toBe(mem.state.nowIso);
    expect(task?.updatedAt).toBe(mem.state.nowIso);
    expect(task?.lastPercent).toBeNull();
    expect(task?.lastDownloadedBytes).toBeNull();
    expect(task?.lastSpeedBps).toBeNull();
    expect(task?.privateMode).toBe(false);
    expect(task?.postprocessed).toBe(false);
    expect(store.lastLoadRepairedCount).toBe(8);
    expect(store.lastLoadSkippedCount).toBe(0);
  });

  it('mediaInfo: a non-object becomes null; a broken object has its key fields filled', async () => {
    const { mem, store } = setup();
    writeRawTasks(mem, [damagedRecord({ mediaInfo: 'not an object' })]);
    expect((await store.load()).tasks[0]?.mediaInfo).toBeNull();
    expect(store.lastLoadRepairedCount).toBe(1);

    const second = setup();
    writeRawTasks(second.mem, [damagedRecord({
      mediaInfo: { id: 7, title: null, formats: 'nope' },
    })]);
    const media = (await second.store.load()).tasks[0]?.mediaInfo;
    expect(media?.id).toBe('t1');
    expect(media?.title).toBe('t1');
    expect(media?.formats).toEqual([]);
    expect(second.store.lastLoadRepairedCount).toBe(3);
  });

  it('D-195 · request 结构非法 → 置 null 且产物路径一并清除；合法 request 的 artifacts 保留', async () => {
    const { mem, store } = setup();
    writeRawTasks(mem, [damagedRecord({
      request: { format: {}, subtitle: {}, paths: {}, network: {}, advanced: 'bad' },
      artifacts: ['C:/Windows/evil.mp4'],
    })]);
    const loaded = await store.load();
    expect(loaded.tasks[0]?.request).toBeNull();
    // 在线审计 P2：清洗后不能留下无归属路径，否则动作层会按 legacy 放行。
    expect(loaded.tasks[0]?.artifacts).toEqual([]);
    expect(loaded.tasks[0]?.id).toBe('t1'); // 任务本身保留
    expect(store.lastLoadRepairedCount).toBe(1); // 一次 fix，D-161 诊断契约不变

    const sound = { format: {}, subtitle: {}, paths: {}, network: {}, advanced: {} };
    const second = setup();
    writeRawTasks(second.mem, [damagedRecord({ request: sound, artifacts: ['C:/Videos/a.mp4'] })]);
    const soundLoaded = await second.store.load();
    expect(soundLoaded.tasks[0]?.request).toBeTruthy();
    expect(soundLoaded.tasks[0]?.artifacts).toEqual(['C:/Videos/a.mp4']);
    expect(second.store.lastLoadRepairedCount).toBe(0);
  });

  it('error: a non-AppError object becomes null; a valid AppError is preserved', async () => {
    const { mem, store } = setup();
    writeRawTasks(mem, [damagedRecord({ error: { code: 42, message: null } })]);
    expect((await store.load()).tasks[0]?.error).toBeNull();

    const second = setup();
    const error = { code: 'E', message: 'm', detail: '', retryable: true, report: '' };
    writeRawTasks(second.mem, [damagedRecord({ error })]);
    expect((await second.store.load()).tasks[0]?.error).toBeTruthy();
    expect(second.store.lastLoadRepairedCount).toBe(0);
  });

  it('subtitleFiles: wrong type and bad elements are cleaned without losing the task', async () => {
    const { mem, store } = setup();
    writeRawTasks(mem, [damagedRecord({ subtitleFiles: [{ path: 'C:/a.srt' }, null, 5] })]);
    expect((await store.load()).tasks[0]?.subtitleFiles).toHaveLength(1);
    expect(store.lastLoadRepairedCount).toBe(2);

    const second = setup();
    writeRawTasks(second.mem, [damagedRecord({ subtitleFiles: 'not an array' })]);
    expect((await second.store.load()).tasks[0]?.subtitleFiles).toEqual([]);
    expect(second.store.lastLoadRepairedCount).toBe(1);
  });

  it('a healthy snapshot is NOT copied: recover() keeps the original object reference', () => {
    const { store } = setup();
    const good = record('t1', 'Completed');
    const recovered = store.recover(snapshot([good]));
    expect(recovered.tasks[0]).toBe(good);
  });

  it('recover() also repairs hand-built snapshots (defence in depth)', () => {
    const { store } = setup();
    const damaged = {
      schemaVersion: 1, savedAt: 'x', tasks: [damagedRecord({ kind: 'bogus' })],
    } as unknown as TaskSnapshot;
    expect(store.recover(damaged).tasks[0]?.kind).toBe('video');
  });

  it('isolation takes precedence over repair, and BOTH counts reach the report', async () => {
    const { mem, store } = setup();
    writeRawTasks(mem, [null, damagedRecord({ kind: 'bogus' })]);
    expect((await store.load()).tasks).toHaveLength(1);
    expect(store.lastLoadSkippedCount).toBe(1);
    expect(store.lastLoadRepairedCount).toBe(1);
    expect(store.lastLoadDiagnostic.status).toBe('invalid-records');
    expect(store.lastLoadDiagnostic.skippedRecords).toBe(1);
    expect(store.lastLoadDiagnostic.repairedFields).toBe(1);
  });

  it('a repair backs up the original bytes and reports repairedFields through the boot chain', async () => {
    const { mem, store } = setup();
    const damaged = JSON.stringify({
      schemaVersion: 1, savedAt: '2026-11-05T00:00:00.000Z',
      tasks: [damagedRecord({ kind: 'bogus', artifacts: [null] })],
    });
    mem.state.files.set(SNAPSHOT(mem), damaged);

    const result = await restoreTasks(bootQueue(mem, store), store);
    expect(result.load.status).toBe('repaired-fields');
    expect(result.load.repairedFields).toBe(2);
    expect(result.load.writeBlocked).toBe(false);
    expect(backupTextOf(mem, result.load.backupPath ?? '')).toBe(damaged);
    expect(degradedWarnings(mem)[0]?.payload.repairedFields).toBe(2);

    const persisted = JSON.parse(mem.state.files.get(SNAPSHOT(mem)) ?? '{}') as TaskSnapshot;
    expect(persisted.tasks[0]?.kind).toBe('video');
    expect(persisted.tasks[0]?.artifacts).toEqual([]);
  });
});
