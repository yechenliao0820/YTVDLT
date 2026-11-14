/**
 * D-187 · every `packages/ui` source module must boot under the import-based
 * harness. This is both a smoke guard (a stray top-level `document` access
 * regression would break the coverage harness for that module) and the
 * coverage baseline loader: the real `import()` here is what lets the v8
 * coverage provider see UI sources at all — the legacy `runInNewContext`
 * tests execute in VM sandboxes the provider never reports.
 *
 * All modules load ONCE in `beforeAll`, in page script order, against a single
 * shared fake window: the ESM module registry caches each file after its first
 * import, so a fresh `beforeEach` window would leave later modules stranded
 * without the `YTVDLT*` collaborators an earlier import attached to the
 * previous window. The fake timers keep boot intervals/paint loops inert.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installUiGlobals, loadUiModule, type UiGlobals } from './helpers/ui-harness.js';

const MODULES: string[] = [
  // Page script order matters: the shared `YTVDLT` namespace (shell, dialog
  // state, i18n) must exist before the modules that read it at boot.
  'i18n/messages.js',
  'i18n/i18n.js',
  'theme/theme.js',
  'shell/app-version.js',
  'shell/app-nav.js',
  'ipc-bridge.js',
  'shortcuts/shortcuts.js',
  'app-shell.js',
  'fixtures/probe-fixture.js',
  'dialogs/dialog-state.js',
  'dialogs/format-selector.js',
  'dialogs/subtitle-selector.js',
  'dialogs/playlist-selector.js',
  'pages/queue/queue.js',
  'pages/queue/playlist-batch.js',
  'pages/settings/settings.js',
  'pages/task-detail/task-detail.js',
  'pages/task-log/task-log.js',
  'subtitles/subtitle-picker.js',
  'playlists/playlist-import.js',
  'updates/update-dialog.js',
  'txt-import/txt-import.js',
  'sites/supported-sites.js',
  'about/about.js',
];

interface BootResult { ok: boolean; keys: string[]; error?: string }
const results = new Map<string, BootResult>();
let globals: UiGlobals | null = null;

beforeAll(async () => {
  vi.useFakeTimers();
  globals = installUiGlobals({ bridge: null });
  for (const path of MODULES) {
    try {
      await loadUiModule(path, globals);
      results.set(path, { ok: true, keys: Object.keys(globals.attached) });
    } catch (error) {
      results.set(path, { ok: false, keys: [], error: String(error) });
    }
  }
});

afterAll(() => {
  globals?.restore();
  globals = null;
  vi.useRealTimers();
});

describe('D-187 · UI modules boot under the import harness', () => {
  for (const path of MODULES) {
    it(`boots ${path} and exposes its YTVDLT surface`, () => {
      const result = results.get(path);
      // Every UI script is an IIFE attaching at least one YTVDLT* surface to
      // the window it receives; an empty surface means the module silently
      // took a "no window" branch, which would starve the coverage harness.
      expect(result?.ok, result?.error).toBe(true);
      expect(result?.keys.length ?? 0, `${path} attached nothing to the fake window`).toBeGreaterThan(0);
    });
  }
});
