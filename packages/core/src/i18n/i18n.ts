/**
 * i18n policy (M5-2) — locale normalisation, key registry, interpolation.
 *
 * The STRINGS live in `packages/ui/src/i18n/messages.js` (the UI is a static,
 * unbundled carrier, so a TS module cannot be imported there). This module owns
 * what must be true regardless of carrier:
 *   - which locales ship (`zh-CN`, `en`) and how a messy OS locale maps onto them;
 *   - which keys MUST exist, derived from the state machine and the notification
 *     kinds instead of a hand-maintained list (drift would otherwise be silent);
 *   - `{placeholder}` interpolation and a `missingKeys()` audit used by
 *     `tests/unit/i18n.test.ts` against the real shipped catalogue.
 */
import type { TaskState } from '@ytvdlt/shared';
import type { NotificationKind } from '../notifications/notification-center.js';
import { TASK_STATES } from '../task-queue/state-machine.js';
import { FAILURE_KINDS, type FailureKind } from '../failure-summary/failure-summary.js';

export const LOCALES = ['zh-CN', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'zh-CN';

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'progress', 'completed', 'error', 'canceled',
];

/** `en`, `en-US`, `EN_us` -> `en`; `zh*` -> `zh-CN`; unknown -> default. */
export function normalizeLocale(raw: unknown): Locale {
  if (typeof raw !== 'string') return DEFAULT_LOCALE;
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return DEFAULT_LOCALE;
  if (value === 'en' || value.startsWith('en-') || value.startsWith('en_')) return 'en';
  if (value === 'zh' || value.startsWith('zh-') || value.startsWith('zh_')) return 'zh-CN';
  return DEFAULT_LOCALE;
}

/** Human label for the language picker (never translated itself). */
export function localeLabel(locale: Locale): string {
  return locale === 'en' ? 'English' : '简体中文';
}

/** `task.state.Running` — same convention as core's `stateLabelKey()`. */
export function stateKey(state: TaskState): string {
  return `task.state.${state}`;
}

/** D-109: `queue.failure.<kind>` — the one-line brief under a failed card. */
export function failureKey(kind: FailureKind): string {
  return `queue.failure.${kind}`;
}

export function notificationKeys(kind: NotificationKind): { readonly titleKey: string; readonly bodyKey: string } {
  return { titleKey: `notification.${kind}.title`, bodyKey: `notification.${kind}.body` };
}

/** Queue tabs + empty/error states + shared actions (A-4.4-16 / A-4.4-21). */
export const UI_REQUIRED_KEYS: readonly string[] = [
  'app.name', 'common.confirm', 'common.cancel', 'common.retry', 'common.remove',
  'queue.title', 'queue.subtitle', 'queue.tab.all', 'queue.tab.downloading',
  'queue.tab.finished', 'queue.tab.canceled', 'queue.tab.count',
  'queue.search.placeholder', 'queue.url.placeholder', 'queue.url.label', 'queue.concurrency',
  'queue.empty.title', 'queue.empty.hint', 'queue.empty.cta',
  'queue.filter.empty.title', 'queue.filter.empty.hint',
  'queue.error.title', 'queue.error.hint', 'queue.error.retry',
  'queue.action.cancel', 'queue.action.retry', 'queue.action.open-folder',
  'queue.action.copy-url', 'queue.action.remove', 'queue.action.detail',
  'detail.title', 'log.title',
  'settings.title', 'settings.appearance', 'settings.theme', 'settings.accent',
  'settings.language', 'settings.motion', 'settings.accent.note', 'settings.autostart.note', 'common.check',
  'about.title', 'about.version',
];

/** Every key the app must ship in every locale. */
export function requiredKeys(): readonly string[] {
  const keys = new Set<string>(UI_REQUIRED_KEYS);
  for (const state of TASK_STATES) keys.add(stateKey(state));
  for (const kind of FAILURE_KINDS) keys.add(failureKey(kind));
  for (const kind of NOTIFICATION_KINDS) {
    const { titleKey, bodyKey } = notificationKeys(kind);
    keys.add(titleKey);
    keys.add(bodyKey);
  }
  return [...keys].sort();
}

/** Keys missing from one locale's catalogue (audit; never throws). */
export function missingKeys(available: Iterable<string>): readonly string[] {
  const present = new Set(available);
  return requiredKeys().filter((key) => !present.has(key));
}

/** `{n}` / `{taskId}` interpolation; unknown placeholders are left intact. */
export function interpolate(template: string, params?: Readonly<Record<string, string | number>>): string {
  if (params === undefined) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** Placeholder names used by a template, sorted (used to compare locales). */
export function placeholdersOf(template: string): readonly string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found].sort();
}

/** CLI / deep-link prefill is ASCII-only, so no locale can break the URL. */
export function isLocaleDependentValue(value: string): boolean {
  return /[^\u0000-\u007f]/.test(value);
}
