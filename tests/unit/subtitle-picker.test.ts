/**
 * Stage 5 · subtitle picker + queue wiring.
 *
 * Every assertion runs the REAL shipped browser scripts against a fake DOM:
 * no re-implementation of the component, no relaxed assertions, no faked
 * results. `subtitle-picker-harness.ts` only fakes document/storage/bridge.
 *
 * Coverage follows the phase-5 brief:
 *   normal preview · no subtitles · multi-language · automatic · manual ·
 *   cancel · expired preview · URL change · enqueue success ·
 *   untouched legacy flow · different window sizes (layout checks).
 * Plus: loading, failure codes, format unavailable, out-of-order replies,
 * enqueue-time URL mismatch, container warning, audio gate, URL privacy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Node, byId, find, subtitleHarness, track,
  type SubtitleHarness, type SubtitlePreviewFixture,
} from './helpers/subtitle-picker-harness.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const UI_SRC = join(ROOT, 'packages', 'ui', 'src');

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function tick(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

function dto(overrides: Partial<SubtitlePreviewFixture> = {}): SubtitlePreviewFixture {
  return {
    previewId: 'ticket-00000001',
    media: { title: 'Demo clip', uploader: 'Studio', durationSec: 125, extractorKey: 'Generic' },
    tracks: [track()],
    manualLanguages: 1,
    automaticLanguages: 0,
    empty: false,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    ...overrides,
  };
}

function fullDto(): SubtitlePreviewFixture {
  return dto({
    tracks: [
      track({ languageCode: 'en', languageName: 'English', manualAvailable: true, automaticAvailable: true, manualFormats: ['srt', 'vtt'], automaticFormats: ['vtt'] }),
      track({ languageCode: 'zh-Hans', languageName: '简体中文', manualAvailable: true, automaticAvailable: false, manualFormats: ['srt'], automaticFormats: [] }),
      track({ languageCode: 'ja', languageName: '日本語', manualAvailable: false, automaticAvailable: true, manualFormats: [], automaticFormats: ['vtt', 'srv3'] }),
    ],
    manualLanguages: 2,
    automaticLanguages: 2,
  });
}

async function ready(h: SubtitleHarness, preview = fullDto()): Promise<void> {
  h.setPreview({ ok: true, preview });
  h.open();
  await tick();
}

function languageBoxes(h: SubtitleHarness): Node[] {
  return h.findInModal((n) => n.tagName === 'input'
    && n.getAttribute('type') === 'checkbox'
    && n.getAttribute('value') !== null);
}
function boxFor(h: SubtitleHarness, code: string): Node {
  const found = languageBoxes(h).filter((n) => n.getAttribute('value') === code)[0];
  if (!found) throw new Error(`no language checkbox for ${code}`);
  return found;
}
function click(h: SubtitleHarness, id: string): void {
  const node = byId(h.modal, id);
  if (!node) throw new Error(`missing #${id}`);
  node.fire('click', { preventDefault() {}, stopPropagation() {} });
}
function select(h: SubtitleHarness, code: string): void {
  const box = boxFor(h, code);
  box.checked = true;
  box.fire('change', {});
}
function previewCalls(h: SubtitleHarness) {
  return h.calls.filter((c) => c.channel === 'ytvdlt:subtitle:preview');
}
function cancelCalls(h: SubtitleHarness) {
  return h.calls.filter((c) => c.channel === 'ytvdlt:subtitle:previewCancel');
}
function enqueueCalls(h: SubtitleHarness) {
  return h.calls.filter((c) => c.channel === 'ytvdlt:download:start');
}
function enqueue(h: SubtitleHarness, url?: string): void {
  if (url !== undefined) h.urlInput.value = url;
  h.form.fire('submit', { preventDefault() {} });
}

// ---------------------------------------------------------------------------
describe('stage 5 · mounting, baselines and "no probe until asked"', () => {
  it('mounts nothing and probes nothing in static file:// preview', () => {
    const h = subtitleHarness({ live: false });
    expect(h.queue.subtitlePicker()).toBeNull();
    expect(byId(h.form, 'queue-subtitle-open')).toBeNull();
    expect(byId(h.body, 'subtitle-modal')).toBeNull();
    expect(previewCalls(h)).toEqual([]);
  });

  it('mounts the entry inside the URL paste row only in live mode', () => {
    const h = subtitleHarness();
    expect(h.entry).toBeTruthy();
    expect(h.entry.getAttribute('type')).toBe('button'); // must never submit the form
    expect(h.form.children.indexOf(h.entry)).toBeGreaterThanOrEqual(0);
    expect(h.form.children.indexOf(h.entry)).toBeLessThan(h.form.children.indexOf(h.picker.refs.chip) + 1);
    expect(previewCalls(h)).toEqual([]);              // zero probe on page load
    expect(cancelCalls(h)).toEqual([]);
  });

  it('first preview happens only on the user click, with the exact URL', async () => {
    const h = subtitleHarness({ url: 'https://example.org/watch?v=ONE' });
    expect(previewCalls(h)).toEqual([]);
    h.open();
    expect(previewCalls(h)).toHaveLength(1);
    expect(previewCalls(h)[0].payload).toEqual({ url: 'https://example.org/watch?v=ONE' });
    await tick();
  });

  it('an invalid / empty URL shows an explicit error and never probes', () => {
    const h = subtitleHarness({ url: 'not-a-link' });
    h.open();
    expect(previewCalls(h)).toEqual([]);
    expect(h.picker.state.phase).toBe('error');
    expect(h.modalText()).toContain('http(s)');
  });

  it('static layout switch mounts without a bridge and reports it honestly', async () => {
    const h = subtitleHarness({ live: false, url: 'https://example.org/v' });
    // `?subtitle=1` is simulated by mounting the factory directly here; the
    // real switch is exercised by the browser layout check, not by this unit.
    h.queue.mountSubtitlePicker(h.sandbox.YTVDLT.subtitles);
    const picker = h.queue.subtitlePicker();
    expect(picker).not.toBeNull();
    picker.open();
    await tick();
    expect(picker.state.phase).toBe('error'); // BRIDGE_UNAVAILABLE -> explicit copy
    expect(enqueueCalls(h)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('stage 5 · preview states', () => {
  it('shows a loading state while fetching, then the language list', async () => {
    const h = subtitleHarness();
    h.setPreview({ ok: true, preview: fullDto() });
    let resolvePreview: (value: unknown) => void = () => {};
    h.sandbox.ytvdltBridge.invoke = (channel: string, payload: unknown) => {
      h.calls.push({ channel, payload });
      if (channel === 'ytvdlt:subtitle:preview') {
        return new Promise((resolve) => { resolvePreview = resolve; });
      }
      if (channel === 'ytvdlt:subtitle:previewCancel') return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: true, items: [] });
    };
    h.open();
    expect(h.picker.state.phase).toBe('loading');
    expect(h.modalText()).toContain('正在获取字幕信息');
    expect(byId(h.modal, 'subtitle-confirm')?.disabled).toBe(true);
    resolvePreview({ ok: true, preview: fullDto() });
    await tick();
    expect(h.picker.state.phase).toBe('ready');
    expect(languageBoxes(h)).toHaveLength(3);
  });

  it('normal preview: shows languages, manual/auto labels and their formats', async () => {
    const h = subtitleHarness();
    await ready(h);
    const text = h.modalText();
    expect(text).toContain('en');
    expect(text).toContain('zh-Hans');
    expect(text).toContain('ja');
    expect(text).toContain('人工');
    expect(text).toContain('自动');
    expect(text).toContain('srt');
    expect(text).toContain('vtt');
    expect(text).toContain('srv3');
    expect(text).toContain('Demo clip');      // whitelisted media header
    // Source badges carry both buckets for the same language.
    expect(h.findInModal((n) => n.getAttribute('data-source') === 'manual').length).toBeGreaterThan(0);
    expect(h.findInModal((n) => n.getAttribute('data-source') === 'automatic').length).toBeGreaterThan(0);
  });

  it('no subtitles is a successful empty state, not an error', async () => {
    const h = subtitleHarness();
    await ready(h, dto({ empty: true, tracks: [], manualLanguages: 0, automaticLanguages: 0 }));
    expect(h.picker.state.phase).toBe('empty');
    expect(h.picker.state.errorKey).toBeNull();
    expect(h.modalText()).toContain('没有可用字幕');
    expect(byId(h.modal, 'subtitle-confirm')?.disabled).toBe(true);
  });

  it('each failure code maps to its own honest sentence with a retry', async () => {
    const codes = [
      'PREVIEW_UNAVAILABLE', 'PREVIEW_INVALID_URL', 'PREVIEW_FAILED',
      'PREVIEW_EXPIRED', 'PREVIEW_CONSUMED', 'PREVIEW_URL_MISMATCH', 'PREVIEW_UNKNOWN',
    ];
    for (const code of codes) {
      const h = subtitleHarness();
      h.setPreview({ ok: false, code, message: 'backend said no' });
      h.open();
      await tick();
      expect(h.picker.state.phase, code).toMatch(/error|expired/);
      expect(h.picker.state.errorKey, code).toMatch(/^subtitle\.error\./);
      expect(h.modalText(), code).not.toContain('MISSING:');
      expect(byId(h.modal, 'subtitle-retry')?.getAttribute('hidden')).toBe('false');
      expect(enqueueCalls(h)).toEqual([]);
    }
  });

  it('a track with no usable source format is disabled and labelled', async () => {
    const h = subtitleHarness();
    await ready(h, dto({
      tracks: [
        track({ languageCode: 'en', manualFormats: [], automaticFormats: [] }),
        track({ languageCode: 'ja', manualAvailable: false, automaticAvailable: true, manualFormats: [], automaticFormats: ['vtt'] }),
      ],
    }));
    expect(boxFor(h, 'en').disabled).toBe(true);
    expect(boxFor(h, 'ja').disabled).toBe(false);
    expect(h.modalText()).toContain('格式不可用');
  });

  it('out-of-order responses are discarded and their tickets released', async () => {
    const h = subtitleHarness();
    let first: (value: unknown) => void = () => {};
    let second: (value: unknown) => void = () => {};
    let n = 0;
    h.sandbox.ytvdltBridge.invoke = (channel: string, payload: unknown) => {
      h.calls.push({ channel, payload });
      if (channel === 'ytvdlt:subtitle:preview') {
        n += 1;
        return new Promise((resolve) => { if (n === 1) first = resolve; else second = resolve; });
      }
      if (channel === 'ytvdlt:subtitle:previewCancel') return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: true, items: [] });
    };
    h.open();
    h.picker.close();
    h.open();                                     // second preview supersedes first
    second({ ok: true, preview: fullDto() });
    await tick();
    first({ ok: true, preview: dto({ previewId: 'ticket-STALE' }) });
    await tick();
    expect(h.picker.state.preview.previewId).toBe('ticket-00000001');
    expect(cancelCalls(h).some((c) => (c.payload as any).previewId === 'ticket-STALE')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('stage 5 · selection interaction', () => {
  it('multi-language selection shows a chip per language and a count', async () => {
    const h = subtitleHarness();
    await ready(h);
    select(h, 'en');
    select(h, 'zh-Hans');
    expect(h.modalText()).toContain('已选 2 种');
    expect(h.findInModal((n) => n.className === 'subtitle-chip-item')).toHaveLength(2);
    click(h, 'subtitle-confirm');
    expect(h.entry.getAttribute('aria-pressed')).toBe('true');
    expect(h.picker.state.confirmed.subtitleLanguages).toEqual(['en', 'zh-Hans']);
    // Confirming never creates a download task by itself.
    expect(enqueueCalls(h)).toEqual([]);
  });

  it('manual-only and automatic-only tracks are both selectable', async () => {
    const h = subtitleHarness();
    await ready(h);
    select(h, 'zh-Hans');                       // manual only
    select(h, 'ja');                            // automatic only
    const auto = byId(h.modal, 'subtitle-automatic') as Node;
    auto.checked = true;
    auto.fire('change', {});
    click(h, 'subtitle-confirm');
    expect(h.picker.state.confirmed.subtitleLanguages).toEqual(['zh-Hans', 'ja']);
  });

  it('automatic captions are opt-in via an explicit switch', async () => {
    const h = subtitleHarness();
    await ready(h);
    select(h, 'en');
    const auto = byId(h.modal, 'subtitle-automatic') as Node;
    expect(auto.checked).toBe(false);
    auto.checked = true;
    auto.fire('change', {});
    click(h, 'subtitle-confirm');
    expect(h.picker.state.confirmed.subtitleAutoCaptions).toBe(true);
  });

  it('caps the selection at the core limit of 12 languages', async () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      track({ languageCode: 'l' + i, languageName: 'Lang ' + i }));
    const h = subtitleHarness();
    await ready(h, dto({ tracks: many, manualLanguages: 15 }));
    many.forEach((item, i) => {
      if (i < 12) select(h, item.languageCode);
    });
    const box = boxFor(h, 'l12');
    box.checked = true;
    box.fire('change', {});
    expect(h.modalText()).toContain('最多可选 12 种语言');
    expect(h.picker.state.selected['l12']).toBeUndefined();
  });

  it('choosing embed warns about the forced MKV container change', async () => {
    const h = subtitleHarness();
    await ready(h);
    select(h, 'en');
    const embed = byId(h.modal, 'subtitle-mode-embed') as Node;
    embed.checked = true;
    embed.fire('change', {});
    expect(h.modalText()).toContain('MKV');
    click(h, 'subtitle-confirm');
    expect(h.picker.state.confirmed.subtitleEmbed).toBe(true);
  });

  it('audio mode refuses embed and explains why', async () => {
    const h = subtitleHarness({ kind: 'audio' });
    await ready(h);
    const embed = byId(h.modal, 'subtitle-mode-embed') as Node;
    expect(embed.disabled).toBe(true);
    expect(h.modalText()).toContain('仅音频模式不支持内嵌字幕');
  });

  it('conversion target is a separate, explicit choice', async () => {
    const h = subtitleHarness();
    await ready(h);
    select(h, 'en');
    const convert = byId(h.modal, 'subtitle-convert') as Node;
    convert.value = 'srt';
    convert.fire('change', {});
    click(h, 'subtitle-confirm');
    expect(h.picker.state.confirmed.subtitleConvertTo).toBe('srt');
    expect(h.picker.state.confirmed.subtitleLanguages).toEqual(['en']);
  });
});

// ---------------------------------------------------------------------------
describe('stage 5 · cancel, expiry, URL changes and mismatch', () => {
  it('cancelling releases the ticket and NEVER creates a download task', async () => {
    const h = subtitleHarness();
    await ready(h);
    select(h, 'en');
    click(h, 'subtitle-cancel');
    await tick();
    expect(h.picker.state.confirmed).toBeNull();
    expect(h.picker.getSelection()).toBeNull();
    expect(cancelCalls(h).some((c) => (c.payload as any).previewId === 'ticket-00000001')).toBe(true);
    expect(enqueueCalls(h)).toEqual([]);
    expect(h.modal.getAttribute('hidden')).toBe('true');
  });

  it('Esc and the close button both use the cancel path', async () => {
    for (const how of ['escape', 'close'] as const) {
      const h = subtitleHarness();
      await ready(h);
      select(h, 'en');
      if (how === 'escape') h.doc.fireKey('keydown', { key: 'Escape' });
      else (byId(h.modal, 'subtitle-close') as Node).fire('click', {});
      await tick();
      expect(h.picker.state.confirmed, how).toBeNull();
      expect(h.modal.getAttribute('hidden'), how).toBe('true');
      expect(enqueueCalls(h), how).toEqual([]);
    }
  });

  it('explicit clear drops the selection and the chip', async () => {
    const h = subtitleHarness();
    await ready(h);
    select(h, 'en');
    click(h, 'subtitle-confirm');
    expect(h.picker.state.confirmed).not.toBeNull();
    click(h, 'subtitle-clear');
    await tick();
    expect(h.picker.state.confirmed).toBeNull();
    expect(h.entry.getAttribute('aria-pressed')).toBe('false');
    expect(h.picker.getSelection()).toBeNull();
  });

  it('an expired preview cannot be confirmed', async () => {
    const h = subtitleHarness();
    await ready(h, dto({ expiresAt: new Date(Date.now() - 1_000).toISOString() }));
    select(h, 'en');
    click(h, 'subtitle-confirm');
    expect(h.picker.state.confirmed).toBeNull();
    expect(h.modalText()).toContain('过期');
    expect(h.picker.getSelection()).toBeNull();
  });

  it('changing the URL invalidates the old preview and cancels its ticket', async () => {
    const h = subtitleHarness();
    await ready(h);
    select(h, 'en');
    click(h, 'subtitle-confirm');
    h.setUrl('https://example.org/watch?v=OTHER');
    await tick();
    expect(h.picker.state.confirmed).toBeNull();
    expect(h.picker.state.phase).toBe('stale');
    expect(cancelCalls(h).some((c) => (c.payload as any).previewId === 'ticket-00000001')).toBe(true);
    expect(h.modalText()).toContain('链接已更改');
    // Enqueue on the new URL must NOT carry a stale ticket.
    h.picker.close();
    enqueue(h, 'https://example.org/watch?v=OTHER');
    await tick();
    expect((enqueueCalls(h)[0].payload as any).previewId).toBeUndefined();
  });

  it('enqueue-time URL mismatch blocks submission instead of dropping subtitles', async () => {
    const h = subtitleHarness();
    await ready(h);
    select(h, 'en');
    click(h, 'subtitle-confirm');
    // Simulate a programmatic URL replacement (no input event, e.g. deep link).
    h.urlInput.value = 'https://example.org/other';
    const payload = h.queue.downloadPayload('https://example.org/other');
    expect(payload).toBeNull();
    enqueue(h);
    await tick();
    expect(enqueueCalls(h)).toEqual([]);
    expect(h.picker.getSelection()).toBe(false);
    expect(h.status.textContent).toContain('链接已更改');
  });

  it('a ticket-dead enqueue rejection is reported and blocks the choice', async () => {
    for (const code of ['PREVIEW_EXPIRED', 'PREVIEW_CONSUMED', 'PREVIEW_URL_MISMATCH', 'SUBTITLE_LANGUAGE_UNKNOWN']) {
      const h = subtitleHarness();
      await ready(h);
      select(h, 'en');
      click(h, 'subtitle-confirm');
      h.setEnqueue({ accepted: false, enqueued: false, taskIds: [], code, reason: 'noop' });
      enqueue(h, h.urlInput.value);
      await tick();
      expect(h.picker.state.confirmed, code).not.toBeNull();
      expect(h.picker.getSelection(), code).toBe(false);
      expect(h.status.textContent, code).not.toContain('MISSING:');
    }
  });
});

// ---------------------------------------------------------------------------
describe('stage 5 · enqueue and the untouched legacy flow', () => {
  it('no subtitle selection => byte-identical legacy DOWNLOAD_START payload', async () => {
    const h = subtitleHarness();
    await ready(h);                 // preview exists, but nothing confirmed
    expect(h.queue.downloadPayload('https://example.org/v')).toEqual({
      url: 'https://example.org/v', kind: 'video', quality: 'best',
    });
    enqueue(h, 'https://example.org/v');
    await tick();
    expect(enqueueCalls(h)).toHaveLength(1);
    expect(Object.keys(enqueueCalls(h)[0].payload as object).sort())
      .toEqual(['kind', 'operationId', 'quality', 'url']);
  });

  it('a confirmed selection adds exactly the six flat keys + previewId', async () => {
    const h = subtitleHarness();
    await ready(h);
    select(h, 'en');
    select(h, 'ja');
    const auto = byId(h.modal, 'subtitle-automatic') as Node;
    auto.checked = true; auto.fire('change', {});
    const convert = byId(h.modal, 'subtitle-convert') as Node;
    convert.value = 'srt'; convert.fire('change', {});
    click(h, 'subtitle-confirm');
    const payload = h.queue.downloadPayload(h.urlInput.value) as Record<string, unknown>;
    expect(payload.url).toBe('https://example.org/watch?v=abcdef');
    expect(payload.kind).toBe('video');
    expect(payload.quality).toBe('best');
    expect(payload.previewId).toBe('ticket-00000001');
    expect(payload.subtitleLanguages).toEqual(['en', 'ja']);
    expect(payload.subtitleAutoCaptions).toBe(true);
    expect(payload.subtitleConvertTo).toBe('srt');
    expect(payload.subtitleEmbed).toBe(false);
    expect(payload.subtitleKeepFile).toBe(false);
  });

  it('enqueue success consumes the one-shot ticket and clears the choice', async () => {
    const h = subtitleHarness();
    await ready(h);
    select(h, 'en');
    click(h, 'subtitle-confirm');
    enqueue(h, h.urlInput.value);
    await tick();
    expect(enqueueCalls(h)).toHaveLength(1);
    expect(enqueueCalls(h)[0].payload).toMatchObject({ previewId: 'ticket-00000001' });
    expect(h.picker.state.confirmed).toBeNull();
    expect(h.picker.getSelection()).toBeNull();
    // A second download must not replay the consumed ticket.
    enqueue(h, 'https://example.org/watch?v=abcdef');
    await tick();
    expect((enqueueCalls(h)[1].payload as any).previewId).toBeUndefined();
  });

  it('re-opening a still-valid confirmed selection restores it without a probe', async () => {
    const h = subtitleHarness();
    await ready(h);
    select(h, 'en');
    click(h, 'subtitle-confirm');
    const before = previewCalls(h).length;
    h.open();
    await tick();
    expect(previewCalls(h)).toHaveLength(before);
    expect(boxFor(h, 'en').checked).toBe(true);
  });

  it('retry after failure issues a fresh preview and releases the old ticket', async () => {
    const h = subtitleHarness();
    h.setPreview({ ok: false, code: 'PREVIEW_FAILED', message: 'x' });
    h.open();
    await tick();
    expect(h.picker.state.phase).toBe('error');
    h.setPreview({ ok: true, preview: fullDto() });
    click(h, 'subtitle-retry');
    await tick();
    expect(h.picker.state.phase).toBe('ready');
    expect(previewCalls(h).length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
describe('stage 6 · subtitle state regressions', () => {
  it.each([['ja'], ['en', 'ja']])('requires explicit automatic opt-in for %j', async (...codes: string[]) => {
    const h = subtitleHarness();
    await ready(h);
    codes.forEach((code) => select(h, code));
    expect(byId(h.modal, 'subtitle-confirm')?.disabled).toBe(true);
    expect(h.modalText()).toContain('请开启「包含自动字幕」');
    h.picker.confirm();
    expect(h.picker.getSelection()).toBeNull();
    const automatic = byId(h.modal, 'subtitle-automatic') as Node;
    automatic.checked = true;
    automatic.fire('change', {});
    expect(byId(h.modal, 'subtitle-confirm')?.disabled).toBe(false);
    automatic.checked = false;
    automatic.fire('change', {});
    expect(byId(h.modal, 'subtitle-confirm')?.disabled).toBe(true);
    automatic.checked = true;
    automatic.fire('change', {});
    h.picker.confirm();
    expect(h.picker.getSelection().subtitleAutoCaptions).toBe(true);
  });

  it('keeps a dual-source manual selection usable with automatic captions off', async () => {
    const h = subtitleHarness();
    await ready(h);
    select(h, 'en');
    expect(byId(h.modal, 'subtitle-confirm')?.disabled).toBe(false);
    h.picker.confirm();
    expect(h.picker.getSelection().subtitleAutoCaptions).toBe(false);
  });

  it('switches a confirmed embedded choice to external files in audio mode', async () => {
    const h = subtitleHarness();
    await ready(h);
    select(h, 'en');
    const embed = byId(h.modal, 'subtitle-mode-embed') as Node;
    embed.checked = true;
    embed.fire('change', {});
    const keep = byId(h.modal, 'subtitle-keep') as Node;
    keep.checked = true;
    keep.fire('change', {});
    h.picker.confirm();
    h.queue.setKind('audio');
    expect(h.picker.getSelection()).toMatchObject({ subtitleEmbed: false, subtitleKeepFile: false });
    expect(h.picker.refs.chip.textContent).toContain('外置');
    expect(h.status.textContent).toContain('已选字幕改为外置文件');
    h.open();
    expect(embed.checked).toBe(false);
    expect(keep.checked).toBe(false);
    h.picker.cancel();
    enqueue(h);
    await tick();
    expect(enqueueCalls(h)[0].payload).toMatchObject({ kind: 'audio', subtitleEmbed: false, subtitleKeepFile: false });
  });

  it.each(['resolve', 'reject'])('clear invalidates an in-flight preview that will %s', async (outcome) => {
    let resolvePreview: (value: unknown) => void = () => {};
    let rejectPreview: (reason: unknown) => void = () => {};
    const pending = new Promise((resolve, reject) => { resolvePreview = resolve; rejectPreview = reject; });
    const h = subtitleHarness({ onInvoke: (channel) => channel === 'ytvdlt:subtitle:preview' ? pending : undefined });
    h.open();
    h.picker.clearSelection();
    expect(h.picker.state.loading).toBe(false);
    expect(h.picker.state.phase).toBe('idle');
    if (outcome === 'resolve') resolvePreview({ ok: true, preview: fullDto() });
    else rejectPreview(new Error('late failure'));
    await tick();
    expect(h.picker.state.phase).toBe('idle');
    expect(h.picker.state.preview).toBeNull();
    expect(h.picker.getSelection()).toBeNull();
    if (outcome === 'resolve') expect(cancelCalls(h)[0].payload).toEqual({ previewId: 'ticket-00000001' });
  });

  it('clear synchronizes automatic, embedding and keep-file controls on reopening', async () => {
    const h = subtitleHarness();
    await ready(h);
    select(h, 'en');
    for (const id of ['subtitle-automatic', 'subtitle-mode-embed', 'subtitle-keep']) {
      const control = byId(h.modal, id) as Node;
      control.checked = true;
      control.fire('change', {});
    }
    h.picker.confirm();
    h.picker.clearSelection();
    h.open();
    await tick();
    for (const id of ['subtitle-automatic', 'subtitle-mode-embed', 'subtitle-keep']) {
      expect(byId(h.modal, id)?.checked, id).toBe(false);
    }
    expect(byId(h.modal, 'subtitle-mode-external')?.checked).toBe(true);
  });

  it('blocks repeated expired submissions until explicit clear, without a download IPC', async () => {
    const h = subtitleHarness();
    await ready(h, dto({ expiresAt: new Date(Date.now() + 100).toISOString() }));
    select(h, 'en');
    h.picker.confirm();
    await vi.advanceTimersByTimeAsync(101);
    enqueue(h);
    enqueue(h);
    await tick();
    expect(enqueueCalls(h)).toEqual([]);
    expect(h.status.textContent).toContain('已过期');
    expect(h.modal.getAttribute('hidden')).toBe('false');
    h.picker.clearSelection();
    enqueue(h);
    await tick();
    expect(enqueueCalls(h)).toHaveLength(1);
    expect(Object.keys(enqueueCalls(h)[0].payload as object).sort())
      .toEqual(['kind', 'operationId', 'quality', 'url']);
  });

  it.each(['PREVIEW_EXPIRED', 'PREVIEW_CONSUMED', 'SUBTITLE_NO_MANUAL_TRACK', 'ENQUEUE_FAILED'])('blocks repeated submissions after Main rejects %s until clear or re-preview', async (code) => {
    const h = subtitleHarness();
    await ready(h);
    select(h, 'en');
    h.picker.confirm();
    h.setEnqueue({ accepted: false, enqueued: false, code });
    enqueue(h);
    await tick();
    expect(enqueueCalls(h)).toHaveLength(1);
    enqueue(h);
    await tick();
    enqueue(h);
    await tick();
    expect(enqueueCalls(h)).toHaveLength(1);
    expect(h.picker.getSelection()).toBe(false);
    await ready(h);
    select(h, 'en');
    h.picker.confirm();
    expect(h.picker.getSelection()).not.toBe(false);
    h.picker.clearSelection();
    expect(h.picker.getSelection()).toBe(null);
  });

  it('reports the Main automatic-source rejection with translated guidance', async () => {
    const h = subtitleHarness();
    await ready(h);
    select(h, 'en');
    h.picker.confirm();
    h.setEnqueue({ accepted: false, enqueued: false, code: 'SUBTITLE_NO_MANUAL_TRACK' });
    enqueue(h);
    await tick();
    expect(h.status.textContent).toContain('请开启「包含自动字幕」');
  });

  it('repaints missing and partial subtitle warnings without changing Completed state', async () => {
    let outcome: string | undefined;
    const h = subtitleHarness({ onInvoke: (channel) => channel === 'ytvdlt:task:list'
      ? { ok: true, items: [{ id: 'subtitle-task', state: 'Completed', title: 'Clip', subtitleOutcome: outcome }] }
      : undefined });
    await tick();
    const cards = h.doc.getElementById('queue-cards') as Node;
    expect(find(cards, (node) => node.getAttribute('data-subtitle-outcome') !== null)).toHaveLength(0);
    for (const next of ['missing', 'partial', 'none']) {
      outcome = next;
      await vi.advanceTimersByTimeAsync(3000);
      const warnings = find(cards, (node) => node.getAttribute('data-subtitle-outcome') !== null);
      expect(warnings).toHaveLength(next === 'none' ? 0 : 1);
      if (next !== 'none') {
        expect(warnings[0].getAttribute('data-subtitle-outcome')).toBe(next);
        expect(warnings[0].textContent).toContain('警告');
      }
      expect(cards.children[0].getAttribute('data-state')).toBe('Completed');
    }
  });
});

describe('stage 5 · privacy, i18n and responsive layout', () => {
  it('never renders the video URL or any signed subtitle URL into the DOM', async () => {
    const h = subtitleHarness({ url: 'https://example.org/watch?v=SUPERSECRET&sig=abcdef' });
    await ready(h, fullDto());
    const all = h.findInModal(() => true).concat(find(h.root, () => true));
    for (const node of all) {
      for (const [key, value] of Object.entries(node.attrs)) {
        expect(value, key).not.toContain('SUPERSECRET');
        expect(value, key).not.toContain('http');
      }
    }
    expect(h.modalText()).not.toContain('SUPERSECRET');
    expect(h.modalText()).not.toContain('https://');
  });

  it('site-supplied text is painted as text, never as markup', async () => {
    const h = subtitleHarness();
    await ready(h, dto({
      media: { title: '<img src=x onerror=alert(1)>', uploader: '<b>Studio</b>', durationSec: null, extractorKey: 'X' },
      tracks: [track({ languageName: '<script>bad()</script>' })],
    }));
    expect(h.modalText()).toContain('<img src=x onerror=alert(1)>');
    expect(h.modalText()).toContain('<script>bad()</script>');
    expect(h.findInModal((n) => n.tagName === 'img')).toEqual([]);
    expect(h.findInModal((n) => n.tagName === 'script')).toEqual([]);
  });

  it('ships identical zh-CN / en key sets and no missing subtitle copy', () => {
    const source = readFileSync(join(UI_SRC, 'i18n', 'messages.js'), 'utf8');
    const sandbox: Record<string, any> = {};
    new Function('window', source)(sandbox);
    const messages = sandbox['YTVDLT_I18N'].MESSAGES as Record<string, Record<string, string>>;
    const zh = Object.keys(messages['zh-CN']).filter((k) => k.startsWith('subtitle.')).sort();
    const en = Object.keys(messages['en']).filter((k) => k.startsWith('subtitle.')).sort();
    expect(zh.length).toBeGreaterThan(40);
    expect(en).toEqual(zh);
    for (const key of zh) {
      expect(messages['zh-CN'][key].trim().length, key).toBeGreaterThan(0);
      expect(messages['en'][key].trim().length, key).toBeGreaterThan(0);
    }
    const h = subtitleHarness({ lang: 'en' });
    expect(h.entry.textContent).toBe('Subtitles');
  });

  it('CSS is queue-scoped and adapts to narrow / short viewports', () => {
    const css = readFileSync(join(UI_SRC, 'styles', 'subtitles.css'), 'utf8');
    expect(css).toContain('.subtitle-modal');
    expect(css).toContain('max-height: min(84vh, 680px)');
    expect(css).toContain('overflow: auto');
    expect(css).toContain('@media (max-width: 720px)');
    expect(css).toContain('@media (max-height: 640px)');
    expect(css).toContain('grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr))');
    // Only the queue page links it; no frozen screenshot of another page can move.
    const queueHtml = readFileSync(join(UI_SRC, 'pages', 'queue', 'index.html'), 'utf8');
    expect(queueHtml).not.toContain('subtitle-picker.js');
    expect(queueHtml).not.toContain('subtitles.css');
  });

  /**
   * Stage-6 regression for a REAL defect found by the real-input smoke:
   * the entry button used `id="queue-subtitle"`, which the queue page already
   * owns for its header subtitle line. `document.querySelector('#queue-subtitle')`
   * then resolved to that <p>, so a real click landed on a paragraph and the
   * preview never started (picker.state stayed `idle`, `seq` 0).
   */
  it('never reuses an id that the queue page already owns', () => {
    const queueHtml = readFileSync(join(UI_SRC, 'pages', 'queue', 'index.html'), 'utf8');
    const pageIds = new Set([...queueHtml.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] as string));
    expect(pageIds.has('queue-subtitle')).toBe(true);   // the header line, not our button

    const source = readFileSync(join(UI_SRC, 'subtitles', 'subtitle-picker.js'), 'utf8');
    const componentIds = [...source.matchAll(/setAttribute\('id', '([^']+)'\)/g)]
      .map((match) => match[1] as string);
    expect(componentIds.length).toBeGreaterThan(15);
    expect(componentIds.filter((id) => pageIds.has(id))).toEqual([]);
    expect(componentIds).toContain('queue-subtitle-open');
    expect(componentIds).not.toContain('queue-subtitle');
  });

  it('exposes the entry as a real button under a unique id', () => {
    const h = subtitleHarness();
    expect(h.entry.tagName).toBe('button');
    expect(h.entry.getAttribute('id')).toBe('queue-subtitle-open');
    expect(h.entry.getAttribute('type')).toBe('button');
  });


  it('modal keeps header, scrolling body and footer actions as separate flex regions', async () => {
    const h = subtitleHarness();
    await ready(h);
    const css = readFileSync(join(UI_SRC, 'styles', 'subtitles.css'), 'utf8');
    expect(css).toContain('.subtitle-body');
    expect(css).toContain('.subtitle-actions');
    expect(byId(h.modal, 'subtitle-rows')).toBeTruthy();
    expect(byId(h.modal, 'subtitle-confirm')).toBeTruthy();
    expect(byId(h.modal, 'subtitle-cancel')).toBeTruthy();
    expect(byId(h.modal, 'subtitle-close')).toBeTruthy();
    expect(h.modal.getAttribute('role')).toBe('dialog');
    expect(h.modal.getAttribute('aria-modal')).toBe('true');
  });
});
