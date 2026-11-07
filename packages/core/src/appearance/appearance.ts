/**
 * Appearance policy (M5-1) — Light / Dark / System, accent, motion.
 *
 * Pure decision layer on purpose (D-54): the palette itself lives in
 * `packages/ui/src/styles/{ytvdlt,theme}.css`, and `theme.js` only flips
 * attributes on `<html>`. This module owns everything that is testable without
 * a DOM: normalisation of user input, resolution against the OS preference,
 * accent precedence (user > OS > default), WCAG contrast maths, and the
 * reduced-motion policy.
 *
 * `A-4.4-20` (三态 + 强调色) and `A-4.6-06` (动态取色 / 触觉省略 / 转场动效)
 * are discharged here; the screenshot evidence lives in the e2e suite.
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export type MotionMode = 'system' | 'reduced' | 'full';
export type ResolvedMotion = 'reduced' | 'full';

export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'] as const;
export const MOTION_MODES: readonly MotionMode[] = ['system', 'reduced', 'full'] as const;

/** Accent presets shipped in `theme.css`; `blue` reproduces the M3 palette. */
export const ACCENT_PRESETS = ['blue', 'teal', 'violet', 'amber', 'rose'] as const;
export type AccentPreset = (typeof ACCENT_PRESETS)[number];
export const DEFAULT_ACCENT: AccentPreset = 'blue';

export type AccentChoice =
  | { readonly kind: 'preset'; readonly value: AccentPreset }
  | { readonly kind: 'hex'; readonly value: string }
  | { readonly kind: 'system' };

export interface AppearanceSettings {
  readonly theme: ThemeMode;
  readonly accent: AccentChoice;
  readonly motion: MotionMode;
  /** Accent reported by the OS (Windows registry / macOS defaults). */
  readonly systemAccent: string | null;
}

export interface SystemAppearance {
  readonly prefersDark: boolean;
  readonly prefersReducedMotion: boolean;
  readonly accent: string | null;
}

const HEX_RE = /^#?([0-9a-f]{6})$/i;

/** Unknown / corrupt values degrade to `system` — never throw on user input. */
export function normalizeThemeMode(raw: unknown): ThemeMode {
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
}

export function normalizeMotionMode(raw: unknown): MotionMode {
  return raw === 'reduced' || raw === 'full' || raw === 'system' ? raw : 'system';
}

/** `#RRGGBB` / `RRGGBB` / `#RGB` -> `#rrggbb`; anything else -> null. */
export function normalizeHexColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const long = HEX_RE.exec(trimmed);
  if (long !== null) return `#${long[1]?.toLowerCase() ?? ''}`;
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(trimmed);
  if (short === null) return null;
  const [, r, g, b] = short;
  return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
}

/** Parse a stored accent (`general.accent`) into a choice. */
export function parseAccent(raw: unknown): AccentChoice {
  if (typeof raw === 'string' && raw.trim() === 'system') return { kind: 'system' };
  const hex = normalizeHexColor(raw);
  if (hex !== null) return { kind: 'hex', value: hex };
  if (typeof raw === 'string' && (ACCENT_PRESETS as readonly string[]).includes(raw)) {
    return { kind: 'preset', value: raw as AccentPreset };
  }
  return { kind: 'preset', value: DEFAULT_ACCENT };
}

/** `system` follows the OS; an explicit mode always wins. */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode;
}

export function resolveMotion(mode: MotionMode, prefersReducedMotion: boolean): ResolvedMotion {
  if (mode === 'system') return prefersReducedMotion ? 'reduced' : 'full';
  return mode;
}

/**
 * Accent precedence: user hex > OS accent (when the choice is `system`) > preset.
 * This is A-4.6-06's "动态取色改为跟随系统强调色".
 */
export function effectiveAccent(
  choice: AccentChoice,
  systemAccent: string | null,
): { readonly kind: 'preset'; readonly value: AccentPreset } | { readonly kind: 'hex'; readonly value: string } {
  if (choice.kind === 'hex') return { kind: 'hex', value: choice.value };
  if (choice.kind === 'system' && systemAccent !== null) {
    const normalized = normalizeHexColor(systemAccent);
    if (normalized !== null) return { kind: 'hex', value: normalized };
  }
  if (choice.kind === 'system') return { kind: 'preset', value: DEFAULT_ACCENT };
  return { kind: 'preset', value: choice.value };
}

/** `#rrggbb` -> [0..1, 0..1, 0..1] sRGB channels. */
export function hexToRgb(hex: string): readonly [number, number, number] {
  const normalized = normalizeHexColor(hex);
  if (normalized === null) throw new Error(`invalid hex colour: ${String(hex)}`);
  return [
    parseInt(normalized.slice(1, 3), 16) / 255,
    parseInt(normalized.slice(3, 5), 16) / 255,
    parseInt(normalized.slice(5, 7), 16) / 255,
  ];
}

/** WCAG 2.1 relative luminance. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio in [1, 21]; order-independent. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** AA for normal text is 4.5:1; large text / UI borders are allowed 3:1. */
export function meetsContrast(fg: string, bg: string, minimum = 4.5): boolean {
  return contrastRatio(fg, bg) >= minimum;
}

/** Transition duration honouring "reduce motion" (0 = instant). */
export function transitionMs(resolved: ResolvedMotion, fullMs = 180): number {
  return resolved === 'reduced' ? 0 : Math.max(0, Math.round(fullMs));
}

/**
 * Desktop has no haptic hardware: the Android feature is explicitly omitted
 * rather than silently missing (A-4.6-06). Recorded so the About box and the
 * acceptance report can quote the same sentence.
 */
export function hapticsCapability(): { readonly supported: false; readonly reason: string } {
  return {
    supported: false,
    reason: '桌面端无等价触觉硬件，按 PRD §2 默认假设 6 明确省略',
  };
}

/** Build settings from a config getter + the OS probe (production + tests). */
export function readAppearance(
  get: (domain: 'general', key: string) => unknown,
  system: SystemAppearance,
): AppearanceSettings {
  return {
    theme: normalizeThemeMode(get('general', 'theme')),
    accent: parseAccent(get('general', 'accent')),
    motion: normalizeMotionMode(get('general', 'motion')),
    systemAccent: system.accent === null ? null : normalizeHexColor(system.accent),
  };
}

/** One resolved snapshot the UI can apply verbatim (attributes + tokens). */
export interface AppearanceSnapshot {
  readonly theme: ResolvedTheme;
  readonly themeMode: ThemeMode;
  readonly accent: string;
  readonly accentKind: 'preset' | 'hex';
  readonly motion: ResolvedMotion;
  readonly transitionMs: number;
}

export function resolveAppearance(
  settings: AppearanceSettings,
  system: SystemAppearance,
): AppearanceSnapshot {
  const theme = resolveTheme(settings.theme, system.prefersDark);
  const motion = resolveMotion(settings.motion, system.prefersReducedMotion);
  const accent = effectiveAccent(settings.accent, settings.systemAccent ?? system.accent);
  return {
    theme,
    themeMode: settings.theme,
    accent: accent.value,
    accentKind: accent.kind,
    motion,
    transitionMs: transitionMs(motion),
  };
}
