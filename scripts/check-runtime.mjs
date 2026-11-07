#!/usr/bin/env node
/**
 * `npm run check-runtime` entry (P0-13 / A-INF-04).
 *
 * Shares the ONE implementation of self-check: it loads the pure-TS Core
 * `checkRuntime()` and the Node port adapter through `tsx` — it does NOT
 * reimplement hash/version logic (ARCHITECTURE D2).
 *
 * To make the raw command `node scripts/check-runtime.mjs --json` work too,
 * the script self-bootstraps `--import tsx` via a one-time re-exec.
 *
 * Exit codes: 0 = 3 required OK; 2 = a required component failed;
 *             3 = manifest / script-level error.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';

const SELF = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SELF));

if (process.env['YTVDLT_TSX_BOOTSTRAPPED'] !== '1') {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', SELF, ...process.argv.slice(2)],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, YTVDLT_TSX_BOOTSTRAPPED: '1' },
      windowsHide: true,
    },
  );
  process.exit(result.status ?? (result.signal ? 2 : 3));
}

const { createNodePorts } = await import('../apps/desktop/src/main/adapters/node-ports.ts');
const { resolveRuntimeDir } = await import('../apps/desktop/src/main/runtime-paths.ts');
const { checkRuntime } = await import('../packages/core/src/index.ts');

const asJson = process.argv.includes('--json');
const RUNTIME_DIR = resolveRuntimeDir({
  isPackaged: () => false,
  resourcesPath: () => join(ROOT, 'resources'),
});
const APP_DATA = join(process.env['APPDATA'] ?? ROOT, 'YTVDLT');
const CONFIG_DIR = join(APP_DATA, 'config');
const LOGS_DIR = join(APP_DATA, 'logs');
const MANIFEST_PATH = join(RUNTIME_DIR, 'runtime-manifest.json');

function humanTable(report) {
  const pad = (text, width) => String(text).padEnd(width);
  const lines = [
    `${pad('GROUP', 10)} ${pad('STATUS', 15)} ${pad('REQUIRED', 9)} ${pad('VERSION', 24)} PATH`,
    '─'.repeat(110),
  ];
  for (const item of report.items) {
    lines.push(
      `${pad(item.kind, 10)} ${pad(item.status, 15)} ${pad(item.required ? 'yes' : 'optional', 9)} ` +
      `${pad(item.version || '-', 24)} ${item.absoluteDir || '-'}` +
      (item.errorCode ? `  [${item.errorCode}]` : ''),
    );
  }
  lines.push(`allRequiredOk=${report.allRequiredOk}  summary=${JSON.stringify(report.summary)}`);
  lines.push(`runtimeDir=${report.runtimeDir}`);
  return lines.join('\n');
}

async function main() {
  await mkdir(CONFIG_DIR, { recursive: true });
  await mkdir(LOGS_DIR, { recursive: true });
  const ports = createNodePorts({
    packaged: false,
    resourcesPath: join(ROOT, 'resources'),
    runtimeDir: RUNTIME_DIR,
    appDataDir: APP_DATA,
    configDir: CONFIG_DIR,
    logsDir: LOGS_DIR,
    appVersion: '0.1.0',
  });

  let report;
  try {
    report = await checkRuntime(ports, MANIFEST_PATH);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = {
      schemaVersion: 1,
      platform: 'win-x64',
      checkedAt: new Date().toISOString(),
      packaged: false,
      runtimeDir: RUNTIME_DIR,
      allRequiredOk: false,
      summary: { requiredOk: 0, requiredTotal: 3, optionalMissing: 0, failed: 3 },
      items: [],
      errorCode: 'UNKNOWN',
      error: message,
      manifestPath: MANIFEST_PATH,
    };
    if (asJson) console.log(JSON.stringify(failure, null, 2));
    else console.error(`[check-runtime] UNKNOWN: ${message}`);
    await mkdir(join(ROOT, 'reports'), { recursive: true });
    await writeFile(join(ROOT, 'reports', 'check-runtime.json'), `${JSON.stringify(failure, null, 2)}\n`, 'utf8');
    process.exitCode = 3;
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(humanTable(report));
    const failed = report.items.filter((i) => i.status !== 'OK' && i.status !== 'OPTIONAL');
    for (const item of failed) {
      console.error(`[check-runtime] ${item.kind}: ${item.status} ${item.errorCode ?? ''} — ${item.message}`);
    }
  }
  await mkdir(join(ROOT, 'reports'), { recursive: true });
  await writeFile(join(ROOT, 'reports', 'check-runtime.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.exitCode = report.allRequiredOk ? 0 : 2;
}

main().catch((error) => {
  console.error(`[check-runtime] fatal: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 3;
});
