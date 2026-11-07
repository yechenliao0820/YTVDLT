/**
 * 7-state task machine (A-M2-01).
 * Exactly 13 legal transitions; every other pair (incl. self-loops) is illegal.
 * `Completed` is terminal — it accepts no inbound edge.
 */
import type { TaskState } from '@ytvdlt/shared';

export const TASK_STATES: readonly TaskState[] = [
  'Idle', 'FetchingInfo', 'ReadyWithInfo', 'Running', 'Completed', 'Error', 'Canceled',
] as const;

/** The 13 legal `from -> to` pairs (§4.5). */
export const LEGAL_TRANSITIONS: ReadonlyArray<readonly [TaskState, TaskState]> = [
  ['Idle', 'FetchingInfo'],
  ['FetchingInfo', 'ReadyWithInfo'],
  ['FetchingInfo', 'Error'],
  ['FetchingInfo', 'Canceled'],
  ['ReadyWithInfo', 'Running'],
  ['ReadyWithInfo', 'Canceled'],
  ['Running', 'Completed'],
  ['Running', 'Error'],
  ['Running', 'Canceled'],
  ['Error', 'ReadyWithInfo'],
  ['Error', 'Idle'],
  ['Canceled', 'ReadyWithInfo'],
  ['Canceled', 'Idle'],
] as const;

const LEGAL_KEYS = new Set(LEGAL_TRANSITIONS.map(([from, to]) => `${from}->${to}`));

export class IllegalTaskTransitionError extends Error {
  readonly from: TaskState;
  readonly to: TaskState;
  constructor(from: TaskState, to: TaskState) {
    super(`illegal task transition: ${from} -> ${to}`);
    this.name = 'IllegalTaskTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return LEGAL_KEYS.has(`${from}->${to}`);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) throw new IllegalTaskTransitionError(from, to);
}

/** Terminal states never transition out. */
export function isTerminal(state: TaskState): boolean {
  return state === 'Completed';
}

/** States from which `restart` is meaningful. */
export function isRestartable(state: TaskState): boolean {
  return state === 'Error' || state === 'Canceled';
}

/** All 49 combinations, used by the exhaustive unit test. */
export function allTransitions(): Array<readonly [TaskState, TaskState]> {
  const pairs: Array<readonly [TaskState, TaskState]> = [];
  for (const from of TASK_STATES) {
    for (const to of TASK_STATES) pairs.push([from, to]);
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// M4-1 (append-only): ordinal priority + matrix view for the UI / tray.
// The seven states are ORDERED: a task that is further along the pipeline has
// a higher ordinal. `Completed` is the maximum, `Idle` the minimum. The tray
// badge and the default list sort use `compareStatePriority()` so "Running"
// always sorts above "ReadyWithInfo" regardless of locale collation.
// ---------------------------------------------------------------------------

/** Frozen ordinal (append-only; never renumber — assertions pin these values). */
export const STATE_ORDINAL: Readonly<Record<TaskState, number>> = {
  Idle: 0,
  FetchingInfo: 1,
  ReadyWithInfo: 2,
  Running: 3,
  Completed: 4,
  Error: 5,
  Canceled: 6,
};

/** Single numeric priority for a state (higher = "further along"). */
export function statePriority(state: TaskState): number {
  return STATE_ORDINAL[state];
}

/**
 * Compare two states by ordinal. Returns <0 when `a` sorts before `b`.
 * Stable and total: the 7 ordinals are unique.
 */
export function compareStatePriority(a: TaskState, b: TaskState): number {
  return STATE_ORDINAL[a] - STATE_ORDINAL[b];
}

/** Legal successors of a state (empty for the terminal `Completed`). */
export function legalTargets(from: TaskState): readonly TaskState[] {
  return LEGAL_TRANSITIONS
    .filter(([source]) => source === from)
    .map(([, target]) => target);
}

/** 7x7 boolean matrix; `matrix[from][to]` mirrors `canTransition`. */
export function transitionMatrix(): ReadonlyArray<ReadonlyArray<boolean>> {
  return TASK_STATES.map((from) => TASK_STATES.map((to) => canTransition(from, to)));
}

/** A task that occupies a download slot (probe or transfer in flight). */
export function isActive(state: TaskState): boolean {
  return state === 'FetchingInfo' || state === 'Running';
}

/** A task that will never move again without an explicit user action. */
export function isSettled(state: TaskState): boolean {
  return state === 'Completed' || state === 'Error' || state === 'Canceled';
}

/** UI label key (i18n resolves it; core never carries display strings). */
export function stateLabelKey(state: TaskState): `task.state.${TaskState}` {
  return `task.state.${state}`;
}
