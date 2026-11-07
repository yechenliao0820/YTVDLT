/**
 * M4-1 · 7-state machine — full legal-transition matrix + ordinal priority.
 *
 * The M2 suite (A-M2-01) already walks all 49 pairs once. This file is the M4
 * contract: it pins the 7 states / 13 legal edges / 36 rejected edges as
 * INDEPENDENT hand-written expectations (not derived from the implementation),
 * and covers the M4 additions (ordinal priority, matrix view, predicates).
 */
import { describe, it, expect } from 'vitest';
import {
  TASK_STATES, LEGAL_TRANSITIONS, STATE_ORDINAL,
  canTransition, assertTransition, allTransitions, legalTargets,
  transitionMatrix, statePriority, compareStatePriority,
  isActive, isSettled, isTerminal, isRestartable, stateLabelKey,
  IllegalTaskTransitionError,
} from '@ytvdlt/core';
import type { TaskState } from '@ytvdlt/shared';

/** Hand-written expectation: exactly these 13 edges are legal (M4 §10.2). */
const EXPECTED_LEGAL: ReadonlyArray<readonly [TaskState, TaskState]> = [
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
];

/** Hand-written expectation: the 7 ordinals (Idle lowest, Canceled highest). */
const EXPECTED_ORDINAL: Readonly<Record<TaskState, number>> = {
  Idle: 0, FetchingInfo: 1, ReadyWithInfo: 2, Running: 3,
  Completed: 4, Error: 5, Canceled: 6,
};

const key = (pair: readonly [TaskState, TaskState]): string => `${pair[0]}->${pair[1]}`;

describe('M4-1 · seven states', () => {
  it('exposes exactly the 7 documented states in order', () => {
    expect([...TASK_STATES]).toEqual([
      'Idle', 'FetchingInfo', 'ReadyWithInfo', 'Running', 'Completed', 'Error', 'Canceled',
    ]);
    expect(TASK_STATES).toHaveLength(7);
    expect(new Set(TASK_STATES).size).toBe(7);
  });

  it('the 13 legal edges match the hand-written matrix exactly (no extra, no missing)', () => {
    expect(LEGAL_TRANSITIONS).toHaveLength(13);
    expect(new Set(LEGAL_TRANSITIONS.map(key))).toEqual(new Set(EXPECTED_LEGAL.map(key)));
    expect(EXPECTED_LEGAL.every(([from, to]) => canTransition(from, to))).toBe(true);
  });

  it('Completed is terminal: zero legal outbound edges', () => {
    expect(isTerminal('Completed')).toBe(true);
    expect(legalTargets('Completed')).toHaveLength(0);
    for (const to of TASK_STATES) {
      expect(canTransition('Completed', to)).toBe(false);
      expect(isTerminal(to)).toBe(to === 'Completed');
    }
  });
});

describe('M4-1 · legal transition matrix (7x7 = 49)', () => {
  it('transitionMatrix() has 13 true cells and 36 false cells', () => {
    const matrix = transitionMatrix();
    expect(matrix).toHaveLength(7);
    for (const row of matrix) expect(row).toHaveLength(7);
    let legal = 0;
    for (const [i, from] of TASK_STATES.entries()) {
      for (const [j, to] of TASK_STATES.entries()) {
        const expected = EXPECTED_LEGAL.some(([f, t]) => f === from && t === to);
        expect(matrix[i]?.[j]).toBe(expected);
        if (matrix[i]?.[j] === true) legal += 1;
      }
    }
    expect(legal).toBe(13);
    expect(49 - legal).toBe(36);
  });

  it('every one of the 36 illegal pairs is rejected individually', () => {
    let rejected = 0;
    for (const [from, to] of allTransitions()) {
      if (EXPECTED_LEGAL.some(([f, t]) => f === from && t === to)) continue;
      expect(() => assertTransition(from, to), `${from}->${to}`).toThrow(IllegalTaskTransitionError);
      rejected += 1;
    }
    expect(rejected).toBe(36);
  });

  it('rejections carry the exact from/to pair (for diagnostics + UI copy)', () => {
    for (const [from, to] of allTransitions()) {
      if (canTransition(from, to)) continue;
      try {
        assertTransition(from, to);
        expect.unreachable(`${from}->${to} must throw`);
      } catch (error) {
        expect(error).toBeInstanceOf(IllegalTaskTransitionError);
        const illegal = error as IllegalTaskTransitionError;
        expect(illegal.from).toBe(from);
        expect(illegal.to).toBe(to);
        expect(illegal.message).toBe(`illegal task transition: ${from} -> ${to}`);
        expect(illegal.name).toBe('IllegalTaskTransitionError');
      }
    }
  });

  it('legalTargets() equals the matrix row for every state', () => {
    for (const from of TASK_STATES) {
      const expected = TASK_STATES.filter((to) => EXPECTED_LEGAL.some(([f, t]) => f === from && t === to));
      expect([...legalTargets(from)].sort()).toEqual([...expected].sort());
    }
  });

  it('self-loops are illegal for all 7 states', () => {
    for (const state of TASK_STATES) {
      expect(canTransition(state, state)).toBe(false);
      expect(() => assertTransition(state, state)).toThrow(IllegalTaskTransitionError);
    }
  });
});

describe('M4-1 · ordinal priority', () => {
  it('pins the 7 ordinals to unique 0…6 values', () => {
    expect(STATE_ORDINAL).toEqual(EXPECTED_ORDINAL);
    const values = Object.values(STATE_ORDINAL);
    expect(new Set(values).size).toBe(7);
    expect(Math.min(...values)).toBe(0);
    expect(Math.max(...values)).toBe(6);
  });

  it('statePriority() and compareStatePriority() agree with the ordinal', () => {
    for (const state of TASK_STATES) expect(statePriority(state)).toBe(EXPECTED_ORDINAL[state]);
    for (const a of TASK_STATES) {
      for (const b of TASK_STATES) {
        const diff = statePriority(a) - statePriority(b);
        const forward = compareStatePriority(a, b);
        const backward = compareStatePriority(b, a);
        expect(Math.sign(forward)).toBe(Math.sign(diff));
        // `Object.is(-0, 0)` is false, so assert zero-antisymmetry explicitly.
        expect(forward === 0 ? backward === 0 : Math.sign(backward) === -Math.sign(forward)).toBe(true);
      }
    }
  });

  it('sorting by priority is stable and total (no two states tie)', () => {
    const shuffled: TaskState[] = ['Error', 'Idle', 'Canceled', 'Running', 'Completed', 'ReadyWithInfo', 'FetchingInfo'];
    const sorted = [...shuffled].sort(compareStatePriority);
    expect(sorted).toEqual(['Idle', 'FetchingInfo', 'ReadyWithInfo', 'Running', 'Completed', 'Error', 'Canceled']);
    expect(compareStatePriority('Running', 'ReadyWithInfo')).toBeGreaterThan(0);
    expect(compareStatePriority('Completed', 'Running')).toBeGreaterThan(0);
  });
});

describe('M4-1 · state predicates + UI label keys', () => {
  it('isActive covers exactly the two in-flight states', () => {
    const active = TASK_STATES.filter(isActive);
    expect(active).toEqual(['FetchingInfo', 'Running']);
  });

  it('isSettled covers exactly Completed / Error / Canceled', () => {
    const settled = TASK_STATES.filter(isSettled);
    expect(settled).toEqual(['Completed', 'Error', 'Canceled']);
  });

  it('isRestartable is the subset of settled states with a legal restart edge', () => {
    for (const state of TASK_STATES) {
      const restartable = isRestartable(state);
      expect(restartable).toBe(state === 'Error' || state === 'Canceled');
      if (restartable) {
        expect(canTransition(state, 'ReadyWithInfo') || canTransition(state, 'Idle')).toBe(true);
      }
    }
  });

  it('every state has a deterministic i18n key', () => {
    for (const state of TASK_STATES) expect(stateLabelKey(state)).toBe(`task.state.${state}`);
    expect(stateLabelKey('ReadyWithInfo')).toBe('task.state.ReadyWithInfo');
  });
});
