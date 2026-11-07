#!/usr/bin/env node
/**
 * L3 static layering guard (ARCHITECTURE §9.7), B0-extended for M3.
 *
 * Scans pure-TS packages AND the new `packages/ui/src` (static HTML/JS dialogs)
 * for forbidden imports. Pure-TS packages may never import electron / node:*
 * built-ins; the UI package may never import electron / node:fs / child_process
 * either (it talks to the main process only through `window.ytvdltBridge`).
 *
 * `collectSourceFiles` collects `.ts` / `.js` / `.mjs` (M3 UI is plain JS) while
 * the M1/M2 targets remain `.ts`-only in practice. Outputs "0 violations" on
 * success; exit 1 otherwise. Also exported as `scanForViolations()` so
 * tests/unit/layering.test.ts can re-run the identical scan inside `npm test`.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** M3 B0: the UI package is now a scan target (does not exist until B4). */
export const SCAN_TARGETS = [
  'packages/shared/src',
  'packages/core/src',
  'packages/engine-ytdlp/src',
  'packages/ui/src',
];

/** Import specifiers forbidden inside pure-TS packages. */
export const FORBIDDEN_MODULES = [
  'electron',
  'node:fs', 'node:fs/promises', 'fs', 'fs/promises',
  'node:child_process', 'child_process',
  'node:crypto', 'crypto',
  'node:os', 'os',
  'node:path', 'path',
];

/** M3 B0: UI is additionally forbidden from filesystem / process / electron. */
export const UI_FORBIDDEN_MODULES = [
  'electron',
  'node:fs', 'node:fs/promises', 'fs', 'fs/promises',
  'node:child_process', 'child_process',
];

/** Extensions collected per target. UI is plain JS; pure packages are TS. */
export const SOURCE_EXTENSIONS = ['.ts', '.js', '.mjs'];

const IMPORT_RE = /(?:\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)|\bexport\s+[^;]*?\sfrom\s*['"]([^'"]+)['"])/g;

async function collectSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collectSourceFiles(full));
    else if (entry.isFile() && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

/** @returns {Array<{file:string, line:number, specifier:string, forbidden:string}>} */
export async function scanForViolations(baseRoot = ROOT) {
  const violations = [];
  for (const target of SCAN_TARGETS) {
    const dir = join(baseRoot, ...target.split('/'));
    const forbiddenList = target === 'packages/ui/src' ? UI_FORBIDDEN_MODULES : FORBIDDEN_MODULES;
    let files;
    try { files = await collectSourceFiles(dir); } catch { continue; }
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const lines = source.split(/\r?\n/);
      lines.forEach((line, index) => {
        IMPORT_RE.lastIndex = 0;
        let match;
        while ((match = IMPORT_RE.exec(line)) !== null) {
          const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
          if (!specifier) continue;
          for (const forbidden of forbiddenList) {
            if (specifier === forbidden || specifier.startsWith(`${forbidden}/`)) {
              violations.push({
                file: target + '/' + file.slice(dir.length + 1).replace(/\\/g, '/'),
                line: index + 1,
                specifier,
                forbidden,
              });
            }
          }
        }
      });
    }
  }
  return violations;
}

async function main() {
  const violations = await scanForViolations();
  const asJson = process.argv.includes('--json');
  const payload = {
    checkedAt: new Date().toISOString(),
    targets: SCAN_TARGETS,
    sourceExtensions: SOURCE_EXTENSIONS,
    forbiddenModules: FORBIDDEN_MODULES,
    uiForbiddenModules: UI_FORBIDDEN_MODULES,
    violations,
    violationsCount: violations.length,
  };
  await mkdir(join(ROOT, 'reports'), { recursive: true });
  await writeFile(join(ROOT, 'reports', 'layering.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    process.exitCode = violations.length === 0 ? 0 : 1;
    return;
  }
  if (violations.length === 0) {
    console.log(`[check-layering] 0 violations (${SCAN_TARGETS.join(', ')})`);
    return;
  }
  console.error(`[check-layering] ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.specifier} (forbidden: ${v.forbidden})`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`[check-layering] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
