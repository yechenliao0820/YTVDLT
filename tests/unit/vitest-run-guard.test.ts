/**
 * B0 / R2-1 · unit tests for the vitest guard (F035).
 *
 * These exercise the REAL exported helpers from scripts/lib/vitest-run.mjs:
 * freshness / run-id isolation, four-dimension coverage recomputation,
 * "only this guard marker may be mitigated", structured audit record and the
 * counter-examples that used to be spoofable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, readFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runVitestGuarded, evaluateGuard, inspectEvidence,
  GUARD_MARKER, COVERAGE_MINIMUM, GUARD_REPORT_RELATIVE,
} from '../../scripts/lib/vitest-run.mjs';

const GOOD_RESULTS = {
  success: true, numFailedTests: 0, numPassedTests: 206, numTotalTests: 206,
};
const FAIL_RESULTS = {
  success: false, numFailedTests: 1, numPassedTests: 205, numTotalTests: 206,
};
const dims = (lines: number, branches = 92, functions = 92, statements = 92) => ({
  total: {
    lines: { pct: lines }, branches: { pct: branches },
    functions: { pct: functions }, statements: { pct: statements },
  },
});

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ytvdlt-guard-unit-'));
});
afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

function caseDir(name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'reports'), { recursive: true });
  mkdirSync(join(dir, 'coverage'), { recursive: true });
  return dir;
}

function writeEvidence(
  dir: string,
  options: {
    results?: Record<string, unknown>;
    summary?: Record<string, unknown>;
    staleResults?: boolean;
    staleSummary?: boolean;
  } = {},
): void {
  const resultsPath = join(dir, 'reports', 'vitest-results.json');
  const summaryPath = join(dir, 'coverage', 'coverage-summary.json');
  writeFileSync(resultsPath, JSON.stringify(options.results ?? GOOD_RESULTS), 'utf8');
  writeFileSync(summaryPath, JSON.stringify(options.summary ?? dims(93)), 'utf8');
  const stale = (Date.now() - 180_000) / 1000;
  if (options.staleResults === true) utimesSync(resultsPath, stale, stale);
  if (options.staleSummary === true) utimesSync(summaryPath, stale, stale);
}

const guardOutput = `${`[safe-delete][${GUARD_MARKER}] {"count":75,"threshold":50}`}\n`;

/** In-process spawn seam: writes the evidence the real vitest child would write. */
function fakeSpawn(status: number, options: Parameters<typeof writeEvidence>[1] = {}, stdout = guardOutput) {
  return (argv: string[], cwd: string) => {
    writeEvidence(cwd, options);
    return { status, stdout, stderr: '' };
  };
}

function auditOf(dir: string): Record<string, unknown> | null {
  const path = join(dir, GUARD_REPORT_RELATIVE);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('B0 guard · inspectEvidence (freshness + coverage recompute)', () => {
  it('reports missing evidence instead of trusting anything', () => {
    const dir = caseDir('missing');
    const startedAt = Date.now() - 10;
    const evidence = inspectEvidence(dir, startedAt);
    expect(evidence.resultsOk).toBe(false);
    expect(evidence.coverageOk).toBe(false);
    expect(evidence.reasons).toContain('RESULTS_MISSING');
    expect(evidence.reasons).toContain('SUMMARY_MISSING');
  });

  it('accepts only fresh, successful results with 0 failed tests', () => {
    const dir = caseDir('fresh-good');
    const startedAt = Date.now() - 10;
    writeEvidence(dir);
    const evidence = inspectEvidence(dir, startedAt);
    expect(evidence.resultsOk).toBe(true);
    expect(evidence.coverageOk).toBe(true);
    expect(evidence.coverageMinimum).toBe(92);
    expect(evidence.evidenceMtime.resultsMs).not.toBeNull();
    expect(evidence.evidenceMtime.summaryMs).not.toBeNull();
  });

  it('rejects a stale success result whose mtime predates startedAt', () => {
    const dir = caseDir('stale-results');
    const startedAt = Date.now() - 10;
    writeEvidence(dir, { staleResults: true });
    const evidence = inspectEvidence(dir, startedAt);
    expect(evidence.resultsOk).toBe(false);
    expect(evidence.reasons).toContain('RESULTS_NOT_FRESH');
  });

  it('rejects a stale coverage summary', () => {
    const dir = caseDir('stale-summary');
    const startedAt = Date.now() - 10;
    writeEvidence(dir, { staleSummary: true });
    const evidence = inspectEvidence(dir, startedAt);
    expect(evidence.coverageOk).toBe(false);
    expect(evidence.reasons).toContain('SUMMARY_NOT_FRESH');
  });

  it('recomputes ALL FOUR dimensions: one below 70 vetoes', () => {
    const dir = caseDir('low-branches');
    const startedAt = Date.now() - 10;
    writeEvidence(dir, { summary: dims(93, 69, 92, 92) });
    const evidence = inspectEvidence(dir, startedAt);
    expect(evidence.coverageMinimum).toBe(69);
    expect(evidence.coverageOk).toBe(false);
    expect(evidence.reasons).toContain('COVERAGE_BELOW_MINIMUM');
    expect(COVERAGE_MINIMUM).toBe(70);
  });

  it('rejects malformed / unparseable evidence', () => {
    const dir = caseDir('malformed');
    const startedAt = Date.now() - 10;
    writeEvidence(dir, { summary: { total: { lines: 'oops' } } });
    expect(inspectEvidence(dir, startedAt).reasons).toContain('SUMMARY_MALFORMED');
    writeFileSync(join(dir, 'reports', 'vitest-results.json'), '{not json', 'utf8');
    expect(inspectEvidence(dir, startedAt).reasons).toContain('RESULTS_UNPARSEABLE');
  });
});

describe('B0 guard · evaluateGuard (only the sandbox marker may be mitigated)', () => {
  it('allows only when marker + fresh success + coverage >=70 all hold', () => {
    const dir = caseDir('allow');
    const startedAt = Date.now() - 10;
    writeEvidence(dir);
    expect(evaluateGuard({ status: 1, combined: guardOutput, cwd: dir, startedAt }).allow).toBe(true);
    expect(evaluateGuard({ status: 1, combined: 'exit 1', cwd: dir, startedAt }).reasons)
      .toContain('GUARD_MARKER_ABSENT');
  });

  it('vetoes when the child output reports a real failing test', () => {
    const dir = caseDir('failure-output');
    const startedAt = Date.now() - 10;
    writeEvidence(dir);
    const result = evaluateGuard({
      status: 1, combined: `${guardOutput}Tests  1 failed | 205 passed (206)\n`, cwd: dir, startedAt,
    });
    expect(result.failureInOutput).toBe(true);
    expect(result.allow).toBe(false);
    expect(result.reasons).toContain('TEST_FAILURE_IN_OUTPUT');
  });

  it('vetoes when the results JSON reports a failure', () => {
    const dir = caseDir('failure-json');
    const startedAt = Date.now() - 10;
    writeEvidence(dir, { results: FAIL_RESULTS });
    const result = evaluateGuard({ status: 1, combined: guardOutput, cwd: dir, startedAt });
    expect(result.allow).toBe(false);
    expect(result.reasons).toContain('RESULTS_NOT_SUCCESS');
    expect(result.reasons).toContain('RESULTS_FAILED_TESTS');
  });
});

describe('B0 guard · runVitestGuarded (runId, single-file unlink, audit trail)', () => {
  it('passes a clean exit through untouched with mitigation:null', () => {
    const dir = caseDir('clean-exit');
    const result = runVitestGuarded([], dir, {
      autoJsonReporter: false,
      quiet: true,
      spawn: fakeSpawn(0),
    });
    expect(result.status).toBe(0);
    expect(result.guardMitigated).toBe(false);
    expect(result.mitigation).toBeNull();
    expect(auditOf(dir)?.['decision']).toBe('CLEAN');
  });

  it('isolates evidence with single-file unlink before spawn', () => {
    const dir = caseDir('pre-spawn-unlink');
    writeEvidence(dir, { results: GOOD_RESULTS, staleResults: true });
    const result = runVitestGuarded([], dir, {
      autoJsonReporter: false,
      quiet: true,
      spawn: (_argv: string[], cwd: string) => {
        // The two old evidence files MUST already be gone when the child starts.
        expect(existsSync(join(cwd, 'reports', 'vitest-results.json'))).toBe(false);
        expect(existsSync(join(cwd, 'coverage', 'coverage-summary.json'))).toBe(false);
        writeEvidence(cwd);
        return { status: 1, stdout: guardOutput, stderr: '' };
      },
    });
    expect(result.guardMitigated).toBe(true);
  });

  it('mitigates a green guard-tripped run and writes the 6 required audit fields', () => {
    const dir = caseDir('mitigated');
    const result = runVitestGuarded([], dir, {
      autoJsonReporter: false,
      quiet: true,
      spawn: fakeSpawn(1),
    });
    expect(result.status).toBe(0);
    expect(result.guardMitigated).toBe(true);
    expect(result.originalStatus).toBe(1);
    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.startedAt).toBeGreaterThan(0);
    const audit = auditOf(dir);
    expect(audit).not.toBeNull();
    for (const field of ['originalStatus', 'runId', 'startedAt', 'evidenceMtime', 'coverageMinimum', 'reasons']) {
      expect(Object.prototype.hasOwnProperty.call(audit, field)).toBe(true);
    }
    expect(audit?.['originalStatus']).toBe(1);
    expect(audit?.['coverageMinimum']).toBe(92);
    expect(result.mitigation?.originalStatus).toBe(1);
  });

  it('REJECTS a stale success artifact (the original R2-1 hole)', () => {
    const dir = caseDir('rejected-stale');
    const result = runVitestGuarded([], dir, {
      autoJsonReporter: false,
      quiet: true,
      spawn: fakeSpawn(1, { staleResults: true }),
    });
    expect(result.status).toBe(1);
    expect(result.guardMitigated).toBe(false);
    expect(result.mitigation).toBeNull();
    expect(auditOf(dir)?.['decision']).toBe('REJECTED');
    expect(auditOf(dir)?.['reasons']).toContain('RESULTS_NOT_FRESH');
  });

  it('REJECTS low coverage and a real test failure', () => {
    for (const [name, options, stdout] of [
      ['low-coverage', { summary: dims(60) }, guardOutput],
      ['real-failure', { results: FAIL_RESULTS }, `${guardOutput}Tests  1 failed (1)\n`],
    ] as const) {
      const dir = caseDir(name);
      const result = runVitestGuarded([], dir, {
        autoJsonReporter: false,
        quiet: true,
        spawn: fakeSpawn(1, options, stdout),
      });
      expect(result.status).toBe(1);
      expect(result.guardMitigated).toBe(false);
      expect(auditOf(dir)?.['decision']).toBe('REJECTED');
    }
  });

  it('REJECTS a non-zero exit without the guard marker', () => {
    const dir = caseDir('no-marker');
    const result = runVitestGuarded([], dir, {
      autoJsonReporter: false,
      quiet: true,
      spawn: fakeSpawn(1, {}, 'some unrelated crash\n'),
    });
    expect(result.status).toBe(1);
    expect(result.guardMitigated).toBe(false);
    expect(auditOf(dir)?.['reasons']).toContain('GUARD_MARKER_ABSENT');
  });

  it('injects a JSON reporter when the caller did not request one', () => {
    const dir = caseDir('json-reporter');
    let captured: string[] = [];
    const result = runVitestGuarded(['run', 'tests/unit'], dir, {
      spawn: (argv: string[], cwd: string) => {
        captured = [...argv];
        writeEvidence(cwd);
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    expect(result.status).toBe(0);
    expect(captured).toContain('--reporter=default');
    expect(captured).toContain('--reporter=json');
    expect(captured.some((part) => part.startsWith('--outputFile.json='))).toBe(true);
  });
});
