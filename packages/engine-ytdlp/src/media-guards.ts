/**
 * Pure type guards for defensive JSON mapping (F041).
 * No I/O, no `node:*` imports. `JsonMapper` never throws on malformed input.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function strOr(value: unknown, fallback: string): string {
  const candidate = strOrNull(value);
  return candidate ?? fallback;
}

export function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** First non-null string among the candidate keys (ordered fallback chain). */
export function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const candidate = strOrNull(record[key]);
    if (candidate !== null) return candidate;
  }
  return null;
}
