/** Media DTOs produced by `JsonMapper` from `yt-dlp --dump-single-json`. */

export interface MediaFormat {
  format_id: string;
  ext: string;
  width: number | null;
  height: number | null;
  vcodec: string;
  acodec: string;
  filesize: number | null;
  filesize_approx: number | null;
  tbr: number | null;
  fps: number | null;
  format_note: string | null;
  /** May contain signed/credential-bearing URLs: NEVER log or put in a report. */
  url?: string;
}

export interface SubtitleTrack {
  lang: string;
  ext: string;
  name: string | null;
  url?: string;
}

export interface Chapter {
  start_time: number;
  end_time: number;
  title: string;
}

export interface MediaInfo {
  id: string;
  title: string;
  uploader: string | null;
  uploader_id: string | null;
  duration: number | null;
  thumbnail: string | null;
  webpage_url: string;
  extractor_key: string;
  description: string | null;
  upload_date: string | null;
  ext: string;
  formats: MediaFormat[];
  subtitles: Record<string, SubtitleTrack[]>;
  automatic_captions: Record<string, SubtitleTrack[]>;
  chapters: Chapter[] | null;
  _type: 'video' | 'url' | 'url_transparent';
}

export interface PlaylistEntry {
  id: string;
  title: string;
  url: string;
  duration: number | null;
  _type: string;
}

export interface PlaylistInfo {
  id: string;
  title: string;
  _type: 'playlist';
  extractor_key: string;
  webpage_url: string;
  entries: PlaylistEntry[];
  /**
   * What yt-dlp declared as `playlist_count`. OPTIONAL and only written when
   * the raw JSON actually carries the key — legacy fixtures map to the exact
   * same object as before, so the frozen M1/M4 contracts are unaffected.
   */
  playlistCount?: number | null;
  /** Raw `entries` items that were null / non-objects and got skipped. */
  skippedEntries?: number;
}
