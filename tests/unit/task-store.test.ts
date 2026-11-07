/** A-M2-22 · TaskStore snapshot persistence + crash recovery. */
import { describe, it, expect } from 'vitest';
import { TaskStore } from '@ytvdlt/core';
import type { TaskRecord, TaskSnapshot } from '@ytvdlt/shared';
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
