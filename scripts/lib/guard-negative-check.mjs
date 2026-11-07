#!/usr/bin/env node
/**
 * B0 / R2-1 negative verification (5 cases: 4 counter-examples + 1 positive).
 *
 *   node scripts/lib/guard-negative-check.mjs --json
 *
 * Every case drives the REAL `runVitestGuarded()` from `vitest-run.mjs` with a
 * REAL spawned child process (node argv[] + shell:false + windowsHide:true).
 * The child is a small "vitest outcome simulator": it writes the two evidence
 * files with real mtimes (or deliberately back-dated ones), prints the real
 * sandbox guard marker / failure signatures to stdout, and exits with a chosen
 * status. Nothing about the guard decision is reimplemented or mocked here:
 * the assertions below are made on the guard's actual return value and its
 * actual `reports/vitest-guard.json` output.
 *
 * (a) broken assertion + hand-made STALE success result   -> exit 1 / no mitigation
 * (b) stale success evidence only (mtime < startedAt)      -> exit 1 / no mitigation
 * (c) one coverage dimension < 70                          -> exit 1 / no mitigation
 * (d) real test failure + guard marker                     -> exit 1 / no mitigation
 *     (+ extra: perfect evidence but NO guard marker        -> still rejected)
 * (e) all green + guard tripped                            -> mitigated, audit file complete
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  runVitestGuarded, GUARD_MARKER, COVERAGE_MINIMUM, GUARD_REPORT_RELATIVE,
} from './vitest-run.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPORTS = join(ROOT, 'reports');
const OUTPUT = join(REPORTS, 'r2-1-negative-verification.json');

const GOOD_RESULTS = Object.freeze({
  success: true, numFailedTests: 0, numPassedTests: 206, numTotalTests: 206,
});
const FAIL_RESULTS = Object.freeze({
  success: false, numFailedTests: 1, numPassedTests: 205, numTotalTests: 206,
});

const dimensions = (lines, branches = 92, functions = 92, statements = 92) => ({
  total: {
    lines: { pct: lines }, branches: { pct: branches },
    functions: { pct: functions }, statements: { pct: statements },
  },
});

/** Content of the real child process used as a controllable vitest stand-in. */
const CHILD_SOURCE = `
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
const cfg = JSON.parse(process.argv[2] ?? '{}');
const cwd = process.cwd();
const resultsPath = join(cwd, 'reports', 'vitest-results.json');
const summaryPath = join(cwd, 'coverage', 'coverage-summary.json');
mkdirSync(dirname(resultsPath), { recursive: true });
mkdirSync(dirname(summaryPath), { recursive: true });
writeFileSync(resultsPath, JSON.stringify(cfg.results), 'utf8');
writeFileSync(summaryPath, JSON.stringify(cfg.summary), 'utf8');
const staleSeconds = (Date.now() - 180000) / 1000;
if (cfg.staleResults === true) utimesSync(resultsPath, staleSeconds, staleSeconds);
if (cfg.staleSummary === true) utimesSync(summaryPath, staleSeconds, staleSeconds);
if (cfg.marker === true) {
  process.stdout.write('[safe-delete][' + '${GUARD_MARKER}' + '] {"count":75,"threshold":50}\\n');
}
for (const line of (cfg.extraLines ?? [])) process.stdout.write(line + '\\n');
process.exit(cfg.exitStatus ?? 1);
`;

/** A case config: what the simulated vitest child does. */
function childConfig(overrides) {
  return {
    results: GOOD_RESULTS,
    summary: dimensions(93),
    staleResults: false,
    staleSummary: false,
    marker: true,
    extraLines: [],
    exitStatus: 1,
    ...overrides,
  };
}

const CASES = [
  {
    id: 'a',
    label: '改坏任一断言 + 手造陈旧成功结果',
    expected: 'exit 1 / guardMitigated=false / 命中 RESULTS_NOT_FRESH 与 TEST_FAILURE_IN_OUTPUT',
    config: childConfig({
      results: GOOD_RESULTS,
      staleResults: true,
      summary: dimensions(93),
      marker: true,
      extraLines: ['FAIL tests/unit/guard-negative.test.ts > deliberately broken assertion'],
    }),
    wantMitigated: false,
    wantReasons: ['RESULTS_NOT_FRESH', 'TEST_FAILURE_IN_OUTPUT'],
  },
  {
    id: 'b',
    label: '只留陈旧成功证据（mtime 早于 startedAt）',
    expected: 'exit 1 / guardMitigated=false / 命中 RESULTS_NOT_FRESH 与 SUMMARY_NOT_FRESH',
    config: childConfig({
      results: GOOD_RESULTS,
      staleResults: true,
      staleSummary: true,
      summary: dimensions(93),
      marker: true,
    }),
    wantMitigated: false,
    wantReasons: ['RESULTS_NOT_FRESH', 'SUMMARY_NOT_FRESH'],
  },
  {
    id: 'c',
    label: 'coverage-summary.json 任一维 <70',
    expected: 'exit 1 / guardMitigated=false / 命中 COVERAGE_BELOW_MINIMUM',
    config: childConfig({
      results: GOOD_RESULTS,
      summary: dimensions(69),
      marker: true,
    }),
    wantMitigated: false,
    wantReasons: ['COVERAGE_BELOW_MINIMUM'],
  },
  {
    id: 'd',
    label: '真实测试失败 + guard 标记',
    expected: 'exit 1 / guardMitigated=false / 命中 RESULTS_NOT_SUCCESS 与 RESULTS_FAILED_TESTS',
    config: childConfig({
      results: FAIL_RESULTS,
      summary: dimensions(93),
      marker: true,
      extraLines: ['Tests  1 failed | 205 passed (206)'],
    }),
    wantMitigated: false,
    wantReasons: ['RESULTS_NOT_SUCCESS', 'RESULTS_FAILED_TESTS', 'TEST_FAILURE_IN_OUTPUT'],
  },
  {
    id: 'e',
    label: '正例：全绿 + guard 触发',
    expected: '允许缓解 / status=0 / guardMitigated=true / vitest-guard.json 六个字段齐全',
    config: childConfig({
      results: GOOD_RESULTS,
      summary: dimensions(93),
      marker: true,
    }),
    wantMitigated: true,
    wantReasons: [],
  },
];

const AUDIT_FIELDS = [
  'originalStatus', 'runId', 'startedAt', 'evidenceMtime', 'coverageMinimum', 'reasons',
];

function parseAudit(cwd) {
  const path = join(cwd, GUARD_REPORT_RELATIVE);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function runCase(cwd, childScript, definition) {
  const started = performance.now();
  const result = runVitestGuarded(
    [childScript, JSON.stringify(definition.config)],
    cwd,
    { autoJsonReporter: false, quiet: true },
  );
  const durationMs = Math.max(1, Math.round(performance.now() - started));
  const audit = parseAudit(cwd);
  const reasons = Array.isArray(audit?.reasons) ? audit.reasons : [];
  const checks = [];

  checks.push({
    name: 'exit-status',
    expected: definition.wantMitigated ? 0 : 'non-zero',
    actual: result.status,
    pass: definition.wantMitigated ? result.status === 0 : result.status !== 0,
  });
  checks.push({
    name: 'guardMitigated',
    expected: definition.wantMitigated,
    actual: result.guardMitigated,
    pass: result.guardMitigated === definition.wantMitigated,
  });
  for (const reason of definition.wantReasons) {
    checks.push({
      name: `rejection-reason:${reason}`,
      expected: 'present',
      actual: reasons.includes(reason) ? 'present' : 'absent',
      pass: reasons.includes(reason),
    });
  }
  if (definition.wantMitigated) {
    for (const field of AUDIT_FIELDS) {
      const present = audit !== null && Object.prototype.hasOwnProperty.call(audit, field);
      checks.push({
        name: `audit-field:${field}`,
        expected: 'present',
        actual: present ? String(audit[field] === null ? 'null' : typeof audit[field]) : 'absent',
        pass: present,
      });
    }
    checks.push({
      name: 'originalStatus-preserved',
      expected: definition.config.exitStatus,
      actual: audit?.originalStatus ?? null,
      pass: audit?.originalStatus === definition.config.exitStatus,
    });
    checks.push({
      name: 'coverageMinimum-recomputed',
      expected: `>=${COVERAGE_MINIMUM}`,
      actual: audit?.coverageMinimum ?? null,
      pass: typeof audit?.coverageMinimum === 'number' && audit.coverageMinimum >= COVERAGE_MINIMUM,
    });
  }
  return {
    id: definition.id,
    label: definition.label,
    expected: definition.expected,
    actual: {
      status: result.status,
      guardMitigated: result.guardMitigated,
      originalStatus: result.originalStatus,
      decision: audit?.decision ?? 'unknown',
      reasons,
    },
    durationMs,
    checks,
    status: checks.every((check) => check.pass) ? 'PASS' : 'FAIL',
  };
}

/** Extra (non-scored) hardening check: no guard marker => never mitigate. */
function markerRequiredCheck(cwd, childScript) {
  const config = childConfig({ marker: false, results: GOOD_RESULTS, summary: dimensions(93) });
  const result = runVitestGuarded(
    [childScript, JSON.stringify(config)], cwd, { autoJsonReporter: false, quiet: true },
  );
  const audit = parseAudit(cwd);
  const reasons = Array.isArray(audit?.reasons) ? audit.reasons : [];
  return {
    id: 'extra-marker-required',
    expected: '无 SAFE_DELETE_BULK_CONFIRM_REQUIRED 标记时，即使证据完美也不得缓解',
    actual: { status: result.status, guardMitigated: result.guardMitigated, reasons },
    status: result.status !== 0 && result.guardMitigated === false && reasons.includes('GUARD_MARKER_ABSENT')
      ? 'PASS' : 'FAIL',
  };
}

async function main() {
  mkdirSync(REPORTS, { recursive: true });
  const workspace = mkdtempSync(join(tmpdir(), 'ytvdlt-r2-1-'));
  const childScript = join(workspace, 'simulated-vitest.mjs');
  const cases = [];
  let extra = null;
  try {
    writeFileSync(childScript, CHILD_SOURCE, 'utf8');
    for (const definition of CASES) {
      cases.push(runCase(workspace, childScript, definition));
    }
    extra = markerRequiredCheck(workspace, childScript);
  } finally {
    try { rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const passed = cases.filter((item) => item.status === 'PASS').length;
  const report = {
    checkId: 'R2-1',
    generatedAt: new Date().toISOString(),
    guardMarker: GUARD_MARKER,
    coverageMinimum: COVERAGE_MINIMUM,
    driver: 'scripts/lib/vitest-run.mjs::runVitestGuarded (real spawn, real evidence files)',
    methodology: '真实 spawnSync 子进程写出证据文件并控制 mtime/结果/覆盖率；断言基于 guard 的真实返回值与真实 vitest-guard.json',
    cases,
    additionalChecks: extra === null ? [] : [extra],
    summary: {
      total: cases.length,
      passed,
      failed: cases.length - passed,
      allPass: passed === cases.length && extra?.status === 'PASS',
    },
    evidencePath: 'reports/r2-1-negative-verification.json',
  };
  writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const asJson = process.argv.includes('--json');
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const item of cases) {
      console.log(`[r2-1] case ${item.id}: ${item.status} | ${item.label} | status=${item.actual.status} mitigated=${item.actual.guardMitigated} reasons=${item.actual.reasons.join(',')}`);
    }
    console.log(`[r2-1] ${passed}/${cases.length} PASS; additional check: ${extra?.status ?? 'N/A'}`);
  }
  process.exitCode = report.summary.allPass ? 0 : 1;
}

main().catch((error) => {
  console.error(`[r2-1] fatal: ${error?.stack ?? String(error)}`);
  process.exitCode = 1;
});
