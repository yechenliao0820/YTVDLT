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
  resolveOutputPath, truncateWindowsPath, analyzeWindowsPath, expandEnvVars,
  BUILTIN_OUTPUT_TEMPLATES, PRIVATE_OUTPUT_DIR,
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
});

describe('B2 PathResolver · buildOutputDir 4 combinations (A-4.4-03)', () => {
  it('00 / 10 / 01 / 11', () => {
    expect(buildOutputDir(paths(), 'YouTube', 'MyList')).toBe('C:/V');
    expect(buildOutputDir(paths({ subdirByExtractor: true }), 'YouTube', 'MyList'))
      .toBe('C:/V/YouTube');
    expect(buildOutputDir(paths({ subdirByPlaylist: true }), 'YouTube', 'MyList'))
      .toBe('C:/V/MyList');
    expect(buildOutputDir(paths({ subdirByExtractor: true, subdirByPlaylist: true }), 'YouTube', 'MyList'))
      .toBe('C:/V/YouTube/MyList');
  });

  it('selects audioDir as base when supplied and privateMode when enabled', () => {
    expect(buildOutputDir(paths(), 'YouTube', 'MyList', 'C:/A')).toBe('C:/A');
    expect(buildOutputDir(paths({ privateMode: true }), 'YouTube', 'MyList', 'C:/A'))
      .toBe(PRIVATE_OUTPUT_DIR);
  });

  it('sanitizes subdir tokens and strips trailing separators', () => {
    expect(buildOutputDir(paths({ videoDir: 'D:/Videos/', subdirByExtractor: true }), 'My Extractor', 'P'))
      .toBe('D:/Videos/My_Extractor');
    expect(buildOutputDir(paths({ subdirByPlaylist: true }), 'YT', '')).toBe('C:/V');
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
    expect(resolution.dir).toBe('C:/V/YouTube');
    expect(resolution.template).not.toMatch(/[<>:"/\\|?*]/);
    expect(resolution.preview).toContain('C:/V/YouTube');
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

  it('UNSC private mode routes the preview to the private directory', () => {
    const resolution = resolveOutputPath(paths({ privateMode: true }), vars());
    expect(resolution.dir).toBe(PRIVATE_OUTPUT_DIR);
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
