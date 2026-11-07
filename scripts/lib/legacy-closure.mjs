#!/usr/bin/env node
/**
 * M4-0 / QA-D3 — single source of truth for the M3 legacy-closure evidence.
 *
 * The M3 gate used to read `reports/m3-legacy-closure.json` while NOTHING in the
 * repository generated it: any hand-written JSON with `summary.failed === 0`
 * passed. This module derives the file from the REAL vitest JSON report, so the
 * counts can never drift from the run that acceptance just executed.
 *
 * Usage (regenerate from the latest `reports/vitest-results.json`):
 *   node scripts/lib/legacy-closure.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const LEGACY_CLOSURE_PATH = join(ROOT, 'reports', 'm3-legacy-closure.json');
export const LEGACY_GENERATOR = 'scripts/lib/legacy-closure.mjs';

/** The five M3 legacy files whose closure is claimed by A-4.5-07 / A-M3-12. */
export const LEGACY_TEST_FILES = [
  'task-queue.test.ts',
  'progress-parser.test.ts',
  'argv-builder-m3.test.ts',
  'electron-shell-port.test.ts',
  'shell-port.test.ts',
];

export class LegacyClosureError extends Error {}

function baseName(name) {
  return String(name ?? '').split(/[\\/]/).pop();
}

/**
 * Pure derivation from a parsed vitest JSON report.
 * Throws when a claimed file is absent from the report (a missing file must be
 * a hard FAIL — never a silent zero).
 */
export function buildLegacyClosure(vitestResults, options = {}) {
  if (vitestResults === null || typeof vitestResults !== 'object') {
    throw new LegacyClosureError('vitest results missing');
  }
  if (!Array.isArray(vitestResults.testResults) || vitestResults.testResults.length === 0) {
    throw new LegacyClosureError('vitest results carry no testResults');
  }
  const perFile = [];
  let total = 0;
  let passed = 0;
  let failed = 0;
  let durationMs = 0;

  for (const claimed of LEGACY_TEST_FILES) {
    const file = vitestResults.testResults.find((entry) => baseName(entry.name) === claimed);
    if (file === undefined) throw new LegacyClosureError(`legacy file missing from run: ${claimed}`);
    const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
    const fileFailed = assertions.filter((a) => a.status !== 'passed').length;
    const filePassed = assertions.filter((a) => a.status === 'passed').length;
    const fileDuration = Math.max(
      0,
      Math.round(Number(file.endTime ?? 0) - Number(file.startTime ?? 0)),
    );
    perFile.push({
      file: claimed,
      tests: assertions.length,
      passed: filePassed,
      failed: fileFailed,
      durationMs: fileDuration,
      status: fileFailed === 0 && assertions.length > 0 ? 'PASS' : 'FAIL',
    });
    total += assertions.length;
    passed += filePassed;
    failed += fileFailed;
    durationMs += fileDuration;
  }

  return {
    schemaVersion: 1,
    generatedBy: LEGACY_GENERATOR,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    // Bound to the exact vitest run that produced the counts.
    sourceRunId: String(vitestResults.startTime ?? ''),
    sourceReport: 'reports/vitest-results.json',
    files: perFile,
    summary: {
      files: perFile.length,
      total,
      passed,
      failed,
      allPass: failed === 0 && total > 0,
    },
    durationMs,
    // Honest, separately-listed SKIPPED items (D-28 / D-39) — never counted PASS.
    skipped: [
      { id: 'D-28', subject: '真实 L2 双流 ffmpeg 孤儿压测', followUp: 'M5 打包后补真实 L2' },
      { id: 'D-39', subject: 'Electron 真实 BrowserWindow / 默认播放器', followUp: 'M5 打包后补真实 L2' },
    ],
  };
}

/** Structural validation used by the acceptance gate (falsifiable, not tautological). */
export function validateLegacyClosure(legacy, vitestResults) {
  const reasons = [];
  if (legacy === null || typeof legacy !== 'object') return ['legacy closure missing'];
  if (legacy.generatedBy !== LEGACY_GENERATOR) reasons.push('generatedBy mismatch');
  let expected;
  try {
    expected = buildLegacyClosure(vitestResults, { generatedAt: legacy.generatedAt });
  } catch (error) {
    reasons.push(String(error?.message ?? error));
    return reasons;
  }
  if (legacy.sourceRunId !== expected.sourceRunId) reasons.push('sourceRunId does not match this vitest run');
  if (legacy.summary?.total !== expected.summary.total) {
    reasons.push(`total ${legacy.summary?.total} != measured ${expected.summary.total}`);
  }
  if (legacy.summary?.failed !== expected.summary.failed) {
    reasons.push(`failed ${legacy.summary?.failed} != measured ${expected.summary.failed}`);
  }
  if (legacy.summary?.files !== LEGACY_TEST_FILES.length) reasons.push('file count != 5');
  if (!(Number(legacy.durationMs) > 0)) reasons.push('durationMs must be measured > 0');
  if (legacy.summary?.failed !== 0) reasons.push('legacy suite not green');
  return reasons;
}

/** Write the closure derived from a parsed vitest report. */
export async function writeLegacyClosure(vitestResults, path = LEGACY_CLOSURE_PATH) {
  const closure = buildLegacyClosure(vitestResults);
  await writeFile(path, `${JSON.stringify(closure, null, 2)}\n`, 'utf8');
  return closure;
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  const report = JSON.parse(await readFile(join(ROOT, 'reports', 'vitest-results.json'), 'utf8'));
  const closure = await writeLegacyClosure(report);
  console.log(`[legacy-closure] ${closure.summary.files} files / ${closure.summary.total} tests / `
    + `${closure.summary.failed} failed / ${closure.durationMs}ms -> reports/m3-legacy-closure.json`);
}
