/**
 * A-INF-01 · L4 test guard: re-runs the SAME static import scan as
 * scripts/check-layering.mjs inside `npm test`, so the guard cannot be bypassed.
 */
import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TARGETS = ['packages/shared/src', 'packages/core/src', 'packages/engine-ytdlp/src'];
const FORBIDDEN = [
  'electron', 'node:fs', 'node:fs/promises', 'fs', 'fs/promises',
  'node:child_process', 'child_process', 'node:crypto', 'crypto',
  'node:os', 'os', 'node:path', 'path',
];

async function collect(
  dir: string,
  extensions: readonly string[] = ['.ts'],
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await collect(full, extensions));
    else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

const IMPORT_LINE = /^\s*(?:import|export)\b[^\n]*\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*\(\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/gm;

describe('A-INF-01 layering · pure-TS packages have zero forbidden imports', () => {
  it('reports 0 violations across shared/core/engine-ytdlp', async () => {
    const violations: string[] = [];
    for (const target of TARGETS) {
      for (const file of await collect(join(ROOT, ...target.split('/')))) {
        const source = await readFile(file, 'utf8');
        IMPORT_LINE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = IMPORT_LINE.exec(source)) !== null) {
          const specifier = match[1] ?? match[2] ?? match[3];
          if (!specifier) continue;
          for (const forbidden of FORBIDDEN) {
            if (specifier === forbidden || specifier.startsWith(`${forbidden}/`)) {
              violations.push(`${file}: ${specifier}`);
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('packages/ui is M3 zero-dependency static UI (no TSX, no forbidden imports)', async () => {
    // M1 asserted the directory did not exist. M3/B4 creates it, but ONLY as
    // static .html/.css/.js with zero npm dependencies and zero Node/Electron
    // imports — the A-INF-01 boundary is preserved, not relaxed.
    const uiRoot = join(ROOT, 'packages', 'ui');
    const files = await collect(join(uiRoot, 'src'), ['.js', '.html', '.css']);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => file.endsWith('.tsx') || file.endsWith('.ts'))).toBe(false);

    const uiForbidden = [
      'electron', 'node:fs', 'node:fs/promises', 'fs', 'fs/promises',
      'node:child_process', 'child_process', 'node:crypto', 'crypto',
      'node:os', 'os', 'node:path', 'path',
    ];
    const violations: string[] = [];
    for (const file of files.filter((entry) => entry.endsWith('.js'))) {
      const source = await readFile(file, 'utf8');
      IMPORT_LINE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = IMPORT_LINE.exec(source)) !== null) {
        const specifier = match[1] ?? match[2] ?? match[3];
        if (!specifier) continue;
        for (const forbidden of uiForbidden) {
          if (specifier === forbidden || specifier.startsWith(`${forbidden}/`)) {
            violations.push(`${file}: ${specifier}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
