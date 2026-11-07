/**
 * Internal `ProbeOutcome` type — isolates spawn details from the DTO layer.
 * Pure data: no I/O.
 */
import type { MediaInfo, AppError } from '@ytvdlt/shared';

export type ProbeOutcome =
  | { readonly ok: true; readonly info: MediaInfo }
  | { readonly ok: false; readonly error: AppError };

export interface RawProbeResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export function probeSucceeded(result: RawProbeResult): boolean {
  return !result.timedOut && result.exitCode === 0;
}
