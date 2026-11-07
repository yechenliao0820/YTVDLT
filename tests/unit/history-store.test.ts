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
