/**
 * Advisory attachment probes (stage 4, D-127).
 *
 * C1–C12 answer one question: "is the downloaded media trustworthy?".
 * Attachments need a different verdict, because:
 *  - a site can serve an HTML login page with a `.srt` name (very common), and
 *  - a container can silently refuse to embed a subtitle stream.
 * Neither makes the video corrupt, and neither may flip a task to `Error`
 * (that was the pre-stage-4 behaviour of "C9 fails ⇒ ARTIFACT_INCOMPLETE").
 *
 * These probes are reported in `VerificationReport.attachments` and are
 * consumed by the queue to annotate the record (`subtitleOutcome`). They never
 * feed `ok`, `failureCode` or C12.
 */
import type { AttachmentProbe } from '@ytvdlt/shared';
import type { CheckContext } from './criteria.js';
import { extOf, primaryArtifact } from './criteria.js';
import { isSubtitleArtifact } from '../artifact-classify/kinds.js';
import { matchLanguageExpression, requestableLanguages } from '../artifact-classify/requested.js';

/** Enough for a header check; a subtitle file is text, not a payload. */
const SNIFF_BYTES = 8192;
const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024;

const HTML_PAGE = /^\uFEFF?\s*(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i;

interface FormatRule {
  readonly test: (text: string) => boolean;
  readonly expected: string;
}

/**
 * Format header rules for the subtitle extensions yt-dlp can write.
 *
 * Deliberately shallow: the goal is to catch "this is not a subtitle at all"
 * (HTML error page, binary garbage, truncated download), not to be a full
 * WebVTT/TTML/ASS validator. A real parser would reject files that every
 * player accepts, which is a worse false positive than missing a rare defect.
 */
const FORMAT_RULES: Readonly<Record<string, FormatRule>> = {
  vtt: { expected: 'WEBVTT header', test: (text) => /^WEBVTT(\s|$)/.test(text) },
  srt: { expected: 'an SRT cue index + timestamp', test: (text) => /\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(text) },
  ass: { expected: '[Script Info] / [Events] section', test: (text) => /\[Script Info\]|\[Events\]/i.test(text) },
  ssa: { expected: '[Script Info] / [Events] section', test: (text) => /\[Script Info\]|\[Events\]/i.test(text) },
  lrc: { expected: '[mm:ss.xx] lyric timestamps', test: (text) => /\[\d{1,3}:\d{2}([.:]\d{1,3})?\]/.test(text) },
  ttml: { expected: 'a <tt> XML root', test: (text) => /<tt[\s>]/i.test(text) },
  dfxp: { expected: 'a <tt> XML root', test: (text) => /<tt[\s>]/i.test(text) },
  srv1: { expected: 'a timedtext XML body', test: (text) => /<timedtext[\s>]|<text[\s>]|<\?xml/i.test(text) },
  srv2: { expected: 'a timedtext XML body', test: (text) => /<timedtext[\s>]|<text[\s>]|<\?xml/i.test(text) },
  srv3: { expected: 'a timedtext XML body', test: (text) => /<timedtext[\s>]|<text[\s>]|<\?xml/i.test(text) },
  json3: { expected: 'JSON with an events array', test: (text) => hasJsonEvents(text) },
  sami: { expected: 'a <SAMI> document', test: (text) => /<sami[\s>]/i.test(text) },
  smi: { expected: 'a <SAMI> document', test: (text) => /<sami[\s>]/i.test(text) },
  sbv: { expected: 'an SBV timestamp line', test: (text) => /\d{1,2}:\d{2}:\d{2}[.,]\d{1,3},\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}/.test(text) },
};

function hasJsonEvents(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const events = (parsed as Record<string, unknown>)['events'];
    return Array.isArray(events);
  } catch {
    return false;
  }
}

/**
 * Judge one subtitle file's content. Pure, so the rules above are unit-testable
 * without any filesystem. `text` is the head of the file.
 */
export function inspectSubtitleText(ext: string, text: string): { status: AttachmentProbe['status']; detail: string } {
  const body = text.replace(/^\uFEFF/, '');
  if (body.trim() === '') return { status: 'FAIL', detail: 'subtitle file is empty' };
  if (HTML_PAGE.test(body)) {
    return { status: 'FAIL', detail: 'subtitle file is an HTML page, not a subtitle (login/consent page?)' };
  }
  const rule = FORMAT_RULES[ext];
  if (rule === undefined) {
    // A supported extension we do not sniff (future yt-dlp format): existence
    // and size are still checked by the caller. Do not invent a FAIL.
    return { status: 'SKIPPED', detail: `no content rule for .${ext}; existence-only` };
  }
  return rule.test(body)
    ? { status: 'PASS', detail: `looks like ${rule.expected}` }
    : { status: 'FAIL', detail: `missing ${rule.expected}` };
}

/** Subtitle files declared by this task, judged one by one. */
export async function collectSubtitleProbes(ctx: CheckContext): Promise<AttachmentProbe[]> {
  const probes: AttachmentProbe[] = [];
  for (const path of ctx.artifacts) {
    if (!isSubtitleArtifact(path)) continue;
    const ext = extOf(path);
    try {
      const stat = await ctx.ports.fs.stat(path);
      if (!stat.isFile || stat.sizeBytes <= 0) {
        probes.push({ path, kind: 'subtitle', status: 'FAIL', detail: 'subtitle file is empty on disk' });
        continue;
      }
      if (stat.sizeBytes > MAX_SUBTITLE_BYTES) {
        probes.push({ path, kind: 'subtitle', status: 'SKIPPED', detail: 'subtitle exceeds the 8 MiB content inspection limit' });
        continue;
      }
      let text = '';
      try {
        const content = await ctx.ports.fs.readText(path);
        text = ext === 'json3' ? content : content.slice(0, SNIFF_BYTES);
      } catch {
        probes.push({ path, kind: 'subtitle', status: 'SKIPPED', detail: 'subtitle content unreadable; size is non-zero' });
        continue;
      }
      const verdict = inspectSubtitleText(ext, text);
      probes.push({ path, kind: 'subtitle', status: verdict.status, detail: verdict.detail });
    } catch {
      probes.push({ path, kind: 'subtitle', status: 'FAIL', detail: 'subtitle file disappeared before it could be read' });
    }
  }
  return probes;
}

/**
 * Embedded subtitles: ask the container, do not trust the argv.
 *
 * `--embed-subs` can be a no-op (unsupported container, empty track, ffmpeg
 * refusing the codec), and the exit code stays 0. `ffprobe -select_streams s`
 * is the only honest answer. Advisory: a missing stream is reported, never
 * turned into "the video is broken".
 */
export async function probeEmbeddedSubtitles(ctx: CheckContext): Promise<AttachmentProbe | null> {
  if (ctx.subtitleRequest?.embed !== true) return null;
  const media = primaryArtifact(ctx.artifacts);
  if (media === null) return null;
  let result;
  try {
    result = await ctx.ports.process.spawn(
      ctx.ffprobePath,
      ['-v', 'error', '-select_streams', 's', '-show_streams', '-of', 'json', media],
      { shell: false, windowsHide: true, timeoutMs: 30_000 },
    );
  } catch {
    return { path: media, kind: 'subtitle', status: 'SKIPPED', detail: 'ffprobe could not inspect subtitle streams' };
  }
  if (result.exitCode !== 0) {
    return { path: media, kind: 'subtitle', status: 'SKIPPED', detail: 'ffprobe could not inspect subtitle streams' };
  }
  let count = 0;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    const streams = (parsed as Record<string, unknown> | null)?.['streams'];
    if (Array.isArray(streams)) {
      count = streams.filter((stream) => typeof stream === 'object' && stream !== null
        && String((stream as Record<string, unknown>)['codec_type']) === 'subtitle').length;
    }
  } catch {
    return { path: media, kind: 'subtitle', status: 'SKIPPED', detail: 'ffprobe output was not JSON' };
  }
  const expectedCount = matchLanguageExpression(ctx.subtitleRequest.languages,
    requestableLanguages(ctx.subtitleRequest, ctx.expected)).length;
  if (count > 0 && count < expectedCount) {
    return { path: media, kind: 'subtitle', status: 'FAIL', detail: `container carries ${count} subtitle stream(s); expected at least ${expectedCount}` };
  }
  return count > 0
    ? { path: media, kind: 'subtitle', status: 'PASS', detail: `container carries ${count} subtitle stream(s)` }
    : { path: media, kind: 'subtitle', status: 'FAIL', detail: 'embedding was requested but the container has no subtitle stream' };
}

/** Every advisory attachment probe for this task. */
export async function collectAttachmentProbes(ctx: CheckContext): Promise<AttachmentProbe[]> {
  const probes = await collectSubtitleProbes(ctx);
  const embedded = await probeEmbeddedSubtitles(ctx);
  if (embedded !== null) probes.push(embedded);
  return probes;
}
