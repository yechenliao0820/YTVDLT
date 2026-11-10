/**
 * Requested-vs-produced subtitle reconciliation (stage 4).
 *
 * "Task Completed" used to be the only signal the UI had, and yt-dlp exits 0
 * even when a requested language simply does not exist on the site ("Unable to
 * download video subtitles for 'xx'" is a warning, not an error). The result was
 * a green card for a download that got no subtitles at all.
 *
 * This module answers the question honestly, WITHOUT turning that situation
 * into `Error` (D-127): the video is fine, the attachment is not.
 */
import type { AttachmentProbe, MediaInfo, SubtitleDomain, SubtitleFileLink, SubtitleOutcome } from '@ytvdlt/shared';
import { isMediaArtifact } from './kinds.js';

/**
 * yt-dlp's `--sub-langs` grammar, reduced to what the app can emit:
 * a comma separated list of regexes, `all`, and `-`-prefixed exclusions.
 *
 * The match is FULL (`^…$`), not a prefix — measured on the bundled yt-dlp
 * 2026.10.26: `--sub-langs en` with a page offering `en` AND `en-orig` writes
 * only `en`. That is also why the documented idiom for variants is `en.*`.
 *
 * Unknown/invalid regex text is treated as a literal instead of throwing:
 * a malformed expression must not crash a completed download's bookkeeping.
 */
export function matchLanguageExpression(expression: string, available: readonly string[]): string[] {
  const raw = typeof expression === 'string' ? expression : '';
  const tokens = raw.split(',').map((token) => token.trim()).filter((token) => token.length > 0);
  if (tokens.length === 0) return [...available];

  const includes = tokens.filter((token) => !token.startsWith('-'));
  const excludes = tokens.filter((token) => token.startsWith('-')).map((token) => token.slice(1));
  const matchesAll = includes.some((token) => token.toLowerCase() === 'all');

  const toMatcher = (token: string): ((value: string) => boolean) => {
    try {
      const regex = new RegExp(`^(?:${token})$`);
      return (value: string): boolean => regex.test(value);
    } catch {
      return (value: string): boolean => value === token;
    }
  };
  const includeMatchers = includes.filter((token) => token.toLowerCase() !== 'all').map(toMatcher);
  const excludeMatchers = excludes.filter((token) => token.length > 0).map(toMatcher);

  return available.filter((language) => {
    if (excludeMatchers.some((match) => match(language))) return false;
    if (matchesAll) return true;
    return includeMatchers.some((match) => match(language));
  });
}

/** Languages the request could possibly have produced, per the probe. */
export function requestableLanguages(subtitle: SubtitleDomain | null, mediaInfo: MediaInfo | null): string[] {
  if (subtitle === null || mediaInfo === null) return [];
  const manual = subtitle.enabled || (subtitle.embed && !subtitle.autoCaptions)
    ? Object.keys(mediaInfo.subtitles ?? {}).filter((language) => (mediaInfo.subtitles?.[language]?.length ?? 0) > 0)
    : [];
  const automatic = subtitle.autoCaptions
    ? Object.keys(mediaInfo.automatic_captions ?? {}).filter((language) => (mediaInfo.automatic_captions?.[language]?.length ?? 0) > 0)
    : [];
  return [...new Set([...manual, ...automatic])];
}

/**
 * Did the run deliver what was asked?
 *
 * - no subtitle intent          → `none`
 * - intent, nothing produced    → `missing`
 * - every requested lang there  → `ok`
 * - some requested lang missing → `partial`
 *
 * Defensive rule: if the expression cannot be matched against the probe buckets
 * but files DID arrive, report `ok`. Refusing to call a delivered file "missing"
 * because of a matcher disagreement would be the worse lie.
 */
export function evaluateSubtitleOutcome(input: {
  readonly subtitle: SubtitleDomain | null;
  readonly mediaInfo: MediaInfo | null;
  readonly links: readonly SubtitleFileLink[];
  readonly attachments?: readonly AttachmentProbe[];
}): SubtitleOutcome {
  const { subtitle, mediaInfo } = input;
  if (subtitle === null || !(subtitle.enabled || subtitle.autoCaptions || subtitle.embed)) return 'none';
  const failedPaths = new Set(input.attachments?.filter((probe) => probe.kind === 'subtitle' && probe.status === 'FAIL')
    .map((probe) => probe.path));
  const links = input.links.filter((link) => !failedPaths.has(link.path));
  const embedded = subtitle.embed && input.attachments?.some((probe) => probe.kind === 'subtitle'
    && isMediaArtifact(probe.path) && probe.status === 'PASS') === true;
  const needsFiles = subtitle.enabled || subtitle.autoCaptions;
  if (links.length === 0) return embedded ? (needsFiles ? 'partial' : 'ok') : 'missing';

  const matched = matchLanguageExpression(subtitle.languages, requestableLanguages(subtitle, mediaInfo));
  const produced = new Set(links.map((link) => link.language).filter((language) => language !== ''));
  const missing = matched.filter((language) => !produced.has(language));
  const filesOutcome = matched.length === 0 || produced.size === 0 || missing.length === 0
    ? 'ok' : missing.length === matched.length ? 'missing' : 'partial';
  if (subtitle.embed && !embedded) return filesOutcome === 'missing' ? 'missing' : 'partial';
  if (embedded && filesOutcome === 'missing') return needsFiles ? 'partial' : 'ok';
  return filesOutcome;
}
