/**
 * "Should the update dialog show itself?" — one pure rule (0.2.1, D-93).
 *
 * Kept out of the renderer so the three suppression reasons cannot drift apart:
 * the user skipped THIS version, the user dismissed the dialog for this run, or
 * there is simply nothing to install.
 */
import type { AppUpdateState } from '@ytvdlt/shared';

export interface UpdatePromptGate {
  /** `sessionStorage`-backed flag: closed once, stays closed until next launch. */
  readonly dismissedThisSession: boolean;
}

export function shouldPromptForUpdate(
  state: AppUpdateState | null,
  gate: UpdatePromptGate,
): boolean {
  if (state === null) return false;
  if (state.phase !== 'available') return false;
  if (state.latest === null) return false;
  if (gate.dismissedThisSession) return false;
  const skipped = state.skippedVersion;
  if (skipped !== null && skipped !== '' && skipped === state.latest.version) return false;
  return true;
}

/** True when the user can be offered a one-click download + install. */
export function canOneClickInstall(state: AppUpdateState | null): boolean {
  return state !== null && state.phase === 'available' && state.canAutoInstall;
}
