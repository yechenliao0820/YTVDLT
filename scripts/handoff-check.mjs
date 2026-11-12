#!/usr/bin/env node
/**
 * handoff-check.mjs — 交接文档「是否过期」的一键自查（M5-HANDOFF-V2 §0.4）。
 *
 * 只读，不跑测试：把仓库现状（代码提交、决策编号、用例数、上一轮验收结果）
 * 打出来，和文档里写死的数字对照。任何一项不符 → 文档已落后于仓库。
 *
 * 设计要点：
 *  - 只看**代码路径**的最后一次提交（文档提交会不断叠加，不能用来判断代码基线）；
 *  - 验收报告若比最后一次代码提交还旧，直接标 STALE（避免拿旧证据当现状）；
 *  - 输出 Markdown 表，可直接粘进交接文档。
 *
 *   node scripts/handoff-check.mjs
 *   node scripts/handoff-check.mjs --json
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CODE_PATHS = ['apps', 'packages', 'scripts', 'tests'];

function git(args) {
  const run = spawnSync('git', args, {
    cwd: ROOT, shell: false, windowsHide: true, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return run.status === 0 ? (run.stdout ?? '').trim() : null;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function countFiles(dir, suffix) {
  try { return readdirSync(dir).filter((name) => name.endsWith(suffix)).length; } catch { return 0; }
}

const lastCodeCommit = git(['log', '-1', '--format=%h|%ad|%s', '--date=short', '--', ...CODE_PATHS]);
const [codeHash, codeDate, codeSubject] = (lastCodeCommit ?? '||').split('|');

const decisions = (() => {
  try {
    const text = readFileSync(join(ROOT, 'docs', 'DECISIONS.md'), 'utf8');
    const numbers = [...text.matchAll(/^## D-(\d+) ·/gm)].map((m) => Number(m[1]));
    return numbers.length === 0 ? null : Math.max(...numbers);
  } catch { return null; }
})();

const baselinePairs = countFiles(join(ROOT, 'tests', 'e2e', 'baselines'), '.png');
const acceptance = readJson(join(ROOT, 'reports', 'acceptance-report-m5.json'));
const e2e = readJson(join(ROOT, 'reports', 'e2e-summary.json'));
const coverage = readJson(join(ROOT, 'coverage', 'coverage-summary.json'));

/**
 * 报告时间 vs 最后一次代码提交：报告更旧 → 证据是旧的。
 * 故意按「天」比较：同一天内的多次代码/文档提交不应互相报警，隔天才是信号。
 *
 * D-149: report JSON 里的 generatedAt 是 UTC ISO 串（带 Z），直接 slice(0,10)
 * 取的是 UTC 日，而 codeDate（git --date=short）是本地日——本地早上 8 点前
 * （UTC+8）跑出的证据会被误判成「昨天」而永远 STALE。先把报告时刻换算成与
 * 提交日期同一个时区（本地）的日历日，再比「天」；解析失败回退旧的字面切片。
 */
function staleness(reportIso) {
  if (!reportIso || !codeDate) return 'unknown';
  const instant = new Date(String(reportIso));
  const reportDay = Number.isNaN(instant.getTime())
    ? String(reportIso).slice(0, 10)
    : `${instant.getFullYear()}-${String(instant.getMonth() + 1).padStart(2, '0')}-${String(instant.getDate()).padStart(2, '0')}`;
  return reportDay < codeDate ? 'STALE（早于最后一次代码提交）' : 'fresh';
}

const coverageMin = coverage
  ? Math.min(
    coverage.total?.lines?.pct ?? 0,
    coverage.total?.branches?.pct ?? 0,
    coverage.total?.functions?.pct ?? 0,
    coverage.total?.statements?.pct ?? 0,
  )
  : null;

const rows = [
  ['最后一次代码提交', codeHash ? `${codeHash}（${codeDate}）${codeSubject}` : 'git 不可用', 'git log -1 -- apps packages scripts tests'],
  ['决策编号', decisions === null ? 'unknown' : `D-01…D-${decisions}（下一棒从 D-${String(decisions + 1).padStart(2, '0')} 起）`, 'grep "^## D-" docs/DECISIONS.md'],
  ['截图用例数', `${baselinePairs} 个（PNG 基线数 = 用例数）`, 'tests/e2e/baselines/*.png'],
  ['M5 验收', acceptance
    ? `${acceptance.passed}/${acceptance.assertionCount} PASS + ${acceptance.skipped} SKIPPED，allGreen=${acceptance.allGreen}，${staleness(acceptance.generatedAt)}`
    : '缺失（先跑 acceptance --milestone M5）', 'reports/acceptance-report-m5.json'],
  ['E2E', e2e ? `${e2e.summary?.passed}/${e2e.summary?.total} + 反例 ${e2e.summary?.negativePassed}/${e2e.summary?.negativeTotal}，${staleness(e2e.generatedAt)}` : '缺失', 'reports/e2e-summary.json'],
  ['覆盖率四维最低', coverageMin === null ? '缺失' : `${coverageMin.toFixed(2)}%`, 'coverage/coverage-summary.json'],
];

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    lastCodeCommit: { hash: codeHash, date: codeDate, subject: codeSubject },
    decisions,
    e2eCases: baselinePairs,
    acceptance: acceptance ? {
      passed: acceptance.passed, total: acceptance.assertionCount, skipped: acceptance.skipped,
      allGreen: acceptance.allGreen, generatedAt: acceptance.generatedAt, freshness: staleness(acceptance.generatedAt),
    } : null,
    e2e: e2e ? { passed: e2e.summary?.passed, total: e2e.summary?.total, allPass: e2e.summary?.allPass, freshness: staleness(e2e.generatedAt) } : null,
    coverageMin,
  }, null, 2));
} else {
  console.log('| 校验点 | 仓库现状 | 来源 |');
  console.log('|---|---|---|');
  for (const [key, value, source] of rows) console.log(`| ${key} | ${value} | \`${source}\` |`);
  // Only the two evidence rows can be stale — matching the whole table would
  // false-positive on a commit subject that happens to contain the word.
  const stale = [staleness(acceptance?.generatedAt), staleness(e2e?.generatedAt)]
    .filter((value) => value === 'STALE（早于最后一次代码提交）');
  if (stale.length > 0) {
    console.log('\n[handoff-check] 有证据早于最后一次代码提交：先重跑对应验收，再更新交接文档。');
    process.exitCode = 1;
  } else {
    console.log('\n[handoff-check] 与交接文档的数字逐项对照；不一致说明文档已过期。');
  }
}
