/**
 * Playlist selector · REAL shipped component against a tiny fake DOM.
 *
 * Executes `packages/ui/src/playlists/playlist-import.js` verbatim, so these
 * cases verify the user-visible contract: default select-all, bulk actions,
 * search that never mutates selection, one-confirm enqueue and an honest
 * result line. No mock of the component itself.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpolate } from '@ytvdlt/core';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const UI_SRC = join(ROOT, 'packages', 'ui', 'src');
const COMPONENT = readFileSync(join(UI_SRC, 'playlists', 'playlist-import.js'), 'utf8');
const CATALOGUE = readFileSync(join(UI_SRC, 'i18n', 'messages.js'), 'utf8');

type Listener = (event?: { preventDefault?: () => void }) => void;

class FakeNode {
  readonly attrs: Record<string, string> = {};
  readonly children: FakeNode[] = [];
  readonly listeners: Record<string, Listener[]> = {};
  parentNode: FakeNode | null = null;
  checked = false;
  disabled = false;
  value = '';
  private text = '';

  constructor(readonly tagName: string, private readonly owner: FakeDoc) {}

  set className(value: string) { this.attrs['class'] = String(value); }
  get className(): string { return this.attrs['class'] ?? ''; }
  setAttribute(key: string, value: unknown): void {
    this.attrs[key] = String(value);
    if (key === 'id') this.owner.byId.set(String(value), this);
  }
  getAttribute(key: string): string | null { return this.attrs[key] ?? null; }
  removeAttribute(key: string): void { delete this.attrs[key]; }
  appendChild(child: FakeNode): FakeNode {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(node: FakeNode, ref: FakeNode | null): FakeNode {
    node.parentNode = this;
    const at = ref === null ? this.children.length : this.children.indexOf(ref);
    this.children.splice(at < 0 ? this.children.length : at, 0, node);
    return node;
  }
  removeChild(node: FakeNode): FakeNode {
    const at = this.children.indexOf(node);
    if (at !== -1) this.children.splice(at, 1);
    node.parentNode = null;
    return node;
  }
  get nextSibling(): FakeNode | null {
    if (this.parentNode === null) return null;
    const at = this.parentNode.children.indexOf(this);
    return this.parentNode.children[at + 1] ?? null;
  }
  addEventListener(type: string, fn: Listener): void { (this.listeners[type] ??= []).push(fn); }
  get textContent(): string {
    return this.children.length === 0
      ? this.text : this.children.map((child) => child.textContent).join('');
  }
  set textContent(value: string) { this.children = []; this.text = String(value); }
  click(): void { (this.listeners['click'] ?? []).forEach((fn) => fn({ preventDefault() {} })); }
  change(): void { (this.listeners['change'] ?? []).forEach((fn) => fn()); }
  input(): void { (this.listeners['input'] ?? []).forEach((fn) => fn()); }
}

class FakeDoc {
  readonly byId = new Map<string, FakeNode>();
  readonly head = new FakeNode('head', this);
  readonly body = new FakeNode('body', this);
  createElement(tag: string): FakeNode { return new FakeNode(tag, this); }
  getElementById(id: string): FakeNode | null { return this.byId.get(id) ?? null; }
}

interface Call { channel: string; payload: Record<string, unknown> }

function t(key: string, params?: Record<string, unknown>): string {
  const sandbox: Record<string, unknown> = {};
  new Function('window', CATALOGUE)(sandbox);
  const messages = (sandbox['YTVDLT_I18N'] as {
    MESSAGES: Record<string, Record<string, string>>;
  }).MESSAGES;
  const raw = messages['zh-CN']?.[key];
  return typeof raw === 'string' ? interpolate(raw, params ?? {}) : key;
}

const URL_A = 'https://www.youtube.com/playlist?list=PL_GTA_65';

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

function harness(replies: {
  preview?: Record<string, unknown>;
  enqueue?: Record<string, unknown>;
} = {}) {
  const doc = new FakeDoc();
  const calls: Call[] = [];
  const notices: string[] = [];
  const singleUrls: string[] = [];
  let refreshed = 0;
  const sandbox: Record<string, unknown> = {};
  new Function('window', COMPONENT)(sandbox);

  const call = (channel: string, payload: Record<string, unknown>): Promise<unknown> => {
    calls.push({ channel, payload });
    if (channel === 'PLAYLIST_PREVIEW') return Promise.resolve(replies.preview ?? previewDto());
    if (channel === 'PLAYLIST_BATCH_ENQUEUE') {
      return Promise.resolve(replies.enqueue ?? {
        ok: true, code: '', requested: 63, enqueued: 63, failed: 0,
        taskIds: [], failures: [],
      });
    }
    return Promise.resolve({ ok: true });
  };

  const factory = (sandbox['YTVDLT'] as {
    playlists: { create(o: Record<string, unknown>): any; isPlaylistLike(s: string): boolean };
  }).playlists;
  const component = factory.create({
    doc, t, call,
    notify: (text: string) => notices.push(text),
    getChoice: () => ({ kind: 'video', videoQuality: '1080p', audioQuality: 'best', audioFormat: 'auto' }),
    refresh: () => { refreshed += 1; },
    startSingleDownload: (url: string) => singleUrls.push(url),
    readUrl: () => URL_A,
  });
  const parent = doc.createElement('div');
  const anchor = doc.createElement('form');
  anchor.setAttribute('id', 'queue-paste-form');
  parent.appendChild(anchor);
  component.mount(anchor, '../../styles/playlist-import.css');
  return {
    doc, calls, notices, singleUrls, component, factory,
    refreshed: () => refreshed,
    entry: doc.getElementById('queue-import-playlist'),
  };
}

const tick = async (): Promise<void> => { await new Promise((resolve) => setImmediate(resolve)); };

async function open(h: ReturnType<typeof harness>, url = URL_A) {
  h.component.open(url);
  await tick();
  return h;
}

describe('Playlist selector · auto-detect and default select all', () => {
  it('mounts one entry button and sends nothing until opened', () => {
    const h = harness();
    expect(h.entry?.textContent).toBe('导入播放列表');
    expect(h.calls).toEqual([]);
  });

  it.each([
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/watch?v=abc&list=PL123',
    'https://www.youtube.com/@someone/videos',
    'https://soundcloud.com/user/sets/mix',
  ])('detects %s as a playlist', (url) => {
    expect(harness().factory.isPlaylistLike(url)).toBe(true);
  });

  it('does not misdetect a plain watch URL', () => {
    expect(harness().factory.isPlaylistLike('https://www.youtube.com/watch?v=abc')).toBe(false);
  });

  it('opens with PREVIEW only — nothing is enqueued before confirmation', async () => {
    const h = await open(harness());
    expect(h.calls.map((c) => c.channel)).toEqual(['PLAYLIST_PREVIEW']);
    expect(h.calls[0]?.payload.url).toBe(URL_A);
    expect(h.calls.some((c) => c.channel === 'PLAYLIST_BATCH_ENQUEUE')).toBe(false);
  });

  it('defaults to ALL downloadable entries selected (63 of 65)', async () => {
    const h = await open(harness());
    expect(h.component.state().selected).toHaveLength(63);
    expect(h.doc.getElementById('pl-confirm')?.textContent).toBe('下载全部 63 个视频');
    expect(h.doc.getElementById('pl-body')?.textContent).toContain('GTA 游戏合集');
    expect(h.doc.getElementById('pl-list')?.children).toHaveLength(65);
  });

  it('shows declared / fetched / available / unavailable separately', async () => {
    const h = await open(harness({ preview: previewDto(20, { declaredCount: 65 }) }));
    const text = h.doc.getElementById('pl-body')?.textContent ?? '';
    expect(text).toContain('只解析到 20 / 65 个条目');
    expect(text).toContain('声明条目总数');
    expect(text).toContain('实际解析到');
  });
});

describe('Playlist selector · bulk actions and search', () => {
  it('select none → 0, select all → 63, invert → 0', async () => {
    const h = await open(harness());
    h.doc.getElementById('pl-none')?.click();
    expect(h.component.state().selected).toHaveLength(0);
    expect(h.doc.getElementById('pl-confirm')?.getAttribute('disabled')).toBe('disabled');
    h.doc.getElementById('pl-all')?.click();
    expect(h.component.state().selected).toHaveLength(63);
    h.doc.getElementById('pl-invert')?.click();
    expect(h.component.state().selected).toHaveLength(0);
  });

  it('search filters the visible rows but NEVER changes the selection', async () => {
    const h = await open(harness());
    const before = h.component.state().selected.slice();
    const search = h.doc.getElementById('pl-search');
    expect(search).not.toBeNull();
    if (search !== null) { search.value = '第 01 集'; search.input(); }
    const visible = h.doc.getElementById('pl-list')?.children ?? [];
    expect(visible.length).toBeLessThan(65);
    expect(h.component.state().selected).toEqual(before);
    expect(h.doc.getElementById('pl-confirm')?.textContent).toBe('下载全部 63 个视频');
  });

  it('bulk actions cover all entries even while a search is active', async () => {
    const h = await open(harness());
    const search = h.doc.getElementById('pl-search');
    if (search !== null) { search.value = '第 01 集'; search.input(); }
    h.doc.getElementById('pl-none')?.click();
    h.doc.getElementById('pl-all')?.click();
    expect(h.component.state().selected).toHaveLength(63);
  });

  it('unchecking one row updates the count without rebuilding the dialog', async () => {
    const h = await open(harness());
    const first = h.doc.getElementById('pl-list')?.children[0]?.children[0];
    expect(first).not.toBeNull();
    if (first) { first.checked = false; first.change(); }
    expect(h.component.state().selected).toHaveLength(62);
    expect(h.doc.getElementById('pl-confirm')?.textContent).toBe('下载全部 62 个视频');
    expect(h.component.state().query).toBe('');
  });

  it('unavailable entries stay unselectable', async () => {
    const h = await open(harness());
    const rows = h.doc.getElementById('pl-list')?.children ?? [];
    const unavailable = rows.filter((r) => r.getAttribute('data-available') === 'false');
    expect(unavailable).toHaveLength(2);
    expect(unavailable.every((r) => r.children[0]?.disabled === true)).toBe(true);
  });

  it('shows the selected total duration', async () => {
    const h = await open(harness());
    expect(h.doc.getElementById('pl-duration')?.textContent).toContain('10:30:00');
  });
});

describe('Playlist selector · confirm, cancel and honest results', () => {
  it('cancel releases the ticket and creates NO task', async () => {
    const h = await open(harness());
    h.doc.getElementById('pl-cancel')?.click();
    expect(h.calls.map((c) => c.channel)).toEqual([
      'PLAYLIST_PREVIEW', 'PLAYLIST_PREVIEW_CANCEL',
    ]);
    expect(h.calls.some((c) => c.channel === 'PLAYLIST_BATCH_ENQUEUE')).toBe(false);
    expect(h.component.isOpen()).toBe(false);
  });

  it('confirm sends ONLY (previewId, url, ids) + existing download enums', async () => {
    const h = await open(harness());
    h.doc.getElementById('pl-confirm')?.click();
    await tick();
    const sent = h.calls.find((c) => c.channel === 'PLAYLIST_BATCH_ENQUEUE');
    expect(sent?.payload).toMatchObject({ previewId: 'preview-ticket-0001', url: URL_A, kind: 'video', quality: '1080p' });
    expect(sent?.payload.selectedIds).toHaveLength(63);
    expect('playlist' in (sent?.payload ?? {})).toBe(false);
    expect(h.refreshed()).toBe(1);
  });

  it('reports the real result, including partial failure', async () => {
    const h = await open(harness({
      enqueue: {
        ok: false, code: 'PARTIAL_SUCCESS', requested: 65, enqueued: 60, failed: 5,
        taskIds: [], failures: [{ id: 'ep9', reason: 'ENQUEUE_FAILED' }],
      },
    }));
    h.doc.getElementById('pl-confirm')?.click();
    await tick();
    const text = h.doc.getElementById('pl-body')?.textContent ?? '';
    expect(text).toContain('共 65 条，成功加入 60 个任务，失败 5 个');
    expect(text).toContain('部分任务加入成功');
    expect(text).toContain('ep9');
    expect(h.notices[0]).toContain('成功加入 60 个任务');
  });

  /**
   * R1-03 - the same tally on the playlist surface.
   *
   * The DTO carries IDS, not urls (the whole file is display-safe by contract),
   * so the buckets are rendered by id - the same identifier the selection list
   * already shows. The point of the assertion is that the numbers reach the
   * dialog at all: before this the batch reported only the refusals, so entries
   * that came back unconfirmed looked exactly like confirmed ones.
   */
  it('renders the pre-check tally and the ids it could not confirm', async () => {
    const h = await open(harness({
      enqueue: {
        ok: true, code: '', requested: 65, enqueued: 65, failed: 0,
        taskIds: [], failures: [],
        precheck: {
          examined: 65, supported: 60, unsupported: 0, noMedia: 2, indeterminate: 3,
          skipped: 0,
          unsupportedIds: [], noMediaIds: ['ep7', 'ep8'],
          indeterminateIds: ['ep11', 'ep12', 'ep13'],
        },
      },
    }));
    h.doc.getElementById('pl-confirm')?.click();
    await tick();
    const text = h.doc.getElementById('pl-body')?.textContent ?? '';
    expect(text).toContain('链接预检');
    expect(text).toContain('支持 60');
    expect(text).toContain('无媒体 2');
    expect(text).toContain('未确认 3');
    expect(text).toContain('无媒体 — ep7');
    expect(text).toContain('未确认 — ep13');
  });

  it('a failed probe shows an error and offers the single-download fallback', async () => {
    const h = await open(harness({
      preview: { ok: false, code: 'NOT_PLAYLIST', previewId: '', entries: [] },
    }));
    expect(h.doc.getElementById('pl-body')?.textContent).toContain('这不是播放列表链接');
    expect(h.calls.some((c) => c.channel === 'PLAYLIST_BATCH_ENQUEUE')).toBe(false);
    h.doc.getElementById('pl-fallback')?.click();
    expect(h.singleUrls).toEqual([URL_A]);
    expect(h.calls.some((c) => c.channel === 'PLAYLIST_BATCH_ENQUEUE')).toBe(false);
  });

  it('an empty selection cannot be confirmed', async () => {
    const h = await open(harness());
    h.doc.getElementById('pl-none')?.click();
    h.doc.getElementById('pl-confirm')?.click();
    await tick();
    expect(h.calls.some((c) => c.channel === 'PLAYLIST_BATCH_ENQUEUE')).toBe(false);
  });
});
