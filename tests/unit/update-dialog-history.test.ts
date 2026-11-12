/**
 * Update dialog · version-jump history (D-140).
 *
 * The dialog used to print one release body, so a user on 0.2.8 who upgraded to
 * 0.3.0 never learned what 0.2.9 changed. These cases pin the contract: one
 * block per skipped version, oldest first, and no DOM rebuild while the page
 * keeps polling the same state (a rebuild would reset the scroll position).
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

interface FakeNode {
  style: { cssText?: string; display?: string; width?: string; color?: string };
  attributes: Record<string, string>;
  children: FakeNode[];
  textContent: string;
  disabled: boolean;
  id?: string;
  setAttribute(key: string, value: string): void;
  getAttribute(key: string): string;
  appendChild(child: FakeNode): void;
  addEventListener(event: string, handler: () => void): void;
  click?: () => void;
}

function boot(): { window: any; nodes: Map<string, FakeNode> } {
  const nodes = new Map<string, FakeNode>();
  function element(): FakeNode {
    const node: any = {
      style: {}, attributes: {}, children: [], textContent: '', disabled: false,
      appendChild(child: any) { this.children.push(child); },
      setAttribute(key: string, value: string) { this.attributes[key] = value; },
      getAttribute(key: string) { return this.attributes[key]; },
      addEventListener(_event: string, handler: () => void) { this.click = handler; },
    };
    Object.defineProperty(node, 'id', { set(value) { nodes.set(value, node); } });
    return node;
  }
  const window: any = {
    document: {
      createElement: element, body: element(), readyState: 'loading', addEventListener() {},
    },
    YTVDLT: { i18n: { t: (key: string) => key } },
  };
  runInNewContext(readFileSync('packages/ui/src/updates/update-dialog.js', 'utf8'), { window });
  return { window, nodes };
}

function textOf(node: FakeNode | undefined): string[] {
  if (node === undefined) return [];
  const out: string[] = [];
  const walk = (current: FakeNode): void => {
    if (typeof current.textContent === 'string' && current.textContent !== '') {
      out.push(current.textContent);
    }
    for (const child of current.children) walk(child);
  };
  walk(node);
  return out;
}

const available = {
  phase: 'available',
  currentVersion: '0.2.8',
  latest: {
    version: '0.3.0', notes: 'Big release', publishedAt: '2026-11-12T05:58:56Z',
  },
  releaseNotes: [
    { version: '0.2.9', publishedAt: '2026-11-10T08:08:07Z', notes: 'right-click menu' },
    { version: '0.3.0', publishedAt: '2026-11-12T05:58:56Z', notes: 'Big release' },
  ],
  omittedReleaseNotes: 0,
  downloadedBytes: 0,
  totalBytes: null,
  skippedVersion: null,
  canAutoInstall: true,
};

it('prints one block per skipped version, oldest first', () => {
  const { window, nodes } = boot();
  window.YTVDLTUpdateDialog.__apply(available);

  const text = textOf(nodes.get('ytvdlt-update-notes')).join('\n');
  expect(text).toContain('v0.2.9');
  expect(text).toContain('right-click menu');
  expect(text).toContain('v0.3.0');
  expect(text).toContain('Big release');
  expect(text.indexOf('v0.2.9')).toBeLessThan(text.indexOf('v0.3.0'));

  // The header and the subtitle say out loud that versions were skipped.
  expect(nodes.get('ytvdlt-update-notes-title')?.textContent).toBe('update.notes.range');
  expect(nodes.get('ytvdlt-update-sub')?.textContent).toBe('update.subtitle.jump');
});

it('does not rebuild the notes DOM while the page keeps polling', () => {
  const { window, nodes } = boot();
  window.YTVDLTUpdateDialog.__apply(available);
  const box = nodes.get('ytvdlt-update-notes');
  const rendered = box?.children.length ?? 0;
  expect(rendered).toBe(2);

  window.YTVDLTUpdateDialog.__apply({ ...available, downloadedBytes: 0 });
  window.YTVDLTUpdateDialog.__apply({ ...available, phase: 'downloading', downloadedBytes: 64 });
  expect(box?.children.length).toBe(rendered);
});

it('says how many older versions were left out', () => {
  const { window, nodes } = boot();
  window.YTVDLTUpdateDialog.__apply({ ...available, omittedReleaseNotes: 3 });
  const text = textOf(nodes.get('ytvdlt-update-notes')).join('\n');
  expect(text).toContain('update.notes.omitted');
  // 2 blocks + 3 omitted = 4 skipped versions.
  expect(nodes.get('ytvdlt-update-sub')?.textContent).toBe('update.subtitle.jump');
});

it('keeps the single-body layout for a main process without history', () => {
  const { window, nodes } = boot();
  const { releaseNotes: _ignored, ...legacy } = available;
  window.YTVDLTUpdateDialog.__apply({ ...legacy, currentVersion: '0.2.9' });

  const text = textOf(nodes.get('ytvdlt-update-notes')).join('\n');
  expect(text).toContain('Big release');
  expect(text).not.toContain('v0.2.9');
  expect(nodes.get('ytvdlt-update-notes-title')?.textContent).toBe('update.notes');
  expect(nodes.get('ytvdlt-update-sub')?.textContent).toBe('update.subtitle');
});
