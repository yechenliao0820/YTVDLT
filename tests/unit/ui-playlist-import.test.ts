/**
 * D-187 · playlists/playlist-import.js（播放列表批量导入）真实行为单测 —— import 路线，v8 覆盖率可见。
 *
 * 【为什么是 import 而不是 runInNewContext】既有语义单测 playlist-import-ui.test.ts
 * 通过 `new Function` 沙箱执行源码，断言很好，但 VM 沙箱里的执行 v8 覆盖率统计不到。
 * 本文件改用共享装载架 tests/unit/helpers/ui-harness.ts（installUiGlobals + 真实
 * `await import()`），让 playlist-import.js 进入 D-187 的覆盖率统计。
 *
 * 【模块形态】playlist-import.js 是工厂式组件（YTVDLT.playlists.create(options)），
 * 每个场景用 `create({ doc, t, call, notify, getChoice, ... })` 注入独立假 doc 与
 * 假 bridge 回包，实例之间零共享状态 —— 与 ui-subtitle-picker.test.ts 同套路。
 * 假定时器驱动 T5 等待行的 `URL_SUPPORT_CHECK_STATUS` 轮询（pollMs 注入为 100ms）。
 *
 * 【对齐既有语义】playlist-import-ui.test.ts 钉住的行为（默认全选、四个统计数、
 * 搜索不改选区、一次确认 BATCH_ENQUEUE、诚实结果行、R1-03 预检清单）在这里按
 * import 路线全部对齐保住；T5 预检取消（operationId 同源）与 D-130「预览通道只收
 * url/previousPreviewId、DTO/对话框不携带条目 URL」的隐私纪律是本文件新增钉点。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  installUiGlobals, loadUiModule, uiNode,
  type UiGlobals, type UiNode,
} from './helpers/ui-harness.js';

type TestNode = UiNode & { parentNode: TestNode | null };

/**
 * 装载架节点补齐真实 DOM 的四件事：parentNode 父链（close() 要 removeChild）、
 * `textContent` 聚合/清空语义（render/renderList 用 `textContent = ''` 全量重绘）、
 * `setAttribute('id', …)` 注册进 byId 表（bodyNode()/footNode() 靠它寻址）、
 * insertBefore 的 ref 定位（mount 把入口按钮插到锚点之后）。
 */
function makeNode(registry: Map<string, TestNode>, tag = 'div'): TestNode {
  const n = uiNode(tag) as unknown as TestNode;
  n.parentNode = null;
  let ownText = '';
  Object.defineProperty(n, 'textContent', {
    get: () => (n.children.length === 0 ? ownText : n.children.map((c) => String(c.textContent)).join('')),
    set: (value: string) => { n.children.length = 0; ownText = String(value); },
    configurable: true,
  });
  const rawSetAttribute = n.setAttribute.bind(n);
  n.setAttribute = (key: string, value: string): void => {
    rawSetAttribute(key, value);
    if (key === 'id') registry.set(value, n);
  };
  const appendChild = n.appendChild.bind(n);
  n.appendChild = (child: UiNode): UiNode => {
    (child as TestNode).parentNode = n;
    return appendChild(child);
  };
  const insertBefore = n.insertBefore.bind(n);
  n.insertBefore = (child: UiNode, ref?: UiNode | null): UiNode => {
    (child as TestNode).parentNode = n;
    const at = ref === undefined || ref === null
      ? n.children.length
      : n.children.indexOf(ref as TestNode);
    n.children.splice(at < 0 ? n.children.length : at, 0, child as TestNode);
    return child;
  };
  const removeChild = n.removeChild.bind(n);
  n.removeChild = (child: UiNode): UiNode => {
    const at = n.children.indexOf(child as TestNode);
    if (at >= 0) n.children.splice(at, 1);
    (child as TestNode).parentNode = null;
    return child;
  };
  return n;
}

/** createElement 钩子注册的 id 表（每个假 doc 一张）。 */
let registry: Map<string, TestNode>;

function makeDoc(): { doc: Record<string, any>; head: TestNode; body: TestNode } {
  registry = new Map<string, TestNode>();
  const head = makeNode(registry, 'head');
  const body = makeNode(registry, 'body');
  const doc: Record<string, any> = {
    head,
    body,
    createElement(tag?: string): TestNode { return makeNode(registry, tag ?? 'div'); },
    getElementById(id: string): TestNode | null { return registry.get(id) ?? null; },
  };
  return { doc, head, body };
}

/** 断言用文本聚合：本文件的 textContent 访问器已递归聚合子树，直接读即可。 */
function textOf(root: UiNode): string {
  return String(root.textContent);
}

function allNodes(root: UiNode): UiNode[] {
  const out: UiNode[] = [root];
  for (const child of root.children) out.push(...allNodes(child));
  return out;
}

async function tick(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

// ---- 夹具 -------------------------------------------------------------------

const URL_A = 'https://www.youtube.com/playlist?list=PL_GTA_65';

/** PREVIEW DTO（与主进程 playlist-preview 同形：条目只有 id/标题/时长/可用性，绝无 URL）。 */
function previewDto(count = 65, overrides: Record<string, unknown> = {}) {
  const entries = Array.from({ length: count }, (_v, i) => ({
    id: `ep${i + 1}`,
    title: `第 ${String(i + 1).padStart(2, '0')} 集 GTA 第 ${i + 1} 章`,
    position: i + 1,
    durationSec: 600,
    available: i !== 3 && i !== 9,
  }));
  return {
    ok: true, code: '', previewId: 'preview-ticket-0001', title: 'GTA 游戏合集',
    extractorKey: 'youtube:playlist', declaredCount: count, fetchedCount: count,
    availableCount: entries.filter((e) => e.available).length,
    unavailableCount: entries.filter((e) => !e.available).length,
    totalDurationSec: count * 600, entries, truncated: false, expiresAt: '',
    ...overrides,
  };
}

const ENQUEUE_OK = {
  ok: true, code: '', requested: 63, enqueued: 63, failed: 0, taskIds: [], failures: [],
};

/** 全部条目可下载的 DTO（选择/搜索族用；previewDto 自带 2 条不可访问）。 */
function uniformDto(count: number, overrides: Record<string, unknown> = {}) {
  const dto = previewDto(count, overrides);
  dto.entries = (dto.entries as Array<Record<string, unknown>>).map((e) => ({ ...e, available: true }));
  dto.availableCount = count;
  dto.unavailableCount = 0;
  return dto;
}

// ---- 场景装载 ---------------------------------------------------------------

let globals: UiGlobals | null = null;
let factory: {
  create(options: Record<string, unknown>): any;
  isPlaylistLike(raw: unknown): boolean;
  formatDuration(seconds: unknown): string;
};
let T: (key: string, params?: Record<string, unknown>) => string;

beforeAll(async () => {
  vi.useFakeTimers();
  globals = installUiGlobals({ bridge: null });
  await loadUiModule('i18n/messages.js', globals);
  await loadUiModule('i18n/i18n.js', globals);
  await loadUiModule('playlists/playlist-import.js', globals);
  const win = globals.window as any;
  factory = win.YTVDLT.playlists;
  T = (key, params) => String(win.YTVDLT.i18n.t(key, params));
});

afterAll(() => {
  globals?.restore();
  globals = null;
  vi.useRealTimers();
});

// ---- 可编程假桥 -------------------------------------------------------------

interface Deferred {
  channel: string;
  payload: Record<string, unknown>;
  settled: boolean;
  settle(value: unknown): void;
}
type ReplyKind = 'preview' | 'enqueue' | 'status';

interface Boot {
  component: any;
  calls: Array<{ channel: string; payload: Record<string, unknown> }>;
  notices: string[];
  singles: string[];
  refreshed(): number;
  doc: Record<string, any>;
  body: TestNode;
  head: TestNode;
  anchor: TestNode;
  byId(id: string): TestNode | null;
  /** 换某类通道的自动应答（只影响之后的调用）。 */
  setReply(kind: ReplyKind, reply: unknown): void;
  /** 挂起某类通道（之后的调用不再自动应答，留给用例手工 settle）。 */
  hold(kind: ReplyKind): void;
  /** 放行某类通道的全部挂起调用（用当前/给定应答）。 */
  release(kind: ReplyKind, reply?: unknown): Promise<void>;
  /** 按登记序号放行单个挂起调用（陈旧代 / 乱序场景；序号按该通道登记顺序计）。 */
  settleAt(channel: string, index: number, reply: unknown): Promise<void>;
  flush(): Promise<void>;
  tickMs(ms: number): Promise<void>;
}

function boot(options: {
  url?: string;
  previewReply?: unknown;
  enqueueReply?: unknown;
  statusReply?: unknown;
  holdPreview?: boolean;
  holdEnqueue?: boolean;
  pollMs?: number;
  withReadUrl?: boolean;
  kind?: 'video' | 'audio';
  audioQuality?: string;
  audioFormat?: string;
  videoQuality?: string;
  mount?: boolean;
} = {}): Boot {
  const env = makeDoc();
  const calls: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const pending: Deferred[] = [];
  const notices: string[] = [];
  const singles: string[] = [];
  let refreshedCount = 0;
  const replies: Record<ReplyKind, unknown> = {
    preview: 'previewReply' in options ? options.previewReply : previewDto(),
    enqueue: 'enqueueReply' in options ? options.enqueueReply : ENQUEUE_OK,
    status: 'statusReply' in options ? options.statusReply : { active: false },
  };
  const holds: Record<ReplyKind, boolean> = {
    preview: options.holdPreview === true,
    enqueue: options.holdEnqueue === true,
    status: false,
  };
  const kindOf = (channel: string): ReplyKind | null => channel === 'PLAYLIST_PREVIEW'
    ? 'preview'
    : channel === 'PLAYLIST_BATCH_ENQUEUE' ? 'enqueue'
      : channel === 'URL_SUPPORT_CHECK_STATUS' ? 'status' : null;

  const call = (channel: string, payload: Record<string, unknown>): Promise<unknown> => {
    calls.push({ channel, payload });
    let resolve!: (value: unknown) => void;
    const promise = new Promise<unknown>((res) => { resolve = res; });
    const entry: Deferred = {
      channel,
      payload,
      settled: false,
      settle(value: unknown) {
        if (entry.settled) return;
        entry.settled = true;
        resolve(value);
      },
    };
    pending.push(entry);
    const kind = kindOf(channel);
    if (kind === null) entry.settle({ ok: true }); // 两个 CANCEL 通道
    else if (!holds[kind]) entry.settle(replies[kind]);
    return promise;
  };

  const component = factory.create({
    doc: env.doc,
    t: T,
    call,
    notify(text: string): void { notices.push(String(text)); },
    getChoice: () => (options.kind ?? 'video') === 'audio'
      ? { kind: 'audio', audioQuality: options.audioQuality ?? '192', audioFormat: options.audioFormat ?? 'mp3' }
      : { kind: 'video', videoQuality: options.videoQuality ?? '1080p' },
    refresh: () => { refreshedCount += 1; },
    startSingleDownload: (url: string) => { singles.push(url); },
    readUrl: options.withReadUrl === false ? undefined : () => options.url ?? URL_A,
    ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
  });

  const anchor = env.doc.createElement('form') as TestNode;
  const host = env.doc.createElement('div') as TestNode;
  host.appendChild(anchor);
  if (options.mount !== false) component.mount(anchor, '../../styles/playlist-import.css');

  const settleAll = async (kind: ReplyKind, reply?: unknown): Promise<void> => {
    const value = reply !== undefined ? reply : replies[kind];
    for (const entry of pending) {
      if (kindOf(entry.channel) === kind && !entry.settled) entry.settle(value);
    }
    await tick();
  };

  return {
    component,
    calls,
    notices,
    singles,
    refreshed: () => refreshedCount,
    doc: env.doc,
    body: env.body,
    head: env.head,
    anchor,
    byId: (id: string) => registry.get(id) ?? null,
    setReply(kind: ReplyKind, reply: unknown) { replies[kind] = reply; },
    hold(kind: ReplyKind) { holds[kind] = true; },
    async release(kind: ReplyKind, reply?: unknown) {
      holds[kind] = false;
      await settleAll(kind, reply);
    },
    async settleAt(channel: string, index: number, reply: unknown) {
      const hits = pending.filter((p) => p.channel === channel);
      const entry = hits[index];
      if (entry === undefined) throw new Error(`no pending ${channel}[${index}]`);
      if (entry.settled) throw new Error(`${channel}[${index}] already settled`);
      entry.settle(reply);
      await tick();
    },
    async flush() { await tick(); },
    async tickMs(ms: number) { await vi.advanceTimersByTimeAsync(ms); },
  };
}

function click(b: Boot, id: string): void {
  const target = b.byId(id);
  if (target === null) throw new Error(`missing #${id}`);
  target.dispatch('click');
}

async function openReady(b: Boot, preview?: Record<string, unknown>): Promise<Boot> {
  // 注意：playlist-import 的 PREVIEW 应答就是 DTO 本体（result.ok/entries 直读），
  // 与 subtitle-picker 的 { ok, preview } 包裹形状不同。
  if (preview !== undefined) b.setReply('preview', preview);
  click(b, 'queue-import-playlist');
  await b.flush();
  return b;
}

const channelOf = (b: Boot, channel: string) => b.calls.filter((c) => c.channel === channel);

// ---------------------------------------------------------------------------

describe('D-187 · playlist-import 装载面与纯函数', () => {
  it('真实 import 后暴露 YTVDLT.playlists 工厂（create / isPlaylistLike / formatDuration）', () => {
    expect(typeof factory.create).toBe('function');
    expect(typeof factory.isPlaylistLike).toBe('function');
    expect(typeof factory.formatDuration).toBe('function');
    expect(Object.keys(globals!.attached)).toContain('YTVDLT');
  });

  it('isPlaylistLike 与 core 同构：list= / playlist= / 路径段 / 频道页全部命中', () => {
    expect(factory.isPlaylistLike('https://www.youtube.com/playlist?list=PL123')).toBe(true);
    expect(factory.isPlaylistLike('https://www.youtube.com/watch?v=abc&list=PL123')).toBe(true);
    expect(factory.isPlaylistLike('https://www.youtube.com/watch?v=abc&playlist=PL9')).toBe(true);
    expect(factory.isPlaylistLike('https://site.tld/playlist/x')).toBe(true);
    expect(factory.isPlaylistLike('https://site.tld/playlists/')).toBe(true);
    expect(factory.isPlaylistLike('https://soundcloud.com/user/sets/mix')).toBe(true);
    expect(factory.isPlaylistLike('https://www.youtube.com/channel/UC123/videos')).toBe(true);
    expect(factory.isPlaylistLike('https://www.youtube.com/user/name/videos')).toBe(true);
    expect(factory.isPlaylistLike('https://www.youtube.com/c/name/videos?x=1')).toBe(true);
    expect(factory.isPlaylistLike('https://www.youtube.com/@someone/videos')).toBe(true);
    expect(factory.isPlaylistLike('https://www.youtube.com/@someone/videos/latest')).toBe(true);
    // 大写也按小写判定；普通 watch 链接绝不误判；空值安全。
    expect(factory.isPlaylistLike('https://www.youtube.com/PLAYLIST?List=PL1')).toBe(true);
    expect(factory.isPlaylistLike('https://www.youtube.com/watch?v=abc')).toBe(false);
    expect(factory.isPlaylistLike('')).toBe(false);
    expect(factory.isPlaylistLike(undefined)).toBe(false);
    expect(factory.isPlaylistLike(null)).toBe(false);
  });

  it('formatDuration：h:mm:ss / m:ss / 非法值一律 —', () => {
    expect(factory.formatDuration(0)).toBe('0:00');
    expect(factory.formatDuration(59)).toBe('0:59');
    expect(factory.formatDuration(600)).toBe('10:00');
    expect(factory.formatDuration(65)).toBe('1:05');
    expect(factory.formatDuration(3600)).toBe('1:00:00');
    expect(factory.formatDuration(3661)).toBe('1:01:01');
    expect(factory.formatDuration(37800)).toBe('10:30:00');
    expect(factory.formatDuration(null)).toBe('—');
    expect(factory.formatDuration(undefined)).toBe('—');
    expect(factory.formatDuration(Number.NaN)).toBe('—');
    expect(factory.formatDuration(Number.POSITIVE_INFINITY)).toBe('—');
    expect(factory.formatDuration(-5)).toBe('—');
    expect(factory.formatDuration(12.9)).toBe('0:12'); // 先取整再分段
  });
});

describe('D-187 · 挂载面：入口按钮、样式与 mount 守卫', () => {
  it('mount 注入样式 link + 入口按钮（排在锚点之后），挂载零 IPC', () => {
    const b = boot();
    const link = b.head.children[0];
    expect(link.getAttribute('rel')).toBe('stylesheet');
    expect(link.getAttribute('href')).toBe('../../styles/playlist-import.css');
    const entry = b.byId('queue-import-playlist');
    expect(entry).toBeTruthy();
    expect(entry?.getAttribute('type')).toBe('button');
    expect(entry?.getAttribute('data-i18n')).toBe('queue.playlist.button');
    expect(entry?.textContent).toBe(T('queue.playlist.button'));
    expect(b.anchor.parentNode!.children.indexOf(entry!)).toBe(1); // 锚点后一位
    expect(b.calls).toEqual([]); // 挂载零探测
  });

  it('重复 mount 与无父锚点都是空操作', () => {
    const b = boot();
    const before = b.anchor.parentNode!.children.length;
    b.component.mount(b.anchor, '../../styles/playlist-import.css'); // 已挂载 → 守卫
    expect(b.anchor.parentNode!.children.length).toBe(before);
    const orphan = b.doc.createElement('div') as TestNode; // 没有 parentNode
    b.component.mount(orphan, 'x.css');
    expect(orphan.children).toHaveLength(0);
    b.component.mount(null, 'x.css'); // 无锚点 → 守卫
  });

  it('入口点击：粘贴框无 URL 只提示不发 IPC；readUrl 缺席同路', () => {
    const empty = boot({ url: '' });
    click(empty, 'queue-import-playlist');
    expect(empty.notices).toEqual([T('queue.playlist.needUrl')]);
    expect(empty.calls).toEqual([]);

    const noReader = boot({ withReadUrl: false });
    click(noReader, 'queue-import-playlist');
    expect(noReader.notices).toEqual([T('queue.playlist.needUrl')]);
    expect(noReader.calls).toEqual([]);
  });

  it('入口点击 → open(url) → PLAYLIST_PREVIEW：载荷只有 url 与 previousPreviewId（D-130）', async () => {
    const b = boot();
    click(b, 'queue-import-playlist');
    await b.flush();
    expect(b.calls).toEqual([
      { channel: 'PLAYLIST_PREVIEW', payload: { url: URL_A, previousPreviewId: '' } },
    ]);
    expect(b.component.isOpen()).toBe(true);
    expect(b.byId('pl-dialog')?.getAttribute('role')).toBe('dialog');
    expect(b.byId('pl-dialog')?.getAttribute('aria-modal')).toBe('true');
  });

  it('open("") 只提示；进行中重复 open 被 busy 门闩吞掉', async () => {
    const b = boot({ holdPreview: true });
    b.component.open('   '); // 空白链接 → 提示
    expect(b.notices).toEqual([T('queue.playlist.needUrl')]);
    expect(b.calls).toEqual([]);
    click(b, 'queue-import-playlist'); // 第一次：进 busy
    b.component.open('https://example.com/second'); // busy → 直接忽略
    expect(channelOf(b, 'PLAYLIST_PREVIEW')).toHaveLength(1);
    expect(b.component.state().url).toBe(URL_A);
  });

  it('open 后先显示「正在解析播放列表…」，成功后替换为完整渲染', async () => {
    const b = boot({ holdPreview: true });
    click(b, 'queue-import-playlist');
    expect(b.byId('pl-body')?.textContent).toBe(T('queue.playlist.picking'));
    expect(b.component.state().busy).toBe(true);
    await b.release('preview', previewDto(3));
    expect(b.byId('pl-body')?.textContent).toContain('GTA 游戏合集');
    expect(b.component.state().busy).toBe(false);
  });
});

describe('D-187 · 预览失败、回退与陈旧代（generation）', () => {
  it('失败预览 → 稳定码文案 + 单链接回退按钮（fallback 不发任何入队）', async () => {
    const b = boot({ previewReply: { ok: false, code: 'NOT_PLAYLIST', previewId: '', entries: [] } });
    click(b, 'queue-import-playlist');
    await b.flush();
    expect(b.byId('pl-body')?.textContent).toContain(T('queue.playlist.error.NOT_PLAYLIST'));
    expect(b.calls.some((c) => c.channel === 'PLAYLIST_BATCH_ENQUEUE')).toBe(false);
    click(b, 'pl-fallback');
    expect(b.singles).toEqual([URL_A]); // 回退走单链接
    expect(b.component.isOpen()).toBe(false);
    expect(b.calls.some((c) => c.channel === 'PLAYLIST_BATCH_ENQUEUE')).toBe(false);
  });

  it('失败文案矩阵：message 优先 / 未知码落 generic / 空回复落 IPC 文案', async () => {
    const byMessage = boot({ previewReply: { ok: false, message: '主进程自定义原因' } });
    click(byMessage, 'queue-import-playlist');
    await byMessage.flush();
    expect(byMessage.byId('pl-body')?.textContent).toContain('主进程自定义原因');

    const byGeneric = boot({ previewReply: { ok: false, code: 'TOTALLY_WEIRD' } });
    click(byGeneric, 'queue-import-playlist');
    await byGeneric.flush();
    expect(byGeneric.byId('pl-body')?.textContent)
      .toContain(T('queue.playlist.error.generic', { code: 'TOTALLY_WEIRD' }));

    const byNull = boot({ previewReply: null });
    click(byNull, 'queue-import-playlist');
    await byNull.flush();
    expect(byNull.byId('pl-body')?.textContent).toContain(T('queue.notify.ipc'));
  });

  it('失败预览的取消按钮走 cancel()：无票据可释放（currentPreviewId 已清空）', async () => {
    const b = boot({ previewReply: { ok: false, code: 'TIMEOUT' } });
    click(b, 'queue-import-playlist');
    await b.flush();
    // renderFailure 的取消按钮没有 id（与正常态 pl-cancel 不同），按文案定位
    const cancelBtn = b.byId('pl-foot')!.children
      .find((n) => n.tagName === 'BUTTON' && n.textContent === T('common.cancel'));
    expect(cancelBtn).toBeTruthy();
    cancelBtn!.dispatch('click');
    expect(b.component.isOpen()).toBe(false);
    expect(b.calls.some((c) => c.channel === 'PLAYLIST_PREVIEW_CANCEL')).toBe(false);
  });

  it('陈旧代：open1 挂起时取消，open2 挂起后旧答复落地必须丢弃（不重绘不置票）', async () => {
    const b = boot({ holdPreview: true });
    click(b, 'queue-import-playlist'); // open1（generation 1）挂起
    click(b, 'pl-close'); // cancel → busy 复位、对话框关闭
    expect(b.component.isOpen()).toBe(false);
    click(b, 'queue-import-playlist'); // open2（generation 2）挂起
    expect(channelOf(b, 'PLAYLIST_PREVIEW')).toHaveLength(2);
    await b.settleAt('PLAYLIST_PREVIEW', 0, previewDto(3, { previewId: 'ticket-STALE' }));
    // 陈旧答复：mine(1) !== generation(2) → 早退，不进入结果态、busy 不翻转
    expect(b.component.state().previewId).toBe('');
    expect(b.component.state().busy).toBe(true);
    expect(b.byId('pl-body')?.textContent).toBe(T('queue.playlist.picking'));
    await b.settleAt('PLAYLIST_PREVIEW', 1, previewDto(2, { previewId: 'ticket-LIVE' }));
    expect(b.component.state().previewId).toBe('ticket-LIVE');
    expect(b.component.state().fetched).toBe(2);
    expect(b.component.state().busy).toBe(false);
  });

  it('预览成功后再次 open：previousPreviewId 外显上一张票（TTL 票据复用语义）', async () => {
    const b = boot();
    click(b, 'queue-import-playlist');
    await b.flush();
    expect(b.component.state().previewId).toBe('preview-ticket-0001');
    click(b, 'queue-import-playlist'); // 第二次 open：带着旧票
    await b.flush();
    const previews = channelOf(b, 'PLAYLIST_PREVIEW');
    expect(previews).toHaveLength(2);
    expect(previews[0]?.payload).toEqual({ url: URL_A, previousPreviewId: '' });
    expect(previews[1]?.payload).toEqual({ url: URL_A, previousPreviewId: 'preview-ticket-0001' });
  });
});

describe('D-187 · 渲染矩阵：四个统计数、默认全选、部分/截断提示', () => {
  it('默认全选所有可下载条目（63/65），确认按钮计数与总时长如实', async () => {
    const b = await openReady(boot());
    expect(b.component.state().selected).toHaveLength(63);
    const confirm = b.byId('pl-confirm');
    expect(confirm?.textContent).toBe(T('queue.playlist.confirm', { n: 63 }));
    expect(confirm?.hasAttribute('disabled')).toBe(false);
    expect(b.byId('pl-selected')?.textContent).toBe(T('queue.playlist.selected', { n: 63 }));
    expect(b.byId('pl-duration')?.textContent)
      .toBe(T('queue.playlist.duration', { duration: '10:30:00' }));
    expect(b.byId('pl-list')?.children).toHaveLength(65);
    expect(b.byId('pl-body')?.textContent).toContain('GTA 游戏合集');
  });

  it('四个统计数分开呈现：声明总数 / 实际解析 / 可下载（ok）/ 不可访问（warn）', async () => {
    const b = await openReady(boot(), previewDto(65));
    const grid = b.byId('pl-body')!.children.find((n) => (n as any).className === 'pl-stats');
    expect(grid).toBeTruthy();
    const values = grid!.children.map((cell) => ({
      value: String(cell.children[0]?.textContent),
      label: cell.children[1]?.getAttribute('data-i18n'),
      extra: String((cell as unknown as { className?: string }).className ?? ''),
    }));
    expect(values).toEqual([
      { value: '65', label: 'queue.playlist.stats.declared', extra: 'pl-stat' },
      { value: '65', label: 'queue.playlist.stats.fetched', extra: 'pl-stat' },
      { value: '63', label: 'queue.playlist.stats.available', extra: 'pl-stat ok' },
      { value: '2', label: 'queue.playlist.stats.unavailable', extra: 'pl-stat warn' },
    ]);
  });

  it('声明 65 只解析到 20 → partial 警告；无不可访问时无 warn 修饰、无截断提示', async () => {
    const partial = previewDto(20, { declaredCount: 65, unavailableCount: 0 });
    partial.entries = (partial.entries as Array<Record<string, unknown>>)
      .map((e) => ({ ...e, available: true }));
    const b = await openReady(boot(), partial);
    const text = textOf(b.byId('pl-body')!);
    expect(text).toContain(T('queue.playlist.partial', { fetched: 20, declared: 65 }));
    expect(text).not.toContain(T('queue.playlist.truncated', { max: 20 }));
    const warnStat = b.byId('pl-body')!.children
      .find((n) => String((n as unknown as { className?: string }).className ?? '') === 'pl-stat warn');
    expect(warnStat).toBeUndefined();
  });

  it('truncated=true → 截断提示以条目数为上限', async () => {
    const b = await openReady(boot(), previewDto(20, { truncated: true }));
    expect(textOf(b.byId('pl-body')!)).toContain(T('queue.playlist.truncated', { max: 20 }));
  });

  it('不可访问行：复选框禁用、data-available=false、文案「不可访问」', async () => {
    const b = await openReady(boot(), previewDto(10));
    const rows = b.byId('pl-list')!.children;
    const unavailable = rows.filter((r) => r.getAttribute('data-available') === 'false');
    expect(unavailable).toHaveLength(2);
    for (const row of unavailable) {
      expect((row.children[0] as TestNode).disabled).toBe(true);
      expect(row.children[0].checked).toBe(false);
      expect(textOf(row)).toContain(T('queue.playlist.unavailable'));
      row.children[0].checked = true;
      row.children[0].dispatch('change'); // 禁用行没有 change 监听 → 选区纹丝不动
      expect(b.component.state().selected).toHaveLength(8);
      row.children[0].checked = false;
    }
  });

  it('行渲染：序号 / 标题 / 时长齐备，durationSec 缺失落 —', async () => {
    const dto = previewDto(2);
    dto.entries = [
      { id: 'a', title: 'Alpha', position: 1, durationSec: 3661, available: true },
      { id: 'b', title: 'Beta', position: 2, durationSec: null, available: true },
    ];
    dto.availableCount = 2;
    dto.unavailableCount = 0;
    const b = await openReady(boot(), dto);
    const rows = b.byId('pl-list')!.children;
    expect(textOf(rows[0])).toContain(T('queue.playlist.episode', { n: 1 }));
    expect(textOf(rows[0])).toContain('Alpha');
    expect(textOf(rows[0])).toContain('1:01:01');
    expect(textOf(rows[1])).toContain('—'); // 非法时长
    expect(rows[0].children[2].getAttribute('title')).toBe('Alpha');
  });
});

describe('D-187 · 行选择与搜索：选区永不被搜索改写', () => {
  it('全不选 → 确认禁用；全选恢复；反选归零', async () => {
    const b = await openReady(boot(), uniformDto(10));
    click(b, 'pl-none');
    expect(b.component.state().selected).toHaveLength(0);
    expect(b.byId('pl-confirm')?.getAttribute('disabled')).toBe('disabled');
    expect(b.byId('pl-duration')?.textContent)
      .toBe(T('queue.playlist.duration', { duration: '—' })); // 无已知时长 → —
    click(b, 'pl-all');
    expect(b.component.state().selected).toHaveLength(10);
    click(b, 'pl-invert');
    expect(b.component.state().selected).toHaveLength(0);
    click(b, 'pl-invert');
    expect(b.component.state().selected).toHaveLength(10);
  });

  it('搜索只过滤可见行、绝不动选区；按标题/序号/id 命中；无匹配显示提示行', async () => {
    const b = await openReady(boot(), uniformDto(10));
    const before = b.component.state().selected.slice();
    const search = b.byId('pl-search')!;
    search.value = '第 01 集';
    search.dispatch('input');
    expect(b.component.state().query).toBe('第 01 集');
    expect(b.byId('pl-list')!.children.length).toBeLessThan(10);
    expect(b.component.state().selected).toEqual(before); // 选区未变
    expect(b.byId('pl-confirm')?.textContent).toBe(T('queue.playlist.confirm', { n: 10 }));
    search.value = 'ep5';
    search.dispatch('input');
    expect(b.byId('pl-list')!.children).toHaveLength(1);
    search.value = '3';
    search.dispatch('input');
    expect(b.byId('pl-list')!.children.length).toBeGreaterThan(0);
    search.value = '绝不匹配的词';
    search.dispatch('input');
    expect(b.byId('pl-list')!.children).toHaveLength(1);
    expect(textOf(b.byId('pl-list')!)).toBe(T('queue.playlist.noMatch'));
    search.value = '';
    search.dispatch('input');
    expect(b.byId('pl-list')!.children).toHaveLength(10);
  });

  it('搜索激活时 bulk 仍覆盖全部条目（不只搜索命中）', async () => {
    const b = await openReady(boot(), uniformDto(10));
    const search = b.byId('pl-search')!;
    search.value = '第 01 集';
    search.dispatch('input');
    click(b, 'pl-none');
    click(b, 'pl-all');
    expect(b.component.state().selected).toHaveLength(10);
  });

  it('单行取消勾选：计数原位更新、对话框不重建（行节点同引用）', async () => {
    const b = await openReady(boot(), uniformDto(10));
    const list = b.byId('pl-list')!;
    const firstRow = list.children[0];
    const box = firstRow.children[0] as TestNode;
    box.checked = false;
    box.dispatch('change');
    expect(b.component.state().selected).toHaveLength(9);
    expect(b.byId('pl-confirm')?.textContent).toBe(T('queue.playlist.confirm', { n: 9 }));
    expect(b.byId('pl-list')!.children[0]).toBe(firstRow); // 未重建
    expect(firstRow.getAttribute('data-selected')).toBe('false');
    box.checked = true;
    box.dispatch('change');
    expect(b.component.state().selected).toHaveLength(10);
    expect(firstRow.getAttribute('data-selected')).toBe('true');
  });
});

describe('D-187 · 确认入队：BATCH_ENQUEUE 载荷、等待行与预检轮询（T5）', () => {
  it('确认载荷 = previewId + url + selectedIds + 类型枚举 + operationId，绝无 playlist 字段', async () => {
    const b = await openReady(boot(), previewDto(3));
    click(b, 'pl-confirm');
    await b.flush();
    const sent = b.calls.find((c) => c.channel === 'PLAYLIST_BATCH_ENQUEUE');
    expect(sent?.payload.previewId).toBe('preview-ticket-0001');
    expect(sent?.payload.url).toBe(URL_A);
    expect(sent?.payload.kind).toBe('video');
    expect(sent?.payload.quality).toBe('1080p');
    expect(sent?.payload.selectedIds).toEqual(['ep1', 'ep2', 'ep3']);
    expect(typeof sent?.payload.operationId).toBe('string');
    expect('playlist' in (sent?.payload ?? {})).toBe(false);
    expect(b.refreshed()).toBe(1); // 结果落地后刷新队列
  });

  it('音频选择继承 getChoice：audioQuality/audioFormat 进载荷且无 quality', async () => {
    const b = await openReady(boot({ kind: 'audio', audioQuality: '64', audioFormat: 'opus' }), previewDto(2));
    click(b, 'pl-confirm');
    await b.flush();
    const sent = b.calls.find((c) => c.channel === 'PLAYLIST_BATCH_ENQUEUE');
    expect(sent?.payload).toMatchObject({ kind: 'audio', audioQuality: '64', audioFormat: 'opus' });
    expect('quality' in (sent?.payload ?? {})).toBe(false);
  });

  it('确认进行中：按钮禁用 + 等待行出现；STATUS 轮询刷新已检计数', async () => {
    const b = await openReady(boot({ pollMs: 100, holdEnqueue: true }), previewDto(5));
    click(b, 'pl-confirm');
    expect(b.byId('pl-confirm')?.getAttribute('disabled')).toBe('disabled');
    const row = b.byId('pl-wait');
    expect(row).toBeTruthy();
    expect(b.byId('pl-wait-progress')?.textContent).toBe(T('queue.precheck.checking'));
    expect(b.byId('pl-cancel-precheck')?.textContent).toBe(T('queue.precheck.cancel'));
    const operationId = (b.calls.find((c) => c.channel === 'PLAYLIST_BATCH_ENQUEUE')?.payload as Record<string, unknown>).operationId;
    b.setReply('status', { active: true, checked: 2, total: 5 });
    await b.tickMs(100);
    expect(channelOf(b, 'URL_SUPPORT_CHECK_STATUS')).toHaveLength(1);
    expect(b.calls.at(-1)?.payload).toEqual({ operationId });
    expect(b.byId('pl-wait-progress')?.textContent)
      .toBe(T('queue.precheck.progress', { checked: 2, total: 5 }));
    // 入队回复落地 → 等待行拆除、票据消费、对话框进入结果态
    await b.release('enqueue');
    // 拆除的节点从 foot 子树移除（id 注册表里仍有引用，断言走 children）
    expect(b.byId('pl-foot')!.children.some((n) => n.getAttribute('id') === 'pl-wait')).toBe(false);
    expect(b.component.state().previewId).toBe('');
    expect(b.byId('pl-foot')!.children.some((n) => n.getAttribute('id') === 'pl-confirm')).toBe(false);
    expect(b.byId('pl-done')?.textContent).toBe(T('common.close'));
  });

  it('STATUS total=0 / 缺失字段时计数行不刷新为垃圾值', async () => {
    const b = await openReady(boot({ pollMs: 100, holdEnqueue: true }), previewDto(5));
    click(b, 'pl-confirm');
    b.setReply('status', { active: true }); // 没有 total → 只停不写
    await b.tickMs(100);
    expect(b.byId('pl-wait-progress')?.textContent).toBe(T('queue.precheck.checking'));
    b.setReply('status', { active: true, checked: 9, total: 0 });
    await b.tickMs(100);
    expect(b.byId('pl-wait-progress')?.textContent).toBe(T('queue.precheck.checking'));
    await b.release('enqueue');
  });

  it('等待行取消按钮：置灰 + 文案切换 + URL_SUPPORT_CHECK_CANCEL 携同源 operationId', async () => {
    const b = await openReady(boot({ pollMs: 100, holdEnqueue: true }), previewDto(5));
    click(b, 'pl-confirm');
    const operationId = (b.calls.find((c) => c.channel === 'PLAYLIST_BATCH_ENQUEUE')?.payload as Record<string, unknown>).operationId;
    click(b, 'pl-cancel-precheck');
    const stop = b.byId('pl-cancel-precheck')!;
    expect(stop.getAttribute('disabled')).toBe('disabled');
    expect(b.byId('pl-wait-progress')?.textContent).toBe(T('queue.precheck.cancelling'));
    expect(b.calls.at(-1)).toEqual({ channel: 'URL_SUPPORT_CHECK_CANCEL', payload: { operationId } });
    await b.release('enqueue');
  });

  it('STATUS 回复 inactive → 轮询停止（不再发 STATUS）', async () => {
    const b = await openReady(boot({ pollMs: 100, holdEnqueue: true }), previewDto(5));
    click(b, 'pl-confirm');
    b.setReply('status', { active: false });
    await b.tickMs(100);
    expect(channelOf(b, 'URL_SUPPORT_CHECK_STATUS')).toHaveLength(1);
    await b.tickMs(300);
    expect(channelOf(b, 'URL_SUPPORT_CHECK_STATUS')).toHaveLength(1);
    await b.release('enqueue');
  });

  it('等待行已拆（对话框关闭）后 STATUS 回复才落地 → wait===null 早退不抛错', async () => {
    const b = await openReady(boot({ pollMs: 100, holdEnqueue: true }), previewDto(5));
    click(b, 'pl-confirm');
    b.hold('status'); // 先登记一条挂起的 STATUS
    await b.tickMs(100);
    expect(channelOf(b, 'URL_SUPPORT_CHECK_STATUS')).toHaveLength(1);
    click(b, 'pl-cancel'); // 整体取消 → 等待行拆除、轮询停摆
    expect(b.byId('pl-foot')!.children.some((n) => n.getAttribute('id') === 'pl-wait')).toBe(false);
    const statusCalls = channelOf(b, 'URL_SUPPORT_CHECK_STATUS').length;
    await b.tickMs(300); // 轮询已停：无新增 STATUS
    expect(channelOf(b, 'URL_SUPPORT_CHECK_STATUS')).toHaveLength(statusCalls);
    await b.settleAt('URL_SUPPORT_CHECK_STATUS', 0, { active: true, checked: 1, total: 3 });
    expect(b.calls.at(-1)?.channel).toBe('PLAYLIST_PREVIEW_CANCEL'); // 早退路径无副作用
    await b.release('enqueue');
  });

  it('结果呈现：成功行 + 通知 + 关闭按钮；关闭后对话框整体退场', async () => {
    const b = await openReady(boot(), previewDto(3));
    b.setReply('enqueue', { ok: true, code: '', requested: 3, enqueued: 3, failed: 0, taskIds: [], failures: [] });
    click(b, 'pl-confirm');
    await b.flush();
    expect(b.byId('pl-body')?.textContent)
      .toContain(T('queue.playlist.result', { requested: 3, enqueued: 3, failed: 0 }));
    expect(b.notices.at(-1)).toContain(T('queue.playlist.result', { requested: 3, enqueued: 3, failed: 0 }));
    click(b, 'pl-done');
    expect(b.component.isOpen()).toBe(false);
    expect(b.body.children.some((n) => n.getAttribute('id') === 'pl-dialog')).toBe(false);
  });

  it('部分失败：结果行 + 失败明细逐条列出；通知同文案', async () => {
    const b = await openReady(boot(), previewDto(5));
    b.setReply('enqueue', {
      ok: false, code: 'PARTIAL_SUCCESS', requested: 5, enqueued: 4, failed: 1,
      taskIds: [], failures: [{ id: 'ep3', reason: 'ENQUEUE_FAILED' }],
    });
    click(b, 'pl-confirm');
    await b.flush();
    const text = textOf(b.byId('pl-body')!);
    expect(text).toContain(T('queue.playlist.result', { requested: 5, enqueued: 4, failed: 1 }));
    expect(text).toContain(T('queue.playlist.error.PARTIAL_SUCCESS'));
    expect(text).toContain('ep3 — ENQUEUE_FAILED');
    expect(b.notices.at(-1)).toContain(T('queue.playlist.result', { requested: 5, enqueued: 4, failed: 1 }));
    expect(b.refreshed()).toBe(1);
  });

  it('R1-03 预检清单：汇总行 + skippedNote + 无媒体 id 桶；无桶字段时安全跳过', async () => {
    const b = await openReady(boot(), previewDto(5));
    b.setReply('enqueue', {
      ok: true, code: '', requested: 5, enqueued: 5, failed: 0, taskIds: [], failures: [],
      precheck: {
        examined: 5, supported: 4, unsupported: 0, noMedia: 1, indeterminate: 0, skipped: 1,
        noMediaIds: ['ep2'], indeterminateIds: [],
      },
    });
    click(b, 'pl-confirm');
    await b.flush();
    const text = textOf(b.byId('pl-body')!);
    expect(text).toContain(T('queue.precheck.summary', {
      supported: 4, unsupported: 0, noMedia: 1, indeterminate: 0, skipped: 1,
    }));
    expect(text).toContain(T('queue.precheck.skippedNote', { skipped: 1 }));
    expect(text).toContain(`${T('queue.precheck.noMedia')} — ep2`);
    expect(text).not.toContain(`${T('queue.precheck.indeterminate')} — `);

    const bare = await openReady(boot(), previewDto(3));
    bare.setReply('enqueue', {
      ok: true, requested: 3, enqueued: 3, failed: 0, failures: [],
      precheck: { supported: 3, skipped: 0 }, // 没有任何 id 桶字段
    });
    click(bare, 'pl-confirm');
    await bare.flush();
    expect(textOf(bare.byId('pl-body')!)).toContain(T('queue.precheck.summary', {
      supported: 3, unsupported: 0, noMedia: 0, indeterminate: 0, skipped: 0,
    }));
  });

  it('取消的批次不是失败：cancelledBatch 文案、无错误行', async () => {
    const b = await openReady(boot(), previewDto(3));
    b.setReply('enqueue', { ok: false, cancelled: true, requested: 3, enqueued: 0, failed: 0, failures: [] });
    click(b, 'pl-confirm');
    await b.flush();
    const text = textOf(b.byId('pl-body')!);
    expect(text).toContain(T('queue.precheck.cancelledBatch'));
    expect(text).not.toContain(T('queue.playlist.error.PARTIAL_SUCCESS'));
    expect(b.byId('pl-done')?.textContent).toBe(T('common.close'));
  });

  it('空选择不可确认：bulk 全不选后点确认只提示 EMPTY_SELECTION、零入队', async () => {
    const b = await openReady(boot(), previewDto(3));
    click(b, 'pl-none');
    click(b, 'pl-confirm'); // disabled 属性在假节点上不拦截 listener，组件守卫兜底
    await b.flush();
    expect(b.notices).toContain(T('queue.playlist.error.EMPTY_SELECTION'));
    expect(b.calls.some((c) => c.channel === 'PLAYLIST_BATCH_ENQUEUE')).toBe(false);
  });

  it('结果落地后再点确认：preview 已消费 → 守卫早退零 IPC', async () => {
    const b = await openReady(boot(), previewDto(3));
    click(b, 'pl-confirm');
    await b.flush();
    const before = b.calls.length;
    click(b, 'pl-confirm'); // preview=null → 守卫
    expect(b.calls.length).toBe(before);
  });
});

describe('D-187 · 取消路径与隐私纪律（D-130 DTO 无 URL）', () => {
  it('确认前取消：PLAYLIST_PREVIEW_CANCEL 释放票据、绝无入队、对话框退场', async () => {
    const b = await openReady(boot(), previewDto(3));
    click(b, 'pl-cancel');
    expect(b.calls.map((c) => c.channel)).toEqual([
      'PLAYLIST_PREVIEW', 'PLAYLIST_PREVIEW_CANCEL',
    ]);
    expect(b.calls.some((c) => c.channel === 'PLAYLIST_BATCH_ENQUEUE')).toBe(false);
    expect(b.component.isOpen()).toBe(false);
    expect(b.component.state().previewId).toBe('');
    expect(b.component.state().selected).toEqual([]);
  });

  it('入队进行中取消（头部 ×）：释放预检与预览票，回复落地后安静收尾', async () => {
    const b = await openReady(boot({ pollMs: 100, holdEnqueue: true }), previewDto(3));
    b.setReply('enqueue', { ok: true, code: '', requested: 3, enqueued: 3, failed: 0, taskIds: [], failures: [] });
    click(b, 'pl-confirm');
    const operationId = (b.calls.find((c) => c.channel === 'PLAYLIST_BATCH_ENQUEUE')?.payload as Record<string, unknown>).operationId;
    click(b, 'pl-close'); // cancel()：enqueueInFlight → CANCEL；票据在握 → PREVIEW_CANCEL
    expect(b.component.isOpen()).toBe(false);
    expect(b.calls.at(-2)).toEqual({ channel: 'URL_SUPPORT_CHECK_CANCEL', payload: { operationId } });
    expect(b.calls.at(-1)).toEqual({ channel: 'PLAYLIST_PREVIEW_CANCEL', payload: { previewId: 'preview-ticket-0001' } });
    // 回复落地：wait 已拆（幂等）、busy 复位、刷新与通知照发
    await b.release('enqueue');
    expect(b.component.state().busy).toBe(false);
    expect(b.refreshed()).toBe(1);
    expect(b.notices.at(-1)).toContain(T('queue.playlist.result', { requested: 3, enqueued: 3, failed: 0 }));
    // 关闭后再 open 一切如常（busy 复位可重新打开）
    click(b, 'queue-import-playlist');
    await b.flush();
    expect(b.component.isOpen()).toBe(true);
  });

  it('D-130 隐私：对话框任何文本/属性都不携带播放列表 URL 或条目 URL', async () => {
    const b = await openReady(boot(), previewDto(10));
    click(b, 'pl-confirm');
    await b.flush();
    for (const n of allNodes(b.body)) {
      expect(textOf(n)).not.toContain('https://');
      expect(textOf(n)).not.toContain('list=PL_GTA_65');
      for (const value of Object.values(n.attrs)) {
        expect(String(value)).not.toContain('https://');
      }
    }
  });

  it('state() 快照：url/busy/previewId/selected/query/declared/fetched 如实', async () => {
    const b = boot({ holdPreview: true });
    expect(b.component.state()).toEqual({
      url: '', busy: false, previewId: '', selected: [], query: '', declared: null, fetched: null,
    });
    click(b, 'queue-import-playlist');
    expect(b.component.state().busy).toBe(true);
    expect(b.component.state().url).toBe(URL_A);
    await b.release('preview');
    expect(b.component.state().declared).toBe(65);
    expect(b.component.state().fetched).toBe(65);
    expect(b.component.state().previewId).toBe('preview-ticket-0001');
    expect(b.component.state().selected).toHaveLength(63);
  });
});
