/**
 * D-214 — update-only Electron / Chromium network transport.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The D-143 transport (`adapters/http-policy.ts`) resolves EVERY hop's
 * hostname with `dns.promises.lookup`, rejects any answer that is not a public
 * address and pins the socket to the verified answer. That is correct for
 * ordinary outbound traffic, but it makes the two UPDATE chains fail under a
 * system proxy / TUN / Fake-IP DNS: `api.github.com` resolves to a Fake-IP such
 * as 198.18.0.26, which is deliberately classified as non-public, so the
 * request is refused BEFORE a connection is even attempted
 * (`blocked resolved address at hop 0: 198.18.0.26 (api.github.com)`).
 *
 * A proxy does its own DNS resolution, and a TUN transparently routes the
 * connection. In both cases the address the app sees is not the address the
 * connection should be pinned to. Asking the updater to resolve and pin the
 * target is therefore the wrong connection model — not a rule to be relaxed.
 *
 * THE NEW SECURITY BOUNDARY (only for this update channel)
 * --------------------------------------------------------
 *   1. the initial URL AND every redirect hop must pass the caller's existing
 *      URL policy (`isTrustedReleaseHost` for GitHub, `mirrorHopPolicy` for an
 *      operator mirror); HTTP downgrade, loops and the 5-hop cap are refused;
 *   2. the connection is made by Electron's Chromium stack (`net.request`),
 *      which honours the OS proxy / PAC / WPAD / TUN routing without the app
 *      resolving the target itself;
 *   3. HTTPS certificate verification stays at Chromium's DEFAULT — no
 *      `rejectUnauthorized`, no `setCertificateVerifyProc`, no relaxed TLS;
 *   4. an explicit proxy is never silently bypassed: no `DIRECT` fallback,
 *      no automatic downgrade to a direct connection on proxy failure;
 *   5. proxy credentials live only in this module, are never written into
 *      `proxyRules`, headers, logs, error details or the renderer.
 *
 * This is a transport decision for the UPDATE CHANNEL ONLY. Thumbnails, URL
 * pre-checks and every other ordinary request still go through `node-ports.ts`
 * -> `fetchFollowingRedirects` with D-143 DNS pinning fully intact. Neither
 * `isPrivateIpv4()` nor `isPublicResolvedAddress()` is modified; 198.18.0.0/15
 * stays rejected everywhere else.
 *
 * INJECTION SEAM
 * --------------
 * `electron-entry.ts` owns the only `import { net, session } from 'electron'`
 * and injects them here as `UpdateNetworkSurface`. That keeps this adapter
 * importable by offline unit tests (no Electron binary in the test runner,
 * B1/D-39) while the production path still uses the real `net.request()`.
 *
 * SESSION ISOLATION
 * -----------------
 * Every distinct proxy configuration gets its OWN non-persistent, cache-less
 * session, created once and NEVER reconfigured afterwards. A request keeps a
 * reference to the session it started with, so an app-update download in
 * flight can never be re-routed by a component-update changing the proxy
 * config (or vice versa). `sessions` caches the creation PROMISE, so two
 * concurrent updates asking for the same config share one setup instead of
 * racing `setProxy()`.
 */
import { createHash } from 'node:crypto';
import type { HttpFetchOptions, HttpPort } from '@ytvdlt/shared';
import { MAX_HTTP_REDIRECTS, isPublicHttpsUrl } from './http-policy.js';
import {
  downloadToFile,
  type DownloadRequest, type DownloadResponseContext, type DownloadResult,
} from './http-download.js';

/* -------------------------------------------------------------------------- */
/* Injected Electron surface (structural, so offline fakes can implement it)   */
/* -------------------------------------------------------------------------- */

export interface UpdateProxySettings {
  readonly mode?: 'direct' | 'auto_detect' | 'pac_script' | 'fixed_servers' | 'system';
  readonly proxyRules?: string;
  readonly pacScript?: string;
  readonly proxyBypassRules?: string;
}

export interface UpdateSessionLike {
  setProxy(config: UpdateProxySettings): Promise<void>;
}

export interface UpdateAuthInfoLike {
  readonly isProxy: boolean;
  readonly host: string;
  readonly port: number;
  readonly scheme: string;
  readonly realm: string;
}

export interface UpdateIncomingMessageLike {
  readonly statusCode?: number;
  readonly headers: Record<string, string | string[] | undefined>;
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'aborted', listener: () => void): unknown;
  /** Present on the real Electron IncomingMessage; optional for test fakes. */
  pause?(): void;
  resume?(): void;
}

export interface UpdateRequestOptions {
  readonly method: string;
  readonly url: string;
  /** A real Electron `Session`; typed unknown so this module needs no import. */
  readonly session: unknown;
  readonly redirect: 'manual';
  readonly headers: Record<string, string>;
  readonly cache: 'no-store';
  readonly useSessionCookies: false;
  readonly bypassCustomProtocolHandlers: true;
}

export interface UpdateClientRequestLike {
  on(event: 'redirect', listener: (
    statusCode: number, method: string, redirectUrl: string,
    responseHeaders: Record<string, string[]>,
  ) => void): unknown;
  on(event: 'login', listener: (
    authInfo: UpdateAuthInfoLike,
    callback: (username?: string, password?: string) => void,
  ) => void): unknown;
  on(event: 'response', listener: (message: UpdateIncomingMessageLike) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  abort(): void;
  followRedirect(): void;
  end(): unknown;
}

export interface UpdateNetLike {
  request(options: UpdateRequestOptions): UpdateClientRequestLike;
}

export interface UpdateSessionStaticLike {
  fromPartition(partition: string, options: { cache: false }): UpdateSessionLike;
}

/** The exact two Electron modules `electron-entry.ts` injects. */
export interface UpdateNetworkSurface {
  readonly net: UpdateNetLike;
  readonly session: UpdateSessionStaticLike;
}

/* -------------------------------------------------------------------------- */
/* Proxy configuration — pure, never echoes secrets                            */
/* -------------------------------------------------------------------------- */

/** Thrown for an unusable `network.proxy`; the message NEVER contains its value. */
export class UpdateProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateProxyConfigError';
  }
}

export interface UpdateProxyCredentials {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
}

export interface UpdateProxyConfig {
  readonly mode: 'system' | 'fixed_servers';
  /** Chromium `proxyRules`, rebuilt from the parsed URL: NO userinfo inside. */
  readonly proxyRules: string;
  readonly credentials: UpdateProxyCredentials | null;
  /** Non-secret cache key (a credential hash, never the credential itself). */
  readonly key: string;
}

interface ProxySchemeMapping {
  readonly scheme: string;
  readonly defaultPort: number;
}

/**
 * `network.proxy` is the SAME string yt-dlp receives (`--proxy`). Both HTTP(S)
 * and SOCKS families are accepted. `socks5h` / `socks` map to Chromium's
 * `socks5`, `socks4a` to `socks4`. Proxy-side DNS resolution is the whole
 * point of the SOCKS path, so no hostname is resolved locally.
 *
 * CHROMIUM LIMITATION (D-266 · external online audit P2: SOCKS5 credentials
 * unsupported by Chromium):
 * Chromium's SOCKS client implements NO username/password authentication
 * (RFC 1929) — net/docs/proxy.md#socks-v5 — and a SOCKS endpoint never
 * triggers the HTTP 407 `login` event where `credentials` would be consumed
 * (see the `login` gate below, HTTP(S) fixed proxies only). A SOCKS URL
 * carrying userinfo would therefore connect WITHOUT the credentials and fail
 * opaquely (proxy-side rejection, no actionable message). `parseUpdateProxy`
 * refuses that combination fail-fast instead of stripping the userinfo and
 * pretending it works. yt-dlp's own `--proxy` path receives the raw string and
 * DOES support SOCKS credentials, so the download chain is unaffected.
 */
const PROXY_SCHEMES: Readonly<Record<string, ProxySchemeMapping>> = {
  'http:': { scheme: 'http', defaultPort: 80 },
  'https:': { scheme: 'https', defaultPort: 443 },
  'socks:': { scheme: 'socks5', defaultPort: 1080 },
  'socks5:': { scheme: 'socks5', defaultPort: 1080 },
  'socks5h:': { scheme: 'socks5', defaultPort: 1080 },
  'socks4:': { scheme: 'socks4', defaultPort: 1080 },
  'socks4a:': { scheme: 'socks4', defaultPort: 1080 },
};

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function decodeCredential(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

const INVALID_PROXY = 'network.proxy 配置非法：需要带协议的代理 URL（http / https / socks4 / socks5），且不得附带路径或查询参数';

/**
 * SOCKS + userinfo is refused, never echoed back: like `INVALID_PROXY`, this
 * message names the PROBLEM, not the configured value (no username/password,
 * no host). Same fail-fast contract as every other unusable `network.proxy`.
 */
const SOCKS_CREDENTIALS_UNSUPPORTED = 'network.proxy 配置非法：SOCKS 代理不支持用户名/密码认证（Chromium 限制），应用与组件更新无法使用该代理；下载不受影响；可改用无凭据 SOCKS 代理或 HTTP(S) 代理';

/**
 * Empty/unset -> `mode: 'system'` (OS proxy, PAC, WPAD and auto-detect all stay
 * available; an empty config is NEVER interpreted as force-DIRECT).
 * Non-empty -> `mode: 'fixed_servers'` with NO `DIRECT` fallback and NO
 * `proxyBypassRules`. A malformed value throws instead of degrading to direct.
 * A proxy endpoint may be 127.0.0.1 / localhost / RFC1918 — it is the
 * user-designated proxy endpoint, not the GitHub target, so no public-address
 * classification is applied to it.
 */
export function parseUpdateProxy(raw: string): UpdateProxyConfig {
  const value = raw.trim();
  if (value === '') {
    return { mode: 'system', proxyRules: '', credentials: null, key: 'system' };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new UpdateProxyConfigError(INVALID_PROXY);
  }
  const mapping = PROXY_SCHEMES[parsed.protocol];
  if (mapping === undefined || parsed.hostname === '') {
    throw new UpdateProxyConfigError(INVALID_PROXY);
  }
  // WHATWG parses http(s) with `pathname === '/'`, but NON-special schemes
  // (socks, socks4, socks5, socks5h) come back with `pathname === ''`. The old
  // check only accepted '/', so every SOCKS proxy written the normal way
  // (`socks5://127.0.0.1:7890`) was rejected as malformed. Both forms are the
  // same "no path" case; a real path / query / fragment is still refused (D-228).
  const hasPath = parsed.pathname !== '' && parsed.pathname !== '/';
  if (hasPath || parsed.search !== '' || parsed.hash !== '') {
    throw new UpdateProxyConfigError(INVALID_PROXY);
  }
  const port = parsed.port === '' ? mapping.defaultPort : Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new UpdateProxyConfigError(INVALID_PROXY);
  }
  const username = decodeCredential(parsed.username);
  const password = decodeCredential(parsed.password);
  const credentials: UpdateProxyCredentials | null = username === '' && password === ''
    ? null
    : { host: normalizeHost(parsed.hostname), port, username, password };
  // external online audit P2 · SOCKS5 credentials unsupported by Chromium:
  // every scheme mapped to socks4/socks5 above is refused when userinfo is
  // present. Stripping the userinfo and continuing would silently change what
  // the user asked for (authenticated -> unauthenticated) and fail opaquely at
  // connect time — there is no 407 `login` event for SOCKS to surface it. The
  // credential-less SOCKS path below stays valid; HTTP(S) credentials keep
  // flowing through the `login` gate.
  if (credentials !== null && (mapping.scheme === 'socks4' || mapping.scheme === 'socks5')) {
    throw new UpdateProxyConfigError(SOCKS_CREDENTIALS_UNSUPPORTED);
  }
  // Rebuilt from parts on purpose: userinfo can NEVER leak into proxyRules.
  const proxyRules = `${mapping.scheme}://${parsed.hostname}:${port}`;
  const key = credentials === null
    ? `fixed:${proxyRules}`
    : `fixed:${proxyRules}:${createHash('sha256')
      .update(`${username}\u0000${password}`, 'utf8').digest('hex').slice(0, 16)}`;
  return { mode: 'fixed_servers', proxyRules, credentials, key };
}

/* -------------------------------------------------------------------------- */
/* Redirect policy — pure, synchronous (Electron requires a SYNC decision)     */
/* -------------------------------------------------------------------------- */

export interface RedirectHopContext {
  readonly current: string;
  readonly location: string;
  readonly initialProtocol: string;
  readonly policy: (rawUrl: string) => boolean;
  readonly maxRedirects: number;
  /** Number of redirects already followed (0 = the first Location). */
  readonly hop: number;
  readonly visited: ReadonlySet<string>;
}

export type RedirectHopDecision =
  | { readonly ok: true; readonly next: string }
  | { readonly ok: false; readonly reason: string };

/** WHATWG normalisation of a Location header (absolute or relative). */
export function resolveRedirectTarget(current: string, location: string): string | null {
  if (location.trim() === '') return null;
  try { return new URL(location, current).toString(); } catch { return null; }
}

/**
 * Every check here is SYNCHRONOUS and pure. `followRedirect()` must be called
 * inside the `redirect` event handler, so there is deliberately NO await, NO
 * DNS lookup and no address pinning on this channel. The URL policy (GitHub
 * allowlist / same-host mirror rule) is the trust boundary.
 */
export function evaluateRedirectHop(ctx: RedirectHopContext): RedirectHopDecision {
  if (ctx.hop >= ctx.maxRedirects) return { ok: false, reason: 'too many redirects' };
  const next = resolveRedirectTarget(ctx.current, ctx.location);
  if (next === null) return { ok: false, reason: 'invalid redirect Location' };
  let target: URL;
  try {
    target = new URL(next);
  } catch {
    return { ok: false, reason: 'invalid redirect Location' };
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { ok: false, reason: 'unsupported redirect scheme' };
  }
  if (ctx.initialProtocol === 'https:' && target.protocol !== 'https:') {
    return { ok: false, reason: 'HTTPS downgrade refused' };
  }
  if (!ctx.policy(next)) return { ok: false, reason: 'URL policy rejected the redirect' };
  if (ctx.visited.has(next)) return { ok: false, reason: 'redirect loop detected' };
  return { ok: true, next };
}

/* -------------------------------------------------------------------------- */
/* Response adaptation — Electron IncomingMessage -> fetch-shaped Response     */
/* -------------------------------------------------------------------------- */

const NULL_BODY_STATUS = new Set([204, 205, 304]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * Electron's IncomingMessage is an EventEmitter, NOT a `node:stream.Readable`
 * instance, so `Readable.toWeb()` (used by the D-143 path) cannot be reused.
 * This builds a real WHATWG stream with backpressure and cancellation instead:
 * the installer (~220 MB) is still written to disk chunk by chunk by
 * `http-download.ts`, never buffered in the main process.
 */
function toFetchResponse(
  message: UpdateIncomingMessageLike,
  request: UpdateClientRequestLike,
  signal: AbortSignal,
): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, String(item));
    } else if (value !== undefined) {
      headers.append(key, String(value));
    }
  }
  const rawStatus = message.statusCode ?? 0;
  const status = rawStatus >= 200 && rawStatus <= 599 ? rawStatus : 502;
  if (NULL_BODY_STATUS.has(status)) return new Response(null, { status, headers });

  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let finished = false;
  let paused = false;
  let detachAbort: () => void = () => {};

  const finish = (error: Error | null): void => {
    if (finished) return;
    finished = true;
    detachAbort();
    if (error === null) {
      try { controllerRef?.close(); } catch { /* already closed */ }
    } else {
      try { controllerRef?.error(error); } catch { /* already closed */ }
      try { request.abort(); } catch { /* already closed */ }
    }
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      // Electron's IncomingMessage documents that `end` must be registered
      // BEFORE `data`; keep that order even though Node's Readable does not
      // require it.
      message.on('end', () => finish(null));
      message.on('error', (error: Error) => finish(error));
      message.on('aborted', () => finish(new Error('update response aborted')));
      message.on('data', (chunk: Uint8Array) => {
        if (finished) return;
        try {
          // Copy: the caller's hash/write happen after this tick.
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          return;
        }
        if ((controller.desiredSize ?? 1) <= 0 && message.pause !== undefined) {
          paused = true;
          try { message.pause(); } catch { /* fake without pause */ }
        }
      });
    },
    pull() {
      if (paused && message.resume !== undefined) {
        paused = false;
        try { message.resume(); } catch { /* fake without resume */ }
      }
    },
    cancel() {
      finished = true;
      detachAbort();
      try { request.abort(); } catch { /* already closed */ }
    },
  });

  // Cancellation must cover the FULL body, not just the response headers.
  const onAbort = (): void => { finish(new Error('The operation was aborted')); };
  signal.addEventListener('abort', onAbort, { once: true });
  detachAbort = () => signal.removeEventListener('abort', onAbort);
  if (signal.aborted) finish(new Error('The operation was aborted'));

  return new Response(body, { status, headers });
}

/* -------------------------------------------------------------------------- */
/* Request driver                                                             */
/* -------------------------------------------------------------------------- */

interface SessionEntry {
  readonly session: UpdateSessionLike;
  readonly credentials: UpdateProxyCredentials | null;
  /** `system` must NOT install a per-request `login` handler (see below). */
  readonly mode: 'system' | 'fixed_servers';
}

interface OpenElectronOptions {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly signal: AbortSignal;
  readonly policy: (rawUrl: string) => boolean;
  readonly maxRedirects: number;
  readonly entry: SessionEntry;
}

function openElectronResponse(
  surface: UpdateNetworkSurface,
  options: OpenElectronOptions,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    // Hop 0 is checked too: `net.request` does not know our allowlist.
    if (!options.policy(options.url)) {
      reject(new Error('blocked outbound update URL at hop 0: URL policy refused'));
      return;
    }
    if (options.signal.aborted) {
      reject(new Error('The operation was aborted'));
      return;
    }

    let initialProtocol = 'https:';
    try { initialProtocol = new URL(options.url).protocol; } catch { /* hop 0 above already refused */ }
    let current = options.url;
    const visited = new Set<string>([options.url]);
    let hop = 0;
    let settled = false;
    let request: UpdateClientRequestLike;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      try { request.abort(); } catch { /* already closed */ }
      reject(error);
    };

    try {
      request = surface.net.request({
        method: 'GET',
        url: options.url,
        session: options.entry.session,
        redirect: 'manual',
        headers: options.headers,
        cache: 'no-store',
        // No cookies / stored site data; non-persistent session with cache:false.
        useSessionCookies: false,
        bypassCustomProtocolHandlers: true,
      });
    } catch {
      // Never echo the URL or the proxy address into an error/log line.
      reject(new Error('update network request could not be created'));
      return;
    }

    const onAbort = (): void => {
      try { request.abort(); } catch { /* already closed */ }
      fail(new Error('The operation was aborted'));
    };
    options.signal.addEventListener('abort', onAbort, { once: true });

    request.on('redirect', (statusCode: number, _method: string, redirectUrl: string) => {
      if (settled) return;
      if (!REDIRECT_STATUS.has(statusCode)) {
        fail(new Error(`unexpected redirect status at hop ${hop}`));
        return;
      }
      const decision = evaluateRedirectHop({
        current,
        location: redirectUrl,
        initialProtocol,
        policy: options.policy,
        maxRedirects: options.maxRedirects,
        hop,
        visited,
      });
      if (!decision.ok) {
        fail(new Error(`blocked redirect at hop ${hop}: ${decision.reason}`));
        return;
      }
      hop += 1;
      visited.add(decision.next);
      current = decision.next;
      // Electron: MUST be called synchronously during the redirect event.
      try {
        request.followRedirect();
      } catch {
        fail(new Error('could not follow a validated redirect'));
      }
    });

    // A `login` listener MUST call its callback; empty credentials CANCEL the
    // request (Electron ClientRequest docs). In `system` mode we therefore do
    // not install one at all — OS/PAC proxy authentication is left to Electron
    // / Chromium's own system authentication capability, as required.
    // Only an explicit fixed_servers proxy installs the credential gate.
    if (options.entry.mode === 'fixed_servers') {
      request.on('login', (
        authInfo: UpdateAuthInfoLike,
        callback: (username?: string, password?: string) => void,
      ) => {
        const credentials = options.entry.credentials;
        // A plain server-side 401 must NEVER receive the proxy password, and an
        // unconfigured proxy gets no silent fallback: both are refused here.
        if (authInfo.isProxy !== true || credentials === null) {
          callback();
          return;
        }
        const sameHost = normalizeHost(authInfo.host) === credentials.host;
        const samePort = !(authInfo.port > 0) || authInfo.port === credentials.port;
        if (!sameHost || !samePort) {
          callback();
          return;
        }
        callback(credentials.username, credentials.password);
      });
    }

    request.on('response', (message: UpdateIncomingMessageLike) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener('abort', onAbort);
      try {
        resolve(toFetchResponse(message, request, options.signal));
      } catch {
        reject(new Error('update response could not be read'));
      }
    });

    request.on('error', () => {
      // A failed explicit proxy is reported as a failure; NEVER fall back to
      // DIRECT. No proxy address / credentials in the message or the log.
      fail(new Error('update network request failed (proxy or TLS error; no direct fallback)'));
    });

    request.end();
  });
}

/* -------------------------------------------------------------------------- */
/* Public factory                                                             */
/* -------------------------------------------------------------------------- */

export interface ElectronUpdateNetworkDeps {
  /** Injected by `electron-entry.ts`: real Electron `net` + `session`. */
  readonly surface: UpdateNetworkSurface;
  /**
   * LAZY read of `network.proxy` from the main-process ConfigStore. Called at
   * the start of every request so a settings change takes effect on the NEXT
   * request without re-routing one already in flight.
   */
  readonly readProxy: () => string;
}

export interface ElectronUpdateNetwork {
  /** Injected into BOTH updaters as their update-only `HttpPort`. */
  readonly httpPort: HttpPort;
  /** Injected into `downloadToFile` as its optional transport. */
  readonly openResponse: (context: DownloadResponseContext) => Promise<Response>;
  /** Injected into `createAppUpdateService` as `downloadInstaller`. */
  readonly downloadInstaller: (request: DownloadRequest) => Promise<DownloadResult>;
}

const DEFAULT_TEXT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_BINARY_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_TEXT_TIMEOUT_MS = 20_000;
const DEFAULT_BINARY_TIMEOUT_MS = 120_000;
/**
 * A caller without an explicit policy still cannot reach an arbitrary host:
 * cleartext and private/loopback literals are refused by default. All real
 * update callers pass their own, stricter policy (GitHub allowlist or the
 * operator mirror's same-host rule).
 */
const DEFAULT_URL_POLICY = isPublicHttpsUrl;

function partitionFor(key: string): string {
  return `ytvdlt-update-${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)}`;
}

export function createElectronUpdateNetwork(deps: ElectronUpdateNetworkDeps): ElectronUpdateNetwork {
  const { surface } = deps;
  /** key -> the ONE creation promise; a config never mutates an existing session. */
  const sessions = new Map<string, Promise<SessionEntry>>();

  const sessionFor = async (): Promise<SessionEntry> => {
    const config = parseUpdateProxy(deps.readProxy());
    let pending = sessions.get(config.key);
    if (pending === undefined) {
      pending = (async (): Promise<SessionEntry> => {
        const session = surface.session.fromPartition(partitionFor(config.key), { cache: false });
        // No `proxyBypassRules`, no `DIRECT`, no `pac_script`: an explicit
        // proxy is exclusive, while `system` keeps PAC/WPAD/auto-detect.
        const settings: UpdateProxySettings = config.mode === 'system'
          ? { mode: 'system' }
          : { mode: 'fixed_servers', proxyRules: config.proxyRules };
        await session.setProxy(settings);
        return { session, credentials: config.credentials, mode: config.mode };
      })();
      sessions.set(config.key, pending);
      // A failed setup must not poison every later request with a rejected
      // promise; the NEXT request is allowed to try again.
      void pending.catch(() => { sessions.delete(config.key); });
    }
    return pending;
  };

  const openResponse = async (context: DownloadResponseContext): Promise<Response> => {
    const entry = await sessionFor();
    return openElectronResponse(surface, {
      url: context.url,
      headers: context.headers,
      signal: context.signal,
      policy: context.urlPolicy,
      maxRedirects: context.maxRedirects,
      entry,
    });
  };

  const readBounded = async (
    url: string,
    opts: HttpFetchOptions | undefined,
    defaults: { readonly maxBytes: number; readonly timeoutMs: number },
  ): Promise<Uint8Array> => {
    const maxBytes = opts?.maxBytes ?? defaults.maxBytes;
    const controller = new AbortController();
    // ONE deadline covering proxy setup, response headers AND the last byte.
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? defaults.timeoutMs);
    try {
      const entry = await sessionFor();
      // `allowPrivateAddresses` is intentionally NOT forwarded: this channel
      // has no DNS pinning, so there is no address classification to disable.
      const response = await openElectronResponse(surface, {
        url,
        headers: { 'user-agent': 'YTVDLT' },
        signal: controller.signal,
        policy: opts?.urlPolicy ?? DEFAULT_URL_POLICY,
        maxRedirects: MAX_HTTP_REDIRECTS,
        entry,
      });
      if (!response.ok) {
        if (response.body !== null) await response.body.cancel().catch(() => undefined);
        throw new Error(`HTTP ${response.status} from update source`);
      }
      const declared = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > maxBytes) {
        if (response.body !== null) await response.body.cancel().catch(() => undefined);
        throw new Error(`response too large: ${declared} bytes`);
      }
      if (response.body === null) return new Uint8Array(0);

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value === undefined) continue;
          total += value.byteLength;
          if (total > maxBytes) {
            controller.abort();
            await reader.cancel().catch(() => undefined);
            throw new Error(`response exceeded ${maxBytes} bytes`);
          }
          chunks.push(value);
        }
      } finally {
        try { reader.releaseLock(); } catch { /* stream already closed */ }
      }
      controller.signal.throwIfAborted();
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
      return joined;
    } finally {
      clearTimeout(timer);
    }
  };

  const httpPort: HttpPort = {
    async getText(url: string, opts?: HttpFetchOptions): Promise<string> {
      const bytes = await readBounded(url, opts, {
        maxBytes: DEFAULT_TEXT_MAX_BYTES, timeoutMs: DEFAULT_TEXT_TIMEOUT_MS,
      });
      return new TextDecoder().decode(bytes);
    },
    async getBytes(url: string, opts?: HttpFetchOptions): Promise<Uint8Array> {
      return readBounded(url, opts, {
        maxBytes: DEFAULT_BINARY_MAX_BYTES, timeoutMs: DEFAULT_BINARY_TIMEOUT_MS,
      });
    },
  };

  /** Reuses the existing `.part` / hash / size / PE / cancellation pipeline. */
  const downloadInstaller = (request: DownloadRequest): Promise<DownloadResult> =>
    downloadToFile({ ...request, openResponse });

  return { httpPort, openResponse, downloadInstaller };
}
