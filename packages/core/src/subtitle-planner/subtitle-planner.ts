/**
 * SubtitlePlanner — stage-1 UI pure functions (M3-F007).
 *
 * `mergeToMkv` is derived HERE only for a UI hint ("将强制合并为 MKV") and for
 * the stage-2 re-check; it is NEVER written into `PathsDomain` (D-35 / Q-M3-11).
 */
import type {
  MediaInfo, SubtitleDomain, SubtitleSelection,
} from '@ytvdlt/shared';

export interface GroupedLanguages {
  suggested: string[];
  other: string[];
  automatic: string[];
}

export const DEFAULT_SUGGESTED_LANGUAGES: readonly string[] = ['en.*', '.*-orig'];

/** Convert a yt-dlp-like language glob into a case-insensitive anchored regex. */
export function matchesLanguagePattern(lang: string, pattern: string): boolean {
  if (typeof lang !== 'string' || typeof pattern !== 'string') return false;
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return false;
  // yt-dlp language patterns such as `en.*` / `.*-orig` mean "en + anything";
  // a literal dot immediately before `*` is part of the wildcard, not a
  // separator. Collapse `.*` to `*` before building the anchored regex.
  const normalized = trimmed.replace(/\.\*/g, '*');
  let source = '^';
  for (const char of normalized) {
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  source += '$';
  try {
    return new RegExp(source, 'i').test(lang);
  } catch {
    return false;
  }
}

/** Three dialog groups: suggested / other / automatic captions. */
export function groupLanguages(
  media: MediaInfo,
  suggested: readonly string[],
): GroupedLanguages {
  const subtitleKeys = Object.keys(media.subtitles ?? {}).sort();
  const automaticKeys = Object.keys(media.automatic_captions ?? {}).sort();
  const patterns = suggested.length > 0 ? suggested : DEFAULT_SUGGESTED_LANGUAGES;
  const isSuggested = (lang: string): boolean =>
    patterns.some((pattern) => matchesLanguagePattern(lang, pattern));
  return {
    suggested: subtitleKeys.filter(isSuggested),
    other: subtitleKeys.filter((lang) => !isSuggested(lang)),
    automatic: automaticKeys,
  };
}

/** Language-expression validation used for the inline error + confirm gate. */
export function validateLanguageExpression(expr: string): { valid: boolean; reason: string | null } {
  if (typeof expr !== 'string' || expr.trim().length === 0) {
    return { valid: false, reason: '语言表达式不能为空' };
  }
  if (/[\s\u0000-\u001f\u007f]/.test(expr)) {
    return { valid: false, reason: '语言表达式不能包含空白或控制字符' };
  }
  if (!/^[A-Za-z0-9_.,*\-:]+$/.test(expr)) {
    return { valid: false, reason: '语言表达式包含非法字符' };
  }
  if (expr.split(',').some((token) => token.length === 0)) {
    return { valid: false, reason: '存在空的语言项' };
  }
  return { valid: true, reason: null };
}

export interface PlanSubtitlesResult {
  subtitle: SubtitleDomain;
  mergeToMkv: boolean;
  warnings: string[];
}

/** Dialog selection -> legal SubtitleDomain (A-4.3-08, R3) + UI-only hint. */
export function planSubtitles(
  media: MediaInfo,
  current: SubtitleDomain,
  sel: SubtitleSelection,
  mode: 'video' | 'audio',
): PlanSubtitlesResult {
  const warnings: string[] = [];
  const languages = sel.languages ?? [];
  const joined = languages.join(',');
  const validation = validateLanguageExpression(joined);
  if (languages.length > 0 && !validation.valid) {
    warnings.push(`非法语言表达式：${validation.reason ?? 'unknown'}`);
  }
  const grouped = groupLanguages(media, DEFAULT_SUGGESTED_LANGUAGES);
  if (grouped.suggested.length === 0 && grouped.other.length === 0 && grouped.automatic.length === 0) {
    warnings.push('解析结果中没有任何字幕语言，可手动输入表达式');
  }

  const known = new Set([
    ...Object.keys(media.subtitles ?? {}),
    ...Object.keys(media.automatic_captions ?? {}),
  ]);
  for (const lang of languages) {
    if (!lang.includes('*') && !known.has(lang)) {
      warnings.push(`语言 ${lang} 未出现在解析结果中`);
    }
  }

  // A-4.3-08: selecting ANY language forces enabled=true.
  const enabled = languages.length > 0;
  // R3 / P1: audio mode can NEVER embed subtitles.
  const embed = mode === 'video' ? sel.embed : false;
  if (mode === 'audio' && sel.embed) {
    warnings.push('仅音频模式不可嵌入字幕（R3）');
  }
  const mergeToMkv = embed && mode === 'video';

  const subtitle: SubtitleDomain = {
    ...current,
    enabled,
    languages: joined,
    autoCaptions: sel.autoCaptions,
    skipTranslated: sel.skipTranslated,
    convertTo: sel.convertTo,
    embed,
    keepSubtitleFile: sel.keepSubtitleFile,
  };
  return { subtitle, mergeToMkv, warnings };
}
