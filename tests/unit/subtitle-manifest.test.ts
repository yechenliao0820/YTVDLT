/** Subtitle path parsing and explicit move-map ownership. */
import { describe, it, expect } from 'vitest';
import {
  parseSubtitlePathList, quotedLiterals, subtitleFinalCandidates, subtitleManifestPath,
} from '@ytvdlt/engine-ytdlp';

describe('quotedLiterals · just enough Python repr', () => {
  it('reads single- and double-quoted literals and decodes escapes', () => {
    expect(quotedLiterals(`['C:\\\\a\\\\b.vtt', "C:\\\\c\\\\d.srt"]`))
      .toEqual(['C:\\a\\b.vtt', 'C:\\c\\d.srt']);
    expect(quotedLiterals("['it\\'s.srt']")).toEqual(["it's.srt"]);
  });

  it('returns nothing for the "NA" yt-dlp prints when there are no subtitles', () => {
    expect(quotedLiterals('NA')).toEqual([]);
    expect(quotedLiterals('')).toEqual([]);
  });
});

describe('parseSubtitlePathList', () => {
  it('parses the measured shape', () => {
    const line = String.raw`['C:\\out\\clip [id].en.srt', 'C:\\out\\clip [id].zh-Hans.srt']`;
    expect(parseSubtitlePathList(line)).toEqual([
      'C:\\out\\clip [id].en.srt',
      'C:\\out\\clip [id].zh-Hans.srt',
    ]);
  });

  it('parses an empty list and a missing file as nothing', () => {
    expect(parseSubtitlePathList('[]')).toEqual([]);
    expect(parseSubtitlePathList('   ')).toEqual([]);
  });

  it('drops relative values instead of guessing a base directory', () => {
    expect(parseSubtitlePathList(`['clip.en.srt', 'C:\\\\out\\\\clip.en.srt']`))
      .toEqual(['C:\\out\\clip.en.srt']);
  });

  it('de-dupes case-insensitively and keeps order', () => {
    expect(parseSubtitlePathList(`['C:\\\\Out\\\\A.en.srt', 'c:\\\\out\\\\a.EN.srt', 'C:\\\\Out\\\\B.srt']`))
      .toEqual(['C:\\Out\\A.en.srt', 'C:\\Out\\B.srt']);
  });

  it('unions several lines (a playlist batch prints one line per video)', () => {
    expect(parseSubtitlePathList(`['C:\\\\o\\\\a.en.srt']\n['C:\\\\o\\\\b.en.srt']`))
      .toEqual(['C:\\o\\a.en.srt', 'C:\\o\\b.en.srt']);
  });

  it('never invents a path from a stray quote in a message', () => {
    expect(parseSubtitlePathList("WARNING: 'not a path'")).toEqual([]);
  });
});

describe('subtitleFinalCandidates · explicit ownership only', () => {
  it('never invents a destination from a media directory', () => {
    expect(subtitleFinalCandidates('C:/work/x.en.srt')).toEqual(['C:/work/x.en.srt']);
  });

  it('uses only an explicit target, including a changed basename', () => {
    expect(subtitleFinalCandidates('C:/work/x.en.srt', {
      'C:/work/x.en.srt': 'D:/subs/renamed.en.srt',
      'C:/work/other.en.srt': 'C:/V/other.en.srt',
    })).toEqual(['D:/subs/renamed.en.srt']);
  });

  it('matches Windows casing and separators, not basenames', () => {
    expect(subtitleFinalCandidates('C:/work/x.en.srt', {
      'c:\\WORK\\X.en.srt': 'C:/V/x.en.srt',
    })).toEqual(['C:/V/x.en.srt']);
    expect(subtitleFinalCandidates('C:/work/x.en.srt', {
      'C:/another-task/x.en.srt': 'C:/V/x.en.srt',
    })).toEqual(['C:/work/x.en.srt']);
  });

  it.each(['', 'relative.srt', null, 1])('rejects an invalid move target %s', (target) => {
    expect(subtitleFinalCandidates('C:/work/x.en.srt', { 'C:/work/x.en.srt': target })).toEqual([]);
  });
});

const record = (moves: unknown, paths: unknown): string =>
  `YTVDLT_SUBTITLE_MOVES:${JSON.stringify(moves)}\nYTVDLT_SUBTITLE_PATHS:${JSON.stringify(paths)}`;

describe('post_process maps + after_move sources', () => {
  it('parses the real 2026.10.26 converted SRT path-only output', () => {
    const moves = String.raw`{"C:\\Users\\leolee\\Desktop\\YTVDLT\\Project\\reports\\l2-tmp\\subtitle-final-mapping-448-1794318133619\\temp\\mapping.en.srt": "C:\\Users\\leolee\\Desktop\\YTVDLT\\Project\\reports\\l2-tmp\\subtitle-final-mapping-448-1794318133619\\out\\mapping.en.srt", "C:\\Users\\leolee\\Desktop\\YTVDLT\\Project\\reports\\l2-tmp\\subtitle-final-mapping-448-1794318133619\\temp\\mapping.zh-Hans.srt": "C:\\Users\\leolee\\Desktop\\YTVDLT\\Project\\reports\\l2-tmp\\subtitle-final-mapping-448-1794318133619\\out\\mapping.zh-Hans.srt"}`;
    const sources = Object.keys(JSON.parse(moves) as Record<string, string>);
    expect(parseSubtitlePathList(`YTVDLT_SUBTITLE_MOVES:${moves}\nYTVDLT_SUBTITLE_PATHS:${JSON.stringify(sources)}`))
      .toEqual(Object.values(JSON.parse(moves) as Record<string, string>));
  });

  it('parses the measured no-subtitle records as empty', () => {
    expect(parseSubtitlePathList('YTVDLT_SUBTITLE_MOVES:{}\nYTVDLT_SUBTITLE_PATHS:[]')).toEqual([]);
  });

  it('ignores unrelated map entries and does not cross-claim multiple media directories', () => {
    expect(parseSubtitlePathList(record({
      'C:/temp/a.en.srt': 'C:/V/a.en.srt',
      'C:/temp/b.en.srt': 'C:/A/b.en.srt',
      'C:/temp/a.mp4': 'C:/V/a.mp4',
    }, ['C:/temp/a.en.srt']))).toEqual(['C:/V/a.en.srt']);
  });

  it('consumes each mapping once, including empty and malformed path records', () => {
    const mapping = { 'C:/temp/a.en.srt': 'C:/V/a.en.srt' };
    for (const paths of ['[]', 'NA', '{invalid']) {
      expect(parseSubtitlePathList(`YTVDLT_SUBTITLE_MOVES:${JSON.stringify(mapping)}\nYTVDLT_SUBTITLE_PATHS:${paths}\nYTVDLT_SUBTITLE_PATHS:["C:/temp/a.en.srt"]`))
        .toEqual(['C:/temp/a.en.srt']);
    }
  });

  it('rejects malformed or NA move records without extracting their quoted paths', () => {
    for (const moves of ['NA', 'null', '[]', '{"C:/temp/a.en.srt":"C:/V/a.en.srt"']) {
      expect(parseSubtitlePathList(`YTVDLT_SUBTITLE_MOVES:${moves}\nYTVDLT_SUBTITLE_PATHS:["C:/temp/a.en.srt"]`)).toEqual([]);
    }
  });

  it('handles repeated records and keeps sources paired with the latest map', () => {
    expect(parseSubtitlePathList([
      record({ 'C:/temp/a.srt': 'C:/V/a.srt' }, ['C:/temp/a.srt']),
      record({ 'C:/temp/b.srt': 'C:/A/b.srt' }, ['C:/temp/b.srt']),
      record({}, []),
    ].join('\n'))).toEqual(['C:/V/a.srt', 'C:/A/b.srt']);
  });

  it('does not mine arbitrary diagnostics or JSON dictionaries for paths', () => {
    expect(parseSubtitlePathList('WARNING: "C:/V/old.srt"')).toEqual([]);
    expect(parseSubtitlePathList('{"filepath":"C:/V/old.srt"}')).toEqual([]);
  });
});

describe('subtitleManifestPath', () => {
  it('is distinct from the artifact manifest and per task', () => {
    expect(subtitleManifestPath('C:/work/t1', 't1')).toBe('C:/work/t1/ytvdlt-subtitles-t1.txt');
    expect(subtitleManifestPath('', 't1')).toBe('ytvdlt-subtitles-t1.txt');
    expect(subtitleManifestPath('C:/work/t1', 't1')).not.toBe(subtitleManifestPath('C:/work/t1', 't2'));
  });
});
