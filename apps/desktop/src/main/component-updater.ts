/**
 * ComponentUpdater — updates the bundled binaries WITHOUT shipping a new app
 * (M5-5 follow-up D-67; version check + per-component feed added in 0.2.1 D-94).
 *
 * Why this exists: `yt-dlp` is released weekly while the Electron shell changes
 * rarely. Forcing a full 220 MB installer for a 20 MB engine bump is wasteful,
 * and a stale engine is the single most common reason a downloader "stops
 * working" — so it gets its own check/update surface, separate from the app.
 *
 * What it does NOT do:
 *   - it never touches `ffmpeg/` or `node.exe`. Those are version-coupled with
 *     the app (the JS runtime must stay ABI-compatible with the bundle, ffmpeg
 *     is a shared-library set); swapping them outside a release is how you get
 *     "works on my machine" bugs.
 *   - it never deletes-then-installs. `SelfUpdater` writes `<file>.new`, renames
 *     over the target and keeps `.bak` until the post-swap hash matches, so a
 *     failed update leaves the previous binary runnable.
 *
 * The feed is a plain HTTPS directory holding `SHA2-256SUMS` + the binaries
 * themselves. Each component may carry its own feed (`feedUrl`), which is what
 * lets yt-dlp point at `github.com/yt-dlp/yt-dlp/releases/latest/download`
 * while aria2c still follows the operator-configured mirror.
 *
 * Every fetch this module makes (version query, checksum manifest, component
 * binary) carries the source-appropriate URL policy — see
 * `componentSourceUrlPolicy` below. This chain REPLACES the executable yt-dlp
 * runs, so it never fetches without a decided policy (the port's no-policy
 * default exists for generic local traffic, not for this path).
 */
import type {
  ComponentVersionCheck, ComponentVersionReport, CorePorts, HttpFetchOptions, QueueIntakeGate,
} from '@ytvdlt/shared';
import type { ILogger } from '@ytvdlt/core';
import { compareVersions } from '@ytvdlt/core';
import {
  HttpUpdateSource, SelfUpdater, normalizeToolVersion,
} from '@ytvdlt/engine-ytdlp';
import { isTrustedReleaseHost } from './github-releases.js';

export interface ComponentSpec {
  /** Stable id used by the UI (`yt-dlp`, `aria2c`). */
  readonly id: string;
  /** Display name. */
  readonly label: string;
  /** File name inside the feed and in the runtime directory. */
  readonly fileName: string;
  /** Absolute path of the installed copy. */
  readonly path: string;
  /**
   * Feed directory for THIS component. `null`/absent falls back to the global
   * `baseUrl`; both empty means "not updatable in this build".
   */
  readonly feedUrl?: string | null;
  /** `GET` endpoint returning the latest release JSON (GitHub API). */
  readonly versionApiUrl?: string | null;
}

export interface ComponentState {
  readonly id: string;
  readonly label: string;
  readonly fileName: string;
  readonly installed: boolean;
  readonly version: string;
  /** Latest published version, `null` until `check()` has run or when unknown. */
  readonly latestVersion: string | null;
  readonly updateAvailable: boolean;
  /** Effective feed directory; `null` = this component cannot self-update. */
  readonly feedUrl: string | null;
  /** Where the latest version comes from; `null` = check button stays disabled. */
  readonly versionApiUrl: string | null;
}

export interface ComponentUpdateReport {
  readonly id: string;
  readonly label: string;
  readonly changed: boolean;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly rolledBack: boolean;
  /** `null` = swapped or already current; otherwise a machine-readable failure. */
  readonly reason: string | null;
  /** Set only when the update threw (transport, disk, bug) — not for refusals. */
  readonly error: string | null;
}

export interface ComponentUpdateStatus {
  readonly components: readonly ComponentState[];
  /** `null` = no feed configured, so the button must stay disabled. */
  readonly source: string | null;
  readonly updating: boolean;
}

export interface ComponentUpdateResult {
  readonly ok: boolean;
  readonly source: string | null;
  readonly reason: string;
  readonly results: readonly ComponentUpdateReport[];
}

export interface ComponentUpdatePort {
  status(): Promise<ComponentUpdateStatus>;
  /** Network lookup of the latest published version; never downloads. */
  check(): Promise<ComponentVersionReport>;
  run(): Promise<ComponentUpdateResult>;
}

export interface ComponentUpdaterDeps {
  readonly ports: CorePorts;
  readonly logger: ILogger;
  readonly components: readonly ComponentSpec[];
  /** Fallback feed directory (HTTPS). `null` disables components without their own. */
  readonly baseUrl: string | null;
  readonly intakeGate: QueueIntakeGate | null;
  readonly channel?: 'stable' | 'nightly';
}

/** Re-exported so callers/tests have one spelling for version normalisation. */
export const normalizeVersion = normalizeToolVersion;

function isHttpUrl(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

/**
 * Per-hop URL policy for one fetch of the component update chain, chosen by
 * WHERE the source URL points. The renderer can set none of these URLs — they
 * come from the app-shipped component specs and the operator's
 * `advanced.componentFeedUrl` — so the URL is the trust decision:
 *
 * - GitHub-family hosts (the official yt-dlp feed `github.com/yt-dlp/…` and
 *   the `api.github.com` version API) share the app updater's trust root, so
 *   `isTrustedReleaseHost` is reused directly. The port turns that policy into
 *   per-hop URL checks PLUS public-only resolved-address validation with
 *   socket pinning (node-ports.ts `httpPort`).
 *
 * - Everything else is an operator-configured mirror. Before D-161 this path
 *   passed NO `urlPolicy` at all, because any caller policy made the port
 *   classify resolved addresses public-only and killed every intranet mirror.
 *   That left a supply-chain hole: a plain-HTTP mirror could have BOTH
 *   `SHA2-256SUMS` and the binary replaced in transit, and a same-feed hash
 *   cannot detect the simultaneous substitution. D-161 closes it in layers:
 *     ① feeds are HTTPS by default; plain HTTP needs an explicit deployment
 *       opt-in (`YTVDLT_ALLOW_HTTP_COMPONENT_FEED=1`, see
 *       `allowedComponentFeed`);
 *     ② every mirror hop must stay on the feed's OWN hostname and must not
 *       downgrade an HTTPS feed to HTTP (`mirrorHopPolicy`), so a mirror can
 *       no longer redirect the trust chain to an arbitrary third party;
 *     ③ `allowPrivateAddresses: true` keeps the port's address classification
 *       off for this one path, so loopback / RFC1918 mirrors still work while
 *       the URL policy, redirect cap, loop detection and socket pinning stay
 *       fully on.
 *
 * The split is a pure function of the URL, so there is no "sometimes checked,
 * sometimes not" state: the official feed can never fall onto the mirror path,
 * and a mirror living on the GitHub trust root simply gets the stricter rules.
 * NOTE: same-hostname is deliberately stricter than "any http(s) hop". A mirror
 * that needs to hand off to a DIFFERENT host must point the configured feed URL
 * at that final host instead; cross-host CDN chains are no longer implicitly
 * trusted. SHA-256 still protects against corruption, not first-party
 * authenticity — independent release signing remains a future item.
 */
export function componentSourceUrlPolicy(url: string): ((rawUrl: string) => boolean) | undefined {
  return isTrustedReleaseHost(url) ? isTrustedReleaseHost : undefined;
}

/**
 * D-161: per-hop rule for one operator mirror. A hop is legal only when it is
 * a valid http(s) URL on the SAME hostname as the configured feed (the port may
 * change — common for NAS mirrors) and, for an HTTPS feed, it is still HTTPS.
 * A malformed source rejects every hop. Pure and side-effect free so the
 * policy can be asserted without a network.
 */
export function mirrorHopPolicy(sourceUrl: string): (rawUrl: string) => boolean {
  let source: URL;
  try {
    source = new URL(sourceUrl);
  } catch {
    return () => false;
  }
  if (source.protocol !== 'https:' && source.protocol !== 'http:') return () => false;
  const host = source.hostname.toLowerCase();
  const noDowngrade = source.protocol === 'https:';
  return (rawUrl: string): boolean => {
    try {
      const hop = new URL(rawUrl);
      if (hop.protocol !== 'https:' && hop.protocol !== 'http:') return false;
      if (noDowngrade && hop.protocol !== 'https:') return false;
      return hop.hostname.toLowerCase() === host;
    } catch {
      return false;
    }
  };
}

/** D-161: the FULL fetch policy for one component feed (official or mirror). */
export function componentFetchPolicy(url: string): Pick<HttpFetchOptions, 'urlPolicy' | 'allowPrivateAddresses'> {
  const official = componentSourceUrlPolicy(url);
  if (official !== undefined) return { urlPolicy: official };
  return { urlPolicy: mirrorHopPolicy(url), allowPrivateAddresses: true };
}

/** `extra` merged under the source-appropriate policy (policy wins). */
function withSourcePolicy(url: string, extra: HttpFetchOptions = {}): HttpFetchOptions {
  return { ...extra, ...componentFetchPolicy(url) };
}

/**
 * D-161: HTTPS by default for an operator-configured component feed. Plain
 * HTTP is accepted ONLY when the deployment explicitly opts in (an intranet
 * NAS / LAN mirror with no TLS); that opt-in is the documented risk
 * confirmation. Any other scheme / empty value disables the feature.
 */
export function allowedComponentFeed(raw: string, allowInsecureHttp: boolean): string | null {
  const trimmed = raw.trim();
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  if (allowInsecureHttp && /^http:\/\//i.test(trimmed)) return trimmed;
  return null;
}

/** Latest tag from a GitHub release payload; `null` when unusable. */
export function latestVersionFromReleaseJson(text: string): string | null {
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    if (payload['draft'] === true || payload['prerelease'] === true) return null;
    const tag = typeof payload['tag_name'] === 'string' ? payload['tag_name'] : '';
    const name = typeof payload['name'] === 'string' ? payload['name'] : '';
    const raw = tag.trim() !== '' ? tag : name;
    if (raw.trim() === '') return null;
    const normalized = normalizeToolVersion(raw);
    return normalized === '' ? null : normalized;
  } catch {
    return null;
  }
}

export function createComponentUpdater(deps: ComponentUpdaterDeps): ComponentUpdatePort {
  const { ports, logger, components, baseUrl, intakeGate } = deps;
  let updating = false;
  /** Latest versions discovered by `check()`, by component id. */
  const latestKnown = new Map<string, string>();

  const installedVersion = async (path: string): Promise<string> => {
    try {
      const run = await ports.process.spawn(path, ['--version'], {
        shell: false, windowsHide: true, timeoutMs: 15_000,
      });
      return normalizeToolVersion(run.stdout ?? '');
    } catch {
      return '';
    }
  };

  const feedOf = (component: ComponentSpec): string | null => {
    if (isHttpUrl(component.feedUrl)) return component.feedUrl.trim();
    if (isHttpUrl(baseUrl)) return baseUrl.trim();
    return null;
  };

  const buildState = async (component: ComponentSpec): Promise<ComponentState> => {
    const installed = await ports.fs.exists(component.path);
    const version = installed ? await installedVersion(component.path) : '';
    const latestVersion = latestKnown.get(component.id) ?? null;
    return {
      id: component.id,
      label: component.label,
      fileName: component.fileName,
      installed,
      version,
      latestVersion,
      updateAvailable: installed && latestVersion !== null
        ? compareVersions(latestVersion, version) > 0
        : latestVersion !== null && version === '',
      feedUrl: feedOf(component),
      versionApiUrl: isHttpUrl(component.versionApiUrl) ? component.versionApiUrl.trim() : null,
    };
  };

  return {
    async status(): Promise<ComponentUpdateStatus> {
      const states: ComponentState[] = [];
      for (const component of components) states.push(await buildState(component));
      const effective = baseUrl ?? states.find((item) => item.feedUrl !== null)?.feedUrl ?? null;
      return { components: states, source: effective, updating };
    },

    async check(): Promise<ComponentVersionReport> {
      const results: ComponentVersionCheck[] = [];
      const http = ports.http;
      for (const component of components) {
        const installed = await installedVersion(component.path);
        const apiUrl = isHttpUrl(component.versionApiUrl) ? component.versionApiUrl.trim() : '';
        if (http === undefined || apiUrl === '') {
          results.push({
            id: component.id,
            label: component.label,
            installedVersion: installed,
            latestVersion: null,
            updateAvailable: false,
            error: http === undefined ? '当前构建不支持网络请求' : '未配置版本查询地址',
          });
          continue;
        }
        try {
          // Component-update hardening: the version query carries the source's
          // URL policy (official GitHub API → strict allowlist), so a redirect
          // cannot walk the release JSON off the trusted hosts.
          const text = await http.getText(apiUrl, withSourcePolicy(apiUrl, { timeoutMs: 15_000 }));
          const latestVersion = latestVersionFromReleaseJson(text);
          if (latestVersion === null) {
            results.push({
              id: component.id,
              label: component.label,
              installedVersion: installed,
              latestVersion: null,
              updateAvailable: false,
              error: '未能解析最新版本',
            });
            continue;
          }
          latestKnown.set(component.id, latestVersion);
          results.push({
            id: component.id,
            label: component.label,
            installedVersion: installed,
            latestVersion,
            updateAvailable: compareVersions(latestVersion, installed) > 0,
            error: null,
          });
        } catch (error) {
          await logger.warn('component-check', 'version lookup failed', {
            component: component.id,
            detail: error instanceof Error ? error.message : String(error),
          });
          results.push({
            id: component.id,
            label: component.label,
            installedVersion: installed,
            latestVersion: null,
            updateAvailable: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { checkedAt: ports.clock.nowIso(), results };
    },

    async run(): Promise<ComponentUpdateResult> {
      const usable = components.filter((component) => feedOf(component) !== null);
      if (usable.length === 0) {
        return { ok: false, source: null, reason: '未配置组件更新源', results: [] };
      }
      if (updating) {
        return { ok: false, source: baseUrl, reason: '更新正在进行中', results: [] };
      }
      const http = ports.http;
      if (http === undefined) {
        return { ok: false, source: baseUrl, reason: '当前构建不支持网络更新', results: [] };
      }

      updating = true;
      const results: ComponentUpdateReport[] = [];
      try {
        for (const component of usable) {
          const feed = feedOf(component) as string;
          // D-161: an explicitly opted-in cleartext mirror must leave a trace.
          if (/^http:\/\//i.test(feed)) {
            await logger.warn('component-update', 'insecure HTTP mirror in use', {
              component: component.id,
            });
          }
          // D-161: manifest + binary carry the SAME full source policy as the
          // version query — GitHub allowlist for official feeds, same-host /
          // no-downgrade + intranet-address allowance for operator mirrors.
          // Both files come from this one feed, so neither may be fetched under
          // a looser rule than the other (see the D-161 rationale above).
          const source = new HttpUpdateSource({
            baseUrl: feed, fileName: component.fileName, http,
            ...componentFetchPolicy(feed),
          });
          const updater = new SelfUpdater({
            ports,
            logger,
            source,
            intakeGate,
            enginePath: component.path,
            channel: deps.channel ?? 'stable',
            componentFileName: component.fileName,
            componentLabel: component.label,
          });
          try {
            const result = await updater.update();
            results.push({
              id: component.id,
              label: component.label,
              changed: result.changed,
              fromVersion: result.fromVersion,
              toVersion: result.toVersion,
              rolledBack: result.rolledBack === true,
              reason: result.reason ?? null,
              error: null,
            });
          } catch (error) {
            // One component failing must not stop the next one.
            results.push({
              id: component.id,
              label: component.label,
              changed: false,
              fromVersion: '',
              toVersion: '',
              rolledBack: false,
              reason: null,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } finally {
        updating = false;
      }

      // A fresh version means the cached "latest" may now be the installed one.
      for (const item of results) {
        if (item.changed && item.toVersion !== '') latestKnown.set(item.id, item.toVersion);
      }

      const failed = results.filter((item) => item.error !== null
        || (item.reason !== null && item.reason !== 'up-to-date'));
      return {
        ok: failed.length === 0,
        source: baseUrl,
        reason: failed.length === 0 ? 'ok' : `${failed.length}/${results.length} 个组件未能更新`,
        results,
      };
    },
  };
}
