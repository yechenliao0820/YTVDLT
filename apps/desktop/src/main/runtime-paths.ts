/**
 * Pure path resolution for dev vs packaged runtime layout (§9.1).
 * `node:path` is confined to the adapter layer; Core never imports it.
 */
import { join, resolve } from 'node:path';
import type { EnvPort } from '@ytvdlt/shared';

export type RuntimePathEnv = Pick<EnvPort, 'isPackaged' | 'resourcesPath'>;

/**
 * Development: `<projectRoot>/resources/runtime/win-x64`
 * Packaged:    `<process.resourcesPath>/runtime`  (extraResources flattens win-x64/)
 */
/**
 * Development: `<projectRoot>/resources/runtime/win-x64`
 * Packaged:    `<process.resourcesPath>/runtime`  (extraResources flattens win-x64/)
 *
 * `cwd` is injectable so the dev branch is testable without chdir.
 */
export function resolveRuntimeDir(env: RuntimePathEnv, cwd: string = process.cwd()): string {
  return env.isPackaged()
    ? join(env.resourcesPath(), 'runtime')
    : resolve(cwd, 'resources', 'runtime', 'win-x64');
}

/**
 * Where the recorded M3 fixtures live (M5-4 / §6.2-⑤).
 *
 * Dev:      `<cwd>/tests/fixtures`
 * Packaged: `<resourcesPath>/fixtures` — the PROBE channel is a development
 *           leftover (D-31); fixtures are deliberately NOT shipped, so the
 *           channel fails with a normal error instead of reading the wrong
 *           file from an inherited `cwd`.
 *
 * The point is that `process.cwd()` never leaks into a packaged run.
 */
export function resolveFixtureDir(env: RuntimePathEnv, cwd: string): string {
  return env.isPackaged()
    ? join(env.resourcesPath(), 'fixtures')
    : resolve(cwd, 'tests', 'fixtures');
}
