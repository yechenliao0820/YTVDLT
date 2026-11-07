/**
 * FormatSelector — stage-1 UI pure functions (M3-F005).
 *
 * Maps a dialog's format selection into a LEGAL five-domain `FormatDomain`.
 * Notably it corrects `audioMultistreams` from the number of selected audio-only
 * formats (R4) and builds `-f id+id` (P3). No argv is produced here; the final
 * defensive reduction is `resolveDownloadPlan()` (stage 2).
 */
import type { MediaFormat, MediaInfo, FormatDomain, FormatSelection } from '@ytvdlt/shared';

export type FormatGroup = 'video-only' | 'audio-only' | 'merged';

export interface ClassifiedFormats {
  videoOnly: MediaFormat[];
  audioOnly: MediaFormat[];
  merged: MediaFormat[];
}

/** Three-column dialog classification by codec presence. */
export function classifyFormats(formats: readonly MediaFormat[]): ClassifiedFormats {
  const result: ClassifiedFormats = { videoOnly: [], audioOnly: [], merged: [] };
  if (!Array.isArray(formats)) return result;
  for (const item of formats) {
    if (item === null || item === undefined) continue;
    const hasVideo = item.vcodec !== 'none';
    const hasAudio = item.acodec !== 'none';
    if (hasVideo && hasAudio) result.merged.push(item);
    else if (hasVideo) result.videoOnly.push(item);
    else if (hasAudio) result.audioOnly.push(item);
  }
  return result;
}

/** Highest `tbr` in a group; null when NO member has a usable tbr. */
export function recommendFormat(group: readonly MediaFormat[]): MediaFormat | null {
  let best: MediaFormat | null = null;
  let bestTbr = Number.NEGATIVE_INFINITY;
  if (!Array.isArray(group)) return null;
  for (const item of group) {
    if (item === null || item === undefined) continue;
    const tbr = item.tbr;
    if (tbr === null || tbr === undefined || !Number.isFinite(tbr)) continue;
    if (tbr > bestTbr) {
      bestTbr = tbr;
      best = item;
    }
  }
  return best;
}

/** Sum `filesize ?? filesize_approx`; null when ALL are missing (show "—"). */
export function sumSelectedBytes(selected: readonly MediaFormat[]): number | null {
  let total = 0;
  let found = false;
  if (!Array.isArray(selected)) return null;
  for (const item of selected) {
    if (item === null || item === undefined) continue;
    const size = item.filesize ?? item.filesize_approx;
    if (size === null || size === undefined || !Number.isFinite(size) || size < 0) continue;
    total += size;
    found = true;
  }
  return found ? total : null;
}

export interface SelectFormatsResult {
  format: FormatDomain;
  totalBytes: number | null;
  audioOnlyCount: number;
  warnings: string[];
}

/** Dialog selection -> legal FormatDomain (R4 correction + P3 `-f` value). */
export function selectFormats(
  media: MediaInfo,
  current: FormatDomain,
  sel: FormatSelection,
): SelectFormatsResult {
  const groups = classifyFormats(media.formats ?? []);
  const byId = new Map<string, MediaFormat>();
  for (const item of media.formats ?? []) {
    if (item !== null && item !== undefined) byId.set(item.format_id, item);
  }

  const warnings: string[] = [];
  const selected: MediaFormat[] = [];
  const parts: string[] = [];

  if (sel.videoFormatId !== null && sel.videoFormatId.length > 0) {
    parts.push(sel.videoFormatId);
    const found = byId.get(sel.videoFormatId);
    if (found !== undefined) selected.push(found);
    else warnings.push(`FORMAT_UNAVAILABLE: ${sel.videoFormatId}`);
  }
  for (const id of sel.audioFormatIds ?? []) {
    if (typeof id !== 'string' || id.length === 0) continue;
    parts.push(id);
    const found = byId.get(id);
    if (found !== undefined) selected.push(found);
    else warnings.push(`FORMAT_UNAVAILABLE: ${id}`);
  }

  const audioOnlyCount = (sel.audioFormatIds ?? []).filter((id) =>
    groups.audioOnly.some((item) => item.format_id === id),
  ).length;
  const audioMultistreams = audioOnlyCount >= 2;
  if (current.audioMultistreams === true && !audioMultistreams) {
    warnings.push('R4: audioMultistreams corrected to false (fewer than 2 audio-only formats)');
  }

  const totalBytes = sumSelectedBytes(selected);
  const extractAudio = sel.videoFormatId === null && audioOnlyCount > 0;
  const format: FormatDomain = {
    ...current,
    formatId: parts.length > 0 ? parts.join('+') : null,
    extractAudio,
    audioMultistreams,
    quality: sel.quality,
    videoCodecPref: sel.videoCodecPref,
    audioQuality: sel.audioQuality,
    audioCodecPref: sel.audioCodecPref,
    audioFormat: sel.audioFormat,
    sortingFields: sel.sortingFields,
  };
  return { format, totalBytes, audioOnlyCount, warnings };
}
