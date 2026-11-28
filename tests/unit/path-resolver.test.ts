/**
 * B2 / F032 · Windows filename boundaries (A-M3-07 / 08 / 09, A-4.4-01..04,
 * A-4.6-01): 9 illegal char classes + control chars, reserved names (case
 * insensitive incl. CON.txt / con), trailing dot/space, %(title).200B
 * truncation, 259/260/261 boundary, UNC + \\?\ / \\?\UNC\ prefixes,
 * buildOutputDir 4 combinations, 3 built-in + custom templates, and the
 * Q-M3-09 purification order. Also covers three-dir / private-dir persistence.
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeToken, sanitizeFileName, renderTemplate, buildOutputDir,
  categorizedTemplatePrefix,
  resolveOutputPath, truncateWindowsPath, analyzeWindowsPath, expandEnvVars,
  hasUnresolvedEnvToken,
  BUILTIN_OUTPUT_TEMPLATES,
  WINDOWS_MAX_PATH, WINDOWS_SAFE_PATH, LONG_PATH_PREFIX, LONG_UNC_PREFIX,
  ConfigStore, DEFAULT_DOMAINS, createDefaultConfig,
} from '@ytvdlt/core';
import type { PathsDomain, TemplateVars } from '@ytvdlt/core';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const CONFIG_PATH = 'C:/Users/test/AppData/Roaming/YTVDLT/config/config.json';

const paths = (o: Partial<PathsDomain> = {}): PathsDomain => ({
  videoDir: 'C:/V', audioDir: 'C:/A', commandDir: 'C:/C', privateMode: false,
  subdirByExtractor: false, subdirByPlaylist: false,
  outputTemplate: '%(title)s.%(ext)s', tempDir: 'C:/temp', ...o,
});
const vars = (o: Partial<TemplateVars> = {}): TemplateVars => ({
  title: 'My Video', id: 'abc123', ext: 'mp4', playlist: 'MyList',
  extractor_key: 'YouTube', ...o,
});

describe('B2 PathResolver · sanitizeToken (argv safety, D-34)', () => {
  it('replaces whitespace and control characters with _ (output !/\\s/)', () => {
    const out = sanitizeToken('My New\tTitle\n\u0000\u001f\u007f');
    expect(/\s/.test(out)).toBe(false);
    expect(/[\u0000-\u001f\u007f]/.test(out)).toBe(false);
    expect(out).toContain('_');
  });

  it('keeps legitimate URL / path separators intact', () => {
    expect(sanitizeToken('http://127.0.0.1:8888')).toBe('http://127.0.0.1:8888');
    expect(sanitizeToken('C:/Videos/YTVDLT')).toBe('C:/Videos/YTVDLT');
    expect(sanitizeToken('res:720,ext:mp4')).toBe('res:720,ext:mp4');
  });

  it('is total: empty / non-string input never throws', () => {
    expect(sanitizeToken('')).toBe('');
    expect(sanitizeToken(null as unknown as string)).toBe('');
  });
});

describe('B2 PathResolver · sanitizeFileName (A-M3-07)', () => {
  it('replaces all 9 illegal Windows character classes', () => {
    const out = sanitizeFileName('a<b>c:d"e/f\\g|h?i*j');
    expect(out).not.toMatch(/[<>:"/\\|?*]/);
    expect(out).toContain('_');
  });

  it('replaces C0 control characters \\u0000-\\u001f and DEL', () => {
    const raw = `bad${'\u0000\u0001\u001f\u007f'}name`;
    const out = sanitizeFileName(raw);
    expect(/[\u0000-\u001f\u007f]/.test(out)).toBe(false);
  });

  it('reserved names are case-insensitive INCLUDING suffix variants', () => {
    for (const name of ['CON', 'con', 'Con.txt', 'PRN', 'aux', 'NUL.log', 'com1', 'COM9', 'LPT1', 'lpt9.srt']) {
      const out = sanitizeFileName(name);
      expect(out.startsWith('_'), `${name} must be rewritten, got ${out}`).toBe(true);
      expect(out.toUpperCase()).not.toMatch(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/);
    }
  });

  it('does NOT rewrite ordinary names that merely start with a reserved word', () => {
    expect(sanitizeFileName('Console.txt')).toBe('Console.txt');
    expect(sanitizeFileName('context')).toBe('context');
  });

  it('strips trailing dots and spaces', () => {
    expect(sanitizeFileName('name.')).toBe('name');
    expect(sanitizeFileName('name...   ')).toBe('name');
    expect(sanitizeFileName(' . ')).toBe('_');
  });

  it('never returns an empty name and never throws on an over-long dirty title', () => {
    const out = sanitizeFileName(`<>:"${'x'.repeat(400)}|?*  `);
    expect(out.length).toBeGreaterThan(0);
    expect(/[<>:"/\\|?*]/.test(out)).toBe(false);
  });

  it('is total for non-string input', () => {
    expect(sanitizeFileName(null as unknown as string)).toBe('_');
  });
});

describe('B2 PathResolver · renderTemplate (A-M3-09)', () => {
  it('renders all five supported tokens for a custom template', () => {
    const out = renderTemplate('%(extractor_key)s/%(playlist)s/%(title)s [%(id)s].%(ext)s', vars());
    expect(out).toBe('YouTube/MyList/My Video [abc123].mp4');
  });

  it('supports %(title).200B truncation to 200 characters', () => {
    const long = 'T'.repeat(250);
    expect(renderTemplate('%(title).200B', vars({ title: long }))).toHaveLength(200);
    expect(renderTemplate('%(title).200B', vars())).toBe('My Video');
  });

  it('renders the 3 built-in templates', () => {
    expect(Object.keys(BUILTIN_OUTPUT_TEMPLATES)).toHaveLength(3);
    expect(renderTemplate(BUILTIN_OUTPUT_TEMPLATES['default'] ?? '', vars()))
      .toBe('My Video [abc123].mp4');
    expect(renderTemplate(BUILTIN_OUTPUT_TEMPLATES['simple'] ?? '', vars()))
      .toBe('My Video.mp4');
    expect(renderTemplate(BUILTIN_OUTPUT_TEMPLATES['playlist'] ?? '', vars()))
      .toBe('MyList/My Video [abc123].mp4');
  });

  it('keeps unknown tokens and handles empty templates', () => {
    expect(renderTemplate('%(unknown)s.%(ext)s', vars())).toBe('%(unknown)s.mp4');
    expect(renderTemplate('', vars())).toBe('');
    expect(renderTemplate(null as unknown as string, vars())).toBe('');
  });

  it('D-275 · %(field|default)s renders the default for missing / null / empty fields', () => {
    // yt-dlp treats an empty value as unavailable (the sanitize step turns ''
    // back into None), so the default applies to all three shapes.
    expect(renderTemplate('%(playlist|NA)s', vars({ playlist: 'MyList' }))).toBe('MyList');
    expect(renderTemplate('%(playlist|NA)s', { ...vars(), playlist: '' } as TemplateVars)).toBe('NA');
    expect(renderTemplate('%(playlist|)s', { ...vars(), playlist: null } as unknown as TemplateVars)).toBe('');
    // An unknown key WITH a default renders the default; without one it
    // survives verbatim (unchanged behaviour).
    expect(renderTemplate('%(future|fallback)s', vars())).toBe('fallback');
    expect(renderTemplate('%(future)s', vars())).toBe('%(future)s');
    // Tokens without the pipe syntax are untouched by the new group.
    expect(renderTemplate('%(title)s', vars())).toBe('My Video');
  });
});

describe('B2 PathResolver · buildOutputDir (root only — D-275 moved the categorized layers into -o)', () => {
  it('returns the root whatever the categorized switches say (no %( token in -P)', () => {
    expect(buildOutputDir(paths())).toBe('C:/V');
    expect(buildOutputDir(paths({ subdirByExtractor: true }))).toBe('C:/V');
    expect(buildOutputDir(paths({ subdirByPlaylist: true }))).toBe('C:/V');
    expect(buildOutputDir(paths({ subdirByExtractor: true, subdirByPlaylist: true }))).toBe('C:/V');
  });

  it('uses the supplied base dir; D-229 moved private routing to the intake', () => {
    expect(buildOutputDir(paths(), 'C:/A')).toBe('C:/A');
    // The planner must never return a `%VAR%` token: `-P` reaches a spawned
    // process that will not expand it (D-79). `m4-host.ts::readDefaults` writes
    // the expanded private directory into the request instead.
    expect(buildOutputDir(paths({ privateMode: true }), 'C:/A')).toBe('C:/A');
    expect(buildOutputDir(paths({ privateMode: true, videoDir: 'C:/private' })))
      .toBe('C:/private');
  });

  it('strips trailing separators and never emits a template token', () => {
    expect(buildOutputDir(paths({ videoDir: 'D:/Videos/' }))).toBe('D:/Videos');
    expect(buildOutputDir(paths({ subdirByExtractor: true }))).not.toContain('%');
  });
});

describe('B2 PathResolver · categorizedTemplatePrefix (D-275: layers ride the -o template)', () => {
  it('00 / 10 / 01 / 11', () => {
    expect(categorizedTemplatePrefix(paths())).toBe('');
    expect(categorizedTemplatePrefix(paths({ subdirByExtractor: true }))).toBe('%(extractor_key)s');
    // D-290: the playlist default is `.` (relative no-op), never '' — an empty
    // first segment made the `-o` template start with `/`, i.e. an absolute
    // path, and yt-dlp wrote the media into the DRIVE ROOT.
    expect(categorizedTemplatePrefix(paths({ subdirByPlaylist: true }))).toBe('%(playlist|.)s');
    expect(categorizedTemplatePrefix(paths({ subdirByExtractor: true, subdirByPlaylist: true })))
      .toBe('%(extractor_key)s/%(playlist|.)s');
  });

  it('the playlist layer carries the RELATIVE default: a single video skips it (no NA, no leading /)', () => {
    // yt-dlp renders a missing field as its NA placeholder unless the template
    // carries `|default`. D-290: the default is `.`, so the layer collapses to
    // a relative no-op instead of producing a leading separator.
    expect(renderTemplate(categorizedTemplatePrefix(paths({ subdirByExtractor: true, subdirByPlaylist: true })), vars()))
      .toBe('YouTube/MyList');
    expect(renderTemplate(categorizedTemplatePrefix(paths({ subdirByExtractor: true, subdirByPlaylist: true })), vars({ playlist: '' })))
      .toBe('YouTube/.');
    // The playlist-only prefix must never resolve to something that starts with
    // a separator when the field is absent.
    expect(renderTemplate(categorizedTemplatePrefix(paths({ subdirByPlaylist: true })), vars({ playlist: '' })))
      .not.toMatch(/^\//);
  });

  it('D-290 · preview drops the `.` no-op layer instead of turning it into a `_` directory', () => {
    const single = resolveOutputPath(
      paths({ subdirByPlaylist: true, outputTemplate: '%(title)s.%(ext)s' }),
      vars({ playlist: '' }),
    );
    expect(single.preview.replace(/\\/g, '/')).toBe('C:/V/My Video.mp4');
    expect(single.preview).not.toContain('/_/');
    const playlist = resolveOutputPath(
      paths({ subdirByPlaylist: true, outputTemplate: '%(title)s.%(ext)s' }),
      vars({ playlist: 'MyList' }),
    );
    expect(playlist.preview.replace(/\\/g, '/')).toBe('C:/V/MyList/My Video.mp4');
  });
});

describe('B2 PathResolver · truncateWindowsPath (A-M3-08 / A-4.6-01)', () => {
  it('259 is the last safe length: unchanged, no prefix', () => {
    const p = `C:/V/${'a'.repeat(259 - 5)}`;
    expect(p).toHaveLength(259);
    const result = analyzeWindowsPath(p);
    expect(result.path).toBe(p);
    expect(result.truncated).toBe(false);
    expect(result.usedLongPathPrefix).toBe(false);
  });

  it('260 / 261 get the \\\\?\\ extended prefix and are truncated', () => {
    for (const length of [260, 261]) {
      const p = `C:/V/${'a'.repeat(length - 5)}`;
      expect(p).toHaveLength(length);
      const result = analyzeWindowsPath(p);
      expect(result.usedLongPathPrefix).toBe(true);
      expect(result.truncated).toBe(true);
      expect(result.path.startsWith(LONG_PATH_PREFIX)).toBe(true);
      expect(result.path.length).toBeLessThanOrEqual(WINDOWS_MAX_PATH);
    }
  });

  it('UNC paths get the \\\\?\\UNC\\ prefix', () => {
    const p = `\\\\server\\share\\${'a'.repeat(300)}`;
    const result = analyzeWindowsPath(p);
    expect(result.path.startsWith(LONG_UNC_PREFIX)).toBe(true);
    expect(result.usedLongPathPrefix).toBe(true);
    expect(result.path.length).toBeLessThanOrEqual(WINDOWS_MAX_PATH);
  });

  it('keeps an already-prefixed path and truncates only when over max', () => {
    const short = `${LONG_PATH_PREFIX}C:/V/short`;
    expect(truncateWindowsPath(short)).toBe(short);
    const long = `${LONG_PATH_PREFIX}C:/V/${'a'.repeat(400)}`;
    const result = analyzeWindowsPath(long);
    expect(result.path.startsWith(LONG_PATH_PREFIX)).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.path.length).toBeLessThanOrEqual(WINDOWS_MAX_PATH);
  });

  it('respects an explicit smaller max and never throws on a huge dirty path', () => {
    expect(truncateWindowsPath('C:/V/' + 'a'.repeat(100), 40).length).toBeLessThanOrEqual(40);
    expect(() => truncateWindowsPath(`<>:"${'x'.repeat(5000)}|?*`)).not.toThrow();
    expect(WINDOWS_SAFE_PATH).toBe(259);
  });

  it('is total for empty / non-string input', () => {
    expect(truncateWindowsPath('')).toBe('');
    expect(truncateWindowsPath(null as unknown as string)).toBe('');
    expect(analyzeWindowsPath('').usedLongPathPrefix).toBe(false);
  });
});

describe('B2 PathResolver · resolveOutputPath (Q-M3-09 fixed order / D-43)', () => {
  it('renders -> sanitizes -> builds dir -> truncates, without throwing', () => {
    const dirty = 'a<b>c:d"e/f\\g|h?i*j';
    const resolution = resolveOutputPath(
      paths({ outputTemplate: '%(title)s.%(ext)s', subdirByExtractor: true }),
      vars({ title: dirty }),
    );
    expect(resolution.sanitizationApplied).toBe(true);
    expect(resolution.warnings).toContain('FILE_NAME_SANITIZED');
    // D-275: `dir` is the -P root; the categorized extractor layer renders
    // inside the PREVIEW (it rides the -o template prefix now).
    expect(resolution.dir).toBe('C:/V');
    expect(resolution.template).not.toMatch(/[<>:"/\\|?*]/);
    expect(resolution.preview).toContain('C:/V/YouTube/');
  });

  it('D-275 · both categorized layers preview under the root; a single video skips the playlist layer', () => {
    const both = resolveOutputPath(
      paths({ subdirByExtractor: true, subdirByPlaylist: true }),
      vars(),
    );
    expect(both.dir).toBe('C:/V');
    expect(both.preview).toBe('C:/V/YouTube/MyList/My Video.mp4');
    // playlist === '' -> the layer collapses instead of becoming an NA folder.
    const single = resolveOutputPath(
      paths({ subdirByExtractor: true, subdirByPlaylist: true }),
      vars({ playlist: '' }),
    );
    expect(single.preview).toBe('C:/V/YouTube/My Video.mp4');
  });

  it('a long title with illegal chars is truncated and never throws', () => {
    const dirty = `CON:${'x'.repeat(400)}?`;
    const resolution = resolveOutputPath(paths(), vars({ title: dirty }));
    expect(resolution.sanitizationApplied).toBe(true);
    expect(resolution.preview.length).toBeLessThanOrEqual(WINDOWS_MAX_PATH);
    expect(resolution.preview.length).toBeGreaterThan(0);
  });

  it('clean input needs no sanitization and no long-path prefix', () => {
    const resolution = resolveOutputPath(paths(), vars({ title: 'Clean Title' }));
    expect(resolution.sanitizationApplied).toBe(false);
    expect(resolution.truncated).toBe(false);
    expect(resolution.usedLongPathPrefix).toBe(false);
    expect(resolution.warnings).toEqual([]);
    expect(resolution.preview).toBe('C:/V/Clean Title.mp4');
  });

  it('D-229: the preview follows the request root, never a private-mode token', () => {
    const resolution = resolveOutputPath(paths({ privateMode: true, videoDir: 'C:/private' }), vars());
    expect(resolution.dir).toBe('C:/private');
    expect(resolution.preview.startsWith('C:/private/')).toBe(true);
  });

  // external online audit P3: the preview must run the SAME template chain as
  // the planner (download-plan.ts sanitizes the raw template with
  // `sanitizeToken()` BEFORE rendering), so what the preview shows is what
  // lands on disk. The shipped default template's space therefore previews as
  // `_` — ugly but honest; the actual filename behaviour is frozen (manual §4).
  it('external online audit P3: the default template previews Title_[id], matching the real file', () => {
    const raw = BUILTIN_OUTPUT_TEMPLATES['default'] ?? '';
    const resolution = resolveOutputPath(paths({ outputTemplate: raw }), vars());
    // The template's own space (between %(title).200B and [%(id)s) becomes ONE
    // `_`; the title's internal space stays (the planner sanitizes the TEMPLATE,
    // never yt-dlp's rendered metadata).
    expect(resolution.preview).toBe('C:/V/My Video_[abc123].mp4');
    // Chain parity for the filename part: exactly what the planner's
    // sanitizeToken -> yt-dlp rendering produces for the same vars.
    expect(resolution.preview).toBe(`C:/V/${renderTemplate(sanitizeToken(raw), vars())}`);
    // Template sanitization is argv safety, not filename sanitization: the
    // FILE_NAME_SANITIZED warning still tracks sanitizeFileName() only.
    expect(resolution.sanitizationApplied).toBe(false);
    expect(resolution.warnings).toEqual([]);
  });

  it('external online audit P3: a whitespace RUN in the template previews as one _, like sanitizeToken', () => {
    const resolution = resolveOutputPath(
      paths({ outputTemplate: '%(title)s   [%(id)s].%(ext)s' }),
      vars(),
    );
    // Three consecutive spaces -> exactly one `_` (TOKEN_UNSAFE_RE run rule),
    // so the preview can never disagree with the argv template again.
    expect(resolution.preview).toBe('C:/V/My Video_[abc123].mp4');
  });

  it('external online audit P3: template sanitization never reaches the rendered metadata values', () => {
    // The planner sanitizes the template string only; the title yt-dlp inserts
    // keeps its spaces (no --restrict-filenames, D-110). The preview must not
    // over-sanitize either.
    const resolution = resolveOutputPath(paths(), vars({ title: 'My Two Words' }));
    expect(resolution.preview).toBe('C:/V/My Two Words.mp4');
  });

  it('P2 fix · the baked playlist-title layer previews as a directory — one chain with the argv (D-270)', () => {
    // resolveOutputPath renders exactly what the batch record carries: the
    // literal `<title>/` layer passes through untouched. The argv template is
    // `%(playlist|.)s/My_Playlist/%(title)s.%(ext)s` (sanitizeToken folded the
    // space to `_`); the `.` no-op collapses and the layer stays a REAL
    // directory — the preview must show the same shape yt-dlp renders.
    const layered = resolveOutputPath(
      paths({ subdirByPlaylist: true, outputTemplate: 'My Playlist/%(title)s.%(ext)s' }),
      vars({ playlist: '' }),
    );
    expect(layered.dir).toBe('C:/V');
    expect(layered.preview.replace(/\\/g, '/')).toBe('C:/V/My_Playlist/My Video.mp4');

    // Both categorized switches: the extractor token layer renders first, the
    // `.` playlist no-op is dropped, then the literal layer.
    const both = resolveOutputPath(
      paths({
        subdirByExtractor: true, subdirByPlaylist: true,
        outputTemplate: 'My Playlist/%(title)s.%(ext)s',
      }),
      vars({ playlist: '' }),
    );
    expect(both.preview.replace(/\\/g, '/')).toBe('C:/V/YouTube/My_Playlist/My Video.mp4');
  });

  it('P2 fix · a separator inside a rendered FIELD value stays inside its segment (engine parity)', () => {
    // yt-dlp sanitizes each field value individually: a `/` inside the title
    // becomes `_`, never a phantom directory. Segmenting the TEMPLATE (not the
    // rendered string) keeps that parity — and keeps flat templates
    // byte-identical to the previous whole-string behaviour.
    const dirty = resolveOutputPath(paths(), vars({ title: 'a/b' }));
    expect(dirty.preview.replace(/\\/g, '/')).toBe('C:/V/a_b.mp4');
    // A layered template with a dirty field: the layer stays a directory, the
    // field separator is rewritten inside its own segment.
    const layeredDirty = resolveOutputPath(
      paths({ outputTemplate: 'My_List/%(title)s.%(ext)s' }),
      vars({ title: 'x/y' }),
    );
    expect(layeredDirty.preview.replace(/\\/g, '/')).toBe('C:/V/My_List/x_y.mp4');
  });
});

describe('B2 · three-dir / private-dir config persistence (A-4.4-01 / 02)', () => {
  it('DEFAULT_DOMAINS carries videoDir / audioDir / commandDir / privateMode / tempDir', () => {
    const p = DEFAULT_DOMAINS['paths'];
    for (const key of ['videoDir', 'audioDir', 'commandDir', 'privateMode', 'tempDir']) {
      expect(Object.prototype.hasOwnProperty.call(p, key), `paths.${key} missing`).toBe(true);
    }
    const a = DEFAULT_DOMAINS['advanced'];
    for (const key of ['sponsorblockRemove', 'downloadSections', 'splitChapters', 'customTitle']) {
      expect(Object.prototype.hasOwnProperty.call(a, key), `advanced.${key} missing`).toBe(true);
    }
  });

  it('createDefaultConfig returns a fresh deep clone (no shared references)', () => {
    const one = createDefaultConfig('t1');
    const two = createDefaultConfig('t2');
    expect(one.domains).not.toBe(two.domains);
    expect(one.domains['paths']).not.toBe(two.domains['paths']);
  });

  it('video / audio / command dirs survive a simulated restart', async () => {
    const { ports, state } = createInMemoryPorts();
    const first = new ConfigStore({ ports });
    await first.load();
    await first.set('paths', 'videoDir', 'D:\\Videos');
    await first.set('paths', 'audioDir', 'D:\\Music');
    await first.set('paths', 'commandDir', 'D:\\Commands');
    await first.set('paths', 'privateMode', true);
    expect(state.files.has(CONFIG_PATH)).toBe(true);

    const restarted = new ConfigStore({ ports });
    await restarted.load();
    expect(restarted.get('paths', 'videoDir')).toBe('D:\\Videos');
    expect(restarted.get('paths', 'audioDir')).toBe('D:\\Music');
    expect(restarted.get('paths', 'commandDir')).toBe('D:\\Commands');
    expect(restarted.get('paths', 'privateMode')).toBe(true);
  });
});

/**
 * D-79: the shipped default output dir contains `%USERPROFILE%`, and nothing
 * expands it for a spawned process. Without expansion the download landed in a
 * literal `%USERPROFILE%` folder and every fresh install failed with
 * ARTIFACT_INCOMPLETE.
 */
describe('D-79 · expandEnvVars', () => {
  const env = { USERPROFILE: 'C://Users//leo', LOCALAPPDATA: 'C://Users//leo//AppData//Local' };

  it('expands the shipped default output dir to an absolute path', () => {
    expect(expandEnvVars('%USERPROFILE%/Downloads/YTVDLT', env)).toBe('C://Users//leo/Downloads/YTVDLT');
  });

  it('leaves unknown names verbatim so a typo stays visible', () => {
    expect(expandEnvVars('%NOPE%/x', env)).toBe('%NOPE%/x');
  });

  it('leaves empty-valued names verbatim instead of producing a bare "/x"', () => {
    expect(expandEnvVars('%EMPTY%/x', { EMPTY: '' })).toBe('%EMPTY%/x');
  });

  it('is a no-op for strings without % and does not touch output templates', () => {
    expect(expandEnvVars('D:/Videos', env)).toBe('D:/Videos');
    expect(expandEnvVars('%(title).200B [%(id)s].%(ext)s', env)).toBe('%(title).200B [%(id)s].%(ext)s');
  });
});

/**
 * D-254: the fail-closed companion of `expandEnvVars`. Where `expandEnvVars`
 * keeps an unresolvable token verbatim ON PURPOSE, a DIRECTORY whose expansion
 * still carries a `%NAME%` token must never reach an argv (spawn has no shell,
 * D-79): yt-dlp would create a literal `%LOCALAPPDATA%` folder. Intake code
 * calls this predicate and refuses the request when it answers true.
 */
describe('D-254 · hasUnresolvedEnvToken', () => {
  const env = { LOCALAPPDATA: 'C:/Users/leo/AppData/Local' };

  it('flags a directory whose %VAR% did not resolve', () => {
    expect(hasUnresolvedEnvToken('%LOCALAPPDATA%/YTVDLT/private')).toBe(true);
    expect(hasUnresolvedEnvToken('C:/Users/leo/AppData/Local/YTVDLT/private')).toBe(false);
  });

  it('uses the SAME token rule as expandEnvVars (unknown and empty names verbatim)', () => {
    // Whatever expandEnvVars could not replace is, by definition, unresolved.
    expect(hasUnresolvedEnvToken(expandEnvVars('%LOCALAPPDATA%/YTVDLT/private', {}))).toBe(true);
    expect(hasUnresolvedEnvToken(expandEnvVars('%LOCALAPPDATA%/YTVDLT/private', env))).toBe(false);
  });

  it('never flags output templates — the predicate is a DIRECTORY check only', () => {
    expect(hasUnresolvedEnvToken('%(title)s.%(ext)s')).toBe(true); // templates DO match the token rule…
    // …which is exactly why intake must only ever run it on the private ROOT,
    // never on `paths.outputTemplate`. Pinned here so nobody "generalizes" it.
    expect(hasUnresolvedEnvToken('')).toBe(false);
    expect(hasUnresolvedEnvToken('C:/100%')).toBe(false); // a lone % is not a token
  });
});
