/**
 * D-187 · playlist-batch.js 真实行为单测（M4-4 批量预览页，冻结语义只测不修）。
 *
 * 【import 路线】共享装载架 helpers/ui-harness.ts 真实 `import()`，v8 覆盖率可见。
 * 页面在 import 时刻读 `window.__YTVDLT_FIXTURE__`（页面加载器注入的 L1 录制数据）
 * 与 location.search（?selected= / ?concurrency= / ?error=1 / ?autoconfirm=1），
 * 渲染一次并给 batch-enqueue 绑定 emit。
 *
 * 【场景驱动】两条通道：
 *  - `render()` / `selectedIds()` 是 YTVDLTBatch 暴露的动态入口：fixture() 与
 *    param() 在每次调用时现读 window 与 location.search —— 直接改输入反复驱动，
 *    覆盖选择解析、去重、未知条目跳过、并发钳制、空/错态、时长格式化、
 *    SAMPLE 兜底、标题回退；
 *  - 依赖「import 时刻模型」的分支（autoconfirm、按钮闭包 emit、emit 的
 *    EMPTY_SELECTION）用 `vi.resetModules()` + 换 search 重装（重装前清掉按钮
 *    上旧实例的监听器 —— harness 的 dispatch 闭包持有 listeners 对象，原地
 *    删除键即可）。
 *
 * 【冻结语义】一行一个选中条目、data-playlist-items 永远是播放列表原始位次
 * （不是点击顺序）、页面绝不启动下载（只 emit 任务清单）—— 按现状钉住。
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installUiGlobals, loadUiModule, type UiGlobals, type UiNode } from './helpers/ui-harness.js';

/** tests/e2e/fixtures/dialog-playlist.json —— M1 录制的 L1 扁平播放列表（a1/a2/a3）。 */
const REAL_PLAYLIST_FIXTURE = JSON.parse(
  readFileSync('tests/e2e/fixtures/dialog-playlist.json', 'utf8'),
) as { playlist: Record<string, unknown> };

let globals: UiGlobals | null = null;
let batch: any = null; // window.YTVDLTBatch

const win = () => globals!.window as Record<string, any>;
const doc = () => globals!.document as any;
const node = (id: string): UiNode => globals!.nodes.get(id) as UiNode;
const flush = async (rounds = 6): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};

/** render 入口：先清行容器（harness 的 textContent='' 不清 children），再走真实渲染。 */
function render(): any {
  node('batch-rows').children.length = 0;
  return batch.render();
}

/** 当前行列表（按 data-task-id 去重取最后一次渲染的节点）。 */
function rowsOf(): Array<Record<string, string>> {
  const seen = new Map<string, UiNode>();
  for (const child of node('batch-rows').children) {
    const id = child.getAttribute('data-task-id');
    if (id !== null) seen.set(id, child);
  }
  return [...seen.values()].map((row) => ({
    taskId: row.getAttribute('data-task-id') as string,
    position: row.getAttribute('data-playlist-items') as string,
    title: (row.children[1] as UiNode).textContent,
    meta: (row.children[2] as UiNode).textContent,
  }));
}

/** 查询变体：清按钮旧监听器 + 行容器，重装模块拿到全新的 import 时刻模型。 */
async function reloadBatch(search: string, fixture?: unknown): Promise<any> {
  for (const id of ['batch-enqueue', 'batch-rows']) {
    const n = globals!.nodes.get(id);
    if (n !== undefined) {
      for (const type of Object.keys(n.listeners)) delete n.listeners[type];
      n.children.length = 0;
    }
  }
  if (fixture === undefined) delete (win() as any).__YTVDLT_FIXTURE__;
  else (win() as any).__YTVDLT_FIXTURE__ = fixture;
  win().location.search = search;
  vi.resetModules();
  await loadUiModule('pages/queue/playlist-batch.js', globals!);
  await flush();
  return win().YTVDLTBatch;
}

beforeAll(async () => {
  vi.useFakeTimers();
  globals = installUiGlobals({
    bridge: null, // 页面零 IPC：emit 只写 <pre id="ytvdlt-output">
    location: { href: 'file:///C:/app/pages/batch/index.html', search: '', protocol: 'file:' },
    injected: { __YTVDLT_FIXTURE__: REAL_PLAYLIST_FIXTURE },
  });
  await loadUiModule('pages/queue/playlist-batch.js', globals);
  batch = win().YTVDLTBatch;
  await flush();
});

afterAll(() => {
  globals?.restore();
  globals = null;
  batch = null;
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 族一 · 引导渲染：真实 fixture、原始位次、行形状
// ---------------------------------------------------------------------------
describe('D-187 · playlist-batch：fixture 驱动的批量预览页', () => {
  it('引导基线：全部条目入列、位次取播放列表原始顺序、时长来自录制数据', () => {
    expect(rowsOf().map((r) => [r.taskId, r.position, r.title])).toEqual([
      ['PL_fixture_01-a1', '1', 'Episode 1'],
      ['PL_fixture_01-a2', '2', 'Episode 2'],
      ['PL_fixture_01-a3', '3', 'Episode 3'],
    ]);
    expect(node('batch-title').textContent).toBe('Recorded Flat Playlist');
    expect(node('batch-selected').textContent).toBe('3');
    expect(node('batch-tasks').textContent).toBe('3');
    expect(node('batch-limit').textContent).toBe('3'); // 默认并发 3
    expect(node('batch-concurrency').textContent).toBe('3');
    expect(node('ytvdlt-batch').getAttribute('data-state')).toBe('ready');
    expect(node('ytvdlt-batch').getAttribute('data-task-count')).toBe('3');
    expect(node('batch-empty').getAttribute('hidden')).toBe('true');
    expect(node('batch-error').getAttribute('hidden')).toBe('true');
    expect(String(node('batch-rows').getAttribute('hidden'))).not.toBe('true');
    expect(node('batch-enqueue').getAttribute('aria-disabled')).toBe('false');
    expect(node('batch-enqueue').getAttribute('data-confirm')).toBe('enabled');
    // 时长格式化：100s → 1:40，200s → 3:20，null → —（真实录制数据里 a3 没有时长）
    expect(rowsOf().map((r) => r.meta)).toEqual([
      '条目 #1 · 1:40', '条目 #2 · 3:20', '条目 #3 · —',
    ]);
  });

  it('?selected=：点击顺序无关、去重、未知条目跳过、空白项丢弃（冻结语义）', () => {
    win().location.search = '?selected=a2,a1,a2,%20,a9';
    const model = render();
    // 行序按 selected 出现顺序，但 data-playlist-items 是原始位次（2 和 1）
    expect(model.rows.map((r: any) => [r.id, r.position])).toEqual([
      ['PL_fixture_01-a2', 2], ['PL_fixture_01-a1', 1],
    ]);
    expect(rowsOf().map((r) => [r.taskId, r.position])).toEqual([
      ['PL_fixture_01-a2', '2'], ['PL_fixture_01-a1', '1'],
    ]);
    expect(node('batch-selected').textContent).toBe('4'); // selectedIds 已滤掉空白项
    expect(node('batch-tasks').textContent).toBe('2'); // 去重 + 跳过未知后的行数
    expect(model.ids).toEqual(['a2', 'a1', 'a2', 'a9']); // 空白项在选择解析层就被丢弃
    win().location.search = '';
  });

  it('selectedIds：空串回退全选；非空串（哪怕过滤后为空）不回退', () => {
    win().location.search = '';
    expect(batch.selectedIds(REAL_PLAYLIST_FIXTURE.playlist)).toEqual(['a1', 'a2', 'a3']);
    win().location.search = '?selected=';
    expect(batch.selectedIds(REAL_PLAYLIST_FIXTURE.playlist)).toEqual(['a1', 'a2', 'a3']);
    win().location.search = '?selected=%20,%20';
    expect(batch.selectedIds(REAL_PLAYLIST_FIXTURE.playlist)).toEqual([]); // 有值但全空白
    win().location.search = '';
  });

  it('?concurrency=：1..8 原样，>8 钳到 8，<1 / NaN 回落 3', () => {
    for (const [raw, expected] of [['5', 5], ['12', 8], ['0', 3], ['-2', 3], ['abc', 3], ['', 3]] as const) {
      win().location.search = raw === '' ? '' : `?concurrency=${raw}`;
      const model = render();
      expect(model.concurrency, `?concurrency=${raw}`).toBe(expected);
      expect(node('batch-limit').textContent).toBe(String(expected));
      expect(node('batch-concurrency').textContent).toBe(String(Math.min(expected, model.rows.length)));
    }
    win().location.search = '';
  });

  it('空选择 → empty 态：行隐藏、空态亮出、入队按钮禁用', () => {
    win().location.search = '?selected=%20';
    const model = render();
    expect(model.rows).toEqual([]);
    expect(node('ytvdlt-batch').getAttribute('data-state')).toBe('empty');
    expect(node('batch-empty').getAttribute('hidden')).toBe('false');
    expect(String(node('batch-rows').getAttribute('hidden'))).toBe('true');
    expect(node('batch-enqueue').getAttribute('aria-disabled')).toBe('true');
    expect(node('batch-enqueue').getAttribute('data-confirm')).toBe('disabled');
    win().location.search = '';
  });

  it('?error=1 → error 态：错误盒亮出、行隐藏、按钮禁用（与空态互不覆盖）', () => {
    win().location.search = '?error=1&selected=a1';
    const model = render();
    expect(model.rows).toHaveLength(1); // 行照常解析，只是页面进入错误态
    expect(node('ytvdlt-batch').getAttribute('data-state')).toBe('error');
    expect(node('batch-error').getAttribute('hidden')).toBe('false');
    expect(node('batch-empty').getAttribute('hidden')).toBe('true');
    expect(String(node('batch-rows').getAttribute('hidden'))).toBe('true');
    expect(node('batch-enqueue').getAttribute('aria-disabled')).toBe('true');
    win().location.search = '';
  });

  it('fixture 兜底链：无注入 → SAMPLE 六条；注入形状坏 → SAMPLE；顶层 entries 形状直用', () => {
    delete (win() as any).__YTVDLT_FIXTURE__;
    let model = render();
    expect(model.playlist.id).toBe('PL_fixture_01'); // 内置 SAMPLE
    expect(model.rows).toHaveLength(6);
    // 注入了但没有可用 entries → SAMPLE
    (win() as any).__YTVDLT_FIXTURE__ = { playlist: { id: 'broken', entries: [] } };
    model = render();
    expect(model.playlist.id).toBe('PL_fixture_01');
    expect(node('batch-title').textContent).toBe('Recorded Flat Playlist');
    // 顶层 entries（不带 playlist 包装）→ 直接使用
    (win() as any).__YTVDLT_FIXTURE__ = {
      id: 'top-level', title: '顶层注入', webpage_url: 'https://example.org/top',
      entries: [{ id: 'b1', title: 'B1', duration: 30 }],
    };
    model = render();
    expect(model.playlist.id).toBe('top-level');
    expect(node('batch-title').textContent).toBe('顶层注入');
    expect(model.rows).toEqual([{ id: 'top-level-b1', position: 1, title: 'B1', duration: 30 }]);
    // 标题缺失 → 「播放列表」占位
    (win() as any).__YTVDLT_FIXTURE__ = {
      id: 'no-title', entries: [{ id: 'c1', title: 'C1', duration: 10 }],
    };
    render();
    expect(node('batch-title').textContent).toBe('播放列表');
    (win() as any).__YTVDLT_FIXTURE__ = REAL_PLAYLIST_FIXTURE;
    render();
  });

  it('时长格式化边界：0 / 59 / 60 / 61 / 负数 / 非有限值', () => {
    (win() as any).__YTVDLT_FIXTURE__ = {
      id: 'dur', title: '时长边界',
      entries: [
        { id: 'd0', title: 'd0', duration: 0 },
        { id: 'd59', title: 'd59', duration: 59 },
        { id: 'd60', title: 'd60', duration: 60 },
        { id: 'd61', title: 'd61', duration: 61 },
        { id: 'dneg', title: 'dneg', duration: -5 },
        { id: 'dinf', title: 'dinf', duration: Number.POSITIVE_INFINITY },
        { id: 'dstr', title: 'dstr', duration: 'x' },
      ],
    };
    render();
    expect(rowsOf().map((r) => r.meta)).toEqual([
      '条目 #1 · 0:00', '条目 #2 · 0:59', '条目 #3 · 1:00', '条目 #4 · 1:01',
      '条目 #5 · —', '条目 #6 · —', '条目 #7 · —',
    ]);
    (win() as any).__YTVDLT_FIXTURE__ = REAL_PLAYLIST_FIXTURE;
    render();
  });
});

// ---------------------------------------------------------------------------
// 族二 · emit：import 时刻模型的按钮闭包、autoconfirm 钩子、EMPTY_SELECTION
// ---------------------------------------------------------------------------
describe('D-187 · playlist-batch：emit 契约（页面绝不启动下载，只交任务清单）', () => {
  it('boot 模型闭包：点击 batch-enqueue → ytvdlt-output 落任务清单 JSON（不含 URL 列表）', () => {
    node('batch-enqueue').dispatch('click');
    const emitted = JSON.parse(node('ytvdlt-output').textContent);
    expect(emitted).toEqual({
      accepted: true,
      enqueued: true,
      kind: 'playlist',
      playlistUrl: 'https://example.org/playlist?list=PL_fixture_01',
      taskIds: ['PL_fixture_01-a1', 'PL_fixture_01-a2', 'PL_fixture_01-a3'],
    });
  });

  it('?autoconfirm=1&selected=a2,a1：引导即 emit，taskIds 按 selected 顺序', async () => {
    const fresh = await reloadBatch('?autoconfirm=1&selected=a2,a1', REAL_PLAYLIST_FIXTURE);
    const emitted = JSON.parse(node('ytvdlt-output').textContent);
    expect(emitted.accepted).toBe(true);
    expect(emitted.enqueued).toBe(true);
    expect(emitted.taskIds).toEqual(['PL_fixture_01-a2', 'PL_fixture_01-a1']);
    expect(fresh.selectedIds(REAL_PLAYLIST_FIXTURE.playlist)).toEqual(['a2', 'a1']);
  });

  it('?selected=%20&autoconfirm=1：空选择 emit EMPTY_SELECTION，绝不接受', async () => {
    await reloadBatch('?selected=%20&autoconfirm=1', REAL_PLAYLIST_FIXTURE);
    expect(JSON.parse(node('ytvdlt-output').textContent)).toEqual({
      accepted: false, enqueued: false, reason: 'EMPTY_SELECTION', taskIds: [],
    });
    expect(node('batch-enqueue').getAttribute('data-confirm')).toBe('disabled');
  });

  it('?error=1&autoconfirm=1：错误态页面照常 emit（错误只影响呈现，不影响清单）', async () => {
    await reloadBatch('?error=1&autoconfirm=1', REAL_PLAYLIST_FIXTURE);
    const emitted = JSON.parse(node('ytvdlt-output').textContent);
    expect(emitted.accepted).toBe(true);
    expect(emitted.taskIds).toHaveLength(3);
    expect(node('ytvdlt-batch').getAttribute('data-state')).toBe('error');
  });

  it('重装后的新按钮闭包：点击 emit 的是该次引导的模型，而不是旧实例的', async () => {
    await reloadBatch('?selected=a1', REAL_PLAYLIST_FIXTURE);
    node('batch-enqueue').dispatch('click');
    const emitted = JSON.parse(node('ytvdlt-output').textContent);
    expect(emitted.taskIds).toEqual(['PL_fixture_01-a1']);
  });

  it('D-190：重调 render() 后点击 emit 的是最新模型，不再锁死首次 import 的选择', async () => {
    const fresh = await reloadBatch('', REAL_PLAYLIST_FIXTURE);
    // 引导模型是全选；改变查询参数后走公开的 render() 重渲染。
    win().location.search = '?selected=a3';
    node('batch-rows').children.length = 0;
    const next = fresh.render();
    expect(next.ids).toEqual(['a3']);
    // 按钮闭包读的是模块级 model 变量：修复后 render() 已把它回写。
    node('batch-enqueue').dispatch('click');
    const emitted = JSON.parse(node('ytvdlt-output').textContent);
    expect(emitted.taskIds).toEqual(['PL_fixture_01-a3']);
    win().location.search = '';
  });
});
