/**
 * D-148 · pure Star-prompt frequency policy.
 *
 * These tests never touch config or the clock: every decision runs on a state
 * object and an injected epoch-ms `now`, so the real 7-day gap is exercised in
 * microseconds on a fake timeline. They pin the safety invariants the
 * main-process service relies on:
 *   - a fresh install / upgrade stays quiet twice (third launch asks);
 *   - at most two asks per version;
 *   - "later" arms a 7-day retry gap, within the SAME version;
 *   - "star" / "never" silence permanently — across version changes;
 *   - a version change resets the counters but never the permanent silence.
 */
import { describe, it, expect } from 'vitest';
import {
  STAR_EMPTY_STATE, STAR_LAUNCH_THRESHOLD, STAR_MAX_PROMPTS_PER_VERSION,
  STAR_RETRY_GAP_MS, normalizeStarPromptState, onLaunch, recordResult, shouldShow,
  type StarPromptState,
} from '@ytvdlt/core';

const V1 = '0.3.0';
const V2 = '0.3.1';
const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** Walk `launches` launches of `version` starting from `state`. */
function launches(
  state: StarPromptState,
  count: number,
  version: string = V1,
): StarPromptState {
  let current = state;
  for (let index = 0; index < count; index += 1) {
    current = onLaunch(current, version, T0 + index);
  }
  return current;
}

describe('star prompt policy · constants are pinned (behaviour freezes with them)', () => {
  it('keeps the shipped thresholds', () => {
    expect(STAR_LAUNCH_THRESHOLD).toBe(3);
    expect(STAR_MAX_PROMPTS_PER_VERSION).toBe(2);
    expect(STAR_RETRY_GAP_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('star prompt policy · onLaunch', () => {
  it('counts launches within one version', () => {
    let state = onLaunch(STAR_EMPTY_STATE, V1, T0);
    expect(state).toEqual({
      version: V1, launches: 1, promptedCount: 0, lastPromptedAt: '', never: false,
    });
    state = onLaunch(state, V1, T0 + 1);
    expect(state.launches).toBe(2);
    state = onLaunch(state, V1, T0 + 2);
    expect(state.launches).toBe(3);
  });

  it('resets the per-version counters on a version change but keeps permanent silence', () => {
    let state = launches(STAR_EMPTY_STATE, 5);
    state = recordResult(state, 'later', T0); // promptedCount 1, lastPromptedAt set
    state = recordResult(state, 'never', T0 + 1);
    expect(state.never).toBe(true);

    const afterUpgrade = onLaunch(state, V2, T0 + 2);
    expect(afterUpgrade.version).toBe(V2);
    expect(afterUpgrade.launches).toBe(1);
    expect(afterUpgrade.promptedCount).toBe(0);
    expect(afterUpgrade.lastPromptedAt).toBe('');
    // "不再提醒" is a permanent answer, not a per-version one.
    expect(afterUpgrade.never).toBe(true);
  });
});

describe('star prompt policy · shouldShow', () => {
  it('stays quiet for the first two launches of a version', () => {
    const one = launches(STAR_EMPTY_STATE, 1);
    const two = launches(STAR_EMPTY_STATE, 2);
    expect(shouldShow(one, T0)).toBe(false);
    expect(shouldShow(two, T0)).toBe(false);
  });

  it('asks from the third launch on', () => {
    const three = launches(STAR_EMPTY_STATE, 3);
    expect(shouldShow(three, T0)).toBe(true);
  });

  it('caps the asks at two per version', () => {
    let state = launches(STAR_EMPTY_STATE, 3);
    state = recordResult(state, 'later', T0);
    // Within the 7-day gap: quiet.
    expect(shouldShow(state, T0 + STAR_RETRY_GAP_MS - 1)).toBe(false);
    // Second ask, still under the cap.
    expect(shouldShow(state, T0 + STAR_RETRY_GAP_MS)).toBe(true);
    state = recordResult(state, 'later', T0 + STAR_RETRY_GAP_MS);
    expect(state.promptedCount).toBe(2);
    expect(shouldShow(state, T0 + STAR_RETRY_GAP_MS + STAR_RETRY_GAP_MS)).toBe(false);
  });

  it('never shows after a permanent answer, regardless of launches or versions', () => {
    let state = launches(STAR_EMPTY_STATE, 3);
    state = recordResult(state, 'never', T0);
    expect(shouldShow(state, T0 + 100 * DAY)).toBe(false);
    const upgraded = launches(state, 10, V2);
    expect(shouldShow(upgraded, T0 + 100 * DAY)).toBe(false);
  });

  it('re-arms seven days after a "later" answer, not earlier', () => {
    let state = launches(STAR_EMPTY_STATE, 3);
    state = recordResult(state, 'later', T0);
    expect(shouldShow(state, T0 + 6 * DAY + 23 * 60 * 60 * 1000)).toBe(false);
    expect(shouldShow(state, T0 + STAR_RETRY_GAP_MS)).toBe(true);
  });

  it('fails closed on an unparsable timestamp (frequency limiter stays quiet)', () => {
    const state: StarPromptState = {
      version: V1, launches: 3, promptedCount: 0, lastPromptedAt: 'not-a-date', never: false,
    };
    expect(shouldShow(state, T0)).toBe(false);
  });
});

describe('star prompt policy · recordResult', () => {
  it('later counts a prompt and stamps the retry gap, keeping the version eligible', () => {
    const state = recordResult(launches(STAR_EMPTY_STATE, 3), 'later', T0);
    expect(state.promptedCount).toBe(1);
    expect(state.lastPromptedAt).toBe(new Date(T0).toISOString());
    expect(state.never).toBe(false);
    expect(shouldShow(state, T0 + STAR_RETRY_GAP_MS)).toBe(true);
  });

  it('star silences permanently (the user is on their way to the repo)', () => {
    let state = recordResult(launches(STAR_EMPTY_STATE, 3), 'star', T0);
    expect(state.never).toBe(true);
    expect(shouldShow(state, T0 + 100 * DAY)).toBe(false);
    // …and the silence survives an upgrade.
    state = onLaunch(state, V2, T0 + 1);
    expect(shouldShow(state, T0 + 100 * DAY)).toBe(false);
  });

  it('never silences permanently', () => {
    const state = recordResult(launches(STAR_EMPTY_STATE, 3), 'never', T0);
    expect(state.never).toBe(true);
    expect(shouldShow(state, T0 + 100 * DAY)).toBe(false);
  });
});

describe('star prompt policy · normalizeStarPromptState', () => {
  it('passes a well-formed config domain through', () => {
    const raw = {
      starPromptVersion: V1,
      starPromptLaunches: 4,
      starPromptPromptedCount: 1,
      starPromptLastPromptedAt: '2026-11-01T00:00:00.000Z',
      starPromptNever: false,
    };
    expect(normalizeStarPromptState(raw)).toEqual({
      version: V1, launches: 4, promptedCount: 1,
      lastPromptedAt: '2026-11-01T00:00:00.000Z', never: false,
    });
  });

  it('falls back to defaults for missing or wrong-typed values (hand-edited config)', () => {
    expect(normalizeStarPromptState({})).toEqual({
      version: '', launches: 0, promptedCount: 0, lastPromptedAt: '', never: false,
    });
    expect(normalizeStarPromptState({
      starPromptVersion: 42,
      starPromptLaunches: 'nine',
      starPromptPromptedCount: -1,
      starPromptLastPromptedAt: null,
      starPromptNever: 'yes',
    })).toEqual({
      version: '', launches: 0, promptedCount: 0, lastPromptedAt: '', never: false,
    });
    // Fractional counters are floored, never trusted.
    expect(normalizeStarPromptState({ starPromptLaunches: 2.7 }).launches).toBe(2);
    expect(normalizeStarPromptState({ starPromptNever: true }).never).toBe(true);
  });
});

describe('star prompt policy · the whole per-version story', () => {
  it('matches the owner contract end to end on a fake timeline', () => {
    let state = STAR_EMPTY_STATE;
    // Launches 1-2: quiet. Launch 3: ask #1.
    state = onLaunch(state, V1, T0);
    state = onLaunch(state, V1, T0 + DAY);
    expect(shouldShow(state, T0 + DAY)).toBe(false);
    state = onLaunch(state, V1, T0 + 2 * DAY);
    expect(shouldShow(state, T0 + 2 * DAY)).toBe(true);
    // User: "later" → 7-day gap inside this version.
    state = recordResult(state, 'later', T0 + 2 * DAY);
    expect(shouldShow(state, T0 + 3 * DAY)).toBe(false);
    expect(shouldShow(state, T0 + 2 * DAY + STAR_RETRY_GAP_MS)).toBe(true);
    // Ask #2: user goes to star → permanent silence.
    state = recordResult(state, 'star', T0 + 2 * DAY + STAR_RETRY_GAP_MS);
    expect(shouldShow(state, T0 + 200 * DAY)).toBe(false);
    // Upgrade: counters reset, but silence is permanent.
    state = onLaunch(state, V2, T0 + 201 * DAY);
    expect(shouldShow(state, T0 + 201 * DAY)).toBe(false);

    // A "later" user upgrades instead: the new version asks again.
    let laterUser = STAR_EMPTY_STATE;
    laterUser = onLaunch(laterUser, V1, T0);
    laterUser = onLaunch(laterUser, V1, T0 + 1);
    laterUser = onLaunch(laterUser, V1, T0 + 2);
    laterUser = recordResult(laterUser, 'later', T0 + 2);
    laterUser = onLaunch(laterUser, V2, T0 + 3);
    expect(shouldShow(laterUser, T0 + 4)).toBe(false); // new version, launch 1: quiet
    laterUser = onLaunch(laterUser, V2, T0 + 4);
    laterUser = onLaunch(laterUser, V2, T0 + 5);
    expect(shouldShow(laterUser, T0 + 5)).toBe(true); // third launch of the new version
  });
});
