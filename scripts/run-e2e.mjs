#!/usr/bin/env node
/**
 * run-e2e.mjs — `npm run test:e2e` entry point (F028 / PRD §5.5 / D-31).
 *
 * Drives the CACHED `chrome-headless-shell.exe` with spawnSync(absolutePath,
 * argv[], {shell:false, windowsHide:true}) — no shell strings, no npm deps.
 * For each case it takes one `--screenshot` and one `--dump-dom`, then applies:
 *   main criterion ①  deterministic DOM snapshot + structural DOM assertions
 *   main criterion ②  pixel-tolerance RGBA diff (png-diff.mjs, tolerance 2 /
 *                     max differing ratio 0.1%, strict 1280x800)
 *   data red line    fixture has no `url` keys, writeback has no `url` /
 *                    `mergeToMkv`, playlist writes ONLY selectedPlaylistIds
 *   QA negative      corrupt a PNG / DOM / fixture copy -> MUST FAIL
 *
 * `--update-baselines` regenerates the committed PNG + DOM baselines.
 * A missing baseline is a FAIL (never silently created on a normal run).
 * Writes fully reproducible metadata to `reports/e2e-summary.json`.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  E2E_CASES, FIXTURES, RENDER_FLAGS, RENDER_METADATA,
  dialogPath, pagePath, baselineNames,
} from './e2e-cases.mjs';
import {
  decodePng, comparePngBuffers, compareRgba, corruptRgba, sha256,
  DEFAULT_TOLERANCE, DEFAULT_MAX_RATIO,
} from './lib/png-diff.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPORTS = join(ROOT, 'reports');
const BASELINES = join(ROOT, 'tests', 'e2e', 'baselines');
const FIXTURE_DIR = join(ROOT, 'tests', 'e2e', 'fixtures');
const TMP = join(REPORTS, 'e2e-tmp');
const EXE = 'C:\\Users\\leolee\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1234\\chrome-headless-shell-win64\\chrome-headless-shell.exe';
const EXPECTED_VERSION = 'Google Chrome for Testing 151.0.7922.34';

const argv = process.argv.slice(2);
const updateBaselines = argv.includes('--update-baselines');
const negativeChecksRequested = argv.includes('--negative-checks');
const asJson = argv.includes('--json');
const caseFilterArg = argv.find((a) => a.startsWith('--case='));
const caseFilter = caseFilterArg ? caseFilterArg.split('=')[1] : null;

function normalize(text) {
  return String(text).replace(/\r\n/g, '\n').trimEnd();
}

/** Spawn the cached headless shell with an argv[] (never a shell string). */
function runChrome(args) {
  return spawnSync(EXE, args, {
    cwd: ROOT,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  });
}

function fileUrl(absoluteWindowsPath, query) {
  return `file:///${absoluteWindowsPath.replace(/\\/g, '/')}${query ? `?${query}` : ''}`;
}

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }

function hasUrlKey(value) {
  if (Array.isArray(value)) return value.some(hasUrlKey);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value).some((key) => key === 'url' || hasUrlKey(value[key]));
  }
  return false;
}

function hasForbiddenKey(value, forbidden) {
  if (Array.isArray(value)) return value.some((item) => hasForbiddenKey(item, forbidden));
  if (value !== null && typeof value === 'object') {
    return Object.keys(value).some((key) => forbidden.includes(key) || hasForbiddenKey(value[key], forbidden));
  }
  return false;
}

/** Verify the L1-recorded fixtures: no URL, data homonymous with M1 recordings. */
function validateFixtures() {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });
  const recordedVideo = readJson(join(ROOT, 'tests', 'fixtures', 'info-video.json'));
  const recordedPlaylist = readJson(join(ROOT, 'tests', 'fixtures', 'info-flat-playlist.json'));
  const fixtures = {};
  for (const name of Object.values(FIXTURES)) {
    const path = join(FIXTURE_DIR, name);
    add(`fixture-exists:${name}`, existsSync(path), path);
    if (existsSync(path)) fixtures[name] = readJson(path);
  }
  for (const name of Object.keys(fixtures)) {
    add(`fixture-no-url-key:${name}`, !hasUrlKey(fixtures[name]), 'no own property named url');
    add(`fixture-no-mergeToMkv:${name}`, !hasForbiddenKey(fixtures[name], ['mergeToMkv']), 'no mergeToMkv');
  }
  const media = fixtures[FIXTURES.media]?.media;
  const playlist = fixtures[FIXTURES.playlist]?.playlist;
  const empty = fixtures[FIXTURES.empty];
  add('same-source-format-ids',
    Array.isArray(media?.formats) && media.formats.map((f) => f.format_id).join(',') ===
      recordedVideo.formats.map((f) => f.format_id).join(','),
    `dialog=${media?.formats?.map((f) => f.format_id).join(',')} recorded=${recordedVideo.formats.map((f) => f.format_id).join(',')}`);
  add('same-source-subtitle-languages',
    media?.subtitles && Object.keys(media.subtitles).join(',') === Object.keys(recordedVideo.subtitles).join(','),
    Object.keys(media?.subtitles || {}).join(','));
  add('same-source-entry-ids',
    Array.isArray(playlist?.entries) && playlist.entries.map((e) => e.id).join(',') ===
      recordedPlaylist.entries.map((e) => e.id).join(','),
    playlist?.entries?.map((e) => e.id).join(','));
  add('same-source-entry-titles',
    Array.isArray(playlist?.entries) && playlist.entries.map((e) => e.title).join('|') ===
      recordedPlaylist.entries.map((e) => e.title).join('|'),
    playlist?.entries?.map((e) => e.title).join('|'));
  add('empty-fixture-is-empty',
    empty?.media?.formats?.length === 0 && Object.keys(empty?.media?.subtitles || {}).length === 0 &&
    empty?.playlist?.entries?.length === 0,
    'formats=[] subtitles={} entries=[]');
  add('empty-fixture-error-code', empty?.error?.code === 'UNSUPPORTED_SITE', empty?.error?.code);
  return { checks, fixtures, pass: checks.every((c) => c.pass) };
}

function decodeEntities(text) {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/** Pull the dialog's five-domain (or selectedIds) writeback out of the DOM. */
function extractWriteback(dom) {
  // Attribute order differs per page; match the id, not the exact tag shape.
  const match = /<pre[^>]*id="ytvdlt-output"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
  if (!match) return { found: false, value: null, raw: '' };
  const raw = decodeEntities(match[1]);
  try { return { found: true, value: JSON.parse(raw), raw }; }
  catch (error) { return { found: true, value: null, raw, parseError: error.message }; }
}

function checkWriteback(dom, expectedKind, expectWriteback) {
  const checks = [];
  const writeback = extractWriteback(dom);
  const add = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });
  add('writeback-present', writeback.found, writeback.found ? `${writeback.raw.length} chars` : 'missing <pre>');
  add('writeback-json-parseable', writeback.value !== null, writeback.parseError || 'ok');

  // A case without `autoconfirm=1` must NOT have produced a confirmation:
  // the confirm gate is closed (empty / error / disabled / invalid expression).
  if (!expectWriteback) {
    add('confirm-gate-closed',
      writeback.value === null || writeback.value.kind === undefined,
      'no DialogConfirmResult emitted');
    add('no-url-key', !hasUrlKey(writeback.value || {}), 'no own property named url');
    add('no-mergeToMkv-key', !hasForbiddenKey(writeback.value || {}, ['mergeToMkv']), 'no mergeToMkv');
    add('dom-no-media-url', !/"url"\s*:/.test(dom) && !/data-format-url|data-subtitle-url/.test(dom),
      'no url key / no data-*-url attribute');
    return { checks, pass: checks.every((c) => c.pass), writeback };
  }

  add('writeback-confirmed', writeback.value?.confirmed === true, String(writeback.value?.confirmed));
  if (writeback.value !== null) {
    add('writeback-kind', writeback.value.kind === expectedKind, writeback.value.kind);
    add('no-url-key', !hasUrlKey(writeback.value), 'no own property named url');
    add('no-mergeToMkv-key', !hasForbiddenKey(writeback.value, ['mergeToMkv']), 'no mergeToMkv');
    if (expectedKind === 'playlist') {
      add('only-selected-ids',
        Array.isArray(writeback.value.selectedPlaylistIds) && writeback.value.requestPatch === undefined &&
        !/enqueueBatch|TaskRecord/.test(JSON.stringify(writeback.value)),
        JSON.stringify(writeback.value.selectedPlaylistIds || []));
    } else {
      const patch = writeback.value.requestPatch;
      add('five-domains-isomorphic', patch !== null && typeof patch === 'object' &&
        ['format', 'subtitle', 'paths', 'network', 'advanced'].every((k) => k in patch),
        Object.keys(patch || {}).join(','));
    }
  }
  add('dom-no-media-url', !/"url"\s*:/.test(dom) && !/data-format-url|data-subtitle-url/.test(dom),
    'no url key / no data-*-url attribute');
  return { checks, pass: checks.every((c) => c.pass), writeback };
}

function assertDom(dom, checks) {
  const failures = [];
  const passes = [];
  for (const check of checks) {
    const pattern = check.pattern instanceof RegExp ? check.pattern : new RegExp(check.pattern);
    const matched = pattern.test(dom);
    const ok = check.absent === true ? !matched : matched;
    (ok ? passes : failures).push({ name: check.name, pattern: String(check.pattern), absent: check.absent === true });
  }
  return { pass: failures.length === 0, passes, failures };
}

/** Three reproducible, in-memory negative checks (QA can also corrupt files). */
function runNegativeChecks(caseResults, baselineBuffers) {
  const items = [];
  // ① corrupt a PNG baseline by one pixel -> main criterion ② must FAIL.
  try {
    const first = caseResults.find((c) => c.pngBuffer !== null);
    const decoded = decodePng(first.pngBuffer);
    const corrupted = corruptRgba(decoded, 1);
    const verdict = compareRgba(decoded, corrupted, { tolerance: DEFAULT_TOLERANCE, maxRatio: DEFAULT_MAX_RATIO });
    items.push({
      id: 'png-baseline-corrupted', expected: 'main criterion ② FAIL', actual: verdict.pass ? 'PASS' : 'FAIL',
      pass: verdict.pass === false, detail: `differPixels=${verdict.differPixels} ratio=${verdict.ratio}`,
    });
    // Also replace the whole baseline with a DIFFERENT case's screenshot.
    const other = caseResults.find((c) => c.id !== first.id && c.pngBuffer !== null);
    if (other) {
      const otherDecoded = decodePng(other.pngBuffer);
      const whole = compareRgba(decoded, otherDecoded, { tolerance: DEFAULT_TOLERANCE, maxRatio: DEFAULT_MAX_RATIO });
      items.push({
        id: 'png-baseline-replaced', expected: 'main criterion ② FAIL', actual: whole.pass ? 'PASS' : 'FAIL',
        pass: whole.pass === false, detail: `differPixels=${whole.differPixels} ratio=${whole.ratio}`,
      });
    }
  } catch (error) {
    items.push({ id: 'png-baseline-corrupted', expected: 'FAIL', actual: 'ERROR', pass: false, detail: error.message });
  }
  // ② corrupt a DOM baseline (remove a control / flip aria-disabled) -> ① must FAIL.
  try {
    const domCase = caseResults.find((c) => c.id === 'format-ready') || caseResults[0];
    const baseline = baselineBuffers[domCase.id].dom;
    const corrupted = baseline.replace('id="ytvdlt-confirm"', 'id="ytvdlt-confirm-removed"')
      .replace('aria-disabled="true"', 'aria-disabled="false"');
    const differs = normalize(corrupted) !== normalize(baseline);
    const verdict = normalize(corrupted) === normalize(domCase.dom);
    items.push({
      id: 'dom-baseline-corrupted', expected: 'main criterion ① FAIL',
      actual: (differs && !verdict) ? 'FAIL' : 'PASS', pass: differs && !verdict,
      detail: `baseline changed=${differs} equalsActual=${verdict}`,
    });
  } catch (error) {
    items.push({ id: 'dom-baseline-corrupted', expected: 'FAIL', actual: 'ERROR', pass: false, detail: error.message });
  }
  // ③ corrupt a fixture (inject url / invent format_id) -> red-line must FAIL.
  try {
    const fixture = JSON.parse(JSON.stringify(validateFixtures().fixtures[FIXTURES.media]));
    fixture.media.formats[0].url = 'https://evil.example/credential';
    const injectedUrlDetected = hasUrlKey(fixture);
    fixture.media.formats.push({ format_id: 'INVENTED_999' });
    const recorded = readJson(join(ROOT, 'tests', 'fixtures', 'info-video.json'));
    const inventedDetected = fixture.media.formats.map((f) => f.format_id).join(',') !==
      recorded.formats.map((f) => f.format_id).join(',');
    items.push({
      id: 'fixture-corrupted-url', expected: 'red-line FAIL', actual: injectedUrlDetected ? 'FAIL' : 'PASS',
      pass: injectedUrlDetected, detail: 'injected formats[0].url detected',
    });
    items.push({
      id: 'fixture-corrupted-format-id', expected: 'data-homonymy FAIL', actual: inventedDetected ? 'FAIL' : 'PASS',
      pass: inventedDetected, detail: 'invented format_id detected against recorded fixture',
    });
  } catch (error) {
    items.push({ id: 'fixture-corrupted', expected: 'FAIL', actual: 'ERROR', pass: false, detail: error.message });
  }
  return items;
}

async function main() {
  const started = performance.now();
  mkdirSync(REPORTS, { recursive: true });
  mkdirSync(BASELINES, { recursive: true });
  mkdirSync(TMP, { recursive: true });

  const versionRun = runChrome(['--version']);
  const version = (versionRun.stdout || '').trim();
  const versionOk = versionRun.status === 0 && version === EXPECTED_VERSION;
  const exeOk = existsSync(EXE);

  const fixtureValidation = validateFixtures();
  const cases = caseFilter ? E2E_CASES.filter((c) => c.id === caseFilter) : E2E_CASES;
  const results = [];
  const baselineBuffers = {};

  for (const testCase of cases) {
    const caseStart = performance.now();
    const htmlPath = testCase.page ? pagePath(ROOT, testCase.page) : dialogPath(ROOT, testCase.dialog);
    const url = fileUrl(htmlPath, testCase.query);
    const tempPng = join(TMP, `${testCase.id}.png`);
    const names = baselineNames(testCase.id);
    const baselinePng = join(BASELINES, names.png);
    const baselineDom = join(BASELINES, names.dom);

    const shotArgv = [...RENDER_FLAGS, `--screenshot=${tempPng}`, url];
    const domArgv = [...RENDER_FLAGS, '--dump-dom', url];

    const shot = runChrome(shotArgv);
    const domRun = runChrome(domArgv);
    const dom = normalize(domRun.stdout || '');
    const pngBuffer = existsSync(tempPng) ? readFileSync(tempPng) : null;

    const domAssertions = assertDom(dom, testCase.checks);
    const dialogName = typeof testCase.dialog === 'string' ? testCase.dialog : '';
    const kind = dialogName.startsWith('playlist') ? 'playlist'
      : dialogName.startsWith('subtitle') ? 'subtitle' : 'format';
    const expectWriteback = testCase.query.includes('autoconfirm=1');
    const writeback = checkWriteback(dom, kind, expectWriteback);

    // ---- main criterion ① : DOM snapshot baseline ----
    let domBaseline = { pass: false, reason: 'missing baseline' };
    if (updateBaselines) {
      writeFileSync(baselineDom, `${dom}\n`, 'utf8');
      domBaseline = { pass: true, reason: 'baseline generated (verified on next normal run)' };
    } else if (existsSync(baselineDom)) {
      const expected = normalize(readFileSync(baselineDom, 'utf8'));
      domBaseline = expected === dom
        ? { pass: true, reason: 'DOM snapshot identical' }
        : { pass: false, reason: 'DOM snapshot differs from baseline' };
    }
    baselineBuffers[testCase.id] = {
      dom: existsSync(baselineDom) ? normalize(readFileSync(baselineDom, 'utf8')) : dom,
    };

    // ---- main criterion ② : pixel tolerance diff ----
    let pixel = { pass: false, reason: 'no screenshot produced' };
    if (pngBuffer !== null) {
      if (updateBaselines) {
        copyFileSync(tempPng, baselinePng);
        pixel = { pass: true, reason: 'baseline generated (verified on next normal run)', differPixels: 0, ratio: 0 };
      } else if (existsSync(baselinePng)) {
        pixel = comparePngBuffers(readFileSync(baselinePng), pngBuffer, {
          tolerance: DEFAULT_TOLERANCE, maxRatio: DEFAULT_MAX_RATIO,
        });
        pixel = { ...pixel, pass: pixel.pass === true };
      } else {
        pixel = { pass: false, reason: 'PNG baseline missing' };
      }
    }

    const baselineHashes = {
      png: existsSync(baselinePng) ? sha256(readFileSync(baselinePng)) : null,
      dom: existsSync(baselineDom) ? sha256(readFileSync(baselineDom, 'utf8')) : null,
    };

    const pass = exeOk && versionOk && shot.status === 0 && domRun.status === 0
      && fixtureValidation.pass && domAssertions.pass && writeback.pass
      && domBaseline.pass && pixel.pass;

    results.push({
      pngBuffer,
      id: testCase.id,
      dialog: testCase.dialog,
      fixture: testCase.fixture,
      state: testCase.state,
      assertionIds: testCase.assertionIds,
      pass,
      durationMs: Math.max(1, Math.round(performance.now() - caseStart)),
      screenshotExitCode: shot.status,
      domExitCode: domRun.status,
      domAssertions: {
        pass: domAssertions.pass,
        passed: domAssertions.passes.map((p) => p.name),
        failures: domAssertions.failures,
      },
      writeback: { pass: writeback.pass, checks: writeback.checks, value: writeback.writeback.value },
      domBaseline,
      pixel: {
        pass: pixel.pass, reason: pixel.reason,
        differPixels: pixel.differPixels ?? 0, ratio: pixel.ratio ?? 0,
        maxChannelDiff: pixel.maxChannelDiff ?? 0,
        tolerance: DEFAULT_TOLERANCE, maxRatio: DEFAULT_MAX_RATIO,
        width: pixel.width ?? 1280, height: pixel.height ?? 800,
      },
      baselineSha256: baselineHashes,
      argv: { screenshot: shotArgv, dumpDom: domArgv },
    });
  }

  const negativeChecks = runNegativeChecks(results, baselineBuffers);
  const allPass = exeOk && versionOk && fixtureValidation.pass
    && results.every((r) => r.pass)
    && negativeChecks.every((n) => n.pass);

  const fixtureHashes = {};
  for (const name of Object.values(FIXTURES)) {
    const path = join(FIXTURE_DIR, name);
    if (existsSync(path)) fixtureHashes[name] = sha256(readFileSync(path));
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    carrier: 'zero-dependency static HTML/CSS + native DOM (PRD-M3 §5.5 / D-31)',
    exePath: EXE,
    exeVersion: version,
    exeVersionExpected: EXPECTED_VERSION,
    exeVersionOk: versionOk,
    exeExists: exeOk,
    renderFlags: RENDER_FLAGS,
    renderMetadata: RENDER_METADATA,
    tolerance: { channel: DEFAULT_TOLERANCE, maxDifferRatio: DEFAULT_MAX_RATIO, expectedSize: '1280x800' },
    fixtureSha256: fixtureHashes,
    fixtureValidation: fixtureValidation.checks,
    cases: results.map(({ pngBuffer, ...rest }) => rest),
    negativeChecks,
    negativeChecksRequested,
    summary: {
      total: results.length,
      passed: results.filter((r) => r.pass).length,
      failed: results.filter((r) => !r.pass).length,
      negativePassed: negativeChecks.filter((n) => n.pass).length,
      negativeTotal: negativeChecks.length,
      allPass,
    },
    durationMs: Math.max(1, Math.round(performance.now() - started)),
    honestNote: 'PNG byte/SHA-256 comparison is auxiliary only (Chrome metadata is non-deterministic); main criteria are DOM snapshot + RGBA tolerance diff.',
  };
  writeFileSync(join(REPORTS, 'e2e-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    for (const item of results) {
      console.log(`[e2e] ${item.pass ? 'PASS' : 'FAIL'} ${item.id} | state=${item.state} dom=${item.domAssertions.pass} writeback=${item.writeback.pass} snapshot=${item.domBaseline.pass} pixel=${item.pixel.pass} (${item.pixel.differPixels} px) ${item.durationMs}ms`);
      for (const failure of item.domAssertions.failures) console.log(`[e2e]   DOM assertion FAILED: ${failure.name}`);
      for (const check of item.writeback.checks) if (!check.pass) console.log(`[e2e]   writeback FAILED: ${check.name} (${check.detail})`);
      if (!item.pixel.pass) console.log(`[e2e]   pixel FAILED: ${item.pixel.reason}`);
      if (!item.domBaseline.pass) console.log(`[e2e]   snapshot FAILED: ${item.domBaseline.reason}`);
    }
    for (const negative of negativeChecks) {
      console.log(`[e2e] negative ${negative.pass ? 'PASS' : 'FAIL'} ${negative.id}: expected ${negative.expected}, actual ${negative.actual}`);
    }
    console.log(`[e2e] exe ${version} (ok=${versionOk})`);
    console.log(`[e2e] ${summary.summary.passed}/${summary.summary.total} cases PASS, ${summary.summary.negativePassed}/${summary.summary.negativeTotal} negative checks PASS, allPass=${allPass}`);
  }
  if (negativeChecksRequested && !negativeChecks.every((n) => n.pass)) {
    console.error('[e2e] --negative-checks: at least one negative check did not FAIL as required');
  }
  process.exitCode = allPass ? 0 : 1;
}

main().catch((error) => {
  console.error(`[e2e] fatal: ${error?.stack ?? String(error)}`);
  process.exitCode = 1;
});
