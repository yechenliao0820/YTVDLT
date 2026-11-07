/**
 * B4 / F039 · Dialog DTO contract (PRD §5.4, ARCH §3.4, §8.4).
 *
 * The three dialogs serialise their confirmation into
 * `<pre id="ytvdlt-output">`. This contract verifies the serialised payload is
 * ISOMORPHIC to the five frozen `DownloadRequest` domains, carries neither
 * `mergeToMkv` (D-35) nor any credential-bearing `url` (§8.4), and that the
 * playlist dialog writes back `selectedIds` ONLY (A-M3-04 / D-38).
 *
 * All inputs are real artefacts on disk: the L1-recorded e2e fixtures and the
 * committed DOM snapshot baselines produced by `npm run test:e2e`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DialogConfirmResult, DialogKind, DialogState, ProbeResultDto,
} from '@ytvdlt/shared';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BASELINES = join(ROOT, 'tests', 'e2e', 'baselines');
const FIXTURES = join(ROOT, 'tests', 'e2e', 'fixtures');
const UI_ROOT = join(ROOT, 'packages', 'ui', 'src');

/** Frozen five-domain signatures from `packages/shared/src/request.ts` (M1). */
const FROZEN_DOMAINS = {
  format: [
    'quality', 'videoCodecPref', 'formatId', 'sortingFields', 'extractAudio',
    'audioQuality', 'audioCodecPref', 'audioFormat', 'audioMultistreams',
  ],
  subtitle: [
    'enabled', 'languages', 'autoCaptions', 'skipTranslated', 'convertTo',
    'embed', 'keepSubtitleFile',
  ],
  paths: [
    'videoDir', 'audioDir', 'commandDir', 'privateMode', 'subdirByExtractor',
    'subdirByPlaylist', 'outputTemplate', 'tempDir',
  ],
  network: [
    'rateLimit', 'proxy', 'cookiesFile', 'userAgent', 'ipv4Only',
    'concurrentFragments', 'aria2cPath',
  ],
  advanced: [
    'sponsorblockRemove', 'downloadSections', 'splitChapters', 'customTitle',
    'debug', 'downloadArchive', 'customCommand',
  ],
} as const;
const DOMAIN_NAMES = Object.keys(FROZEN_DOMAINS) as Array<keyof typeof FROZEN_DOMAINS>;

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Extract and parse the confirmation JSON from a committed DOM baseline. */
function readWriteback(caseId: string): Record<string, unknown> {
  const dom = readFileSync(join(BASELINES, `${caseId}.dom.html`), 'utf8');
  const match = /<pre id="ytvdlt-output"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
  expect(match, `${caseId}: <pre id="ytvdlt-output"> missing`).not.toBeNull();
  const raw = decodeEntities((match as RegExpExecArray)[1] as string);
  const parsed: unknown = JSON.parse(raw);
  expect(parsed).toBeTypeOf('object');
  return parsed as Record<string, unknown>;
}

function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      collectKeys(item, out);
    }
  }
  return out;
}

describe('A-M3-06 · Dialog confirm DTO is isomorphic to the five frozen domains', () => {
  for (const caseId of ['format-ready', 'subtitle-ready'] as const) {
    it(`${caseId} writes back exactly the five domains, nothing more`, () => {
      const dto = readWriteback(caseId) as unknown as DialogConfirmResult;
      expect(dto.confirmed).toBe(true);
      expect(dto.state).toBe('ready');
      const stateCheck: DialogState = dto.state;
      expect(stateCheck).toBe('ready');
      expect((['format', 'subtitle'] as DialogKind[])).toContain(dto.kind);
      expect(Object.keys(dto).sort()).toEqual(
        ['confirmed', 'kind', 'requestPatch', 'state'].sort(),
      );

      const patch = dto.requestPatch as Record<string, Record<string, unknown>>;
      expect(patch).toBeTypeOf('object');
      expect(Object.keys(patch).sort()).toEqual([...DOMAIN_NAMES].sort());
      for (const domain of DOMAIN_NAMES) {
        expect(Object.keys(patch[domain] as object).sort()).toEqual(
          [...FROZEN_DOMAINS[domain]].sort(),
        );
      }
    });

    it(`${caseId} never leaks mergeToMkv / url / taskId / customCommand values`, () => {
      const dto = readWriteback(caseId);
      const keys = collectKeys(dto);
      for (const forbidden of ['mergeToMkv', 'url', 'taskId']) {
        expect(keys).not.toContain(forbidden);
      }
      const serialised = JSON.stringify(dto);
      expect(serialised).not.toMatch(/"url"\s*:/);
      expect(serialised).not.toContain('mergeToMkv');
      expect(serialised).not.toContain('"taskId"');
      expect(serialised).not.toContain('example.org');
    });
  }

  it('format dialog forwards the recommended 137+251 selection', () => {
    const dto = readWriteback('format-ready');
    const patch = dto['requestPatch'] as Record<string, Record<string, unknown>>;
    expect(patch['format']?.['formatId']).toBe('137+251');
    expect(patch['format']?.['quality']).toBe('best');
    expect(patch['subtitle']?.['enabled']).toBe(false);
  });

  it('subtitle dialog forwards the selected language and enabled=true', () => {
    const dto = readWriteback('subtitle-ready');
    const patch = dto['requestPatch'] as Record<string, Record<string, unknown>>;
    expect(patch['subtitle']?.['enabled']).toBe(true);
    expect(patch['subtitle']?.['languages']).toBe('en');
    expect(['none', 'ass', 'srt', 'vtt', 'lrc']).toContain(patch['subtitle']?.['convertTo']);
  });
});

describe('A-M3-04 / D-38 · Playlist confirm writes back selectedIds ONLY', () => {
  it('contains no requestPatch, no enqueue and no TaskRecord', () => {
    const dto = readWriteback('playlist-ready') as unknown as DialogConfirmResult;
    expect(dto.kind).toBe('playlist');
    expect(dto.confirmed).toBe(true);
    expect(Object.keys(dto).sort()).toEqual(
      ['confirmed', 'kind', 'selectedPlaylistIds', 'state'].sort(),
    );
    expect(dto.selectedPlaylistIds).toEqual(['a1', 'a2', 'a3']);
    expect(dto.requestPatch).toBeUndefined();

    const serialised = JSON.stringify(dto);
    for (const forbidden of [
      'requestPatch', 'enqueueBatch', 'TaskRecord', 'mergeToMkv',
      'taskId', 'url', 'customCommand',
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('the DOM baseline explicitly records that enqueueBatch was never called', () => {
    const dom = readFileSync(join(BASELINES, 'playlist-ready.dom.html'), 'utf8');
    expect(dom).toContain('data-enqueue-batch="never"');
    expect(dom).toContain('保存选择');
    expect(dom).not.toMatch(/"url"\s*:/);
  });
});

describe('§8.4 · L1 dialog fixtures carry zero credential-bearing URLs', () => {
  for (const fixture of [
    'dialog-media.json', 'dialog-playlist.json', 'dialog-media-empty.json',
  ] as const) {
    it(`${fixture} has no url key anywhere`, () => {
      const raw = readFileSync(join(FIXTURES, fixture), 'utf8');
      const value = JSON.parse(raw) as ProbeResultDto;
      expect(collectKeys(value)).not.toContain('url');
      expect(raw).not.toMatch(/"url"\s*:/);
      // `webpage_url` / `thumbnail` are non-credential example.org placeholders
      // from the M1 recording; only signed MediaFormat.url / SubtitleTrack.url
      // (and query-string credentials) are forbidden.
      for (const credential of ['signature=', 'sig=', 'token=', 'expire=', 'X-Amz-']) {
        expect(raw, `credential marker ${credential}`).not.toContain(credential);
      }
      const media = (value as ProbeResultDto).media;
      if (media !== null) {
        expect(collectKeys(media.formats)).not.toContain('url');
        expect(collectKeys(media.subtitles)).not.toContain('url');
        expect(collectKeys(media.automatic_captions)).not.toContain('url');
      }
    });
  }
});

describe('§8.4 · Renderer sources never import Node / Electron', () => {
  it('ipc-bridge.js and dialog-state.js stay pure browser ES modules', () => {
    for (const relative of [
      'ipc-bridge.js', 'dialogs/dialog-state.js',
      'dialogs/format-selector.js', 'dialogs/subtitle-selector.js',
      'dialogs/playlist-selector.js', 'fixtures/probe-fixture.js',
    ] as const) {
      const source = readFileSync(join(UI_ROOT, relative), 'utf8');
      expect(source, relative).not.toMatch(/from\s+['"]node:/);
      expect(source, relative).not.toMatch(/from\s+['"](?:fs|path|child_process)['"]/);
      expect(source, relative).not.toMatch(/from\s+['"]electron['"]/);
      expect(source, relative).not.toMatch(/require\s*\(/);
    }
  });

  it('ipc-bridge.js talks only through window.ytvdltBridge', () => {
    const source = readFileSync(join(UI_ROOT, 'ipc-bridge.js'), 'utf8');
    expect(source).toContain('window.ytvdltBridge');
    expect(source).not.toMatch(/\bipcRenderer\b/);
    expect(source).not.toMatch(/\bcontextBridge\b/);
  });
});
