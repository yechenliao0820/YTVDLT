import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * D-166 follow-up: the main process now reports the HKCU Run truth on the
 * SETTINGS_GET snapshot (`autostart`), but the settings page only repainted
 * theme / paths / the two update switches from it — the checkbox stayed at its
 * `__YTVDLT_SETTINGS__` fallback, which the packaged app never injects. This
 * drives the SAME source slice the page runs and asserts the checkbox follows
 * the snapshot. Live-only by construction: without a bridge the callback never
 * runs, so the frozen static baselines are untouched.
 */
// Handbook pit 33 / D-158: windows-latest checks sources out with CRLF
// (.gitattributes pins *.mjs only), and the multi-line endMarker below spans
// lines — a `\n` marker never matches a `\r\n` file, so the slice collapses
// and every case in this file would fail on CI only. Normalize at the input
// boundary; the assertions themselves are untouched.
const source = readFileSync('packages/ui/src/pages/settings/settings.js', 'utf8').replace(/\r\n/g, '\n');

function harness(snapshot: unknown, initial: { autostart: boolean; appAuto: boolean; engineAuto: boolean }) {
  const autostart = { checked: initial.autostart };
  const appAuto = { checked: initial.appAuto };
  const engineAuto = { checked: initial.engineAuto };
  const paintedPaths: unknown[] = [];
  let themePaints = 0;
  const context: Record<string, unknown> = {
    invokeBridge: () => (snapshot === undefined ? null : Promise.resolve(snapshot)),
    paintTheme: () => { themePaints += 1; },
    paintPaths: (value: unknown) => { paintedPaths.push(value); },
    appAuto,
    engineAuto,
    autostart,
  };
  const start = source.indexOf('var pendingSettings = invokeBridge');
  const endMarker = '}).catch(function () { /* keep the defaults */ });\n    }';
  const end = source.indexOf(endMarker, start) + endMarker.length;
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  runInNewContext(source.slice(start, end), context);
  return { autostart, appAuto, engineAuto, paintedPaths, themePaints: () => themePaints };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

describe('settings autostart · the snapshot repaints the checkbox (D-166 follow-up)', () => {
  it('consumes the registry-backed snapshot value (stale false -> true)', async () => {
    const app = harness(
      { autostart: true, autoCheckAppUpdate: true, autoCheckEngineUpdate: false, theme: 'dark', videoDir: 'C:/v' },
      { autostart: false, appAuto: false, engineAuto: true },
    );
    await flush();
    expect(app.autostart.checked).toBe(true);
    // The pre-existing snapshot repaints keep working.
    expect(app.appAuto.checked).toBe(true);
    expect(app.engineAuto.checked).toBe(false);
    expect(app.paintedPaths).toHaveLength(1);
    expect(app.themePaints()).toBe(1);
  });

  it('corrects a stale checked box to false', async () => {
    const app = harness(
      { autostart: false, autoCheckAppUpdate: false, autoCheckEngineUpdate: false },
      { autostart: true, appAuto: true, engineAuto: true },
    );
    await flush();
    expect(app.autostart.checked).toBe(false);
  });

  it('stays untouched when no bridge answers (static preview is live-only)', async () => {
    const app = harness(undefined, { autostart: false, appAuto: false, engineAuto: false });
    await flush();
    expect(app.autostart.checked).toBe(false);
    expect(app.appAuto.checked).toBe(false);
    expect(app.paintedPaths).toHaveLength(0);
    expect(app.themePaints()).toBe(0);
  });

  it('stays untouched when the snapshot carries no autostart key', async () => {
    const app = harness(
      { autoCheckAppUpdate: true, autoCheckEngineUpdate: true },
      { autostart: true, appAuto: false, engineAuto: false },
    );
    await flush();
    expect(app.autostart.checked).toBe(true);
    expect(app.appAuto.checked).toBe(true);
  });
});
