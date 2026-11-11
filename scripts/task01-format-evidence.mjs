#!/usr/bin/env node
/**
 * TASK-01 evidence — does the `-S` term we emit actually select the intended
 * format? Offline, against the shipped yt-dlp, via `--load-info-json`.
 *
 * WHY `--load-info-json`: it makes yt-dlp read a metadata document from disk
 * instead of the network, so the FORMAT SELECTION logic (the thing TASK-01 is
 * about) is exercised for real without touching any site. Every fixture here is
 * a hand-built info.json with a known format list, so the expected winner is
 * computable by inspection and the observed winner can be compared to it.
 *
 * The point of the run: prove `lowest` is a RELATIVE ascending choice, not a
 * hard-coded 360p, and that `best` still means "highest".
 *
 *   node scripts/task01-format-evidence.mjs
 *
 * Writes `reports/task01-format-selection.json`. Never connects to a network.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const YTDLP = join(ROOT, 'resources', 'runtime', 'win-x64', 'yt-dlp.exe');
const TEMP = join(process.env.TEMP ?? process.env.TMP ?? '.', 'ytvdlt-probe');

/** Run the bundled engine with argv[] only: never a shell string. */
function run(argv) {
  return new Promise((resolve) => {
    const child = spawn(YTDLP, argv, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ exitCode: null, stdout, stderr: String(error) }));
    child.on('close', (code) => resolve({ exitCode: code, stdout, stderr }));
  });
}

/**
 * Ask yt-dlp which format the given sort term picks, using a local metadata
 * document. `--print` returns the resolved selector; `--simulate` guarantees
 * nothing is written to disk even if a fixture is malformed.
 */
async function selectWith(fixture, sortTerm) {
  const argv = ['--load-info-json', fixture, '--simulate', '--no-warnings'];
  if (sortTerm !== null) argv.push('-S', sortTerm);
  argv.push('--print', '%(format_id)s|%(resolution)s|%(vcodec)s|%(acodec)s');
  const result = await run(argv);
  return {
    sortTerm,
    exitCode: result.exitCode,
    selection: result.stdout.trim().split(/\r?\n/)[0] ?? '',
    stderr: result.stderr.trim().slice(0, 400),
  };
}

const FIXTURES = [
  ['info.json', 'multi-resolution 2160/1080/720/360 + audio'],
  ['only480.json', 'single video stream at 480p only'],
  ['audioonly.json', 'audio-only source'],
  ['single_res.json', 'one video + one audio stream'],
  ['mixed_codec.json', 'mixed codecs across resolutions'],
];

const TERMS = [
  [null, 'no -S (the pre-fix behaviour for `lowest`)'],
  ['res', 'explicit descending (yt-dlp default direction)'],
  ['+res', 'ASCENDING — what `lowest` now emits'],
  ['res:360', 'what a hard-coded 360p would look like'],
];

async function main() {
  if (!existsSync(YTDLP)) {
    console.error(`[task01] missing bundled engine: ${YTDLP}`);
    process.exit(1);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    enginePath: YTDLP,
    engineVersion: (await run(['--version'])).stdout.trim(),
    method: '--load-info-json (offline metadata) + --simulate --print',
    networkUsed: false,
    fixtures: {},
    notes: [
      'selection is rendered as format_id|resolution|vcodec|acodec',
      'no -S leaves yt-dlp default sorting (res DESC) in charge = HIGHEST resolution',
      '+res flips the direction to ASCENDING = the LOWEST resolution available',
      'res:360 is a FIXED request; on a source without 360p it fails or falls back',
    ],
  };

  for (const [name, description] of FIXTURES) {
    const fixture = join(TEMP, name);
    if (!existsSync(fixture)) {
      report.fixtures[name] = { description, missing: true, path: fixture };
      continue;
    }
    const rows = [];
    for (const [term, label] of TERMS) {
      const observed = await selectWith(fixture, term);
      rows.push({ ...observed, label });
    }
    report.fixtures[name] = { description, path: fixture, rows };
  }

  const outDir = join(ROOT, 'reports');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'task01-format-selection.json');
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  // Human-readable summary on stdout so the run is self-documenting.
  process.stdout.write(`engine ${report.engineVersion}\n`);
  for (const [name, data] of Object.entries(report.fixtures)) {
    process.stdout.write(`\n${name} — ${data.description}\n`);
    if (data.missing) { process.stdout.write('  (fixture missing, skipped)\n'); continue; }
    for (const row of data.rows) {
      const term = row.sortTerm === null ? '(none)' : row.sortTerm;
      process.stdout.write(`  ${term.padEnd(8)} -> ${row.selection || `exit=${row.exitCode}`}\n`);
    }
  }
  process.stdout.write(`\nwrote ${outPath}\n`);
}

await main();
