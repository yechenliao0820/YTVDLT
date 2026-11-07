/**
 * D-19 · `detectPostprocessed` drives the C2-vs-C8 choice, so every branch that
 * can flip post-processing must be covered explicitly.
 */
import { describe, it, expect } from 'vitest';
import { detectPostprocessed, detectPostprocessedFromRun } from '@ytvdlt/core';
import type { DownloadRequest } from '@ytvdlt/shared';

const base = (): DownloadRequest => ({
  taskId: 't', url: 'https://example.org/v',
  format: { quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null, extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto', audioFormat: null, audioMultistreams: false },
  subtitle: { enabled: false, languages: 'en.*', autoCaptions: false, skipTranslated: true, convertTo: 'none', embed: false, keepSubtitleFile: false },
  paths: { videoDir: 'C:/v', audioDir: 'C:/a', commandDir: 'C:/c', privateMode: false, subdirByExtractor: false, subdirByPlaylist: false, outputTemplate: '%(title)s.%(ext)s', tempDir: 'C:/t' },
  network: { rateLimit: null, proxy: null, cookiesFile: null, userAgent: null, ipv4Only: false, concurrentFragments: null, aria2cPath: null },
  advanced: { sponsorblockRemove: null, downloadSections: null, splitChapters: false, customTitle: null, debug: false, downloadArchive: null, customCommand: null },
});

describe('D-19 detectPostprocessed', () => {
  it('a plain video download is NOT post-processed', () => {
    expect(detectPostprocessed(base())).toBe(false);
  });

  it('audio-format / extract-audio / split-chapters / embed-subs each trigger it', () => {
    const withAudioFormat = base();
    (withAudioFormat.format as { audioFormat: 'mp3' | 'm4a' | null }).audioFormat = 'mp3';
    expect(detectPostprocessed(withAudioFormat)).toBe(true);

    const withExtract = base();
    (withExtract.format as { extractAudio: boolean }).extractAudio = true;
    expect(detectPostprocessed(withExtract)).toBe(true);

    const withChapters = base();
    (withChapters.advanced as { splitChapters: boolean }).splitChapters = true;
    expect(detectPostprocessed(withChapters)).toBe(true);

    const withEmbed = base();
    (withEmbed.subtitle as { embed: boolean }).embed = true;
    expect(detectPostprocessed(withEmbed)).toBe(true);
  });

  it('subtitle conversion alone triggers it; enabling subs without conversion does not', () => {
    const converting = base();
    (converting.subtitle as { enabled: boolean; convertTo: 'none' | 'srt' }).enabled = true;
    (converting.subtitle as { convertTo: 'none' | 'srt' }).convertTo = 'srt';
    expect(detectPostprocessed(converting)).toBe(true);

    const plainSubs = base();
    (plainSubs.subtitle as { enabled: boolean }).enabled = true;
    expect(detectPostprocessed(plainSubs)).toBe(false);
  });

  it('observed stderr post-processor markers also flip the flag', () => {
    expect(detectPostprocessedFromRun(base(), '')).toBe(false);
    for (const marker of ['[PostProcess] Merging formats', '[Merger] Merging', '[ExtractAudio] Destination: x.mp3']) {
      expect(detectPostprocessedFromRun(base(), marker), marker).toBe(true);
    }
  });
});
