/**
 * D-133 (TASK-02) — byte-accurate output ceiling for child processes.
 *
 * WHY BYTES AND NOT `string.length`: `stdout += chunk` counts UTF-16 code units.
 * A CJK playlist title costs 3 UTF-8 bytes but 1-2 JS characters, so a limit
 * expressed in characters is off by up to 3x exactly for the users this app
 * ships to. Every counter here is fed a raw `Buffer` and sums `byteLength`.
 *
 * WHY THIS EXISTS AT ALL: the playlist probe reads a whole JSON document into
 * memory and then `JSON.parse`s it. Collecting it as an unbounded `+=` string
 * meant a pathological playlist (or a site that streamed an endless body) grew
 * the main process until it stalled. A hard ceiling turns that into a bounded,
 * explainable failure.
 *
 * SCOPE: only used for BOUNDED metadata jobs (probe / probePlaylist). A normal
 * download passes no limit and keeps the legacy unbounded behaviour, because a
 * long transfer legitimately streams megabytes of progress lines.
 */

/** Outcome of offering one chunk to a bounded collector. */
export type PushOutcome = 'ok' | 'exceeded';

/**
 * D-133: appended to `stderr` when a ceiling was hit, so the failure is
 * explainable in the log instead of looking like a random crash. The engine's
 * error mapper turns an unmatched stderr into `UNKNOWN`, and the bounded
 * `exitCode: null` keeps it out of every success path.
 *
 * Defined in `@ytvdlt/shared` because the engine package also needs the exact
 * string (to recognise its own overflow) and may not import from `apps/`.
 * Re-exported here so existing local importers keep one name to reach for.
 */
export { OUTPUT_LIMIT_MARKER } from '@ytvdlt/shared';

export interface BoundedOutput {
  /** Append a raw chunk; returns `exceeded` once the ceiling is crossed. */
  push(chunk: Buffer): PushOutcome;
  /** Decoded text so far (a truncated tail may end in U+FFFD — diagnostics only). */
  text(): string;
  /** Bytes accepted so far. Never exceeds the configured maximum. */
  byteLength(): number;
  /** True once at least one chunk was refused. */
  exceeded(): boolean;
}

/**
 * Bounded byte collector. `maxBytes` undefined / <= 0 means UNBOUNDED, which is
 * the byte-identical legacy path (every chunk accepted, no counter enforced).
 *
 * When the ceiling is crossed the collector keeps the prefix it already had and
 * refuses the rest — it does not throw, so the caller can kill the process and
 * still report how much arrived.
 */
export function createBoundedOutput(maxBytes: number | undefined): BoundedOutput {
  const bounded = typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0;
  const limit = bounded ? Math.floor(maxBytes) : Number.POSITIVE_INFINITY;
  const chunks: Buffer[] = [];
  let accepted = 0;
  let refused = false;

  return {
    push(chunk: Buffer): PushOutcome {
      if (refused) return 'exceeded';
      if (!bounded) {
        chunks.push(chunk);
        accepted += chunk.byteLength;
        return 'ok';
      }
      const remaining = limit - accepted;
      if (chunk.byteLength <= remaining) {
        chunks.push(chunk);
        accepted += chunk.byteLength;
        // Landing EXACTLY on the limit is not a breach — the next chunk is.
        return 'ok';
      }
      if (remaining > 0) {
        chunks.push(chunk.subarray(0, remaining));
        accepted += remaining;
      }
      refused = true;
      return 'exceeded';
    },
    text(): string {
      return chunks.length === 0 ? '' : Buffer.concat(chunks).toString('utf8');
    },
    byteLength(): number {
      return accepted;
    },
    exceeded(): boolean {
      return refused;
    },
  };
}
