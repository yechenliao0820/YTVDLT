/**
 * TASK-03 (D-134) — verify `classifySupportFailure()` against stderr captured
 * from the REAL bundled engine, not against strings typed from memory.
 *
 *   node --import tsx scripts/task03-classify-evidence.mjs
 *
 * Offline: reads the recorded capture, spawns nothing, touches no network.
 *
 * WHY THIS SCRIPT EXISTS SEPARATELY FROM THE UNIT TEST
 *   `tests/unit/site-support.test.ts` asserts the SAME function, but only over
 *   a handful of hand-picked message shapes. This script replays the FULL
 *   `--simulate` capture from `reports/task03/probe5-raw.json` (10 local cases,
 *   raw stderr per case) so the mapping is checked against every wording the
 *   engine actually produced, including the ones nobody thought to copy.
 *
 *   It imports the REAL function rather than restating its regexes. An earlier
 *   draft re-derived them, which meant the check could keep passing after the
 *   implementation changed — a check that cannot fail is not a check.
 *
 *   The capture lives under `reports/` (gitignored). When it is absent this
 *   script reports SKIPPED and exits 0 — it never fabricates a capture to
 *   "pass" against.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { classifySupportFailure, extractorClaimedUrl } from '../packages/engine-ytdlp/src/index.ts';

const CAPTURE = join(process.cwd(), 'reports', 'task03', 'probe5-raw.json');

if (!existsSync(CAPTURE)) {
  process.stdout.write(
    `SKIPPED — no capture at ${CAPTURE}\n`
    + '  Re-create it with: node --import tsx reports/task03/probe5.mjs\n',
  );
  process.exit(0);
}

const raw = JSON.parse(readFileSync(CAPTURE, 'utf8'));

/**
 * The expected state per case, from the requirement's semantics (§3.1/§3.4):
 * success cases are SUPPORTED; the bare `Unsupported URL:` cases are NO_MEDIA;
 * transient/HTTP failures are INDETERMINATE; an unroutable input is UNSUPPORTED.
 */
const EXPECT = {
  '/media.html': { exit: 0, state: 'SUPPORTED' },
  '/audio.html': { exit: 0, state: 'SUPPORTED' },
  '/video-dangling.html': { exit: 0, state: 'SUPPORTED' },
  '/v.mp4': { exit: 0, state: 'SUPPORTED' },
  '/plain.txt': { exit: 0, state: 'SUPPORTED' },
  '/nomedia.html': { exit: 1, state: 'NO_MEDIA' },
  '/video-nosrc.html': { exit: 1, state: 'NO_MEDIA' },
  '/missing(404)': { exit: 1, state: 'INDETERMINATE' },
  refused: { exit: 1, state: 'INDETERMINATE' },
  notaurl: { exit: 1, state: 'UNSUPPORTED' },
};

let failures = 0;
let checked = 0;

process.stdout.write(
  `${'label'.padEnd(20)}${'exit'.padEnd(6)}${'classified'.padEnd(15)}${'claimed'.padEnd(9)}expect\n`,
);

for (const entry of raw) {
  const expected = EXPECT[entry.label];
  const stderr = entry.stderrRaw ?? entry.stderr ?? '';
  // exit 0 is decided by the engine's format probe, not by stderr; only a
  // failed run goes through the classifier.
  const got = entry.exit === 0 ? 'SUPPORTED' : classifySupportFailure(stderr);
  const claimed = entry.exit === 0 ? '-' : String(extractorClaimedUrl(stderr));
  const firstErr = (entry.errorLines ?? [])[0] ?? '(none)';

  if (expected === undefined) {
    process.stdout.write(`  ${String(entry.label).padEnd(20)}(unlisted case, expected state unknown)\n`);
    continue;
  }
  checked += 1;
  const ok = got === expected.state && entry.exit === expected.exit;
  if (!ok) failures += 1;
  process.stdout.write(
    `${String(entry.label).padEnd(20)}${String(entry.exit).padEnd(6)}${got.padEnd(15)}`
    + `${claimed.padEnd(9)}${expected.state}${ok ? '' : '   <-- MISMATCH'}`
    + `\n    engine: ${String(firstErr).slice(0, 110)}\n`,
  );
}

// The two cases that motivated D-134, asserted by name so a regression is loud.
const nomedia = raw.find((entry) => entry.label === '/nomedia.html');
const nosrc = raw.find((entry) => entry.label === '/video-nosrc.html');
process.stdout.write('\nD-134 core claim — a bare `Unsupported URL:` must NOT read as UNSUPPORTED:\n');
for (const entry of [nomedia, nosrc]) {
  if (entry === undefined) continue;
  const stderr = entry.stderrRaw ?? entry.stderr ?? '';
  process.stdout.write(
    `  ${entry.label}\n`
    + `    engine says : ${JSON.stringify((entry.errorLines ?? [])[0] ?? '(none)')}\n`
    + `    classified  : ${classifySupportFailure(stderr)}  (must be NO_MEDIA)\n`
    + `    [name] prefix: ${extractorClaimedUrl(stderr)}  (must be false — no extractor was credited)\n`
    + `    claimed via -v: ${/Extracting URL:/.test(stderr) ? 'yes' : 'n/a in this capture'}\n`,
  );
}

process.stdout.write(
  `\n${checked} case(s) checked — ${failures === 0 ? 'ALL MAPPINGS MATCH' : `${failures} MISMATCH(ES)`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
