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
    });
    expect(store.lastLoadSkippedCount).toBe(2);
    expect(queue.get('live')?.state).toBe('Canceled');
    expect(queue.get('live')?.lastPercent).toBe(37);
    expect(queue.list()).toHaveLength(1);
  });
});
