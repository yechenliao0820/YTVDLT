/**
 * D-115: post-process stage detection.
 *
 * The whole point of this module is that the UI only ever says "merging" when
 * yt-dlp literally printed `[Merger]`. These tests pin both directions: every
 * supported marker maps to its stage, and anything else stays `null` (a wrong
 * positive would put a "merging video" label on an ordinary download).
 */
import { describe, it, expect } from 'vitest';
import {
  createLineSplitter, detectStageFromLine,
} from '@ytvdlt/engine-ytdlp';
import { isForwardStage, stageRank } from '@ytvdlt/shared';

describe('D-115 postprocess markers', () => {
  it('recognises the Merger line as the only "merging" source', () => {
    expect(detectStageFromLine('[Merger] Merging formats into "C:/out/a.mkv"')).toBe('merging');
    // Real capture includes a leading space in some versions.
    expect(detectStageFromLine('  [Merger] Merging formats into "a.mkv"')).toBe('merging');
  });

  it('maps every other postprocessor to the generic stage', () => {
    const lines = [
      '[ExtractAudio] Destination: C:/out/a.m4a',
      '[VideoConvertor] Converting video from webm to mp4',
      '[VideoRemuxer] Remuxing video from flv to mp4',
      '[FixupM3u8] Fixing MPEG-TS in MP4 container',
      '[FixupM4a] Correcting container of "a.m4a"',
      '[Metadata] Adding metadata to "a.mp4"',
      '[EmbedThumbnail] Adding thumbnail to "a.mp4"',
      '[EmbedSubtitle] Embedding subtitles in "a.mp4"',
      '[SubtitlesConvertor] Converting subtitles',
      '[MoveFiles] Moving file "a.mp4"',
      '[ThumbnailsConvertor] Converting thumbnail "a.webp" to "a.jpg"',
      '[ModifyChapters] Sponsored section',
      '[SplitChapters] Splitting video by chapters',
      '[SponsorBlock] Marking sponsor sections',
    ];
    for (const line of lines) {
      expect(detectStageFromLine(line), line).toBe('postprocess');
    }
  });

  it('never promotes an unrelated line to a stage', () => {
    const lines = [
      '',
      '[youtube] Extracting URL: https://example.org/v',
      '[info] Downloading 1 format(s): 137+140',
      '[download] Destination: a.f137.mp4',
      '[download] 100% of 12.3MiB in 00:00:03 at 4.1MiB/s',
      'Merger without brackets',
      '[Merger]', // no trailing payload: not a real marker line
      '[MergerX] Merging',
      'ERROR: [Merger] failed', // an error line, not a stage announcement
    ];
    for (const line of lines) {
      expect(detectStageFromLine(line), line).toBeNull();
    }
  });

  it('splits a chunk that ends mid-line without losing the marker', () => {
    const splitter = createLineSplitter();
    expect(splitter.push('[Mer')).toEqual([]);
    expect(splitter.push('ger] Merging formats into "a.mkv"\r\n')).toEqual([
      '[Merger] Merging formats into "a.mkv"',
    ]);
    expect(splitter.flush()).toEqual([]);
  });

  it('flushes a trailing marker that has no newline', () => {
    const splitter = createLineSplitter();
    splitter.push('[ExtractAudio] Destination: a.m4a');
    expect(splitter.flush()).toEqual(['[ExtractAudio] Destination: a.m4a']);
  });

  it('keeps memory bounded on a stream with no newlines', () => {
    const splitter = createLineSplitter(64);
    splitter.push('x'.repeat(400));
    // No newline seen → nothing emitted, but the buffer must not keep 400 chars.
    expect(splitter.push('')).toEqual([]);
    expect(splitter.flush()[0]?.length).toBeLessThanOrEqual(64);
  });
});

describe('D-115 stage ordering', () => {
  it('ranks stages monotonically', () => {
    expect(stageRank('fetching')).toBeLessThan(stageRank('downloading'));
    expect(stageRank('downloading')).toBeLessThan(stageRank('merging'));
    expect(stageRank('merging')).toBeLessThan(stageRank('postprocess'));
    expect(stageRank('postprocess')).toBeLessThan(stageRank('verifying'));
  });

  it('allows forward moves and the same stage, refuses every backward move', () => {
    expect(isForwardStage(null, 'downloading')).toBe(true);
    expect(isForwardStage('downloading', 'merging')).toBe(true);
    expect(isForwardStage('merging', 'merging')).toBe(true);
    expect(isForwardStage('merging', 'downloading')).toBe(false);
    expect(isForwardStage('verifying', 'merging')).toBe(false);
    expect(isForwardStage('verifying', 'postprocess')).toBe(false);
  });

  it('treats an unknown stage as unusable instead of "latest"', () => {
    expect(stageRank('nonsense')).toBe(-1);
    // @ts-expect-error deliberately outside the union
    expect(isForwardStage('downloading', 'nonsense')).toBe(false);
  });
});
