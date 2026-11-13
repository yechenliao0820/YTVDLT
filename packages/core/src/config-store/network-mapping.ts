/**
 * D-165: `config.network.maxRate` → the yt-dlp `-r` token.
 *
 * Before this file the config carried `maxRate` and the plan read `rateLimit`:
 * two names for the same idea, never connected, so the setting was a lie —
 * it was stored, shown in `config.json`, and ignored by every download.
 *
 * Unit (now defined, was undocumented): **KB/s**. `0` (and anything that is not
 * a finite positive number) means "no limit", which is the behaviour every
 * build had until now, so the default is `0` rather than `1000`: turning an old
 * placeholder value into a real 1 MB/s ceiling on first launch would be a
 * silent slowdown for every existing user.
 */
export function toRateLimit(maxRate: unknown): string | null {
  const numeric = typeof maxRate === 'string' ? Number(maxRate.trim()) : maxRate;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return null;
  const kilobytes = Math.trunc(numeric);
  if (kilobytes <= 0) return null;
  return `${kilobytes}K`;
}
