/**
 * mergeSubtitleChoice — the per-task subtitle decision (stage 3).
 *
 * Input is what the user actually clicked (a set of language codes plus three
 * switches) and what the video actually offers (the `SubtitleTrackPreview[]`
 * produced by the preview that is still held in the main process). Output is a
 * `SubtitleDomain` PATCH — the same frozen domain `buildDownloadRequest()`
 * already understands, so no second request model exists.
 *
 * Why not reuse `planSubtitles()`:
 *   it derives `enabled` from `languages.length > 0`, which is precisely the
 *   audit R1 defect — a user who picks only automatic captions would silently
 *   get `--write-subs` (manual) as well, and an `enabled === false` request
 *   would lose the language filter entirely. Overriding its `enabled` from the
 *   outside would leave two sources of truth for the same field, so the
 *   availability-aware rule lives here instead. Both functions still emit the
 *   SAME `SubtitleDomain`; `planSubtitles` keeps serving the M3 dialog, whose
 *   fixture-driven behaviour must not change under a screenshot baseline.
 *
 * Pure: no I/O, no clock, never throws.
 */
import type { SubtitleDomain, SubtitleTrackPreview } from '@ytvdlt/shared';
import { validateLanguageExpression } from './subtitle-planner.js';
import { normalizeLanguageCode } from '../subtitle-preview/build-subtitle-preview.js';

/** A person does not pick 30 subtitle languages; this is also a cheap IPC guard. */
export const MAX_SUBTITLE_LANGUAGES = 12;

export interface SubtitleChoice {
  /** Exact yt-dlp language codes (`en`, `zh-Hans`), NOT glob patterns. */
  readonly languages: readonly string[];
  /** Also download automatic captions for the selected languages. */
  readonly includeAutomatic: boolean;
  readonly convertTo: SubtitleDomain['convertTo'];
  /** Embed as a soft subtitle track (video only; implies a remux to MKV). */
  readonly embed: boolean;
  /** With `embed`: also keep the external subtitle file next to the video. */
  readonly keepSubtitleFile: boolean;
}

export type SubtitleChoiceWarningCode =
  | 'SUBTITLE_LANGUAGE_UNKNOWN'
  | 'SUBTITLE_NO_MANUAL_TRACK'
  | 'SUBTITLE_NO_AUTOMATIC_TRACK'
  | 'SUBTITLE_EMBED_IGNORED_AUDIO'
  | 'SUBTITLE_EMBED_NEEDS_MANUAL'
  | 'SUBTITLE_TOO_MANY_LANGUAGES'
  | 'SUBTITLE_EXPRESSION_INVALID';

export interface SubtitleChoiceWarning {
  readonly code: SubtitleChoiceWarningCode;
  readonly detail: string;
}

export interface SubtitleChoiceResult {
  /** `false` means "not one requested language exists" — the caller must refuse. */
  readonly usable: boolean;
  /** Patch merged over the configured subtitle defaults, never a whole request. */
  readonly patch: Partial<SubtitleDomain>;
  readonly acceptedLanguages: readonly string[];
  readonly warnings: readonly SubtitleChoiceWarning[];
}

export interface MergeSubtitleChoiceInput {
  readonly choice: SubtitleChoice;
  /** Availability projected from the previewed `MediaInfo` (main process only). */
  readonly available: readonly SubtitleTrackPreview[];
  /** Current config defaults, preserved for fields the user did not touch. */
  readonly current?: Partial<SubtitleDomain>;
  readonly mode: 'video' | 'audio';
}

const CONVERT_VALUES: readonly SubtitleDomain['convertTo'][] = ['none', 'ass', 'srt', 'vtt', 'lrc'];

function dedupe(codes: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of codes) {
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/**
 * Turn a user selection into a legal subtitle patch.
 *
 * The three switches are INDEPENDENT on purpose:
 *   - `enabled` (→ `--write-subs`) only when a MANUAL track exists for a
 *     selected language;
 *   - `autoCaptions` (→ `--write-auto-subs`) only when an AUTOMATIC track does;
 *   - `embed` only in video mode and only when a manual track exists (embedding
 *     an automatic-only language is not a behaviour this product promises).
 *
 * Unknown codes are dropped rather than forwarded: a stale preview (the video
 * changed, or the page sent a language the probe never saw) must not reach
 * `--sub-langs`, where it would silently download nothing.
 */
export function mergeSubtitleChoice(input: MergeSubtitleChoiceInput): SubtitleChoiceResult {
  const warnings: SubtitleChoiceWarning[] = [];
  const current = input.current ?? {};
  const availableByCode = new Map(input.available.map((track) => [track.languageCode, track]));

  const normalized = dedupe(
    (Array.isArray(input.choice.languages) ? input.choice.languages : [])
      .map((code) => normalizeLanguageCode(code))
      .filter((code): code is string => code !== null),
  );
  const requested = normalized.slice(0, MAX_SUBTITLE_LANGUAGES);
  if (normalized.length > MAX_SUBTITLE_LANGUAGES) {
    warnings.push({
      code: 'SUBTITLE_TOO_MANY_LANGUAGES',
      detail: `最多支持 ${MAX_SUBTITLE_LANGUAGES} 种字幕语言，多余的已忽略`,
    });
  }
  const accepted = requested.filter((code) => availableByCode.has(code));
  const unknown = requested.filter((code) => !availableByCode.has(code));
  if (unknown.length > 0) {
    warnings.push({
      code: 'SUBTITLE_LANGUAGE_UNKNOWN',
      detail: `解析结果中没有这些语言：${unknown.join(', ')}`,
    });
  }
  if (accepted.length === 0) {
    return { usable: false, patch: {}, acceptedLanguages: [], warnings };
  }

  const manual = accepted.filter((code) => availableByCode.get(code)?.manualAvailable === true);
  const automatic = accepted.filter((code) => availableByCode.get(code)?.automaticAvailable === true);
  if (!input.choice.includeAutomatic && accepted.some((code) => !manual.includes(code))) {
    warnings.push({ code: 'SUBTITLE_NO_MANUAL_TRACK', detail: '所选语言含仅自动字幕，请启用自动字幕或移除这些语言' });
    return { usable: false, patch: {}, acceptedLanguages: accepted, warnings };
  }
  if (manual.length === 0) {
    warnings.push({ code: 'SUBTITLE_NO_MANUAL_TRACK', detail: '所选语言没有人工字幕，不会请求人工字幕' });
  }
  if (input.choice.includeAutomatic && automatic.length === 0) {
    warnings.push({ code: 'SUBTITLE_NO_AUTOMATIC_TRACK', detail: '所选语言没有自动字幕，已忽略自动字幕选项' });
  }

  // R3 (M3) stays the resolver's job: audio mode can never embed. Refuse here
  // too so the user gets an explicit reason instead of a silent downgrade.
  let embed = input.choice.embed === true;
  if (embed && input.mode === 'audio') {
    embed = false;
    warnings.push({ code: 'SUBTITLE_EMBED_IGNORED_AUDIO', detail: '仅音频模式不能内嵌字幕（R3）' });
  } else if (embed && manual.length === 0) {
    embed = false;
    warnings.push({ code: 'SUBTITLE_EMBED_NEEDS_MANUAL', detail: '内嵌需要人工字幕轨道，已降级为外置' });
  }

  const expression = accepted.join(',');
  if (!validateLanguageExpression(expression).valid) {
    warnings.push({ code: 'SUBTITLE_EXPRESSION_INVALID', detail: '语言表达式非法，已拒绝本次字幕选择' });
    return { usable: false, patch: {}, acceptedLanguages: accepted, warnings };
  }

  const autoCaptions = input.choice.includeAutomatic === true && automatic.length > 0;
  const convertTo = CONVERT_VALUES.includes(input.choice.convertTo) ? input.choice.convertTo : 'none';

  return {
    usable: true,
    acceptedLanguages: accepted,
    warnings,
    patch: {
      // The only switch that produces `--write-subs`.
      enabled: manual.length > 0,
      languages: expression,
      autoCaptions,
      // Preserved from config: `--extractor-args youtube:skip=translated_subs`
      // is a site workaround, not part of this UI's decision.
      skipTranslated: current.skipTranslated !== false,
      convertTo,
      embed,
      // Only meaningful together with `embed`; otherwise the external file is
      // the deliverable and there is nothing to "keep".
      keepSubtitleFile: embed ? input.choice.keepSubtitleFile === true : current.keepSubtitleFile === true,
    },
  };
}
