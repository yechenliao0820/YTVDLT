#!/usr/bin/env node
/**
 * CI 安全套件跳过守卫（A-D206 安全轮 · 要求 7）。
 *
 * 消费 workflow「Security suite (fail-closed · links · registry i18n)」步骤里
 * `pnpm exec vitest run --reporter=json --outputFile.json=…` 产出的定向运行
 * 结果（默认 reports/vitest-security-results.json，七个安全边界测试文件），
 * 做两类检查：
 *
 * 结构性检查（任一不满足 → exit 2，绝不静默放过）：
 *   - 结果文件存在且可解析；
 *   - testResults 为非空数组，且结果里的文件集合与七个期望文件【完全一致】
 *     （防 vitest include/filter 或命令行文件列表被改动后整个文件静默漏跑）；
 *   - 每个文件的 assertionResults 非空（收集到 0 个用例同样不放行）；
 *   - 只允许 passed / failed / skipped 三种终态（pending/todo = 未完成或
 *     reporter 形态异常，结果不可信）；
 *   - success === true 且 numFailedTests === 0（正常情况下 vitest 非零退出
 *     早已让 bash -eo pipefail 步骤失败，这里是双保险）。
 *
 * 跳过守卫（D-208 语义）：
 *   - 符号链接权限类跳过：零容忍。windows-latest runner 以管理员运行，应当
 *     拥有 SeCreateSymbolicLinkPrivilege；junction 用例无需权限、永远执行。
 *     任何非 allowlist 的 skipped（尤其符号链接用例）→ exit 1 + 可操作指引。
 *   - UNC 能力门跳过（A-8a / A-8b，`\\<host>\<盘符>$` 管理员共享）：显式
 *     allowlist 放行并大声报告——SMB 回环可达性是环境属性而非权限缺失，
 *     runner 阻断时该覆盖缺口按 D-206/D-208 登记（不构成静默跳过）。
 *   - 边界说明：本地开发机（无开发者模式）符号链接用例 skipped > 0 是预期
 *     行为——本守卫只应绑定在 CI 的安全套件步骤；本地覆盖范围以 A-D206
 *     能力探测输出（A-0 / B-0 / C-1 用例的 stdout）为准。
 *
 * 用法：node scripts/check-security-suite-results.mjs [结果JSON路径]
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/** 跳过守卫的目标文件（要求 7：CI runner 上 skipped 必须为 0）。 */
const GUARD_FILE = 'win-fs-link-security.test.ts';

/** 七个安全边界测试文件，与 workflow 中 vitest run 的文件列表一一对应。 */
const EXPECTED_FILES = [
  'artifact-containment-actions.test.ts', // 要求 3/5：request===null fail-closed / 越界 / 混合批 / 回收站零误收
  'restore-chain-fail-closed.test.ts',    // 要求 4：损坏快照完整恢复链后危险 artifacts 不复活
  'win-fs-link-security.test.ts',         // 要求 1/2/5：真实 junction/symlink 删除守卫 + realpath 打开守卫 + 回收站零调用
  'task-detail.test.ts',                  // 要求 2：open 门 fail-closed（fake-fs 互补层）
  'task-detail-folder.test.ts',           // 要求 2：open 门 realpath 分支（D-204）
  'win-startup.test.ts',                  // 要求 6：注册表多语种 not-found + Access-Denied fail-closed
  'path-containment.test.ts',             // 要求 1：路径归一化/长路径前缀/UNC 形态纯函数面
];

const TERMINAL_STATUSES = new Set(['passed', 'failed', 'skipped']);

const resultsPath = process.argv[2] ?? 'reports/vitest-security-results.json';

function structuralError(detail) {
  console.error(`[security-suite-guard] STRUCTURAL FAILURE — 结果不可信，拒绝放行：${detail}`);
  console.error('[security-suite-guard] 排查：确认 Security suite 步骤的 vitest 命令（--reporter=json --outputFile.json 与七个文件列表）未被改动，reports/ 可写。');
  process.exit(2);
}

let raw;
try {
  raw = readFileSync(resultsPath, 'utf8');
} catch (error) {
  structuralError(`无法读取结果文件 ${resultsPath}（${error.code ?? error.message}）——定向 vitest 可能没有产出 JSON`);
}

let report;
try {
  report = JSON.parse(raw);
} catch (error) {
  structuralError(`结果文件 ${resultsPath} 不是合法 JSON（${error.message}）`);
}

if (report === null || typeof report !== 'object') structuralError('JSON 顶层不是对象');
if (!Array.isArray(report.testResults) || report.testResults.length === 0) {
  structuralError('testResults 缺失或为空——定向运行没有执行任何文件');
}
if (report.success !== true || report.numFailedTests !== 0) {
  structuralError(`运行未全绿（success=${report.success}, numFailedTests=${report.numFailedTests}）——跳过守卫只在干净结果上判定`);
}

// 按文件基名归并（vitest JSON reporter 的 testResults[].name 是绝对路径，分隔符随平台）。
const byFile = new Map();
for (const suite of report.testResults) {
  if (!suite || typeof suite.name !== 'string' || !Array.isArray(suite.assertionResults)) {
    structuralError('testResults 条目缺 name 或 assertionResults——JSON 形态与 vitest 3.x reporter 不符');
  }
  const base = basename(suite.name.replace(/\\/g, '/'));
  if (!byFile.has(base)) byFile.set(base, []);
  byFile.get(base).push(suite.assertionResults);
}

const seen = [...byFile.keys()];
for (const base of seen) {
  if (!EXPECTED_FILES.includes(base)) {
    structuralError(`结果里出现期望之外的文件 ${base}——若确属安全套件新成员，请同步更新本脚本的 EXPECTED_FILES 与 workflow 的文件列表`);
  }
}

function flatOf(base) {
  return byFile.get(base).flat();
}

for (const expected of EXPECTED_FILES) {
  if (!byFile.has(expected)) {
    structuralError(`期望的测试文件 ${expected} 没有出现在结果里——文件可能被改名/删除，或 vitest 的 include/filter 把它静默漏掉`);
  }
  const flat = flatOf(expected);
  if (flat.length === 0) {
    structuralError(`${expected} 的 assertionResults 为空——文件被收集但没有执行任何用例`);
  }
  for (const assertion of flat) {
    if (!TERMINAL_STATUSES.has(assertion?.status)) {
      structuralError(`${expected} 出现非终态用例（status=${String(assertion?.status)}，fullName=${String(assertion?.fullName)}）——运行未完成或 reporter 形态异常`);
    }
  }
}

console.log('[security-suite-guard] 七文件终态统计：');
for (const expected of EXPECTED_FILES) {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const assertion of flatOf(expected)) counts[assertion.status] += 1;
  console.log(`[security-suite-guard]   ${expected.padEnd(42)} passed=${counts.passed} failed=${counts.failed} skipped=${counts.skipped}`);
}

// ── 跳过守卫（要求 7 · D-208 语义）────────────────────────────────────────
// 符号链接权限类跳过零容忍；UNC 管理员共享跳过为显式 allowlist（大声报告，
// 不构成静默跳过——SMB 回环可达性是环境属性而非权限缺失，覆盖缺口按
// D-206/D-208 登记）。
const CAPABILITY_SKIP_ALLOWLIST = ['A-8a', 'A-8b'];
const skipped = flatOf(GUARD_FILE).filter((assertion) => assertion.status === 'skipped');
const unexpectedSkips = skipped.filter((assertion) => {
  const name = String(assertion.fullName ?? assertion.title ?? '');
  return !CAPABILITY_SKIP_ALLOWLIST.some((id) => name.includes(id));
});
if (unexpectedSkips.length > 0) {
  console.error(`[security-suite-guard] SKIP GUARD FAILURE — ${unexpectedSkips.length} 个非 allowlist 跳过（要求 7：符号链接权限在 windows-latest runner 上必须可用，相关用例必须实跑）`);
  console.error('[security-suite-guard] 被跳过的用例：');
  for (const assertion of unexpectedSkips) console.error(`[security-suite-guard]   - ${assertion.fullName ?? assertion.title}`);
  console.error('[security-suite-guard] 可操作指引：');
  console.error('[security-suite-guard]   1) windows-latest runner 以管理员运行，应拥有 SeCreateSymbolicLinkPrivilege——非 allowlist skipped>0 说明 runner 缺符号链接权限；应检查 runner 环境，而不是放宽本守卫。');
  console.error('[security-suite-guard]   2) junction 用例无需权限、永不跳过；allowlist 之外的被跳用例只会来自 file-symlink 门（A-3/A-4b/B-11c）。');
  console.error('[security-suite-guard]   3) 诊断依据：A-0/B-0/C-1 能力探测用例的 stdout 输出 EPERM 探测原因。本地开发机（无开发者模式）符号链接用例 skipped>0 是预期行为，本守卫只绑定 CI。');
  process.exit(1);
}
if (skipped.length > 0) {
  console.warn(`[security-suite-guard] ALLOWED CAPABILITY SKIPS — ${skipped.length} 个 UNC 能力门跳过（allowlist：${CAPABILITY_SKIP_ALLOWLIST.join('/')}，环境不可得、大声报告非静默）`);
  for (const assertion of skipped) console.warn(`[security-suite-guard]   - ${assertion.fullName ?? assertion.title}`);
  console.warn('[security-suite-guard] 覆盖缺口登记：UNC 真实共享场景未在 runner 验证（D-206/D-208 未覆盖），留真机。');
}

console.log(`[security-suite-guard] PASS — 七个安全文件全部执行且全绿（${report.numPassedTests} passed / 0 failed）；skipped=${skipped.length}（全部属 allowlist 能力门）。`);
