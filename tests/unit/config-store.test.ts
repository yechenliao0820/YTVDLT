/**
 * A-4.1-03 (saved_links persistence + corrupt fallback) and
 * A-4.4-19 (domains / schemaVersion / migration / atomic write).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigStore, CONFIG_SCHEMA_VERSION, createDefaultConfig, MIGRATIONS } from '@ytvdlt/core';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');

const CONFIG_PATH = 'C:/Users/test/AppData/Roaming/YTVDLT/config/config.json';

describe('A-4.4-19 ConfigStore · 分域 / schemaVersion / 原子写', () => {
  it('starts with 7 domains and the current CONFIG_SCHEMA_VERSION', async () => {
    const { ports } = createInMemoryPorts();
    const store = new ConfigStore({ ports });
    await store.load();
    expect(store.schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
    expect(store.get('general', 'concurrency')).toBe(3);
    expect(store.get('paths', 'outputTemplate')).toBe('%(title).200B [%(id)s].%(ext)s');
    expect(store.getDomain('subtitle')['languages']).toBe('en.*,.*-orig');
    for (const domain of ['general', 'format', 'subtitle', 'paths', 'network', 'advanced', 'saved_links'] as const) {
      expect(Object.keys(store.getDomain(domain)).length).toBeGreaterThan(0);
    }
  });

  it('D-147: the factory `general.language` is the "" sentinel ("not determined yet")', async () => {
    const { ports } = createInMemoryPorts();
    const store = new ConfigStore({ ports });
    await store.load();
    // Empty means the main process has not yet detected from the OS locale.
    // After the first-launch write-back the stored value is concrete forever.
    expect(store.get('general', 'language')).toBe('');
    // The other general defaults are untouched by D-147.
    expect(store.get('general', 'concurrency')).toBe(3);
    expect(store.get('general', 'theme')).toBe('system');
  });

  it('writes atomically via writeTextAtomic and persists a change across reload', async () => {
    const { ports, state } = createInMemoryPorts();
    const first = new ConfigStore({ ports });
    await first.load();
    await first.set('general', 'theme', 'dark');
    expect(state.files.has(CONFIG_PATH)).toBe(true);
    // tmp file is gone after the atomic rename.
    expect(state.files.has(`${CONFIG_PATH}.tmp`)).toBe(false);
    const persisted = JSON.parse(state.files.get(CONFIG_PATH) ?? '{}') as Record<string, unknown>;
    expect(persisted['schemaVersion']).toBe(CONFIG_SCHEMA_VERSION);

    const second = new ConfigStore({ ports });
    await second.load();
    expect(second.get('general', 'theme')).toBe('dark');
  });

  it('setDomain merges a patch without dropping other keys', async () => {
    const { ports } = createInMemoryPorts();
    const store = new ConfigStore({ ports });
    await store.load();
    await store.setDomain('network', { maxRate: 500 });
    expect(store.get('network', 'maxRate')).toBe(500);
    expect(store.get('network', 'concurrentFragments')).toBe(8);
  });

  it('migrates a v0 config through the pure migration chain', async () => {
    const base = createDefaultConfig('2026-11-05T00:00:00.000Z');
    const legacy = { ...base, schemaVersion: 0, domains: { ...base.domains, general: { theme: 'light' } } };
    const { ports, state } = createInMemoryPorts();
    state.files.set(CONFIG_PATH, JSON.stringify(legacy));
    const store = new ConfigStore({ ports, migrations: MIGRATIONS });
    await store.load();
    expect(store.get('general', 'theme')).toBe('light');
    expect(store.get('general', 'concurrency')).toBe(3);
    const persisted = JSON.parse(state.files.get(CONFIG_PATH) ?? '{}') as Record<string, unknown>;
    expect(persisted['schemaVersion']).toBe(CONFIG_SCHEMA_VERSION);
  });

  it('v1 -> v2 retires the ASCII-only filename default (D-110)', async () => {
    const base = createDefaultConfig('2026-11-05T00:00:00.000Z');
    const legacy = {
      ...base,
      schemaVersion: 1,
      domains: { ...base.domains, paths: { ...base.domains['paths'], restrictFilenames: true } },
    };
    const { ports, state } = createInMemoryPorts();
    state.files.set(CONFIG_PATH, JSON.stringify(legacy));
    const store = new ConfigStore({ ports, migrations: MIGRATIONS });
    await store.load();
    expect(store.get('paths', 'restrictFilenames')).toBe(false);
    // Everything else in the domain survives untouched.
    expect(store.get('paths', 'outputTemplate')).toBe(legacy.domains['paths']?.['outputTemplate']);
    const persisted = JSON.parse(state.files.get(CONFIG_PATH) ?? '{}') as Record<string, unknown>;
    expect(persisted['schemaVersion']).toBe(CONFIG_SCHEMA_VERSION);
  });

  it('v2 -> v3 retires the legacy network.maxRate placeholder 1000', async () => {
    const base = createDefaultConfig('2026-11-05T00:00:00.000Z');
    const legacy = {
      ...base,
      schemaVersion: 2,
      domains: { ...base.domains, network: { ...base.domains['network'], maxRate: 1000 } },
    };
    const { ports, state } = createInMemoryPorts();
    state.files.set(CONFIG_PATH, JSON.stringify(legacy));
    const store = new ConfigStore({ ports, migrations: MIGRATIONS });
    await store.load();
    // Back to the current default (0 = unlimited); without this the stored
    // pre-D-165 placeholder would become a real `-r 1000K` cap on upgrade.
    expect(store.get('network', 'maxRate')).toBe(0);
    // Everything else in the domain survives untouched.
    expect(store.get('network', 'concurrentFragments')).toBe(legacy.domains['network']?.['concurrentFragments']);
    expect(store.get('network', 'ipv4Only')).toBe(legacy.domains['network']?.['ipv4Only']);
    const persisted = JSON.parse(state.files.get(CONFIG_PATH) ?? '{}') as Record<string, unknown>;
    expect(persisted['schemaVersion']).toBe(CONFIG_SCHEMA_VERSION);
  });

  it('v2 -> v3 keeps a hand-edited maxRate (only the exact legacy 1000 is retired)', async () => {
    const base = createDefaultConfig('2026-11-05T00:00:00.000Z');
    const legacy = {
      ...base,
      schemaVersion: 2,
      domains: { ...base.domains, network: { ...base.domains['network'], maxRate: 2000 } },
    };
    const { ports, state } = createInMemoryPorts();
    state.files.set(CONFIG_PATH, JSON.stringify(legacy));
    const store = new ConfigStore({ ports, migrations: MIGRATIONS });
    await store.load();
    expect(store.get('network', 'maxRate')).toBe(2000);
    const persisted = JSON.parse(state.files.get(CONFIG_PATH) ?? '{}') as Record<string, unknown>;
    expect(persisted['schemaVersion']).toBe(CONFIG_SCHEMA_VERSION);
  });

  it('v2 -> v3 leaves a config without a maxRate key alone', async () => {
    const base = createDefaultConfig('2026-11-05T00:00:00.000Z');
    const { maxRate: _omitted, ...networkWithoutMaxRate } = base.domains['network'];
    const legacy = {
      ...base,
      schemaVersion: 2,
      domains: { ...base.domains, network: networkWithoutMaxRate },
    };
    const { ports, state } = createInMemoryPorts();
    state.files.set(CONFIG_PATH, JSON.stringify(legacy));
    const store = new ConfigStore({ ports, migrations: MIGRATIONS });
    await store.load();
    expect(store.get('network', 'maxRate')).toBeUndefined();
    // The version still moves to 3 even though no value was rewritten.
    const persisted = JSON.parse(state.files.get(CONFIG_PATH) ?? '{}') as Record<string, unknown>;
    expect(persisted['schemaVersion']).toBe(CONFIG_SCHEMA_VERSION);
  });

  it('a v0 config with the legacy maxRate 1000 walks the whole chain and lands on 0', async () => {
    const base = createDefaultConfig('2026-11-05T00:00:00.000Z');
    const legacy = {
      ...base,
      schemaVersion: 0,
      domains: { ...base.domains, network: { ...base.domains['network'], maxRate: 1000 } },
    };
    const { ports, state } = createInMemoryPorts();
    state.files.set(CONFIG_PATH, JSON.stringify(legacy));
    const store = new ConfigStore({ ports, migrations: MIGRATIONS });
    await store.load();
    expect(store.get('network', 'maxRate')).toBe(0);
    expect(store.get('paths', 'restrictFilenames')).toBe(false);
    const persisted = JSON.parse(state.files.get(CONFIG_PATH) ?? '{}') as Record<string, unknown>;
    expect(persisted['schemaVersion']).toBe(CONFIG_SCHEMA_VERSION);
  });

  it('downgrade (schemaVersion > 1) falls back to defaults and emits WARNING', async () => {
    const { ports, state } = createInMemoryPorts();
    state.files.set(CONFIG_PATH, JSON.stringify({ ...createDefaultConfig('x'), schemaVersion: 99 }));
    const store = new ConfigStore({ ports });
    await store.load();
    expect(store.get('general', 'concurrency')).toBe(3);
    const warnings = state.logLines.map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l['level'] === 'WARNING' && l['event'] === 'config.corrupt');
    expect(warnings.length).toBe(1);
  });
});

describe('A-4.1-03 ConfigStore · saved_links 重启保持 + 损坏回退 WARNING', () => {
  it('persists 2 saved links across a fresh instance (simulated restart)', async () => {
    const { ports } = createInMemoryPorts();
    const store = new ConfigStore({ ports });
    await store.load();
    await store.set('saved_links', 'items', ['https://example.org/a', 'https://example.org/b']);
    const restarted = new ConfigStore({ ports });
    await restarted.load();
    expect(restarted.get<string[]>('saved_links', 'items')).toEqual([
      'https://example.org/a', 'https://example.org/b',
    ]);
  });

  it('loads the recorded valid fixture (2 saved links) without mutation', async () => {
    const { ports, state } = createInMemoryPorts();
    state.files.set(CONFIG_PATH, fixture('config-valid.json'));
    const store = new ConfigStore({ ports });
    await store.load();
    expect(store.get<string[]>('saved_links', 'items')).toHaveLength(2);
    expect(store.get('subtitle', 'languages')).toBe('zh.*,en.*');
  });

  it('corrupt JSON -> defaults + WARNING + backup file (does NOT delete user data)', async () => {
    const { ports, state } = createInMemoryPorts();
    state.files.set(CONFIG_PATH, fixture('config-corrupt.json'));
    const store = new ConfigStore({ ports });
    await store.load();
    expect(store.get('general', 'concurrency')).toBe(3);
    expect(store.get<string[]>('saved_links', 'items')).toEqual([]);
    const backups = [...state.files.keys()].filter((k) => k.includes('config.corrupt-'));
    expect(backups.length).toBe(1);
    expect(state.files.get(backups[0] ?? '')).toContain('"theme"');
    const warnings = state.logLines.map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l['level'] === 'WARNING' && l['event'] === 'config.corrupt');
    expect(warnings.length).toBe(1);
    expect(warnings[0]?.['payload']).toMatchObject({ fallback: 'defaults' });
  });

  it('export()/import() round-trips a schema-versioned snapshot (M1 placeholder)', async () => {
    const { ports } = createInMemoryPorts();
    const store = new ConfigStore({ ports });
    await store.load();
    await store.set('saved_links', 'items', ['https://example.org/x']);
    const snapshot = await store.export();
    const restored = new ConfigStore({ ports: createInMemoryPorts().ports });
    await restored.load();
    await restored.import(snapshot);
    expect(restored.get<string[]>('saved_links', 'items')).toEqual(['https://example.org/x']);
  });
});
