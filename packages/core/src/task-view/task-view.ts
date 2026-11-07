/**
 * Task list view model (M5-3, A-4.4-16) — four tabs, search, empty states.
 *
 * Pure: it takes `TaskRecord[]` and returns what the page should render, so the
 * queue page has no filtering logic of its own and the rules are L0-testable.
 *
 * Tab semantics (documented deviation D-56): the Android source exposes
 * All / Downloading / Canceled / Finished. `Error` is grouped with `Canceled`
 * because both mean "ended without a successful artifact"; a separate "failed"
 * tab would change the PRD's four tabs.
 *
 * Search deliberately covers `id`, `mediaInfo.title`, `mediaInfo.uploader` and
 * the kind — NEVER `url`: a signed URL must not be able to pull a task out of
 * the list (the URL is masked in the UI anyway, §8.4).
 */
import type { TaskRecord, TaskState } from '@ytvdlt/shared';

export type TaskTab = 'all' | 'downloading' | 'finished' | 'canceled';
export const TASK_TABS: readonly TaskTab[] = ['all', 'downloading', 'finished', 'canceled'] as const;

export type EmptyKind = 'no-tasks' | 'no-match';

export interface TaskTabCounts {
  readonly all: number;
  readonly downloading: number;
  readonly finished: number;
  readonly canceled: number;
}

/** One state -> one non-`all` tab. */
export function tabOfState(state: TaskState): Exclude<TaskTab, 'all'> {
  if (state === 'Completed') return 'finished';
  if (state === 'Canceled' || state === 'Error') return 'canceled';
  return 'downloading';
}

export function tabCounts(records: readonly TaskRecord[]): TaskTabCounts {
  const counts = { all: records.length, downloading: 0, finished: 0, canceled: 0 };
  for (const record of records) {
    const tab = tabOfState(record.state);
    counts[tab] += 1;
  }
  return counts;
}

/** Fields the search box may match (URL intentionally excluded). */
export function searchableText(record: TaskRecord): string {
  const media = record.mediaInfo;
  return [
    record.id,
    record.kind,
    media?.title ?? '',
    media?.uploader ?? '',
  ].join(' ').toLowerCase();
}

export function filterTasks(
  records: readonly TaskRecord[],
  options: { readonly tab?: TaskTab; readonly query?: string } = {},
): readonly TaskRecord[] {
  const tab = options.tab ?? 'all';
  const query = String(options.query ?? '').trim().toLowerCase();
  return records.filter((record) => {
    if (tab !== 'all' && tabOfState(record.state) !== tab) return false;
    if (query.length === 0) return true;
    return searchableText(record).includes(query);
  });
}

/** `no-tasks` = the queue is empty; `no-match` = this tab/filter is empty. */
export function emptyKind(total: number, visible: number): EmptyKind | null {
  if (visible > 0) return null;
  return total === 0 ? 'no-tasks' : 'no-match';
}

export interface EmptyStateCopy {
  readonly variant: 'empty' | 'filter';
  readonly titleKey: string;
  readonly hintKey: string;
  readonly ctaKey: string | null;
}

/** Copy keys are resolved by i18n; core never carries display strings. */
export function emptyStateCopy(kind: EmptyKind | null): EmptyStateCopy | null {
  if (kind === null) return null;
  if (kind === 'no-tasks') {
    return {
      variant: 'empty',
      titleKey: 'queue.empty.title',
      hintKey: 'queue.empty.hint',
      ctaKey: 'queue.empty.cta',
    };
  }
  return {
    variant: 'filter',
    titleKey: 'queue.filter.empty.title',
    hintKey: 'queue.filter.empty.hint',
    ctaKey: null,
  };
}

export interface TaskListSnapshot {
  readonly tab: TaskTab;
  readonly query: string;
  readonly visible: readonly TaskRecord[];
  readonly counts: TaskTabCounts;
  readonly empty: EmptyStateCopy | null;
}

/** Everything the page needs for one render pass. */
export function buildTaskListSnapshot(
  records: readonly TaskRecord[],
  options: { readonly tab?: TaskTab; readonly query?: string } = {},
): TaskListSnapshot {
  const tab = options.tab ?? 'all';
  const query = String(options.query ?? '').trim();
  const visible = filterTasks(records, { tab, query });
  const empty = emptyStateCopy(emptyKind(records.length, visible.length));
  return { tab, query, visible, counts: tabCounts(records), empty };
}

/** Tabs that must still be clickable when the queue is empty. */
export function enabledTabs(records: readonly TaskRecord[]): readonly TaskTab[] {
  if (records.length === 0) return ['all'];
  return TASK_TABS;
}
