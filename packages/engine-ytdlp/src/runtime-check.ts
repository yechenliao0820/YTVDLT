/**
 * Guards / runtime-check for the engine (F045-adjacent).
 * Pure helpers: verify that the injected paths are absolute and that the
 * spawn options conform to the §4.3 spawn 铁律. No I/O, no `node:*` imports.
 */
import type { SpawnOptions } from '@ytvdlt/shared';

const WINDOWS_ABS = /^[A-Za-z]:[\\/]/;
const UNC_ABS = /^\\\\/;
const POSIX_ABS = /^\//;

/** True for a Windows drive path, UNC path, or POSIX absolute path. */
export function isAbsolutePath(path: string): boolean {
  return WINDOWS_ABS.test(path) || UNC_ABS.test(path) || POSIX_ABS.test(path);
}

/** Throws (plain Error) when the engine or JS runtime path is not absolute. */
export function assertAbsoluteRuntimePaths(enginePath: string, jsRuntimePath: string): void {
  if (!isAbsolutePath(enginePath)) {
    throw new Error(`enginePath must be absolute: ${enginePath}`);
  }
  if (!isAbsolutePath(jsRuntimePath)) {
    throw new Error(`jsRuntimePath must be absolute: ${jsRuntimePath}`);
  }
}

/** Assert the spawn options obey the frozen safety rules. */
export function assertSafeSpawnOptions(opts: SpawnOptions): void {
  if (opts.shell !== false) throw new Error('spawn must use shell:false');
  if (opts.windowsHide !== true) throw new Error('spawn must use windowsHide:true');
  // D-133: a ceiling that is not a positive integer would be treated as
  // "unbounded" by the adapter, so a typo (`0`, `-1`, `NaN`) would silently
  // turn the guard off exactly where it is meant to apply. Refuse it loudly.
  for (const [name, value] of [
    ['maxStdoutBytes', opts.maxStdoutBytes],
    ['maxStderrBytes', opts.maxStderrBytes],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer when set, got ${String(value)}`);
    }
  }
}
