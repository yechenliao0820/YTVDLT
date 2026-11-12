/**
 * star-prompt-service — main-process owner of the "Star on GitHub" nudge (D-148).
 *
 * All frequency policy lives in `@ytvdlt/core` (`star-prompt/policy.ts`, pure
 * and fake-clock tested); this adapter only glues it to ConfigStore, the
 * injected clock and the injected `openExternal` port. No `electron` import:
 * the Electron layer hands the same `shell.openExternal` wrapper it already
 * builds for the app updater (D-93), so the URL is opened by the main process
 * and never travels through the renderer (D-98 spirit).
 *
 * The five `advanced.starPrompt*` keys are the ONLY persisted state; the
 * renderer holds no counter at all and can only (a) ask "may I show now?"
 * through `STAR_PROMPT_CHECK` (zero payload) and (b) report which button the
 * user pressed through `STAR_PROMPT_ACTION` (action enum, whitelist-validated).
 */
import {
  normalizeStarPromptState, onLaunch, recordResult, shouldShow,
  STAR_PROMPT_ACTIONS,
  type ClockPort, type IConfigStore, type StarPromptAction, type StarPromptState,
} from '@ytvdlt/core';

/**
 * The repository the dialog opens (D-148). Main-process-only constant: the
 * renderer sends `action: 'star'`, never a URL.
 */
export const STAR_PROMPT_REPO_URL = 'https://github.com/yechenliao0820/YTVDLT';

/**
 * Minimal logger seam so the service stays testable without the real Logger.
 * Both methods are optional on purpose: the production wiring forwards the
 * D-134 `siteSupportLogger` shape (warn/error only), and diagnostics are
 * best-effort by design — a missing logger must never fail a launch record.
 */
export interface StarPromptLogger {
  info?(scope: string, event: string, payload?: Record<string, unknown>): Promise<void> | void;
  warn?(scope: string, event: string, payload?: Record<string, unknown>): Promise<void> | void;
}

export interface StarPromptDeps {
  readonly config: IConfigStore;
  readonly clock: ClockPort;
  /** The running build version — decides "same version" for the counters. */
  readonly appVersion: string;
  /** Test/override seam; defaults to `STAR_PROMPT_REPO_URL`. */
  readonly repoUrl?: string;
  /** Electron `shell.openExternal`; absent = `star` still records, just opens nothing. */
  readonly openExternal?: (url: string) => Promise<void>;
  readonly logger?: StarPromptLogger;
}

/** The surface the M5 channels consume (and the unit tests fake). */
export interface StarPromptPort {
  /**
   * Called once per process start, after ConfigStore is loaded: records the
   * launch (version reset / counter bump) and persists the five keys.
   */
  recordLaunch(): Promise<void>;
  /** `STAR_PROMPT_CHECK` — frequency decision only, persists nothing. */
  check(): Promise<{ show: boolean }>;
  /** `STAR_PROMPT_ACTION` — validates the enum, persists, opens the repo on `star`. */
  applyAction(action: unknown): Promise<{ ok: boolean; action: StarPromptAction }>;
}

const LOG_SCOPE = 'star-prompt';

/** Read the five `advanced.*` keys as a validated state (missing keys = defaults). */
function readState(config: IConfigStore): StarPromptState {
  return normalizeStarPromptState(config.getDomain('advanced') as Record<string, unknown>);
}

/** Write the whole state back as one atomic `advanced` patch. */
async function persistState(config: IConfigStore, state: StarPromptState): Promise<void> {
  await config.setDomain('advanced', {
    starPromptVersion: state.version,
    starPromptLaunches: state.launches,
    starPromptPromptedCount: state.promptedCount,
    starPromptLastPromptedAt: state.lastPromptedAt,
    starPromptNever: state.never,
  });
}

export function createStarPromptService(deps: StarPromptDeps): StarPromptPort {
  const repoUrl = typeof deps.repoUrl === 'string' && deps.repoUrl !== ''
    ? deps.repoUrl : STAR_PROMPT_REPO_URL;

  return {
    async recordLaunch(): Promise<void> {
      const before = readState(deps.config);
      const after = onLaunch(before, deps.appVersion, deps.clock.nowEpochMs());
      await persistState(deps.config, after);
      await deps.logger?.info?.(LOG_SCOPE, 'launch recorded', {
        version: after.version,
        launches: after.launches,
        promptedCount: after.promptedCount,
        never: after.never,
      });
    },

    async check(): Promise<{ show: boolean }> {
      const state = readState(deps.config);
      return { show: shouldShow(state, deps.clock.nowEpochMs()) };
    },

    async applyAction(action: unknown): Promise<{ ok: boolean; action: StarPromptAction }> {
      // Enum gate (the channel layer whitelist-checks the payload KEYS; this is
      // the VALUE gate). Anything outside the three buttons is a protocol error.
      if (typeof action !== 'string' || !STAR_PROMPT_ACTIONS.includes(action as StarPromptAction)) {
        throw new Error('[star-prompt] unknown action');
      }
      const choice = action as StarPromptAction;
      const after = recordResult(readState(deps.config), choice, deps.clock.nowEpochMs());
      await persistState(deps.config, after);
      if (choice === 'star') {
        try {
          await deps.openExternal?.(repoUrl);
        } catch (error) {
          // Opening the browser is best-effort; the user's answer is already
          // recorded and must never be lost to a failed shell call.
          await deps.logger?.warn?.(LOG_SCOPE, 'open repo failed', {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await deps.logger?.info?.(LOG_SCOPE, 'action recorded', { action: choice, never: after.never });
      return { ok: true, action: choice };
    },
  };
}
