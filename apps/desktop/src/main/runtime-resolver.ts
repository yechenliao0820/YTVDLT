/**
 * Electron assembly layer — the ONLY `import { app } from 'electron'` point.
 * Reads `app.isPackaged`, assembles Node ports, then delegates to the pure-TS
 * Core `checkRuntime()`. No window, no UI, no IPC in M1.
 */
import { app } from 'electron';
import { join } from 'node:path';
import type { RuntimeCheckReport } from '@ytvdlt/shared';
import { checkRuntime } from '@ytvdlt/core';
import { createNodePorts } from './adapters/node-ports.js';
import { resolveRuntimeDir } from './runtime-paths.js';

export async function checkRuntimeForApp(): Promise<RuntimeCheckReport> {
  const packaged = app.isPackaged;
  const resourcesPath = process.resourcesPath ?? '';
  const runtimeDir = resolveRuntimeDir({
    isPackaged: () => packaged,
    resourcesPath: () => resourcesPath,
  });
  const appDataDir = join(process.env['APPDATA'] ?? process.cwd(), 'YTVDLT');
  const configDir = join(appDataDir, 'config');
  const logsDir = join(appDataDir, 'logs');

  const ports = createNodePorts({
    packaged,
    resourcesPath,
    runtimeDir,
    appDataDir,
    configDir,
    logsDir,
    appVersion: app.getVersion(),
  });

  return checkRuntime(ports, join(runtimeDir, 'runtime-manifest.json'));
}
