/**
 * Frozen-gate · M5-4 / §6.2-① option A (D-61).
 *
 * D-50 froze `packages/shared/src/request.ts` — the argv/request contract.
 * The old gate also demanded byte-identical `package.json` and
 * `pnpm-lock.yaml`, which made installing any packaging dependency turn
 * M3/M4-GATE-frozen red even though the frozen contract was untouched.
 *
 * New rule (explicit allow-list, not a blanket diff check):
 *   R1  request.ts must be byte-identical to HEAD.
 *   R2  package.json: every top-level field except devDependencies must be
 *       identical; devDependencies may only GAIN electron-builder /
 *       electron-updater with the exact planned versions — no edits, no
 *       deletions, no other additions.
 *   R3  pnpm-lock.yaml: no package and no importer declaration may DISAPPEAR.
 *       Additions and re-resolutions are what installing the two allow-listed
 *       dependencies produces; silently dropping a dependency is the risk.
 *   R4  return { ok, reasons, stats } — never throw, always explain a failure.
 *
 * Why R3 is name-set based and not "any '-' line fails" (D-61 §R3 细化):
 * a real `pnpm add` re-resolves the whole graph. The measured diff on
 * 2026-11-06 had 39 removed lines, including `resolution:` blocks for
 * `rollup@4.67.5` / `semver@7.8.6` — pnpm bumping transitives and rewriting
 * peer suffixes, not a human deleting dependencies. A textual rule would fail
 * every legitimate install and teach the next person to bypass the gate.
 * The rule therefore checks intent: package names and importer declarations
 * must survive; version churn is reported in `stats.versionChanges` so the
 * gate output still shows it.
 *
 * Pure function: it never runs git itself, so it is fully L0-testable.
 * The CLI wrapper at the bottom of this file owns the git side (R1-09).
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Exact versions registered in package.json -> ytvdltPlannedDependencies. */
export const ALLOWED_NEW_DEPS = Object.freeze({
  'electron-builder': '^26.0.0',
  'electron-updater': '^6.8.0',
});

/**
 * Top-level `package.json` keys that may be ADDED without tripping the gate.
 * Deliberately tiny: non-dependency metadata only. `license` was added when the
 * project picked a source-available licence (D-66); dependency declarations are
 * still locked by R2's devDependencies rules.
 */
export const ALLOWED_NEW_TOP_LEVEL = Object.freeze({ license: 'string' });

/** The one truly frozen file (D-50). */
export const FROZEN_CORE_FILE = 'packages/shared/src/request.ts';

/** Order-insensitive, undefined-safe canonical form for JSON comparison. */
function canon(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canon(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** Strip a lockfile block key down to its package name. */
export function packageNameOf(blockKey) {
  const key = String(blockKey ?? '').replace(/^'+|'+$/g, '');
  // pnpm appends peer suffixes in parentheses: `vitest@3.2.4(@types/node@22.20.5)`.
  const base = key.split('(')[0];
  const at = base.lastIndexOf('@');
  return at > 0 ? base.slice(0, at) : base;
}

/**
 * Every package block key in the `packages:` section of a pnpm lockfile.
 * Lockfile v9 puts them at exactly two spaces of indentation.
 */
export function lockPackageKeys(lockText) {
  const keys = [];
  let inPackages = false;
  for (const line of String(lockText ?? '').split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
    if (!inPackages) continue;
    if (/^\S/.test(line) && line.trim() !== '') { inPackages = false; continue; }
    const match = /^ {2}(?:'([^']+)'|([^\s:][^:]*)):\s*$/.exec(line);
    if (match !== null) keys.push(match[1] ?? match[2]);
  }
  return keys;
}

/**
 * `importer|section|dependency` triples for every declared dependency in the
 * `importers:` section. Deleting one of these means a package was removed from
 * a workspace package — always a failure.
 */
export function lockImporterDeps(lockText) {
  const deps = new Set();
  let inImporters = false;
  let importer = '';
  let section = '';
  for (const line of String(lockText ?? '').split(/\r?\n/)) {
    if (/^importers:\s*$/.test(line)) { inImporters = true; continue; }
    if (!inImporters) continue;
    if (/^packages:\s*$/.test(line)) break;
    if (/^ {2}(?:'([^']+)'|([^\s:][^:]*)):\s*$/.test(line)) {
      const match = /^ {2}(?:'([^']+)'|([^\s:][^:]*)):\s*$/.exec(line);
      importer = match[1] ?? match[2];
      section = '';
      continue;
    }
    if (/^ {4}([A-Za-z]+):\s*$/.test(line)) {
      section = /^ {4}([A-Za-z]+):\s*$/.exec(line)[1];
      continue;
    }
    const dep = /^ {6}(?:'([^']+)'|([^\s:][^:]*)):\s*$/.exec(line);
    if (dep !== null && importer !== '' && section !== '') {
      deps.add(`${importer}|${section}|${dep[1] ?? dep[2]}`);
    }
  }
  return deps;
}

/** Textual fallback used only when full lockfile text is unavailable. */
export function lockDiffHasRemoval(lockDiff) {
  return String(lockDiff ?? '')
    .split(/\r?\n/)
    .some((line) => line.startsWith('-') && !line.startsWith('--- '));
}

function checkPackageJson(pkgHead, pkgWork, reasons) {
  const head = pkgHead ?? {};
  const work = pkgWork ?? {};
  const headDev = head.devDependencies ?? {};
  const workDev = work.devDependencies ?? {};

  const restOf = (pkg) => {
    const copy = { ...pkg };
    delete copy.devDependencies;
    return copy;
  };
  const headRest = restOf(head);
  const workRest = restOf(work);
  for (const key of Object.keys(headRest)) {
    if (!(key in workRest)) reasons.push(`package.json 删除了顶层字段 ${key}`);
    else if (canon(headRest[key]) !== canon(workRest[key])) {
      reasons.push(`package.json 改写了顶层字段 ${key}`);
    }
  }
  for (const key of Object.keys(workRest)) {
    if (key in headRest) continue;
    if (!(key in ALLOWED_NEW_TOP_LEVEL)) {
      reasons.push(`package.json 新增了顶层字段 ${key}`);
    } else if (typeof workRest[key] !== ALLOWED_NEW_TOP_LEVEL[key]) {
      reasons.push(`package.json 顶层字段 ${key} 类型应为 ${ALLOWED_NEW_TOP_LEVEL[key]}`);
    }
  }

  for (const [name, version] of Object.entries(headDev)) {
    if (!(name in workDev)) {
      reasons.push(`package.json 删除了既有依赖 ${name}`);
    } else if (workDev[name] !== version) {
      reasons.push(`package.json 改写了既有依赖 ${name} 的版本（${version} -> ${workDev[name]}）`);
    }
  }
  for (const [name, version] of Object.entries(workDev)) {
    if (name in headDev) continue;
    if (!(name in ALLOWED_NEW_DEPS)) {
      reasons.push(`package.json 新增了白名单外依赖 ${name}@${version}`);
    } else if (version !== ALLOWED_NEW_DEPS[name]) {
      reasons.push(`白名单依赖 ${name} 版本应为 ${ALLOWED_NEW_DEPS[name]}，实际 ${version}`);
    }
  }
}

export function checkFrozen({
  coreDiff = '',
  pkgHead = {},
  pkgWork = {},
  lockHead = null,
  lockWork = null,
  lockDiff = '',
} = {}) {
  const reasons = [];
  const stats = { removedPackages: [], addedPackages: [], versionChanges: 0 };

  // R1 — the only truly frozen object (D-50).
  if (String(coreDiff ?? '').trim() !== '') {
    reasons.push(`${FROZEN_CORE_FILE} 对 HEAD 有改动（D-50 冻结对象）`);
  }

  // R2 — package.json: only the two planned dependencies may appear.
  checkPackageJson(pkgHead, pkgWork, reasons);

  // R3 — nothing may disappear from the lockfile.
  if (typeof lockHead === 'string' && typeof lockWork === 'string') {
    const headKeys = lockPackageKeys(lockHead);
    const workKeys = lockPackageKeys(lockWork);
    const headNames = new Set(headKeys.map(packageNameOf));
    const workNames = new Set(workKeys.map(packageNameOf));

    const removed = [...headNames].filter((name) => !workNames.has(name));
    const added = [...workNames].filter((name) => !headNames.has(name));
    stats.removedPackages = removed;
    stats.addedPackages = added;
    if (removed.length > 0) {
      reasons.push(`pnpm-lock.yaml 有 ${removed.length} 个依赖整体消失：${removed.slice(0, 5).join(', ')}`);
    }

    const headDeps = lockImporterDeps(lockHead);
    const workDeps = lockImporterDeps(lockWork);
    const lostDeps = [...headDeps].filter((dep) => !workDeps.has(dep));
    if (lostDeps.length > 0) {
      reasons.push(`pnpm-lock.yaml 删除了 ${lostDeps.length} 条 importer 依赖声明：${lostDeps.slice(0, 5).join(', ')}`);
    }

    const byName = new Map();
    for (const key of workKeys) {
      const name = packageNameOf(key);
      const list = byName.get(name) ?? [];
      list.push(key);
      byName.set(name, list);
    }
    for (const key of headKeys) {
      const versions = byName.get(packageNameOf(key)) ?? [];
      if (versions.length > 0 && !versions.includes(key)) stats.versionChanges += 1;
    }
  } else if (lockDiffHasRemoval(lockDiff)) {
    reasons.push('pnpm-lock.yaml diff 含删除行（未提供完整 lock 文本，退回严格判定）');
  }

  return { ok: reasons.length === 0, reasons, stats };
}

/* ------------------------------------------------------------------------- *
 * CLI entry (R1-09)
 *
 * WHY THIS EXISTS: until this was added the file exported `checkFrozen()` and
 * nothing else. `node scripts/frozen-gate.mjs` therefore imported the module,
 * ran no check at all, and exited 0 — so every "frozen-gate passed" line in a
 * report was evidence of nothing. A gate that cannot fail is worse than no gate,
 * because it is counted as coverage.
 *
 * Resolution rules, all deliberate:
 *   - HEAD  side: `git show HEAD:<file>` — the committed baseline.
 *   - WORK  side: the WORKING TREE file, not the index. `git show :file` would
 *     report a staged snapshot and miss exactly the uncommitted edits this gate
 *     is meant to catch.
 *   - git unavailable or the file missing at HEAD (first commit): exit 2 with a
 *     message, never a silent pass.
 *
 *   node scripts/frozen-gate.mjs          # human output, exit 0/1
 *   node scripts/frozen-gate.mjs --json   # machine output
 * ------------------------------------------------------------------------- */
function isCliEntry() {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return pathToFileURL(invoked).href === import.meta.url;
  } catch {
    return false;
  }
}

function gitShow(ref, cwd) {
  const run = spawnSync('git', ['show', ref], {
    cwd, shell: false, windowsHide: true, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
  return run.status === 0 ? run.stdout : null;
}

export function runFrozenGateCli(cwd = process.cwd()) {
  const headPkg = gitShow('HEAD:package.json', cwd);
  if (headPkg === null) {
    return { ok: false, reasons: ['无法读取 git HEAD:package.json（不在 git 仓库或尚无提交）'], stats: {} };
  }
  const headLock = gitShow('HEAD:pnpm-lock.yaml', cwd);
  const workPkgText = readFileSync(join(cwd, 'package.json'), 'utf8');
  const workLockText = existsSync(join(cwd, 'pnpm-lock.yaml'))
    ? readFileSync(join(cwd, 'pnpm-lock.yaml'), 'utf8')
    : null;
  // The frozen contract file: an empty diff means byte-identical.
  const coreDiffRun = spawnSync('git', ['diff', 'HEAD', '--', FROZEN_CORE_FILE], {
    cwd, shell: false, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const coreDiff = coreDiffRun.status === 0 ? (coreDiffRun.stdout ?? '') : '__git_failed__';
  const reasons = [];
  if (coreDiff === '__git_failed__') reasons.push(`无法对 ${FROZEN_CORE_FILE} 执行 git diff`);

  const result = checkFrozen({
    coreDiff: coreDiff === '__git_failed__' ? '' : coreDiff,
    pkgHead: JSON.parse(headPkg),
    pkgWork: JSON.parse(workPkgText),
    lockHead: headLock,
    lockWork: workLockText,
  });
  return { ...result, reasons: [...reasons, ...result.reasons], ok: reasons.length === 0 && result.ok };
}

if (isCliEntry()) {
  const result = runFrozenGateCli();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(
      `[frozen-gate] PASS — ${FROZEN_CORE_FILE} 未改动；package.json 白名单合规；`
      + `pnpm-lock.yaml 无依赖消失（新增 ${result.stats.addedPackages?.length ?? 0}，`
      + `版本变动 ${result.stats.versionChanges ?? 0}）\n`,
    );
  } else {
    process.stdout.write('[frozen-gate] FAIL\n');
    for (const reason of result.reasons) process.stdout.write(`  - ${reason}\n`);
  }
  process.exit(result.ok ? 0 : 1);
}
