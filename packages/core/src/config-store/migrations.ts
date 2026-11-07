/**
 * Pure migration chain (`from -> to`). M1 ships the v1 baseline plus the
 * framework; a v0 -> v1 migration is included so the chain is executable and
 * unit-testable. Downgrades (schemaVersion > current) are NOT migrated —
 * ConfigStore falls back to defaults and emits a WARNING instead.
 */
import { CONFIG_SCHEMA_VERSION, createDefaultConfig, type ConfigFile } from './defaults.js';

export interface Migration {
  from: number;
  to: number;
  /** Pure function: never mutate the input, always return a new document. */
  migrate(old: ConfigFile): ConfigFile;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    from: 0,
    to: 1,
    migrate(old: ConfigFile): ConfigFile {
      const base = createDefaultConfig(old.updatedAt);
      const merged: Record<string, Record<string, unknown>> = {};
      for (const [name, defaults] of Object.entries(base.domains)) {
        merged[name] = { ...defaults, ...(old.domains[name as keyof ConfigFile['domains']] ?? {}) };
      }
      return {
        schemaVersion: 1,
        updatedAt: base.updatedAt,
        domains: merged as ConfigFile['domains'],
      };
    },
  },
] as const;

/** Pure: apply migrations in order until the document reaches the target version. */
export function applyMigrations(
  doc: ConfigFile,
  chain: readonly Migration[] = MIGRATIONS,
): ConfigFile {
  let current = doc;
  let guard = 0;
  while (current.schemaVersion < CONFIG_SCHEMA_VERSION) {
    const step = chain.find((m) => m.from === current.schemaVersion);
    if (!step) break;
    current = step.migrate(current);
    guard += 1;
    if (guard > 32) break;
  }
  return current;
}

/** True when the schema version is newer than this build (unsafe downgrade). */
export function isDowngrade(schemaVersion: number): boolean {
  return schemaVersion > CONFIG_SCHEMA_VERSION;
}
