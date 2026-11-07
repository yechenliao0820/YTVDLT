#!/usr/bin/env node
/**
 * `node scripts/verify-artifact.mjs --expect <manifest.json> --actual <path> [--json]`
 *
 * Runs the REAL Core `ArtifactVerifier` (C1–C12) against a file on disk using
 * the same Node ports as production, and writes
 * `reports/artifact-verification.json` (M2-F032 / A-M2-24).
 *
 * Flags:
 *   --expect <path>       fixture manifest JSON (sha256/sizeBytes/durationSec/...)
 *   --actual <path>       artifact to verify
 *   --postprocessed       treat the artifact as post-processed (selects C8, not C2)
 *   --kind audio|video    stream expectations for C6 (default video)
 *   --history <path>      optional history.json to pull the C11 entry from
 *   --json                print the VerificationReport to stdout
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SELF = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SELF));

// Re-exec under tsx so we can import the pure-TS Core verifier.
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
const { ArtifactVerifier } = await import('../packages/core/src/artifact-verifier/index.ts');

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const expectPath = option('--expect');
const actualPath = option('--actual');
const asJson = process.argv.includes('--json');
const postprocessed = process.argv.includes('--postprocessed');
const kind = (option('--kind', 'video') ?? 'video') === 'audio' ? 'audio' : 'video';
const historyPath = option('--history');

if (!expectPath || !actualPath) {
  console.error('[verify-artifact] usage: --expect <manifest.json> --actual <artifact> [--json] [--postprocessed] [--kind audio|video]');
  process.exit(3);
}

const RUNTIME_DIR = join(ROOT, 'resources', 'runtime', 'win-x64');
const APP_DATA = join(process.env['APPDATA'] ?? ROOT, 'YTVDLT');

const rawManifest = JSON.parse(await readFile(expectPath, 'utf8'));
const expectedManifest = {
  sha256: rawManifest.sha256,
  sizeBytes: rawManifest.sizeBytes,
  durationSec: rawManifest.durationSec,
  videoCodec: rawManifest.videoCodec ?? '',
  audioCodec: rawManifest.audioCodec ?? '',
  expectedFormat: rawManifest.expectedFormat ?? null,
  c8Golden: rawManifest.c8Golden ?? null,
};

let historyEntry = null;
if (historyPath) {
  try {
    const parsed = JSON.parse(await readFile(historyPath, 'utf8'));
    const entries = Array.isArray(parsed) ? parsed : (parsed.entries ?? []);
    historyEntry = entries[0] ?? null;
  } catch {
    historyEntry = null;
  }
}

const ports = createNodePorts({
  packaged: false,
  resourcesPath: join(ROOT, 'resources'),
  runtimeDir: RUNTIME_DIR,
  appDataDir: APP_DATA,
  configDir: join(APP_DATA, 'config'),
  logsDir: join(APP_DATA, 'logs'),
  appVersion: '0.1.0',
});

const verifier = new ArtifactVerifier({ ports });
const report = await verifier.verify({
  taskId: rawManifest.taskId ?? 'verify-artifact',
  artifacts: [actualPath],
  // No probe MediaInfo here: C5 falls back to expectedManifest.durationSec (D-20).
  expected: null,
  postprocessed,
  expectedManifest,
  historyEntry,
  kind,
});

await mkdir(join(ROOT, 'reports'), { recursive: true });
await writeFile(join(ROOT, 'reports', 'artifact-verification.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  for (const criterion of report.criteria) {
    console.log(`${criterion.id.padEnd(3)} ${criterion.status.padEnd(8)} ${criterion.detail}`);
  }
  console.log(`ok=${report.ok} failureCode=${report.failureCode ?? 'null'} postprocessed=${report.postprocessed}`);
}
process.exitCode = report.ok ? 0 : 1;
