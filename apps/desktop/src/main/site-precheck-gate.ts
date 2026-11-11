/**
 * SitePrecheckGate (D-134) — §3.4's "only a settled UNSUPPORTED may block".
 *
 * WHY THIS IS ITS OWN MODULE: three different entry points must apply the SAME
 * rule (a single URL from the paste box, N lines from a TXT import, N entries
 * from a playlist). Copying the predicate three times is how the fourth entry
 * point ends up with a slightly different rule — the exact class of bug this
 * project keeps paying for. One implementation, three callers.
 *
 * THE ASYMMETRY THAT DECIDES EVERYTHING (measured, see D-134):
 *   The engine claims every http(s) URL (GenericIE is always present), so its
 *   failure wording conflates "no extractor exists" with "this page has no
 *   media". A pre-check is therefore a WEAK signal and must be treated as one:
 *     - blocking wrongly  => a URL the engine could download is refused, and the
 *                            user has no way to override it;
 *     - passing wrongly   => the download fails later with the engine's own,
 *                            accurate error — which is the status quo.
 *   So the gate fails OPEN on everything it is unsure about, including its own
 *   errors. `UNSUPPORTED` is the ONLY blocking state.
 *
 * BOUNDING: a pre-check is one `--simulate` run per URL. A 200-line import must
 * not become 200 simultaneous engines, so checks run through a small worker
 * pool. Beyond `maxChecks` URLs the gate stops checking and PASSES the rest —
 * never blocks on a URL it did not actually examine, and reports the count it
 * skipped so the caller can be honest about it.
 */
import type { UrlSupportResult } from '@ytvdlt/shared';
import { blocksEnqueue } from '@ytvdlt/shared';

/** The narrow slice the gate needs; `SiteSupportService` satisfies it. */
export interface PrecheckPortLike {
  check(url: string): Promise<UrlSupportResult>;
}

/**
 * How many URLs in one batch are pre-checked before the rest are passed
 * unchecked. Sized so a normal import (≤200 lines) is fully covered while a
 * 5,000-entry playlist cannot turn "confirm" into a 20-minute wait.
 */
export const MAX_PRECHECK_URLS_PER_BATCH = 64;

/** Simultaneous pre-checks. Each is a real engine process, so this stays small. */
export const PRECHECK_CONCURRENCY = 3;

export interface PrecheckBlock {
  readonly url: string;
  readonly state: UrlSupportResult['state'];
  /** Stable code for the renderer's copy; never engine stderr. */
  readonly code: string;
  readonly reason: string;
}

export interface PrecheckOutcome {
  /** URLs that may be enqueued, in the ORIGINAL order, with duplicates preserved. */
  readonly allowed: readonly string[];
  /** Only the URLs the engine settled as UNSUPPORTED, with a stable code. */
  readonly blocked: readonly PrecheckBlock[];
  /** How many URLs were never examined because `maxChecks` was reached. */
  readonly skipped: number;
  /** Non-blocking observations (NO_MEDIA / INDETERMINATE / TIMEOUT). Advisory. */
  readonly notes: readonly PrecheckBlock[];
  /**
   * R1-03 — the three-way count the requirement asks for, plus what was never
   * examined.
   *
   * WHY IT IS PART OF THE OUTCOME, not something a caller derives: every caller
   * that had to derive it got it wrong. `blocked.length` looks like "how many
   * were refused" but silently omits the URLs that failed as NO_MEDIA or
   * INDETERMINATE, and `notes` was not read by ANY caller — so a batch of 40
   * links could report "34 enqueued, 0 failed" while 6 were never confirmed and
   * the UI implied full coverage. The counts are produced HERE, from the same
   * verdicts the gate acted on, so a caller cannot report a number the gate did
   * not see.
   *
   * INVARIANT: supported + unsupported + noMedia + indeterminate + skipped
   * === the number of URLs passed in (duplicates counted once, because a
   * repeated line is ONE engine check and the gate reports checks).
   */
  readonly summary: PrecheckSummary;
}

/**
 * R1-03 — the batch's pre-check arithmetic.
 *
 * `indeterminate` deliberately absorbs TIMEOUT + CANCELLED + our own throws:
 * from the user's point of view all three mean the same thing — "we did not
 * confirm this one, the download will decide". The URL lists exist so the UI can
 * name the specific links instead of only counting them.
 */
export interface PrecheckSummary {
  readonly examined: number;
  readonly supported: number;
  readonly unsupported: number;
  readonly noMedia: number;
  readonly indeterminate: number;
  readonly skipped: number;
  readonly unsupportedUrls: readonly string[];
  readonly noMediaUrls: readonly string[];
  readonly indeterminateUrls: readonly string[];
}

/** The empty summary: "no port" and "no URLs" both mean nothing was examined. */
export function emptyPrecheckSummary(totalUrls: number): PrecheckSummary {
  return {
    examined: 0, supported: 0, unsupported: 0, noMedia: 0, indeterminate: 0,
    skipped: totalUrls,
    unsupportedUrls: [], noMediaUrls: [], indeterminateUrls: [],
  };
}

/**
 * Pre-check a batch of URLs and split it into enqueueable and blocked.
 *
 * Order is preserved and duplicates are NOT collapsed: the caller's batch
 * semantics (and the user's line numbers) depend on position, so deduplicating
 * here would silently change how many tasks get created.
 *
 * `check` is allowed to throw; a throw is counted as "not examined" and PASSES,
 * because our own failure must never be reported as the site's fault.
 */
export async function precheckBatch(
  urls: readonly string[],
  port: PrecheckPortLike | undefined,
  options: {
    readonly maxChecks?: number;
    readonly concurrency?: number;
    /** Called for each verdict so a caller may cache / log without re-asking. */
    readonly onResult?: (result: UrlSupportResult) => void;
  } = {},
): Promise<PrecheckOutcome> {
  // No port = no opinion. Every URL passes, nothing is claimed to be checked.
  if (port === undefined || urls.length === 0) {
    return {
      allowed: [...urls], blocked: [], skipped: urls.length, notes: [],
      // `skipped` is the whole batch: "not checked" is a fact the report must
      // carry, not an omission the UI can mistake for "all supported".
      summary: emptyPrecheckSummary(urls.length),
    };
  }
  const maxChecks = Math.max(0, options.maxChecks ?? MAX_PRECHECK_URLS_PER_BATCH);
  const budget = Math.min(urls.length, maxChecks);
  const examined = urls.slice(0, budget);
  const untouched = urls.slice(budget);

  const verdicts = new Map<string, UrlSupportResult>();
  // In-flight de-duplication. `verdicts` only holds FINISHED answers, so two
  // workers reaching the same repeated line would both spawn an engine before
  // either result landed. Sharing the promise keeps "one link written twice" at
  // exactly one spawn, which is the whole point of the cursor.
  const inFlight = new Map<string, Promise<UrlSupportResult | null>>();
  let cursor = 0;
  const workers = Math.min(
    Math.max(1, options.concurrency ?? PRECHECK_CONCURRENCY),
    Math.max(1, examined.length),
  );
  const decide = (url: string): Promise<UrlSupportResult | null> => {
    const settled = verdicts.get(url);
    if (settled !== undefined) return Promise.resolve(settled);
    const pending = inFlight.get(url);
    if (pending !== undefined) return pending;
    // Our own failure resolves to `null`, not a rejection: a throw must leave
    // the URL UNDECIDED so it passes below, never surfaced as the site's fault.
    const job = (async (): Promise<UrlSupportResult | null> => {
      try {
        const result = await port.check(url);
        verdicts.set(url, result);
        options.onResult?.(result);
        return result;
      } catch {
        return null;
      }
    })();
    inFlight.set(url, job);
    return job;
  };
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= examined.length) return;
      await decide(examined[index] as string);
    }
  }));

  const allowed: string[] = [];
  const blocked: PrecheckBlock[] = [];
  const notes: PrecheckBlock[] = [];
  for (const url of examined) {
    const result = verdicts.get(url);
    if (result === undefined) { allowed.push(url); continue; }
    if (blocksEnqueue(result.state)) {
      blocked.push({
        url,
        state: result.state,
        code: result.extractor === '' ? 'SITE_UNSUPPORTED' : 'ITEM_UNSUPPORTED',
        reason: result.reason,
      });
      continue;
    }
    if (result.state !== 'SUPPORTED') {
      notes.push({ url, state: result.state, code: result.state, reason: result.reason });
    }
    allowed.push(url);
  }
  // Skipped-for-budget URLs PASS, and they are counted separately from the
  // examined ones so the report can never imply full coverage.
  allowed.push(...untouched);
  return {
    allowed,
    blocked,
    skipped: untouched.length,
    notes,
    summary: summarizeExamination(examined, verdicts, untouched.length),
  };
}

/**
 * R1-03 — fold the per-URL verdicts into the batch's counts.
 *
 * Counted LINE-WISE over `examined`, one entry per submitted URL, so that
 * `supported + unsupported + noMedia + indeterminate + skipped` equals exactly
 * the number of URLs the caller handed in. That is the number the user is
 * reconciling against ("I imported 40 links, where did they all go?"), so a
 * de-duplicated count would be the wrong arithmetic even though the gate runs
 * one engine per unique URL.
 *
 * A URL with NO verdict threw inside `port.check()`. It passed (fail-open) and
 * it is reported under `indeterminate` — the honest reading is "we did not
 * confirm it", never "it is fine".
 */
function summarizeExamination(
  examined: readonly string[],
  verdicts: ReadonlyMap<string, UrlSupportResult>,
  skipped: number,
): PrecheckSummary {
  const unsupportedUrls: string[] = [];
  const noMediaUrls: string[] = [];
  const indeterminateUrls: string[] = [];
  let supported = 0;
  let unconfirmed = 0;
  for (const url of examined) {
    const result = verdicts.get(url);
    if (result === undefined) {
      unconfirmed += 1;
      indeterminateUrls.push(url);
      continue;
    }
    if (result.state === 'SUPPORTED') { supported += 1; continue; }
    if (result.state === 'UNSUPPORTED') { unsupportedUrls.push(url); continue; }
    if (result.state === 'NO_MEDIA') { noMediaUrls.push(url); continue; }
    // INDETERMINATE / TIMEOUT / CANCELLED — all "not confirmed".
    indeterminateUrls.push(url);
  }
  return {
    examined: unsupportedUrls.length + noMediaUrls.length + indeterminateUrls.length + supported,
    supported,
    unsupported: unsupportedUrls.length,
    noMedia: noMediaUrls.length,
    indeterminate: indeterminateUrls.length,
    skipped,
    unsupportedUrls,
    noMediaUrls,
    indeterminateUrls,
  };
}
