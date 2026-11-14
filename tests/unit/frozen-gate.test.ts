/**
 * M5-4 · frozen gate (D-61, §6.2-① option A).
 *
 * The gate replaced a blanket `git diff` check with an explicit allow-list:
 *   - `packages/shared/src/request.ts` stays byte-frozen (D-50);
 *   - `package.json` may only gain `electron-builder` / `electron-updater` at
 *     the exact planned versions;
 *   - `pnpm-lock.yaml` may re-resolve and grow, but nothing may disappear.
 *
 * The peer-suffix / transitive-bump case is the one that matters in practice:
 * the 2026-11-06 install produced 39 removed lockfile lines that were pnpm
 * re-resolution, not a deletion. A gate that fails on that would be bypassed
 * within a week, so R3 is name-set based and the test pins both directions.
 */
import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ALLOWED_NEW_DEPS, checkFrozen, lockImporterDeps, lockPackageKeys, packageNameOf,
  runFrozenGateCli,
} from '../../scripts/frozen-gate.mjs';

const HEAD_PKG = {
  name: 'ytvdlt',
  version: '0.1.0',
  private: true,
  devDependencies: { electron: '45.2.2', vitest: '3.2.4' },
  ytvdltPlannedDependencies: { 'electron-builder': '^26.0.0', 'electron-updater': '^6.8.0' },
};

const HEAD_LOCK = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      electron:
        specifier: 45.2.2
        version: 45.2.2
      vitest:
        specifier: 3.2.4
        version: 3.2.4(@types/node@22.20.5)(tsx@4.23.15)

packages:

  electron@45.2.2:
    resolution: {integrity: sha512-aaa}
    engines: {node: '>=18'}

  rollup@4.67.5:
    resolution: {integrity: sha512-bbb}

  vitest@3.2.4(@types/node@22.20.5)(tsx@4.23.15):
    resolution: {integrity: sha512-ccc}
`;

/** What a real `pnpm add` looks like: peer suffix rewritten, a version bumped. */
const WORK_LOCK_INSTALLED = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      electron:
        specifier: 45.2.2
        version: 45.2.2
      electron-builder:
        specifier: ^26.0.0
        version: 26.18.0
      electron-updater:
        specifier: ^6.8.0
        version: 6.8.11
      vitest:
        specifier: 3.2.4
        version: 3.2.4(@types/debug@4.1.13)(@types/node@22.20.5)(jiti@2.7.0)(tsx@4.23.15)

packages:

  electron@45.2.2:
    resolution: {integrity: sha512-aaa}
    engines: {node: '>=18'}

  electron-builder@26.18.0:
    resolution: {integrity: sha512-ddd}

  electron-updater@6.8.11:
    resolution: {integrity: sha512-eee}

  rollup@4.68.0:
    resolution: {integrity: sha512-fff}

  vitest@3.2.4(@types/debug@4.1.13)(@types/node@22.20.5)(jiti@2.7.0)(tsx@4.23.15):
    resolution: {integrity: sha512-ccc}
`;

const clean = () => ({
  coreDiff: '',
  pkgHead: HEAD_PKG,
  pkgWork: HEAD_PKG,
  lockHead: HEAD_LOCK,
  lockWork: HEAD_LOCK,
  lockDiff: '',
});

describe('frozen gate · request.ts (R1)', () => {
  it('passes when nothing changed at all', () => {
    const verdict = checkFrozen(clean());
    expect(verdict.ok).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it('rejects any change to the D-50 frozen contract file', () => {
    const verdict = checkFrozen({ ...clean(), coreDiff: '@@ -1 +1 @@\n-export const A = 1;\n+export const A = 2;' });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join()).toContain('request.ts');
  });
});

describe('frozen gate · package.json (R2)', () => {
  it('accepts exactly the two allow-listed dependencies at the planned versions', () => {
    const pkgWork = {
      ...HEAD_PKG,
      devDependencies: {
        ...HEAD_PKG.devDependencies,
        'electron-builder': ALLOWED_NEW_DEPS['electron-builder'],
        'electron-updater': ALLOWED_NEW_DEPS['electron-updater'],
      },
    };
    const verdict = checkFrozen({ ...clean(), pkgWork });
    expect(verdict.ok).toBe(true);
  });

  it('accepts the allow-listed dependency even when declared before an existing one (order-insensitive)', () => {
    const pkgWork = {
      ...HEAD_PKG,
      devDependencies: {
        'electron-builder': ALLOWED_NEW_DEPS['electron-builder'],
        electron: '45.2.2',
        vitest: '3.2.4',
      },
    };
    expect(checkFrozen({ ...clean(), pkgWork }).ok).toBe(true);
  });

  it('rejects an unexpected version for an allow-listed dependency', () => {
    const pkgWork = {
      ...HEAD_PKG,
      devDependencies: { ...HEAD_PKG.devDependencies, 'electron-builder': '^27.0.0' },
    };
    const verdict = checkFrozen({ ...clean(), pkgWork });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join()).toContain('electron-builder');
  });

  it('rejects a dependency outside the allow-list', () => {
    const pkgWork = {
      ...HEAD_PKG,
      devDependencies: { ...HEAD_PKG.devDependencies, react: '^19.0.0' },
    };
    const verdict = checkFrozen({ ...clean(), pkgWork });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join()).toContain('react');
  });

  it('rejects deleting an existing dependency or retuning an existing version', () => {
    const dropped = { ...HEAD_PKG, devDependencies: { electron: '45.2.2' } };
    expect(checkFrozen({ ...clean(), pkgWork: dropped }).reasons.join()).toContain('vitest');

    const bumped = { ...HEAD_PKG, devDependencies: { electron: '45.2.2', vitest: '3.3.0' } };
    expect(checkFrozen({ ...clean(), pkgWork: bumped }).reasons.join()).toContain('vitest');
  });

  it('allows adding the licence field but nothing else at top level', () => {
    const withLicense = { ...HEAD_PKG, license: 'SEE LICENSE IN LICENSE' };
    expect(checkFrozen({ ...clean(), pkgWork: withLicense }).ok).toBe(true);

    const withExtra = { ...HEAD_PKG, repository: 'https://example.org/x' };
    const verdict = checkFrozen({ ...clean(), pkgWork: withExtra });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join()).toContain('repository');
  });

  it('rejects a non-string licence value', () => {
    const bad = { ...HEAD_PKG, license: { type: 'MIT' } };
    expect(checkFrozen({ ...clean(), pkgWork: bad }).ok).toBe(false);
  });

  it('rejects rewriting another top-level field (e.g. scripts)', () => {
    const pkgWork = { ...HEAD_PKG, scripts: { test: 'true' } };
    const verdict = checkFrozen({ ...clean(), pkgWork });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join()).toContain('scripts');
  });
});

describe('frozen gate · pnpm-lock.yaml (R3)', () => {
  it('accepts a real install: new packages, peer-suffix rewrite, transitive bump', () => {
    const pkgWork = {
      ...HEAD_PKG,
      devDependencies: {
        ...HEAD_PKG.devDependencies,
        'electron-builder': ALLOWED_NEW_DEPS['electron-builder'],
        'electron-updater': ALLOWED_NEW_DEPS['electron-updater'],
      },
    };
    const verdict = checkFrozen({ ...clean(), pkgWork, lockWork: WORK_LOCK_INSTALLED });
    expect(verdict.ok).toBe(true);
    expect(verdict.stats.addedPackages.sort()).toEqual(['electron-builder', 'electron-updater']);
    expect(verdict.stats.versionChanges).toBeGreaterThan(0);
  });

  it('rejects a package that disappears from the lockfile', () => {
    const lockWork = HEAD_LOCK.replace(/  rollup@4\.67\.5:\n    resolution: \{[^}]*\}\n\n/, '');
    expect(lockWork).not.toContain('rollup@4.67.5');
    const verdict = checkFrozen({ ...clean(), lockWork });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join()).toContain('rollup');
  });

  it('rejects a removed importer dependency declaration', () => {
    const lockWork = WORK_LOCK_INSTALLED.replace('      electron:\n        specifier: 45.2.2\n        version: 45.2.2\n', '');
    const verdict = checkFrozen({ ...clean(), lockWork });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join()).toContain('importer');
  });

  it('falls back to the strict diff rule when lockfile text is unavailable', () => {
    const verdict = checkFrozen({ ...clean(), lockHead: null, lockWork: null, lockDiff: '-  rollup@4.67.5:\n' });
    expect(verdict.ok).toBe(false);
  });
});

describe('frozen gate · lockfile parsing helpers', () => {
  it('lists package block keys and strips versions (scoped names included)', () => {
    const keys = lockPackageKeys(HEAD_LOCK);
    expect(keys).toEqual([
      'electron@45.2.2',
      'rollup@4.67.5',
      'vitest@3.2.4(@types/node@22.20.5)(tsx@4.23.15)',
    ]);
    expect(packageNameOf('@types/node@22.20.5')).toBe('@types/node');
    expect(packageNameOf('@vitest/coverage-v8@3.2.4(vitest@3.2.4)')).toBe('@vitest/coverage-v8');
  });

  it('reads importer declarations as importer|section|dependency', () => {
    expect([...lockImporterDeps(HEAD_LOCK)]).toEqual(['.|devDependencies|electron', '.|devDependencies|vitest']);
  });
});

/**
 * R1-09 — the gate must be able to FAIL.
 *
 * The file had no CLI entry for a long time, so `node scripts/frozen-gate.mjs`
 * imported the module and exited 0 without checking anything. These two cases
 * pin the property that was missing: a real git repository, read through the
 * same code path the CLI uses, PASSES only when the frozen file is untouched and
 * FAILS as soon as it is edited. Driven through `runFrozenGateCli(cwd)` rather
 * than a child process so the assertion is on the verdict, not on an exit code
 * nobody captured.
 */
describe('frozen gate · CLI resolution against a real repository (R1-09)', () => {
  /** Written as a constant so no escaping layer can turn it into a literal `\n`. */
  const NL = String.fromCharCode(10);
  const git = (cwd: string, args: string[]): string => String(
    spawnSync('git', args, {
      cwd, shell: false, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).stdout ?? '',
  );

  /**
   * D-181: git for Windows writes loose objects under `.git/objects` with the
   * read-only bit set, and Node's `rmSync({recursive, force})` does not clear
   * it — on this machine's Node (the Electron runtime), scratch-repo cleanup
   * in `finally` threw EPERM *after* every assertion had already passed,
   * turning a green run red. Clear the read-only bits first, and treat any
   * cleanup failure as best-effort: a leftover temp dir must never mask the
   * verdicts the assertions above already produced.
   */
  const rmScratch = (dir: string): void => {
    const clearReadOnly = (path: string): void => {
      let entries;
      try { entries = readdirSync(path, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) clearReadOnly(child);
        else { try { chmodSync(child, 0o666); } catch { /* best-effort */ } }
      }
    };
    try { clearReadOnly(dir); } catch { /* best-effort */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  };

  const scratchRepo = (): string | null => {
    const dir = mkdtempSync(join(tmpdir(), 'ytvdlt-frozen-'));
    git(dir, ['init', '-q']);
    if (!git(dir, ['rev-parse', '--is-inside-work-tree']).includes('true')) return null;
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', devDependencies: { vitest: '3.2.4' } }));
    // A lockfile shaped like the v9 blocks the parser reads: two-space keys
    // under `packages:`, one importer declaration under `importers:`.
    const lock = [
      'lockfileVersion: 9.0',
      'importers:',
      '  .:',
      '    devDependencies:',
      '      vitest:',
      '        specifier: 3.2.4',
      '        version: 3.2.4',
      'packages:',
      '',
      "  'vitest@3.2.4':",
      '    resolution: {integrity: sha512-x}',
      '',
    ].join(NL);
    writeFileSync(join(dir, 'pnpm-lock.yaml'), lock);
    mkdirSync(join(dir, 'packages', 'shared', 'src'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'shared', 'src', 'request.ts'), `export const frozen = 1;${NL}`);
    git(dir, ['add', '.']);
    git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base']);
    return dir;
  };

  it('passes when the frozen file is byte-identical to HEAD', () => {
    const dir = scratchRepo();
    if (dir === null) return;               // no usable git: SKIP, never a fake pass
    try {
      const verdict = runFrozenGateCli(dir);
      expect(verdict.ok).toBe(true);
      expect(verdict.reasons).toEqual([]);
    } finally { rmScratch(dir); }
  });

  it('fails as soon as the frozen file is edited in the working tree', () => {
    const dir = scratchRepo();
    if (dir === null) return;
    try {
      writeFileSync(join(dir, 'packages', 'shared', 'src', 'request.ts'), `export const frozen = 2;${NL}`);
      const verdict = runFrozenGateCli(dir);
      expect(verdict.ok).toBe(false);
      expect(verdict.reasons.join()).toContain('request.ts');
    } finally { rmScratch(dir); }
  });

  it('fails on a deleted dependency instead of passing quietly', () => {
    const dir = scratchRepo();
    if (dir === null) return;
    try {
      const pkg = { name: 'x', devDependencies: {} };
      writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
      const verdict = runFrozenGateCli(dir);
      expect(verdict.ok).toBe(false);
      expect(verdict.reasons.join()).toContain('vitest');
    } finally { rmScratch(dir); }
  });
});
