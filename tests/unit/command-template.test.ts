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
