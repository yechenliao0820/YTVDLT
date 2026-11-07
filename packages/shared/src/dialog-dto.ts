/**
 * Dialog / probe IPC DTOs (M3-F002).
 *
 * HARD RED LINE (§8.4): these DTOs NEVER carry `MediaFormat.url` /
 * `SubtitleTrack.url` (may contain signed/credential-bearing URLs). They also
 * never carry a `mergeToMkv` field (internal derivation, D-35) and never carry
 * a raw command.
 */
import type { FormatDomain, SubtitleDomain, DownloadRequest } from './request.js';
import type { MediaInfo, MediaFormat, SubtitleTrack, PlaylistInfo } from './media.js';

export type DialogKind = 'format' | 'subtitle' | 'playlist';
export type DialogState = 'ready' | 'empty' | 'error' | 'disabled';

export interface FormatSelection {
  videoFormatId: string | null;
  audioFormatIds: readonly string[];
  quality: FormatDomain['quality'];
  videoCodecPref: FormatDomain['videoCodecPref'];
  audioQuality: FormatDomain['audioQuality'];
  audioCodecPref: FormatDomain['audioCodecPref'];
  audioFormat: FormatDomain['audioFormat'];
  sortingFields: string | null;
}

export interface SubtitleSelection {
  languages: readonly string[];
  autoCaptions: boolean;
  skipTranslated: boolean;
  convertTo: SubtitleDomain['convertTo'];
  embed: boolean;
  keepSubtitleFile: boolean;
}

export interface PlaylistSelection {
  readonly selectedIds: readonly string[];
}

/** Confirmation writes back five-domain fields or selected ids ONLY. */
export interface DialogConfirmResult {
  kind: DialogKind;
  confirmed: boolean;
  requestPatch?: Partial<Pick<DownloadRequest, 'format' | 'subtitle' | 'paths' | 'network' | 'advanced'>>;
  selectedPlaylistIds?: readonly string[];
  state: DialogState;
  reason?: string;
}

/** Probe result DTO: every signed `url` field has been stripped. */
export interface ProbeResultDto {
  media: (Omit<MediaInfo, 'formats' | 'subtitles' | 'automatic_captions'> & {
    formats: ReadonlyArray<Omit<MediaFormat, 'url'>>;
    subtitles: Readonly<Record<string, ReadonlyArray<Omit<SubtitleTrack, 'url'>>>>;
    automatic_captions: Readonly<Record<string, ReadonlyArray<Omit<SubtitleTrack, 'url'>>>>;
  }) | null;
  playlist: PlaylistInfo | null;
  error: { code: string; message: string; retryable: boolean } | null;
}
