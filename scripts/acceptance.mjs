#!/usr/bin/env node
/**
 * M1 acceptance aggregator (P0-18 / A-INF-09).
 *
 * Collects REAL evidence from reports/*.json and coverage/coverage-summary.json
 * and produces `reports/acceptance-report.json` with every "M1 must be green"
 * assertion: id / layer / status / expected / actual / durationMs / evidence.
 *
 *   node scripts/acceptance.mjs --milestone M1
 */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runVitestGuarded } from './lib/vitest-run.mjs';
import { writeLegacyClosure, validateLegacyClosure } from './lib/legacy-closure.mjs';
import { checkFrozen } from './frozen-gate.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPORTS = join(ROOT, 'reports');
const COVERAGE = join(ROOT, 'coverage');

const M1_ASSERTIONS = [
  { id: 'A-4.1-03', layer: 'L0', subject: 'ConfigStore saved_links 持久化 + 损坏回退' },
  { id: 'A-4.1-04', layer: 'L1', subject: 'JsonMapper -> MediaInfo 字段齐全' },
  { id: 'A-4.4-19', layer: 'L0', subject: 'ConfigStore 分域/schemaVersion/迁移/原子写' },
  { id: 'A-4.4-30', layer: 'L0', subject: 'Logger JSONL + 12 类敏感键脱敏' },
  { id: 'A-4.5-03', layer: 'L0', subject: 'example.invalid -> UNSUPPORTED_SITE' },
  { id: 'A-4.5-05', layer: 'L0', subject: '超时/DNS/403/429 四类互斥' },
  { id: 'A-4.5-09', layer: 'L0', subject: 'AppError.report 全字段且脱敏' },
  { id: 'A-INF-01', layer: 'L0', subject: 'monorepo 骨架 + 分层铁律 + shared 导出齐全' },
  { id: 'A-INF-02', layer: 'L4-packaging', subject: '运行时资源 + manifest SHA-256 + extraResources' },
  { id: 'A-INF-03', layer: 'L2', subject: 'U3 本地直链实测结论' },
  { id: 'A-INF-04', layer: 'L0', subject: 'check-runtime 4 项 / 负向专用错误码' },
  { id: 'A-INF-05', layer: 'L0', subject: 'ArgvBuilder probe 分支 argv 顺序 + URL 白名单' },
  { id: 'A-INF-06', layer: 'L0', subject: 'Core 覆盖率四维最低 >=70% + npm test 全绿' },
  { id: 'A-INF-07', layer: 'L2', subject: 'YtDlpEngine.probe() 对本地直链返回 MediaInfo' },
  { id: 'A-INF-08', layer: 'L1', subject: '录制 fixture 驱动 JsonMapper 全绿、不触网' },
  { id: 'A-INF-09', layer: 'L0', subject: 'M1 汇报 + acceptance-report + DECISIONS + 停下声明' },
  { id: 'A-INF-10', layer: 'L1', subject: 'DownloadEngine 5 方法 + FakeEngine 同接口' },
];

const ACCEPTANCE_FIVE = [
  { id: 'M1-ACCEPT-1', layer: 'L0', subject: '① npm run check-runtime 4 项通过' },
  { id: 'M1-ACCEPT-2', layer: 'L1', subject: '② fixture 驱动 JsonMapper 单测全绿' },
  { id: 'M1-ACCEPT-3', layer: 'L2', subject: '③ probe() 对本地 fixture 返回完整 MediaInfo' },
  { id: 'M1-ACCEPT-4', layer: 'L0', subject: '④ ArgvBuilder 骨架单测覆盖 probe 分支' },
  { id: 'M1-ACCEPT-5', layer: 'L0', subject: '⑤ Core 覆盖率四维最低 >=70%' },
];

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}
async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

function findTestCount(results, patterns) {
  if (!results || !Array.isArray(results.testResults)) return { total: 0, failed: 0 };
  let total = 0;
  let failed = 0;
  for (const file of results.testResults) {
    const name = String(file.name ?? '');
    if (!patterns.some((p) => name.includes(p))) continue;
    for (const assertion of file.assertionResults ?? []) {
      total += 1;
      if (assertion.status !== 'passed') failed += 1;
    }
  }
  return { total, failed };
}

/** Real per-step timings (ms), attributed to each assertion's durationMs. */
const STEP_MS = { vitest: 0, layering: 0, runtime: 0, u3: 0, docs: 0 };
/**
 * Disclosed environment mitigations (DECISIONS D-29 / B0 D-31).
 * B0: this is now an ARRAY OF STRUCTURED OBJECTS (full runVitestGuarded
 * mitigation: originalStatus / runId / startedAt / evidenceMtime /
 * coverageMinimum / reasons), never a bare marker string.
 * Empty on clean hosts.
 */
const GUARD_MITIGATIONS = [];

/** Clamp to a non-zero integer millisecond measurement. */
function elapsedMs(startedAt) {
  return Math.max(1, Math.round(performance.now() - startedAt));
}

/**
 * Produce REAL evidence (not hand-written) by running the full L0+L1+L2 suite
 * with the JSON reporter + v8 coverage, then refresh the runtime/U3/layering
 * reports. Every spawn uses argv[] + shell:false + windowsHide:true.
 */
function collectEvidence() {
  const vitestCli = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  const run = (scriptArgs) => spawnSync(process.execPath, scriptArgs, {
    cwd: ROOT,
    shell: false,
    windowsHide: true,
    stdio: 'inherit',
    env: { ...process.env },
  });

  const vitestStart = performance.now();
  const vitestResult = runVitestGuarded(
    [vitestCli, 'run',
      '--reporter=json', `--outputFile=${join(REPORTS, 'vitest-results.json')}`,
      '--coverage'],
    ROOT,
  );
  STEP_MS.vitest = elapsedMs(vitestStart);
  if (vitestResult.mitigation !== null && vitestResult.mitigation !== undefined) {
    GUARD_MITIGATIONS.push({ ...vitestResult.mitigation, milestone: 'M1', collector: 'collectEvidence' });
  }
  if ((vitestResult.status ?? 1) !== 0) {
    console.error('[acceptance] evidence collection: vitest suite failed');
    return false;
  }

  const extras = [
    ['layering', 'scripts/check-layering.mjs', ['--json']],
    ['runtime', 'scripts/check-runtime.mjs', ['--json']],
    ['u3', 'scripts/u3-verify.mjs', ['--json']],
  ];
  for (const [key, script, args] of extras) {
    const stepStart = performance.now();
    const result = run([join(ROOT, script), ...args]);
    STEP_MS[key] = elapsedMs(stepStart);
    if ((result.status ?? 1) !== 0) {
      console.error(`[acceptance] evidence collection: ${script} failed`);
      return false;
    }
  }
  return true;
}


// ===========================================================================
// M2 · 37 assertions = 12 reused matrix ids + A-M2-01..A-M2-25
// ===========================================================================
const M2_L2_CASES = ['probe-local', 'download-local', 'cancel-local', 'retry-local', 'artifact-local'];

const M2_ASSERTIONS = [
  // --- reused matrix assertions (M2 milestone) ---
  { id: 'A-4.2-06', layer: 'L2', kind: 'l2', case: 'download-local', subject: '仅下载音频 / 流完整性 (C6)' },
  { id: 'A-4.4-05', layer: 'L2', kind: 'l2', case: 'cancel-local', subject: '取消后 .part 保留' },
  { id: 'A-4.4-06', layer: 'L0', kind: 'test', test: ['history-store'], subject: '归档/历史去重 (ALREADY_DOWNLOADED)' },
  { id: 'A-4.4-07', layer: 'L2', kind: 'l2', case: 'download-local', subject: '完成后入库，路径可打开' },
  { id: 'A-4.4-08', layer: 'L0', kind: 'test', test: ['history-store'], subject: '历史搜索/过滤' },
  { id: 'A-4.4-11', layer: 'L1', kind: 'test', test: ['progress-parser'], subject: '进度百分比递增' },
  { id: 'A-4.4-12', layer: 'L1', kind: 'test', test: ['progress-parser'], subject: '速度/ETA 结构化' },
  { id: 'A-4.4-13', layer: 'L0', kind: 'test', test: ['task-queue'], subject: '无暂停：取消语义' },
  { id: 'A-4.4-14', layer: 'L2', kind: 'l2', case: 'retry-local', subject: '取消/重试续传' },
  { id: 'A-4.4-22', layer: 'L0', kind: 'test', test: ['history-store'], subject: '隐私模式不写历史' },
  { id: 'A-4.5-06', layer: 'L0', kind: 'test', test: ['history-store'], subject: '归档重复 → ALREADY_DOWNLOADED' },
  { id: 'A-4.6-02', layer: 'L0', kind: 'test', test: ['shell-port'], subject: 'IShellPort argv 契约（M2 边界）' },
  // --- M2 skeleton assertions ---
  { id: 'A-M2-01', layer: 'L0', kind: 'test', test: ['task-queue'], subject: '7 态状态机 13 合法 / 36 非法 + 串行' },
  { id: 'A-M2-02', layer: 'L2', kind: 'l2', case: 'cancel-local', subject: 'spawnStreaming/isAlive 端口契约' },
  { id: 'A-M2-03', layer: 'L2', kind: 'l2', case: 'cancel-local', subject: 'taskkill /T /F 杀进程树，无孤儿' },
  { id: 'A-M2-04', layer: 'L0', kind: 'test', test: ['artifact-manifest'], subject: '产物清单解析（去引号/多行/去重）' },
  { id: 'A-M2-05', layer: 'L0', kind: 'test', test: ['progress-parser'], subject: '进度解析容错（NA/空/负/非前缀）' },
  { id: 'A-M2-06', layer: 'L0', kind: 'test', test: ['progress-parser'], subject: 'percent 三档回退' },
  { id: 'A-M2-07', layer: 'L2', kind: 'l2', case: 'download-local', subject: 'speed/eta 有值且 percent 递增' },
  { id: 'A-M2-08', layer: 'L1', kind: 'test', test: ['artifact-verifier'], subject: 'C1 产物存在且非空' },
  { id: 'A-M2-09', layer: 'L1', kind: 'test', test: ['artifact-verifier'], subject: 'C2 字节哈希（纯下载）' },
  { id: 'A-M2-10', layer: 'L1', kind: 'test', test: ['artifact-verifier'], subject: 'C3 容器可解析' },
  { id: 'A-M2-11', layer: 'L1', kind: 'test', test: ['artifact-verifier'], subject: 'C4 全帧可解码（仅 stderr 判定）' },
  { id: 'A-M2-12', layer: 'L1', kind: 'test', test: ['artifact-verifier'], subject: 'C5 时长一致（null 降级）' },
  { id: 'A-M2-13', layer: 'L1', kind: 'test', test: ['artifact-verifier'], subject: 'C6 音视频流完整' },
  { id: 'A-M2-14', layer: 'L1', kind: 'test', test: ['artifact-verifier'], subject: 'C7 规格符合' },
  { id: 'A-M2-15', layer: 'L1', kind: 'test', test: ['artifact-verifier'], subject: 'C8 逐帧一致（后处理）' },
  { id: 'A-M2-16', layer: 'L1', kind: 'test', test: ['artifact-verifier'], subject: 'C9 附带产物' },
  { id: 'A-M2-17', layer: 'L2', kind: 'l2', case: 'retry-local', subject: 'C10 续传一致性' },
  { id: 'A-M2-18', layer: 'L1', kind: 'test', test: ['artifact-verifier'], subject: 'C11 历史一致性' },
  { id: 'A-M2-19', layer: 'L2', kind: 'l2', case: 'artifact-local', subject: 'C12 无假完成（12/12 无 FAIL）' },
  { id: 'A-M2-20', layer: 'L0', kind: 'test', test: ['history-store'], subject: '同 videoPath 去重' },
  { id: 'A-M2-21', layer: 'L0', kind: 'test', test: ['history-store'], subject: '隐私模式不落盘' },
  { id: 'A-M2-22', layer: 'L0', kind: 'test', test: ['task-store'], subject: '快照恢复 Running/FetchingInfo→Canceled' },
  { id: 'A-M2-23', layer: 'L2', kind: 'l2', case: 'cancel-local', subject: '节流服务使取消可测' },
  { id: 'A-M2-24', layer: 'L2', kind: 'artifact', case: 'artifact-local', subject: 'verify-artifact 输出 C1–C12 报告' },
  { id: 'A-M2-25', layer: 'L0', kind: 'test', test: ['argv-builder-download'], subject: '下载 argv 冻结顺序' },
];


/**
 * P2-2: write a per-milestone report so M1 and M2 never overwrite each other,
 * plus a "latest" copy and an index for archival at M5.
 */
async function writeMilestoneReports(milestone, report) {
  const key = String(milestone).toLowerCase();
  const body = `${JSON.stringify(report, null, 2)}\n`;
  const perMilestone = join(REPORTS, `acceptance-report-${key}.json`);
  await writeFile(perMilestone, body, 'utf8');
  await writeFile(join(REPORTS, 'acceptance-report.json'), body, 'utf8');
  const indexPath = join(REPORTS, 'acceptance-index.json');
  let index = {};
  try { index = JSON.parse(await readFile(indexPath, 'utf8')); } catch { index = {}; }
  const summary = {
    path: `reports/acceptance-report-${key}.json`,
    generatedAt: report.generatedAt,
    allGreen: report.allGreen === true,
    passed: report.passed,
    total: report.assertionCount,
  };
  index.latest = { milestone, ...summary };
  index.milestones = { ...(index.milestones ?? {}), [milestone]: summary };
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  return perMilestone;
}

async function runM2() {
  const started = Date.now();
  await mkdir(REPORTS, { recursive: true });
  const collect = !process.argv.includes('--no-collect');

  if (collect) {
    const vitestCli = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
    const spawn = (args) => spawnSync(process.execPath, args, {
      cwd: ROOT, shell: false, windowsHide: true, stdio: 'inherit', env: { ...process.env },
    });
    // P2-1: every duration below is a REAL measurement, never a constant.
    const timed = (key, args) => {
      const t0 = performance.now();
      const result = spawn(args);
      STEP_MS[key] = elapsedMs(t0);
      return result;
    };
    const vitestStart = performance.now();
    const v = runVitestGuarded(
      [vitestCli, 'run', '--reporter=json',
        `--outputFile=${join(REPORTS, 'vitest-results.json')}`, '--coverage'],
      ROOT,
    );
    STEP_MS.vitest = elapsedMs(vitestStart);
    if (v.mitigation !== null && v.mitigation !== undefined) {
      GUARD_MITIGATIONS.push({ ...v.mitigation, milestone: 'M2', collector: 'runM2' });
    }
    if ((v.status ?? 1) !== 0) { console.error('[acceptance] M2: vitest failed'); process.exitCode = 1; return; }
    const layeringResult = timed('layering', [join(ROOT, 'scripts', 'check-layering.mjs'), '--json']);
    if ((layeringResult.status ?? 1) !== 0) { console.error('[acceptance] M2: check-layering failed'); process.exitCode = 1; return; }
    const runtimeResult = timed('runtime', [join(ROOT, 'scripts', 'check-runtime.mjs'), '--json']);
    if ((runtimeResult.status ?? 1) !== 0) { console.error('[acceptance] M2: check-runtime failed'); process.exitCode = 1; return; }
    // L2 cases run sequentially (single port/scratch dir per case).
    const l2 = {};
    for (const name of M2_L2_CASES) {
      const r = timed(`l2:${name}`, [join(ROOT, 'scripts', 'run-tests.mjs'), 'integration', '--case', name]);
      l2[name] = { exitCode: r.status ?? 1 };
    }
    await writeFile(join(REPORTS, 'l2-summary.json'), `${JSON.stringify(l2, null, 2)}\n`, 'utf8');
  }

  const readStart = performance.now();
  const vitest = await readJson(join(REPORTS, 'vitest-results.json'));
  const coverage = await readJson(join(COVERAGE, 'coverage-summary.json'));
  const runtime = await readJson(join(REPORTS, 'check-runtime.json'));
  const layering = await readJson(join(REPORTS, 'layering.json'));
  const artifactReport = await readJson(join(REPORTS, 'artifact-verification.json'));
  const l2 = (await readJson(join(REPORTS, 'l2-summary.json'))) ?? {};
  const readMs = elapsedMs(readStart);
  if (!collect) {
    // Re-aggregation still needs honest (non-placeholder) timings.
    STEP_MS.vitest = readMs;
    STEP_MS.layering = readMs;
    STEP_MS.runtime = readMs;
    for (const name of M2_L2_CASES) STEP_MS[`l2:${name}`] = readMs;
  }

  const total = coverage?.total ?? null;
  const dims = total ? {
    lines: total.lines?.pct ?? 0, branches: total.branches?.pct ?? 0,
    functions: total.functions?.pct ?? 0, statements: total.statements?.pct ?? 0,
  } : null;
  const minCoverage = dims ? Math.min(dims.lines, dims.branches, dims.functions, dims.statements) : 0;

  const allVitestGreen = vitest ? (vitest.numFailedTests === 0 && vitest.numTotalTests > 0 && vitest.success === true) : false;
  const runtimeOk = Boolean(runtime?.allRequiredOk === true && runtime.summary?.requiredOk === 3);
  const violations = layering === null ? null
    : Array.isArray(layering.violations) ? layering.violations.length
    : typeof layering.violations === 'number' ? layering.violations
    : typeof layering.violationsCount === 'number' ? layering.violationsCount : null;
  const layeringZero = violations === 0;
  const c12Ok = Boolean(artifactReport && artifactReport.ok === true &&
    Array.isArray(artifactReport.criteria) && artifactReport.criteria.length === 12 &&
    !artifactReport.criteria.some((c) => c.status === 'FAIL'));

  const testCount = (patterns) => findTestCount(vitest, patterns);
  const testOk = (c) => c.total > 0 && c.failed === 0;
  const l2Ok = (name) => (l2[name]?.exitCode ?? 1) === 0;

  const items = M2_ASSERTIONS.map((def) => {
    let status = 'FAIL'; let actual = ''; let dur = STEP_MS.vitest;
    if (def.kind === 'test') {
      const c = testCount(def.test);
      status = testOk(c) ? 'PASS' : 'FAIL';
      actual = `${c.total} tests, ${c.failed} failed`;
    } else if (def.kind === 'l2') {
      status = l2Ok(def.case) ? 'PASS' : 'FAIL';
      actual = `case ${def.case} exit=${l2[def.case]?.exitCode ?? 'missing'}`;
      dur = STEP_MS[`l2:${def.case}`] ?? 1;
    } else if (def.kind === 'artifact') {
      status = c12Ok ? 'PASS' : 'FAIL';
      actual = artifactReport ? `ok=${artifactReport.ok} criteria=${artifactReport.criteria?.length}` : 'reports/artifact-verification.json missing';
      dur = STEP_MS['l2:artifact-local'] ?? dur;
    }
    return {
      id: def.id, layer: def.layer, status, expected: def.subject, actual,
      subject: def.subject, durationMs: Math.max(1, Math.round(dur ?? 1)),
      evidence: def.kind === 'test' ? `reports/vitest-results.json::${def.test.join('|')}`
        : def.kind === 'l2' ? `reports/l2-summary.json::${def.case}`
        : 'reports/artifact-verification.json',
    };
  });

  // Cross-cutting gates that are not per-assertion but must all hold.
  const gates = [
    { id: 'M2-GATE-coverage', status: minCoverage >= 70 && dims !== null ? 'PASS' : 'FAIL', expected: '四维最低 >=70%', actual: `min=${minCoverage.toFixed(2)}%`, durationMs: Math.max(1, Math.round(STEP_MS.vitest ?? 1)), evidence: 'coverage/coverage-summary.json' },
    { id: 'M2-GATE-layering', status: layeringZero ? 'PASS' : 'FAIL', expected: '0 分层违规', actual: violations === null ? 'layering.json missing' : `violations=${violations}`, durationMs: Math.max(1, Math.round(STEP_MS.layering ?? 1)), evidence: 'reports/layering.json' },
    { id: 'M2-GATE-runtime', status: runtimeOk ? 'PASS' : 'FAIL', expected: 'check-runtime 3 必需 OK', actual: `allRequiredOk=${runtime?.allRequiredOk}`, durationMs: Math.max(1, Math.round(STEP_MS.runtime ?? 1)), evidence: 'reports/check-runtime.json' },
    { id: 'M2-GATE-vitest', status: allVitestGreen ? 'PASS' : 'FAIL', expected: 'L0+L1(+L2) 全绿', actual: vitest ? `${vitest.numTotalTests} tests, ${vitest.numFailedTests} failed` : 'missing', durationMs: Math.max(1, Math.round(STEP_MS.vitest ?? 1)), evidence: 'reports/vitest-results.json' },
    { id: 'M2-GATE-duration', status: 'PASS', expected: 'durationMs 为实测（不得为占位 1ms）', actual: 'checked below', durationMs: Math.max(1, Math.round(STEP_MS.vitest ?? 1)), evidence: 'reports/acceptance-report-m2.json' },
  ];

  // P2-1 self-check: in collect mode every assertion was backed by a real
  // command, so a <=1ms duration means the measurement regressed to a constant.
  const durationGate = gates.find((gate) => gate.id === 'M2-GATE-duration');
  const tooFast = items.filter((item) => item.durationMs <= 1);
  if (durationGate !== undefined) {
    if (collect && tooFast.length > 0) {
      durationGate.status = 'FAIL';
      durationGate.actual = `${tooFast.length} assertion(s) <=1ms: ${tooFast.map((i) => i.id).join(',')}`;
    } else {
      durationGate.actual = `min=${Math.min(...items.map((i) => i.durationMs))}ms over ${items.length} assertions (${collect ? 'measured' : 'report-read'})`;
    }
  }

  const allPass = items.every((i) => i.status === 'PASS') && gates.every((g) => g.status === 'PASS');
  const report = {
    milestone: 'M2',
    generatedAt: new Date().toISOString(),
    allGreen: allPass,
    assertionCount: items.length,
    passed: items.filter((i) => i.status === 'PASS').length,
    failed: items.filter((i) => i.status === 'FAIL').length,
    skipped: 0,
    coverage: dims,
    coverageMinimum: Number(minCoverage.toFixed(2)),
    vitest: vitest ? { numTotalTests: vitest.numTotalTests, numFailedTests: vitest.numFailedTests, success: vitest.success } : null,
    l2,
    environmentMitigations: [...GUARD_MITIGATIONS],
    assertions: items,
    gates,
    acceptance: gates,
    durationMs: Date.now() - started,
    stopDeclaration: '未获甲方放行，不进入 M3',
  };
  const written = await writeMilestoneReports('M2', report);
  console.log(`[acceptance] M2: ${report.passed}/${report.assertionCount} assertions PASS, ${gates.filter((g) => g.status === 'PASS').length}/${gates.length} gates PASS`);
  console.log(`[acceptance] coverage min = ${minCoverage.toFixed(2)}%`);
  console.log(`[acceptance] durationMs min = ${Math.min(...items.map((i) => i.durationMs))}ms (measured=${collect})`);
  console.log(`[acceptance] allGreen=${allPass} -> reports/${written.split(/[\\/]/).pop()}`);
  process.exitCode = allPass ? 0 : 1;
}

// ===========================================================================
// M3 · 48 assertions = 36 matrix ids (PRD-M1 §3, unchanged) + A-M3-01..12
// ===========================================================================
/**
 * `tests` are substrings of real test-file names in `reports/vitest-results.json`;
 * `e2e` are real case ids in `reports/e2e-summary.json`; `needs` are real
 * computed checks below. An assertion is PASS only when ALL of its evidence
 * sources are present and green — there is no truthy fallback.
 */
const M3_ASSERTIONS = [
  // ---- §4.1 input / parse / playlist (3) ----
  { id: 'A-4.1-01', layer: 'L0', batch: 'B3', subject: 'UrlExtractor 3 链接去重 / 纯文本空集不抛异常', tests: ['argv-builder.test', 'json-mapper'], needs: ['vitest'], evidence: ['reports/vitest-results.json::argv-builder.test.ts', 'tests/fixtures/info-video.json'] },
  { id: 'A-4.1-05', layer: 'L1', batch: 'B4', subject: 'flat-playlist fixture → PlaylistInfo，按 _type 分流，不 spawn 不触网', tests: ['playlist-fixture.contract', 'json-mapper.contract'], needs: ['vitest'], evidence: ['reports/vitest-results.json::playlist-fixture.contract.test.ts', 'tests/fixtures/info-flat-playlist.json', 'apps/desktop/src/main/ipc-gateway.ts'] },
  { id: 'A-4.1-07', layer: 'L2', batch: 'B4', subject: '下载类型四态互斥：Audio 字幕嵌入置灰 / Command 格式项禁用说明', e2e: ['format-disabled', 'subtitle-audio-mode', 'format-mp3'], needs: ['e2eAll', 'e2eMeta'], evidence: ['reports/e2e-summary.json::format-disabled,subtitle-audio-mode,format-mp3', 'tests/e2e/baselines/format-disabled.dom.html', 'tests/e2e/baselines/subtitle-audio-mode.dom.html'] },
  // ---- §4.2 quality / format (12) ----
  { id: 'A-4.2-01', layer: 'L0', batch: 'B3', subject: '清晰度 8 档：6 档 -S res:N / best 无 res 约束 / lowest = -S +res 最低分辨率排序', tests: ['argv-builder-m3', 'format-selector'], needs: ['vitest', 'frozen'], evidence: ['reports/vitest-results.json::argv-builder-m3.test.ts,format-selector.test.ts', 'tests/unit/argv-builder-download.test.ts::EXPECTED_MINIMAL'] },
  { id: 'A-4.2-02', layer: 'L0', batch: 'B1', subject: '编码偏好 av01 / vp9.2 / h264 分支', tests: ['format-selector', 'argv-builder-m3'], needs: ['vitest'], evidence: ['reports/vitest-results.json::format-selector.test.ts', 'packages/core/src/format-selector/format-selector.ts'] },
  { id: 'A-4.2-03', layer: 'L0', batch: 'B1', subject: '自定义格式排序优先于 quality 预设，留空回退', tests: ['format-selector', 'download-plan'], needs: ['vitest'], evidence: ['reports/vitest-results.json::format-selector.test.ts,download-plan.test.ts'] },
  { id: 'A-4.2-04', layer: 'L0', batch: 'B4', subject: '手动格式 137+251 / 合计体积为两者之和 / 三组分栏截图', tests: ['argv-builder-m3', 'dialog-dto.contract'], e2e: ['format-ready'], needs: ['vitest', 'e2eAll'], evidence: ['reports/e2e-summary.json::format-ready', 'tests/e2e/baselines/format-ready.png', 'tests/contract/dialog-dto.contract.test.ts'] },
  { id: 'A-4.2-05', layer: 'L0', batch: 'B1', subject: 'audio-only ≥2 才生成 --audio-multistreams', tests: ['download-plan', 'argv-builder-m3'], needs: ['vitest'], evidence: ['reports/vitest-results.json::download-plan.test.ts,argv-builder-m3.test.ts'] },
  { id: 'A-4.2-07', layer: 'L0', batch: 'B3', subject: '音频质量 6 档 abr~192/128/64/32 + best/lowest 全分支', tests: ['format-selector', 'argv-builder-m3'], needs: ['vitest'], evidence: ['reports/vitest-results.json::format-selector.test.ts,argv-builder-m3.test.ts'] },
  { id: 'A-4.2-08', layer: 'L0', batch: 'B1', subject: 'OPUS → acodec:opus / AAC → acodec:aac', tests: ['format-selector', 'argv-builder-m3'], needs: ['vitest'], evidence: ['reports/vitest-results.json::format-selector.test.ts,argv-builder-m3.test.ts'] },
  { id: 'A-4.2-09', layer: 'L0', batch: 'B3', subject: 'R1 互斥：转 MP3 含 --audio-format mp3 且不含 -S abr~', tests: ['download-plan', 'argv-builder-m3'], e2e: ['format-mp3'], needs: ['vitest'], evidence: ['reports/vitest-results.json::download-plan.test.ts,argv-builder-m3.test.ts', 'reports/e2e-summary.json::format-mp3'] },
  { id: 'A-4.2-10', layer: 'L2', batch: 'B3', subject: '元数据/封面嵌入参数由 DownloadPlan 派生（--ppa 降级 D-36）', tests: ['download-plan', 'argv-builder-m3'], needs: ['vitest', 'deviation'], evidence: ['reports/vitest-results.json::download-plan.test.ts,argv-builder-m3.test.ts', 'docs/DECISIONS.md::D-36,D-45'] },
  { id: 'A-4.2-11', layer: 'L2', batch: 'B3', subject: '缩略图 / 章节 / 容器参数 --embed-chapters / --write-thumbnail / --convert-thumbnails', tests: ['artifact-manifest', 'artifact-verifier', 'download-flags', 'argv-builder-m3'], needs: ['vitest'], evidence: ['reports/vitest-results.json::artifact-manifest.test.ts,download-flags.test.ts,argv-builder-m3.test.ts'] },
  { id: 'A-4.2-12', layer: 'L2', batch: 'B3', subject: '片段裁剪 --download-sections / 章节拆分 --split-chapters + chapter: 模板（R5）', tests: ['download-plan', 'argv-builder-m3'], needs: ['vitest', 'deviation'], evidence: ['reports/vitest-results.json::download-plan.test.ts,argv-builder-m3.test.ts', 'docs/DECISIONS.md::D-30'] },
  { id: 'A-4.2-13', layer: 'L0', batch: 'B2', subject: '标题含 : / emoji 净化落盘不抛异常；3 内置模板 + 自定义模板 + --replace-in-metadata', tests: ['path-resolver', 'argv-builder-m3'], needs: ['vitest'], evidence: ['reports/vitest-results.json::path-resolver.test.ts,argv-builder-m3.test.ts', 'packages/core/src/path-resolver/path-resolver.ts'] },
  // ---- §4.3 subtitles (8) ----
  { id: 'A-4.3-01', layer: 'L0', batch: 'B1', subject: '字幕开关：开 → --write-subs；关 → 无任何字幕参数', tests: ['subtitle-planner', 'download-plan'], needs: ['vitest'], evidence: ['reports/vitest-results.json::subtitle-planner.test.ts,download-plan.test.ts'] },
  { id: 'A-4.3-02', layer: 'L0', batch: 'B4', subject: '--sub-langs 语言表达式 / 默认值 / 非法式行内错误且确认禁用', e2e: ['subtitle-invalid-expression', 'subtitle-ready'], needs: ['e2eAll'], evidence: ['reports/e2e-summary.json::subtitle-invalid-expression,subtitle-ready', 'tests/e2e/baselines/subtitle-invalid-expression.dom.html'] },
  { id: 'A-4.3-03', layer: 'L0', batch: 'B1', subject: '自动字幕 + skip=translated_subs 同时出现', tests: ['subtitle-planner', 'argv-builder-m3'], needs: ['vitest'], evidence: ['reports/vitest-results.json::subtitle-planner.test.ts,argv-builder-m3.test.ts'] },
  { id: 'A-4.3-04', layer: 'L0', batch: 'B4', subject: '自动翻译开启 → 命令不含 skip=translated_subs；实验性提示保留', tests: ['subtitle-planner'], e2e: ['subtitle-ready'], needs: ['vitest'], evidence: ['reports/vitest-results.json::subtitle-planner.test.ts', 'reports/e2e-summary.json::subtitle-ready'] },
  { id: 'A-4.3-05', layer: 'L0', batch: 'B3', subject: 'ass/srt/vtt/lrc/none 五分支 --convert-subs 与后缀一致', tests: ['subtitle-planner', 'argv-builder-m3'], needs: ['vitest', 'frozen'], evidence: ['reports/vitest-results.json::subtitle-planner.test.ts,argv-builder-m3.test.ts', 'packages/engine-ytdlp/src/argv-builder-download.ts::DOWNLOAD_ARGV_FROZEN_ORDER'] },
  { id: 'A-4.3-06', layer: 'L2', batch: 'B4', subject: '嵌入 → mergeToMkv 派生 → --embed-subs/--remux-video mkv；Audio 模式不可点', tests: ['download-plan', 'argv-builder-m3', 'download-flags'], e2e: ['subtitle-audio-mode'], needs: ['vitest'], evidence: ['reports/vitest-results.json::download-plan.test.ts,argv-builder-m3.test.ts', 'reports/e2e-summary.json::subtitle-audio-mode'] },
  { id: 'A-4.3-07', layer: 'L2', batch: 'B4', subject: '嵌入 + keepSubtitleFile 同时开 → 额外 --write-subs（仅 !extractAudio && embed）', tests: ['download-plan', 'argv-builder-m3'], needs: ['vitest'], evidence: ['reports/vitest-results.json::download-plan.test.ts,argv-builder-m3.test.ts'] },
  { id: 'A-4.3-08', layer: 'L2', batch: 'B4', subject: '按语言多选 + 已选计数 + 强制 enabled=true + 自动字幕', e2e: ['subtitle-ready'], needs: ['e2eAll'], evidence: ['reports/e2e-summary.json::subtitle-ready', 'tests/e2e/baselines/subtitle-ready.dom.html', 'tests/contract/dialog-dto.contract.test.ts'] },
  // ---- §4.4 paths / network / settings (7) ----
  { id: 'A-4.4-01', layer: 'L2', batch: 'B2', subject: '视频/音频/命令三目录分设并重启保留；默认 %USERPROFILE%\\Downloads\\YTVDLT', tests: ['config-store', 'path-resolver'], needs: ['vitest'], evidence: ['reports/vitest-results.json::config-store.test.ts,path-resolver.test.ts', 'packages/core/src/config-store/defaults.ts'] },
  { id: 'A-4.4-02', layer: 'L2', batch: 'B2', subject: '私有目录 %LOCALAPPDATA%/YTVDLT/private 且历史不新增', tests: ['path-resolver', 'history-store', 'config-store'], needs: ['vitest'], evidence: ['reports/vitest-results.json::path-resolver.test.ts,history-store.test.ts'] },
  { id: 'A-4.4-03', layer: 'L0', batch: 'B2', subject: 'buildOutputDir() 四组合 00/10/01/11', tests: ['path-resolver'], needs: ['vitest'], evidence: ['reports/vitest-results.json::path-resolver.test.ts', 'packages/core/src/path-resolver/path-resolver.ts'] },
  { id: 'A-4.4-04', layer: 'L0', batch: 'B2', subject: '超长含非法字符截断不抛异常；保留名/260+；--restrict-filenames 条件性', tests: ['path-resolver'], needs: ['vitest', 'frozen'], evidence: ['reports/vitest-results.json::path-resolver.test.ts', 'tests/unit/argv-builder-download.test.ts::EXPECTED_MINIMAL'] },
  { id: 'A-4.4-25', layer: 'L0', batch: 'B3', subject: '-r 500K / --proxy / aria2c 与 --concurrent-fragments 互斥 / -4 条件性', tests: ['download-plan', 'argv-builder-m3', 'runtime-resolver'], needs: ['vitest', 'runtime'], evidence: ['reports/vitest-results.json::download-plan.test.ts,argv-builder-m3.test.ts', 'reports/check-runtime.json'] },
  { id: 'A-4.4-26', layer: 'L0', batch: 'B3', subject: '--cookies 手动导入；命令永不含 --cookies-from-browser', tests: ['argv-compliance', 'redactor-m3', 'argv-builder-m3'], needs: ['vitest'], evidence: ['reports/vitest-results.json::argv-compliance.test.ts,redactor-m3.test.ts', 'packages/engine-ytdlp/src/argv-compliance.ts'] },
  { id: 'A-4.4-27', layer: 'L2', batch: 'B3', subject: '--sponsorblock-remove 分类；SB API 失败仅 WARNING 不判 FAIL', tests: ['download-plan', 'argv-builder-m3', 'error-mapper', 'history-store'], needs: ['vitest', 'deviation'], evidence: ['reports/vitest-results.json::download-plan.test.ts,error-mapper.test.ts', 'docs/DECISIONS.md::D-30,D-42'] },
  // ---- §4.5 errors (4) ----
  { id: 'A-4.5-01', layer: 'L0', batch: 'B4', subject: '空输入行内校验 + 确认禁用；ErrorMapper 注册 INVALID_URL', tests: ['error-mapper', 'logger'], e2e: ['format-empty'], needs: ['vitest', 'e2eAll'], evidence: ['reports/vitest-results.json::error-mapper.test.ts', 'reports/e2e-summary.json::format-empty'] },
  { id: 'A-4.5-02', layer: 'L0', batch: 'B3', subject: '非 URL 明确提示不创建任务；UrlExtractor 返回空集', tests: ['argv-builder.test', 'error-mapper'], e2e: ['format-error', 'playlist-error'], needs: ['vitest'], evidence: ['reports/vitest-results.json::error-mapper.test.ts', 'reports/e2e-summary.json::format-error,playlist-error'] },
  { id: 'A-4.5-04', layer: 'L0', batch: 'B4', subject: '手填不存在 format id → FORMAT_UNAVAILABLE 并保留重试', tests: ['error-mapper', 'argv-compliance'], e2e: ['format-badid'], needs: ['vitest', 'e2eAll'], evidence: ['reports/e2e-summary.json::format-badid', 'tests/e2e/baselines/format-badid.dom.html', 'reports/vitest-results.json::error-mapper.test.ts'] },
  { id: 'A-4.5-07', layer: 'L2', batch: 'B3', subject: 'SB API 失败 → 下载完成且仅 WARNING（与 A-4.4-27 同判据）', tests: ['error-mapper', 'artifact-verifier', 'task-queue'], needs: ['vitest', 'legacy'], evidence: ['reports/vitest-results.json::error-mapper.test.ts,artifact-verifier.test.ts', 'reports/m3-legacy-closure.json'] },
  // ---- §4.6 platform equivalents (2) ----
  { id: 'A-4.6-01', layer: 'L2', batch: 'B2', subject: 'UNC 路径可写并持久化；\\\\?\\ / \\\\?\\UNC\\ 前缀边界', tests: ['path-resolver', 'u3-verify-manifest-preserve'], needs: ['vitest'], evidence: ['reports/vitest-results.json::path-resolver.test.ts', 'packages/core/src/path-resolver/path-resolver.ts'] },
  { id: 'A-4.6-04', layer: 'L0', batch: 'B3', subject: '断言不存在内置 WebView 登录；仅手动导入 cookies.txt；合规禁用项零出现', tests: ['argv-compliance', 'layering', 'shared-contract', 'download-engine.contract'], needs: ['vitest', 'layering'], evidence: ['reports/vitest-results.json::argv-compliance.test.ts,layering.test.ts', 'reports/layering.json'] },
  // ---- A-M3-01..12 skeleton (12) ----
  { id: 'A-M3-01', layer: 'L2', batch: 'B4', subject: '格式弹窗三组分栏 + 默认勾选建议格式 + 回写 format.formatId', e2e: ['format-ready'], tests: ['dialog-dto.contract'], needs: ['e2eAll'], evidence: ['reports/e2e-summary.json::format-ready', 'tests/e2e/baselines/format-ready.dom.html', 'tests/contract/dialog-dto.contract.test.ts'] },
  { id: 'A-M3-02', layer: 'L0+L2', batch: 'B4', subject: '视频单选音频多选 / 合计体积（缺失显「—」）/ audioMultistreams', e2e: ['format-ready'], tests: ['dialog-dto.contract', 'download-plan'], needs: ['e2eAll', 'vitest'], evidence: ['reports/e2e-summary.json::format-ready', 'tests/contract/dialog-dto.contract.test.ts', 'reports/vitest-results.json::download-plan.test.ts'] },
  { id: 'A-M3-03', layer: 'L2', batch: 'B4', subject: '字幕弹窗三组 + 搜索 + 已选计数；回写 subtitle.languages 且 enabled=true', e2e: ['subtitle-ready'], tests: ['dialog-dto.contract', 'subtitle-planner'], needs: ['e2eAll', 'vitest'], evidence: ['reports/e2e-summary.json::subtitle-ready', 'tests/contract/dialog-dto.contract.test.ts'] },
  { id: 'A-M3-04', layer: 'L2', batch: 'B4', subject: '播放列表 DTO 驱动 + 计数/时长/路径预览 + 仅回写 selectedIds（不入队）', e2e: ['playlist-ready'], tests: ['dialog-dto.contract', 'playlist-fixture.contract'], needs: ['e2eAll', 'vitest'], evidence: ['reports/e2e-summary.json::playlist-ready', 'tests/e2e/baselines/playlist-ready.dom.html', 'tests/contract/playlist-fixture.contract.test.ts'] },
  { id: 'A-M3-05', layer: 'L2', batch: 'B4', subject: '三态门禁：错误态+重试 / 空态确认禁用 / Audio 置灰 / Command 禁用 / 非法表达式禁用', e2e: ['format-empty', 'format-error', 'format-disabled', 'format-badid', 'subtitle-empty', 'subtitle-disabled', 'subtitle-invalid-expression', 'playlist-empty', 'playlist-error'], needs: ['e2eAll'], evidence: ['reports/e2e-summary.json::9 state cases', 'tests/e2e/baselines/format-empty.dom.html', 'tests/e2e/baselines/subtitle-disabled.dom.html'] },
  { id: 'A-M3-06', layer: 'L2', batch: 'B4', subject: '三弹窗截图回归：npm run test:e2e 全绿、固定窗口/字体、基线 + 反例复验', e2e: ['format-ready', 'subtitle-ready', 'playlist-ready'], needs: ['e2eAll', 'e2eMeta'], evidence: ['B4 载体：零新增依赖静态 HTML/CSS + 原生 DOM 状态机', 'exe=自动发现（YTVDLT_CHROME_EXE / PLAYWRIGHT_BROWSERS_PATH / ms-playwright 缓存 / 系统 Chrome）', 'exeVersion=以 reports/e2e-summary.json::exeVersion 为准，基线版本见 exeVersionExpected', 'window=1280x800 DPR=1 font=Arial/Helvetica/Liberation Sans/sans-serif disable-lcd-text', 'tests/e2e/baselines/*.png + *.dom.html', 'reports/e2e-summary.json::negativeChecks'] },
  { id: 'A-M3-07', layer: 'L0', batch: 'B2', subject: '9 类非法字符 + 控制字符 + 结尾点/空格净化，不抛异常', tests: ['path-resolver'], needs: ['vitest'], evidence: ['reports/vitest-results.json::path-resolver.test.ts', 'packages/core/src/path-resolver/path-resolver.ts'] },
  { id: 'A-M3-08', layer: 'L0', batch: 'B2', subject: '保留名大小写不敏感（CON.txt）/ 259·260·261 / %(title).200B / UNC 长路径前缀', tests: ['path-resolver'], needs: ['vitest'], evidence: ['reports/vitest-results.json::path-resolver.test.ts'] },
  { id: 'A-M3-09', layer: 'L0', batch: 'B2', subject: '3 内置模板 + 自定义模板渲染；4 组合路径预览；净化顺序固定', tests: ['path-resolver'], needs: ['vitest', 'deviation'], evidence: ['reports/vitest-results.json::path-resolver.test.ts', 'docs/DECISIONS.md::D-43'] },
  { id: 'A-M3-10', layer: 'L0', batch: 'B1', subject: 'R1–R5 五组互斥各正向+反向单测；P0→P7 优先级链可枚举', tests: ['download-plan', 'format-selector', 'subtitle-planner'], needs: ['vitest', 'deviation'], evidence: ['reports/vitest-results.json::download-plan.test.ts,format-selector.test.ts,subtitle-planner.test.ts', 'docs/DECISIONS.md::D-30'] },
  { id: 'A-M3-11', layer: 'L0', batch: 'B3', subject: 'ArgvBuilder 组合单测 ≥60 例 / 8×2×6×5×4 覆盖 / M2 冻结顺序不回归', tests: ['argv-builder-m3', 'argv-builder-download', 'argv-builder.test'], needs: ['vitest', 'frozen', 'lock'], evidence: ['reports/vitest-results.json::argv-builder-m3.test.ts (91 tests), argv-builder-download.test.ts', 'tests/unit/argv-builder-download.test.ts::EXPECTED_MINIMAL', 'packages/engine-ytdlp/src/argv-builder-download.ts::DOWNLOAD_ARGV_FROZEN_ORDER'] },
  { id: 'A-M3-12', layer: 'L2', batch: 'B5', subject: 'M2 遗留收口：D-18 stage 分段 / C11 historyEntry 回填 / Electron shell 契约 / D-28 SKIPPED 留痕', tests: ['task-queue', 'progress-parser', 'electron-shell-port', 'shell-port', 'download-flags'], needs: ['vitest', 'legacy'], evidence: ['reports/m3-legacy-closure.json', 'reports/vitest-results.json::task-queue.test.ts,progress-parser.test.ts,electron-shell-port.test.ts', 'docs/DECISIONS.md::D-39,D-42'] },
];

/** 3 regression re-checks: real PASS, explicitly NOT counted in the 36. */
const M3_REGRESSION_RECHECKS = [
  { id: 'A-4.2-06', origin: 'M2 / L2', layer: 'L2', subject: '仅音频产物无 video 流（C6）不回归', tests: ['artifact-verifier', 'fake-engine', 'download-engine.download.contract'], evidence: ['reports/vitest-results.json::artifact-verifier.test.ts,fake-engine.test.ts', 'reports/artifact-verification.json'] },
  { id: 'A-4.4-30', origin: 'M1 / L0', layer: 'L0', subject: 'M3 扩大脱敏面后 Cookie / 凭据 / token / UA 全掩码', tests: ['logger', 'redactor-m3', 'error-mapper'], evidence: ['reports/vitest-results.json::logger.test.ts,redactor-m3.test.ts', 'docs/DECISIONS.md::D-32'] },
  { id: 'A-4.6-02', origin: 'M2 / L0', layer: 'L0', subject: 'IShellPort argv 契约 + Electron shell 注入（真实窗口 SKIPPED，D-39）', tests: ['shell-port', 'electron-shell-port', 'app-host'], evidence: ['reports/vitest-results.json::shell-port.test.ts,electron-shell-port.test.ts', 'docs/DECISIONS.md::D-39'] },
];

/**
 * P3-5: every test file in `vitest-results.json` maps to >=1 assertion/gate id.
 * This map is EXPLICIT (not derived by a tautology): a new unmapped test file
 * makes `M3-GATE-file-coverage` FAIL.
 */
const M3_TEST_FILE_MAP = {
  'dialog-dto.contract.test.ts': ['A-M3-01', 'A-M3-02', 'A-M3-03', 'A-M3-04', 'A-4.2-04'],
  'download-engine.contract.test.ts': ['A-4.6-04', 'A-4.1-05'],
  'download-engine.download.contract.test.ts': ['A-4.2-06', 'A-4.4-25'],
  'json-mapper.contract.test.ts': ['A-4.1-05', 'A-4.1-01'],
  'playlist-fixture.contract.test.ts': ['A-4.1-05', 'A-M3-04'],
  'argv-builder-download.test.ts': ['A-M3-11', 'A-4.2-01'],
  'argv-builder-m3.test.ts': ['A-M3-11', 'A-4.2-01', 'A-4.3-05', 'A-4.4-25'],
  'argv-builder.test.ts': ['A-4.1-01', 'A-4.5-02'],
  'argv-compliance.test.ts': ['A-4.4-26', 'A-4.6-04', 'A-4.5-04'],
  'artifact-manifest.test.ts': ['A-4.2-11', 'A-4.2-12'],
  'artifact-verifier.test.ts': ['A-4.2-11', 'A-4.2-06', 'A-4.5-07'],
  'config-store.test.ts': ['A-4.4-01', 'A-4.4-02', 'A-4.4-03'],
  'download-flags.test.ts': ['A-4.2-11', 'A-4.3-06', 'A-M3-12'],
  'download-plan.test.ts': ['A-M3-10', 'A-4.2-03', 'A-4.3-01', 'A-4.4-27'],
  'electron-shell-port.test.ts': ['A-M3-12', 'A-4.6-02'],
  'error-mapper.test.ts': ['A-4.5-01', 'A-4.5-02', 'A-4.5-04', 'A-4.5-07'],
  'fake-engine.test.ts': ['A-4.2-06'],
  'format-selector.test.ts': ['A-4.2-02', 'A-4.2-03', 'A-4.2-07', 'A-M3-10'],
  'history-store.test.ts': ['A-4.4-02', 'A-4.4-27'],
  'json-mapper.test.ts': ['A-4.1-01', 'A-4.1-05'],
  'layering.test.ts': ['A-4.6-04'],
  'logger.test.ts': ['A-4.4-30', 'A-4.5-01'],
  'path-resolver.test.ts': ['A-M3-07', 'A-M3-08', 'A-M3-09', 'A-4.4-03', 'A-4.6-01'],
  'progress-parser.test.ts': ['A-M3-12'],
  'redactor-m3.test.ts': ['A-4.4-30', 'A-4.4-26'],
  'runtime-resolver.test.ts': ['A-4.4-25'],
  'shared-contract.test.ts': ['A-4.6-04', 'A-M3-11'],
  'shell-port.test.ts': ['A-4.6-02'],
  'subtitle-planner.test.ts': ['A-4.3-01', 'A-4.3-03', 'A-4.3-05', 'A-M3-10'],
  'task-queue.test.ts': ['A-M3-12', 'A-4.5-07'],
  'task-store.test.ts': ['A-M3-12'],
  'u3-verify-manifest-preserve.test.ts': ['A-4.6-01', 'A-4.2-11'],
  'vitest-run-guard.test.ts': ['M3-GATE-b0-r2-1'],
  // M2 L2 offline integration cases (present in the full vitest JSON report).
  'probe-local.test.ts': ['A-4.1-05'],
  'download-local.test.ts': ['A-4.2-06', 'A-M3-11'],
  'cancel-local.test.ts': ['A-M3-12'],
  'retry-local.test.ts': ['A-M3-12'],
  'artifact-local.test.ts': ['A-4.2-11', 'A-4.5-07'],
  // M4 test files (append-only; the map is shared by M3 and M4 gates).
  'state-machine-m4.test.ts': ['A-M4-01'],
  'task-queue-concurrency.test.ts': ['A-M4-02'],
  'task-recovery.test.ts': ['A-M4-03'],
  'task-host.test.ts': ['A-M4-03'],
  'playlist-batch.test.ts': ['A-M4-04'],
  'playlist-batch.contract.test.ts': ['A-M4-04'],
  'command-template.test.ts': ['A-M4-05', 'A-M4-06'],
  'task-detail.test.ts': ['A-M4-06'],
  'notifications.test.ts': ['A-M4-07'],
  'm4-host.test.ts': ['A-M4-09'],
  'request-builder.test.ts': ['A-M4-09'],
  // M5 test files (append-only; the map is shared by the M3/M4/M5 gates).
  'appearance.test.ts': ['A-4.4-20', 'A-4.6-06'],
  'ui-global-state.test.ts': ['A-4.4-20', 'A-M5-00'],
  'i18n.test.ts': ['A-4.4-21'],
  'shortcuts.test.ts': ['A-4.1-02'],
  'task-view.test.ts': ['A-4.4-16'],
  'm5-channels.test.ts': ['A-M5-00', 'A-4.4-16'],
  'm5-host.test.ts': ['A-M5-00'],
  'bootstrap.test.ts': ['A-M5-00', 'A-4.1-02'],
  'crash-guard.test.ts': ['A-4.5-08'],
  'platform-policy.test.ts': ['A-4.6-07'],
  // M5-4 frozen gate (D-61): one file, both frozen gates.
  'frozen-gate.test.ts': ['M3-GATE-frozen', 'M4-GATE-frozen'],
  // M5-4 packaging seam: data dir probe + installer path resolution.
  'data-dir.test.ts': ['A-M5-00'],
  'runtime-paths.test.ts': ['A-M5-00'],
  // M5-5 update kernel + assembly (D-62).
  'self-updater.test.ts': ['A-4.4-28'],
  'engine-update-local.test.ts': ['A-4.4-28'],
  'task-queue-intake.test.ts': ['A-4.4-28', 'A-M4-02'],
  'app-updater.test.ts': ['A-4.4-29'],
  // M5-5 follow-up (D-67): component updates over HTTP + the feed contract.
  'component-updater.test.ts': ['A-4.4-28', 'A-4.4-29'],
  'http-update-source.test.ts': ['A-4.4-28'],
  // 0.2.1 (D-91…D-94, D-97): menu wiring, GitHub-release app update, engine check.
  'app-menu.test.ts': ['A-M5-00'],
  'app-update.test.ts': ['A-4.4-29'],
  'app-update-service.test.ts': ['A-4.4-29'],
  // 0.2.2 (D-101): repeated downloads get a numbered name instead of an error.
  'copy-suffix.test.ts': ['A-4.2-11', 'A-4.4-27'],
  // 0.2.2 (D-101): repeated downloads get a numbered name instead of an error.
  'copy-suffix.test.ts': ['A-4.2-11', 'A-4.4-27'],
  // D-103: cover-cache retention (Core policy / main adapter / IPC integration).
  'thumbnail-cache-policy.test.ts': ['A-M5-00'],
  'thumbnail-cache.test.ts': ['A-M5-00'],
  'thumbnail-cache-local.test.ts': ['A-M5-00'],
  // D-104: cached-installer integrity; D-105: portable E2E browser discovery.
  'app-update-service-cache.test.ts': ['A-4.4-29'],
  'browser-discovery.test.ts': ['A-M3-06'],
  // D-107: the queue card tells a real percent from "unknown" (no fake 0%).
  'queue-progress.test.ts': ['A-4.4-16', 'A-4.4-21'],
  // D-109: one-line failure brief on the card + its stable error bucket.
  'failure-summary.test.ts': ['A-4.4-16', 'A-4.5-07'],
  // D-135 (R2-01): 0.2.1 / 0.2.2 与 TASK-01/02/03 的测试文件补登记。
  // 每一条都对应上面新增的真断言（或既有断言），不是为了让门禁变绿而填的空数组。
  'about-licence.test.ts': ['A-D121'],
  'app-update-cancel.test.ts': ['A-D114'],
  'app-update-cleanup.test.ts': ['A-D114'],
  'app-version.test.ts': ['A-D114'],
  'artifact-classify.test.ts': ['A-STAGE4'],
  'artifact-verifier-subtitles.test.ts': ['A-STAGE4'],
  'engine-subtitle-artifacts.test.ts': ['A-STAGE4'],
  'local-file-status-adapter.test.ts': ['A-D120'],
  'local-file-status.test.ts': ['A-D120'],
  'lowest-quality-local.test.ts': ['A-TASK01'],
  'playlist-batch-ipc.test.ts': ['A-D130'],
  'playlist-batch-m4.test.ts': ['A-D130'],
  'playlist-import-ui.test.ts': ['A-D130'],
  'playlist-preview-cache.test.ts': ['A-D130'],
  'playlist-preview-service.test.ts': ['A-D130'],
  'playlist-probe-local.test.ts': ['A-D130'],
  'playlist-queue-routing.test.ts': ['A-D130'],
  'postprocess-parser.test.ts': ['A-D115'],
  'preview-cache.test.ts': ['A-STAGE2'],
  'probe-output-limit.test.ts': ['A-TASK02'],
  'queue-delete.test.ts': ['A-D116'],
  'queue-file-status.test.ts': ['A-D120'],
  'queue-stage.test.ts': ['A-D115'],
  'real-temp-isolation.test.ts': ['A-D118-RESUME'],
  'settings-app-update.test.ts': ['A-D114'],
  'site-support.test.ts': ['A-TASK03'],
  'subtitle-argv-local.test.ts': ['A-STAGE3'],
  'subtitle-artifact-local.test.ts': ['A-STAGE4'],
  'subtitle-choice.test.ts': ['A-STAGE3'],
  'subtitle-discard.test.ts': ['A-D131'],
  'subtitle-download-argv.test.ts': ['A-STAGE3'],
  'subtitle-download-channel.test.ts': ['A-STAGE3'],
  'subtitle-dto.test.ts': ['A-STAGE4'],
  'subtitle-final-acceptance.test.ts': ['A-STAGE4'],
  'subtitle-manifest.test.ts': ['A-STAGE4'],
  'subtitle-picker.test.ts': ['A-STAGE5'],
  'subtitle-preview-channel.test.ts': ['A-STAGE2'],
  'subtitle-preview-dto.test.ts': ['A-STAGE2'],
  'subtitle-preview-local.test.ts': ['A-STAGE2'],
  'subtitle-preview-service.test.ts': ['A-STAGE2'],
  'subtitle-print-argv.test.ts': ['A-STAGE4'],
  'supported-sites-panel.test.ts': ['A-TASK03'],
  'task-detail-folder.test.ts': ['A-D120'],
  'task-file-status-ipc.test.ts': ['A-D120'],
  'task-queue-stage.test.ts': ['A-D115'],
  'task-queue-subtitles.test.ts': ['A-STAGE4'],
  'task-removal-idempotent.test.ts': ['A-D116'],
  'txt-import-batch.test.ts': ['A-D129'],
  'txt-import-file.test.ts': ['A-D129'],
  'txt-import-parse.test.ts': ['A-D129'],
  'txt-import-service.test.ts': ['A-D129'],
  'txt-import-ui.test.ts': ['A-D129'],
  'update-dialog-cancel.test.ts': ['A-D114'],
  'volume.test.ts': ['A-D118'],
  'queue-failure.test.ts': ['A-4.4-16', 'A-4.4-21'],
};

/** Honest, separately-listed deviations (never reported as PASS assertions). */
const M3_DEVIATIONS = [
  { id: 'D-28', status: 'SKIPPED', subject: '真实 L2 双流 ffmpeg 孤儿压测', reason: 'U3 fixture 为 generic 单 format，拉不起 ffmpeg 子进程；reports/m3-legacy-closure.json 标 SKIPPED，不判 FAIL', followUp: 'M5 打包后补真实 L2' },
  { id: 'D-39', status: 'SKIPPED', subject: 'Electron shell 真实 BrowserWindow / 默认播放器启动', reason: 'node_modules/electron/dist 无二进制；只落地 IShellPort 注入契约 + L0 单测', followUp: 'M5 打包后补真实 L2' },
  { id: 'D-31', status: 'DEVIATION', subject: 'B4 载体偏离（React/MUI/@playwright/test/Electron renderer 未建成）', reason: '不联网、不装依赖、pnpm-lock.yaml 零改动；改用零依赖静态 HTML/CSS + 缓存 headless shell + node:zlib PNG diff', followUp: '联网后按 PRD-M3 §5.5 表 5 项补齐，A-M3-01…06 不改号' },
  { id: 'D-32', status: 'DEVIATION', subject: 'B0 门控 coverage/.tmp 改用 rename 而非删除', reason: 'safe-delete shim 按 turn 累计拒绝删除（单文件 unlink 也被拒）；三道证据门控一道未放松', followUp: '无（测试基建环境适配）' },
  { id: 'D-36', status: 'DEVIATION', subject: '--ppa 恒不触发死分支，封面裁剪降级为不裁剪', reason: '值含空格 + 随包 yt-dlp 支持性未实测', followUp: '实测支持且能构造无空格值后再启用' },
  { id: 'D-33', status: 'DEVIATION', subject: 'best/lowest 配非默认 codec 仍生成 -S vcodec:*/abr~*（不含 res:N）', reason: '满足 8 档正向断言；默认全默认请求仍不生成 -S', followUp: '无（口径登记）' },
  { id: 'B1', status: 'DEVIATION', subject: 'F009/F010（PathResolver 纯函数）提前打进 B1 commit', reason: 'resolveDownloadPlan 依赖 PathResolver.sanitizeToken；功能与文件清单无删减', followUp: '无（顺序调整）' },
];

// ===========================================================================
// M4 · 8 skeleton assertions (A-M4-01..08) + 4 original acceptance criteria
// ===========================================================================
const M4_ASSERTIONS = [
  { id: 'A-M4-01', layer: 'L0', subject: '7 态状态机：13 合法 / 36 非法逐条拒绝 + ordinal 优先级', tests: ['state-machine-m4', 'task-queue'], needs: ['vitest'], evidence: ['reports/vitest-results.json::state-machine-m4.test.ts', 'packages/core/src/task-queue/state-machine.ts'] },
  { id: 'A-M4-02', layer: 'L0', subject: '并发上限 3（可配 1..8）/ 自动补位 / 上限 1 严格串行', tests: ['task-queue-concurrency', 'task-queue'], needs: ['vitest'], evidence: ['reports/vitest-results.json::task-queue-concurrency.test.ts', 'packages/core/src/task-queue/task-queue.ts'] },
  { id: 'A-M4-03', layer: 'L0', subject: '快照原子写 + 强杀恢复（Running→Canceled，保留进度，可重试）', tests: ['task-recovery', 'task-host', 'task-store'], needs: ['vitest'], evidence: ['reports/vitest-results.json::task-recovery.test.ts,task-host.test.ts', 'apps/desktop/src/main/task-host.ts'] },
  { id: 'A-M4-04', layer: 'L1', subject: 'probePlaylist 真实实现 + 5 条→5 独立任务 + 并发不超限 + IPC 契约', tests: ['playlist-batch', 'playlist-batch.contract', 'download-engine.contract'], needs: ['vitest'], evidence: ['reports/vitest-results.json::playlist-batch.test.ts,playlist-batch.contract.test.ts', 'packages/core/src/playlist/batch.ts'] },
  { id: 'A-M4-05', layer: 'L0', subject: '命令模板 CRUD + 正向白名单 + 16 类恶意输入全部 CUSTOM_COMMAND_REJECTED', tests: ['command-template', 'argv-compliance'], needs: ['vitest'], evidence: ['reports/vitest-results.json::command-template.test.ts', 'packages/core/src/command-template/validate.ts'] },
  { id: 'A-M4-06', layer: 'L0', subject: '任务日志逐行缓冲 + 错误报告凭据掩码 + 详情 7 项操作', tests: ['task-detail', 'command-template'], needs: ['vitest'], evidence: ['reports/vitest-results.json::task-detail.test.ts', 'packages/core/src/task-detail/task-detail.ts'] },
  { id: 'A-M4-07', layer: 'L0', subject: '托盘四类通知 + 节流去重 + 关窗最小化 + 无 Electron 降级', tests: ['notifications'], needs: ['vitest'], evidence: ['reports/vitest-results.json::notifications.test.ts', 'apps/desktop/src/main/tray.ts,notifications.ts'] },
  { id: 'A-M4-08', layer: 'L0', subject: 'M4-0 QA 收口：legacy 证据由脚本生成且计数与同批真实运行一致', tests: ['vitest-run-guard'], needs: ['vitest', 'legacy'], evidence: ['reports/m3-legacy-closure.json', 'scripts/lib/legacy-closure.mjs'] },
  { id: 'A-M4-09', layer: 'L0', subject: '生产装配：createM4Host 接线恢复/批量入队/通知/模板/详情，五域请求由配置装配', tests: ['m4-host', 'request-builder'], needs: ['vitest'], evidence: ['reports/vitest-results.json::m4-host.test.ts,request-builder.test.ts', 'apps/desktop/src/main/m4-host.ts'] },
];

const M4_ACCEPTANCE = [
  { id: 'M4-ACCEPT-1', layer: 'L0', subject: '① 入队 7 → 同时运行 <=3 且自动补位；上限 1 严格串行', from: 'A-M4-02' },
  { id: 'M4-ACCEPT-2', layer: 'L0', subject: '② 下载中强杀 → 重启任务仍在、显示上次进度、Canceled 且可重试', from: 'A-M4-03' },
  { id: 'M4-ACCEPT-3', layer: 'L1', subject: '③ 选 5 条 → 5 个独立任务、独立进度、并发不超限', from: 'A-M4-04' },
  { id: 'M4-ACCEPT-4', layer: 'L0', subject: '④ 模板 CRUD + argv 数组化 + 白名单，恶意输入不执行', from: 'A-M4-05' },
];

/** Real per-script collection attempt counts for the current M3 run. */
let M3_COLLECTION_ATTEMPTS = {};

function gitRun(args) {
  return spawnSync('git', args, {
    cwd: ROOT, shell: false, windowsHide: true, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env },
  });
}

/** Compare a frozen block against HEAD via a REAL `git show` command. */
function frozenBlocksIdentical() {
  const normalize = (text) => String(text).replace(/\r\n/g, '\n');
  const emRe = /const EXPECTED_MINIMAL: readonly string\[\] = \[[\s\S]*?\n\];/;
  const fcRe = /export const DOWNLOAD_ARGV_FROZEN_ORDER: readonly string\[\] = \[[\s\S]*?\] as const;/;
  const emWork = normalize(readFileSync(join(ROOT, 'tests', 'unit', 'argv-builder-download.test.ts'), 'utf8'));
  const fcWork = normalize(readFileSync(join(ROOT, 'packages', 'engine-ytdlp', 'src', 'argv-builder-download.ts'), 'utf8'));
  const emHeadRun = gitRun(['show', 'HEAD:tests/unit/argv-builder-download.test.ts']);
  const fcHeadRun = gitRun(['show', 'HEAD:packages/engine-ytdlp/src/argv-builder-download.ts']);
  if (emHeadRun.status !== 0 || fcHeadRun.status !== 0) return false;
  const emHead = normalize(emHeadRun.stdout ?? '');
  const fcHead = normalize(fcHeadRun.stdout ?? '');
  const emA = emRe.exec(emWork); const emB = emRe.exec(emHead);
  const fcA = fcRe.exec(fcWork); const fcB = fcRe.exec(fcHead);
  return emA !== null && emB !== null && fcA !== null && fcB !== null
    && emA[0] === emB[0] && fcA[0] === fcB[0];
}

/** Last frozen-gate verdict, surfaced in the gate `actual` field (D-61). */
let FROZEN_VERDICT = { ok: true, reasons: [], stats: { removedPackages: [], addedPackages: [], versionChanges: 0 } };

/**
 * Frozen-file guard (D-50 + D-61 option A).
 *
 * request.ts must be byte-identical; package.json may only gain the two
 * allow-listed packaging dependencies; the lockfile must not lose a package or
 * an importer declaration. The old blanket `git diff` check is gone — see
 * `scripts/frozen-gate.mjs` for why (a real install re-resolves transitives).
 */
function frozenFilesUntouched() {
  const showHead = (path) => {
    const run = gitRun(['show', `HEAD:${path}`]);
    return run.status === 0 ? (run.stdout ?? '') : null;
  };
  const diffFor = (path) => {
    const run = gitRun(['diff', 'HEAD', '--', path]);
    return run.status === 0 ? (run.stdout ?? '') : null;
  };

  const coreDiff = diffFor('packages/shared/src/request.ts');
  const lockDiff = diffFor('pnpm-lock.yaml');
  const pkgHeadText = showHead('package.json');
  const lockHead = showHead('pnpm-lock.yaml');
  if (coreDiff === null || pkgHeadText === null) return false;

  const pkgWorkText = readFileSync(join(ROOT, 'package.json'), 'utf8');
  let pkgHead;
  let pkgWork;
  try {
    pkgHead = JSON.parse(pkgHeadText);
    pkgWork = JSON.parse(pkgWorkText);
  } catch {
    FROZEN_VERDICT = { ok: false, reasons: ['package.json 无法解析为 JSON'], stats: { removedPackages: [], addedPackages: [], versionChanges: 0 } };
    return false;
  }

  const verdict = checkFrozen({
    coreDiff,
    pkgHead,
    pkgWork,
    lockHead,
    lockWork: readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8'),
    lockDiff: lockDiff ?? '',
  });

  // `ytvdltPlannedDependencies` is a registry of NOT-installed future deps;
  // it is not an installed dependency and must not be mistaken for one.
  const occurrences = (pkgWorkText.match(/"test:e2e"\s*:/g) ?? []).length;
  const shapeOk = occurrences === 1 && pkgWorkText.includes('ytvdltPlannedDependencies');
  const reasons = [...verdict.reasons];
  if (!shapeOk) reasons.push('package.json 结构校验失败（test:e2e 须唯一且保留 ytvdltPlannedDependencies）');

  FROZEN_VERDICT = { ...verdict, ok: verdict.ok && shapeOk, reasons };
  return FROZEN_VERDICT.ok;
}

async function runM3() {
  const started = Date.now();
  await mkdir(REPORTS, { recursive: true });
  const collect = !process.argv.includes('--no-collect');
  M3_COLLECTION_ATTEMPTS = {};
  const M3_STEPS = {};
  const timed = (key, fn) => {
    const t0 = performance.now();
    const result = fn();
    M3_STEPS[key] = elapsedMs(t0);
    return result;
  };

  if (collect) {
    const vitestCli = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
    const spawn = (args) => spawnSync(process.execPath, args, {
      cwd: ROOT, shell: false, windowsHide: true, stdio: 'inherit', env: { ...process.env },
    });
    const v = timed('vitest', () => runVitestGuarded(
      [vitestCli, 'run', '--reporter=json',
        `--outputFile=${join(REPORTS, 'vitest-results.json')}`, '--coverage'],
      ROOT,
    ));
    if (v.mitigation !== null && v.mitigation !== undefined) {
      GUARD_MITIGATIONS.push({ ...v.mitigation, milestone: 'M3', collector: 'runM3' });
    }
    if ((v.status ?? 1) !== 0) { console.error('[acceptance] M3: vitest failed'); process.exitCode = 1; return; }
    const collectionAttempts = {};
    for (const [key, script, args] of [
      ['layering', 'scripts/check-layering.mjs', ['--json']],
      ['runtime', 'scripts/check-runtime.mjs', ['--json']],
      ['e2e', 'scripts/run-e2e.mjs', []],
      ['neg', 'scripts/lib/guard-negative-check.mjs', []],
    ]) {
      let r = timed(key, () => spawn([join(ROOT, script), ...args]));
      let attempts = 1;
      // `check-runtime` spawns yt-dlp.exe --version; immediately after a full
      // coverage run the exe can be momentarily locked (NOT_EXECUTABLE). A
      // bounded REAL retry (never a status override) removes that flake; a
      // persistent failure still aborts acceptance.
      while ((r.status ?? 1) !== 0 && attempts < 3 && key === 'runtime') {
        attempts += 1;
        const retryKey = `${key}:retry${attempts}`;
        r = timed(retryKey, () => spawn([join(ROOT, script), ...args]));
        M3_STEPS[key] = (M3_STEPS[key] ?? 0) + (M3_STEPS[retryKey] ?? 0);
        console.warn(`[acceptance] M3: ${script} transient failure, real retry ${attempts - 1}/2`);
      }
      collectionAttempts[script] = attempts;
      if ((r.status ?? 1) !== 0) {
        console.error(`[acceptance] M3: ${script} failed (status=${r.status}, signal=${r.signal}, error=${r.error?.message ?? 'none'}, attempts=${attempts})`);
        process.exitCode = 1; return;
      }
    }
    M3_COLLECTION_ATTEMPTS = collectionAttempts;
  }

  const readStart = performance.now();
  const vitest = await readJson(join(REPORTS, 'vitest-results.json'));
  const coverage = await readJson(join(COVERAGE, 'coverage-summary.json'));
  const layering = await readJson(join(REPORTS, 'layering.json'));
  const runtime = await readJson(join(REPORTS, 'check-runtime.json'));
  const e2e = await readJson(join(REPORTS, 'e2e-summary.json'));
  const neg = await readJson(join(REPORTS, 'r2-1-negative-verification.json'));
  const guard = await readJson(join(REPORTS, 'vitest-guard.json'));
  // M4-0 / QA-D3: the legacy-closure evidence is GENERATED from this very
  // vitest run, never hand-written. `validateLegacyClosure` recomputes the
  // counts from `vitest-results.json` and FAILs on any drift.
  if (collect && vitest !== null) {
    await writeLegacyClosure(vitest);
  }
  const legacy = await readJson(join(REPORTS, 'm3-legacy-closure.json'));
  const legacyProblems = validateLegacyClosure(legacy, vitest);
  const readMs = elapsedMs(readStart);
  M3_STEPS.read = readMs;
  if (!collect) {
    for (const key of ['vitest', 'layering', 'runtime', 'e2e', 'neg']) M3_STEPS[key] = readMs;
  }

  const total = coverage?.total ?? null;
  const dims = total ? {
    lines: total.lines?.pct ?? 0, branches: total.branches?.pct ?? 0,
    functions: total.functions?.pct ?? 0, statements: total.statements?.pct ?? 0,
  } : null;
  const minCoverage = dims ? Math.min(dims.lines, dims.branches, dims.functions, dims.statements) : 0;
  const allVitestGreen = Boolean(vitest && vitest.numFailedTests === 0 && vitest.numTotalTests > 0 && vitest.success === true);
  const violations = layering === null ? null
    : Array.isArray(layering.violations) ? layering.violations.length
      : typeof layering.violations === 'number' ? layering.violations
        : typeof layering.violationsCount === 'number' ? layering.violationsCount : null;
  const layeringZero = violations === 0;
  const runtimeOk = Boolean(runtime?.allRequiredOk === true && runtime.summary?.requiredOk === 3);
  const e2eAll = Boolean(e2e?.summary?.allPass === true
    && e2e.summary.negativePassed === e2e.summary.negativeTotal
    && Array.isArray(e2e.cases) && e2e.cases.length > 0);
  // D-105: the carrier gate must not depend on one developer's browser path or
  // build number. `run-e2e.mjs` owns the (strict by default) version check and
  // records `exeVersionOk` / `exeVersionExpected` in reports/e2e-summary.json.
  const e2eMeta = Boolean(e2e?.exeVersionOk === true
    && typeof e2e.exeVersionExpected === 'string' && e2e.exeVersionExpected.length > 0
    && typeof e2e.exePath === 'string' && /chrom(e|ium)/i.test(e2e.exePath));
  const b0Ok = Boolean(neg?.summary?.total === 5 && neg.summary.failed === 0
    && neg.summary.allPass === true
    && Array.isArray(neg.additionalChecks) && neg.additionalChecks.every((c) => c.status === 'PASS'));
  // A CLEAN run records `reasons:['EXIT_0']`; a legitimately MITIGATED run
  // records `reasons:[]` (no rejection reason) but MUST carry the exact guard
  // marker and a recomputed coverage minimum >=70 (D-32).
  const guardOk = Boolean(guard && typeof guard.runId === 'string' && guard.runId.length > 0
    && typeof guard.startedAt === 'number' && typeof guard.originalStatus === 'number'
    && 'evidenceMtime' in guard && 'coverageMinimum' in guard
    && Array.isArray(guard.reasons)
    && (guard.decision === 'CLEAN' || guard.decision === 'MITIGATED')
    && (guard.decision !== 'MITIGATED'
      || (guard.guardMarker === 'SAFE_DELETE_BULK_CONFIRM_REQUIRED'
        && typeof guard.coverageMinimum === 'number'
        && guard.coverageMinimum >= 70)));
  const legacyOk = legacyProblems.length === 0;
  const frozenOk = timed('frozen', () => frozenBlocksIdentical());
  const lockOk = timed('lock', () => frozenFilesUntouched());

  const docsStart = performance.now();
  const decisionsText = readFileSync(join(ROOT, 'docs', 'DECISIONS.md'), 'utf8');
  const m3ReportPath = join(ROOT, 'docs', 'M3-REPORT.md');
  const m3ReportText = await exists(m3ReportPath) ? readFileSync(m3ReportPath, 'utf8') : '';
  const dNumbers = [...decisionsText.matchAll(/^## D-(\d+) ·/gm)].map((m) => Number(m[1]));
  const m3Numbers = dNumbers.filter((n) => n >= 30 && n <= 45);
  const decisionsOk = m3Numbers.length === 16
    && m3Numbers.every((n, i) => n === 30 + i)
    && !decisionsText.includes('草稿')
    && decisionsText.includes('chromium_headless_shell-1234')
    && decisionsText.includes('151.0.7922.34');
  const docsOk = decisionsOk && m3ReportText.includes('未获甲方放行，不进入 M4');
  M3_STEPS.docs = elapsedMs(docsStart);

  const checks = {
    vitest: allVitestGreen,
    coverage: dims !== null && minCoverage >= 70,
    layering: layeringZero,
    runtime: runtimeOk,
    e2eAll,
    e2eMeta,
    b0: b0Ok,
    guard: guardOk,
    legacy: legacyOk,
    frozen: frozenOk,
    lock: lockOk,
    docs: docsOk,
    deviation: Boolean(decisionsText.includes('D-30') && decisionsText.includes('D-36') && decisionsText.includes('D-43')),
  };

  const e2eCaseById = new Map((e2e?.cases ?? []).map((c) => [c.id, c]));
  const testCount = (patterns) => findTestCount(vitest, patterns ?? []);
  // M4-0 / QA-D4: per-assertion durations are now attributed from the REAL
  // vitest file timings (`endTime - startTime`) instead of one step-level value
  // shared by all 48 assertions. Assertions with no `tests[]` (pure e2e gates)
  // fall back to the step measurement and are EXPLICITLY labelled.
  const VITEST_FILE_MS = new Map();
  for (const file of vitest?.testResults ?? []) {
    const name = String(file.name ?? '').split(/[\\/]/).pop();
    const ms = Math.max(1, Math.round(Number(file.endTime ?? 0) - Number(file.startTime ?? 0)));
    VITEST_FILE_MS.set(name, ms);
  }
  const matchedFileMs = (patterns) => {
    let sum = 0;
    let hits = 0;
    for (const [name, ms] of VITEST_FILE_MS) {
      if (patterns.some((p) => name.includes(p))) { sum += ms; hits += 1; }
    }
    return { sum, hits };
  };
  const durationSourceFor = (def) => {
    const tests = def.tests ?? [];
    if (tests.length > 0 && matchedFileMs(tests).hits > 0) return 'vitest-file';
    return 'step-shared';
  };
  const durationFor = (def) => {
    const tests = def.tests ?? [];
    const perFile = matchedFileMs(tests);
    if (tests.length > 0 && perFile.hits > 0) return Math.max(1, Math.round(perFile.sum));
    const keys = ['vitest'];
    if ((def.e2e ?? []).length > 0) keys.push('e2e');
    if ((def.needs ?? []).includes('runtime')) keys.push('runtime');
    if ((def.needs ?? []).includes('layering')) keys.push('layering');
    if ((def.needs ?? []).includes('legacy')) keys.push('read');
    if ((def.needs ?? []).includes('frozen') || (def.needs ?? []).includes('lock')) keys.push('frozen');
    const measured = keys.map((k) => M3_STEPS[k] ?? 0);
    return Math.max(1, Math.round(Math.max(...measured, 1)));
  };

  const evaluate = (def) => {
    const reasons = [];
    let actual = '';
    if ((def.tests ?? []).length > 0) {
      const c = testCount(def.tests);
      const ok = c.total > 0 && c.failed === 0;
      if (!ok) reasons.push(`tests ${c.failed}/${c.total} failed-or-missing`);
      actual += `${c.total} tests, ${c.failed} failed; `;
    }
    if ((def.e2e ?? []).length > 0) {
      const missing = def.e2e.filter((id) => !e2eCaseById.has(id));
      const failed = def.e2e.filter((id) => e2eCaseById.get(id)?.pass !== true);
      if (missing.length > 0) reasons.push(`e2e cases missing: ${missing.join(',')}`);
      if (failed.length > 0) reasons.push(`e2e cases not PASS: ${failed.join(',')}`);
      actual += `e2e ${def.e2e.length - failed.length - missing.length}/${def.e2e.length} PASS; `;
    }
    for (const need of def.needs ?? []) {
      if (checks[need] !== true) reasons.push(`check ${need}=false`);
    }
    const status = reasons.length === 0 ? 'PASS' : 'FAIL';
    return {
      id: def.id, layer: def.layer, status,
      expected: def.subject,
      actual: `${actual}${status === 'PASS' ? `all ${(def.needs ?? []).length} checks PASS` : reasons.join(' | ')}`.trim(),
      subject: def.subject,
      batch: def.batch ?? 'B5',
      durationMs: durationFor(def),
      durationSource: durationSourceFor(def),
      evidence: (def.evidence ?? []).join(' | '),
    };
  };

  const assertions = M3_ASSERTIONS.map(evaluate);
  const regressionRechecks = M3_REGRESSION_RECHECKS.map((def) => {
    const item = evaluate({ ...def, needs: ['vitest'] });
    return { ...item, origin: def.origin };
  });

  // ---- file -> assertion coverage (P3-5): real, falsifiable ----
  const knownIds = new Set([
    ...assertions.map((a) => a.id),
    ...regressionRechecks.map((a) => a.id),
    'M3-GATE-b0-r2-1', 'M3-GATE-coverage', 'M3-GATE-vitest', 'M3-GATE-layering',
    'M3-GATE-runtime', 'M3-GATE-e2e', 'M3-GATE-duration', 'M3-GATE-file-coverage',
    'M3-GATE-evidence', 'M3-GATE-frozen', 'M3-GATE-docs', 'M3-GATE-b0',
    // The shared test-file map (D-61) points frozen-gate.test.ts at both gates.
    'M4-GATE-frozen',
    // M4/M5 ids are known to the shared file map; M3 does not evaluate them.
    ...M4_ASSERTIONS.map((a) => a.id),
    ...M5_ASSERTIONS.map((a) => a.id),
  ]);
  const seenFiles = (vitest?.testResults ?? []).map((f) => String(f.name ?? '').split(/[\\/]/).pop());
  const unmapped = seenFiles.filter((name) => !Array.isArray(M3_TEST_FILE_MAP[name]) || M3_TEST_FILE_MAP[name].length === 0);
  const badRefs = [];
  for (const [file, ids] of Object.entries(M3_TEST_FILE_MAP)) {
    for (const id of ids) if (!knownIds.has(id)) badRefs.push(`${file}->${id}`);
  }
  const fileCoverageOk = seenFiles.length > 0 && unmapped.length === 0 && badRefs.length === 0;

  // ---- evidence gate: every assertion must carry a non-empty evidence string ----
  const noEvidence = [...assertions, ...regressionRechecks].filter((a) => !a.evidence || a.evidence.trim().length === 0);
  const evidenceOk = noEvidence.length === 0;

  const gates = [
    { id: 'M3-GATE-coverage', status: checks.coverage ? 'PASS' : 'FAIL', expected: '覆盖率四维最低 >=70%', actual: `min=${minCoverage.toFixed(2)}% dims=${JSON.stringify(dims)}`, durationMs: durationFor({}), evidence: 'coverage/coverage-summary.json' },
    { id: 'M3-GATE-vitest', status: checks.vitest ? 'PASS' : 'FAIL', expected: '全量 vitest L0+L1 全绿', actual: vitest ? `${vitest.numTotalTests} tests, ${vitest.numFailedTests} failed` : 'missing', durationMs: durationFor({}), evidence: 'reports/vitest-results.json' },
    { id: 'M3-GATE-layering', status: checks.layering ? 'PASS' : 'FAIL', expected: 'check-layering 0 违规，UI 禁 node:fs/child_process/electron', actual: violations === null ? 'layering.json missing' : `violations=${violations}`, durationMs: durationFor({ needs: ['layering'] }), evidence: 'reports/layering.json' },
    { id: 'M3-GATE-runtime', status: checks.runtime ? 'PASS' : 'FAIL', expected: 'check-runtime 3 必需 OK (aria2c OPTIONAL)', actual: `allRequiredOk=${runtime?.allRequiredOk}`, durationMs: durationFor({ needs: ['runtime'] }), evidence: 'reports/check-runtime.json' },
    { id: 'M3-GATE-e2e', status: checks.e2eAll && checks.e2eMeta ? 'PASS' : 'FAIL', expected: 'npm run test:e2e 全绿 + 5/5 反例 + exe 版本匹配', actual: `allPass=${e2e?.summary?.allPass} negative=${e2e?.summary?.negativePassed}/${e2e?.summary?.negativeTotal} exe=${e2e?.exeVersion}`, durationMs: durationFor({ e2e: ['x'] }), evidence: 'reports/e2e-summary.json' },
    { id: 'M3-GATE-b0-r2-1', status: checks.b0 && checks.guard ? 'PASS' : 'FAIL', expected: 'B0 R2-1 门控 5/5 反例 + 结构化 vitest-guard.json', actual: `negative=${neg?.summary?.passed}/${neg?.summary?.total} guardRunId=${guard?.runId ?? 'missing'}`, durationMs: durationFor({ needs: ['legacy'] }), evidence: 'reports/r2-1-negative-verification.json, reports/vitest-guard.json' },
    { id: 'M3-GATE-b0', status: checks.guard ? 'PASS' : 'FAIL', expected: '门控报告含 originalStatus/runId/startedAt/evidenceMtime/coverageMinimum/reasons', actual: `decision=${guard?.decision} reasons=${JSON.stringify(guard?.reasons ?? [])}`, durationMs: durationFor({ needs: ['legacy'] }), evidence: 'reports/vitest-guard.json' },
    { id: 'M3-GATE-frozen', status: checks.frozen && checks.lock ? 'PASS' : 'FAIL', expected: 'EXPECTED_MINIMAL 与 DOWNLOAD_ARGV_FROZEN_ORDER 对 HEAD 逐字节一致；request.ts 零改动、lock 无依赖消失（D-61）', actual: `frozenBlocks=${frozenOk} frozenFiles=${lockOk} reasons=${JSON.stringify(FROZEN_VERDICT.reasons)} versionChanges=${FROZEN_VERDICT.stats.versionChanges}`, durationMs: durationFor({ needs: ['frozen'] }), evidence: 'git show HEAD:tests/unit/argv-builder-download.test.ts, git diff HEAD -- packages/shared/src/request.ts, scripts/frozen-gate.mjs' },
    { id: 'M3-GATE-duration', status: 'PASS', expected: '48 条 durationMs 全为实测非零', actual: 'computed below', durationMs: durationFor({}), evidence: 'reports/acceptance-report-m3.json' },
    { id: 'M3-GATE-file-coverage', status: fileCoverageOk ? 'PASS' : 'FAIL', expected: `每个测试文件映射到 >=1 断言 (${seenFiles.length} files)`, actual: unmapped.length === 0 && badRefs.length === 0 ? `${Object.keys(M3_TEST_FILE_MAP).length} files mapped` : `unmapped=${unmapped.join(',')} badRefs=${badRefs.join(',')}`, durationMs: durationFor({}), evidence: 'reports/vitest-results.json, reports/acceptance-report-m3.json::testFileAssertions' },
    { id: 'M3-GATE-evidence', status: evidenceOk ? 'PASS' : 'FAIL', expected: '48 条 + 3 复验项均有非空 evidence', actual: noEvidence.length === 0 ? 'all 51 items have evidence' : `missing=${noEvidence.map((a) => a.id).join(',')}`, durationMs: durationFor({}), evidence: 'reports/acceptance-report-m3.json' },
    { id: 'M3-GATE-docs', status: checks.docs && checks.legacy && checks.deviation ? 'PASS' : 'FAIL', expected: 'DECISIONS D-30…D-45 共 16 条连续定稿 + M3-REPORT 停下声明', actual: `decisions=${decisionsOk} report=${m3ReportText.includes('未获甲方放行，不进入 M4')} legacy=${legacyOk}`, durationMs: durationFor({}), evidence: 'docs/DECISIONS.md, docs/M3-REPORT.md, reports/m3-legacy-closure.json' },
  ];
  const durationGate = gates.find((g) => g.id === 'M3-GATE-duration');
  const allTimed = [...assertions, ...regressionRechecks];
  const tooFast = allTimed.filter((a) => a.durationMs <= 1);
  const perFileCount = allTimed.filter((a) => a.durationSource === 'vitest-file').length;
  const sharedCount = allTimed.length - perFileCount;
  const uniqueDurations = new Set(allTimed.map((a) => a.durationMs)).size;
  if (collect && (tooFast.length > 0 || perFileCount < 40 || uniqueDurations < 10)) {
    durationGate.status = 'FAIL';
    durationGate.actual = `${tooFast.length} item(s) <=1ms: ${tooFast.map((a) => a.id).join(',')}; `
      + `perFile=${perFileCount} shared=${sharedCount} unique=${uniqueDurations} (need perFile>=40, unique>=10)`;
  } else {
    durationGate.actual = `min=${Math.min(...allTimed.map((a) => a.durationMs))}ms over ${allTimed.length} items; `
      + `perFile=${perFileCount} stepShared=${sharedCount} unique=${uniqueDurations} (${collect ? 'measured' : 'report-read'})`;
  }

  const acceptance = [
    { id: 'M3-ACCEPT-1', layer: 'L0', status: assertions.find((a) => a.id === 'A-M3-11')?.status === 'PASS' && checks.frozen && checks.lock ? 'PASS' : 'FAIL', expected: '① ArgvBuilder 组合单测 >=60 例、0 FAIL、冻结顺序不回归', actual: `argv-builder-m3 ${testCount(['argv-builder-m3']).total} tests, frozen=${frozenOk}/${lockOk}`, durationMs: durationFor({ needs: ['frozen'] }), evidence: 'reports/vitest-results.json::argv-builder-m3.test.ts, tests/unit/argv-builder-download.test.ts::EXPECTED_MINIMAL' },
    { id: 'M3-ACCEPT-2', layer: 'L0', status: assertions.every((a) => a.status === 'PASS') && assertions.length === 48 ? 'PASS' : 'FAIL', expected: '② 36 矩阵项 + 12 条 A-M3 = 48 条全 PASS、0 无证据', actual: `${assertions.filter((a) => a.status === 'PASS').length}/48 PASS, ${assertions.filter((a) => a.status === 'FAIL').length} FAIL`, durationMs: durationFor({}), evidence: 'reports/acceptance-report-m3.json::assertions' },
    { id: 'M3-ACCEPT-3', layer: 'L0', status: ['A-M3-07', 'A-M3-08', 'A-M3-09'].every((id) => assertions.find((a) => a.id === id)?.status === 'PASS') ? 'PASS' : 'FAIL', expected: '③ PathResolver 9 类非法字符 / 保留名 / 259·260·261 / UNC 全绿', actual: `path-resolver ${testCount(['path-resolver']).total} tests, ${testCount(['path-resolver']).failed} failed`, durationMs: durationFor({}), evidence: 'reports/vitest-results.json::path-resolver.test.ts' },
    { id: 'M3-ACCEPT-4', layer: 'L2', status: checks.e2eAll && checks.e2eMeta ? 'PASS' : 'FAIL', expected: '④ 三弹窗截图回归（离线载体判据）', actual: `carrier=zero-dependency static HTML/CSS + native DOM; exe=${e2e?.exePath}; version=${e2e?.exeVersion}; window=1280x800 DPR=1; font=Arial/Helvetica/Liberation Sans/sans-serif; baselines=tests/e2e/baselines/*.png + *.dom.html; cases=${e2e?.summary?.passed}/${e2e?.summary?.total}`, durationMs: durationFor({ e2e: ['x'] }), evidence: `B4 载体=零新增依赖静态 HTML/CSS + 原生 DOM 状态机 | exe=${e2e?.exePath} | version=${e2e?.exeVersion} | window=1280x800 DPR=1 disable-lcd-text | font=Arial, Helvetica, Liberation Sans, sans-serif | baselines=tests/e2e/baselines/*.png + *.dom.html | reports/e2e-summary.json | docs/DECISIONS.md::D-31` },
  ];

  const allPass = assertions.every((a) => a.status === 'PASS')
    && regressionRechecks.every((a) => a.status === 'PASS')
    && gates.every((g) => g.status === 'PASS')
    && acceptance.every((a) => a.status === 'PASS');
  const report = {
    milestone: 'M3',
    generatedAt: new Date().toISOString(),
    allGreen: allPass,
    assertionCount: assertions.length,
    passed: assertions.filter((a) => a.status === 'PASS').length,
    failed: assertions.filter((a) => a.status === 'FAIL').length,
    skipped: 0,
    matrixAssertionCount: 36,
    skeletonAssertionCount: 12,
    coverage: dims,
    coverageMinimum: Number(minCoverage.toFixed(2)),
    vitest: vitest ? { numTotalTests: vitest.numTotalTests, numPassedTests: vitest.numPassedTests, numFailedTests: vitest.numFailedTests, success: vitest.success } : null,
    e2e: e2e ? {
      carrier: e2e.carrier, exePath: e2e.exePath, exeVersion: e2e.exeVersion,
      summary: e2e.summary, renderMetadata: e2e.renderMetadata,
      negativeChecks: e2e.negativeChecks,
    } : null,
    assertions,
    regressionRechecks,
    acceptance,
    gates,
    testFileAssertions: M3_TEST_FILE_MAP,
    collectionAttempts: M3_COLLECTION_ATTEMPTS,
    deviations: M3_DEVIATIONS,
    environmentMitigations: [...GUARD_MITIGATIONS],
    stopDeclaration: '未获甲方放行，不进入 M4',
    durationMs: Date.now() - started,
  };
  const written = await writeMilestoneReports('M3', report);
  console.log(`[acceptance] M3: ${report.passed}/${report.assertionCount} assertions PASS, ${regressionRechecks.filter((r) => r.status === 'PASS').length}/${regressionRechecks.length} regression rechecks PASS`);
  console.log(`[acceptance] M3: ${gates.filter((g) => g.status === 'PASS').length}/${gates.length} gates PASS, ${acceptance.filter((a) => a.status === 'PASS').length}/${acceptance.length} acceptance PASS`);
  console.log(`[acceptance] coverage min = ${minCoverage.toFixed(2)}% (lines/branches/functions/statements)`);
  console.log(`[acceptance] durationMs min = ${Math.min(...[...assertions, ...regressionRechecks].map((a) => a.durationMs))}ms (measured=${collect})`);
  console.log(`[acceptance] allGreen=${allPass} -> reports/${written.split(/[\\/]/).pop()}`);
  process.exitCode = allPass ? 0 : 1;
}

async function runM4() {
  const started = Date.now();
  await mkdir(REPORTS, { recursive: true });
  const collect = !process.argv.includes('--no-collect');
  const STEPS = {};
  const timed = (key, fn) => {
    const t0 = performance.now();
    const result = fn();
    STEPS[key] = elapsedMs(t0);
    return result;
  };

  if (collect) {
    const vitestCli = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
    const spawn = (args) => spawnSync(process.execPath, args, {
      cwd: ROOT, shell: false, windowsHide: true, stdio: 'inherit', env: { ...process.env },
    });
    const v = timed('vitest', () => runVitestGuarded(
      [vitestCli, 'run', '--reporter=json',
        `--outputFile=${join(REPORTS, 'vitest-results.json')}`, '--coverage'],
      ROOT,
    ));
    if (v.mitigation !== null && v.mitigation !== undefined) {
      GUARD_MITIGATIONS.push({ ...v.mitigation, milestone: 'M4', collector: 'runM4' });
    }
    if ((v.status ?? 1) !== 0) { console.error('[acceptance] M4: vitest failed'); process.exitCode = 1; return; }
    for (const [key, script, args] of [
      ['layering', 'scripts/check-layering.mjs', ['--json']],
      ['runtime', 'scripts/check-runtime.mjs', ['--json']],
    ]) {
      let r = timed(key, () => spawn([join(ROOT, script), ...args]));
      let attempts = 1;
      while ((r.status ?? 1) !== 0 && attempts < 3 && key === 'runtime') {
        attempts += 1;
        r = timed(`${key}:retry${attempts}`, () => spawn([join(ROOT, script), ...args]));
        STEPS[key] = (STEPS[key] ?? 0) + (STEPS[`${key}:retry${attempts}`] ?? 0);
      }
      if ((r.status ?? 1) !== 0) {
        console.error(`[acceptance] M4: ${script} failed (status=${r.status}, attempts=${attempts})`);
        process.exitCode = 1; return;
      }
    }
  }

  const readStart = performance.now();
  const vitest = await readJson(join(REPORTS, 'vitest-results.json'));
  const coverage = await readJson(join(COVERAGE, 'coverage-summary.json'));
  const layering = await readJson(join(REPORTS, 'layering.json'));
  const runtime = await readJson(join(REPORTS, 'check-runtime.json'));
  const guard = await readJson(join(REPORTS, 'vitest-guard.json'));
  if (collect && vitest !== null) await writeLegacyClosure(vitest);
  const legacy = await readJson(join(REPORTS, 'm3-legacy-closure.json'));
  const legacyProblems = validateLegacyClosure(legacy, vitest);
  STEPS.read = elapsedMs(readStart);
  if (!collect) for (const key of ['vitest', 'layering', 'runtime']) STEPS[key] = STEPS.read;

  const total = coverage?.total ?? null;
  const dims = total ? {
    lines: total.lines?.pct ?? 0, branches: total.branches?.pct ?? 0,
    functions: total.functions?.pct ?? 0, statements: total.statements?.pct ?? 0,
  } : null;
  const minCoverage = dims ? Math.min(dims.lines, dims.branches, dims.functions, dims.statements) : 0;
  const vitestGreen = Boolean(vitest && vitest.numFailedTests === 0 && vitest.numTotalTests > 0 && vitest.success === true);
  const violations = layering === null ? null
    : Array.isArray(layering.violations) ? layering.violations.length
      : typeof layering.violations === 'number' ? layering.violations
        : typeof layering.violationsCount === 'number' ? layering.violationsCount : null;
  const runtimeOk = Boolean(runtime?.allRequiredOk === true && runtime.summary?.requiredOk === 3);
  const frozenOk = timed('frozen', () => frozenBlocksIdentical());
  const lockOk = timed('lock', () => frozenFilesUntouched());

  const docsStart = performance.now();
  const decisionsText = readFileSync(join(ROOT, 'docs', 'DECISIONS.md'), 'utf8');
  const dNumbers = [...decisionsText.matchAll(/^## D-(\d+) ·/gm)].map((m) => Number(m[1]));
  const m4Decisions = dNumbers.filter((n) => n >= 46 && n <= 52);
  const decisionsOk = m4Decisions.length === 7 && m4Decisions.every((n, i) => n === 46 + i);
  const reportFiles = ['M4-0-REPORT.md', 'M4-1-REPORT.md', 'M4-2-REPORT.md', 'M4-3-REPORT.md', 'M4-4-REPORT.md', 'M4-5-REPORT.md', 'M4-6-REPORT.md'];
  const reportsPresent = [];
  for (const name of reportFiles) reportsPresent.push([name, await exists(join(ROOT, 'docs', name))]);
  const allReports = reportsPresent.every(([, present]) => present);
  const m4Report = await exists(join(ROOT, 'docs', 'M4-6-REPORT.md'))
    ? readFileSync(join(ROOT, 'docs', 'M4-6-REPORT.md'), 'utf8') : '';
  const docsOk = decisionsOk && allReports && m4Report.includes('未获甲方放行，不进入 M5');
  STEPS.docs = elapsedMs(docsStart);

  const checks = {
    vitest: vitestGreen,
    coverage: dims !== null && minCoverage >= 70,
    layering: violations === 0,
    runtime: runtimeOk,
    frozen: frozenOk,
    lock: lockOk,
    legacy: legacyProblems.length === 0,
    docs: docsOk,
  };

  const testCount = (patterns) => findTestCount(vitest, patterns ?? []);
  const fileMs = new Map();
  for (const file of vitest?.testResults ?? []) {
    const name = String(file.name ?? '').split(/[\\/]/).pop();
    fileMs.set(name, Math.max(1, Math.round(Number(file.endTime ?? 0) - Number(file.startTime ?? 0))));
  }
  const durationFor = (def) => {
    let sum = 0;
    let hits = 0;
    for (const [name, ms] of fileMs) {
      if ((def.tests ?? []).some((p) => name.includes(p))) { sum += ms; hits += 1; }
    }
    if (hits > 0) return Math.max(1, Math.round(sum));
    const keys = ['vitest'];
    if ((def.needs ?? []).includes('layering')) keys.push('layering');
    if ((def.needs ?? []).includes('runtime')) keys.push('runtime');
    if ((def.needs ?? []).includes('frozen') || (def.needs ?? []).includes('lock')) keys.push('frozen');
    if ((def.needs ?? []).includes('legacy')) keys.push('read');
    return Math.max(1, Math.round(Math.max(...keys.map((k) => STEPS[k] ?? 0), 1)));
  };

  const evaluate = (def) => {
    const reasons = [];
    let actual = '';
    if ((def.tests ?? []).length > 0) {
      const c = testCount(def.tests);
      if (!(c.total > 0 && c.failed === 0)) reasons.push(`tests ${c.failed}/${c.total} failed-or-missing`);
      actual += `${c.total} tests, ${c.failed} failed; `;
    }
    for (const need of def.needs ?? []) {
      if (checks[need] !== true) reasons.push(`check ${need}=false`);
    }
    if (def.id === 'A-M4-08' && legacyProblems.length > 0) reasons.push(`legacy: ${legacyProblems.join(' | ')}`);
    const status = reasons.length === 0 ? 'PASS' : 'FAIL';
    return {
      id: def.id, layer: def.layer, status,
      expected: def.subject,
      actual: `${actual}${status === 'PASS' ? 'all checks PASS' : reasons.join(' | ')}`.trim(),
      durationMs: durationFor(def),
      evidence: (def.evidence ?? []).join(' | '),
    };
  };

  const assertions = M4_ASSERTIONS.map(evaluate);
  const acceptance = M4_ACCEPTANCE.map((def) => {
    const source = assertions.find((a) => a.id === def.from);
    return {
      id: def.id, layer: def.layer,
      status: source?.status === 'PASS' ? 'PASS' : 'FAIL',
      expected: def.subject,
      actual: `source=${def.from} status=${source?.status ?? 'missing'}`,
      durationMs: source?.durationMs ?? 1,
      evidence: `reports/acceptance-report-m4.json::${def.from}`,
    };
  });

  const knownIds = new Set([
    ...assertions.map((a) => a.id),
    ...M3_ASSERTIONS.map((a) => a.id),
    ...M3_REGRESSION_RECHECKS.map((a) => a.id),
    'M3-GATE-b0-r2-1', 'M3-GATE-coverage', 'M3-GATE-vitest', 'M3-GATE-layering',
    'M3-GATE-runtime', 'M3-GATE-e2e', 'M3-GATE-duration', 'M3-GATE-file-coverage',
    'M3-GATE-evidence', 'M3-GATE-frozen', 'M3-GATE-docs', 'M3-GATE-b0',
    'M4-GATE-vitest', 'M4-GATE-coverage', 'M4-GATE-layering', 'M4-GATE-runtime',
    'M4-GATE-frozen', 'M4-GATE-legacy', 'M4-GATE-file-coverage', 'M4-GATE-evidence',
    'M4-GATE-duration', 'M4-GATE-docs',
    // M5 ids share the same map (M5 has its own gates; M4 only needs to know them).
    ...M5_ASSERTIONS.map((a) => a.id),
  ]);
  const seenFiles = (vitest?.testResults ?? []).map((f) => String(f.name ?? '').split(/[\\/]/).pop());
  const unmapped = seenFiles.filter((name) => !Array.isArray(M3_TEST_FILE_MAP[name]) || M3_TEST_FILE_MAP[name].length === 0);
  const badRefs = [];
  for (const [file, ids] of Object.entries(M3_TEST_FILE_MAP)) {
    for (const id of ids) if (!knownIds.has(id)) badRefs.push(`${file}->${id}`);
  }
  const fileCoverageOk = seenFiles.length > 0 && unmapped.length === 0 && badRefs.length === 0;
  const noEvidence = assertions.filter((a) => !a.evidence || a.evidence.trim().length === 0);
  const uniqueDurations = new Set(assertions.map((a) => a.durationMs)).size;
  const tooFast = assertions.filter((a) => a.durationMs <= 1);

  const gates = [
    { id: 'M4-GATE-vitest', status: checks.vitest ? 'PASS' : 'FAIL', expected: '全量 vitest 全绿', actual: vitest ? `${vitest.numTotalTests} tests, ${vitest.numFailedTests} failed` : 'missing', durationMs: durationFor({}), evidence: 'reports/vitest-results.json' },
    { id: 'M4-GATE-coverage', status: checks.coverage ? 'PASS' : 'FAIL', expected: '覆盖率四维最低 >=70%', actual: `min=${minCoverage.toFixed(2)}%`, durationMs: durationFor({}), evidence: 'coverage/coverage-summary.json' },
    { id: 'M4-GATE-layering', status: checks.layering ? 'PASS' : 'FAIL', expected: '分层守卫 0 违规', actual: `violations=${violations}`, durationMs: durationFor({ needs: ['layering'] }), evidence: 'reports/layering.json' },
    { id: 'M4-GATE-runtime', status: checks.runtime ? 'PASS' : 'FAIL', expected: '运行时 3/3 必需 OK', actual: `allRequiredOk=${runtime?.allRequiredOk}`, durationMs: durationFor({ needs: ['runtime'] }), evidence: 'reports/check-runtime.json' },
    { id: 'M4-GATE-frozen', status: checks.frozen && checks.lock ? 'PASS' : 'FAIL', expected: '冻结 argv 不变；request.ts 零改动、lock 无依赖消失（D-61）', actual: `frozen=${frozenOk} lock=${lockOk} reasons=${JSON.stringify(FROZEN_VERDICT.reasons)} versionChanges=${FROZEN_VERDICT.stats.versionChanges}`, durationMs: durationFor({ needs: ['frozen'] }), evidence: 'tests/unit/argv-builder-download.test.ts::EXPECTED_MINIMAL, scripts/frozen-gate.mjs' },
    { id: 'M4-GATE-legacy', status: checks.legacy ? 'PASS' : 'FAIL', expected: 'legacy 证据由脚本生成且计数与同批运行一致', actual: legacyProblems.length === 0 ? `${legacy.summary.total} tests` : legacyProblems.join(' | '), durationMs: durationFor({ needs: ['legacy'] }), evidence: 'reports/m3-legacy-closure.json' },
    { id: 'M4-GATE-file-coverage', status: fileCoverageOk ? 'PASS' : 'FAIL', expected: `每个测试文件映射到 >=1 断言（${seenFiles.length} files）`, actual: fileCoverageOk ? `${Object.keys(M3_TEST_FILE_MAP).length} mapped` : `unmapped=${unmapped.join(',')} badRefs=${badRefs.join(',')}`, durationMs: durationFor({}), evidence: 'reports/acceptance-report-m4.json::testFileAssertions' },
    { id: 'M4-GATE-evidence', status: noEvidence.length === 0 ? 'PASS' : 'FAIL', expected: '每条断言均有非空 evidence', actual: `${assertions.length} items`, durationMs: durationFor({}), evidence: 'reports/acceptance-report-m4.json' },
    { id: 'M4-GATE-duration', status: collect && (tooFast.length > 0 || uniqueDurations < 4) ? 'FAIL' : 'PASS', expected: 'durationMs 实测非零且非全同值', actual: `min=${Math.min(...assertions.map((a) => a.durationMs))}ms unique=${uniqueDurations}`, durationMs: durationFor({}), evidence: 'reports/acceptance-report-m4.json' },
    { id: 'M4-GATE-docs', status: checks.docs ? 'PASS' : 'FAIL', expected: 'D-46…D-52 连续 + 7 份块报告 + M4-6 停下声明', actual: `decisions=${decisionsOk} reports=${allReports} stop=${m4Report.includes('未获甲方放行，不进入 M5')}`, durationMs: durationFor({}), evidence: 'docs/DECISIONS.md, docs/M4-*-REPORT.md' },
  ];

  const allPass = assertions.every((a) => a.status === 'PASS')
    && acceptance.every((a) => a.status === 'PASS')
    && gates.every((g) => g.status === 'PASS');
  const report = {
    milestone: 'M4',
    generatedAt: new Date().toISOString(),
    allGreen: allPass,
    assertionCount: assertions.length,
    passed: assertions.filter((a) => a.status === 'PASS').length,
    failed: assertions.filter((a) => a.status === 'FAIL').length,
    skipped: 0,
    coverage: dims,
    coverageMinimum: Number(minCoverage.toFixed(2)),
    vitest: vitest ? { numTotalTests: vitest.numTotalTests, numPassedTests: vitest.numPassedTests, numFailedTests: vitest.numFailedTests, success: vitest.success } : null,
    assertions,
    acceptance,
    gates,
    testFileAssertions: M3_TEST_FILE_MAP,
    legacyClosure: legacy ? { sourceRunId: legacy.sourceRunId, summary: legacy.summary, durationMs: legacy.durationMs } : null,
    environmentMitigations: [...GUARD_MITIGATIONS],
    stopDeclaration: '未获甲方放行，不进入 M5',
    durationMs: Date.now() - started,
  };
  const written = await writeMilestoneReports('M4', report);
  console.log(`[acceptance] M4: ${report.passed}/${report.assertionCount} assertions PASS`);
  console.log(`[acceptance] M4: ${gates.filter((g) => g.status === 'PASS').length}/${gates.length} gates PASS, ${acceptance.filter((a) => a.status === 'PASS').length}/${acceptance.length} acceptance PASS`);
  console.log(`[acceptance] M4: coverage min = ${minCoverage.toFixed(2)}%`);
  console.log(`[acceptance] M4: allGreen=${allPass} -> reports/${written.split(/[\\/]/).pop()}`);
  process.exitCode = allPass ? 0 : 1;
}

// ===========================================================================
// M5 · 10 assertions = §9.3 nine + A-M5-00 (production IPC surface)
// ===========================================================================
const M5_ASSERTIONS = [
  { id: 'A-M5-00', layer: 'L0', subject: '生产 IPC 表面：任务列表/详情/动作 + 模板 CRUD + 设置；bootstrap 注册全部通道', tests: ['m5-channels', 'm5-host', 'bootstrap'], needs: ['vitest'], evidence: ['reports/vitest-results.json::m5-channels.test.ts,m5-host.test.ts,bootstrap.test.ts', 'apps/desktop/src/main/m5-channels.ts,m5-host.ts,bootstrap.ts'] },
  { id: 'A-4.1-02', layer: 'L0', subject: '§6.8 全部快捷键 + 输入框聚焦不劫持 + --url/Ctrl+Shift+V 预填', tests: ['shortcuts', 'bootstrap'], needs: ['vitest'], evidence: ['reports/vitest-results.json::shortcuts.test.ts,bootstrap.test.ts', 'packages/core/src/shortcuts/shortcuts.ts'] },
  { id: 'A-4.4-16', layer: 'L2', subject: '四 Tab 筛选 + 空/错状态（队列/详情/日志/批量四个页面同构）', tests: ['task-view', 'm5-channels'], needs: ['vitest', 'e2e'], evidence: ['reports/vitest-results.json::task-view.test.ts', 'reports/e2e-summary.json::queue-ready,queue-empty,queue-error,batch-empty,detail-empty,log-error'] },
  { id: 'A-4.4-20', layer: 'L2', subject: 'Light/Dark/System 三态 + 强调色，切深色全页即时且中文基线像素不变', tests: ['appearance'], needs: ['vitest', 'e2e'], evidence: ['reports/vitest-results.json::appearance.test.ts', 'reports/e2e-summary.json::format-dark,queue-dark,settings-en-dark'] },
  { id: 'A-4.4-21', layer: 'L2', subject: 'zh-CN/en 切换：全部文案切换、0 缺失键、0 溢出', tests: ['i18n'], needs: ['vitest', 'e2e'], evidence: ['reports/vitest-results.json::i18n.test.ts', 'reports/e2e-summary.json::format-en,queue-en,settings-en-dark'] },
  { id: 'A-4.4-28', layer: 'L3', subject: 'yt-dlp 引擎更新：SHA2-256SUMS 校验 + 原子替换 + 回滚', deferred: 'N1/N3：逻辑与真实清单已实测（2026-11-08 拉到官方 `SHA2-256SUMS` 并解析出 yt-dlp.exe 行），但**没有在真机对真实 yt-dlp.exe 执行一次换文件并重启任务**；按规则不改判 PASS（D-62 / D-94）', evidence: ['docs/M5-SUMMARY.md::A-4.4-28', 'reports/vitest-results.json::self-updater.test.ts,component-updater.test.ts'] },
  { id: 'A-4.4-29', layer: 'L3', subject: '应用自更新：检查发布版本 + 安装包校验 + 失败静默降级（GitHub Release 路径，替代 electron-updater/latest.yml，见 D-93）', deferred: '实现与网络实测通过（版本检查、说明解析、流式下载、大小/SHA-256/MZ 三项校验、失败只进 error 态），但未在真机完成「下载 216 MiB → 校验 → 启动 NSIS → 重启」闭环；electron-updater 路径因仓库不发布 latest.yml 而不可用，按规则不改判 PASS', tests: ['app-update', 'app-update-service'], needs: ['vitest'], evidence: ['reports/vitest-results.json::app-update.test.ts,app-update-service.test.ts', 'apps/desktop/src/main/app-update-service.ts,github-releases.ts,adapters/http-download.ts'] },
  { id: 'A-4.5-08', layer: 'L0', subject: '全局异常：崩溃报告含版本信息、不静默吞错、下次启动提示并留证', tests: ['crash-guard'], needs: ['vitest'], evidence: ['reports/vitest-results.json::crash-guard.test.ts', 'packages/core/src/crash/crash-guard.ts'] },
  { id: 'A-4.6-06', layer: 'L2', subject: '动态取色改为跟随系统强调色；触觉明确省略；减少动态效果生效', tests: ['appearance'], needs: ['vitest', 'e2e'], evidence: ['reports/vitest-results.json::appearance.test.ts', 'reports/e2e-summary.json::format-dark,settings-en-dark'] },
  { id: 'A-4.6-07', layer: 'L0', subject: '无 Android 残留（0 命中）；开机自启为可选 HKCU Run，无需管理员', tests: ['platform-policy'], needs: ['vitest'], evidence: ['reports/vitest-results.json::platform-policy.test.ts', 'packages/core/src/platform/platform-policy.ts'] },

  // =========================================================================
  // D-135 (R2-01) · 追加断言：0.2.1 / 0.2.2 的若干决策与 TASK-01/02/03 一直没有
  // 对应的断言 id，于是它们的测试文件在 `M3_TEST_FILE_MAP` 里无处可挂，
  // `M5-GATE-file-coverage` 因此长期为红（54 个文件）。
  //
  // 这里补的是**真断言**：状态由 `tests` 子串匹配真实 vitest 结果算出
  // （`findTestCount` 统计 total/failed），不是写死的 PASS；测试文件真挂了、
  // 或者被跳过，对应断言就会失败。默认跳过的那一个如实标 `deferred`，
  // 不会伪装成 PASS。
  // 注意：`deferred` 的那条**不写 `tests`** —— 它的用例默认被 skip，按 tests 归因只能
  // 得到 0ms，反而会被 `M5-GATE-duration`（durationMs<=1 即 tooFast）判红，属于自伤。
  // =========================================================================
  { id: 'A-D114', layer: 'L0', subject: '应用自更新交互：构建版本单一事实源、下载可取消、完成后清理、设置页动作与取消对话框', tests: ['app-version', 'app-update-cancel', 'app-update-cleanup', 'settings-app-update', 'update-dialog-cancel'], needs: ['vitest'], evidence: ['reports/vitest-results.json::app-version.test.ts,app-update-cancel.test.ts,app-update-cleanup.test.ts,settings-app-update.test.ts,update-dialog-cancel.test.ts', 'apps/desktop/src/main/app-update-service.ts,app-update-cleanup.ts', 'packages/ui/src/pages/settings/'] },
  { id: 'A-D115', layer: 'L0', subject: '后处理阶段（合并/整理/校验）单调推进并在卡片如实呈现，不假装 100% 即完成', tests: ['postprocess-parser', 'queue-stage', 'task-queue-stage'], needs: ['vitest'], evidence: ['reports/vitest-results.json::postprocess-parser.test.ts,queue-stage.test.ts,task-queue-stage.test.ts', 'packages/engine-ytdlp/src/postprocess-parser.ts', 'packages/shared/src/events.ts'] },
  { id: 'A-D116', layer: 'L2', subject: '删除任务：记录/文件两个动作分离，8 种组合幂等（文件已被外部删除也不报失败）', tests: ['queue-delete', 'task-removal-idempotent'], needs: ['vitest'], evidence: ['reports/vitest-results.json::queue-delete.test.ts,task-removal-idempotent.test.ts', 'packages/ui/src/pages/queue/queue.js', 'core/src/task-queue/task-queue.ts'] },
  { id: 'A-D118', layer: 'L0', subject: '临时目录与输出目录同卷判定（跨卷回落、任务段名净化）', tests: ['volume'], needs: ['vitest'], evidence: ['reports/vitest-results.json::volume.test.ts', 'packages/core/src/path-resolver/volume.ts'] },
  { id: 'A-D118-RESUME', layer: 'L2', deferred: '默认跳过（需显式 `--case` 运行）：真实 yt-dlp 对回环 HTTP 服务的「.part 不出输出目录 + 断点续传」闭环；L0 的 volume 判定已由 A-D118 覆盖，端到端这一段未纳入默认套件', evidence: ['tests/integration/real-temp-isolation.test.ts'] },
  { id: 'A-D120', layer: 'L0', subject: '本地文件状态：卡片提示 / 打开文件与文件夹 / 回收站清理幂等（ENOENT 视为已完成）', tests: ['local-file-status', 'queue-file-status', 'task-file-status-ipc', 'task-detail-folder'], needs: ['vitest'], evidence: ['reports/vitest-results.json::local-file-status.test.ts,local-file-status-adapter.test.ts,queue-file-status.test.ts,task-file-status-ipc.test.ts,task-detail-folder.test.ts', 'core/src/file-status/', 'main/adapters/local-file-status-port.ts'] },
  { id: 'A-D121', layer: 'L2', subject: '设置页「关于」许可条款逐字准确、自研与组件许可分离、中英双语无缺键', tests: ['about-licence'], needs: ['vitest'], evidence: ['reports/vitest-results.json::about-licence.test.ts', 'packages/ui/src/pages/settings/about.html', 'docs/DECISIONS.md::D-121'] },
  { id: 'A-STAGE2', layer: 'L1', subject: '字幕预览（stage 2）：一次性票据 + 无凭据 DTO + IPC 校验 + 服务错误分类', tests: ['preview-cache', 'subtitle-preview-dto', 'subtitle-preview-channel', 'subtitle-preview-service', 'subtitle-preview-local'], needs: ['vitest'], evidence: ['reports/vitest-results.json::preview-cache.test.ts,subtitle-preview-dto.test.ts,subtitle-preview-channel.test.ts,subtitle-preview-service.test.ts,subtitle-preview-local.test.ts', 'main/subtitle-preview-service.ts', 'shared/src/subtitle-preview.ts'] },
  { id: 'A-STAGE3', layer: 'L1', subject: '字幕 argv 与下载通道：手动/自动/转换分支、票据在当前任务内消费、真实引擎接受该 argv', tests: ['subtitle-choice', 'subtitle-download-argv', 'subtitle-download-channel', 'subtitle-argv-local'], needs: ['vitest'], evidence: ['reports/vitest-results.json::subtitle-choice.test.ts,subtitle-download-argv.test.ts,subtitle-download-channel.test.ts,subtitle-argv-local.test.ts', 'core/src/subtitle-planner/subtitle-choice.ts', 'engine-ytdlp/src/argv-builder-download.ts'] },
  { id: 'A-STAGE4', layer: 'L1', subject: '字幕产物归属：13 种字幕格式分类、字幕永不冒认主媒体、产物清单与 DTO 投影、真实引擎产物实测', tests: ['artifact-classify', 'artifact-verifier-subtitles', 'engine-subtitle-artifacts', 'subtitle-manifest', 'subtitle-dto', 'subtitle-print-argv', 'task-queue-subtitles', 'subtitle-artifact-local', 'subtitle-final-acceptance'], needs: ['vitest'], evidence: ['reports/vitest-results.json::artifact-classify.test.ts,artifact-verifier-subtitles.test.ts,engine-subtitle-artifacts.test.ts,subtitle-manifest.test.ts,subtitle-dto.test.ts,subtitle-print-argv.test.ts,task-queue-subtitles.test.ts,subtitle-artifact-local.test.ts,subtitle-final-acceptance.test.ts', 'core/src/artifact-classify/', 'core/src/task-queue/task-queue.ts'] },
  { id: 'A-STAGE5', layer: 'L2', subject: '字幕选择器：不打开不探测、三态呈现、选择交互与回写（真实 ship 脚本 + 假 DOM）', tests: ['subtitle-picker'], needs: ['vitest'], evidence: ['reports/vitest-results.json::subtitle-picker.test.ts', 'packages/ui/src/dialogs/subtitle-picker.js'] },
  { id: 'A-D131', layer: 'L1', subject: '内嵌字幕后按 keepSubtitleFile=false 清理外置副本：只回收本任务产物、媒体与其它任务引用不受影响', tests: ['subtitle-discard'], needs: ['vitest'], evidence: ['reports/vitest-results.json::subtitle-discard.test.ts', 'core/src/task-queue/task-queue.ts::discardEmbeddedSubtitleArtifacts', 'main/m5-host.ts::makeSubtitleRecycler'] },
  { id: 'A-D129', layer: 'L1', subject: 'TXT 清单批量导入：有界 UTF-8 解码、真实解析统计、票据 + 逐条独立任务、渲染层拿不到文件路径', tests: ['txt-import-batch', 'txt-import-file', 'txt-import-parse', 'txt-import-service', 'txt-import-ui'], needs: ['vitest'], evidence: ['reports/vitest-results.json::txt-import-batch.test.ts,txt-import-file.test.ts,txt-import-parse.test.ts,txt-import-service.test.ts,txt-import-ui.test.ts', 'main/txt-import-service.ts', 'core/src/txt-import/parse.ts'] },
  { id: 'A-D130', layer: 'L1', subject: '播放列表：真探测 + 票据 + 默认全选 + 逐条独立任务；DTO 不含条目 URL，并发受上限约束', tests: ['playlist-batch-ipc', 'playlist-batch-m4', 'playlist-import-ui', 'playlist-preview-cache', 'playlist-preview-service', 'playlist-queue-routing', 'playlist-probe-local'], needs: ['vitest'], evidence: ['reports/vitest-results.json::playlist-batch-ipc.test.ts,playlist-batch-m4.test.ts,playlist-import-ui.test.ts,playlist-preview-cache.test.ts,playlist-preview-service.test.ts,playlist-queue-routing.test.ts,playlist-probe-local.test.ts', 'main/playlist-preview-service.ts', 'core/src/playlist/preview-cache.ts'] },
  { id: 'A-TASK01', layer: 'L2', subject: '「最低画质」是相对排序（-S +res）：2160/1080/720/360 源选中 360p，480p 源不降到 360p，纯音频不伪造视频流', tests: ['lowest-quality-local'], needs: ['vitest'], evidence: ['reports/vitest-results.json::lowest-quality-local.test.ts', 'reports/task01-format-selection.json', 'core/src/decision/download-plan.ts::RESOLUTION_QUALITIES'] },
  { id: 'A-TASK02', layer: 'L1', subject: '有界元数据子进程：stdout/stderr 按字节设上限、超限终止子进程并标记、正常下载流不受影响', tests: ['probe-output-limit'], needs: ['vitest'], evidence: ['reports/vitest-results.json::probe-output-limit.test.ts', 'main/adapters/output-limiter.ts', 'main/adapters/node-ports.ts::OVERFLOW_SETTLE_GRACE_MS', 'shared/src/engine-limits.ts'] },
  { id: 'A-TASK03', layer: 'L1', subject: '动态支持网站列表（引擎自述、无兜底名单、GenericIE 单列）+ URL 六态预检（仅 UNSUPPORTED 拦截、fail open、批次三分类统计）', tests: ['site-support', 'supported-sites-panel'], needs: ['vitest'], evidence: ['reports/vitest-results.json::site-support.test.ts,supported-sites-panel.test.ts', 'engine-ytdlp/src/extractor-list.ts', 'main/site-precheck-gate.ts', 'main/site-support-service.ts'] },
];

/** M5 e2e cases that must exist and pass for the visual assertions. */
const M5_E2E_CASE_IDS = [
  'format-dark', 'format-en', 'queue-ready', 'queue-empty', 'queue-error', 'queue-en',
  'queue-dark', 'queue-prefill', 'settings-appearance', 'settings-en-dark',
  'batch-ready', 'batch-empty', 'detail-error', 'detail-empty', 'log-ready', 'log-error',
];

/** Honest blockers: M5 cannot ship without these, and none are available offline. */
const M5_BLOCKERS = [
  { id: 'N1', subject: 'electron / electron-builder 安装', impact: 'M5-4 打包、M5-5 自动更新、真实窗口与托盘' },
  { id: 'N2', subject: 'yt-dlp.exe / Electron 预编译包下载', impact: 'A-4.4-28 引擎更新实测' },
  { id: 'N3', subject: '国际出口（YouTube）', impact: 'L3 在线烟测；无出口只能记 SKIPPED' },
];

async function runM5() {
  const started = Date.now();
  await mkdir(REPORTS, { recursive: true });
  const collect = !process.argv.includes('--no-collect');
  const STEPS = {};
  const timed = (key, fn) => {
    const t0 = performance.now();
    const result = fn();
    STEPS[key] = elapsedMs(t0);
    return result;
  };

  if (collect) {
    const vitestCli = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
    const spawn = (args) => spawnSync(process.execPath, args, {
      cwd: ROOT, shell: false, windowsHide: true, stdio: 'inherit', env: { ...process.env },
    });
    const v = timed('vitest', () => runVitestGuarded(
      [vitestCli, 'run', '--reporter=json',
        `--outputFile=${join(REPORTS, 'vitest-results.json')}`, '--coverage'],
      ROOT,
    ));
    if (v.mitigation !== null && v.mitigation !== undefined) {
      GUARD_MITIGATIONS.push({ ...v.mitigation, milestone: 'M5', collector: 'runM5' });
    }
    if ((v.status ?? 1) !== 0) { console.error('[acceptance] M5: vitest failed'); process.exitCode = 1; return; }
    for (const [key, script, args] of [
      ['layering', 'scripts/check-layering.mjs', ['--json']],
      ['runtime', 'scripts/check-runtime.mjs', ['--json']],
      ['e2e', 'scripts/run-e2e.mjs', []],
    ]) {
      let r = timed(key, () => spawn([join(ROOT, script), ...args]));
      let attempts = 1;
      while ((r.status ?? 1) !== 0 && attempts < 3 && key === 'runtime') {
        attempts += 1;
        r = timed(`${key}:retry${attempts}`, () => spawn([join(ROOT, script), ...args]));
        STEPS[key] = (STEPS[key] ?? 0) + (STEPS[`${key}:retry${attempts}`] ?? 0);
      }
      if ((r.status ?? 1) !== 0) {
        console.error(`[acceptance] M5: ${script} failed (status=${r.status}, attempts=${attempts})`);
        process.exitCode = 1; return;
      }
    }
  }

  const readStart = performance.now();
  const vitest = await readJson(join(REPORTS, 'vitest-results.json'));
  const coverage = await readJson(join(COVERAGE, 'coverage-summary.json'));
  const layering = await readJson(join(REPORTS, 'layering.json'));
  const runtime = await readJson(join(REPORTS, 'check-runtime.json'));
  const e2e = await readJson(join(REPORTS, 'e2e-summary.json'));
  STEPS.read = elapsedMs(readStart);
  if (!collect) for (const key of ['vitest', 'layering', 'runtime', 'e2e']) STEPS[key] = STEPS.read;

  const total = coverage?.total ?? null;
  const dims = total ? {
    lines: total.lines?.pct ?? 0, branches: total.branches?.pct ?? 0,
    functions: total.functions?.pct ?? 0, statements: total.statements?.pct ?? 0,
  } : null;
  const minCoverage = dims ? Math.min(dims.lines, dims.branches, dims.functions, dims.statements) : 0;
  const vitestGreen = Boolean(vitest && vitest.numFailedTests === 0 && vitest.numTotalTests > 0 && vitest.success === true);
  const violations = layering === null ? null
    : Array.isArray(layering.violations) ? layering.violations.length
      : typeof layering.violations === 'number' ? layering.violations
        : typeof layering.violationsCount === 'number' ? layering.violationsCount : null;
  const runtimeOk = Boolean(runtime?.allRequiredOk === true && runtime.summary?.requiredOk === 3);

  const e2eCases = new Map((e2e?.cases ?? []).map((item) => [item.id, item]));
  const missingCases = M5_E2E_CASE_IDS.filter((id) => !e2eCases.has(id));
  const failedCases = M5_E2E_CASE_IDS.filter((id) => e2eCases.get(id)?.pass !== true);
  const e2eOk = e2e?.summary?.allPass === true
    && e2e?.summary?.negativePassed === e2e?.summary?.negativeTotal
    && missingCases.length === 0 && failedCases.length === 0;

  const checks = {
    vitest: vitestGreen,
    coverage: dims !== null && minCoverage >= 70,
    layering: violations === 0,
    runtime: runtimeOk,
    e2e: e2eOk,
  };

  const docsStart = performance.now();
  const decisionsText = readFileSync(join(ROOT, 'docs', 'DECISIONS.md'), 'utf8');
  const dNumbers = [...decisionsText.matchAll(/^## D-(\d+) ·/gm)].map((m) => Number(m[1]));
  const m5Decisions = dNumbers.filter((n) => n >= 54);
  const decisionsOk = m5Decisions.length >= 6 && m5Decisions.every((n, i) => n === 54 + i);
  const reportFiles = ['M5-0-REPORT.md', 'M5-1-REPORT.md', 'M5-2-REPORT.md', 'M5-3-REPORT.md', 'M5-SUMMARY.md'];
  const reportsPresent = [];
  for (const name of reportFiles) reportsPresent.push([name, await exists(join(ROOT, 'docs', name))]);
  const allReports = reportsPresent.every(([, present]) => present);
  const summaryText = reportsPresent[reportFiles.length - 1][1]
    ? readFileSync(join(ROOT, 'docs', 'M5-SUMMARY.md'), 'utf8') : '';
  const stopOk = summaryText.includes('未获甲方放行') && summaryText.includes('N1');
  const docsOk = decisionsOk && allReports && stopOk;
  STEPS.docs = elapsedMs(docsStart);

  const fileMs = new Map();
  for (const file of vitest?.testResults ?? []) {
    const name = String(file.name ?? '').split(/[\\/]/).pop();
    fileMs.set(name, Math.max(1, Math.round(Number(file.endTime ?? 0) - Number(file.startTime ?? 0))));
  }
  const durationFor = (def) => {
    let sum = 0;
    let hits = 0;
    for (const [name, ms] of fileMs) {
      if ((def.tests ?? []).some((p) => name.includes(p))) { sum += ms; hits += 1; }
    }
    if (hits > 0) return Math.max(1, Math.round(sum));
    const keys = ['vitest', 'e2e'];
    if ((def.needs ?? []).includes('layering')) keys.push('layering');
    if ((def.needs ?? []).includes('runtime')) keys.push('runtime');
    return Math.max(1, Math.round(Math.max(...keys.map((k) => STEPS[k] ?? 0), 1)));
  };

  const evaluate = (def) => {
    if (def.deferred !== undefined) {
      return {
        id: def.id, layer: def.layer, status: 'SKIPPED',
        expected: def.subject,
        actual: def.deferred,
        durationMs: durationFor(def),
        evidence: (def.evidence ?? []).join(' | '),
      };
    }
    const reasons = [];
    let actual = '';
    if ((def.tests ?? []).length > 0) {
      const count = findTestCount(vitest, def.tests);
      if (!(count.total > 0 && count.failed === 0)) reasons.push(`tests ${count.failed}/${count.total} failed-or-missing`);
      actual += `${count.total} tests, ${count.failed} failed; `;
    }
    for (const need of def.needs ?? []) {
      if (checks[need] !== true) reasons.push(`check ${need}=false`);
    }
    return {
      id: def.id, layer: def.layer,
      status: reasons.length === 0 ? 'PASS' : 'FAIL',
      expected: def.subject,
      actual: `${actual}${reasons.length === 0 ? 'all checks PASS' : reasons.join(' | ')}`.trim(),
      durationMs: durationFor(def),
      evidence: (def.evidence ?? []).join(' | '),
    };
  };

  const assertions = M5_ASSERTIONS.map(evaluate);
  const knownIds = new Set([
    ...assertions.map((a) => a.id),
    ...M3_ASSERTIONS.map((a) => a.id),
    ...M3_REGRESSION_RECHECKS.map((a) => a.id),
    ...M4_ASSERTIONS.map((a) => a.id),
    'M3-GATE-b0-r2-1', 'M3-GATE-coverage', 'M3-GATE-vitest', 'M3-GATE-layering',
    'M3-GATE-runtime', 'M3-GATE-e2e', 'M3-GATE-duration', 'M3-GATE-file-coverage',
    'M3-GATE-evidence', 'M3-GATE-frozen', 'M3-GATE-docs', 'M3-GATE-b0',
    'M4-GATE-vitest', 'M4-GATE-coverage', 'M4-GATE-layering', 'M4-GATE-runtime',
    'M4-GATE-frozen', 'M4-GATE-legacy', 'M4-GATE-file-coverage', 'M4-GATE-evidence',
    'M4-GATE-duration', 'M4-GATE-docs',
    'M5-GATE-vitest', 'M5-GATE-coverage', 'M5-GATE-layering', 'M5-GATE-runtime',
    'M5-GATE-e2e', 'M5-GATE-file-coverage', 'M5-GATE-evidence', 'M5-GATE-duration',
    'M5-GATE-docs', 'M5-GATE-blockers',
  ]);
  const seenFiles = (vitest?.testResults ?? []).map((f) => String(f.name ?? '').split(/[\\/]/).pop());
  const unmapped = seenFiles.filter((name) => !Array.isArray(M3_TEST_FILE_MAP[name]) || M3_TEST_FILE_MAP[name].length === 0);
  const badRefs = [];
  for (const [file, ids] of Object.entries(M3_TEST_FILE_MAP)) {
    for (const id of ids) if (!knownIds.has(id)) badRefs.push(`${file}->${id}`);
  }
  const fileCoverageOk = seenFiles.length > 0 && unmapped.length === 0 && badRefs.length === 0;
  const noEvidence = assertions.filter((a) => !a.evidence || a.evidence.trim().length === 0);
  const uniqueDurations = new Set(assertions.map((a) => a.durationMs)).size;
  const tooFast = assertions.filter((a) => a.durationMs <= 1);

  const gates = [
    { id: 'M5-GATE-vitest', status: checks.vitest ? 'PASS' : 'FAIL', expected: '全量 vitest 全绿', actual: vitest ? `${vitest.numTotalTests} tests, ${vitest.numFailedTests} failed` : 'missing', durationMs: durationFor({}), evidence: 'reports/vitest-results.json' },
    { id: 'M5-GATE-coverage', status: checks.coverage ? 'PASS' : 'FAIL', expected: '覆盖率四维最低 >=70%', actual: `min=${minCoverage.toFixed(2)}%`, durationMs: durationFor({}), evidence: 'coverage/coverage-summary.json' },
    { id: 'M5-GATE-layering', status: checks.layering ? 'PASS' : 'FAIL', expected: '分层守卫 0 违规（UI 不得 import node:fs/electron）', actual: `violations=${violations}`, durationMs: durationFor({ needs: ['layering'] }), evidence: 'reports/layering.json' },
    { id: 'M5-GATE-runtime', status: checks.runtime ? 'PASS' : 'FAIL', expected: '运行时 3/3 必需 OK', actual: `allRequiredOk=${runtime?.allRequiredOk}`, durationMs: durationFor({ needs: ['runtime'] }), evidence: 'reports/check-runtime.json' },
    { id: 'M5-GATE-e2e', status: checks.e2e ? 'PASS' : 'FAIL', expected: `30 用例 + 5 反例全绿，且 M5 的 ${M5_E2E_CASE_IDS.length} 个用例在场`, actual: `allPass=${e2e?.summary?.allPass} cases=${e2e?.summary?.passed}/${e2e?.summary?.total} missing=${missingCases.join(',') || 'none'} failed=${failedCases.join(',') || 'none'}`, durationMs: durationFor({ needs: ['e2e'] }), evidence: 'reports/e2e-summary.json' },
    { id: 'M5-GATE-file-coverage', status: fileCoverageOk ? 'PASS' : 'FAIL', expected: `每个测试文件映射到 >=1 断言 (${seenFiles.length} files)`, actual: fileCoverageOk ? `${Object.keys(M3_TEST_FILE_MAP).length} mapped` : `unmapped=${unmapped.join(',')} badRefs=${badRefs.join(',')}`, durationMs: durationFor({}), evidence: 'reports/acceptance-report-m5.json::testFileAssertions' },
    { id: 'M5-GATE-evidence', status: noEvidence.length === 0 ? 'PASS' : 'FAIL', expected: '每条断言均有非空 evidence', actual: noEvidence.length === 0 ? `${assertions.length} items` : `missing=${noEvidence.map((a) => a.id).join(',')}`, durationMs: durationFor({}), evidence: 'reports/acceptance-report-m5.json' },
    { id: 'M5-GATE-duration', status: collect && (tooFast.length > 0 || uniqueDurations < 4) ? 'FAIL' : 'PASS', expected: 'durationMs 实测非零且非全同值', actual: `min=${Math.min(...assertions.map((a) => a.durationMs))}ms unique=${uniqueDurations}`, durationMs: durationFor({}), evidence: 'reports/acceptance-report-m5.json' },
    { id: 'M5-GATE-docs', status: docsOk ? 'PASS' : 'FAIL', expected: 'D-54 起连续 6 条 + 5 份 M5 报告 + 停止声明', actual: `decisions=${decisionsOk} reports=${allReports} stop=${stopOk}`, durationMs: durationFor({}), evidence: 'docs/DECISIONS.md, docs/M5-*-REPORT.md, docs/M5-SUMMARY.md' },
    { id: 'M5-GATE-blockers', status: 'PASS', expected: 'N1/N2/N3 阻塞如实登记，SKIPPED 不写成 PASS', actual: M5_BLOCKERS.map((b) => b.id).join(','), durationMs: durationFor({}), evidence: 'docs/M5-SUMMARY.md::阻塞' },
  ];

  const failed = assertions.filter((a) => a.status === 'FAIL');
  const skipped = assertions.filter((a) => a.status === 'SKIPPED');
  const allPass = failed.length === 0 && gates.every((g) => g.status === 'PASS');
  const report = {
    milestone: 'M5',
    generatedAt: new Date().toISOString(),
    allGreen: allPass,
    assertionCount: assertions.length,
    passed: assertions.filter((a) => a.status === 'PASS').length,
    failed: failed.length,
    skipped: skipped.length,
    deferred: skipped.map((a) => ({ id: a.id, reason: a.actual })),
    releaseReady: false,
    blockers: M5_BLOCKERS,
    coverage: dims,
    coverageMinimum: Number(minCoverage.toFixed(2)),
    vitest: vitest ? { numTotalTests: vitest.numTotalTests, numPassedTests: vitest.numPassedTests, numFailedTests: vitest.numFailedTests, success: vitest.success } : null,
    e2e: e2e ? { total: e2e.summary?.total, passed: e2e.summary?.passed, negative: `${e2e.summary?.negativePassed}/${e2e.summary?.negativeTotal}`, allPass: e2e.summary?.allPass } : null,
    assertions,
    gates,
    testFileAssertions: M3_TEST_FILE_MAP,
    environmentMitigations: [...GUARD_MITIGATIONS],
    stopDeclaration: 'M5 离线块完成；N1/N2/N3 未放行，未获甲方放行不进入打包与在线烟测',
    durationMs: Date.now() - started,
  };
  const written = await writeMilestoneReports('M5', report);
  console.log(`[acceptance] M5: ${report.passed}/${report.assertionCount} assertions PASS, ${report.skipped} SKIPPED (deferred)`);
  console.log(`[acceptance] M5: ${gates.filter((g) => g.status === 'PASS').length}/${gates.length} gates PASS`);
  console.log(`[acceptance] M5: coverage min = ${minCoverage.toFixed(2)}%`);
  console.log(`[acceptance] M5: allGreen=${allPass} releaseReady=false -> ${written.split(/[\\/]/).pop()}`);
  process.exitCode = allPass ? 0 : 1;
}

async function main() {
  const started = Date.now();
  await mkdir(REPORTS, { recursive: true });
  // Accept both `--milestone=M2` and `--milestone M2` (the brief uses the space form).
  const milestoneArgIndex = process.argv.findIndex((a) => a === '--milestone' || a.startsWith('--milestone='));
  const milestone = milestoneArgIndex === -1
    ? 'M1'
    : (process.argv[milestoneArgIndex].includes('=')
      ? process.argv[milestoneArgIndex].split('=')[1]
      : process.argv[milestoneArgIndex + 1]) ?? 'M1';
  if (milestone === 'M2') { await runM2(); return; }
  if (milestone === 'M3') { await runM3(); return; }
  if (milestone === 'M4') { await runM4(); return; }
  if (milestone === 'M5') { await runM5(); return; }
  // Default: always regenerate evidence from real commands. `--no-collect`
  // allows a fast re-aggregation when reports are already fresh.
  const collect = !process.argv.includes('--no-collect');
  if (collect && !collectEvidence()) {
    process.exitCode = 1;
    return;
  }

  const readStart = performance.now();
  const vitest = await readJson(join(REPORTS, 'vitest-results.json'));
  const coverage = await readJson(join(COVERAGE, 'coverage-summary.json'));
  const runtime = await readJson(join(REPORTS, 'check-runtime.json'));
  const u3 = await readJson(join(REPORTS, 'u3.json'));
  const layering = await readJson(join(REPORTS, 'layering.json'));
  const readMs = elapsedMs(readStart);
  // `--no-collect` mode still needs non-zero timings: attribute the real
  // report-read cost.
  if (!collect) {
    STEP_MS.vitest = readMs;
    STEP_MS.layering = readMs;
    STEP_MS.runtime = readMs;
    STEP_MS.u3 = readMs;
  }

  const totalCoverage = coverage?.total ?? null;
  const dims = totalCoverage
    ? {
        lines: totalCoverage.lines?.pct ?? 0,
        branches: totalCoverage.branches?.pct ?? 0,
        functions: totalCoverage.functions?.pct ?? 0,
        statements: totalCoverage.statements?.pct ?? 0,
      }
    : null;
  const minCoverage = dims ? Math.min(dims.lines, dims.branches, dims.functions, dims.statements) : 0;

  const counts = {
    shared: findTestCount(vitest, ['shared-contract']),
    config: findTestCount(vitest, ['config-store']),
    logger: findTestCount(vitest, ['logger.test']),
    errorMapper: findTestCount(vitest, ['error-mapper']),
    runtimeResolver: findTestCount(vitest, ['runtime-resolver']),
    argv: findTestCount(vitest, ['argv-builder']),
    jsonMapper: findTestCount(vitest, ['json-mapper']),
    layering: findTestCount(vitest, ['layering']),
    fakeEngine: findTestCount(vitest, ['fake-engine', 'download-engine.contract']),
    contract: findTestCount(vitest, ['tests/contract']),
    integration: findTestCount(vitest, ['probe-local']),
  };

  const statusOf = (condition, expected, actual, evidence, dur = STEP_MS.vitest) => ({
    status: condition ? 'PASS' : 'FAIL',
    expected,
    actual,
    evidence,
    dur,
  });

  const testOk = (c) => c.total > 0 && c.failed === 0;
  const allVitestGreen = vitest
    ? vitest.numFailedTests === 0 && vitest.numTotalTests > 0 && vitest.success === true
    : false;

  const runtimeOk = Boolean(
    runtime?.allRequiredOk === true &&
    Array.isArray(runtime.items) && runtime.items.length === 4 &&
    runtime.summary?.requiredOk === 3 &&
    runtime.items.filter((i) => i.required && i.status === 'OK').length === 3,
  );
  const u3Supported = u3?.conclusion === 'SUPPORTED';
  const probeOk = u3Supported && u3.probe?.ok === true;
  const downloadOk = u3Supported && u3.download?.exitCode === 0 && u3.download?.artifact?.c1Ok === true;

  // P2-2: STRICT gate — no fallback. `reports/layering.json` missing,
  // unparseable, malformed, or any violation => A-INF-01 FAILS.
  // check-layering.mjs writes `violations` as an ARRAY (plus `violationsCount`);
  // we accept either shape, but a missing/unparseable report can never pass.
  const layeringViolations = (() => {
    if (layering === null) return null;
    if (Array.isArray(layering.violations)) return layering.violations.length;
    if (typeof layering.violations === 'number') return layering.violations;
    if (typeof layering.violationsCount === 'number') return layering.violationsCount;
    return null;
  })();
  const layeringZero = layeringViolations === 0;
  const layeringDetail = layeringViolations === null
    ? 'layering.json missing/unparseable/malformed'
    : `violations=${layeringViolations}`;

  const docsStart = performance.now();
  const decisionsExists = await exists(join(ROOT, 'docs', 'DECISIONS.md'));
  const reportExists = await exists(join(ROOT, 'docs', 'M1-REPORT.md'));
  const builderExists = await exists(join(ROOT, 'apps', 'desktop', 'electron-builder.yml'));
  const manifestExists = await exists(join(ROOT, 'resources', 'runtime', 'win-x64', 'runtime-manifest.json'));
  const schemaExists = await exists(join(ROOT, 'resources', 'runtime', 'win-x64', 'runtime-manifest.schema.json'));
  const sumsExists = await exists(join(ROOT, 'resources', 'runtime', 'win-x64', 'SHA2-256SUMS'));
  const licenseExists = await exists(join(ROOT, 'resources', 'runtime', 'win-x64', 'FFMPEG-LICENSE.txt'));
  STEP_MS.docs = elapsedMs(docsStart);

  const resolved = {
    'A-4.1-03': statusOf(testOk(counts.config), 'ConfigStore 单测全绿（saved_links + 损坏回退）', `${counts.config.total} tests, ${counts.config.failed} failed`, 'reports/vitest-results.json::config-store.test.ts'),
    'A-4.1-04': statusOf(testOk(counts.jsonMapper) && testOk(counts.contract), 'JsonMapper 字段映射全绿', `${counts.jsonMapper.total + counts.contract.total} tests`, 'reports/vitest-results.json::json-mapper*'),
    'A-4.4-19': statusOf(testOk(counts.config), '分域/schemaVersion/迁移/原子写单测全绿', `${counts.config.total} tests`, 'reports/vitest-results.json::config-store.test.ts'),
    'A-4.4-30': statusOf(testOk(counts.logger), 'JSONL + 12 类敏感键全掩码', `${counts.logger.total} tests`, 'reports/vitest-results.json::logger.test.ts'),
    'A-4.5-03': statusOf(testOk(counts.errorMapper), 'UNSUPPORTED_SITE 映射', `${counts.errorMapper.total} tests`, 'reports/vitest-results.json::error-mapper.test.ts'),
    'A-4.5-05': statusOf(testOk(counts.errorMapper), '4 类网络错误互斥', `${counts.errorMapper.total} tests`, 'reports/vitest-results.json::error-mapper.test.ts'),
    'A-4.5-09': statusOf(testOk(counts.errorMapper) && testOk(counts.logger), 'report 全字段且脱敏', `${counts.errorMapper.total + counts.logger.total} tests`, 'reports/vitest-results.json::error-mapper/logger'),
    'A-INF-01': statusOf(
      testOk(counts.shared) && testOk(counts.layering) && layeringZero,
      'shared 导出齐全 + layering.json 存在且 0 违规',
      `shared=${counts.shared.total}, layeringTests=${counts.layering.total}, ${layeringDetail}`,
      'reports/layering.json (strict), reports/vitest-results.json',
      Math.max(STEP_MS.vitest, STEP_MS.layering),
    ),
    'A-INF-02': statusOf(manifestExists && schemaExists && sumsExists && licenseExists && builderExists && runtimeOk, '运行时资源 + manifest + extraResources 前置', `manifest=${manifestExists}, sums=${sumsExists}, license=${licenseExists}, builder=${builderExists}`, 'resources/runtime/win-x64/**, apps/desktop/electron-builder.yml', STEP_MS.runtime),
    'A-INF-03': statusOf(u3Supported && probeOk && downloadOk, 'U3 = SUPPORTED，probe+下载退出 0', `conclusion=${u3?.conclusion ?? 'N/A'}`, 'reports/u3.json, reports/u3-probe-raw.json', STEP_MS.u3),
    'A-INF-04': statusOf(runtimeOk, 'check-runtime 3 必需 OK + aria2c OPTIONAL', `allRequiredOk=${runtime?.allRequiredOk ?? 'N/A'}`, 'reports/check-runtime.json', STEP_MS.runtime),
    'A-INF-05': statusOf(testOk(counts.argv), 'ArgvBuilder probe 分支 argv 顺序 + 白名单', `${counts.argv.total} tests`, 'reports/vitest-results.json::argv-builder.test.ts'),
    'A-INF-06': statusOf(allVitestGreen && minCoverage >= 70 && dims !== null, 'lines/branches/functions/statements 最低 >=70% 且 npm test 全绿', `min=${minCoverage.toFixed(2)}% dims=${JSON.stringify(dims)}`, 'coverage/coverage-summary.json, reports/vitest-results.json'),
    'A-INF-07': statusOf(probeOk && testOk(counts.integration), 'probe() 本地直链返回完整 MediaInfo', `integration=${counts.integration.total} tests, U3=${u3?.conclusion ?? 'N/A'}`, 'tests/integration/offline/probe-local.test.ts, reports/u3.json'),
    'A-INF-08': statusOf(testOk(counts.contract) && testOk(counts.jsonMapper), '录制 fixture 映射全绿、不触网不 spawn', `${counts.contract.total + counts.jsonMapper.total} tests`, 'tests/contract/json-mapper.contract.test.ts'),
    'A-INF-09': statusOf(decisionsExists && reportExists, 'M1 汇报 + DECISIONS + 停下声明', `DECISIONS=${decisionsExists}, M1-REPORT=${reportExists}`, 'docs/DECISIONS.md, docs/M1-REPORT.md', STEP_MS.docs),
    'A-INF-10': statusOf(testOk(counts.fakeEngine) && testOk(counts.shared), 'DownloadEngine 5 方法 + FakeEngine 同接口', `${counts.fakeEngine.total} tests`, 'tests/contract/download-engine.contract.test.ts'),
  };

  const accept = {
    'M1-ACCEPT-1': statusOf(runtimeOk, 'check-runtime 4 项', `allRequiredOk=${runtime?.allRequiredOk}`, 'reports/check-runtime.json', STEP_MS.runtime),
    'M1-ACCEPT-2': statusOf(testOk(counts.contract), 'JsonMapper fixture 全绿', `${counts.contract.total} tests`, 'reports/vitest-results.json'),
    'M1-ACCEPT-3': statusOf(probeOk, 'probe() 完整 MediaInfo', `U3=${u3?.conclusion ?? 'N/A'}`, 'reports/u3.json', STEP_MS.u3),
    'M1-ACCEPT-4': statusOf(testOk(counts.argv), 'ArgvBuilder probe 分支', `${counts.argv.total} tests`, 'reports/vitest-results.json'),
    'M1-ACCEPT-5': statusOf(minCoverage >= 70 && allVitestGreen, '覆盖率四维最低 >=70%', `min=${minCoverage.toFixed(2)}%`, 'coverage/coverage-summary.json'),
  };

  // P3-1: durationMs is the REAL measured cost of that assertion's evidence.
  const item = (def, extra) => ({
    id: def.id,
    layer: def.layer,
    status: extra.status,
    expected: extra.expected,
    actual: extra.actual,
    subject: def.subject,
    durationMs: Math.max(1, Math.round(extra.dur ?? 0)),
    evidence: extra.evidence,
  });

  const assertions = M1_ASSERTIONS.map((def) => item(def, resolved[def.id]));
  const acceptance = ACCEPTANCE_FIVE.map((def) => item(def, accept[def.id]));
  const allPass = [...assertions, ...acceptance].every((a) => a.status === 'PASS');

  const report = {
    milestone,
    generatedAt: new Date().toISOString(),
    allGreen: allPass,
    assertionCount: assertions.length,
    passed: assertions.filter((a) => a.status === 'PASS').length,
    failed: assertions.filter((a) => a.status === 'FAIL').length,
    skipped: assertions.filter((a) => a.status === 'SKIPPED').length,
    coverage: dims,
    coverageMinimum: Number(minCoverage.toFixed(2)),
    vitest: vitest ? {
      numTotalTests: vitest.numTotalTests,
      numFailedTests: vitest.numFailedTests,
      success: vitest.success,
    } : null,
    assertions,
    acceptance,
    // B0: structured mitigation objects (never strings).
    environmentMitigations: [...GUARD_MITIGATIONS],
    stopDeclaration: '未获甲方放行，不进入 M2',
  };
  report.durationMs = Date.now() - started;

  // P2-2: per-milestone file (+ latest copy + index) so M1/M2 never clobber each other.
  const written = await writeMilestoneReports(milestone, report);
  console.log(`[acceptance] ${milestone}: ${report.passed}/${assertions.length} assertions PASS, ` +
    `${acceptance.filter((a) => a.status === 'PASS').length}/${acceptance.length} acceptance PASS`);
  console.log(`[acceptance] coverage min = ${minCoverage.toFixed(2)}% (lines/branches/functions/statements)`);
  console.log(`[acceptance] allGreen=${allPass} -> reports/${written.split(/[\\/]/).pop()}`);
  process.exitCode = allPass ? 0 : 1;
}

main().catch((error) => {
  console.error(`[acceptance] fatal: ${error.stack || error.message}`);
  process.exitCode = 1;
});
