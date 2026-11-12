/**
 * Queue page · automatic playlist detection on paste/submit.
 *
 * Executes the REAL `queue.js` against the shared fake-DOM harness. The
 * selector itself is injected as a tiny factory (its own behaviour is covered
 * by `playlist-import-ui.test.ts`); here we prove the ROUTING: a playlist URL
 * opens the selector, and every other URL keeps the untouched single-download
 * channel.
 */
import { describe, it, expect } from 'vitest';
import { harness, FakeNode } from './helpers/queue-page-harness.js';

/** `queue.js` only mounts the selector when the paste form exists. */
const withPasteForm = () => ({ 'queue-paste-form': new FakeNode('form') });

const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PL_GTA_65';
const SINGLE_URL = 'https://www.youtube.com/watch?v=video001';

function selector() {
  const opened: string[] = [];
  let created = 0;
  const factory = {
    create() {
      created += 1;
      return {
        mount: () => undefined,
        open: (url: string) => { opened.push(url); },
        close: () => undefined,
        cancel: () => undefined,
        isPlaylistLike: (url: string) => /[?&]list=|\/playlist/.test(url),
        isOpen: () => false,
        state: () => ({}),
      };
    },
  };
  return { factory, opened, created: () => created };
}

describe('queue.js · playlist auto-detection', () => {
  it('a playlist URL opens the selector instead of starting a single download', () => {
    const { factory, opened } = selector();
    const h = harness({ live: true, playlistFactory: factory, elements: withPasteForm() });
    h.queue.startRealDownload(PLAYLIST_URL);
    expect(opened).toEqual([PLAYLIST_URL]);
    expect(h.calls.some((call) => call.channel === 'ytvdlt:download:start')).toBe(false);
    expect(h.queue.playlistImport()).not.toBeNull();
  });

  it('a plain watch URL still goes through DOWNLOAD_START (no regression)', async () => {
    const { factory, opened } = selector();
    const h = harness({ live: true, playlistFactory: factory, elements: withPasteForm() });
    h.queue.startRealDownload(SINGLE_URL);
    // D-139: the single-URL path now asks URL_SUPPORT_CHECK first, so the
    // enqueue lands one macrotask later. The assertion itself is unchanged.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(opened).toEqual([]);
    const sent = h.calls.find((call) => call.channel === 'ytvdlt:download:start');
    expect(sent).toBeDefined();
    expect(sent?.payload).toMatchObject({ url: SINGLE_URL, kind: 'video' });
  });

  it('without the selector (static preview) the original path is unchanged', async () => {
    const h = harness({ live: true });
    expect(h.queue.playlistImport()).toBeNull();
    h.queue.startRealDownload(PLAYLIST_URL);
    // Same reason as above: the pre-check is asynchronous, the destination is
    // still DOWNLOAD_START once it answers `unavailable`.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls.some((call) => call.channel === 'ytvdlt:download:start')).toBe(true);
  });

  it('live mode mounts the selector exactly once at page load', () => {
    const { factory, created } = selector();
    const h = harness({ live: true, playlistFactory: factory, elements: withPasteForm() });
    expect(created()).toBe(1);
    expect(h.queue.playlistImport()).not.toBeNull();
    // Calling ensure again must not create a second component.
    h.queue.ensurePlaylistImport();
    expect(created()).toBe(1);
  });
});
