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
