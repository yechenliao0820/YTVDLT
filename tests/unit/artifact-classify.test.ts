/**
 * Stage 4 · artifact classification + subtitle↔media association.
 *
 * The regressions this file exists for:
 *  - `.srv3` / `.ttml` / `.json3` used to classify as `video`, become
 *    `artifacts[0]`, and get ffprobed as if they were the download;
 *  - a `.json3` subtitle used to be able to masquerade as `info.json`;
 *  - an unknown extension used to be silently promoted to `video`;
 *  - the history's `videoPath` / the detail page's "open file" used `artifacts[0]`.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSubtitleLinks, classifyArtifact, evaluateSubtitleOutcome, isMediaArtifact,
  isSubtitleArtifact, languageFromName, matchLanguageExpression, mediaForSubtitle,
  primaryMediaArtifact, subtitleArtifactsOf, subtitleSourceOf,
} from '@ytvdlt/core';
import type { SubtitleDomain } from '@ytvdlt/shared';
import { bucketOf, mediaInfo, trackOf } from './helpers/subtitle-media.js';

const M = 'C:/out/Clip [id].mp4';

describe('classifyArtifact · the 13 required subtitle formats', () => {
  const subs = ['vtt', 'srt', 'ass', 'ssa', 'lrc', 'ttml', 'srv1', 'srv2', 'srv3', 'json3', 'dfxp', 'sami', 'smi'];
  for (const ext of subs) {
    it(`classifies .${ext} as a subtitle, never as video`, () => {
      expect(classifyArtifact(`C:/out/Clip [id].en.${ext}`)).toBe('subtitle');
      expect(isSubtitleArtifact(`C:/out/Clip [id].en.${ext}`)).toBe(true);
      expect(isMediaArtifact(`C:/out/Clip [id].en.${ext}`)).toBe(false);
    });
  }

  it('keeps `.json3` a subtitle while plain `.json` stays the info dict', () => {
    expect(classifyArtifact('C:/out/Clip [id].en.json3')).toBe('subtitle');
    expect(classifyArtifact('C:/out/Clip [id].info.json')).toBe('infojson');
  });

  it('does not promote an unknown extension to video or subtitle', () => {
    expect(classifyArtifact('C:/out/Clip [id].weird')).toBe('other');
    expect(classifyArtifact('C:/out/Clip [id]')).toBe('other');
  });

  it('still recognises media, thumbnails and audio', () => {
    expect(classifyArtifact('C:/out/a.MKV')).toBe('video');
    expect(classifyArtifact('C:/out/a.m4a')).toBe('audio');
    expect(classifyArtifact('C:/out/a.jpg')).toBe('thumbnail');
  });

  it('is case-insensitive and tolerant of query-free absolute paths', () => {
    expect(classifyArtifact('D:\\Videos\\A.SRT')).toBe('subtitle');
  });
});

describe('primaryMediaArtifact · the media is never whatever came first', () => {
  it('skips thumbnails and subtitles that precede the video', () => {
    const artifacts = ['C:/out/Clip [id].jpg', 'C:/out/Clip [id].en.srt', M];
    expect(primaryMediaArtifact(artifacts)).toBe(M);
  });

  it('returns null when the task produced no media at all', () => {
    // This is the case that used to pick a `.srt` and ffprobe it.
    expect(primaryMediaArtifact(['C:/out/Clip [id].en.srt', 'C:/out/Clip [id].jpg'])).toBeNull();
    expect(primaryMediaArtifact([])).toBeNull();
  });

  it('accepts an unknown container as a last resort (yt-dlp emits `unknown_video`)', () => {
    expect(primaryMediaArtifact(['C:/out/Clip [id].en.srt', 'C:/out/Clip [id].unknown_video']))
      .toBe('C:/out/Clip [id].unknown_video');
  });

  it('prefers a known media extension over an unknown one', () => {
    expect(primaryMediaArtifact(['C:/out/a.unknown_video', 'C:/out/a.mp4'])).toBe('C:/out/a.mp4');
  });

  it('accepts an audio file for an audio-only task', () => {
    expect(primaryMediaArtifact(['C:/out/a.mp3'])).toBe('C:/out/a.mp3');
  });
});

describe('languageFromName · the name is used for ONE thing', () => {
  it('reads the middle segment of <media base>.<lang>.<ext>', () => {
    expect(languageFromName('C:/out/Clip [id].en.srt', M)).toBe('en');
    expect(languageFromName('C:/out/Clip [id].zh-Hans.vtt', M)).toBe('zh-Hans');
    expect(languageFromName('C:/out/Clip [id].pt-BR.srv3', M)).toBe('pt-BR');
  });

  it('returns "" instead of inventing a language', () => {
    expect(languageFromName('C:/out/other name.en.srt', M)).toBe('');
    expect(languageFromName('C:/out/Clip [id].en.srt', '')).toBe('');
    // A name with a space or a colour tag is not a language code.
    expect(languageFromName('C:/out/Clip [id].en US.srt', M)).toBe('');
  });

  it('does not treat a media name prefix like `Clip [id].extra` as a language', () => {
    // `Clip [id].extra.en.srt` → language "extra.en"? No: the segment between
    // the media base and the LAST extension is `extra.en`, which is not a
    // plausible single tag... but it IS a valid tag shape, so it is kept and
    // flagged as unlabelled by the source lookup (unknown). Documented here.
    const link = buildSubtitleLinks({
      artifacts: [M, 'C:/out/Clip [id].extra.en.srt'],
      mediaInfo: mediaInfo(),
    })[0];
    expect(link?.language).toBe('extra.en');
    expect(link?.source).toBe('unknown');
  });
});

describe('mediaForSubtitle · longest matching base wins', () => {
  it('picks the media whose base is a full prefix', () => {
    const long = 'C:/out/Clip [id] 1080p.mp4';
    const short = 'C:/out/Clip [id].mp4';
    expect(mediaForSubtitle('C:/out/Clip [id] 1080p.en.srt', [short, long])).toBe(long);
    expect(mediaForSubtitle('C:/out/Clip [id].en.srt', [short, long])).toBe(short);
  });

  it('falls back to the only media file, and to "" when ambiguous', () => {
    expect(mediaForSubtitle('C:/out/whatever.en.srt', [M])).toBe(M);
    expect(mediaForSubtitle('C:/out/whatever.en.srt', ['C:/out/a.mp4', 'C:/out/b.mp4'])).toBe('');
  });
});

describe('buildSubtitleLinks · ownership and evidence', () => {
  const media = mediaInfo({
    subtitles: bucketOf(trackOf('en', 'vtt'), trackOf('zh-Hans', 'vtt')),
    automatic_captions: bucketOf(trackOf('de', 'vtt')),
  });

  it('links every subtitle artifact with language, format, source and media', () => {
    const links = buildSubtitleLinks({
      artifacts: [M, 'C:/out/Clip [id].en.srt', 'C:/out/Clip [id].zh-Hans.srt', 'C:/out/Clip [id].de.vtt'],
      mediaInfo: media,
    });
    expect(links).toEqual([
      { path: 'C:/out/Clip [id].en.srt', language: 'en', ext: 'srt', source: 'manual', mediaPath: M },
      { path: 'C:/out/Clip [id].zh-Hans.srt', language: 'zh-Hans', ext: 'srt', source: 'manual', mediaPath: M },
      { path: 'C:/out/Clip [id].de.vtt', language: 'de', ext: 'vtt', source: 'automatic', mediaPath: M },
    ]);
  });

  it('ignores non-subtitle artifacts entirely', () => {
    const links = buildSubtitleLinks({
      artifacts: [M, 'C:/out/Clip [id].jpg', 'C:/out/Clip [id].info.json'],
      mediaInfo: media,
    });
    expect(links).toEqual([]);
  });

  it('keeps duplicate formats of one language as separate links but de-dupes a repeated path', () => {
    const links = buildSubtitleLinks({
      artifacts: [M, 'C:/out/Clip [id].en.vtt', 'C:/out/Clip [id].en.srt', 'C:/out/Clip [id].en.SRT'],
      mediaInfo: media,
    });
    expect(links.map((link) => link.ext)).toEqual(['vtt', 'srt']);
  });

  it('says "unknown" instead of guessing when the probe has no such bucket', () => {
    expect(subtitleSourceOf(null, 'en')).toBe('unknown');
    expect(subtitleSourceOf(media, 'fr')).toBe('unknown');
    expect(subtitleSourceOf(media, '')).toBe('unknown');
  });

  it('never claims a file that is not an artifact of this task', () => {
    const links = buildSubtitleLinks({
      artifacts: [M],
      mediaInfo: media,
    });
    expect(links).toEqual([]);
    expect(subtitleArtifactsOf([M, 'C:/out/Clip [id].en.srt'])).toEqual(['C:/out/Clip [id].en.srt']);
  });
});

describe('matchLanguageExpression · yt-dlp --sub-langs grammar', () => {
  const available = ['en', 'en-orig', 'zh-Hans', 'zh-Hant', 'de'];

  it('matches exact codes and full-match regexes (never a bare prefix)', () => {
    expect(matchLanguageExpression('en,zh-Hans', available)).toEqual(['en', 'zh-Hans']);
    expect(matchLanguageExpression('zh.*', available)).toEqual(['zh-Hans', 'zh-Hant']);
    // Measured on the bundled yt-dlp 2026.10.26: `--sub-langs en` does NOT pick
    // up `en-orig`; variants need `en.*`.
    expect(matchLanguageExpression('en', available)).toEqual(['en']);
  });

  it('supports "all" and "-" exclusions', () => {
    expect(matchLanguageExpression('all,-de', available)).toEqual(['en', 'en-orig', 'zh-Hans', 'zh-Hant']);
    expect(matchLanguageExpression('all,-zh.*', available)).toEqual(['en', 'en-orig', 'de']);
  });

  it('returns everything for an empty expression (yt-dlp default)', () => {
    expect(matchLanguageExpression('', available)).toEqual(available);
    expect(matchLanguageExpression(' , ', available)).toEqual(available);
  });

  it('treats an invalid regex as a literal instead of throwing', () => {
    expect(matchLanguageExpression('zh-(', available)).toEqual([]);
    expect(matchLanguageExpression('zh-Hans', available)).toEqual(['zh-Hans']);
  });
});

describe('evaluateSubtitleOutcome · requested vs produced', () => {
  const subtitle = (overrides: Partial<SubtitleDomain> = {}): SubtitleDomain => ({
    enabled: true, languages: 'en,zh-Hans', autoCaptions: false, skipTranslated: true,
    convertTo: 'srt', embed: false, keepSubtitleFile: false, ...overrides,
  });
  const media = mediaInfo({
    subtitles: bucketOf(trackOf('en', 'vtt'), trackOf('zh-Hans', 'vtt')),
  });
  const link = (language: string) => ({
    path: `C:/out/Clip [id].${language}.srt`, language, ext: 'srt',
    source: 'manual' as const, mediaPath: M,
  });

  it('uses only the requested source when manual and automatic languages overlap', () => {
    const both = mediaInfo({
      subtitles: bucketOf(trackOf('en', 'vtt'), trackOf('fr', 'vtt')),
      automatic_captions: bucketOf(trackOf('en', 'vtt')),
    });
    const autoOnly = subtitle({ enabled: false, autoCaptions: true, languages: 'all' });
    const links = buildSubtitleLinks({ artifacts: [M, link('en').path], mediaInfo: both, subtitle: autoOnly });
    expect(links[0]?.source).toBe('automatic');
    expect(evaluateSubtitleOutcome({ subtitle: autoOnly, mediaInfo: both, links })).toBe('ok');
    expect(subtitleSourceOf(both, 'en', subtitle({ languages: 'all', autoCaptions: true }))).toBe('manual');
    expect(subtitleSourceOf(both, 'fr', autoOnly)).toBe('unknown');
    const embeddedAuto = subtitle({ enabled: false, autoCaptions: true, embed: true, languages: 'all' });
    expect(subtitleSourceOf(both, 'en', embeddedAuto)).toBe('automatic');
    expect(subtitleSourceOf(both, 'en', { ...embeddedAuto, enabled: true })).toBe('manual');
    expect(evaluateSubtitleOutcome({
      subtitle: embeddedAuto, mediaInfo: both, links,
      attachments: [{ path: M, kind: 'subtitle', status: 'PASS', detail: 'container carries 1 subtitle stream(s)' }],
    })).toBe('ok');
  });

  it('D-132: embed + keepSubtitleFile=false is ok with embedded delivery and no sidecar', () => {
    const probe = [{ path: M, kind: 'subtitle' as const, status: 'PASS' as const, detail: 'container carries 1 subtitle stream(s)' }];
    const embeddedNoKeep = subtitle({ enabled: false, autoCaptions: true, embed: true, keepSubtitleFile: false });
    // A real YouTube auto-caption download: subtitle embedded, yt-dlp removed
    // the temporary sidecar → no missing subtitle, so this must be "ok".
    expect(evaluateSubtitleOutcome({
      subtitle: embeddedNoKeep, mediaInfo: media, links: [], attachments: probe,
    })).toBe('ok');
    // The user explicitly asked to KEEP the sidecar; it is absent → shortfall.
    expect(evaluateSubtitleOutcome({
      subtitle: { ...embeddedNoKeep, keepSubtitleFile: true }, mediaInfo: media, links: [], attachments: probe,
    })).toBe('partial');
    // Without a container probe an embed-only request is still unproven.
    expect(evaluateSubtitleOutcome({
      subtitle: embeddedNoKeep, mediaInfo: media, links: [],
    })).toBe('missing');
  });

  it('treats embed-only intent as missing until a container probe confirms delivery', () => {
    const embeddedOnly = subtitle({ enabled: false, embed: true });
    expect(evaluateSubtitleOutcome({ subtitle: embeddedOnly, mediaInfo: media, links: [] })).toBe('missing');
    expect(evaluateSubtitleOutcome({
      subtitle: embeddedOnly, mediaInfo: media, links: [],
      attachments: [{ path: M, kind: 'subtitle', status: 'PASS', detail: 'container carries 1 subtitle stream(s)' }],
    })).toBe('ok');
  });

  it('reports "none" when no subtitles were requested', () => {
    expect(evaluateSubtitleOutcome({
      subtitle: subtitle({ enabled: false, autoCaptions: false }), mediaInfo: media, links: [],
    })).toBe('none');
    expect(evaluateSubtitleOutcome({ subtitle: null, mediaInfo: media, links: [] })).toBe('none');
  });

  it('reports "ok" when every requested language produced a file', () => {
    expect(evaluateSubtitleOutcome({
      subtitle: subtitle(), mediaInfo: media, links: [link('en'), link('zh-Hans')],
    })).toBe('ok');
  });

  it('reports "partial" when only some requested languages arrived', () => {
    expect(evaluateSubtitleOutcome({
      subtitle: subtitle(), mediaInfo: media, links: [link('en')],
    })).toBe('partial');
  });

  it('reports "missing" when subtitles were requested and nothing arrived', () => {
    expect(evaluateSubtitleOutcome({
      subtitle: subtitle(), mediaInfo: media, links: [],
    })).toBe('missing');
    // The "language does not exist on the site" case: yt-dlp exits 0.
    expect(evaluateSubtitleOutcome({
      subtitle: subtitle({ languages: 'de' }), mediaInfo: media, links: [],
    })).toBe('missing');
  });

  it('does not call a delivered file "missing" just because the expression did not match', () => {
    expect(evaluateSubtitleOutcome({
      subtitle: subtitle({ languages: 'fr' }), mediaInfo: media, links: [link('en')],
    })).toBe('ok');
  });
});
