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

// --- D-201 · load() first-load race ------------------------------------------

describe('D-201 · concurrent load() calls share one attempt', () => {
  /** Config on disk that differs from the defaults in one observable key. */
  const seededPorts = (): ReturnType<typeof createInMemoryPorts> => {
    const mem = createInMemoryPorts();
    const base = createDefaultConfig('2026-11-05T00:00:00.000Z');
    const onDisk = {
      ...base,
      domains: { ...base.domains, network: { ...base.domains['network'], maxRate: 500 } },
    };
    mem.state.files.set(CONFIG_PATH, JSON.stringify(onDisk));
    return mem;
  };

  it('the second concurrent caller waits for the real load instead of reading defaults', async () => {
    const { ports } = seededPorts();
    let readCalls = 0;
    let readFinished = false;
    const innerRead = ports.fs.readText.bind(ports.fs);
    ports.fs.readText = async (path: string): Promise<string> => {
      readCalls += 1;
      // Hold the load open long enough that a premature return is observable.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const text = await innerRead(path);
      readFinished = true;
      return text;
    };

    const store = new ConfigStore({ ports });
    const first = store.load();
    const second = store.load();
    await second;
    // The second caller may only resolve once the real load has finished.
    expect(readFinished).toBe(true);
    expect(store.get('network', 'maxRate')).toBe(500);
    await first;
    // Both callers shared ONE attempt — the file was not read twice.
    expect(readCalls).toBe(1);
  });

  it('a concurrent set() builds on the loaded file and never persists defaults over it', async () => {
    const { ports, state } = seededPorts();
    const innerRead = ports.fs.readText.bind(ports.fs);
    ports.fs.readText = async (path: string): Promise<string> => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return innerRead(path);
    };

    const store = new ConfigStore({ ports });
    const loading = store.load();
    const setting = store.set('saved_links', 'items', ['https://example.org/x']);
    await Promise.all([loading, setting]);

    const persisted = JSON.parse(state.files.get(CONFIG_PATH) ?? '{}') as {
      domains: Record<string, Record<string, unknown>>;
    };
    expect(persisted.domains.saved_links?.['items']).toEqual(['https://example.org/x']);
    // The on-disk value survived: the set() did not persist the defaults.
    expect(persisted.domains.network?.['maxRate']).toBe(500);
    expect(store.get('network', 'maxRate')).toBe(500);
  });

  it('a failing load rejects every concurrent caller once, then retries after recovery (D-246)', async () => {
    const { ports } = createInMemoryPorts();
    let fail = true;
    let mkdirCalls = 0;
    const innerWrite = ports.fs.writeTextAtomic.bind(ports.fs);
    ports.fs.writeTextAtomic = async (path: string, text: string): Promise<void> => {
      if (fail) throw new Error('simulated disk failure');
      return innerWrite(path, text);
    };
    const innerMkdir = ports.fs.mkdir.bind(ports.fs);
    ports.fs.mkdir = async (dir: string): Promise<void> => {
      mkdirCalls += 1;
      return innerMkdir(dir);
    };

    const store = new ConfigStore({ ports });
    const first = store.load();
    const second = store.load();
    // No silent default for the concurrent caller: both share the same refusal.
    await expect(first).rejects.toThrow('simulated disk failure');
    await expect(second).rejects.toThrow('simulated disk failure');

    // D-246: a failed attempt is NOT "loaded" — the memo is cleared and the
    // next load() is a REAL retry (HistoryStore D-227 contract; the pre-D-246
    // no-op-until-restart semantics intentionally replaced). The I/O runs again.
    fail = false;
    await expect(store.load()).resolves.toBeUndefined();
    expect(mkdirCalls).toBe(2);
  });
});

// --- D-246 · 读失败 ≠ 第一次运行；写入阻断 + 可重试 ----------------------------

describe('D-246 · 存在性探测拆除：读失败阻断写入、恢复后重试', () => {
  /** Config on disk whose value would be DESTROYED if defaults were persisted. */
  const seededPorts = (): ReturnType<typeof createInMemoryPorts> => {
    const mem = createInMemoryPorts();
    const base = createDefaultConfig('2026-11-05T00:00:00.000Z');
    const onDisk = {
      ...base,
      domains: {
        ...base.domains,
        network: { ...base.domains['network'], maxRate: 500 },
        paths: { ...base.domains['paths'], videoDir: 'D:/my/videos' },
      },
    };
    mem.state.files.set(CONFIG_PATH, JSON.stringify(onDisk));
    return mem;
  };

  const errnoError = (code: string): Error =>
    // Same shape as the production adapter's raw `fs.readFile` rejections
    // (Node ErrnoException): message + `code` field.
    Object.assign(new Error(`${code}: transient failure`), { code });

  it('(a) readText 抛 EACCES：load 拒绝、磁盘原样、无 corrupt 备份、set() 拒绝', async () => {
    const { ports, state } = seededPorts();
    const original = state.files.get(CONFIG_PATH) ?? '';
    ports.fs.readText = async (): Promise<string> => {
      throw errnoError('EACCES');
    };

    const store = new ConfigStore({ ports });
    await expect(store.load()).rejects.toThrow('EACCES');

    // The file on disk is byte-for-byte the original: no defaults were
    // written, no `config.corrupt-*` rename happened (a READ failure is not
    // corruption — the old code took the rename+defaults path here).
    expect(state.files.get(CONFIG_PATH)).toBe(original);
    expect([...state.files.keys()].filter((k) => k.includes('config.corrupt-'))).toHaveLength(0);

    // Every write path goes through load() first and refuses with the same
    // error — the in-memory defaults can never reach the disk.
    await expect(store.set('general', 'theme', 'dark')).rejects.toThrow('EACCES');
    await expect(store.setDomain('network', { maxRate: 5 })).rejects.toThrow('EACCES');
    await expect(store.import(JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, config: createDefaultConfig('x') })))
      .rejects.toThrow('EACCES');
    expect(state.files.get(CONFIG_PATH)).toBe(original);

    // Sync getters still answer for display (constructor defaults), but that
    // state is memory-only — proven by the untouched file above.
    expect(store.get('general', 'theme')).toBe('system');
    expect(store.get('network', 'maxRate')).toBe(0);
  });

  it('(b) 错误恢复后 load() 真重试成功，set() 随之恢复', async () => {
    const { ports, state } = seededPorts();
    const innerRead = ports.fs.readText.bind(ports.fs);
    let failures = 1;
    let readCalls = 0;
    ports.fs.readText = async (path: string): Promise<string> => {
      readCalls += 1;
      if (failures > 0) {
        failures -= 1;
        throw errnoError('EIO');
      }
      return innerRead(path);
    };

    const store = new ConfigStore({ ports });
    await expect(store.load()).rejects.toThrow('EIO');
    // The failed attempt did not flip the store to "loaded": the next call
    // re-runs the read instead of serving the constructor defaults forever.
    await store.load();
    expect(readCalls).toBe(2);
    expect(store.get('network', 'maxRate')).toBe(500);
    expect(store.get('paths', 'videoDir')).toBe('D:/my/videos');

    // Writes work again, and they build on the REAL loaded file.
    await store.set('saved_links', 'items', ['https://example.org/x']);
    const persisted = JSON.parse(state.files.get(CONFIG_PATH) ?? '{}') as {
      domains: Record<string, Record<string, unknown>>;
    };
    expect(persisted.domains.saved_links?.['items']).toEqual(['https://example.org/x']);
    expect(persisted.domains.network?.['maxRate']).toBe(500);
    expect(persisted.domains.paths?.['videoDir']).toBe('D:/my/videos');
  });

  it('(b2) 并发调用共享同一次读失败；恢复后重试一次成功（D-201 单飞不回退）', async () => {
    const { ports } = seededPorts();
    const innerRead = ports.fs.readText.bind(ports.fs);
    let failures = 1;
    let readCalls = 0;
    ports.fs.readText = async (path: string): Promise<string> => {
      readCalls += 1;
      if (failures > 0) {
        failures -= 1;
        throw errnoError('EBUSY');
      }
      return innerRead(path);
    };

    const store = new ConfigStore({ ports });
    const first = store.load();
    const second = store.load();
    // Both callers share ONE attempt and ONE rejection (no second read).
    await expect(first).rejects.toThrow('EBUSY');
    await expect(second).rejects.toThrow('EBUSY');
    expect(readCalls).toBe(1);

    failures = 0;
    await store.load();
    expect(readCalls).toBe(2);
    expect(store.get('network', 'maxRate')).toBe(500);
  });

  it('(c) 真正的 ENOENT 仍按首次运行：默认配置落盘', async () => {
    const { ports, state } = createInMemoryPorts();
    const store = new ConfigStore({ ports });
    await store.load();
    expect(state.files.has(CONFIG_PATH)).toBe(true);
    const persisted = JSON.parse(state.files.get(CONFIG_PATH) ?? '{}') as Record<string, unknown>;
    expect(persisted['schemaVersion']).toBe(CONFIG_SCHEMA_VERSION);
    expect(store.get('general', 'theme')).toBe('system');
    expect(store.get('paths', 'videoDir')).toBe('%USERVIDEOS%/YTVDLT');
    // The ENOENT path must not be confused with a failure: no WARNING, and a
    // following set() persists normally.
    expect(state.logLines.filter((l) => l.includes('config.corrupt'))).toHaveLength(0);
    await store.set('general', 'theme', 'dark');
    expect((JSON.parse(state.files.get(CONFIG_PATH) ?? '{}') as { domains: Record<string, Record<string, unknown>> })
      .domains.general?.['theme']).toBe('dark');
  });

  it('生产端口的 exists() 即使撒谎也不再有影响：探测零调用（误判不存在 + TOCTOU 双路径拆除）', async () => {
    const { ports, state } = seededPorts();
    let probes = 0;
    ports.fs.exists = async (): Promise<boolean> => {
      // Exactly what the production adapter does with a stat error — and what
      // the OLD performLoad consumed to decide "first run".
      probes += 1;
      return false;
    };

    const store = new ConfigStore({ ports });
    await store.load();
    // The read itself decides; the probe is never consulted.
    expect(probes).toBe(0);
    expect(store.get('network', 'maxRate')).toBe(500);
    expect(store.get('paths', 'videoDir')).toBe('D:/my/videos');
    const persisted = JSON.parse(state.files.get(CONFIG_PATH) ?? '{}') as {
      domains: Record<string, Record<string, unknown>>;
    };
    expect(persisted.domains.network?.['maxRate']).toBe(500);
    expect(state.files.get(CONFIG_PATH)?.includes('"D:/my/videos"')).toBe(true);
  });

  it('handleCorrupt：备份 rename 报 ENOENT（文件已消失）视为无可备份，回落默认不中断', async () => {
    const { ports, state } = createInMemoryPorts();
    state.files.set(CONFIG_PATH, fixture('config-corrupt.json'));
    let renameCalls = 0;
    ports.fs.rename = async (from: string, _to: string): Promise<void> => {
      renameCalls += 1;
      // The file vanished between the read and the backup rename.
      throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' });
    };

    const store = new ConfigStore({ ports });
    await store.load();
    expect(renameCalls).toBe(1);
    // The fallback still completed: defaults in memory, WARNING emitted.
    expect(store.get('general', 'concurrency')).toBe(3);
    const warnings = state.logLines.map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l['level'] === 'WARNING' && l['event'] === 'config.corrupt');
    expect(warnings.length).toBe(1);
    await store.set('general', 'theme', 'dark');
    expect(state.files.get(CONFIG_PATH)?.includes('"dark"')).toBe(true);
  });

  it('handleCorrupt：备份 rename 其它错误（EBUSY）仍 best-effort 吞掉，不阻断损坏回落', async () => {
    const { ports, state } = createInMemoryPorts();
    state.files.set(CONFIG_PATH, fixture('config-corrupt.json'));
    ports.fs.rename = async (): Promise<void> => {
      throw Object.assign(new Error('EBUSY: file locked'), { code: 'EBUSY' });
    };

    const store = new ConfigStore({ ports });
    await store.load();
    expect(store.get('general', 'concurrency')).toBe(3);
    const warnings = state.logLines.map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l['level'] === 'WARNING' && l['event'] === 'config.corrupt');
    expect(warnings.length).toBe(1);
    expect(warnings[0]?.['payload']).toMatchObject({ fallback: 'defaults' });
    // No rename happened, so the corrupt original is still in place and no
    // backup copy exists (best-effort means exactly that).
    expect(state.files.get(CONFIG_PATH)).toBe(fixture('config-corrupt.json'));
    expect([...state.files.keys()].filter((k) => k.includes('config.corrupt-'))).toHaveLength(0);
  });

  it('迁移写回失败是普通 IO 错误：不走 handleCorrupt（好文件不被改名回落），load 失败可重试', async () => {
    const { ports, state } = seededPorts();
    // A v0 config that NEEDS the migration write-back on load.
    const base = createDefaultConfig('2026-11-05T00:00:00.000Z');
    const legacy = { ...base, schemaVersion: 0, domains: { ...base.domains, general: { theme: 'light' } } };
    state.files.set(CONFIG_PATH, JSON.stringify(legacy));
    const original = state.files.get(CONFIG_PATH) ?? '';

    let failures = 1;
    const innerWrite = ports.fs.writeTextAtomic.bind(ports.fs);
    ports.fs.writeTextAtomic = async (path: string, text: string): Promise<void> => {
      if (failures > 0) {
        failures -= 1;
        throw Object.assign(new Error('EIO: migration write failed'), { code: 'EIO' });
      }
      return innerWrite(path, text);
    };

    const store = new ConfigStore({ ports, migrations: MIGRATIONS });
    // The OLD code caught this inside the corrupt-try: the VALID file was
    // renamed to config.corrupt-* and defaults took over. Now it is a load
    // failure: no rename, no WARNING, file untouched.
    await expect(store.load()).rejects.toThrow('EIO');
    expect(state.files.get(CONFIG_PATH)).toBe(original);
    expect([...state.files.keys()].filter((k) => k.includes('config.corrupt-'))).toHaveLength(0);
    expect(state.logLines.filter((l) => l.includes('config.corrupt'))).toHaveLength(0);

    // Recovery: the retry re-reads, migrates and writes back successfully.
    await store.load();
    expect(store.get('general', 'theme')).toBe('light');
    const persisted = JSON.parse(state.files.get(CONFIG_PATH) ?? '{}') as Record<string, unknown>;
    expect(persisted['schemaVersion']).toBe(CONFIG_SCHEMA_VERSION);
    await store.set('general', 'concurrency', 2);
    expect(store.get('general', 'concurrency')).toBe(2);
  });
});

// --- 外部审计 P1 · 写路径 persist-first commit-after：写失败零内存半提交 -------

describe('ConfigStore · 写路径 persist-first commit-after（外部审计 P1）：写失败零内存半提交', () => {
  /**
   * Config on disk whose committed values are observable and distinct from
   * the defaults (same seed shape as the D-246 describe above).
   */
  const seededPorts = (): ReturnType<typeof createInMemoryPorts> => {
    const mem = createInMemoryPorts();
    const base = createDefaultConfig('2026-11-05T00:00:00.000Z');
    const onDisk = {
      ...base,
      domains: {
        ...base.domains,
        general: { ...base.domains['general'], theme: 'dark' },
        network: { ...base.domains['network'], maxRate: 500 },
      },
    };
    mem.state.files.set(CONFIG_PATH, JSON.stringify(onDisk));
    return mem;
  };

  const ioError = (): Error =>
    // Same shape as the production adapter's raw write rejections.
    Object.assign(new Error('EIO: config write failed'), { code: 'EIO' });

  it('set() 写盘失败：抛原错、内存与磁盘都停在旧值；随后的成功 set() 不把失败值带上盘', async () => {
    const { ports, state } = seededPorts();
    const store = new ConfigStore({ ports });
    await store.load();

    const boom = ioError();
    let fail = true;
    const innerWrite = ports.fs.writeTextAtomic.bind(ports.fs);
    ports.fs.writeTextAtomic = async (path: string, text: string): Promise<void> => {
      if (fail) throw boom;
      return innerWrite(path, text);
    };

    // The ORIGINAL error object surfaces unchanged — nothing swallowed.
    await expect(store.set('general', 'privateMode', true)).rejects.toBe(boom);
    // Memory stays on the committed values: the failed value never
    // half-commits (the old code already had privateMode=true here, so the
    // next enqueue built downloads on a value the UI had rolled back).
    expect(store.get('general', 'privateMode')).toBe(false);
    expect(store.get('general', 'theme')).toBe('dark');
    expect(store.getDomain('general')).toMatchObject({ theme: 'dark', privateMode: false });
    // The disk is byte-identical in content: memory agrees with it.
    const before = JSON.parse(state.files.get(CONFIG_PATH) ?? '{}') as {
      domains: Record<string, Record<string, unknown>>;
    };
    expect(before.domains.general?.['privateMode']).toBe(false);
    expect(before.domains.general?.['theme']).toBe('dark');

    // After recovery one ordinary successful set(): the disk contains ONLY
    // this change — the failed value did not leak into the later write.
    fail = false;
    await store.set('general', 'concurrency', 5);
    const after = JSON.parse(state.files.get(CONFIG_PATH) ?? '{}') as {
      domains: Record<string, Record<string, unknown>>;
    };
    expect(after.domains.general?.['concurrency']).toBe(5);
    expect(after.domains.general?.['privateMode']).toBe(false);
    expect(after.domains.general?.['theme']).toBe('dark');
    expect(store.get('general', 'concurrency')).toBe(5);
  });

  it('setDomain() 同款：写失败零内存变更，恢复后的成功写盘不含失败 patch', async () => {
    const { ports, state } = seededPorts();
    const store = new ConfigStore({ ports });
    await store.load();

    let fail = true;
    const innerWrite = ports.fs.writeTextAtomic.bind(ports.fs);
    ports.fs.writeTextAtomic = async (path: string, text: string): Promise<void> => {
      if (fail) throw ioError();
      return innerWrite(path, text);
    };

    await expect(store.setDomain('network', { maxRate: 12345, ipv4Only: true }))
      .rejects.toThrow('EIO: config write failed');
    // Memory stays on the committed values.
    expect(store.get('network', 'maxRate')).toBe(500);
    expect(store.get('network', 'ipv4Only')).toBe(false);
    expect(store.getDomain('network')).toMatchObject({ maxRate: 500, ipv4Only: false });
    const before = JSON.parse(state.files.get(CONFIG_PATH) ?? '{}') as {
      domains: Record<string, Record<string, unknown>>;
    };
    expect(before.domains.network?.['maxRate']).toBe(500);
    expect(before.domains.network?.['ipv4Only']).toBe(false);

    // Recovery: the successful write lands only its own patch — the failed
    // patch is in neither memory nor disk.
    fail = false;
    await store.setDomain('network', { concurrentFragments: 4 });
    const after = JSON.parse(state.files.get(CONFIG_PATH) ?? '{}') as {
      domains: Record<string, Record<string, unknown>>;
    };
    expect(after.domains.network?.['concurrentFragments']).toBe(4);
    expect(after.domains.network?.['maxRate']).toBe(500);
    expect(after.domains.network?.['ipv4Only']).toBe(false);
    expect(store.get('network', 'maxRate')).toBe(500);
  });

  it('import()：校验失败零副作用；写盘失败内存停在旧值，恢复后的成功写不含导入值', async () => {
    const { ports, state } = seededPorts();
    const store = new ConfigStore({ ports });
    await store.load();

    // (a) Validation failure (downgrade snapshot, rejected BEFORE the queue):
    // zero side effects — memory and disk untouched (pre-existing contract).
    const downgrade = JSON.stringify({ config: { ...createDefaultConfig('x'), schemaVersion: 99 } });
    await expect(store.import(downgrade)).rejects.toThrow('cannot import newer schema');
    expect(store.get('general', 'theme')).toBe('dark');
    expect(store.get('network', 'maxRate')).toBe(500);

    // (b) Valid snapshot but the write fails: this.state is unchanged (the
    // old code had already swapped the whole snapshot into memory here).
    const snapshot = createDefaultConfig('2026-11-05T00:00:00.000Z');
    snapshot.domains['general']['theme'] = 'light';
    snapshot.domains['network']['maxRate'] = 999;
    let fail = true;
    const innerWrite = ports.fs.writeTextAtomic.bind(ports.fs);
    ports.fs.writeTextAtomic = async (path: string, text: string): Promise<void> => {
      if (fail) throw ioError();
      return innerWrite(path, text);
    };
    await expect(store.import(JSON.stringify({ config: snapshot })))
      .rejects.toThrow('EIO: config write failed');
    expect(store.get('general', 'theme')).toBe('dark');
    expect(store.get('network', 'maxRate')).toBe(500);
    const disk = JSON.parse(state.files.get(CONFIG_PATH) ?? '{}') as {
      domains: Record<string, Record<string, unknown>>;
    };
    expect(disk.domains.network?.['maxRate']).toBe(500);
    expect(disk.domains.general?.['theme']).toBe('dark');

    // Recovery: the successful write lands only its own change — the
    // imported values (theme=light / maxRate=999) never reach the disk.
    fail = false;
    await store.set('general', 'concurrency', 5);
    const after = JSON.parse(state.files.get(CONFIG_PATH) ?? '{}') as {
      domains: Record<string, Record<string, unknown>>;
    };
    expect(after.domains.general?.['concurrency']).toBe(5);
    expect(after.domains.general?.['theme']).toBe('dark');
    expect(after.domains.network?.['maxRate']).toBe(500);
  });

  it('写失败后的普通读不抛错：get/getDomain/export 照常返回旧值，后续成功写入不被破坏', async () => {
    const { ports, state } = seededPorts();
    const store = new ConfigStore({ ports });
    await store.load();

    let fail = true;
    const innerWrite = ports.fs.writeTextAtomic.bind(ports.fs);
    ports.fs.writeTextAtomic = async (path: string, text: string): Promise<void> => {
      if (fail) throw ioError();
      return innerWrite(path, text);
    };
    await expect(store.set('paths', 'videoDir', 'D:/my/videos')).rejects.toThrow('EIO');

    // Ordinary reads answer normally and report the OLD committed values —
    // memory holds no trace of the failed write.
    expect(store.get('paths', 'videoDir')).toBe('%USERVIDEOS%/YTVDLT');
    expect(store.getDomain('network')).toMatchObject({ maxRate: 500 });
    const exported = JSON.parse(await store.export()) as {
      config: { domains: Record<string, Record<string, unknown>> };
    };
    expect(exported.config.domains['paths']?.['videoDir']).toBe('%USERVIDEOS%/YTVDLT');
    expect(exported.config.domains['general']?.['theme']).toBe('dark');

    // The write queue is not poisoned by the failure: the next successful
    // write persists completely and builds on the unchanged baseline.
    fail = false;
    await store.set('network', 'maxRate', 0);
    const persisted = JSON.parse(state.files.get(CONFIG_PATH) ?? '{}') as {
      domains: Record<string, Record<string, unknown>>;
    };
    expect(persisted.domains.network?.['maxRate']).toBe(0);
    expect(persisted.domains.paths?.['videoDir']).toBe('%USERVIDEOS%/YTVDLT');
    expect(store.get('paths', 'videoDir')).toBe('%USERVIDEOS%/YTVDLT');
  });
});
