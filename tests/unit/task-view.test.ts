/**
 * M5-3 · task list view model (A-4.4-16).
 *
 * The four tabs, the search box and both empty states are decided here, not in
 * the page. The last block pins the security-relevant rule: searching must never
 * match the task URL (a signed link must not be able to pull a task out of the
 * list, and the UI never renders that URL anyway).
 */
import { describe, it, expect } from 'vitest';
import type { MediaInfo, TaskRecord, TaskState } from '@ytvdlt/shared';
import {
  TASK_TABS, tabOfState, tabCounts, searchableText, filterTasks,
  emptyKind, emptyStateCopy, buildTaskListSnapshot, enabledTabs,
} from '@ytvdlt/core';

function media(title: string, uploader: string | null): MediaInfo {
  return {
    id: 'v1', title, uploader, uploader_id: null, duration: 100, thumbnail: null,
    webpage_url: 'https://example.org/v', extractor_key: 'generic', description: null,
    upload_date: null, ext: 'mp4', formats: [], subtitles: {}, automatic_captions: {},
    chapters: null, _type: 'video',
  };
}

function task(id: string, state: TaskState, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    url: `https://example.org/watch?v=${id}&token=SECRET`,
    kind: 'video',
    state,
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z',
    mediaInfo: media(`Title ${id}`, 'Uploader'),
    request: null,
    artifacts: [],
    lastPercent: state === 'Completed' ? 100 : 42,
    error: null,
    privateMode: false,
    postprocessed: false,
    ...overrides,
  };
}

const records: readonly TaskRecord[] = [
  task('a1', 'Running', { mediaInfo: media('Sprite Fright', 'Blender Studio') }),
  task('a2', 'FetchingInfo', { mediaInfo: null }),
  task('a3', 'ReadyWithInfo', { mediaInfo: media('Sintel', 'Durian') }),
  task('a4', 'Completed', { mediaInfo: media('Tears of Steel', 'Mango') }),
  task('a5', 'Canceled', { mediaInfo: media('Cosmos Laundromat', 'Gooseberry') }),
  task('a6', 'Error', { mediaInfo: media('Private stream', null) }),
  task('a7', 'Idle', { mediaInfo: null }),
];

describe('task-view · tab semantics', () => {
  it('maps all 7 states onto 4 tabs without losing any', () => {
    expect(TASK_TABS).toEqual(['all', 'downloading', 'finished', 'canceled']);
    expect(tabOfState('Idle')).toBe('downloading');
    expect(tabOfState('FetchingInfo')).toBe('downloading');
    expect(tabOfState('ReadyWithInfo')).toBe('downloading');
    expect(tabOfState('Running')).toBe('downloading');
    expect(tabOfState('Completed')).toBe('finished');
    expect(tabOfState('Canceled')).toBe('canceled');
    expect(tabOfState('Error')).toBe('canceled');
  });

  it('counts each tab, with `all` as the total', () => {
    expect(tabCounts(records)).toEqual({ all: 7, downloading: 4, finished: 1, canceled: 2 });
    expect(tabCounts([])).toEqual({ all: 0, downloading: 0, finished: 0, canceled: 0 });
  });
});

describe('task-view · filtering', () => {
  it('filters by tab', () => {
    expect(filterTasks(records, { tab: 'finished' }).map((r) => r.id)).toEqual(['a4']);
    expect(filterTasks(records, { tab: 'canceled' }).map((r) => r.id)).toEqual(['a5', 'a6']);
    expect(filterTasks(records, { tab: 'downloading' }).map((r) => r.id)).toEqual(['a1', 'a2', 'a3', 'a7']);
    expect(filterTasks(records, { tab: 'all' })).toHaveLength(7);
  });

  it('searches title, uploader, id and kind case-insensitively', () => {
    expect(filterTasks(records, { query: 'sprite' }).map((r) => r.id)).toEqual(['a1']);
    expect(filterTasks(records, { query: 'BLENDER' }).map((r) => r.id)).toEqual(['a1']);
    expect(filterTasks(records, { query: 'a4' }).map((r) => r.id)).toEqual(['a4']);
    expect(filterTasks(records, { query: '  video  ' })).toHaveLength(7);
    expect(filterTasks(records, { query: 'nothing-matches' })).toHaveLength(0);
    expect(filterTasks(records, { tab: 'canceled', query: 'gooseberry' }).map((r) => r.id)).toEqual(['a5']);
  });

  it('never matches the task URL (signed links stay out of search)', () => {
    expect(searchableText(task('a1', 'Running'))).not.toContain('token');
    expect(filterTasks(records, { query: 'SECRET' })).toHaveLength(0);
    expect(filterTasks(records, { query: 'https' })).toHaveLength(0);
  });
});

describe('task-view · empty states', () => {
  it('distinguishes an empty queue from an empty filter', () => {
    expect(emptyKind(0, 0)).toBe('no-tasks');
    expect(emptyKind(7, 0)).toBe('no-match');
    expect(emptyKind(7, 3)).toBeNull();
    expect(emptyStateCopy(null)).toBeNull();
    expect(emptyStateCopy('no-tasks')).toEqual({
      variant: 'empty',
      titleKey: 'queue.empty.title',
      hintKey: 'queue.empty.hint',
      ctaKey: 'queue.empty.cta',
    });
    expect(emptyStateCopy('no-match')).toEqual({
      variant: 'filter',
      titleKey: 'queue.filter.empty.title',
      hintKey: 'queue.filter.empty.hint',
      ctaKey: null,
    });
  });

  it('reports the empty state through the snapshot', () => {
    const empty = buildTaskListSnapshot([]);
    expect(empty.empty?.variant).toBe('empty');
    expect(empty.counts.all).toBe(0);
    expect(enabledTabs([])).toEqual(['all']);
    expect(enabledTabs(records)).toEqual(TASK_TABS);

    const filtered = buildTaskListSnapshot(records, { tab: 'finished', query: 'no-such-title' });
    expect(filtered.visible).toHaveLength(0);
    expect(filtered.empty?.variant).toBe('filter');
    expect(filtered.counts.finished).toBe(1);
  });

  it('normalises the snapshot input', () => {
    const snapshot = buildTaskListSnapshot(records, { tab: 'downloading', query: '  sintel  ' });
    expect(snapshot.query).toBe('sintel');
    expect(snapshot.visible.map((r) => r.id)).toEqual(['a3']);
    expect(snapshot.empty).toBeNull();
  });
});
