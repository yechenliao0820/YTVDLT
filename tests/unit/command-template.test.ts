/**
 * M4-5 · command templates + allowlist + task log (原始验收 ④).
 *
 * The 12 malicious inputs below are the acceptance list: `--exec`,
 * `--config-locations`, shell pipes, absolute-path injection, `..` traversal,
 * the reserved `--`, unknown options, dangling options, flag-with-value,
 * control characters, command substitution and `--cookies-from-browser`.
 * EVERY one must be rejected with `CUSTOM_COMMAND_REJECTED` and never executed.
 */
import { describe, it, expect } from 'vitest';
import {
  validateTemplateArgs, CommandTemplateStore, TaskLogBuffer, ALLOWED_CUSTOM_OPTIONS,
} from '@ytvdlt/core';
import { buildCustomDownload } from '@ytvdlt/engine-ytdlp';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const CTX = {
  jsRuntimePath: 'C:/runtime/node.exe',
  ffmpegDir: 'C:/runtime/ffmpeg',
  artifactManifestPath: 'C:/temp/artifacts.txt',
};

const expectRejected = (args: readonly unknown[], reason?: RegExp): void => {
  const result = validateTemplateArgs(args);
  expect(result.ok, `expected rejection for ${JSON.stringify(args)}`).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe('CUSTOM_COMMAND_REJECTED');
    if (reason !== undefined) expect(result.reason).toMatch(reason);
  }
};

describe('M4-5 · allowlist accepts a legitimate template', () => {
  it('accepts the documented safe option set', () => {
    expect(validateTemplateArgs([
      '-f', 'bestvideo[height<=1080]+bestaudio/best',
      '--merge-output-format', 'mkv',
      '--embed-subs',
      '--sub-langs', 'zh.*,en.*',
      '--convert-subs', 'srt',
      '--embed-metadata',
      '--rate-limit', '500K',
      '-R', '3',
      '--concurrent-fragments', '8',
      '--cookies', 'C:/Users/test/cookies.txt',
      '-o', '%(title)s.%(ext)s',
    ]).ok).toBe(true);
  });

  it('exposes the allowlist as data (so the UI can render a picker)', () => {
    expect(Object.keys(ALLOWED_CUSTOM_OPTIONS)).toContain('--format');
    expect(Object.keys(ALLOWED_CUSTOM_OPTIONS)).toContain('--embed-subs');
    expect(Object.keys(ALLOWED_CUSTOM_OPTIONS)).not.toContain('--exec');
  });
});

describe('M4-5 · 12 类恶意输入全部拒绝（原始验收 ④）', () => {
  const CASES: Array<{ name: string; args: string[]; reason: RegExp }> = [
    { name: '1 --exec 执行外部程序', args: ['--exec', 'calc.exe'], reason: /denied option --exec/ },
    { name: '2 --config-locations 读取外部配置', args: ['--config-locations', 'C:/evil.conf'], reason: /denied option/ },
    { name: '3 --cookies-from-browser 偷取浏览器 cookie', args: ['--cookies-from-browser', 'chrome'], reason: /denied option/ },
    { name: '4 管道符注入', args: ['-o', 'a|calc.exe'], reason: /shell metacharacter/ },
    { name: '5 分号串联命令', args: ['-o', 'a; rm -rf /'], reason: /shell metacharacter/ },
    { name: '6 命令替换 $(...)', args: ['-o', '$(whoami)'], reason: /shell metacharacter/ },
    { name: '7 反引号执行', args: ['-o', '`whoami`'], reason: /shell metacharacter/ },
    { name: '8 绝对路径注入（输出模板）', args: ['-o', 'C:/Windows/System32/drivers/etc/hosts'], reason: /must be relative/ },
    { name: '9 目录穿越', args: ['-o', '../../Windows/System32/x'], reason: /path traversal/ },
    { name: '10 保留的 -- 分隔符', args: ['--embed-subs', '--', 'https://evil.example/x'], reason: /separator is reserved/ },
    { name: '11 白名单外选项（--ppa）', args: ['--ppa', 'ffmpeg:-vf'], reason: /not in allowlist|denied option/ },
    { name: '12 选项缺值', args: ['--sub-langs'], reason: /missing its value/ },
    { name: '13 标志位带值', args: ['--embed-subs', 'yes'], reason: /takes no value/ },
    { name: '14 控制字符/换行', args: ['-o', 'a\nb'], reason: /control character|shell metacharacter|invalid/ },
    { name: '15 值伪装成选项', args: ['--sub-langs', '--exec'], reason: /missing its value|looks like an option/ },
    { name: '16 超长参数', args: ['-o', 'x'.repeat(300)], reason: /too long/ },
  ];

  it.each(CASES)('$name', ({ args, reason }) => {
    expectRejected(args, reason);
  });

  it('rejects a whitespace-containing format id (argv tokens never carry blanks)', () => {
    expectRejected(['-f', '137 251'], /invalid format id/);
    expect(validateTemplateArgs(['-f', '137+251']).ok).toBe(true);
  });

  it('rejects non-array / empty / oversized argv', () => {
    expectRejected([], /must not be empty/);
    expectRejected([1, 2], /non-empty string/);
    expectRejected(Array.from({ length: 41 }, () => '--embed-subs'), /too many args/);
    expectRejected('--exec calc.exe' as unknown as string[], /args must be an array/);
  });
});

describe('M4-5 · 命令模板 CRUD + 持久化 + 载入校验', () => {
  const setup = () => {
    const mem = createInMemoryPorts();
    const store = new CommandTemplateStore({ ports: mem.ports });
    return { mem, store };
  };

  it('creates, lists, updates and removes templates', async () => {
    const { store } = setup();
    const created = await store.create({ name: '高质量 MKV', args: ['-f', 'bestvideo+bestaudio', '--merge-output-format', 'mkv'] });
    expect(created.id).toMatch(/^tpl-/);
    expect(store.list()).toHaveLength(1);
    expect(store.get(created.id)?.name).toBe('高质量 MKV');

    const updated = await store.update(created.id, { name: '改名后', args: ['--embed-subs'] });
    expect(updated.name).toBe('改名后');
    expect(updated.args).toEqual(['--embed-subs']);
    expect(updated.createdAt).toBe(created.createdAt);

    expect(await store.remove(created.id)).toBe(true);
    expect(await store.remove(created.id)).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  it('refuses to store a malicious template (code CUSTOM_COMMAND_REJECTED)', async () => {
    const { store } = setup();
    await expect(store.create({ name: 'evil', args: ['--exec', 'calc.exe'] }))
      .rejects.toMatchObject({ code: 'CUSTOM_COMMAND_REJECTED' });
    await expect(store.create({ name: '   ', args: ['--embed-subs'] }))
      .rejects.toMatchObject({ code: 'CUSTOM_COMMAND_REJECTED' });
    expect(store.list()).toHaveLength(0);
  });

  it('round-trips through the atomic JSON file', async () => {
    const { mem, store } = setup();
    await store.create({ name: 'A', args: ['--embed-subs'] });
    const raw = mem.state.files.get(`${mem.state.env.configDir}/command-templates.json`);
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw ?? '{}');
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.templates).toHaveLength(1);

    const reopened = new CommandTemplateStore({ ports: mem.ports });
    await reopened.init();
    expect(reopened.list()).toHaveLength(1);
  });

  it('drops a hand-edited invalid template at load and reports why', async () => {
    const { mem, store } = setup();
    mem.state.files.set(`${mem.state.env.configDir}/command-templates.json`, JSON.stringify({
      schemaVersion: 1,
      templates: [
        { id: 'ok', name: 'ok', args: ['--embed-subs'], createdAt: 'x', updatedAt: 'x' },
        { id: 'evil', name: 'evil', args: ['--exec', 'calc.exe'], createdAt: 'x', updatedAt: 'x' },
      ],
    }));
    await store.init();
    expect(store.list().map((t) => t.id)).toEqual(['ok']);
    expect(store.rejectedAtLoad).toHaveLength(1);
    expect(store.rejectedAtLoad[0]?.reason).toMatch(/denied option/);
  });
});

// ---------------------------------------------------------------------------
// D-249 · init 单飞 + 损坏备份（在线审计「轻微」项）。
//
// 旧 init() 在首个 await 之前就置 `loaded = true`：冷加载期间第二个调用者带着
// 空 templates 直接走写路径，create() 会以空基线覆盖磁盘上正在被读取的文件
// （D-227 修 HistoryStore 前的同款丢数据形态）。旧 load() 还把 JSON.parse 与
// exists() 探测的所有失败一律吞成空数组且无备份，下一次 persist 就把损坏原文
// 覆盖掉（D-159 修 task-store 前的同款形态）。以下用例钉死修复后的契约。
// ---------------------------------------------------------------------------
describe('D-249 · init 单飞：并发调用共享一次加载，写路径不得以空基线覆盖磁盘', () => {
  const templatePath = (mem: ReturnType<typeof createInMemoryPorts>): string =>
    `${mem.state.env.configDir}/command-templates.json`;

  const seededFile = (ids: string[]): string => JSON.stringify({
    schemaVersion: 1,
    templates: ids.map((id) => ({
      id, name: id, args: ['--embed-subs'], createdAt: 'x', updatedAt: 'x',
    })),
  });

  /** Gate the FIRST read of the template file so a second caller overlaps init. */
  const gatedReadPorts = (mem: ReturnType<typeof createInMemoryPorts>, path: string) => {
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolveGate) => { releaseRead = resolveGate; });
    let gated = true;
    let reads = 0;
    const ports = {
      ...mem.ports,
      fs: {
        ...mem.ports.fs,
        readText: async (p: string): Promise<string> => {
          if (p === path) reads += 1;
          if (gated && p === path) {
            gated = false;
            await readGate;
          }
          return mem.ports.fs.readText(p);
        },
      },
    };
    return { ports, releaseRead, readCount: () => reads };
  };

  it('并发 init 单飞：第二次 init 不重复读盘，两路都拿到完整列表', async () => {
    const mem = createInMemoryPorts();
    const path = templatePath(mem);
    mem.state.files.set(path, seededFile(['old-1', 'old-2']));
    const { ports, releaseRead, readCount } = gatedReadPorts(mem, path);
    const store = new CommandTemplateStore({ ports });

    const first = store.init();
    const second = store.init();
    await Promise.resolve();
    releaseRead();
    await Promise.all([first, second]);

    expect(readCount()).toBe(1);
    expect(store.list().map((t) => t.id)).toEqual(['old-1', 'old-2']);
  });

  it('init 未完成时 create() 不得以空基线覆盖既有文件（丢数据级）', async () => {
    const mem = createInMemoryPorts();
    const path = templatePath(mem);
    mem.state.files.set(path, seededFile(['old-1']));
    const { ports, releaseRead } = gatedReadPorts(mem, path);
    const store = new CommandTemplateStore({ ports });

    // Both creates are issued before any await: the second arrives while the
    // first load is still parked on the read gate.
    const first = store.create({ name: 'A', args: ['--embed-subs'] });
    const second = store.create({ name: 'B', args: ['-R', '3'] });
    await Promise.resolve();
    releaseRead();
    const [a, b] = await Promise.all([first, second]);

    const raw = mem.state.files.get(path);
    expect(raw).toBeDefined();
    const diskIds = (JSON.parse(raw as string) as { templates: Array<{ id: string }> })
      .templates.map((t) => t.id);
    // Seeded row AND both new rows survive on disk AND in memory.
    expect(diskIds).toEqual(['old-1', a.id, b.id]);
    expect(store.list().map((t) => t.id)).toEqual(['old-1', a.id, b.id]);
  });

  it('首次读取失败（非 ENOENT）时 create() 拒绝且磁盘逐字未变，随后可重试', async () => {
    const mem = createInMemoryPorts();
    const path = templatePath(mem);
    const seeded = seededFile(['old-1']);
    mem.state.files.set(path, seeded);

    let failures = 1;
    const ports = {
      ...mem.ports,
      fs: {
        ...mem.ports.fs,
        readText: async (p: string): Promise<string> => {
          if (p === path && failures > 0) {
            failures -= 1;
            throw new Error('EACCES: transient');
          }
          return mem.ports.fs.readText(p);
        },
      },
    };
    const store = new CommandTemplateStore({ ports });

    // A read failure is NOT a first run: the write must reject instead of
    // persisting an unknown baseline over the seeded file (D-241 classification).
    await expect(store.create({ name: 'A', args: ['--embed-subs'] })).rejects.toThrow('EACCES');
    expect(mem.state.files.get(path)).toBe(seeded);

    // D-227 retry: the failed load cleared the cached promise, so the next
    // call loads the real file and merges on top of it.
    const created = await store.create({ name: 'B', args: ['--embed-subs'] });
    const diskIds = (JSON.parse(mem.state.files.get(path) as string) as { templates: Array<{ id: string }> })
      .templates.map((t) => t.id);
    expect(diskIds).toEqual(['old-1', created.id]);
  });
});

describe('D-249 · 损坏 JSON：先字节级备份再回落空表，后续 persist 不破坏备份', () => {
  const templatePath = (mem: ReturnType<typeof createInMemoryPorts>): string =>
    `${mem.state.env.configDir}/command-templates.json`;

  const corruptBackups = (mem: ReturnType<typeof createInMemoryPorts>): string[] =>
    [...mem.state.bytes.keys()].filter((p) => /command-templates\.corrupt-.*\.json$/.test(p));

  it('损坏 JSON：init 后备份存在、列表为空；create() 覆盖原文件后备份逐字保留', async () => {
    const mem = createInMemoryPorts();
    const path = templatePath(mem);
    const corrupt = '{"schemaVersion":1,"templates":[{"id":"keep",';
    mem.state.files.set(path, corrupt);

    const store = new CommandTemplateStore({ ports: mem.ports });
    await store.init();
    expect(store.list()).toHaveLength(0);

    const backups = corruptBackups(mem);
    expect(backups).toHaveLength(1);
    const backupPath = backups[0] as string;
    expect(new TextDecoder().decode(mem.state.bytes.get(backupPath))).toBe(corrupt);

    const created = await store.create({ name: 'fresh', args: ['--embed-subs'] });
    // The backup survives the rewrite byte-for-byte.
    expect(new TextDecoder().decode(mem.state.bytes.get(backupPath))).toBe(corrupt);
    // The live file now holds the new template (persist still works).
    const live = JSON.parse(mem.state.files.get(path) as string) as { templates: Array<{ id: string }> };
    expect(live.templates.map((t) => t.id)).toEqual([created.id]);
  });

  it('形状损坏（templates 非数组）走同一备份路径；两次损坏不互相覆盖备份', async () => {
    const mem = createInMemoryPorts();
    const path = templatePath(mem);
    mem.state.files.set(path, '{"schemaVersion":1,"templates":5}');

    const first = new CommandTemplateStore({ ports: mem.ports });
    await first.init();
    expect(first.list()).toHaveLength(0);
    expect(corruptBackups(mem)).toHaveLength(1);

    // A second corrupt load in the SAME millisecond (deterministic clock) must
    // allocate a distinct backup name instead of clobbering the first copy.
    mem.state.files.set(path, 'totally not json');
    const second = new CommandTemplateStore({ ports: mem.ports });
    await second.init();
    expect(second.list()).toHaveLength(0);
    const backups = corruptBackups(mem);
    expect(backups).toHaveLength(2);
    const contents = backups.map((p) => new TextDecoder().decode(mem.state.bytes.get(p)));
    expect(contents).toContain('{"schemaVersion":1,"templates":5}');
    expect(contents).toContain('totally not json');
  });

  it('备份失败不阻断：回落空表后 create() 仍可正常写盘（best-effort 契约）', async () => {
    const mem = createInMemoryPorts();
    const path = templatePath(mem);
    mem.state.files.set(path, '{"broken');

    // Break BOTH backup primitives so every copy attempt fails.
    const ports = {
      ...mem.ports,
      fs: {
        ...mem.ports.fs,
        writeBytesAtomic: async (): Promise<void> => { throw new Error('ENOSPC: backup failed'); },
        writeTextAtomic: async (p: string, text: string): Promise<void> => {
          if (p.includes('.corrupt-')) throw new Error('ENOSPC: backup failed');
          return mem.ports.fs.writeTextAtomic(p, text);
        },
      },
    };
    const store = new CommandTemplateStore({ ports });
    await store.init();
    expect(store.list()).toHaveLength(0);
    expect(corruptBackups(mem)).toHaveLength(0);

    // The store stays usable: the best-effort backup failure must not wedge it.
    const created = await store.create({ name: 'after-corruption', args: ['--embed-subs'] });
    const live = JSON.parse(mem.state.files.get(path) as string) as { templates: Array<{ id: string }> };
    expect(live.templates.map((t) => t.id)).toEqual([created.id]);
  });
});

// ---------------------------------------------------------------------------
// D-256 · persist-first commit-after（外部审计 P3-01）。
//
// 旧 create/update/remove 先改内存再落盘：persist 失败时调用方拿到异常，但
// 内存已改——list()/get() 返回新状态、磁盘是旧状态；下一次成功保存还会把失败
// 的操作一并写盘（D-222 在 HistoryStore 修过的同款形态）。以下用例钉死修复后
// 的契约：构造候选（不碰 this.templates）→ persist → 成功才提交，整段串进
// 既有写队列；D-249 的单飞 init / 损坏备份 / 写队列不毒化钉点保持不变。
// ---------------------------------------------------------------------------
describe('D-256 · persist-first commit-after：写失败内存零变更、错误如实抛出', () => {
  const templatePath = (mem: ReturnType<typeof createInMemoryPorts>): string =>
    `${mem.state.env.configDir}/command-templates.json`;

  const diskIds = (mem: ReturnType<typeof createInMemoryPorts>, path: string): string[] =>
    (JSON.parse(mem.state.files.get(path) as string) as { templates: Array<{ id: string }> })
      .templates.map((t) => t.id);

  /** Wrap the fake fs so writes to the live template file fail while armed. */
  const armedWritePorts = (mem: ReturnType<typeof createInMemoryPorts>, path: string) => {
    let failing = false;
    let writeAttempts = 0;
    const ports = {
      ...mem.ports,
      fs: {
        ...mem.ports.fs,
        writeTextAtomic: async (p: string, text: string): Promise<void> => {
          if (p === path) writeAttempts += 1;
          if (failing && p === path) throw new Error('EIO: disk on fire');
          return mem.ports.fs.writeTextAtomic(p, text);
        },
      },
    };
    return {
      ports,
      arm: (): void => { failing = true; },
      disarm: (): void => { failing = false; },
      writeAttempts: (): number => writeAttempts,
    };
  };

  const setup = () => {
    const mem = createInMemoryPorts();
    const path = templatePath(mem);
    const { ports, arm, disarm, writeAttempts } = armedWritePorts(mem, path);
    const store = new CommandTemplateStore({ ports });
    return { mem, path, store, arm, disarm, writeAttempts };
  };

  it('create 写失败：内存零变更、磁盘逐字未动、错误如实抛出', async () => {
    const { mem, path, store, arm } = setup();
    const first = await store.create({ name: 'A', args: ['--embed-subs'] });
    arm();
    await expect(store.create({ name: 'B', args: ['-R', '3'] })).rejects.toThrow('EIO');
    // list()/get() observe the last COMMITTED state — the failed create left
    // no residue in memory and the atomic write left none on disk.
    expect(store.list().map((t) => t.id)).toEqual([first.id]);
    expect(store.get(first.id)?.name).toBe('A');
    expect(diskIds(mem, path)).toEqual([first.id]);
  });

  it('update 写失败：内存回旧值（list/get 观察已提交状态）、磁盘不变', async () => {
    const { mem, path, store, arm } = setup();
    const first = await store.create({ name: 'A', args: ['--embed-subs'] });
    arm();
    await expect(store.update(first.id, { name: '改名失败', args: ['-R', '3'] }))
      .rejects.toThrow('EIO');
    const after = store.get(first.id);
    expect(after?.name).toBe('A');
    expect(after?.args).toEqual(['--embed-subs']);
    const disk = JSON.parse(mem.state.files.get(path) as string) as {
      templates: Array<{ name: string; args: string[] }>;
    };
    expect(disk.templates[0]?.name).toBe('A');
    expect(disk.templates[0]?.args).toEqual(['--embed-subs']);
  });

  it('remove 写失败：双侧不动；恢复后重试成功且内存与磁盘一致', async () => {
    const { mem, path, store, arm, disarm } = setup();
    const first = await store.create({ name: 'A', args: ['--embed-subs'] });
    const second = await store.create({ name: 'B', args: ['-R', '3'] });
    arm();
    await expect(store.remove(first.id)).rejects.toThrow('EIO');
    expect(store.list().map((t) => t.id)).toEqual([first.id, second.id]);
    expect(diskIds(mem, path)).toEqual([first.id, second.id]);
    disarm();
    expect(await store.remove(first.id)).toBe(true);
    expect(store.list().map((t) => t.id)).toEqual([second.id]);
    expect(diskIds(mem, path)).toEqual([second.id]);
  });

  it('失败后紧跟一次成功保存：失败操作不被顺手复活，磁盘与内存逐字一致', async () => {
    const { mem, path, store, arm, disarm } = setup();
    const first = await store.create({ name: 'A', args: ['--embed-subs'] });
    // A failed create ('B'), a failed update (name 'X') and a failed remove
    // leave NO residue anywhere; the next successful save serializes exactly
    // the committed state. (The old commit-early code resurrected all three
    // onto disk with the very next persist.)
    arm();
    await expect(store.create({ name: 'B', args: ['-R', '3'] })).rejects.toThrow('EIO');
    await expect(store.update(first.id, { name: 'X' })).rejects.toThrow('EIO');
    await expect(store.remove(first.id)).rejects.toThrow('EIO');
    disarm();
    const third = await store.create({ name: 'C', args: ['--embed-subs'] });
    expect(store.list().map((t) => t.id)).toEqual([first.id, third.id]);
    expect(diskIds(mem, path)).toEqual([first.id, third.id]);
    const disk = JSON.parse(mem.state.files.get(path) as string) as {
      templates: Array<{ id: string; name: string }>;
    };
    expect(disk.templates.map((t) => t.name)).toEqual(['A', 'C']);
    expect(JSON.stringify(disk)).not.toContain('"B"');
    expect(JSON.stringify(disk)).not.toContain('"X"');
  });

  it('并发 create×2：整段进写队列，不丢更新（磁盘与内存同为两行、id 不撞）', async () => {
    const { mem, path, store } = setup();
    const [a, b] = await Promise.all([
      store.create({ name: 'P', args: ['--embed-subs'] }),
      store.create({ name: 'Q', args: ['-R', '3'] }),
    ]);
    expect(a.id).not.toBe(b.id);
    expect(store.list().map((t) => t.id)).toEqual([a.id, b.id]);
    expect(diskIds(mem, path)).toEqual([a.id, b.id]);
  });

  it('并发 create + remove：各自基于已提交状态构造候选，两效皆达、不互相覆盖', async () => {
    const { mem, path, store } = setup();
    const first = await store.create({ name: 'A', args: ['--embed-subs'] });
    const [created, removed] = await Promise.all([
      store.create({ name: 'B', args: ['-R', '3'] }),
      store.remove(first.id),
    ]);
    expect(removed).toBe(true);
    expect(store.list().map((t) => t.id)).toEqual([created.id]);
    expect(diskIds(mem, path)).toEqual([created.id]);
  });

  it('remove 不存在的 id：返回 false、零写盘、零内存变更', async () => {
    const { mem, path, store, writeAttempts } = setup();
    const first = await store.create({ name: 'A', args: ['--embed-subs'] });
    const writesBefore = writeAttempts();
    const listBefore = store.list();
    expect(await store.remove('tpl-does-not-exist')).toBe(false);
    expect(writeAttempts()).toBe(writesBefore);
    expect(store.list()).toEqual(listBefore);
    expect(diskIds(mem, path)).toEqual([first.id]);
  });
});

// ---------------------------------------------------------------------------
// D-262 · update() 错误优先级还原（外部审计 P3；修正 D-256 的不实声明）。
//
// pre-D-256 的 update() 先 findIndex 查 unknown-id，再内联校验 patch 字段
// （name 先于 args）。D-256 把校验挪到写队列之外，静默翻转了优先级：
// 「未知 id + 非法 name」改抛 CUSTOM_COMMAND_REJECTED 而不是 unknown-id，
// 而 D-256 的注释仍写「byte-identical to the pre-D-256 code」——本轮外部
// 审计证伪该声明。修复把校验作为纯函数挪回队列任务内、放在 unknown-id 检查
// 之后（校验无 I/O，占队列微秒级；D-256「拒绝的输入不占队列」是优化不是
// 契约），persist-first 契约原样保留。以下用例钉死还原后的语义。
// ---------------------------------------------------------------------------
describe('D-262 · update() 错误优先级：unknown-id 先于校验（还原 pre-D-256 语义）', () => {
  const templatePath = (mem: ReturnType<typeof createInMemoryPorts>): string =>
    `${mem.state.env.configDir}/command-templates.json`;

  const diskState = (mem: ReturnType<typeof createInMemoryPorts>, path: string): unknown =>
    JSON.parse(mem.state.files.get(path) as string);

  it('未知 id + 非法 name（且非法 args）：抛 unknown-id，而不是 CUSTOM_COMMAND_REJECTED', async () => {
    const mem = createInMemoryPorts();
    const path = templatePath(mem);
    const store = new CommandTemplateStore({ ports: mem.ports });
    const first = await store.create({ name: 'A', args: ['--embed-subs'] });
    const diskBefore = diskState(mem, path);
    const listBefore = store.list();

    // Both the name AND the args are invalid: the unknown-id error must win
    // (the precedence the pre-D-256 code had and D-256 silently flipped).
    await expect(store.update('tpl-missing', { name: '   ', args: [] }))
      .rejects.toThrow('unknown command template: tpl-missing');

    // A rejected input still has zero side effects (D-256 guarantee intact).
    expect(store.list()).toEqual(listBefore);
    expect(diskState(mem, path)).toEqual(diskBefore);
  });

  it('已知 id + 非法 name：抛校验错误（code CUSTOM_COMMAND_REJECTED）', async () => {
    const mem = createInMemoryPorts();
    const path = templatePath(mem);
    const store = new CommandTemplateStore({ ports: mem.ports });
    const first = await store.create({ name: 'A', args: ['--embed-subs'] });

    await expect(store.update(first.id, { name: '   ' }))
      .rejects.toMatchObject({ code: 'CUSTOM_COMMAND_REJECTED' });
    // A rejected patch leaves memory AND disk untouched.
    expect(store.get(first.id)?.name).toBe('A');
    expect((diskState(mem, path) as { templates: Array<{ name: string }> }).templates[0]?.name).toBe('A');
  });

  it('已知 id + name 与 args 双非法：name 错误先抛（与旧码内联顺序一致）', async () => {
    const mem = createInMemoryPorts();
    const store = new CommandTemplateStore({ ports: mem.ports });
    const first = await store.create({ name: 'A', args: ['--embed-subs'] });

    // The pre-D-256 inline sequence validated name before args; the reason
    // rides on the AppError `detail` (message is the shared Chinese text).
    await expect(store.update(first.id, { name: '   ', args: [] }))
      .rejects.toMatchObject({
        code: 'CUSTOM_COMMAND_REJECTED',
        detail: expect.stringMatching(/template name/),
      });
  });

  it('队列内的 unknown-id / 校验拒绝不毒化写队列（D-249 钉点延伸到新路径）', async () => {
    const mem = createInMemoryPorts();
    const path = templatePath(mem);
    const store = new CommandTemplateStore({ ports: mem.ports });
    const first = await store.create({ name: 'A', args: ['--embed-subs'] });

    await expect(store.update('tpl-missing', { name: '   ' })).rejects.toThrow('unknown command template');
    await expect(store.update(first.id, { name: '   ' })).rejects.toMatchObject({ code: 'CUSTOM_COMMAND_REJECTED' });

    // The chain stays settled: the next update still runs and commits.
    const updated = await store.update(first.id, { name: 'B' });
    expect(updated.name).toBe('B');
    expect(store.get(first.id)?.name).toBe('B');
    expect((diskState(mem, path) as { templates: Array<{ name: string }> }).templates[0]?.name).toBe('B');
  });
});

describe('M4-5 · buildCustomDownload argv', () => {
  it('keeps the compliance prefix/suffix, exactly one -- and the URL last', () => {
    const argv = buildCustomDownload(['-f', 'best', '--embed-subs'], 'https://example.org/v', CTX);
    expect(argv.filter((token) => token === '--')).toHaveLength(1);
    expect(argv.at(-1)).toBe('https://example.org/v');
    expect(argv.at(-2)).toBe('--');
    expect(argv).toContain('--js-runtimes');
    expect(argv).toContain('--print-to-file');
    expect(argv).toContain('--embed-subs');
    expect(argv).not.toContain('C:/runtime/yt-dlp.exe');
  });

  it('throws CUSTOM_COMMAND_REJECTED for a bad template', () => {
    try {
      buildCustomDownload(['--exec', 'calc.exe'], 'https://example.org/v', CTX);
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('CUSTOM_COMMAND_REJECTED');
    }
  });

  it('still rejects a non-http(s) URL', () => {
    let caught: unknown;
    try {
      buildCustomDownload(['--embed-subs'], 'file:///C:/x', CTX);
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string } | undefined)?.code).toBe('INVALID_URL');
  });
});

describe('M4-5 · TaskLogBuffer', () => {
  it('splits CRLF, strips control characters and keeps blank lines', () => {
    const log = new TaskLogBuffer();
    log.append('t1', 'a\r\nb\n\nc\u0007');
    expect(log.all('t1')).toEqual(['a', 'b', '', 'c']);
    expect(log.copy('t1')).toBe('a\nb\n\nc');
    expect(log.size('t1')).toBe(4);
  });

  it('caps per-task lines and keeps the most recent ones', () => {
    const log = new TaskLogBuffer({ maxLinesPerTask: 10 });
    for (let i = 0; i < 25; i += 1) log.append('t1', `line ${i}`);
    expect(log.size('t1')).toBe(10);
    expect(log.tail('t1', 3)).toEqual(['line 22', 'line 23', 'line 24']);
  });

  it('isolates tasks and supports clear', () => {
    const log = new TaskLogBuffer();
    log.append('t1', 'one');
    log.append('t2', 'two');
    expect(log.taskIds().sort()).toEqual(['t1', 't2']);
    expect(log.tail('missing')).toEqual([]);
    expect(log.clear('t1')).toBe(true);
    expect(log.clear('t1')).toBe(false);
    expect(log.all('t2')).toEqual(['two']);
  });
});
