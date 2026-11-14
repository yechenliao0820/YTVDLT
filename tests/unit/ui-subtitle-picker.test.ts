/**
 * D-187 · subtitle-picker 真实行为单测（packages/ui 纳入覆盖率统计）。
 *
 * 旧的 tests/unit/subtitle-picker.test.ts 通过 `new Function` 沙箱执行源码，
 * v8 覆盖率看不到那些 VM 脚本；本文件改用共享装载架
 * tests/unit/helpers/ui-harness.ts（installUiGlobals + 真实 `import()`），让
 * vitest 直接 import `packages/ui/src/subtitles/subtitle-picker.js`，覆盖率
 * 提供器才能看见全部语句。行为断言通过模块自暴露的测试面
 * `YTVDLT.subtitles`（create / isHttpUrl / isExpired / usableFormats /
 * MAX_LANGUAGES / CONVERT_VALUES / ERROR_KEYS）驱动：每个场景用
 * `create({ doc, t, call, getUrl, ... })` 注入独立的假 doc 与假 bridge 回包，
 * 模块只在调用时惰性读取这些注入项，场景之间互不串扰。
 *
 * 断言覆盖：轨道渲染/选择/上限/搜索、内嵌 vs 外挂联动、keepSubtitleFile
 * 交互态、SUBTITLE_PREVIEW / SUBTITLE_PREVIEW_CANCEL 的调用参数、票据生命
 * 周期（过期 / stale / 乱序 / 死票据）、onEnqueueResult 回执、URL 变更失效，
 * 以及「URL 不落 DOM」的隐私约束。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  installUiGlobals, loadUiModule, uiNode,
  type UiGlobals, type UiNode,
} from './helpers/ui-harness.js';

type TestNode = UiNode & { parentNode: TestNode | null };

/** 共享装载架的节点是"无父节点"的独立对象；这里补上 parentNode 跟踪与 `#id` 查询。 */
function node(tag = 'div'): TestNode {
  const n = uiNode(tag) as unknown as TestNode;
  n.parentNode = null;
  const appendChild = n.appendChild.bind(n);
  n.appendChild = (child: UiNode): UiNode => {
    (child as TestNode).parentNode = n;
    return appendChild(child);
  };
  const insertBefore = n.insertBefore.bind(n);
  n.insertBefore = (child: UiNode, ref?: UiNode | null): UiNode => {
    (child as TestNode).parentNode = n;
    return insertBefore(child, ref);
  };
  const removeChild = n.removeChild.bind(n);
  n.removeChild = (child: UiNode): UiNode => {
    (child as TestNode).parentNode = null;
    return removeChild(child);
  };
  const baseQueryAll = n.querySelectorAll.bind(n);
  n.querySelectorAll = (selector: string): UiNode[] => {
    const idMatch = /^#([A-Za-z0-9_-]+)$/.exec(selector.trim());
    if (idMatch === null) return baseQueryAll(selector);
    const found: UiNode[] = [];
    const walk = (current: UiNode): void => {
      for (const child of current.children) {
        if (child.getAttribute('id') === idMatch[1]) found.push(child);
        walk(child);
      }
    };
    walk(n);
    return found;
  };
  return n;
}

interface FakeDocEnv {
  doc: Record<string, any>;
  head: TestNode;
  body: TestNode;
  fireKey(type: string, event: unknown): void;
}

function makeDoc(): FakeDocEnv {
  const docListeners: Record<string, ((event?: unknown) => void)[]> = {};
  const head = node('head');
  const body = node('body');
  const doc: Record<string, any> = {
    head,
    body,
    createElement(tag?: string): TestNode { return node(tag ?? 'div'); },
    addEventListener(type: string, fn: (event?: unknown) => void): void {
      (docListeners[type] ??= []).push(fn);
    },
    removeEventListener(type: string, fn: (event?: unknown) => void): void {
      const bucket = docListeners[type] ?? [];
      const at = bucket.indexOf(fn);
      if (at >= 0) bucket.splice(at, 1);
    },
  };
  return {
    doc,
    head,
    body,
    fireKey(type: string, event: unknown): void {
      for (const fn of docListeners[type] ?? []) fn(event);
    },
  };
}

/** 参数化假 i18n：带参数时把参数 JSON 内联进文案（null 参数与真 i18n 一样视为无参数）。 */
function t(key: string, params?: Record<string, unknown> | null): string {
  return params === undefined || params === null ? key : `${key}${JSON.stringify(params)}`;
}

function findById(root: UiNode, id: string): TestNode | null {
  if (root.getAttribute('id') === id) return root as TestNode;
  for (const child of root.children) {
    const hit = findById(child, id);
    if (hit !== null) return hit;
  }
  return null;
}

/** 装载架节点的 textContent 是普通属性（不聚合子树），断言用需要自己拼。 */
function textOf(root: UiNode): string {
  let out = typeof root.textContent === 'string' ? root.textContent : '';
  for (const child of root.children) out += textOf(child);
  return out;
}

function allNodes(root: UiNode): UiNode[] {
  const out: UiNode[] = [root];
  for (const child of root.children) out.push(...allNodes(child));
  return out;
}

async function tick(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

// ---- 类型与夹具 -----------------------------------------------------------

interface SubtitleState {
  phase: string;
  errorKey: string | null;
  preview: { previewId: string; expiresAt: string } | null;
  url: string;
  selected: Record<string, boolean>;
  includeAutomatic: boolean;
  convertTo: string;
  embed: boolean;
  keepFile: boolean;
  query: string;
  confirmed: {
    url: string;
    previewId: string;
    expiresAt: string;
    subtitleLanguages: string[];
    subtitleAutoCaptions: boolean;
    subtitleConvertTo: string;
    subtitleEmbed: boolean;
    subtitleKeepFile: boolean;
  } | null;
  seq: number;
  loading: boolean;
  limitHit: boolean;
}

interface SubtitleController {
  mount(anchor?: unknown, cssHref?: string, before?: unknown): void;
  open(): void;
  retry(): void;
  cancel(): void;
  clearSelection(): void;
  confirm(): void;
  getSelection(): Record<string, unknown> | null | false;
  onEnqueueResult(result: unknown): string | null;
  onUrlChanged(url: string): boolean;
  setKind(): void;
  renderPreview(dto: unknown): void;
  close(): void;
  state: SubtitleState;
  refs: Record<string, TestNode>;
}

interface SubtitleFactory {
  create(options: Record<string, unknown>): SubtitleController;
  isHttpUrl(value: unknown): boolean;
  isExpired(expiresAt: unknown, now: number): boolean;
  usableFormats(track: { manualFormats?: string[]; automaticFormats?: string[] }): string[];
  MAX_LANGUAGES: number;
  CONVERT_VALUES: string[];
  ERROR_KEYS: Record<string, string>;
}

const CLOCK = 1_700_000_000_000;

function trackFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    languageCode: 'en', languageName: 'English',
    manualAvailable: true, automaticAvailable: false,
    manualFormats: ['srt', 'vtt'], automaticFormats: [],
    ...overrides,
  };
}

function dtoFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    previewId: 'ticket-00000001',
    media: { title: 'Demo clip', uploader: 'Studio', durationSec: 125 },
    tracks: [trackFixture()],
    empty: false,
    expiresAt: new Date(CLOCK + 300_000).toISOString(),
    ...overrides,
  };
}

function fullDto(): Record<string, unknown> {
  return dtoFixture({
    tracks: [
      trackFixture({ languageCode: 'en', languageName: 'English', manualAvailable: true, automaticAvailable: true, manualFormats: ['srt', 'vtt'], automaticFormats: ['vtt'] }),
      trackFixture({ languageCode: 'zh-Hans', languageName: '简体中文', manualAvailable: true, automaticAvailable: false, manualFormats: ['srt'], automaticFormats: [] }),
      trackFixture({ languageCode: 'ja', languageName: '日本語', manualAvailable: false, automaticAvailable: true, manualFormats: [], automaticFormats: ['vtt', 'srv3'] }),
    ],
  });
}

// ---- 场景装载 -------------------------------------------------------------

let globals: UiGlobals | null = null;
let pickerFactory: SubtitleFactory;

beforeAll(async () => {
  vi.useFakeTimers();
  globals = installUiGlobals({ bridge: null });
  await loadUiModule('subtitles/subtitle-picker.js', globals);
  pickerFactory = (globals.window as any).YTVDLT.subtitles as SubtitleFactory;
});

afterAll(() => {
  globals?.restore();
  globals = null;
  vi.useRealTimers();
});

interface SubtitleBoot {
  component: SubtitleController;
  calls: Array<{ channel: string; payload: unknown }>;
  notices: string[];
  selectionEvents: Array<unknown>;
  anchor: TestNode;
  head: TestNode;
  body: TestNode;
  doc: Record<string, any>;
  byId(id: string): TestNode | null;
  modal(): TestNode;
  fireKey(type: string, event: unknown): void;
  setUrl(value: string): void;
  setKind(value: 'video' | 'audio'): void;
  advanceClock(ms: number): void;
  setPreview(reply: unknown): void;
}

function boot(options: {
  url?: string;
  kind?: 'video' | 'audio';
  mount?: boolean;
  mountBefore?: boolean;
  onCall?: (channel: string, payload: unknown) => unknown;
} = {}): SubtitleBoot {
  const env = makeDoc();
  const calls: Array<{ channel: string; payload: unknown }> = [];
  const notices: string[] = [];
  const selectionEvents: Array<unknown> = [];
  let url = options.url ?? 'https://example.org/watch?v=abc';
  let kind: 'video' | 'audio' = options.kind ?? 'video';
  let clock = CLOCK;
  let previewReply: unknown = { ok: true, preview: dtoFixture() };

  const component = pickerFactory.create({
    doc: env.doc,
    t,
    call(channel: string, payload: unknown): Promise<unknown> {
      calls.push({ channel, payload });
      const custom = options.onCall?.(channel, payload);
      if (custom !== undefined) return Promise.resolve(custom);
      if (channel === 'SUBTITLE_PREVIEW') return Promise.resolve(previewReply);
      return Promise.resolve({ ok: true, canceled: true });   // SUBTITLE_PREVIEW_CANCEL
    },
    notify(text: string): void { notices.push(String(text)); },
    getUrl(): string { return url; },
    getKind(): 'video' | 'audio' { return kind; },
    now(): number { return clock; },
    onSelectionChange(selection: unknown): void { selectionEvents.push(selection); },
  });

  const anchor = env.doc.createElement('form') as TestNode;
  if (options.mount !== false) {
    if (options.mountBefore === true) {
      component.mount(anchor, '../styles/subtitles.css', env.doc.createElement('span'));
    } else {
      component.mount(anchor, '../styles/subtitles.css');
    }
  }

  const byId = (id: string): TestNode | null => {
    for (const root of [env.body, env.head, anchor]) {
      const hit = findById(root, id);
      if (hit !== null) return hit;
    }
    return null;
  };

  return {
    component,
    calls,
    notices,
    selectionEvents,
    anchor,
    head: env.head,
    body: env.body,
    doc: env.doc,
    byId,
    modal: () => byId('subtitle-modal') as TestNode,
    fireKey: env.fireKey,
    setUrl(value: string) { url = value; },
    setKind(value: 'video' | 'audio') { kind = value; },
    advanceClock(ms: number) { clock += ms; },
    setPreview(reply: unknown) { previewReply = reply; },
  };
}

function clickId(b: SubtitleBoot, id: string): void {
  const target = b.byId(id);
  if (target === null) throw new Error(`missing #${id}`);
  target.dispatch('click', {});
}

function rowFor(b: SubtitleBoot, code: string): TestNode | null {
  const row = b.component.refs.rows.children.find(
    (child) => child.getAttribute('data-language') === code,
  );
  return (row as TestNode) ?? null;
}

function boxFor(b: SubtitleBoot, code: string): TestNode {
  const row = rowFor(b, code);
  if (row === null) throw new Error(`no track row for ${code}`);
  return row.children[0] as TestNode;
}

function select(b: SubtitleBoot, code: string, on = true): void {
  const box = boxFor(b, code);
  box.checked = on;
  box.dispatch('change');
}

async function openReady(b: SubtitleBoot, preview?: Record<string, unknown>): Promise<void> {
  if (preview !== undefined) b.setPreview({ ok: true, preview });
  b.component.refs.button.click();
  await tick();
}

// ---------------------------------------------------------------------------

describe('D-187 · subtitle-picker boots under the import harness', () => {
  it('exposes the YTVDLT.subtitles surface after a real import', () => {
    expect(typeof pickerFactory.create).toBe('function');
    expect(Object.keys(pickerFactory)).toEqual(expect.arrayContaining([
      'create', 'isHttpUrl', 'isExpired', 'usableFormats',
      'MAX_LANGUAGES', 'CONVERT_VALUES', 'ERROR_KEYS',
    ]));
    expect(Object.keys(globals!.attached)).toContain('YTVDLT');
  });

  it('keeps the pure helper semantics', () => {
    expect(pickerFactory.isHttpUrl('https://example.org/v')).toBe(true);
    expect(pickerFactory.isHttpUrl('HTTP://EXAMPLE.ORG/V')).toBe(true);
    expect(pickerFactory.isHttpUrl('  https://example.org/v  ')).toBe(true);
    expect(pickerFactory.isHttpUrl('ftp://example.org/v')).toBe(false);
    expect(pickerFactory.isHttpUrl('not-a-link')).toBe(false);
    expect(pickerFactory.isHttpUrl(null)).toBe(false);

    expect(pickerFactory.isExpired(new Date(CLOCK - 1_000).toISOString(), CLOCK)).toBe(true);
    expect(pickerFactory.isExpired(new Date(CLOCK + 60_000).toISOString(), CLOCK)).toBe(false);
    expect(pickerFactory.isExpired('not-a-timestamp', CLOCK)).toBe(true);

    expect(pickerFactory.usableFormats({ manualFormats: ['srt', 'wtt'], automaticFormats: ['vtt', 'badext'] }))
      .toEqual(['srt', 'vtt']);
    expect(pickerFactory.usableFormats({})).toEqual([]);                     // 缺字段安全回退
    expect(pickerFactory.usableFormats({ manualFormats: ['srt'], automaticFormats: ['srt'] }))
      .toEqual(['srt']);                                                     // unique 按精确值去重

    expect(pickerFactory.MAX_LANGUAGES).toBe(12);
    expect(pickerFactory.CONVERT_VALUES).toEqual(['none', 'srt', 'vtt', 'ass', 'lrc']);
    expect(pickerFactory.ERROR_KEYS.PREVIEW_EXPIRED).toBe('subtitle.error.expired');
    expect(pickerFactory.ERROR_KEYS.IPC_ERROR).toBe('subtitle.error.failed');
  });
});

describe('subtitle-picker · mounting', () => {
  it('mount builds entry button, chip and modal, styles go to head only', () => {
    const b = boot();
    const entry = b.component.refs.button;
    expect(entry.getAttribute('id')).toBe('queue-subtitle-open');
    expect(entry.getAttribute('type')).toBe('button');
    expect(entry.getAttribute('data-i18n')).toBe('subtitle.entry');
    expect(entry.getAttribute('aria-pressed')).toBe('false');
    expect(entry.textContent).toBe('subtitle.entry');
    expect(b.anchor.children).toContain(entry);

    const chip = b.component.refs.chip;
    expect(chip.getAttribute('id')).toBe('queue-subtitle-chip');
    expect(chip.getAttribute('data-state')).toBe('none');
    expect(chip.getAttribute('hidden')).toBe('true');
    expect(chip.children[1].getAttribute('aria-label')).toBe('subtitle.clear.aria');

    const modal = b.modal();
    expect(modal.getAttribute('role')).toBe('dialog');
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(modal.getAttribute('hidden')).toBe('true');
    expect(b.byId('subtitle-modal')).toBe(modal);                            // 模态框在 doc.body 下
    expect(b.head.children[0].getAttribute('rel')).toBe('stylesheet');
    expect(b.head.children[0].getAttribute('href')).toBe('../styles/subtitles.css');

    const anchorSize = b.anchor.children.length;
    b.component.mount(b.anchor, '../styles/subtitles.css');                  // 重复 mount 是空操作
    expect(b.anchor.children.length).toBe(anchorSize);
    expect(b.component.refs.button).toBe(entry);
  });

  it('mount supports the insertBefore anchor and an anchorless mount', () => {
    const withBefore = boot({ mountBefore: true });
    expect(withBefore.anchor.children).toContain(withBefore.component.refs.button);
    expect(withBefore.anchor.children).toContain(withBefore.component.refs.chip);

    const bare = boot({ mount: false });
    expect(bare.anchor.children).toHaveLength(0);
    bare.component.mount();                                                  // 无锚点：仅模态框进 body
    expect(bare.byId('subtitle-modal')).not.toBeNull();
    expect(bare.component.refs.button).toBeTruthy();
    expect(bare.calls).toEqual([]);                                          // 挂载零探测
  });
});

describe('subtitle-picker · preview state machine', () => {
  it('probes only on the user click, with exactly the URL as payload', async () => {
    let resolvePreview: (value: unknown) => void = () => {};
    const b = boot({
      onCall: (channel) => channel === 'SUBTITLE_PREVIEW'
        ? new Promise((resolve) => { resolvePreview = resolve; })
        : undefined,
    });
    expect(b.calls).toEqual([]);                                             // 装载/挂载零探测
    b.component.refs.button.click();
    expect(b.calls).toEqual([
      { channel: 'SUBTITLE_PREVIEW', payload: { url: 'https://example.org/watch?v=abc' } },
    ]);
    expect(b.component.state.phase).toBe('loading');
    expect(textOf(b.component.refs.stateText)).toBe('subtitle.state.loading');
    expect(b.component.refs.confirm.disabled).toBe(true);
    expect(b.modal().getAttribute('hidden')).toBe('false');
    resolvePreview({ ok: true, preview: fullDto() });
    await tick();
    expect(b.component.state.phase).toBe('ready');
    expect(b.component.state.loading).toBe(false);
  });

  it('an invalid URL errors out and never probes', () => {
    const b = boot({ url: 'not-a-link' });
    b.component.refs.button.click();
    expect(b.calls).toEqual([]);
    expect(b.component.state.phase).toBe('error');
    expect(b.component.state.errorKey).toBe('subtitle.error.invalidUrl');
    expect(b.component.state.preview).toBeNull();
    expect(textOf(b.component.refs.stateText)).toBe('subtitle.state.error');
    expect(textOf(b.component.refs.alert)).toBe('subtitle.error.invalidUrl');
    expect(b.component.refs.alert.getAttribute('data-tone')).toBe('error');
    expect(b.component.refs.retry.getAttribute('hidden')).toBe('false');
  });

  it('ready rendering: track rows, source badges, media header and count', async () => {
    const b = boot();
    await openReady(b, fullDto());
    expect(b.component.state.phase).toBe('ready');
    expect(b.component.refs.toolbar.getAttribute('hidden')).toBe('false');
    expect(b.component.refs.options.getAttribute('hidden')).toBe('false');
    expect(b.component.refs.selectedBox.getAttribute('hidden')).toBe('true');
    expect(textOf(b.component.refs.count)).toBe('subtitle.count{"n":0}');
    const modalText = textOf(b.modal());
    expect(modalText).toContain('zh-Hans');
    expect(modalText).toContain('ja');
    expect(modalText).toContain('English');
    expect(modalText).toContain('srt');
    expect(modalText).toContain('srv3');
    expect(modalText).toContain('Demo clip · Studio · 2:05');                // m:ss 格式化
    const sources = allNodes(b.modal()).map((n) => n.getAttribute('data-source'));
    expect(sources).toContain('manual');
    expect(sources).toContain('automatic');
    const enRow = rowFor(b, 'en') as TestNode;
    expect(enRow.getAttribute('data-selected')).toBe('false');
    expect((enRow.children[0] as TestNode).checked).toBe(false);
  });

  it('no subtitles is a successful empty state, not an error', async () => {
    const b = boot();
    await openReady(b, dtoFixture({ empty: true, tracks: [] }));
    expect(b.component.state.phase).toBe('empty');
    expect(b.component.state.errorKey).toBeNull();
    expect(textOf(b.component.refs.stateText)).toBe('subtitle.state.empty');
    expect(b.component.refs.confirm.disabled).toBe(true);
    expect(b.component.refs.toolbar.getAttribute('hidden')).toBe('true');
  });

  it('media line hides when absent and skips non-finite durations', async () => {
    const partial = boot();
    await openReady(partial, dtoFixture({ media: { title: 'Only Title', uploader: null, durationSec: Number.NaN } }));
    expect(textOf(partial.component.refs.media)).toBe('Only Title');
    const missing = boot();
    await openReady(missing, dtoFixture({ media: undefined }));
    expect(missing.component.refs.media.getAttribute('hidden')).toBe('true');
  });

  it('maps every failure code to its own sentence with a retry', async () => {
    const codes = ['PREVIEW_UNAVAILABLE', 'PREVIEW_INVALID_URL', 'PREVIEW_FAILED', 'PREVIEW_EXPIRED',
      'PREVIEW_CONSUMED', 'PREVIEW_URL_MISMATCH', 'PREVIEW_UNKNOWN', 'PREVIEW_REQUIRED',
      'SUBTITLE_LANGUAGE_UNKNOWN', 'SUBTITLE_NO_MANUAL_TRACK', 'SUBTITLE_EMBED_UNSUPPORTED',
      'BRIDGE_UNAVAILABLE', 'IPC_ERROR'];
    for (const code of codes) {
      const b = boot();
      b.setPreview({ ok: false, code, message: 'backend said no' });
      b.component.refs.button.click();
      await tick();
      const expired = code === 'PREVIEW_EXPIRED' || code === 'PREVIEW_CONSUMED' || code === 'PREVIEW_REQUIRED';
      expect(b.component.state.phase, code).toBe(expired ? 'expired' : 'error');
      expect(b.component.state.errorKey, code).toBe(pickerFactory.ERROR_KEYS[code]);
      expect(b.component.refs.retry.getAttribute('hidden'), code).toBe('false');
      expect(b.calls.some((c) => c.channel === 'SUBTITLE_PREVIEW_CANCEL'), code).toBe(false);
    }
  });

  it('falls back to the generic failure sentence for unknown codes', async () => {
    const b = boot();
    b.setPreview({ ok: false, code: 'TOTALLY_WEIRD' });
    b.component.refs.button.click();
    await tick();
    expect(b.component.state.errorKey).toBe('subtitle.error.failed');
    expect(b.component.state.phase).toBe('error');
  });

  it('a dead-ticket reply also drops an already confirmed selection', async () => {
    const b = boot();
    await openReady(b, fullDto());
    select(b, 'en');
    clickId(b, 'subtitle-confirm');
    expect(b.component.state.confirmed).not.toBeNull();
    b.advanceClock(400_000);                                                 // 确认选区先过期，重开才会重新探测
    b.setPreview({ ok: false, code: 'PREVIEW_EXPIRED' });
    b.component.refs.button.click();                                         // 重开 → 重新预览 → 失败
    await tick();
    expect(b.component.state.phase).toBe('expired');
    expect(b.component.state.confirmed).toBeNull();
    expect(b.selectionEvents[b.selectionEvents.length - 1]).toBeNull();
  });

  it('a rejected bridge promise lands in the failure state', async () => {
    const b = boot({
      onCall: (channel) => channel === 'SUBTITLE_PREVIEW'
        ? Promise.reject(new Error('ipc down'))
        : undefined,
    });
    b.component.refs.button.click();
    await tick();
    expect(b.component.state.phase).toBe('error');
    expect(b.component.state.errorKey).toBe('subtitle.error.failed');
    expect(b.component.state.loading).toBe(false);
  });

  it('out-of-order replies are discarded and their tickets released', async () => {
    const gates: Array<(value: unknown) => void> = [];
    const b = boot({
      onCall: (channel) => channel === 'SUBTITLE_PREVIEW'
        ? new Promise((resolve) => { gates.push(resolve); })
        : undefined,
    });
    b.component.refs.button.click();                                         // 预览 #1
    b.component.refs.button.click();                                         // 预览 #2 顶掉 #1
    gates[1]({ ok: true, preview: fullDto() });
    await tick();
    gates[0]({ ok: true, preview: dtoFixture({ previewId: 'ticket-STALE' }) });
    await tick();
    expect(b.component.state.preview?.previewId).toBe('ticket-00000001');
    const staleCancel = b.calls.find((c) => c.channel === 'SUBTITLE_PREVIEW_CANCEL'
      && (c.payload as Record<string, unknown>).previewId === 'ticket-STALE');
    expect(staleCancel).toBeTruthy();
  });

  it('a URL changed mid-flight turns the reply stale and releases the ticket', async () => {
    let resolvePreview: (value: unknown) => void = () => {};
    const b = boot({
      onCall: (channel) => channel === 'SUBTITLE_PREVIEW'
        ? new Promise((resolve) => { resolvePreview = resolve; })
        : undefined,
    });
    b.component.refs.button.click();
    b.setUrl('https://example.org/watch?v=OTHER');
    resolvePreview({ ok: true, preview: dtoFixture() });
    await tick();
    expect(b.component.state.phase).toBe('stale');
    expect(b.component.state.errorKey).toBe('subtitle.error.stale');
    expect(b.component.refs.retry.getAttribute('hidden')).toBe('false');
    expect(b.calls[1]).toEqual({ channel: 'SUBTITLE_PREVIEW_CANCEL', payload: { previewId: 'ticket-00000001' } });
  });

  it('the retry button issues a fresh preview', async () => {
    const b = boot();
    b.setPreview({ ok: false, code: 'PREVIEW_FAILED' });
    b.component.refs.button.click();
    await tick();
    expect(b.component.state.phase).toBe('error');
    b.setPreview({ ok: true, preview: fullDto() });
    clickId(b, 'subtitle-retry');
    await tick();
    expect(b.component.state.phase).toBe('ready');
    expect(b.calls.filter((c) => c.channel === 'SUBTITLE_PREVIEW')).toHaveLength(2);
  });
});

describe('subtitle-picker · selection interaction', () => {
  it('checking and unchecking keeps selected / chips / count / confirm in sync', async () => {
    const b = boot();
    await openReady(b, fullDto());
    expect(b.component.refs.confirm.disabled).toBe(true);
    select(b, 'en');
    expect(b.component.state.selected).toEqual({ en: true });
    expect(b.component.refs.confirm.disabled).toBe(false);
    expect(b.component.refs.selectedBox.getAttribute('hidden')).toBe('false');
    expect(textOf(b.component.refs.count)).toBe('subtitle.count{"n":1}');
    const chipCodes = new Set(b.component.refs.chips.children
      .filter((c) => c.className === 'subtitle-chip-item')
      .map((c) => c.textContent));
    expect([...chipCodes]).toEqual(['en']);
    select(b, 'zh-Hans');
    expect(textOf(b.component.refs.count)).toBe('subtitle.count{"n":2}');
    select(b, 'zh-Hans', false);
    expect(b.component.state.selected).toEqual({ en: true });
    expect(b.component.refs.confirm.disabled).toBe(false);
    select(b, 'en', false);
    expect(b.component.state.selected).toEqual({});
    expect(b.component.refs.confirm.disabled).toBe(true);
    expect(b.component.refs.selectedBox.getAttribute('hidden')).toBe('true');
  });

  it('a track without usable formats is disabled, labelled and uncheckable', async () => {
    const b = boot();
    await openReady(b, dtoFixture({
      tracks: [trackFixture({
        languageCode: 'xx', languageName: 'unusable',
        manualFormats: [], automaticFormats: [], automaticAvailable: false,
      })],
    }));
    const box = boxFor(b, 'xx');
    expect(box.disabled).toBe(true);
    const row = rowFor(b, 'xx') as TestNode;
    expect(row.getAttribute('data-disabled')).toBe('true');
    const noneBadges = allNodes(b.modal()).filter((n) => n.getAttribute('data-source') === 'none');
    expect(noneBadges).toHaveLength(1);
    expect(textOf(noneBadges[0])).toContain('subtitle.format.unavailable');
    box.checked = true;
    box.dispatch('change');                                                  // noFormat：处理器早退
    expect(b.component.state.selected).toEqual({});
    expect(b.component.refs.confirm.disabled).toBe(true);
  });

  it('the search box filters rows and shows an empty note on no match', async () => {
    const b = boot();
    await openReady(b, fullDto());
    const search = b.component.refs.toolbar.children[0];
    const renderedBefore = b.component.refs.rows.children.length;
    search.value = 'zh';
    search.dispatch('input');
    const added = b.component.refs.rows.children.slice(renderedBefore);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((row) => row.getAttribute('data-language') === 'zh-Hans')).toBe(true);
    expect(b.component.state.query).toBe('zh');
    const beforeEmpty = b.component.refs.rows.children.length;
    search.value = 'zzz';
    search.dispatch('input');
    const addedEmpty = b.component.refs.rows.children.slice(beforeEmpty);
    expect(addedEmpty).toHaveLength(1);
    expect(addedEmpty[0].textContent).toBe('subtitle.search.empty');
  });

  it('caps the selection at 12 languages and clears the hint when a chip is removed', async () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      trackFixture({ languageCode: `l${i}`, languageName: `Lang ${i}` }));
    const b = boot();
    await openReady(b, dtoFixture({ tracks: many }));
    for (let i = 0; i < 12; i += 1) select(b, `l${i}`);
    expect(b.component.refs.confirm.disabled).toBe(false);
    const overflow = boxFor(b, 'l12');
    overflow.checked = true;
    overflow.dispatch('change');
    expect(b.component.state.selected['l12']).toBeUndefined();
    expect(b.component.state.limitHit).toBe(true);
    expect(textOf(b.component.refs.alert)).toBe('subtitle.limit{"n":12}');
    expect(b.component.refs.alert.getAttribute('data-tone')).toBe('info');
    expect(b.component.refs.alert.getAttribute('hidden')).toBe('false');
    expect(b.notices[b.notices.length - 1]).toBe('subtitle.limit{"n":12}');
    b.component.confirm();                                                   // 全量 render 时 limitHit 仍要重绘提示
    expect(b.component.state.confirmed).not.toBeNull();
    expect(textOf(b.component.refs.alert)).toBe('subtitle.limit{"n":12}');
    const l0Chips = b.component.refs.chips.children
      .filter((c) => c.className === 'subtitle-chip-item' && c.textContent === 'l0');
    const removeButton = l0Chips[l0Chips.length - 1].children[0];
    removeButton.dispatch('click', { preventDefault() { /* noop */ } });
    expect(b.component.state.limitHit).toBe(false);
    expect(b.component.refs.alert.getAttribute('hidden')).toBe('true');
    expect(Object.keys(b.component.state.selected)).toHaveLength(11);
    expect(b.component.refs.confirm.disabled).toBe(false);
  });

  it('automatic-only tracks require the explicit opt-in before confirm', async () => {
    const b = boot();
    await openReady(b, fullDto());
    select(b, 'ja');
    expect(b.component.refs.confirm.disabled).toBe(true);
    expect(textOf(b.component.refs.warning)).toContain('subtitle.warn.automaticRequired');
    b.component.confirm();                                                   // 守卫直接拦下
    expect(b.component.getSelection()).toBeNull();
    const automatic = b.component.refs.automatic;
    automatic.checked = true;
    automatic.dispatch('change');
    expect(b.component.refs.confirm.disabled).toBe(false);
    automatic.checked = false;
    automatic.dispatch('change');
    expect(b.component.refs.confirm.disabled).toBe(true);
    automatic.checked = true;
    automatic.dispatch('change');
    b.component.confirm();
    expect((b.component.getSelection() as Record<string, unknown>).subtitleAutoCaptions).toBe(true);
  });

  it('embed enables keepSubtitleFile, external resets it; unchecking a radio is a no-op', async () => {
    const b = boot();
    await openReady(b, fullDto());
    const embed = b.component.refs.embed;
    embed.checked = false;
    embed.dispatch('change');                                                // 未选中：早退
    expect(b.component.state.embed).toBe(false);
    select(b, 'en');
    embed.checked = true;
    embed.dispatch('change');
    expect(b.component.state.embed).toBe(true);
    expect(b.component.refs.external.checked).toBe(false);
    const keep = b.component.refs.keep;
    expect(keep.disabled).toBe(false);
    keep.checked = true;
    keep.dispatch('change');
    expect(b.component.state.keepFile).toBe(true);
    const warning = textOf(b.component.refs.warning);
    expect(warning).toContain('subtitle.warn.container');
    expect(warning).toContain('subtitle.warn.embedKeep');
    expect(warning).not.toContain('subtitle.warn.embedAuto');                // en 有人工源
    keep.checked = false;
    keep.dispatch('change');
    expect(b.component.state.keepFile).toBe(false);
    const external = b.component.refs.external;
    external.checked = true;                                                 // radio 只在被选中时触发 change
    external.dispatch('change');
    expect(b.component.state.embed).toBe(false);
    expect(keep.disabled).toBe(true);
    expect(keep.checked).toBe(false);
    expect(b.component.state.keepFile).toBe(false);
    expect(b.component.refs.warning.getAttribute('hidden')).toBe('true');
  });

  it('audio mode disables embed and demotes a confirmed embedded choice to external', async () => {
    const b = boot();
    await openReady(b, fullDto());
    select(b, 'en');
    b.component.refs.embed.checked = true;
    b.component.refs.embed.dispatch('change');
    b.component.refs.keep.checked = true;
    b.component.refs.keep.dispatch('change');
    clickId(b, 'subtitle-confirm');
    const confirmed = b.component.state.confirmed;
    expect(confirmed?.subtitleEmbed).toBe(true);
    expect(confirmed?.subtitleKeepFile).toBe(true);
    expect(textOf(b.component.refs.chipLabel)).toContain('"mode":"subtitle.mode.embed"');

    b.component.setKind();                                                   // 仍是视频：无变化
    expect(b.component.state.confirmed?.subtitleEmbed).toBe(true);

    b.setKind('audio');
    b.component.setKind();
    expect(b.component.state.confirmed?.subtitleEmbed).toBe(false);
    expect(b.component.state.confirmed?.subtitleKeepFile).toBe(false);
    expect(textOf(b.component.refs.chipLabel)).toContain('"mode":"subtitle.mode.external"');
    expect(b.notices[b.notices.length - 1]).toBe('subtitle.notify.audioExternal');
    expect(b.selectionEvents[b.selectionEvents.length - 1]).toBe(b.component.state.confirmed);
    expect(b.component.refs.embed.disabled).toBe(true);
    expect(b.component.refs.external.checked).toBe(true);
    expect(b.component.refs.keep.disabled).toBe(true);
    expect(textOf(b.component.refs.warning)).toContain('subtitle.warn.audio');
  });

  it('the convert select accepts legal values, falls back to none and warns when unconvertible', async () => {
    const b = boot();
    await openReady(b, fullDto());
    const convert = b.component.refs.convert;
    convert.value = 'bogus';
    convert.dispatch('change');
    expect(b.component.state.convertTo).toBe('none');
    convert.value = 'srt';
    convert.dispatch('change');
    expect(b.component.state.convertTo).toBe('srt');
    expect(textOf(b.component.refs.warning)).toContain('subtitle.warn.format{"format":"SRT"}'); // 尚未选择轨道
    select(b, 'en');
    expect(b.component.refs.warning.getAttribute('hidden')).toBe('true');
    clickId(b, 'subtitle-confirm');
    expect(b.component.state.confirmed?.subtitleConvertTo).toBe('srt');
  });
});

describe('subtitle-picker · confirm and ticket lifecycle', () => {
  it('confirm freezes the six flat keys plus previewId and reports via onSelectionChange', async () => {
    const b = boot();
    await openReady(b, fullDto());
    select(b, 'en');
    select(b, 'ja');
    b.component.refs.automatic.checked = true;
    b.component.refs.automatic.dispatch('change');
    b.component.refs.convert.value = 'srt';
    b.component.refs.convert.dispatch('change');
    clickId(b, 'subtitle-confirm');
    expect(b.component.state.confirmed).toEqual({
      url: 'https://example.org/watch?v=abc',
      previewId: 'ticket-00000001',
      expiresAt: new Date(CLOCK + 300_000).toISOString(),
      subtitleLanguages: ['en', 'ja'],
      subtitleAutoCaptions: true,
      subtitleConvertTo: 'srt',
      subtitleEmbed: false,
      subtitleKeepFile: false,
    });
    expect(b.selectionEvents[b.selectionEvents.length - 1]).toBe(b.component.state.confirmed);
    expect(b.modal().getAttribute('hidden')).toBe('true');
    expect(b.notices[b.notices.length - 1]).toContain('subtitle.notify.confirmed');
    expect(b.notices[b.notices.length - 1]).toContain('"n":2');
    expect(b.component.refs.chip.getAttribute('data-state')).toBe('active');
    expect(b.component.refs.button.getAttribute('aria-pressed')).toBe('true');
    const selection = b.component.getSelection() as { subtitleLanguages: string[]; subtitleKeepFile: boolean };
    selection.subtitleLanguages.push('zz');                                  // 拷贝：不影响冻结选区
    expect(b.component.state.confirmed?.subtitleLanguages).toEqual(['en', 'ja']);
    expect(selection.subtitleKeepFile).toBe(false);
    expect(b.calls.map((c) => c.channel)).toEqual(['SUBTITLE_PREVIEW']);     // 确认本身绝不入队
  });

  it('an expired preview cannot be confirmed', async () => {
    const b = boot();
    await openReady(b, dtoFixture({ expiresAt: new Date(CLOCK - 1_000).toISOString() }));
    select(b, 'en');
    clickId(b, 'subtitle-confirm');
    expect(b.component.state.phase).toBe('expired');
    expect(b.component.state.errorKey).toBe('subtitle.error.expired');
    expect(b.component.state.confirmed).toBeNull();
    expect(b.selectionEvents[b.selectionEvents.length - 1]).toBeNull();
    expect(b.notices[b.notices.length - 1]).toBe('subtitle.notify.expired');
    expect(b.component.getSelection()).toBeNull();
  });

  it('getSelection returns false on enqueue-time URL mismatch or expiry', async () => {
    const mismatch = boot();
    await openReady(mismatch, fullDto());
    select(mismatch, 'en');
    clickId(mismatch, 'subtitle-confirm');
    mismatch.setUrl('https://example.org/watch?v=OTHER');                    // 程序化改 URL（无 onUrlChanged）
    expect(mismatch.component.getSelection()).toBe(false);
    expect(mismatch.component.state.phase).toBe('stale');
    expect(mismatch.modal().getAttribute('hidden')).toBe('false');
    expect(mismatch.notices[mismatch.notices.length - 1]).toBe('subtitle.error.stale');

    const expired = boot();
    await openReady(expired, fullDto());
    select(expired, 'en');
    clickId(expired, 'subtitle-confirm');
    expired.advanceClock(400_000);
    expect(expired.component.getSelection()).toBe(false);
    expect(expired.component.state.phase).toBe('expired');
    expect(expired.notices[expired.notices.length - 1]).toBe('subtitle.error.expired');
  });

  it('cancel releases the ticket and never enqueues; a confirmed cancel keeps it', async () => {
    const b = boot();
    await openReady(b, fullDto());
    select(b, 'en');
    clickId(b, 'subtitle-cancel');
    expect(b.component.state.confirmed).toBeNull();
    expect(b.component.state.preview).toBeNull();
    expect(b.component.state.phase).toBe('idle');
    expect(b.modal().getAttribute('hidden')).toBe('true');
    expect(b.calls[1]).toEqual({ channel: 'SUBTITLE_PREVIEW_CANCEL', payload: { previewId: 'ticket-00000001' } });
    expect(b.notices[b.notices.length - 1]).toBe('subtitle.notify.cancelled');
    expect(b.selectionEvents).toHaveLength(0);                               // cancel 不触发 onSelectionChange
    expect(b.calls.some((c) => c.channel === 'DOWNLOAD_START')).toBe(false);

    const keep = boot();
    await openReady(keep, fullDto());
    select(keep, 'en');
    clickId(keep, 'subtitle-confirm');
    clickId(keep, 'subtitle-cancel');
    expect(keep.component.state.confirmed).not.toBeNull();
    expect(keep.component.state.phase).toBe('ready');
    expect(keep.calls).toHaveLength(1);                                      // 不再发 CANCEL
    expect(keep.modal().getAttribute('hidden')).toBe('true');
    expect(keep.notices[keep.notices.length - 1]).not.toBe('subtitle.notify.cancelled');
  });

  it('Esc, the close button and the backdrop click all use the same cancel path', async () => {
    const closed = boot();
    closed.fireKey('keydown', { key: 'Escape' });                            // 关闭状态下按 Esc：早退
    expect(closed.calls).toEqual([]);

    const esc = boot();
    await openReady(esc, fullDto());
    select(esc, 'en');
    esc.fireKey('keydown', { key: 'Escape' });
    expect(esc.component.state.confirmed).toBeNull();
    expect(esc.calls[1]?.channel).toBe('SUBTITLE_PREVIEW_CANCEL');
    expect(esc.modal().getAttribute('hidden')).toBe('true');

    const closeBtn = boot();
    await openReady(closeBtn, fullDto());
    select(closeBtn, 'en');
    clickId(closeBtn, 'subtitle-close');
    expect(closeBtn.component.state.phase).toBe('idle');
    expect(closeBtn.calls[1]?.channel).toBe('SUBTITLE_PREVIEW_CANCEL');

    const backdropCase = boot();
    await openReady(backdropCase, fullDto());
    const modalNode = backdropCase.component.refs.modal;
    backdropCase.component.refs.backdrop.dispatch('click', { target: modalNode });   // 点在模态内部：不关
    expect(backdropCase.component.state.phase).toBe('ready');
    backdropCase.component.refs.backdrop.dispatch('click', { target: backdropCase.component.refs.backdrop });
    expect(backdropCase.component.state.phase).toBe('idle');
  });

  it('clearSelection wipes everything and releases the ticket; the chip clear shares the path', async () => {
    const b = boot();
    await openReady(b, fullDto());
    select(b, 'en');
    clickId(b, 'subtitle-confirm');
    clickId(b, 'subtitle-clear');
    expect(b.component.state.phase).toBe('idle');
    expect(b.component.state.confirmed).toBeNull();
    expect(b.component.state.preview).toBeNull();
    expect(b.component.refs.convert.value).toBe('none');
    expect(b.component.refs.button.getAttribute('aria-pressed')).toBe('false');
    expect(b.component.getSelection()).toBeNull();
    expect(b.calls[1]?.channel).toBe('SUBTITLE_PREVIEW_CANCEL');
    expect(b.selectionEvents[b.selectionEvents.length - 1]).toBeNull();

    const viaChip = boot();
    await openReady(viaChip, fullDto());
    select(viaChip, 'en');
    clickId(viaChip, 'subtitle-confirm');
    viaChip.component.refs.chip.children[1].dispatch('click', { preventDefault() { /* noop */ } });
    expect(viaChip.component.state.phase).toBe('idle');
    expect(viaChip.component.state.confirmed).toBeNull();
  });

  it('re-opening a still-valid confirmed selection restores the draft without probing', async () => {
    const b = boot();
    await openReady(b, fullDto());
    select(b, 'en');
    b.component.refs.automatic.checked = true;
    b.component.refs.automatic.dispatch('change');
    b.component.refs.convert.value = 'srt';
    b.component.refs.convert.dispatch('change');
    clickId(b, 'subtitle-confirm');
    b.component.refs.button.click();
    await tick();
    expect(b.calls.filter((c) => c.channel === 'SUBTITLE_PREVIEW')).toHaveLength(1);   // 零新探测
    expect(b.component.state.phase).toBe('ready');
    expect(boxFor(b, 'en').checked).toBe(true);
    expect(b.component.refs.automatic.checked).toBe(true);
    expect(b.component.refs.convert.value).toBe('srt');
    expect(b.component.state.selected).toEqual({ en: true });
  });

  it('re-opening an expired confirmed selection re-probes with previousPreviewId', async () => {
    const b = boot();
    await openReady(b, fullDto());
    select(b, 'en');
    clickId(b, 'subtitle-confirm');
    b.advanceClock(400_000);
    b.component.refs.button.click();
    await tick();
    expect(b.calls[1]).toEqual({
      channel: 'SUBTITLE_PREVIEW',
      payload: { url: 'https://example.org/watch?v=abc', previousPreviewId: 'ticket-00000001' },
    });
    expect(b.component.state.phase).toBe('ready');
  });

  it('confirm during loading is a no-op', async () => {
    let resolvePreview: (value: unknown) => void = () => {};
    const b = boot({
      onCall: (channel) => channel === 'SUBTITLE_PREVIEW'
        ? new Promise((resolve) => { resolvePreview = resolve; })
        : undefined,
    });
    b.component.refs.button.click();
    b.component.confirm();
    expect(b.component.state.confirmed).toBeNull();
    resolvePreview({ ok: true, preview: fullDto() });
    await tick();
    expect(b.component.state.phase).toBe('ready');
  });

  it('create honours the option defaults (noop notify, video kind, Date.now, noop selection hook)', async () => {
    const env = makeDoc();
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const component = pickerFactory.create({
      doc: env.doc,
      t,
      call(channel: string, payload: unknown): Promise<unknown> {
        calls.push({ channel, payload });
        return channel === 'SUBTITLE_PREVIEW'
          ? Promise.resolve({ ok: true, preview: dtoFixture({ expiresAt: '9999-12-31T23:59:59.999Z' }) })
          : Promise.resolve({ ok: true, canceled: true });
      },
      getUrl: () => 'https://example.org/watch?v=min',
    });
    component.mount(env.doc.createElement('form') as TestNode, '../styles/subtitles.css');
    component.refs.button.click();
    await tick();
    expect(component.state.phase).toBe('ready');
    const enRow = component.refs.rows.children
      .find((c) => c.getAttribute('data-language') === 'en') as TestNode;
    const box = enRow.children[0] as TestNode;
    box.checked = true;
    box.dispatch('change');
    expect(component.refs.confirm.disabled).toBe(false);
    component.confirm();                                                     // 默认 notify / onSelectionChange 被调用
    expect(component.state.confirmed?.subtitleLanguages).toEqual(['en']);
    expect(component.refs.embed.disabled).toBe(false);                       // 默认 getKind = video
    expect(calls).toHaveLength(1);
  });

  it('a synchronously throwing cancel call is swallowed (best-effort cleanup)', async () => {
    const b = boot({
      onCall: (channel) => {
        if (channel === 'SUBTITLE_PREVIEW_CANCEL') throw new Error('sync bridge failure');
        return undefined;
      },
    });
    await openReady(b, fullDto());
    select(b, 'en');
    clickId(b, 'subtitle-cancel');                                           // try/catch 吞掉同步异常
    expect(b.component.state.phase).toBe('idle');
    expect(b.component.state.preview).toBeNull();
    expect(b.calls[1]?.channel).toBe('SUBTITLE_PREVIEW_CANCEL');
  });
});

describe('subtitle-picker · enqueue result and URL invalidation', () => {
  it('a success receipt consumes the one-shot ticket and clears the choice', async () => {
    const b = boot();
    await openReady(b, fullDto());
    select(b, 'en');
    clickId(b, 'subtitle-confirm');
    expect(b.component.onEnqueueResult({ accepted: true, enqueued: true, taskIds: ['t-1'] })).toBeNull();
    expect(b.component.state.phase).toBe('idle');
    expect(b.component.state.confirmed).toBeNull();
    expect(b.component.getSelection()).toBeNull();
    expect(b.component.refs.button.getAttribute('aria-pressed')).toBe('false');
    expect(b.calls.some((c) => c.channel === 'SUBTITLE_PREVIEW_CANCEL')).toBe(false);  // 票据已被主进程消费
  });

  it('a dead-ticket receipt freezes the choice and returns the error sentence', async () => {
    const b = boot();
    await openReady(b, fullDto());
    select(b, 'en');
    clickId(b, 'subtitle-confirm');
    const frozen = b.component.state.confirmed;
    const message = b.component.onEnqueueResult({
      accepted: false, enqueued: false, code: 'SUBTITLE_NO_MANUAL_TRACK',
    });
    expect(message).toBe('subtitle.warn.automaticRequired');
    expect(b.component.state.confirmed?.expiresAt).toBe('1970-01-01T00:00:00.000Z');
    expect(b.component.state.phase).toBe('expired');
    expect(b.component.state.preview).toBeNull();
    expect(b.component.getSelection()).toBe(false);
    expect(b.selectionEvents[b.selectionEvents.length - 1]).toBe(b.component.state.confirmed);
    expect(frozen).not.toBeNull();
  });

  it('onEnqueueResult without a receipt or without a confirmed choice is a no-op branch', async () => {
    const fresh = boot();
    expect(fresh.component.onEnqueueResult({ accepted: false })).toBeNull();
    expect(fresh.component.onEnqueueResult(undefined)).toBeNull();

    const b = boot();
    await openReady(b, fullDto());
    select(b, 'en');
    clickId(b, 'subtitle-confirm');
    expect(b.component.onEnqueueResult(undefined)).toBe('subtitle.error.expired');
    expect(b.component.state.phase).toBe('expired');
    expect(b.component.state.confirmed).not.toBeNull();
  });

  it('onUrlChanged tracks silently when idle, invalidates with a selection, and is idempotent', async () => {
    // 页面 URL（getUrl）与组件内 state.url 必须一致，才能区分"同 URL 追踪"与"换 URL 失效"。
    const b = boot({ url: 'https://example.org/first' });
    expect(b.component.onUrlChanged('https://example.org/first')).toBe(false);
    expect(b.component.state.url).toBe('https://example.org/first');
    await openReady(b, fullDto());
    select(b, 'en');
    clickId(b, 'subtitle-confirm');
    expect(b.component.onUrlChanged('https://example.org/first')).toBe(false);  // 同 URL 且仍有选区：只追踪
    expect(b.component.onUrlChanged('https://example.org/other')).toBe(true);
    expect(b.component.state.phase).toBe('stale');
    expect(b.component.state.confirmed).toBeNull();
    expect(b.component.state.url).toBe('https://example.org/other');
    expect(b.calls[1]).toEqual({ channel: 'SUBTITLE_PREVIEW_CANCEL', payload: { previewId: 'ticket-00000001' } });
    expect(b.selectionEvents[b.selectionEvents.length - 1]).toBeNull();
    expect(b.component.onUrlChanged('https://example.org/other')).toBe(false);
  });
});

describe('subtitle-picker · test hook, privacy and escaping', () => {
  it('renderPreview paints a whitelisted DTO with zero IPC and close() hides the modal', () => {
    const b = boot();
    b.component.renderPreview(dtoFixture());
    expect(b.component.state.phase).toBe('ready');
    expect(b.modal().getAttribute('hidden')).toBe('false');
    expect(b.calls).toEqual([]);
    b.component.renderPreview(dtoFixture({ previewId: 'ticket-2', media: undefined }));
    expect(b.component.refs.media.getAttribute('hidden')).toBe('true');
    b.component.close();
    expect(b.modal().getAttribute('hidden')).toBe('true');
  });

  it('never renders the video URL or its signature into DOM text or attributes', async () => {
    const b = boot({ url: 'https://example.org/watch?v=SUPERSECRET&sig=abcdef' });
    await openReady(b, fullDto());
    select(b, 'en');
    clickId(b, 'subtitle-confirm');
    for (const n of [...allNodes(b.body), ...allNodes(b.anchor)]) {
      expect(n.textContent).not.toContain('SUPERSECRET');
      expect(n.textContent).not.toContain('https://');
      for (const value of Object.values(n.attrs)) {
        expect(value).not.toContain('SUPERSECRET');
        expect(value).not.toContain('https://');
      }
    }
  });

  it('site-supplied text is painted as text, never parsed as markup', async () => {
    const b = boot();
    await openReady(b, dtoFixture({
      media: { title: '<img src=x onerror=alert(1)>', uploader: '<b>Studio</b>', durationSec: 60 },
      tracks: [trackFixture({ languageName: '<script>bad()</script>' })],
    }));
    const modalText = textOf(b.modal());
    expect(modalText).toContain('<img src=x onerror=alert(1)>');
    expect(modalText).toContain('<script>bad()</script>');
    const tags = allNodes(b.modal()).map((n) => n.tagName);
    expect(tags).not.toContain('IMG');
    expect(tags).not.toContain('SCRIPT');
  });
});
