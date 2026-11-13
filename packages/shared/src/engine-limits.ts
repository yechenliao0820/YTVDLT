/**
 * D-133 (TASK-02) — output ceilings for BOUNDED metadata jobs.
 *
 * WHY THIS LIVES IN `shared`: the ceiling constant and the overflow marker are
 * consumed from BOTH sides of a layer boundary — `packages/engine-ytdlp` decides
 * *how much* to allow, and `apps/desktop/src/main/adapters/node-ports.ts`
 * enforces it and stamps the marker into `stderr`. `engine-ytdlp` is a pure
 * package and may never import from `apps/desktop`, so the shared vocabulary
 * has to sit here. Constants only: no implementation, no `node:*`, no
 * `electron` (see the `packages/shared/src/index.ts` contract note).
 *
 * WHAT THIS IS NOT: a general cap on child output. A normal download streams
 * megabytes of progress lines by design and passes NO limit, so it keeps the
 * legacy unbounded behaviour byte for byte. Only the bounded metadata spawns
 * (`version` / `probe` / `probePlaylist`) opt in — every one of them runs a
 * single `--dump-single-json` / `--version` and exits, so its output size is
 * decided by the metadata, not by the network duration.
 *
 * HOW THE NUMBERS WERE CHOSEN — measured, not guessed (evidence in
 * `reports/live-audit/`, recorded in D-132):
 *   - a single-video full probe (`video.json`) = 678,386 B, dominated by the
 *     formats table and the automatic-caption language list (157 entries);
 *   - a flat 20-entry playlist probe (`playlist.json`) = 30,045 B, i.e. about
 *     1,502 B per entry;
 *   - a minimal playlist fixture = 554 B.
 *
 *   stdout 16 MiB → ~24x the measured single-video probe, and ~11,000 entries
 *                   of a flat playlist, which is above `MAX_PLAYLIST_ITEMS`
 *                   (500) and above the ~5,000 a YouTube playlist can hold.
 *                   A truncated `--dump-single-json` fails `JSON.parse` and
 *                   surfaces as an error, never as a silently short list, so
 *                   the ceiling has to sit far above any legitimate document.
 *   stderr 1 MiB  → yt-dlp's whole diagnostic output for one job is a handful
 *                   of lines (a warning is a few hundred bytes); this is a
 *                   runaway guard, not a working buffer.
 *
 * The ceilings are a BACKSTOP against an unbounded `+=` string, not a tuned
 * threshold: the goal is a bounded, explainable failure instead of a main
 * process that grows until it stalls.
 */

/** D-133: hard ceiling on collected stdout for one bounded metadata spawn, in BYTES. */
export const METADATA_MAX_STDOUT_BYTES = 16 * 1024 * 1024;

/** D-133: independent ceiling on collected stderr for one bounded metadata spawn, in BYTES. */
export const METADATA_MAX_STDERR_BYTES = 1 * 1024 * 1024;

/**
 * D-133: appended to `stderr` when a ceiling was hit.
 *
 * Two independent consumers depend on this exact string:
 *   - the engine watches for it to explain the failure as an output overflow
 *     instead of a generic `UNKNOWN` from the keyword table;
 *   - the tests assert on it to prove the guard fired rather than the child
 *     happening to exit non-zero.
 *
 * It deliberately contains NO keyword that `core/src/error-mapper/rules.ts`
 * matches (`timeout`, `denied`, `429`, …) so an overflow can never be
 * mislabelled as a network or permission problem.
 */
export const OUTPUT_LIMIT_MARKER = '[ytvdlt] output limit exceeded: child terminated';

/**
 * D-137 (F-03): appended to `stderr` when an overflow/timeout kill was issued
 * but the process tree's exit could NOT be confirmed within the bounded grace
 * period. Emitting a kill is not the same as having stopped the child (§9 坑 21:
 * `child.kill()` leaves a onefile bootloader running), and the old path simply
 * resolved the promise without ever looking at the kill result.
 *
 * Like OUTPUT_LIMIT_MARKER this is a neutral, fixed string with no keyword from
 * `error-mapper/rules.ts`, so it cannot be mislabelled as a network failure.
 * It is a DIAGNOSTIC, not a guarantee: `exitCode: null` is what keeps every
 * success path closed.
 */
export const TERMINATION_UNCONFIRMED_MARKER = '[ytvdlt] child tree termination unconfirmed';

/**
 * D-144: per-stream ceiling on the RETAINED TAIL of one streaming (download)
 * spawn, in BYTES. Unlike D-133 this never terminates the child — a normal
 * download legitimately streams megabytes of progress by design — it only
 * bounds the diagnostic copy the main process keeps in memory. The realtime
 * `onChunk` callback is unaffected and still sees every byte.
 *
 * Same magnitude as D-133's stderr backstop: yt-dlp's diagnostic output for a
 * failed job is a handful of ending lines, so 1 MiB of tail is generous.
 */
export const STREAM_TAIL_MAX_BYTES = 1 * 1024 * 1024;

/**
 * D-144: placed ONCE, at the FRONT, of a stream's retained tail when earlier
 * bytes were discarded to hold the ceiling. Front, not appended like
 * OUTPUT_LIMIT_MARKER: it describes the data that follows, and the END of the
 * tail must stay pristine because error diagnosis reads the last lines.
 *
 * Neutral like OUTPUT_LIMIT_MARKER / TERMINATION_UNCONFIRMED_MARKER: it
 * contains no keyword from `core/src/error-mapper/rules.ts`, so a truncated
 * log can never be mislabelled as a network or permission failure, and the
 * fact it states is "this log is not complete", nothing more.
 */
export const STREAM_TAIL_TRUNCATED_MARKER =
  '[ytvdlt] stream tail truncated: earlier output discarded';

/**
 * D-153 (T6): ceiling on the streaming (download) stdout LINE-ASSEMBLY buffer,
 * in BYTES. `parseProgressChunk` hands back the last unterminated line as
 * `rest`, and the engine used to accumulate it with an unbounded `+=` — stdout
 * that never emits a newline grew that string without limit for as long as the
 * child ran. This is the stdout sibling of D-144's stderr tail ceiling.
 *
 * Unlike D-133 (kill on overflow) and unlike the D-144 diagnostic tail (whose
 * content feeds the error mapper), this buffer is a WORKING parse buffer: when
 * the ceiling is hit the OLDEST prefix is dropped so the most recent bytes
 * survive, the drop is counted, and one WARNING is logged after the run ends.
 * Nothing is thrown and the child is never terminated. Real yt-dlp progress
 * lines are ~100 bytes and always end in a newline, so a normal download never
 * comes near the ceiling — 1 MiB is the same backstop magnitude as
 * STREAM_TAIL_MAX_BYTES, chosen to bound memory, not as a tuned threshold.
 */
export const PROGRESS_PENDING_MAX_BYTES = 1 * 1024 * 1024;
