/**
 * D-187 · 对话框家族真实行为单测 —— dialog-state / format-selector / subtitle-selector。
 *
 * 【import 路线】共享装载架 helpers/ui-harness.ts 真实 `import()`，v8 覆盖率可见；
 * probe-fixture.js 的同步 XHR 由 harness 的 FakeXMLHttpRequest 接管，端上拿到的是
 * tests/e2e/fixtures/ 里 REAL 录制的 L1 数据（dialog-media.json：137 视频轨 +
 * 251 音频轨 + en/zh-Hans 字幕 + en 自动字幕），不是编造的形状。
 *
 * 【单实例与查询变体】三个对话框都是 import 即 `dialog.start(render, patch)` 的
 * 单实例 IIFE，PRD 的 mode/error/empty/mp3/split/enabled/expr/autoconfirm 场景
 * 读 import 时刻的 location.search。因此本文件：
 *  - 引导用空查询（video / ready 基线），交互（搜索 / 勾选 / 确认）在引导实例上驱动；
 *  - 查询变体用 `vi.resetModules()` + 改 location.search 后重装对应 selector 模块
 *    （dialog-state 挂在 window 上的 YTVDLT.dom / createDialog 不受注册表重置影响）。
 *    重装前 resetDialogDom() 清掉共享节点上的旧监听器与旧渲染产物，避免旧实例
 *    的闭包污染新渲染的断言。
 *
 * 【冻结语义】M3 对话框的 DOM 形状（data-* 属性、五域同构回写、确认门禁）按现状
 * 钉住 —— 只测不修；playlist 确认绝不入队（A-M3-04 / D-38）也在此固守。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installUiGlobals, loadUiModule, type UiGlobals, type UiNode } from './helpers/ui-harness.js';

let globals: UiGlobals | null = null;
let formatDialog: any = null; // window.YTVDLT_FORMAT_DIALOG（引导实例）
let subtitleDialog: any = null; // window.YTVDLT_SUBTITLE_DIALOG（引导实例）

const win = () => globals!.window as Record<string, any>;
const doc = () => globals!.document as any;
const node = (id: string): UiNode => globals!.nodes.get(id) as UiNode;
const body = (): UiNode => globals!.document.body as UiNode;
const callsTo = (channel: string) => globals!.bridgeCalls.filter((c) => c.channel === channel);
const flush = async (rounds = 10): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};
const output = (): any => {
  try { return JSON.parse(node('ytvdlt-output').textContent); } catch { return null; }
};

const ITEM_CONTAINERS = [
  'items-video-only', 'items-audio-only', 'items-merged',
  'items-suggested', 'items-other', 'items-automatic',
];

/**
 * 按引用捕获接线函数：boot 的 format / subtitle 以及每个查询变体都把各自的
 * render / confirm / retry 接到同一批共享节点上，谁后派发谁覆盖共享属性。
 * 重装模块前 reloadDialogs 会清空监听器对象 —— 因此在每次 import 后立刻把
 * 「最新接线」按引用存下，派发时只跑目标实例的函数（真实交互等价路径）。
 */
const wired: { search: Record<string, Function>; confirm: Record<string, Function>; retry: Record<string, Function> } = {
  search: {}, confirm: {}, retry: {},
};
function captureWired(which: 'format' | 'subtitle'): void {
  const searchListeners = node('ytvdlt-search').listeners.input ?? [];
  const confirmListeners = node('ytvdlt-confirm').listeners.click ?? [];
  const retryListeners = node('ytvdlt-retry').listeners.click ?? [];
  wired.search[which] = searchListeners[searchListeners.length - 1];
  wired.confirm[which] = confirmListeners[confirmListeners.length - 1];
  wired.retry[which] = retryListeners[retryListeners.length - 1];
}

/** harness 的 textContent='' 不清子节点：每次交互前清容器，让 children 恰好等于本轮渲染。 */
function clearRendered(): void {
  for (const id of ITEM_CONTAINERS) {
    const container = globals!.nodes.get(id);
    if (container !== undefined) container.children.length = 0;
  }
}

/**
 * 重新触发渲染：render 是模块内部函数，实例上只暴露 start 时接线的搜索输入
 * 事件 —— 用空词派发 input 等价于「无搜索重画」（与真实交互同一条路径）。
 */
function rerender(which: 'format' | 'subtitle', term = ''): void {
  const all = node('ytvdlt-search').listeners.input ?? [];
  node('ytvdlt-search').listeners.input = [wired.search[which]];
  node('ytvdlt-search').value = term;
  clearRendered();
  node('ytvdlt-search').dispatch('input');
  node('ytvdlt-search').listeners.input = all; // 还原双渲染接线
}

/** 只让目标实例的确认监听响应点击（patchFn 是模块内部函数，只能走按钮路径）。 */
function clickConfirm(which: 'format' | 'subtitle'): void {
  const all = node('ytvdlt-confirm').listeners.click ?? [];
  node('ytvdlt-confirm').listeners.click = [wired.confirm[which]];
  node('ytvdlt-confirm').dispatch('click');
  node('ytvdlt-confirm').listeners.click = all;
}

/** 只让目标实例的重试监听响应点击（retry 也接在同一批共享按钮上）。 */
function clickRetry(which: 'format' | 'subtitle'): void {
  const all = node('ytvdlt-retry').listeners.click ?? [];
  node('ytvdlt-retry').listeners.click = [wired.retry[which]];
  node('ytvdlt-retry').dispatch('click');
  node('ytvdlt-retry').listeners.click = all;
}

/** 查询变体：清共享节点上的旧监听器 / 旧属性 / 旧渲染产物，再重装对应模块。
 *  注意 harness 的 dispatch 闭包持有创建时的 listeners 对象 —— 只能原地删除键，
 *  不能整对象替换（替换后 dispatch 仍走旧对象，旧实例监听器全都还在）。 */
async function reloadDialogs(search: string, which: 'format' | 'subtitle'): Promise<any> {
  for (const id of ['ytvdlt-search', 'ytvdlt-confirm', 'ytvdlt-retry']) {
    const n = globals!.nodes.get(id);
    if (n !== undefined) {
      for (const type of Object.keys(n.listeners)) delete n.listeners[type];
    }
  }
  clearRendered();
  for (const id of ['ytvdlt-dialog', 'ytvdlt-banner', 'ytvdlt-retry', 'ytvdlt-inline-error',
    'ytvdlt-state-label', 'ytvdlt-selected-count', 'ytvdlt-warnings', 'ytvdlt-output',
    'ctl-mp3', 'label-audio-quality', 'ctl-audio-quality', 'ctl-notice', 'ytvdlt-total-bytes']) {
    const n = globals!.nodes.get(id);
    if (n !== undefined) { n.attrs = {}; n.textContent = ''; }
  }
  body().attrs = {};
  win().location.search = search;
  vi.resetModules();
  await loadUiModule(which === 'format' ? 'dialogs/format-selector.js' : 'dialogs/subtitle-selector.js', globals!);
  captureWired(which); // 重装后接线是新实例的：按引用存下供 rerender/clickConfirm 使用
  await flush();
  return which === 'format' ? win().YTVDLT_FORMAT_DIALOG : win().YTVDLT_SUBTITLE_DIALOG;
}

beforeAll(async () => {
  vi.useFakeTimers();
  globals = installUiGlobals({
    // 真实 ipc-bridge 在册：confirmDialog / retry 的 PROBE 走真通道映射后进 bridgeCalls。
    bridge: { invoke: () => ({ ok: true }) },
    location: { href: 'file:///C:/app/dialogs/format/index.html', search: '', protocol: 'file:' },
    extraWindow: { URLSearchParams: globalThis.URLSearchParams },
  });
  await loadUiModule('ipc-bridge.js', globals);
  await loadUiModule('fixtures/probe-fixture.js', globals);
  await loadUiModule('dialogs/dialog-state.js', globals);
  await loadUiModule('dialogs/format-selector.js', globals);
  captureWired('format'); // boot format 实例的 render / confirm / retry
  await loadUiModule('dialogs/subtitle-selector.js', globals);
  captureWired('subtitle'); // boot subtitle 实例的 render / confirm / retry
  formatDialog = win().YTVDLT_FORMAT_DIALOG;
  subtitleDialog = win().YTVDLT_SUBTITLE_DIALOG;
  // setDisabledLabel 只对 type=checkbox 的输入置灰（真实 DOM 的 <input type=checkbox>
  // 自带 type；harness 节点没有，这里按真实形状补上，让禁用联动可达）。
  for (const id of ['ctl-embed', 'ctl-keep', 'ctl-enabled', 'ctl-skip', 'ctl-auto', 'ctl-mp3']) {
    const n = globals!.nodes.get(id);
    if (n !== undefined) (n as any).type = 'checkbox';
  }
  await flush();
});

afterAll(() => {
  globals?.restore();
  globals = null;
  formatDialog = null;
  subtitleDialog = null;
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 族一 · DialogState 状态机（四个状态、门禁、选中集合、告警、输出）
// ---------------------------------------------------------------------------
describe('D-187 · DialogState 状态机与 dom 助手', () => {
  it('暴露 STATES / DEFAULT_DOMAINS / createDialog / dom 五件套', () => {
    const YTVDLT = win().YTVDLT;
    expect(YTVDLT.STATES).toEqual(['ready', 'empty', 'error', 'disabled']);
    expect(Object.keys(YTVDLT.DEFAULT_DOMAINS).sort())
      .toEqual(['advanced', 'format', 'network', 'paths', 'subtitle']);
    expect(typeof YTVDLT.createDialog).toBe('function');
    for (const key of ['byId', 'text', 'attr', 'dataAttr', 'clone', 'fiveDomainPatch']) {
      expect(typeof YTVDLT.dom[key], key).toBe('function');
    }
  });

  it('createDialog 默认：kind=format、ready、无选中、query 来自 location.search', () => {
    const d = win().YTVDLT.createDialog({ fixture: 'dialog-media.json' });
    expect(d.kind).toBe('format');
    expect(d.state).toBe('ready');
    expect(d.reason).toBe('');
    expect(d.confirmed).toBe(false);
    expect(d.selected).toEqual([]);
    expect(d.option('mode', 'video')).toBe('video'); // 空查询 → 回退默认
    expect(d.option('nope', 'fb')).toBe('fb');
    d.load(); // L1 fixture 真实装载
    expect(d.payload.media.id).toBe('dQw4w9WgXcQ');
  });

  it('setState：合法状态写 body / 对话框 / 横幅 / 重试按钮；非法状态抛错', () => {
    const d = win().YTVDLT.createDialog({ kind: 'format' });
    d.setState('error', '解析失败示例');
    expect(d.state).toBe('error');
    expect(d.reason).toBe('解析失败示例');
    expect(body().getAttribute('data-state')).toBe('error');
    expect(node('ytvdlt-dialog').getAttribute('data-state')).toBe('error');
    expect(node('ytvdlt-state-label').textContent).toBe('解析失败，请重试');
    expect(node('ytvdlt-banner').getAttribute('data-visible')).toBe('true');
    expect(node('ytvdlt-banner').textContent).toBe('解析失败示例');
    expect(node('ytvdlt-retry').getAttribute('hidden')).toBe('false');
    d.setState('ready');
    expect(node('ytvdlt-banner').getAttribute('data-visible')).toBe('false');
    expect(node('ytvdlt-banner').textContent).toBe('');
    expect(node('ytvdlt-retry').getAttribute('hidden')).toBe('true');
    expect(node('ytvdlt-state-label').textContent).toBe('已就绪');
    d.setState('empty'); // 无 reason → 横幅回退状态文案
    expect(node('ytvdlt-banner').textContent).toBe('没有可用数据');
    expect(() => d.setState('bogus' as never)).toThrow('unknown dialog state: bogus');
  });

  it('确认门禁矩阵：error/disabled/内联错误/零选中一律关闭；empty+选中放行（PRD §5.2）', () => {
    const d = win().YTVDLT.createDialog({ kind: 'format' });
    expect(d.isConfirmAllowed()).toBe(false); // 零选中
    d.setSelected(['137']);
    expect(d.isConfirmAllowed()).toBe(true);
    d.setState('error');
    expect(d.isConfirmAllowed()).toBe(false);
    d.setState('empty');
    expect(d.isConfirmAllowed()).toBe(true); // empty 态手动表达式可确认
    d.setState('disabled');
    expect(d.isConfirmAllowed()).toBe(false);
    d.setState('ready');
    d.setInlineError('FORMAT_UNAVAILABLE');
    expect(d.isConfirmAllowed()).toBe(false);
    d.clearInlineError();
    expect(d.isConfirmAllowed()).toBe(true);
    // refreshGate 同步按钮与对话框属性
    expect(node('ytvdlt-confirm').getAttribute('aria-disabled')).toBe('false');
    expect(node('ytvdlt-confirm').disabled).toBe(false);
    expect(node('ytvdlt-confirm').getAttribute('data-confirm-state')).toBe('enabled');
    expect(node('ytvdlt-dialog').getAttribute('data-confirm')).toBe('enabled');
  });

  it('setSelected / toggleSelected：单选（radio）与多选（checkbox）两种语义', () => {
    const d = win().YTVDLT.createDialog({ kind: 'format' });
    d.toggleSelected('a'); // 多选追加
    expect(d.selected).toEqual(['a']);
    d.toggleSelected('a'); // 再点移除
    expect(d.selected).toEqual([]);
    d.toggleSelected('a');
    d.toggleSelected('b');
    expect(d.selected).toEqual(['a', 'b']);
    d.toggleSelected('c', true); // 单选：无选中 → 只留自己
    expect(d.selected).toEqual(['c']);
    d.toggleSelected('c', true); // 单选：已有 → 清空
    expect(d.selected).toEqual([]);
    d.setSelected(['x', 'y']);
    expect(node('ytvdlt-selected-count').textContent).toBe('2');
    expect(node('ytvdlt-dialog').getAttribute('data-selected-count')).toBe('2');
    d.setSelected(null as unknown as string[]); // 防御：null → 空数组
    expect(d.selected).toEqual([]);
  });

  it('setWarnings / setInlineError / renderItems：告警行、可见计数与搜索过滤', () => {
    const d = win().YTVDLT.createDialog({ kind: 'format' });
    d.setWarnings(['R1：告警一', 'R2：告警二']);
    expect(node('ytvdlt-warnings').textContent).toBe('R1：告警一 / R2：告警二');
    expect(node('ytvdlt-dialog').getAttribute('data-warning-count')).toBe('2');
    d.setWarnings(null as unknown as string[]);
    expect(node('ytvdlt-dialog').getAttribute('data-warning-count')).toBe('0');
    d.setInlineError('手动 id 不存在');
    expect(node('ytvdlt-inline-error').textContent).toBe('手动 id 不存在');
    expect(node('ytvdlt-inline-error').getAttribute('data-visible')).toBe('true');
    d.clearInlineError();
    expect(node('ytvdlt-inline-error').getAttribute('data-visible')).toBe('false');
    // renderItems：大小写不敏感过滤 + 计数属性；容器缺失 → 0
    const items = [
      { id: '137', searchText: '137 mp4 1080p', row1: '137' },
      { id: '251', searchText: '251 webm audio', row1: '251' },
    ];
    clearRendered();
    const shown = d.renderItems('items-merged', items, 'MP4', (item: any) => {
      const label = doc().createElement('label');
      label.setAttribute('data-rendered', item.id);
      return label;
    });
    expect(shown).toBe(1);
    expect(node('items-merged').children).toHaveLength(1);
    expect(node('items-merged').children[0].getAttribute('data-rendered')).toBe('137');
    // renderItems 直接 setAttribute 原始数值（真实 DOM 会转字符串），这里 String() 归一。
    expect(String(node('items-merged').getAttribute('data-visible-count'))).toBe('1');
    expect(String(node('items-merged').getAttribute('data-total-count'))).toBe('2');
    expect(d.renderItems('items-merged', items, '', (item: any) => item.row1)).toBe(2);
    clearRendered();
  });

  it('fiveDomainPatch：局部补丁并进冻结默认、未知键丢弃、clone 深拷贝不串源', () => {
    const dom = win().YTVDLT.dom;
    const patched = dom.fiveDomainPatch({
      format: { quality: '720p', bogusKey: 'drop-me' },
      subtitle: null, // 非对象域 → 整域保持默认
      network: { rateLimit: '2M', evil: 1 },
    });
    expect(patched.format.quality).toBe('720p');
    expect((patched.format as any).bogusKey).toBeUndefined();
    expect(patched.subtitle).toEqual(win().YTVDLT.DEFAULT_DOMAINS.subtitle);
    expect(patched.network.rateLimit).toBe('2M');
    expect((patched.network as any).evil).toBeUndefined();
    expect(patched.paths.videoDir).toBe('C:/Videos'); // 未触碰域保持默认
    // 深拷贝：改结果不影响 DEFAULT_DOMAINS；非对象补丁 → 全默认
    patched.format.quality = 'worst';
    expect(win().YTVDLT.DEFAULT_DOMAINS.format.quality).toBe('best');
    expect(dom.fiveDomainPatch(null)).toEqual(win().YTVDLT.DEFAULT_DOMAINS);
    expect(dom.fiveDomainPatch('nonsense' as never)).toEqual(win().YTVDLT.DEFAULT_DOMAINS);
    expect(dom.clone({ a: { b: [1] } })).toEqual({ a: { b: [1] } });
    // dom 助手：text/attr/dataAttr 对缺失 id 是安全 noop
    dom.text('no-such-id', 'x');
    dom.attr('no-such-id', 'data-x', 'y');
    dom.dataAttr('no-such-id', 'k', 'v');
  });

  it('buildWriteback / confirm：format 五域回写 vs playlist 只写 selectedIds；确认绝不入队', () => {
    const d = win().YTVDLT.createDialog({ kind: 'format', fixture: 'dialog-media.json' });
    d.load();
    d.setState('ready');
    d.setSelected(['137', '251']);
    d.onConfirm = (wb: unknown) => { (d as any)._seen = wb; };
    const wb = d.confirm({ format: { quality: '720p' } });
    expect(wb).not.toBeNull();
    expect(wb.kind).toBe('format');
    expect(wb.confirmed).toBe(true);
    expect(wb.state).toBe('ready');
    expect(wb.requestPatch.format.quality).toBe('720p');
    expect(wb.requestPatch.subtitle.languages).toBe('en.*,.*-orig'); // 其余域冻结默认
    expect((d as any)._seen).toBe(wb); // onConfirm 收到同一份回写
    expect(node('ytvdlt-dialog').getAttribute('data-confirmed')).toBe('true');
    expect(JSON.parse(node('ytvdlt-output').textContent)).toEqual(wb);
    // bridge 确认走真实 ipc-bridge 映射：DIALOG_CONFIRM → ytvdlt:dialog:confirm
    expect(callsTo('ytvdlt:dialog:confirm').at(-1)?.payload).toEqual(wb);
    // playlist kind：只写 selectedPlaylistIds，不带 requestPatch
    const pl = win().YTVDLT.createDialog({ kind: 'playlist' });
    pl.setSelected(['a1', 'a3']);
    pl.setState('ready');
    const plWb = pl.confirm();
    expect(plWb).toEqual({
      kind: 'playlist', confirmed: true, state: 'ready', selectedPlaylistIds: ['a1', 'a3'],
    });
    expect((plWb as any).requestPatch).toBeUndefined();
    expect(callsTo('ytvdlt:dialog:confirm').at(-1)?.payload).toEqual(plWb);
  });

  it('confirm 门禁关闭：只落 confirmed:false + confirm-gate-closed，不回调、不写回写', () => {
    node('ytvdlt-dialog').attrs = {}; // 共享对话框节点：清掉此前用例留下的 data-confirmed
    const d = win().YTVDLT.createDialog({ kind: 'format' });
    d.setState('error');
    let called = 0;
    d.onConfirm = () => { called += 1; };
    expect(d.confirm({ format: {} })).toBeNull();
    expect(output()).toEqual({ kind: 'format', confirmed: false, state: 'error', reason: 'confirm-gate-closed' });
    expect(called).toBe(0);
    expect(node('ytvdlt-dialog').getAttribute('data-confirmed')).toBeNull();
  });

  it('start：接线搜索 / 确认 / 重试按钮，renderFn 先跑一次，autoconfirm 钩子复用同一路径', async () => {
    const YTVDLT = win().YTVDLT;
    const d = YTVDLT.createDialog({ kind: 'format', fixture: 'dialog-media.json' });
    const renders: string[] = [];
    let confirmPatch = { format: { quality: 'custom' } };
    d.onRender = (self: unknown) => { renders.push('onRender'); };
    d.start((self: any, term: string) => { renders.push(term); }, () => confirmPatch);
    expect(renders).toEqual(['', 'onRender']); // 初始渲染一次 + onRender 回调
    expect(d.payload.media.id).toBe('dQw4w9WgXcQ');
    d.setSelected(['137', '251']);
    // 搜索框输入 → renderFn(value)
    node('ytvdlt-search').value = '137';
    node('ytvdlt-search').dispatch('input');
    expect(renders.at(-1)).toBe('137');
    node('ytvdlt-search').value = '';
    // 确认按钮 → confirm(patchFn(self))
    node('ytvdlt-confirm').dispatch('click');
    expect(d.confirmed).toBe(true);
    expect((d.writeback as any).requestPatch.format.quality).toBe('custom');
    // 重试按钮 → PROBE 清错 + 回 ready + 再渲染（boot 实例也接了 retry，只派发本实例的）
    d.setState('error', 'boom');
    d.setInlineError('x');
    globals!.bridgeCalls.length = 0;
    const retryFns = node('ytvdlt-retry').listeners.click ?? [];
    const ownRetry = retryFns[retryFns.length - 1]; // d.start 刚接线，最后一条是本实例的
    node('ytvdlt-retry').listeners.click = [ownRetry];
    node('ytvdlt-retry').dispatch('click');
    node('ytvdlt-retry').listeners.click = retryFns;
    expect(callsTo('ytvdlt:probe')[0]).toEqual({ channel: 'ytvdlt:probe', payload: { url: '' } });
    expect(d.state).toBe('ready');
    expect(d.inlineError).toBe('');
    expect(renders.at(-1)).toBe(''); // 空词重渲染
    // patchFn 缺席 → confirm({})；autoconfirm=1 走同一条 confirm 路径
    // （gate 需要非空选中，renderFn 里给出选择）。
    confirmPatch = undefined as unknown as { format: { quality: string } };
    win().location.search = '?autoconfirm=1'; // query 在构造时读取，先设查询再建实例
    const auto = YTVDLT.createDialog({ kind: 'format', fixture: 'dialog-media.json' });
    const renders2: number[] = [];
    auto.start((self: any) => { renders2.push(1); self.setSelected(['137']); });
    win().location.search = '';
    expect(renders2.length).toBeGreaterThan(0);
    expect(auto.confirmed).toBe(true);
    expect(auto.writeback.requestPatch.format).toEqual(YTVDLT.DEFAULT_DOMAINS.format);
  });
});

// ---------------------------------------------------------------------------
// 族二 · format-selector：真实 fixture 的三组分栏、推荐默认、合计与确认流
// ---------------------------------------------------------------------------
describe('D-187 · format-selector：fixture 驱动的三组分栏与默认推荐', () => {
  it('引导基线：video-only/audio-only/merged 计数、默认勾选最高 tbr、合计体积', () => {
    // subtitle 引导（import 顺序在后）把共享节点的告警计数写成 1，先收敛到 format 渲染。
    rerender('format');
    expect(node('count-video-only').textContent).toBe('1');
    expect(node('count-audio-only').textContent).toBe('1');
    expect(node('count-merged').textContent).toBe('0');
    expect(formatDialog.selected).toEqual(['137', '251']); // 137=1080p 视频，251=opus 音频
    expect(node('ytvdlt-total-bytes').textContent).toBe('11.95 MiB'); // 10485760+2048000
    expect(node('ytvdlt-dialog').getAttribute('data-state')).toBe('ready');
    expect(node('ytvdlt-dialog').getAttribute('data-mode')).toBe('video');
    expect(node('ytvdlt-dialog').getAttribute('data-total-bytes')).toBe('11.95 MiB');
    // data-selected-count 是共享节点上「最后一次 setSelected」的写入（subtitle 引导
    // 会覆盖为 1）；选中集合的权威看实例自身，真实联动在下方勾选用例里断言。
    expect(node('ytvdlt-confirm').getAttribute('data-confirm-state')).toBe('enabled');
    expect(node('ytvdlt-dialog').getAttribute('data-confirm')).toBe('enabled');
    expect(node('ytvdlt-dialog').getAttribute('data-warning-count')).toBe('0');
    expect(body().getAttribute('data-state')).toBe('ready');
    for (const col of ['col-video-only', 'col-audio-only', 'col-merged']) {
      expect(node(col).getAttribute('data-disabled')).toBe('false');
    }
  });

  it('行描述符来自真实录制数据：分辨率 / 编解码 / tbr / 体积 / 备注', () => {
    rerender('format');
    const videoItem = node('items-video-only').children[0];
    expect(videoItem.getAttribute('data-format-id')).toBe('137');
    expect(videoItem.getAttribute('data-selected')).toBe('true');
    expect(videoItem.children[0].type).toBe('radio'); // 视频/合并组单选
    expect(videoItem.children[0].name).toBe('fmt-video-only');
    expect(videoItem.children[1].textContent).toBe('137 · mp4 · 1080p');
    expect(videoItem.children[2].textContent).toBe('v:h264 a:none tbr:2500.5 size:10.00 MiB 1080p');
    const audioItem = node('items-audio-only').children[0];
    expect(audioItem.getAttribute('data-format-id')).toBe('251');
    expect(audioItem.children[0].type).toBe('checkbox'); // 音频组多选
    expect(audioItem.children[1].textContent).toBe('251 · webm · —'); // 无分辨率 → —
    expect(audioItem.children[2].textContent).toBe('v:none a:opus tbr:128 size:1.95 MiB audio only');
  });

  it('搜索过滤走真实输入事件：1080 命中视频列，音频列清空', () => {
    // renderItems 直接 setAttribute（harness 存原值，真实 DOM 会转字符串），用 String() 归一。
    node('ytvdlt-search').value = '1080';
    clearRendered();
    node('ytvdlt-search').dispatch('input');
    expect(String(node('items-video-only').getAttribute('data-visible-count'))).toBe('1');
    expect(String(node('items-audio-only').getAttribute('data-visible-count'))).toBe('0');
    expect(node('items-video-only').children).toHaveLength(1);
    node('ytvdlt-search').value = '';
    clearRendered();
    node('ytvdlt-search').dispatch('input');
    expect(String(node('items-video-only').getAttribute('data-visible-count'))).toBe('1');
    expect(String(node('items-audio-only').getAttribute('data-visible-count'))).toBe('1');
  });

  it('勾选联动：取消 251 → 合计掉到 10.00 MiB；再勾恢复；选中数与门禁同步', () => {
    rerender('format');
    const audioInput = node('items-audio-only').children[0].children[0];
    audioInput.dispatch('change'); // checkbox 勾选事件 → toggleSelected
    expect(formatDialog.selected).toEqual(['137']);
    expect(node('ytvdlt-dialog').getAttribute('data-selected-count')).toBe('1');
    expect(node('ytvdlt-dialog').getAttribute('data-total-bytes')).toBe('10.00 MiB');
    expect(node('ytvdlt-total-bytes').textContent).toBe('10.00 MiB');
    const again = node('items-audio-only').children[0].children[0];
    again.dispatch('change');
    expect(formatDialog.selected).toEqual(['137', '251']);
  });

  it('确认流：点击确认 → 五域回写渲染进 <pre>，DIALOG_CONFIRM 走真通道', () => {
    rerender('format');
    globals!.bridgeCalls.length = 0;
    clickConfirm('format'); // 共享确认按钮上挂着多个实例的接线，只派发 boot format 的
    const wb = output();
    expect(wb.kind).toBe('format');
    expect(wb.confirmed).toBe(true);
    expect(wb.state).toBe('ready');
    // patch 读 ctl-* 控件值（harness 下为空串）+ 查询参数
    expect(wb.requestPatch.format).toEqual({
      quality: '', videoCodecPref: '', formatId: '137+251', sortingFields: null,
      extractAudio: false, audioQuality: '', audioCodecPref: '', audioFormat: null,
      audioMultistreams: false,
    });
    expect(node('ytvdlt-dialog').getAttribute('data-confirmed')).toBe('true');
    expect(callsTo('ytvdlt:dialog:confirm').at(-1)?.payload).toEqual(wb);
    formatDialog.confirmed = false; // 复位，后续变体用例从干净状态重装
  });
});

// ---------------------------------------------------------------------------
// 族三 · format-selector 查询变体（audio / command / mp3 / empty / error / badid）
// ---------------------------------------------------------------------------
describe('D-187 · format-selector：查询变体覆盖三态门禁与模式联动', () => {
  it('?mode=audio：视频与合并列禁用，patch.extractAudio=true', async () => {
    const d = await reloadDialogs('?mode=audio', 'format');
    expect(node('col-video-only').getAttribute('data-disabled')).toBe('true');
    expect(node('col-audio-only').getAttribute('data-disabled')).toBe('false');
    expect(node('col-merged').getAttribute('data-disabled')).toBe('true');
    rerender('format');
    expect(node('items-video-only').children[0].getAttribute('data-disabled')).toBe('true');
    expect(node('items-video-only').children[0].children[0].disabled).toBe(true);
    expect(node('items-audio-only').children[0].getAttribute('data-disabled')).toBe('false');
    // patch(self) 是模块内部函数，只在确认按钮路径上被调用 —— 走真实点击。
    clickConfirm('format');
    const wb = d.writeback as any;
    expect(wb.requestPatch.format.extractAudio).toBe(true);
    expect(wb.requestPatch.format.formatId).toBe('137+251');
  });

  it('?mode=command：全部列禁用 + disabled 态 + 明示文案，门禁关闭', async () => {
    const d = await reloadDialogs('?mode=command', 'format');
    for (const col of ['col-video-only', 'col-audio-only', 'col-merged']) {
      expect(node(col).getAttribute('data-disabled')).toBe('true');
    }
    expect(d.state).toBe('disabled');
    expect(node('ytvdlt-dialog').getAttribute('data-state')).toBe('disabled');
    expect(node('ctl-notice').textContent).toBe('Command 模式下格式选择不可用');
    expect(d.selected).toEqual([]); // command 模式不给默认推荐
    expect(node('ytvdlt-confirm').getAttribute('data-confirm-state')).toBe('disabled');
    expect(d.confirm({})).toBeNull();
    expect(output()).toEqual({ kind: 'format', confirmed: false, state: 'disabled', reason: 'confirm-gate-closed' });
  });

  it('?mp3=1：音质档位被抑制（R1 告警）+ audioFormat=mp3 + 控件禁用', async () => {
    const d = await reloadDialogs('?mp3=1', 'format');
    expect(node('ctl-mp3').getAttribute('checked')).toBe('checked');
    expect(node('ctl-mp3').checked).toBe(true);
    expect(node('label-audio-quality').getAttribute('data-disabled')).toBe('true');
    expect(node('ctl-audio-quality').disabled).toBe(true);
    expect(node('ytvdlt-warnings').textContent).toBe('R1：转码 MP3 时音质档位（abr~N）已被抑制');
    expect(node('ytvdlt-dialog').getAttribute('data-warning-count')).toBe('1');
    node('ytvdlt-confirm').dispatch('click'); // 走真实 patch 路径
    expect((d.writeback as any).requestPatch.format.audioFormat).toBe('mp3');
  });

  it('?empty=1：formats 清空 → empty 态、门禁关闭、合计 —', async () => {
    const d = await reloadDialogs('?empty=1', 'format');
    expect(d.state).toBe('empty');
    expect(node('count-video-only').textContent).toBe('0');
    expect(node('count-audio-only').textContent).toBe('0');
    expect(String(node('items-video-only').getAttribute('data-visible-count'))).toBe('0');
    expect(d.selected).toEqual([]);
    expect(node('ytvdlt-dialog').getAttribute('data-confirm')).toBe('disabled');
    expect(node('ytvdlt-total-bytes').textContent).toBe('—');
    expect(node('ytvdlt-banner').getAttribute('data-visible')).toBe('true');
    expect(node('ytvdlt-banner').textContent).toBe('没有可用格式（formats=[]）');
  });

  it('?error=1：error 态 + 重试按钮亮出；点重试发 PROBE 清内联错误再按查询重画', async () => {
    const d = await reloadDialogs('?error=1', 'format');
    expect(d.state).toBe('error');
    expect(node('ytvdlt-retry').getAttribute('hidden')).toBe('false');
    expect(node('ytvdlt-banner').textContent).toBe('解析失败（FORMAT_UNAVAILABLE / UNSUPPORTED_SITE）；可点击「重试解析」');
    expect(d.selected).toEqual([]);
    globals!.bridgeCalls.length = 0;
    clickRetry('format'); // 只派发变体实例自己的 retry 接线
    expect(callsTo('ytvdlt:probe')).toHaveLength(1);
    expect(callsTo('ytvdlt:probe')[0].payload).toEqual({ url: '' });
    // 查询仍是 error=1 → 重画后回 error（真实页面会换掉查询再解析）
    expect(d.state).toBe('error');
  });

  it('?badid=1：手填格式 id 不在结果中 → 内联错误 + 门禁关闭', async () => {
    const d = await reloadDialogs('?badid=1', 'format');
    expect(d.inlineError).toBe('FORMAT_UNAVAILABLE：手填格式 id 不在解析结果中，请重试或重新解析');
    expect(node('ytvdlt-inline-error').getAttribute('data-visible')).toBe('true');
    expect(d.selected.length).toBeGreaterThan(0); // 有推荐选中，但内联错误关门
    expect(node('ytvdlt-confirm').getAttribute('data-confirm-state')).toBe('disabled');
  });

  it('?autoconfirm=1：引导即确认（与点击同一条路径），回写直接落 <pre>', async () => {
    const d = await reloadDialogs('?autoconfirm=1', 'format');
    expect(d.confirmed).toBe(true);
    const wb = output();
    expect(wb.confirmed).toBe(true);
    expect(wb.requestPatch.format.formatId).toBe('137+251');
    expect(callsTo('ytvdlt:dialog:confirm').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 族四 · subtitle-selector：三组语言、表达式校验、音频/拆分门禁、空态手动表达式
// ---------------------------------------------------------------------------
describe('D-187 · subtitle-selector：fixture 驱动的语言分组与表达式校验', () => {
  it('引导基线：suggested=[en] other=[zh-Hans] automatic=[en]，默认勾选建议语言', () => {
    rerender('subtitle'); // 收敛到 subtitle 渲染（format 引导与族二用例写过共享节点）
    expect(node('count-suggested').textContent).toBe('1');
    expect(node('count-other').textContent).toBe('1');
    expect(node('count-automatic').textContent).toBe('1');
    expect(subtitleDialog.selected).toEqual(['en']);
    expect(node('ytvdlt-dialog').getAttribute('data-state')).toBe('ready');
    expect(node('ytvdlt-dialog').getAttribute('data-mode')).toBe('video');
    expect(node('ytvdlt-dialog').getAttribute('data-split')).toBe('false');
    expect(node('ytvdlt-dialog').getAttribute('data-enabled')).toBe('true');
    expect(node('ytvdlt-dialog').getAttribute('data-expression-valid')).toBe('true');
    expect(node('ctl-expression').value).toBe('en.*,.*-orig'); // 查询默认回填
    expect(node('ytvdlt-confirm').getAttribute('data-confirm-state')).toBe('enabled');
    // 行描述符来自真实轨道：en 同时命中人工字幕与自动字幕 → 轨道合并展示；
    // zh-Hans 只有人工字幕。
    rerender('subtitle');
    const en = node('items-suggested').children[0];
    expect(en.getAttribute('data-language')).toBe('en');
    expect(en.children[1].textContent).toBe('en · vtt/vtt');
    expect(en.children[2].textContent).toBe('name:English/English (auto) tracks:2');
    const zh = node('items-other').children[0];
    expect(zh.children[1].textContent).toBe('zh-Hans · srt');
    expect(zh.children[2].textContent).toBe('name:— tracks:1');
  });

  it('实验性提示：harness 的 ctl-skip 默认未勾 → 自动翻译告警可见；勾上即清', () => {
    expect(node('ctl-experimental').getAttribute('data-visible')).toBe('true');
    expect(node('ytvdlt-warnings').textContent).toBe('自动翻译字幕为实验性功能，请确认');
    node('ctl-skip').checked = true;
    rerender('subtitle');
    expect(node('ctl-experimental').getAttribute('data-visible')).toBe('false');
    expect(node('ytvdlt-dialog').getAttribute('data-warning-count')).toBe('0');
    node('ctl-skip').checked = false;
    rerender('subtitle');
    expect(node('ctl-experimental').getAttribute('data-visible')).toBe('true');
  });

  it('mkv 提示：勾「嵌入字幕」且非音频/非拆分 → 显示 mkv 提示；取消勾选即隐', () => {
    node('ctl-embed').checked = true;
    rerender('subtitle');
    expect(node('ctl-mkv-hint').getAttribute('data-visible')).toBe('true');
    node('ctl-embed').checked = false;
    rerender('subtitle');
    expect(node('ctl-mkv-hint').getAttribute('data-visible')).toBe('false');
  });

  it('语言勾选联动：勾 zh-Hans → 选中数 2，搜索 zh 只看得到其他组', () => {
    rerender('subtitle');
    const zhInput = node('items-other').children[0].children[0];
    zhInput.dispatch('change');
    expect(subtitleDialog.selected).toEqual(['en', 'zh-Hans']);
    expect(node('ytvdlt-dialog').getAttribute('data-selected-count')).toBe('2');
    rerender('subtitle', 'zh'); // 带搜索词重画：suggested 清空、other 保留
    expect(String(node('items-suggested').getAttribute('data-visible-count'))).toBe('0');
    expect(String(node('items-other').getAttribute('data-visible-count'))).toBe('1');
    rerender('subtitle');
    const zhAgain = node('items-other').children[0].children[0];
    zhAgain.dispatch('change');
    expect(subtitleDialog.selected).toEqual(['en']);
  });

  it('?mode=audio：嵌入/保留独立字幕置灰并给原因；data-mode=audio', async () => {
    const d = await reloadDialogs('?mode=audio', 'subtitle');
    expect(node('ytvdlt-dialog').getAttribute('data-mode')).toBe('audio');
    expect(node('label-embed').getAttribute('data-disabled')).toBe('true');
    expect(node('label-embed').getAttribute('data-reason')).toBe('仅音频模式不可嵌入');
    expect(node('label-keep').getAttribute('data-disabled')).toBe('true');
    expect(node('label-keep').getAttribute('data-reason')).toBe('仅音频模式不可保留独立字幕');
    expect(node('ctl-embed').disabled).toBe(true);
    expect(d.state).toBe('ready'); // 音频模式不是禁用态，只是控件置灰
  });

  it('?split=1：嵌入被章节拆分禁用', async () => {
    const d = await reloadDialogs('?split=1', 'subtitle');
    expect(node('ytvdlt-dialog').getAttribute('data-split')).toBe('true');
    expect(node('label-embed').getAttribute('data-reason')).toBe('章节拆分时不可嵌入');
    expect(node('label-embed').getAttribute('data-disabled')).toBe('true');
    expect(node('label-keep').getAttribute('data-disabled')).toBe('false'); // 拆分不影响保留
    expect(d.state).toBe('ready');
  });

  it('?enabled=0：总开关关闭 → disabled 态、全控件禁用、门禁关闭', async () => {
    const d = await reloadDialogs('?enabled=0', 'subtitle');
    expect(d.state).toBe('disabled');
    expect(node('ytvdlt-dialog').getAttribute('data-enabled')).toBe('false');
    expect(node('ctl-enabled').checked).toBe(false);
    for (const id of ['label-auto', 'label-skip', 'label-convert', 'label-embed', 'label-keep']) {
      expect(node(id).getAttribute('data-disabled')).toBe('true');
    }
    expect(node('ctl-convert').disabled).toBe(true);
    expect(d.selected).toEqual([]);
    expect(node('ytvdlt-confirm').getAttribute('data-confirm-state')).toBe('disabled');
    expect(node('ytvdlt-banner').textContent).toBe('字幕总开关已关闭，其余控件全部禁用');
  });

  it('?empty=1：空态 + 合法手动表达式是唯一有效选择，门禁反而打开（PRD §5.2）', async () => {
    const d = await reloadDialogs('?empty=1', 'subtitle');
    expect(d.state).toBe('empty');
    expect(node('ytvdlt-banner').textContent).toBe('没有字幕语言；可手动输入语言表达式后确认');
    expect(node('count-suggested').textContent).toBe('0');
    // 空态横幅保持可见，但确认门禁因表达式非空而打开
    expect(d.selected).toEqual(['en.*,.*-orig']);
    expect(node('ytvdlt-confirm').getAttribute('data-confirm-state')).toBe('enabled');
    clickConfirm('subtitle'); // 走真实 patch 路径
    const wb = d.writeback as any;
    expect(wb.kind).toBe('subtitle');
    expect(wb.confirmed).toBe(true);
    // 手动表达式不算语言清单：languages 为空串
    expect(wb.requestPatch.subtitle.languages).toBe('');
    expect(node('ytvdlt-dialog').getAttribute('data-confirmed')).toBe('true');
  });

  it('表达式校验矩阵：空 / 空白 / 非法字符 / 空语言项四种拒绝原因', async () => {
    const cases: Array<[string, string]> = [
      ['?expr=', '语言表达式不能为空'],
      ['?expr=has%20space', '语言表达式不能包含空白或控制字符'],
      ['?expr=bad,token!', '语言表达式包含非法字符'],
      ['?expr=a,,b', '存在空的语言项'],
    ];
    for (const [search, reason] of cases) {
      const d = await reloadDialogs(search, 'subtitle');
      expect(d.inlineError, search).toBe(reason);
      expect(node('ytvdlt-dialog').getAttribute('data-expression-valid')).toBe('false');
      expect(node('ytvdlt-confirm').getAttribute('data-confirm-state')).toBe('disabled');
    }
    // 合法表达式（含 * 和 -）：校验通过
    const ok = await reloadDialogs('?expr=zh.*,.*-orig', 'subtitle');
    expect(ok.inlineError).toBe('');
    expect(node('ytvdlt-dialog').getAttribute('data-expression-valid')).toBe('true');
  });

  it('?error=1：error 态 + 重试可见', async () => {
    const d = await reloadDialogs('?error=1', 'subtitle');
    expect(d.state).toBe('error');
    expect(node('ytvdlt-retry').getAttribute('hidden')).toBe('false');
    expect(node('ytvdlt-banner').textContent).toBe('解析失败（UNSUPPORTED_SITE）；可点击「重试解析」');
    expect(d.selected).toEqual([]);
  });

  it('?autoconfirm=1：五域字幕回写（enabled / languages / 开关组合来自控件现状）', async () => {
    const d = await reloadDialogs('?autoconfirm=1', 'subtitle');
    expect(d.confirmed).toBe(true);
    const wb = output();
    expect(wb.kind).toBe('subtitle');
    expect(wb.confirmed).toBe(true);
    // 选中 = suggested [en]，表达式排除在 languages 之外
    expect(wb.requestPatch.subtitle).toEqual({
      enabled: true, languages: 'en', autoCaptions: false, skipTranslated: false,
      convertTo: '', embed: false, keepSubtitleFile: false,
    });
    expect(callsTo('ytvdlt:dialog:confirm').length).toBeGreaterThan(0);
  });
});
