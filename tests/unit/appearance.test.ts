/**
 * M5-1 · appearance policy (A-4.4-20 / A-4.6-06).
 *
 * The colour VALUES live in CSS (single source of truth), so this test parses
 * the two stylesheets and enforces two invariants that a human reviewer cannot
 * eyeball reliably:
 *   1. every accent preset reaches WCAG AA (>= 4.5:1) as text on BOTH surfaces
 *      of its theme (`--panel` and `--bg`);
 *   2. the default light accent is still exactly the frozen M3 colour — that is
 *      what lets the 14 M3 screenshots stay pixel-identical.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ACCENT_PRESETS, DEFAULT_ACCENT, THEME_MODES, MOTION_MODES,
  normalizeThemeMode, normalizeMotionMode, normalizeHexColor, parseAccent,
  resolveTheme, resolveMotion, effectiveAccent, contrastRatio, meetsContrast,
  relativeLuminance, hexToRgb, transitionMs, hapticsCapability,
  readAppearance, resolveAppearance,
} from '@ytvdlt/core';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (relative: string): string => readFileSync(`${ROOT}${relative}`, 'utf8');

/** Extract `--var: #hex` pairs from one CSS block. */
function blockVars(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, 'g');
  const out: Record<string, string> = {};
  for (const match of css.matchAll(block)) {
    for (const declaration of (match[1] ?? '').split(';')) {
      const pair = /--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/.exec(declaration.trim());
      if (pair?.[1] !== undefined && pair[2] !== undefined) out[pair[1]] = pair[2];
    }
  }
  return out;
}

describe('appearance · normalisation never throws on junk', () => {
  it('falls back to system / preset for unknown values', () => {
    expect(normalizeThemeMode('dark')).toBe('dark');
    expect(normalizeThemeMode('DARK')).toBe('system');
    expect(normalizeThemeMode(null)).toBe('system');
    expect(normalizeThemeMode(42)).toBe('system');
    expect(normalizeMotionMode('reduced')).toBe('reduced');
    expect(normalizeMotionMode('nope')).toBe('system');
    expect(THEME_MODES).toEqual(['light', 'dark', 'system']);
    expect(MOTION_MODES).toEqual(['system', 'reduced', 'full']);
  });

  it('normalises #rgb / #rrggbb / bare hex and rejects the rest', () => {
    expect(normalizeHexColor('#1D63B8')).toBe('#1d63b8');
    expect(normalizeHexColor('1d63b8')).toBe('#1d63b8');
    expect(normalizeHexColor('#abc')).toBe('#aabbcc');
    expect(normalizeHexColor('#12345')).toBeNull();
    expect(normalizeHexColor('rebeccapurple')).toBeNull();
    expect(normalizeHexColor(undefined)).toBeNull();
  });

  it('parses accents with hex > system > preset precedence', () => {
    expect(parseAccent('system')).toEqual({ kind: 'system' });
    expect(parseAccent('#00ff88')).toEqual({ kind: 'hex', value: '#00ff88' });
    expect(parseAccent('teal')).toEqual({ kind: 'preset', value: 'teal' });
    expect(parseAccent('unknown-preset')).toEqual({ kind: 'preset', value: DEFAULT_ACCENT });
    expect(parseAccent(undefined)).toEqual({ kind: 'preset', value: DEFAULT_ACCENT });
  });
});

describe('appearance · resolution', () => {
  it('system follows the OS, explicit modes win', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveMotion('system', true)).toBe('reduced');
    expect(resolveMotion('system', false)).toBe('full');
    expect(resolveMotion('full', true)).toBe('full');
  });

  it('accent follows the OS colour only when the user chose "system"', () => {
    expect(effectiveAccent({ kind: 'system' }, '#123456')).toEqual({ kind: 'hex', value: '#123456' });
    expect(effectiveAccent({ kind: 'system' }, null)).toEqual({ kind: 'preset', value: DEFAULT_ACCENT });
    expect(effectiveAccent({ kind: 'preset', value: 'rose' }, '#123456')).toEqual({ kind: 'preset', value: 'rose' });
    expect(effectiveAccent({ kind: 'hex', value: '#abcdef' }, '#123456')).toEqual({ kind: 'hex', value: '#abcdef' });
    // A malformed OS accent must not leak through as a colour.
    expect(effectiveAccent({ kind: 'system' }, 'not-a-colour')).toEqual({ kind: 'preset', value: DEFAULT_ACCENT });
  });

  it('reduced motion collapses transitions to 0 ms', () => {
    expect(transitionMs('full')).toBe(180);
    expect(transitionMs('reduced')).toBe(0);
    expect(transitionMs('reduced', 900)).toBe(0);
    expect(hapticsCapability().supported).toBe(false);
    expect(hapticsCapability().reason).toContain('触觉');
  });
});

describe('appearance · WCAG maths', () => {
  it('matches the known extremes', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#000000'), 6);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(hexToRgb('#ff0000')).toEqual([1, 0, 0]);
    expect(() => hexToRgb('nope')).toThrow(/invalid hex/);
    expect(meetsContrast('#1d63b8', '#ffffff')).toBe(true);
    expect(meetsContrast('#eeeeee', '#ffffff')).toBe(false);
    expect(meetsContrast('#9fb0c2', '#16202b')).toBe(true);
  });
});

describe('appearance · shipped palette stays readable (CSS is the source of truth)', () => {
  const base = read('packages/ui/src/styles/ytvdlt.css');
  const theme = read('packages/ui/src/styles/theme.css');
  const light = { ...blockVars(base, ':root'), ...blockVars(theme, 'html[data-accent="blue"]') };
  const dark = { ...light, ...blockVars(theme, 'html[data-theme="dark"]') };

  it('keeps the M3 default accent byte-identical (baseline stability)', () => {
    expect(blockVars(base, ':root')['accent']).toBe('#1d63b8');
    expect(DEFAULT_ACCENT).toBe('blue');
  });

  it('has a dark override for every neutral token used by the M3 stylesheet', () => {
    const required = ['ink', 'muted', 'line', 'panel', 'bg', 'accent', 'danger', 'warn-bg', 'ok'];
    const darkVars = blockVars(theme, 'html[data-theme="dark"]');
    for (const token of required) {
      expect(darkVars[token], `dark --${token}`).toBeDefined();
    }
  });

  it.each(ACCENT_PRESETS)('accent %s is AA on light and dark surfaces', (preset) => {
    const lightAccent = { ...light, ...blockVars(theme, `html[data-accent="${preset}"]`) }['accent'];
    const darkAccent = { ...dark, ...blockVars(theme, `html[data-theme="dark"][data-accent="${preset}"]`) }['accent'];
    expect(lightAccent, `light ${preset}`).toBeDefined();
    expect(darkAccent, `dark ${preset}`).toBeDefined();
    for (const surface of ['panel', 'bg'] as const) {
      expect(
        contrastRatio(lightAccent as string, light[surface] as string),
        `${preset}/${surface} (light)`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(darkAccent as string, dark[surface] as string),
        `${preset}/${surface} (dark)`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('body text and muted text stay AA on both themes', () => {
    for (const [name, palette] of [['light', light], ['dark', dark]] as const) {
      for (const surface of ['panel', 'bg'] as const) {
        expect(contrastRatio(palette['ink'] as string, palette[surface] as string), `${name} ink/${surface}`)
          .toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(palette['muted'] as string, palette[surface] as string), `${name} muted/${surface}`)
          .toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('appearance · config -> snapshot', () => {
  it('reads the three general keys and normalises them', () => {
    const values: Record<string, unknown> = { theme: 'dark', accent: '#00AA77', motion: 'reduced' };
    const settings = readAppearance((_domain, key) => values[key], {
      prefersDark: false, prefersReducedMotion: false, accent: '#ff8800',
    });
    expect(settings.theme).toBe('dark');
    expect(settings.accent).toEqual({ kind: 'hex', value: '#00aa77' });
    expect(settings.motion).toBe('reduced');
    expect(settings.systemAccent).toBe('#ff8800');
  });

  it('resolves a snapshot the UI can apply verbatim', () => {
    const snapshot = resolveAppearance(
      { theme: 'system', accent: { kind: 'system' }, motion: 'system', systemAccent: null },
      { prefersDark: true, prefersReducedMotion: true, accent: '#0f6b64' },
    );
    expect(snapshot).toEqual({
      theme: 'dark', themeMode: 'system', accent: '#0f6b64', accentKind: 'hex',
      motion: 'reduced', transitionMs: 0,
    });
  });
});
