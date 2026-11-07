#!/usr/bin/env node
/**
 * Thin test-runner wrapper so npm scripts can accept the milestone's
 * documented CLI conventions (`-- --case download-local`, `-- --run ArgvBuilder`)
 * while still invoking Vitest with an argv[] (never a shell string).
 *
 *   node scripts/run-tests.mjs all|unit|contract|integration [options]
 *     --case <name>    select an integration case (whitelist below)
 *     --run <name>     select unit/contract test FILE by normalized basename
 *     --coverage       enable v8 coverage; thresholds enforced by vitest.config
 *
 * `--run` matches FILE NAMES, not test titles (M1 QA P2-3): a title filter
 * silently skips whole describe blocks.
 *
 * Coverage scoping (M1 QA N-1): a targeted run must not be able to hide a
 * low-coverage file by setting an environment variable. Instead this script
 * writes a one-shot scope file (~/.turbo) bound to a per-run nonce that
 * vitest.config verifies; `YTVDLT_COVERAGE_INCLUDE` is no longer trusted.
 */
import { spawn } from 'node:child_process';
import { runVitestGuarded } from './lib/vitest-run.mjs';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const SCOPE_FILE = join(ROOT, 'node_modules', '.cache', 'ytvdlt', 'coverage-scope.json');

const argv = process.argv.slice(2);
const mode = argv[0] ?? 'all';
const rest = argv.slice(1);

function option(name) {
  const index = rest.indexOf(name);
  if (index === -1) return null;
  return rest[index + 1] ?? null;
}
const wantsCoverage = rest.includes('--coverage');
const runName = option('--run');
const caseName = option('--case');

const targets = {
  all: ['tests/unit', 'tests/contract'],
  unit: ['tests/unit'],
  contract: ['tests/contract'],
  integration: ['tests/integration/offline'],
}[mode];

if (!targets) {
  console.error(`[run-tests] unknown mode: ${mode}`);
  process.exit(3);
}

/** Integration case → test file (exact whitelist; M2 extends M1's single case). */
const CASE_FILES = {
  'probe-local': 'tests/integration/offline/probe-local.test.ts',
  'download-local': 'tests/integration/offline/download-local.test.ts',
  'cancel-local': 'tests/integration/offline/cancel-local.test.ts',
  'retry-local': 'tests/integration/offline/retry-local.test.ts',
  'artifact-local': 'tests/integration/offline/artifact-local.test.ts',
};

/** Normalize a name for fuzzy basename comparison (case/separators ignored). */
function normalizeKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function toPosix(absolute) {
  return relative(ROOT, absolute).replace(/\\/g, '/');
}

function findTestFiles(name, dirs) {
  const key = normalizeKey(name);
  const found = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync(join(ROOT, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.test\.ts$/.test(entry.name)) continue;
      const base = entry.name.replace(/\.test\.ts$/, '');
      if (normalizeKey(base) === key) found.push(`${dir}/${entry.name}`);
    }
  }
  return found;
}

function findSourceFiles(name) {
  const key = normalizeKey(name);
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
        const base = entry.name.replace(/\.ts$/, '');
        if (normalizeKey(base) === key) found.push(toPosix(full));
      }
    }
  };
  for (const dir of ['packages/core/src', 'packages/engine-ytdlp/src']) {
    if (statSync(join(ROOT, dir), { throwIfNoEntry: false })) walk(join(ROOT, dir));
  }
  return found;
}

let runTargets = targets;
const vitestArgs = ['run'];

if (mode === 'integration' && caseName !== null) {
  const file = CASE_FILES[caseName];
  if (!file) {
    console.error(`[run-tests] unknown --case ${caseName}; expected one of ${Object.keys(CASE_FILES).join(', ')}`);
    process.exit(3);
  }
  runTargets = [file];
}

if (runName !== null) {
  const files = findTestFiles(runName, targets);
  if (files.length === 0) {
    console.error(`[run-tests] --run ${runName}: no matching test file under ${targets.join(', ')}`);
    process.exit(3);
  }
  runTargets = files;
}

vitestArgs.push(...runTargets);
if (wantsCoverage) vitestArgs.push('--coverage');

const childEnv = { ...process.env };
// Never inherit a caller-supplied include list (N-1 trust boundary).
delete childEnv['YTVDLT_COVERAGE_INCLUDE'];
delete childEnv['YTVDLT_COVERAGE_SCOPE'];
delete childEnv['YTVDLT_COVERAGE_NONCE'];

let scopeWritten = false;
if (runName !== null && wantsCoverage) {
  const sources = findSourceFiles(runName);
  if (sources.length > 0) {
    const nonce = randomUUID();
    mkdirSync(dirname(SCOPE_FILE), { recursive: true });
    writeFileSync(SCOPE_FILE, JSON.stringify({ nonce, include: sources, createdAt: new Date().toISOString() }), 'utf8');
    childEnv['YTVDLT_COVERAGE_SCOPE'] = SCOPE_FILE;
    childEnv['YTVDLT_COVERAGE_NONCE'] = nonce;
    scopeWritten = true;
  }
}

const cleanup = () => {
  if (!scopeWritten) return;
  try { rmSync(SCOPE_FILE, { force: true }); } catch { /* best effort */ }
};

// Coverage runs end with vitest's own `coverage/.tmp` bulk delete; on hosts with
// a delete guard that aborts an otherwise-green run (DECISIONS D-29). The guarded
// helper re-checks the JSON results before accepting anything.
if (wantsCoverage) {
  const env = { ...childEnv };
  const saved = { ...process.env };
  try {
    Object.assign(process.env, env);
    const result = runVitestGuarded([VITEST, ...vitestArgs], ROOT);
    cleanup();
    // B0 / R2-1: forward the STRUCTURED mitigation object (not a bare string or
    // just an exit code) into reports/vitest-guard.json. The guard itself also
    // writes an audit record for every run; this copy carries the caller tag.
    if (result.mitigation !== null && result.mitigation !== undefined) {
      try {
        mkdirSync(join(ROOT, 'reports'), { recursive: true });
        writeFileSync(
          join(ROOT, 'reports', 'vitest-guard.json'),
          `${JSON.stringify({ ...result.mitigation, forwardedBy: 'scripts/run-tests.mjs' }, null, 2)}\n`,
          'utf8',
        );
      } catch { /* best effort: never mask a test result */ }
    }
    process.exit(result.status);
  } finally {
    for (const key of Object.keys(env)) if (!(key in saved)) delete process.env[key];
  }
}

const child = spawn(process.execPath, [VITEST, ...vitestArgs], {
  cwd: ROOT,
  shell: false,
  windowsHide: true,
  stdio: 'inherit',
  env: childEnv,
});

child.on('exit', (code, signal) => {
  cleanup();
  process.exit(signal ? 1 : (code ?? 1));
});
child.on('error', (error) => {
  cleanup();
  console.error(`[run-tests] failed to start vitest: ${error.message}`);
  process.exit(3);
});
