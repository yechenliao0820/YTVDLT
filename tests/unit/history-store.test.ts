/**
 * A-4.4-08 / A-4.4-22 / A-M2-20 / A-M2-21 · HistoryStore.
 */
import { describe, it, expect } from 'vitest';
import { HistoryStore, normalizePath, dedupeKey, matchEntry, applyQuery } from '@ytvdlt/core';
import type { HistoryEntry } from '@ytvdlt/shared';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');

const entry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: 'h1', taskId: 't1', url: 'https://example.org/v', title: 'Alpha Video',
  uploader: 'Chan', durationSec: 10, videoPath: 'C:/out/Alpha [id].mp4',
  audioPath: null, thumbnailPath: null, subtitlePaths: [], sizeBytes: 100,
  extractorKey: 'generic', downloadType: 'video', formatId: null,
  createdAt: '2026-11-05T00:00:00.000Z', completedAt: '2026-11-05T00:00:01.000Z',
  ...overrides,
});

const setup = () => {
  const mem = createInMemoryPorts();
  return { mem, store: new HistoryStore({ ports: mem.ports }) };
};

describe('path normalization (R12)', () => {
  it('unifies separators, drive-letter case and trailing slashes', () => {
    const forms = [
      'C:\\out\\Alpha.mp4', 'c:/out/Alpha.mp4', 'C:/out/Alpha.mp4',
      'C:\\OUT\\Alpha.mp4\\', 'c:\\out\\\\Alpha.mp4',
    ];
    const keys = forms.map(normalizePath);
    // Windows paths are case-insensitive, so all spellings collapse to ONE key.
    expect(new Set(keys).size).toBe(1);
    expect(normalizePath('C:\\out\\Alpha.mp4')).toBe('c:/out/alpha.mp4');
    expect(dedupeKey({ videoPath: 'C:\\out\\Alpha.mp4' })).toBe('c:/out/alpha.mp4');
  });
});

describe('A-M2-20 · dedupe by videoPath', () => {
  it('adds once and reports duplicate on a second add with a different path spelling', async () => {
    const { store } = setup();
    const first = await store.add(entry());
    expect(first.added).toBe(true);

    const second = await store.add(entry({ id: 'h2', videoPath: 'c:/OUT/Alpha [id].mp4'.replace('OUT', 'out') }));
    expect(second.added).toBe(false);
    if (second.added === false && second.reason === 'duplicate') {
      expect(second.existing.id).toBe('h1');
    } else {
      expect.unreachable('expected duplicate');
    }
    expect(await store.query({})).toHaveLength(1);
  });

  it('persists across a fresh instance (atomic write)', async () => {
    const { mem, store } = setup();
    await store.add(entry());
    const reopened = new HistoryStore({ ports: mem.ports });
    expect(await reopened.query({})).toHaveLength(1);
  });

  it('starts empty when the history file is corrupt (never throws)', async () => {
    const { mem } = setup();
    mem.state.files.set(`${mem.state.env.configDir}/history.json`, '{not json');
    const store = new HistoryStore({ ports: mem.ports });
    expect(await store.query({})).toEqual([]);
  });
});

describe('A-4.4-22 · private mode never writes', () => {
  it('returns private-mode and leaves the store empty', async () => {
    const { store } = setup();
    const result = await store.add(entry(), { privateMode: true });
    expect(result).toEqual({ added: false, reason: 'private-mode' });
    expect(await store.query({})).toHaveLength(0);
  });
});

describe('A-4.4-08 · query / search / filter', () => {
  it('matches title, uploader and path case-insensitively', async () => {
    const { store } = setup();
    await store.add(entry({ id: 'a', title: 'Alpha Video', videoPath: 'C:/out/alpha.mp4' }));
    await store.add(entry({ id: 'b', title: 'Beta', uploader: 'Other', videoPath: 'C:/out/beta.mp4' }));
    await store.add(entry({ id: 'c', title: 'Gamma', videoPath: 'C:/music/gamma.m4a', downloadType: 'audio' }));

    expect((await store.query({ text: 'alpha' })).map((e) => e.id)).toEqual(['a']);
    expect((await store.query({ text: 'other' })).map((e) => e.id)).toEqual(['b']);
    expect((await store.query({ text: 'MUSIC' })).map((e) => e.id)).toEqual(['c']);
    expect((await store.query({ downloadType: 'audio' })).map((e) => e.id)).toEqual(['c']);
    expect(await store.query({ extractorKey: 'nope' })).toEqual([]);
  });

  it('applies limit/offset and newest-first ordering', async () => {
    const { store } = setup();
    await store.add(entry({ id: 'old', videoPath: 'C:/a.mp4', completedAt: '2026-11-05T00:00:01.000Z' }));
    await store.add(entry({ id: 'new', videoPath: 'C:/b.mp4', completedAt: '2026-11-05T00:00:09.000Z' }));
    const all = await store.query({});
    expect(all.map((e) => e.id)).toEqual(['new', 'old']);
    expect((await store.query({ limit: 1 })).map((e) => e.id)).toEqual(['new']);
    expect((await store.query({ offset: 1 })).map((e) => e.id)).toEqual(['old']);
  });

  it('pure matchEntry/applyQuery behave as documented', () => {
    expect(matchEntry(entry(), {})).toBe(true);
    expect(matchEntry(entry(), { text: '' })).toBe(true);
    expect(matchEntry(entry(), { text: 'zzz' })).toBe(false);
    expect(applyQuery([entry()], { limit: 0 })).toEqual([entry()].slice(0, 0));
  });
});

describe('A-M2-21 · remove (optionally deleting files) + export/import', () => {
  it('removes the entry and deletes the file only when asked', async () => {
    const { mem, store } = setup();
    const video = 'C:/out/Alpha [id].mp4';
    mem.state.files.set(video, 'bytes');
    await store.add(entry({ videoPath: video }));
    expect(await store.remove('h1')).toBe(true);
    expect(await store.query({})).toHaveLength(0);
    expect(mem.state.files.has(video)).toBe(true); // kept by default
    expect(await store.remove('h1')).toBe(false);
  });

  it('deleteFile removes video/audio/subtitle artifacts', async () => {
    const { mem, store } = setup();
    const video = 'C:/out/a.mp4';
    const audio = 'C:/out/a.m4a';
    const sub = 'C:/out/a.en.srt';
    for (const path of [video, audio, sub]) mem.state.files.set(path, 'x');
    await store.add(entry({ videoPath: video, audioPath: audio, subtitlePaths: [sub] }));
    expect(await store.remove('h1', { deleteFile: true })).toBe(true);
    expect(mem.state.files.has(video)).toBe(false);
    expect(mem.state.files.has(audio)).toBe(false);
    expect(mem.state.files.has(sub)).toBe(false);
  });

  it('export/import round-trips and de-duplicates on import', async () => {
    const { store } = setup();
    await store.add(entry());
    const json = await store.exportJson();
    const target = setup().store;
    expect(await target.importJson(json)).toBe(1);
    expect(await target.importJson(json)).toBe(0); // already present
    expect(await target.query({})).toHaveLength(1);
  });

  it('imports the recorded fixture and de-duplicates the repeated videoPath', async () => {
    const { store } = setup();
    // history-valid.json has 3 entries, two of which normalize to the same path.
    expect(await store.importJson(fixture('history-valid.json'))).toBe(2);
    expect(await store.query({})).toHaveLength(2);
  });

  it('get() returns a single entry by id', async () => {
    const { store } = setup();
    await store.add(entry());
    expect((await store.get('h1'))?.videoPath).toBe('C:/out/Alpha [id].mp4');
    expect(await store.get('missing')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Audit follow-up (D-218 复核) · persist-first, commit-after.
//
// The old add()/remove()/importJson() mutated `this.entries` BEFORE awaiting
// the write queue, so a persist failure left residue: an add() failure kept
// the row in memory (and the NEXT queue task flushed it to disk — a canceled
// task showed a successful history row that survived restart), a remove()
// failure deleted from memory while the row stayed on disk. The new contract:
// the write-queue task persists the WOULD-BE state and commits memory only
// after the atomic write succeeded — a failure leaves memory AND disk
// untouched, with no rollback and no compensation needed.
// ---------------------------------------------------------------------------
describe('persist-first, commit-after · history write failures leave no residue', () => {
  /**
   * One-shot sabotage in the style of the D-218 gate fakes: `writeTextAtomic`
   * fails the next `n` writes to the history file, then recovers. `disk()`
   * reads the "on-disk" history.json from the in-memory ports' file map (the
   * same way the D-218 window-B test reads it).
   */
  const setupFailing = () => {
    const mem = createInMemoryPorts();
    const historyPath = `${mem.ports.env.configDir()}/history.json`;
    const inner = mem.ports.fs.writeTextAtomic.bind(mem.ports.fs);
    let failsLeft = 0;
    mem.ports.fs.writeTextAtomic = async (path: string, text: string): Promise<void> => {
      if (failsLeft > 0 && path === historyPath) {
        failsLeft -= 1;
        throw new Error('simulated history write failure');
      }
      await inner(path, text);
    };
    const store = new HistoryStore({ ports: mem.ports });
    const diskIds = (): string[] => {
      const raw = mem.state.files.get(historyPath);
      if (raw === undefined) return [];
      return (JSON.parse(raw) as { entries: Array<{ id: string }> }).entries.map((e) => e.id);
    };
    return { store, diskIds, setFails: (n: number): void => { failsLeft = n; } };
  };

  it('add() whose persist throws leaves the entry nowhere — memory and disk both stay clean', async () => {
    const { store, diskIds, setFails } = setupFailing();
    // A first healthy write so "no residue" is asserted about real leftovers.
    await store.add(entry({ id: 'h1', videoPath: 'C:/out/one.mp4' }));
    expect(diskIds()).toEqual(['h1']);

    // The next persist fails: add() rejects and commits NOTHING.
    setFails(1);
    await expect(store.add(entry({ id: 'h2', videoPath: 'C:/out/two.mp4' })))
      .rejects.toThrow('simulated history write failure');

    // Memory is clean (the old code kept h2 in `entries` right here)...
    expect((await store.query({})).map((e) => e.id)).toEqual(['h1']);
    // ...and disk is clean (no residue, no half-written file).
    expect(diskIds()).toEqual(['h1']);

    // Recovery: a later add persists the committed state. Under the old
    // commit-early code this write would have flushed the h2 residue to disk.
    await store.add(entry({ id: 'h3', videoPath: 'C:/out/three.mp4' }));
    expect((await store.query({})).map((e) => e.id)).toEqual(['h1', 'h3']);
    expect(diskIds()).toEqual(['h1', 'h3']);
    expect(diskIds()).not.toContain('h2');
  });

  it('remove() whose persist throws keeps the entry in memory AND on disk; a retried remove lands on both', async () => {
    const { store, diskIds, setFails } = setupFailing();
    await store.add(entry({ id: 'h1', videoPath: 'C:/out/one.mp4' }));
    expect(diskIds()).toEqual(['h1']);

    setFails(1);
    await expect(store.remove('h1')).rejects.toThrow('simulated history write failure');
    // Nothing was committed: memory still has the entry (the old code had
    // already filtered it out here — memory/disk divergence), disk unchanged.
    expect((await store.query({})).map((e) => e.id)).toEqual(['h1']);
    expect(diskIds()).toEqual(['h1']);

    // After recovery the retry removes it consistently on both sides.
    expect(await store.remove('h1')).toBe(true);
    expect(await store.query({})).toEqual([]);
    expect(diskIds()).toEqual([]);
  });

  it('two concurrent add() calls both land on disk (serialized queue, no lost update)', async () => {
    const { mem } = setup();
    const store = new HistoryStore({ ports: mem.ports });
    // Fire the second add WITHOUT awaiting the first: the write queue must
    // serialize both read-modify-persist-commit sequences, and the second
    // persist must observe the first commit.
    const [first, second] = await Promise.all([
      store.add(entry({ id: 'a', videoPath: 'C:/out/a.mp4' })),
      store.add(entry({ id: 'b', videoPath: 'C:/out/b.mp4' })),
    ]);
    expect(first.added).toBe(true);
    expect(second.added).toBe(true);

    expect((await store.query({})).map((e) => e.id).sort()).toEqual(['a', 'b']);
    const historyPath = `${mem.ports.env.configDir()}/history.json`;
    const raw = mem.state.files.get(historyPath);
    expect(raw).toBeDefined();
    const diskIds = (JSON.parse(raw as string) as { entries: Array<{ id: string }> })
      .entries.map((e) => e.id).sort();
    expect(diskIds).toEqual(['a', 'b']);
  });

  it('D-227 cold start: a concurrent add() during the FIRST load must not drop seeded history', async () => {
    const mem = createInMemoryPorts();
    const historyPath = `${mem.ports.env.configDir()}/history.json`;
    // Pre-existing history on disk (the case the previous test deliberately did not cover).
    mem.state.files.set(historyPath, JSON.stringify({
      schemaVersion: 1,
      entries: [
        entry({ id: 'old-1', videoPath: 'C:/out/old1.mp4' }),
        entry({ id: 'old-2', videoPath: 'C:/out/old2.mp4' }),
      ],
    }));

    // Block the FIRST read so the second add() arrives while init() is still
    // loading. Both add() calls are issued before any await, so both enter
    // init() synchronously — the interleaving is deterministic, not timing-based.
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolveGate) => { releaseRead = resolveGate; });
    let gated = true;
    const ports = {
      ...mem.ports,
      fs: {
        ...mem.ports.fs,
        readText: async (path: string): Promise<string> => {
          if (gated && path === historyPath) {
            gated = false;
            await readGate;
          }
          return mem.ports.fs.readText(path);
        },
      },
    };
    const store = new HistoryStore({ ports });

    const first = store.add(entry({ id: 'new-a', videoPath: 'C:/out/a.mp4' }));
    const second = store.add(entry({ id: 'new-b', videoPath: 'C:/out/b.mp4' }));
    await Promise.resolve();
    releaseRead();
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1.added).toBe(true);
    expect(r2.added).toBe(true);

    const raw = mem.state.files.get(historyPath);
    const diskIds = (JSON.parse(raw as string) as { entries: Array<{ id: string }> })
      .entries.map((e) => e.id).sort();
    // Seeded rows must survive AND both new rows must be present.
    expect(diskIds).toEqual(['new-a', 'new-b', 'old-1', 'old-2']);
    expect((await store.query({})).map((e) => e.id).sort()).toEqual(['new-a', 'new-b', 'old-1', 'old-2']);
  });

  it('D-227 a failed first load is retried instead of leaving the store permanently empty', async () => {
    const mem = createInMemoryPorts();
    const historyPath = `${mem.ports.env.configDir()}/history.json`;
    mem.state.files.set(historyPath, JSON.stringify({
      schemaVersion: 1,
      entries: [entry({ id: 'old-1', videoPath: 'C:/out/old1.mp4' })],
    }));

    // First mkdir fails (transient EACCES); the OLD code left `loaded = true`
    // forever, so every later add() would persist against an EMPTY array and
    // overwrite the seeded row. The fix clears the cached promise and retries.
    let failures = 1;
    const ports = {
      ...mem.ports,
      fs: {
        ...mem.ports.fs,
        mkdir: async (dir: string): Promise<void> => {
          if (failures > 0) {
            failures -= 1;
            throw new Error('EACCES: transient');
          }
          return mem.ports.fs.mkdir(dir);
        },
      },
    };
    const store = new HistoryStore({ ports });

    await expect(store.add(entry({ id: 'new-a', videoPath: 'C:/out/a.mp4' }))).rejects.toThrow('EACCES');
    const retried = await store.add(entry({ id: 'new-b', videoPath: 'C:/out/b.mp4' }));
    expect(retried.added).toBe(true);

    const raw = mem.state.files.get(historyPath);
    const diskIds = (JSON.parse(raw as string) as { entries: Array<{ id: string }> })
      .entries.map((e) => e.id).sort();
    expect(diskIds).toEqual(['new-b', 'old-1']);
  });
});

// ---------------------------------------------------------------------------
// D-230 (audit P1) · "could not read" is not "empty".
//
// The old load() wrapped `readText` AND `JSON.parse` in one `catch` and set the
// in-memory list to `[]` for both. A transient read failure (AV scan holding
// the file, a brief EACCES) therefore looked exactly like "this user has no
// history", and the next add() persisted `[onlyTheNewRow]` — the previous file
// was gone before anything could retry. These cases pin the split:
// read failure → reject + retry, nothing written; unparseable content → start
// empty but copy the original aside BEFORE the first rewrite.
// ---------------------------------------------------------------------------
describe('D-230 · read failures never overwrite; corrupt bytes are preserved', () => {
  const historyPath = (mem: ReturnType<typeof createInMemoryPorts>): string =>
    `${mem.ports.env.configDir()}/history.json`;

  const diskIds = (mem: ReturnType<typeof createInMemoryPorts>, path: string): string[] => {
    const raw = mem.state.files.get(path);
    if (raw === undefined) return [];
    return (JSON.parse(raw) as { entries: Array<{ id: string }> }).entries.map((e) => e.id);
  };

  it('a read failure rejects the add and leaves the previous bytes untouched', async () => {
    const mem = createInMemoryPorts();
    const path = historyPath(mem);
    mem.state.files.set(path, JSON.stringify({
      schemaVersion: 1,
      entries: [entry({ id: 'old-1', videoPath: 'C:/out/old1.mp4' })],
    }));
    const before = mem.state.files.get(path);

    let failures = 1;
    const ports = {
      ...mem.ports,
      fs: {
        ...mem.ports.fs,
        readText: async (target: string): Promise<string> => {
          if (failures > 0 && target === path) {
            failures -= 1;
            throw new Error('EBUSY: history file locked');
          }
          return mem.ports.fs.readText(target);
        },
      },
    };
    const store = new HistoryStore({ ports });

    await expect(store.add(entry({ id: 'new-a', videoPath: 'C:/out/a.mp4' })))
      .rejects.toThrow('EBUSY');
    // The decisive assertion: the OLD code had already replaced this file with
    // a single-row payload by now.
    expect(mem.state.files.get(path)).toBe(before);

    // Recovery: init() cleared the cached promise, so the retry re-reads and
    // appends to the rows that were never lost.
    const retried = await store.add(entry({ id: 'new-b', videoPath: 'C:/out/b.mp4' }));
    expect(retried.added).toBe(true);
    expect(diskIds(mem, path).sort()).toEqual(['new-b', 'old-1']);
  });

  it('copies an unparseable file aside before the first rewrite', async () => {
    const mem = createInMemoryPorts();
    const path = historyPath(mem);
    mem.state.files.set(path, '{not json');

    const store = new HistoryStore({ ports: mem.ports });
    // Reading alone must not touch the file.
    expect(await store.query({})).toEqual([]);
    expect(mem.state.files.get(path)).toBe('{not json');

    await store.add(entry({ id: 'new-a', videoPath: 'C:/out/a.mp4' }));
    const backups = [...mem.state.files.keys()].filter((key) => key.includes('history.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(mem.state.files.get(backups[0] as string)).toBe('{not json');
    expect(diskIds(mem, path)).toEqual(['new-a']);
  });

  it('refuses to rewrite when the preserve copy itself fails', async () => {
    const mem = createInMemoryPorts();
    const path = historyPath(mem);
    mem.state.files.set(path, '{not json');
    const inner = mem.ports.fs.writeTextAtomic.bind(mem.ports.fs);
    const ports = {
      ...mem.ports,
      fs: {
        ...mem.ports.fs,
        writeTextAtomic: async (target: string, text: string): Promise<void> => {
          if (target.includes('history.json.corrupt-')) throw new Error('backup disk full');
          await inner(target, text);
        },
      },
    };
    const store = new HistoryStore({ ports });

    await expect(store.add(entry({ id: 'new-a', videoPath: 'C:/out/a.mp4' })))
      .rejects.toThrow('backup disk full');
    // Fail closed: the only copy of the damaged history is still the original.
    expect(mem.state.files.get(path)).toBe('{not json');
  });
});
