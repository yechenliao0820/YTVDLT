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
import {
  ALLOWED_NEW_DEPS, checkFrozen, lockImporterDeps, lockPackageKeys, packageNameOf,
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
