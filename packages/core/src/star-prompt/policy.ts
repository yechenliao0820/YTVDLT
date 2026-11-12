/**
 * Star-prompt policy (D-148).
 *
 * Pure decision layer for the "like this version? Star it on GitHub" nudge —
 * no `node:*`, no `electron`, no I/O, no clock reads: every function takes the
 * current time as an injected epoch-ms argument (same style as
 * `thumbnail-cache-policy`), so the whole behaviour is unit-testable with a
 * fake clock.
 *
 * Frequency contract (owner requirement: "每个版本 1~2 次就行"):
 *   - quiet for the first `STAR_LAUNCH_THRESHOLD - 1` launches of a version
 *     (a fresh install / upgrade stays silent twice before the first ask);
 *   - at most `STAR_MAX_PROMPTS_PER_VERSION` prompts per app version;
 *   - after a "maybe later" answer, the SAME version waits at least
 *     `STAR_RETRY_GAP_MS` before a second ask;
 *   - "star" and "don't ask again" silence the nudge permanently (across
 *     versions — `never` deliberately survives `onLaunch`'s reset);
 *   - upgrading to a new version resets the per-version counters, so a user
 *     who pressed "later" is asked again on the new version.
 */
export interface StarPromptState {
  /** App version the counters belong to ('' = never recorded). */
  readonly version: string;
  /** Launches observed for `version` (1-based: `onLaunch` writes the first). */
  readonly launches: number;
  /** How many times this version already showed the prompt. */
  readonly promptedCount: number;
  /** ISO timestamp of the last "later" answer ('' = never prompted). */
  readonly lastPromptedAt: string;
  /** Permanent silence: set by `star` / `never`, survives version changes. */
  readonly never: boolean;
}

/** Third launch of the same version is the first one that may ask. */
export const STAR_LAUNCH_THRESHOLD = 3;
/** Hard ceiling per version (owner: "每个版本 1~2 次就行"). */
export const STAR_MAX_PROMPTS_PER_VERSION = 2;
/** Minimum gap between the two prompts of one version ("以后再说"). */
export const STAR_RETRY_GAP_MS = 7 * 24 * 60 * 60 * 1000;

export type StarPromptAction = 'star' | 'later' | 'never';

export const STAR_PROMPT_ACTIONS: readonly StarPromptAction[] = ['star', 'later', 'never'];

/** State before the first launch was ever recorded. */
export const STAR_EMPTY_STATE: StarPromptState = {
  version: '',
  launches: 0,
  promptedCount: 0,
  lastPromptedAt: '',
  never: false,
};

/**
 * Coerce five raw `advanced.*` config values (which a hand-edited config.json
 * may hold as any type) into a valid state. Missing / wrong-typed values fall
 * back to the shipped defaults; the result is always safe to feed the three
 * functions below. `version` is compared verbatim — only an exact string match
 * with the running version counts as "same version".
 */
export function normalizeStarPromptState(raw: Record<string, unknown>): StarPromptState {
  const version = typeof raw['starPromptVersion'] === 'string' ? raw['starPromptVersion'] : '';
  const launches = typeof raw['starPromptLaunches'] === 'number'
    && Number.isFinite(raw['starPromptLaunches']) && raw['starPromptLaunches'] >= 0
    ? Math.floor(raw['starPromptLaunches']) : 0;
  const promptedCount = typeof raw['starPromptPromptedCount'] === 'number'
    && Number.isFinite(raw['starPromptPromptedCount']) && raw['starPromptPromptedCount'] >= 0
    ? Math.floor(raw['starPromptPromptedCount']) : 0;
  const lastPromptedAt = typeof raw['starPromptLastPromptedAt'] === 'string'
    ? raw['starPromptLastPromptedAt'] : '';
  return {
    version,
    launches,
    promptedCount,
    lastPromptedAt,
    never: raw['starPromptNever'] === true,
  };
}

/**
 * One app start. A version change resets the per-version counters (the new
 * version may ask again) but KEEPS `never`: "don't ask again" is a permanent
 * answer, not a per-version one.
 */
export function onLaunch(
  state: StarPromptState,
  appVersion: string,
  _nowEpochMs: number,
): StarPromptState {
  if (state.version !== appVersion) {
    return {
      version: appVersion,
      launches: 1,
      promptedCount: 0,
      lastPromptedAt: '',
      never: state.never,
    };
  }
  return { ...state, launches: state.launches + 1 };
}

/**
 * May the prompt show right now? Frequency-only: the caller (main process)
 * still owns the "is a task running" and "page settled" guards.
 *
 * An unparsable non-empty `lastPromptedAt` fails CLOSED (no prompt): the
 * timestamp is only ever written by `recordResult`, so garbage means a
 * hand-edited config, and for a frequency limiter the safe direction is
 * "stay quiet", never "ask more".
 */
export function shouldShow(state: StarPromptState, nowEpochMs: number): boolean {
  if (state.never) return false;
  if (state.launches < STAR_LAUNCH_THRESHOLD) return false;
  if (state.promptedCount >= STAR_MAX_PROMPTS_PER_VERSION) return false;
  if (state.lastPromptedAt !== '') {
    const last = Date.parse(state.lastPromptedAt);
    if (Number.isNaN(last) || nowEpochMs - last < STAR_RETRY_GAP_MS) return false;
  }
  return true;
}

/**
 * Record the user's answer. `star` and `never` both silence permanently (a
 * user who went to star the repo does not need a second ask); `later` keeps
 * the version eligible and only arms the 7-day retry gap.
 */
export function recordResult(
  state: StarPromptState,
  action: StarPromptAction,
  nowEpochMs: number,
): StarPromptState {
  if (action === 'star' || action === 'never') {
    return { ...state, never: true };
  }
  return {
    ...state,
    promptedCount: state.promptedCount + 1,
    lastPromptedAt: new Date(nowEpochMs).toISOString(),
  };
}
