/**
 * TASK-03 (A) — parse `yt-dlp --list-extractors` output. PURE: no I/O.
 *
 * WHAT THE ENGINE ACTUALLY PRINTS (measured against the bundled 2026.10.26,
 * 1755 lines / 23,500 bytes, pure ASCII — see D-134):
 *
 *   youtube
 *   youtube:channel
 *   youtubetab:playlist
 *   20min (CURRENTLY BROKEN)
 *   generic
 *
 * Three facts the parser is built around:
 *   1. `name:variant` is a SUB-extractor. It is not an independent site; a
 *      "sites" count that includes them is inflated by ~400 here and would be
 *      a number we could not defend.
 *   2. `(CURRENTLY BROKEN)` is the ENGINE'S OWN judgement, kept verbatim. We
 *      never re-derive it and never hide it.
 *   3. `generic` is present and must be surfaced separately — see
 *      `ExtractorInfo.isGeneric`.
 *
 * THE FORMAT IS NOT A CONTRACT. It is human-readable stdout, so every rule here
 * degrades instead of throwing: an unknown suffix stays part of the name rather
 * than being silently dropped, and a duplicated name is counted once.
 *
 * WHY `--extractor-descriptions` IS NOT USED: measured on the same binary, its
 * output is NOT UTF-8 — it is the Windows ANSI code page (`BaiduVideo: 百度视频`
 * arrives as `B0 D9 B6 C8 CA D3 C6 B5` = cp936). Feeding those bytes through a
 * UTF-8 decode produces mojibake, and decoding as cp936 would be wrong on any
 * non-Chinese Windows. `--list-extractors` is ASCII-only, so it is the source.
 */
import type { ExtractorInfo } from '@ytvdlt/shared';

/** The engine's own marker for an extractor it knows to be broken. */
const BROKEN_SUFFIX = ' (CURRENTLY BROKEN)';

/** The fallback extractor: attempts any page, guarantees nothing. */
const GENERIC_NAME = 'generic';

export interface ParsedExtractorList {
  readonly extractors: readonly ExtractorInfo[];
  readonly siteCount: number;
  readonly subExtractorCount: number;
  readonly brokenCount: number;
  readonly empty: boolean;
}

/**
 * Turn raw `--list-extractors` stdout into a display-safe list.
 *
 * Ordering is deliberately NOT normalised: the engine's order is stable between
 * runs on one build, and the UI does its own sorting. Re-ordering here would
 * hide an engine change from the diff.
 */
export function parseExtractorList(stdout: string): ParsedExtractorList {
  const extractors: ExtractorInfo[] = [];
  const indexByName = new Map<string, number>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === '') continue;

    // Strip the broken marker BEFORE de-duplicating, so `foo` and
    // `foo (CURRENTLY BROKEN)` cannot both be counted as separate sites.
    const broken = trimmed.endsWith(BROKEN_SUFFIX);
    const name = broken ? trimmed.slice(0, -BROKEN_SUFFIX.length).trim() : trimmed;
    if (name === '') continue;

    const key = name.toLowerCase();
    const existing = indexByName.get(key);
    if (existing !== undefined) {
      // The marker is STICKY, whichever order the two rows arrive in: an
      // engine that CALLED this extractor broken must not end up displayed as
      // healthy. Letting the first row win would make the flag depend on line
      // order — a silent behaviour change for the same input set.
      if (broken) {
        const entry = extractors[existing];
        if (entry !== undefined) extractors[existing] = { ...entry, broken: true };
      }
      continue;
    }
    indexByName.set(key, extractors.length);

    const colon = name.indexOf(':');
    extractors.push({
      name,
      parent: colon === -1 ? '' : name.slice(0, colon),
      broken,
      isGeneric: key === GENERIC_NAME,
    });
  }

  const subExtractorCount = extractors.filter((entry) => entry.parent !== '').length;
  return {
    extractors,
    // `generic` is excluded from the "sites" count on purpose: it is not a site,
    // and counting it would let the UI imply one more supported service.
    siteCount: extractors.filter((entry) => entry.parent === '' && !entry.isGeneric).length,
    subExtractorCount,
    brokenCount: extractors.filter((entry) => entry.broken).length,
    empty: extractors.length === 0,
  };
}

/**
 * TASK-03 (B) — classify a failed pre-check from the engine's own stderr.
 *
 * This is the ONLY place a URL may be declared UNSUPPORTED, and the bar is
 * deliberately high: a timeout, an HTTP error or an auth wall is NOT evidence
 * of unsupportedness, so those become INDETERMINATE and a bad minute on the
 * network can never permanently block a URL.
 *
 * WHY BARE `Unsupported URL:` IS **NOT** UNSUPPORTED HERE (measured, see
 * D-134 — this is the single least obvious rule in this file):
 *
 *   The engine prints the SAME sentence for two different intents:
 *     (a) no extractor exists for this url at all, and
 *     (b) the `generic` extractor DID claim the url, read the page, and found
 *         no media in it.
 *
 *   Verified against the bundled engine by running the same url with `-v`:
 *     /nomedia.html  ->  "[generic] Extracting URL:" ... "Looking for embeds"
 *                        then `ERROR: Unsupported URL: ...` and a real download
 *                        writes zero files.
 *   `generic` is in every build and claims EVERY http(s) url
 *   (`[debug] Loaded 1747 extractors`), so for an http(s) url case (a) is
 *   practically unreachable while case (b) is routine. Treating the bare
 *   sentence as UNSUPPORTED would therefore block ordinary "this page has no
 *   media" cases and mislabel them "site not supported" — exactly the confusion
 *   TASK-03 §3.1/§3.4 forbids ("网站支持 ≠ 视频可用").
 *
 *   So the bare sentence maps to NO_MEDIA, which is a WARNING, not a block.
 *   A false NO_MEDIA just lets a doomed url through to a proper download error;
 *   a false UNSUPPORTED silently forbids a url the engine might have handled.
 *   The asymmetry decides the default.
 *
 *   What remains genuinely UNSUPPORTED is the engine refusing to ROUTE the url
 *   at all — no scheme handler, malformed input — which is knowable and final.
 *
 * The remaining patterns are deliberately duplicated from
 * `core/src/error-mapper/rules.ts` rather than imported: `core` sits ABOVE this
 * package and importing it here would invert the dependency. The two lists are
 * NOT identical on purpose — the download mapper is allowed to be bolder than a
 * gate that can block the user's enqueue.
 */
export function classifySupportFailure(stderr: string): 'UNSUPPORTED' | 'NO_MEDIA' | 'INDETERMINATE' {
  const text = stderr.toLowerCase();

  // (1) The engine cannot even ROUTE this url: nothing will ever download it.
  //     Measured wordings: `'wat' is not a valid URL`,
  //     `Unsupported url scheme: "mailto"`, `file:// URLs are disabled`.
  if (
    /is not a valid url/.test(text)
    || /unsupported url scheme/.test(text)
    || /no suitable extractor/.test(text)
    || /unsupported site/.test(text)
  ) {
    return 'UNSUPPORTED';
  }

  // (2) An extractor claimed the url and found nothing. Includes the bare
  //     `Unsupported URL:` sentence — see the long note above. `unsupported url`
  //     is checked AFTER `unsupported url scheme`, so the routing verdict in (1)
  //     always wins.
  //
  //     R1-04: `/this video is unavailable/` used to live here and MUST NOT.
  //     Measured wordings that matched it:
  //       `ERROR: [youtube] abc: Video unavailable`
  //       `... This video is unavailable in your country`   (geo block)
  //       `... This video has been removed by the uploader` (deleted)
  //     None of those mean "the page has no media": they mean the item exists
  //     but is not retrievable, which §3.4 classifies as INDETERMINATE. Saying
  //     NO_MEDIA there would tell the user "this page has nothing to download"
  //     about a video that is merely region-locked — a wrong, unfixable claim
  //     about the SITE, in the same family as the UNSUPPORTED mistake the note
  //     above spends a paragraph avoiding.
  if (
    /unsupported url/.test(text)
    || /no video formats found/.test(text)
    || /requested format is not available/.test(text)
    || /there is no video/.test(text)
    || /no media found/.test(text)
    || /is not a video/.test(text)
  ) {
    return 'NO_MEDIA';
  }

  // (3) Everything else — network, auth, rate limit, private — is indeterminate.
  //     Deliberately the DEFAULT: guessing "unsupported" from an unfamiliar
  //     message is the one mistake that cannot be undone for the user.
  return 'INDETERMINATE';
}

/**
 * Did an extractor CLAIM this url before failing?
 *
 * Measured shapes of the two families (probe5, see D-134):
 *   claimed  -> `ERROR: [generic] missing: Unable to download webpage: HTTP Error 404`
 *               `ERROR: [youtube] abc: Video unavailable`
 *   unclaimed-> `ERROR: Unsupported URL: http://.../nomedia.html`
 *               `ERROR: Unable to handle request: Unsupported url scheme: "mailto"`
 *
 * Informational only: the state is decided by `classifySupportFailure()`. This
 * exists so a caller can say "the site was recognised but this item failed"
 * instead of "unsupported site".
 */
export function extractorClaimedUrl(stderr: string): boolean {
  return /(?:^|\n)\s*(?:ERROR|WARNING|DEBUG):\s*\[[A-Za-z0-9_.:-]+\]/.test(stderr)
    || /(?:^|\n)\s*\[[A-Za-z0-9_.:-]+\]/.test(stderr);
}

/** Marker for a pre-check that ran out of time. Kept out of `stderr` parsing. */
export const PRECHECK_TIMEOUT_REASON = 'pre-check timed out';
