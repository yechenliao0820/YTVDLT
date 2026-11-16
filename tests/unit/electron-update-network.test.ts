/**
 * D-228 · `electron-update-network.ts` 专属离线单测（D-214 遗留缺口的补齐）。
 *
 * 只测这一层自己的职责，不假装替代真机代理验收：
 *   1. `parseUpdateProxy` —— 代理 URL 解析、scheme 映射、凭据绝不出现在 proxyRules。
 *   2. 重定向守卫 —— 跳数上限、HTTPS 降级、策略拒绝、环路、非法 Location（全同步纯函数）。
 *   3. Session 生命周期 —— 一配置一 Session、缓存创建 Promise、失败不毒化后续请求。
 *   4. 请求驱动 —— hop 0 策略门、login 只在固定代理模式安装且只答匹配的代理、体积上限。
 *
 * 真正的系统代理 / PAC / WPAD / TUN / Fake-IP / 407 握手仍必须在真机验收，
 * 本文件不产生那方面的结论（见手册 §10 与 D-214「未覆盖」）。
 */
import { describe, it, expect } from 'vitest';
import {
  parseUpdateProxy,
  UpdateProxyConfigError,
  resolveRedirectTarget,
  evaluateRedirectHop,
  createElectronUpdateNetwork,
} from '../../apps/desktop/src/main/adapters/electron-update-network.js';
import type {
  UpdateClientRequestLike,
  UpdateIncomingMessageLike,
  UpdateNetLike,
  UpdateRequestOptions,
  UpdateSessionLike,
  UpdateNetworkSurface,
} from '../../apps/desktop/src/main/adapters/electron-update-network.js';

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

type Listener = (...args: never[]) => void;

interface FakeRequest {
  req: UpdateClientRequestLike;
  /** How many times each control method was called. */
  calls: { abort: number; followRedirect: number; end: number };
  emit(event: 'redirect' | 'login' | 'response' | 'error', ...args: unknown[]): void;
  listenerCount(event: 'redirect' | 'login' | 'response' | 'error'): number;
}

function createFakeRequest(): FakeRequest {
  const listeners = new Map<string, Listener[]>();
  const calls = { abort: 0, followRedirect: 0, end: 0 };
  const req = {
    on(event: string, fn: Listener): UpdateClientRequestLike {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return req;
    },
    abort(): void { calls.abort += 1; },
    followRedirect(): void { calls.followRedirect += 1; },
    end(): unknown { calls.end += 1; return req; },
  } as unknown as UpdateClientRequestLike;
  return {
    req,
    calls,
    emit(event, ...args) {
      for (const fn of listeners.get(event) ?? []) (fn as (...a: unknown[]) => void)(...args);
    },
    listenerCount(event) { return (listeners.get(event) ?? []).length; },
  };
}

/**
 * IncomingMessage fake. Electron requires `end` before `data`, so the payload
 * is released on a microtask once the `data` listener is attached (by then
 * `toFetchResponse` has registered every listener inside `ReadableStream.start`).
 */
function createFakeMessage(
  statusCode: number,
  headers: Record<string, string>,
  chunks: Uint8Array[],
): UpdateIncomingMessageLike {
  const listeners = new Map<string, Array<(...args: never[]) => void>>();
  const emit = (event: string, ...args: unknown[]): void => {
    for (const fn of listeners.get(event) ?? []) (fn as (...a: unknown[]) => void)(...args);
  };
  const message: UpdateIncomingMessageLike = {
    statusCode,
    headers,
    on(event: string, fn: (...args: never[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      if (event === 'data') {
        queueMicrotask(() => {
          for (const chunk of chunks) emit('data', chunk);
          emit('end');
        });
      }
      return message;
    },
  };
  return message;
}

/**
 * Each `net.request` gets its OWN fake request: a shared instance would let a
 * later response settle an earlier promise and make the ordering assertions
 * meaningless.
 */
interface Harness {
  surface: UpdateNetworkSurface;
  /** Lazy `network.proxy` reader, exactly the shape the factory expects. */
  readProxy: () => string;
  requests: UpdateRequestOptions[];
  partitions: string[];
  proxies: Array<Record<string, unknown>>;
  fakes: FakeRequest[];
  /** The fake for the most recent `net.request` call. */
  latest(): FakeRequest;
}

function createHarness(options: {
  readonly proxy: () => string;
  readonly setProxyImpl?: (config: Record<string, unknown>) => Promise<void>;
}): Harness {
  const requests: UpdateRequestOptions[] = [];
  const partitions: string[] = [];
  const proxies: Array<Record<string, unknown>> = [];
  const fakes: FakeRequest[] = [];
  const net: UpdateNetLike = {
    request(requestOptions: UpdateRequestOptions) {
      requests.push(requestOptions);
      const fake = createFakeRequest();
      fakes.push(fake);
      return fake.req;
    },
  };
  const surface: UpdateNetworkSurface = {
    net,
    session: {
      fromPartition(partition: string, partitionOptions: { cache: false }) {
        partitions.push(partition);
        expect(partitionOptions).toEqual({ cache: false });
        const session: UpdateSessionLike = {
          setProxy: async (config) => {
            proxies.push(config as Record<string, unknown>);
            if (options.setProxyImpl !== undefined) await options.setProxyImpl(config as Record<string, unknown>);
          },
        };
        return session;
      },
    },
  };
  return {
    surface,
    readProxy: options.proxy,
    requests,
    partitions,
    proxies,
    fakes,
    latest() {
      const fake = fakes[fakes.length - 1];
      if (fake === undefined) throw new Error('no request created yet');
      return fake;
    },
  };
}

const ALLOW_ALL = (): boolean => true;

/** Let `sessionFor()` (async proxy setup) and `net.request` wiring settle. */
const wire = async (): Promise<void> => new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0); });

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/* -------------------------------------------------------------------------- */
/* 1. 代理 URL 解析                                                            */
/* -------------------------------------------------------------------------- */

describe('D-214 · parseUpdateProxy', () => {
  it('empty config means system proxy, never force-DIRECT', () => {
    for (const raw of ['', '   ', '\t\n']) {
      const config = parseUpdateProxy(raw);
      expect(config.mode).toBe('system');
      expect(config.proxyRules).toBe('');
      expect(config.credentials).toBeNull();
      expect(config.key).toBe('system');
    }
  });

  it('maps every accepted scheme to Chromium proxyRules with its default port', () => {
    const cases: Array<[string, string]> = [
      ['http://proxy.local', 'http://proxy.local:80'],
      ['https://proxy.local', 'https://proxy.local:443'],
      ['socks://proxy.local', 'socks5://proxy.local:1080'],
      ['socks5://proxy.local', 'socks5://proxy.local:1080'],
      ['socks5h://proxy.local', 'socks5://proxy.local:1080'],
      ['socks4://proxy.local', 'socks4://proxy.local:1080'],
      ['socks4a://proxy.local', 'socks4://proxy.local:1080'],
      ['http://127.0.0.1:7890', 'http://127.0.0.1:7890'],
      // D-228 regression: the trailing slash is optional for socks too.
      ['socks5://proxy.local:1080/', 'socks5://proxy.local:1080'],
    ];
    for (const [raw, expected] of cases) {
      const config = parseUpdateProxy(raw);
      expect(config.mode).toBe('fixed_servers');
      expect(config.proxyRules).toBe(expected);
    }
  });

  it('keeps credentials OUT of proxyRules, the key and the partition name', () => {
    const config = parseUpdateProxy('socks5://leouser:sup3r%40secret@127.0.0.1:7891');
    expect(config.proxyRules).toBe('socks5://127.0.0.1:7891');
    expect(config.proxyRules).not.toContain('leouser');
    expect(config.proxyRules).not.toContain('secret');
    expect(config.key).not.toContain('leouser');
    expect(config.key).not.toContain('sup3r');
    // Percent-decoding happens for the handshake, not for the rules string.
    expect(config.credentials).toEqual({
      host: '127.0.0.1', port: 7891, username: 'leouser', password: 'sup3r@secret',
    });
  });

  it('different credentials produce different cache keys; same config is stable', () => {
    const a = parseUpdateProxy('http://u1:p1@proxy.local:8080');
    const b = parseUpdateProxy('http://u1:p2@proxy.local:8080');
    const aAgain = parseUpdateProxy('http://u1:p1@proxy.local:8080');
    expect(a.key).not.toBe(b.key);
    expect(a.key).toBe(aAgain.key);
  });

  it('refuses anything that is not a bare proxy URL (no silent DIRECT fallback)', () => {
    const invalid = [
      'proxy.local:8080',              // no scheme
      'ftp://proxy.local:21',          // unsupported scheme
      'http://proxy.local:8080/path',  // path
      'http://proxy.local:8080?a=1',   // query
      'http://proxy.local:8080#frag',  // fragment
      'http://',                       // no host
      'http://proxy.local:99999',      // port out of range
    ];
    for (const raw of invalid) {
      expect(() => parseUpdateProxy(raw), raw).toThrow(UpdateProxyConfigError);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2. 重定向守卫（同步纯函数）                                                  */
/* -------------------------------------------------------------------------- */

describe('D-214 · redirect guards', () => {
  it('resolves absolute and relative Location values', () => {
    expect(resolveRedirectTarget('https://a.test/x/y', '../z')).toBe('https://a.test/z');
    expect(resolveRedirectTarget('https://a.test/x', 'https://b.test/q')).toBe('https://b.test/q');
    expect(resolveRedirectTarget('https://a.test/x', '   ')).toBeNull();
  });

  const base = {
    current: 'https://github.com/releases/1',
    initialProtocol: 'https:',
    policy: ALLOW_ALL,
    maxRedirects: 5,
    hop: 0,
    visited: new Set<string>(['https://github.com/releases/1']),
  };

  it('accepts a same-scheme hop that passes the policy', () => {
    const decision = evaluateRedirectHop({ ...base, location: 'https://objects.gh.test/a' });
    expect(decision).toEqual({ ok: true, next: 'https://objects.gh.test/a' });
  });

  it('refuses HTTPS → HTTP downgrade', () => {
    const decision = evaluateRedirectHop({ ...base, location: 'http://objects.gh.test/a' });
    expect(decision.ok).toBe(false);
    if (decision.ok === false) expect(decision.reason).toContain('downgrade');
  });

  it('refuses a target the caller policy rejects', () => {
    const decision = evaluateRedirectHop({
      ...base, location: 'https://evil.test/a', policy: (url) => url.includes('github.com'),
    });
    expect(decision.ok).toBe(false);
    if (decision.ok === false) expect(decision.reason).toContain('policy');
  });

  it('refuses loops, non-http schemes and exhausted hop budgets', () => {
    expect(evaluateRedirectHop({ ...base, location: 'https://github.com/releases/1' }).ok).toBe(false);
    expect(evaluateRedirectHop({ ...base, location: 'file:///etc/passwd' }).ok).toBe(false);
    expect(evaluateRedirectHop({ ...base, hop: 5, location: 'https://github.com/next' }).ok).toBe(false);
    expect(evaluateRedirectHop({ ...base, location: '' }).ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Session 生命周期                                                          */
/* -------------------------------------------------------------------------- */

describe('D-214 · session lifecycle', () => {
  it('system proxy: one partition, mode system, reused across requests', async () => {
    const harness = createHarness({ proxy: () => '' });
    const network = createElectronUpdateNetwork({ surface: harness.surface, readProxy: harness.readProxy });

    const first = network.httpPort.getText('https://api.github.test/x', { urlPolicy: ALLOW_ALL, timeoutMs: 3000 });
    await wire();
    harness.latest().emit('response', createFakeMessage(200, {}, [text('ok')]));
    await expect(first).resolves.toBe('ok');

    const second = network.httpPort.getText('https://api.github.test/y', { urlPolicy: ALLOW_ALL, timeoutMs: 3000 });
    await wire();
    harness.latest().emit('response', createFakeMessage(200, {}, [text('ok2')]));
    await expect(second).resolves.toBe('ok2');

    expect(harness.partitions).toHaveLength(1);
    expect(harness.partitions[0]).toMatch(/^ytvdlt-update-.{16}$/);
    expect(harness.proxies).toEqual([{ mode: 'system' }]);
  });

  it('fixed proxy: rules carry no userinfo, partition name carries no username', async () => {
    const harness = createHarness({ proxy: () => 'http://alice:hunter2@proxy.local:8080' });
    const network = createElectronUpdateNetwork({ surface: harness.surface, readProxy: harness.readProxy });

    const pending = network.httpPort.getText('https://api.github.test/x', { urlPolicy: ALLOW_ALL, timeoutMs: 3000 });
    await wire();
    harness.latest().emit('response', createFakeMessage(200, {}, [text('x')]));
    await pending;

    expect(harness.proxies).toEqual([{ mode: 'fixed_servers', proxyRules: 'http://proxy.local:8080' }]);
    expect(harness.partitions[0]).toMatch(/^ytvdlt-update-.{16}$/);
    expect(harness.partitions[0]).not.toContain('alice');
    expect(harness.partitions[0]).not.toContain('hunter2');
  });

  it('a changed proxy config gets its own session; the old one is never reconfigured', async () => {
    let raw = 'http://proxy-a.local:8080';
    const harness = createHarness({ proxy: () => raw });
    const network = createElectronUpdateNetwork({ surface: harness.surface, readProxy: harness.readProxy });

    const first = network.httpPort.getText('https://api.github.test/x', { urlPolicy: ALLOW_ALL, timeoutMs: 3000 });
    await wire();
    harness.latest().emit('response', createFakeMessage(200, {}, [text('1')]));
    await first;

    raw = 'http://proxy-b.local:8080';
    const second = network.httpPort.getText('https://api.github.test/x', { urlPolicy: ALLOW_ALL, timeoutMs: 3000 });
    await wire();
    harness.latest().emit('response', createFakeMessage(200, {}, [text('2')]));
    await second;

    expect(harness.partitions).toHaveLength(2);
    expect(harness.proxies).toEqual([
      { mode: 'fixed_servers', proxyRules: 'http://proxy-a.local:8080' },
      { mode: 'fixed_servers', proxyRules: 'http://proxy-b.local:8080' },
    ]);
  });

  it('a failed session setup is retried, not cached as a rejected promise', async () => {
    let attempts = 0;
    const harness = createHarness({
      proxy: () => 'http://proxy.local:8080',
      setProxyImpl: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('proxy setup failed');
      },
    });
    const network = createElectronUpdateNetwork({ surface: harness.surface, readProxy: harness.readProxy });

    await expect(network.httpPort.getText('https://api.github.test/x', { urlPolicy: ALLOW_ALL, timeoutMs: 3000 }))
      .rejects.toThrow('proxy setup failed');
    await wire(); // let the cache-eviction handler run

    const retried = network.httpPort.getText('https://api.github.test/x', { urlPolicy: ALLOW_ALL, timeoutMs: 3000 });
    await wire();
    harness.latest().emit('response', createFakeMessage(200, {}, [text('ok')]));
    await expect(retried).resolves.toBe('ok');
    expect(attempts).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. 请求驱动                                                                  */
/* -------------------------------------------------------------------------- */

describe('D-214 · request driver', () => {
  it('refuses hop 0 BEFORE any request exists (policy is the trust boundary)', async () => {
    const harness = createHarness({ proxy: () => '' });
    const network = createElectronUpdateNetwork({ surface: harness.surface, readProxy: harness.readProxy });

    await expect(network.httpPort.getText('https://evil.test/x', {
      timeoutMs: 3000, urlPolicy: () => false,
    })).rejects.toThrow(/hop 0/);
    expect(harness.requests).toHaveLength(0);
  });

  it('installs a login handler ONLY for an explicit fixed proxy, and answers only the matching proxy', async () => {
    const harness = createHarness({ proxy: () => 'http://alice:hunter2@proxy.local:8080' });
    const network = createElectronUpdateNetwork({ surface: harness.surface, readProxy: harness.readProxy });
    const pending = network.httpPort.getText('https://api.github.test/x', { urlPolicy: ALLOW_ALL, timeoutMs: 3000 });
    await wire();
    const fake = harness.latest();

    expect(fake.listenerCount('login')).toBe(1);
    const answers: Array<{ user?: string; pass?: string }> = [];
    const record = (user?: string, pass?: string): void => { answers.push({ user, pass }); };
    // The real proxy endpoint gets the credential…
    fake.emit('login', { isProxy: true, host: 'proxy.local', port: 8080, scheme: 'basic', realm: 'proxy' }, record);
    // …a server-side 401 never does…
    fake.emit('login', { isProxy: false, host: 'proxy.local', port: 8080, scheme: 'basic', realm: 'origin' }, record);
    // …nor does a different proxy endpoint.
    fake.emit('login', { isProxy: true, host: 'other.local', port: 8080, scheme: 'basic', realm: 'proxy' }, record);

    expect(answers[0]).toEqual({ user: 'alice', pass: 'hunter2' });
    expect(answers[1]).toEqual({ user: undefined, pass: undefined });
    expect(answers[2]).toEqual({ user: undefined, pass: undefined });

    fake.emit('response', createFakeMessage(200, {}, [text('ok')]));
    await pending;
  });

  it('does NOT install a login handler in system mode (Chromium owns system auth)', async () => {
    const harness = createHarness({ proxy: () => '' });
    const network = createElectronUpdateNetwork({ surface: harness.surface, readProxy: harness.readProxy });
    const pending = network.httpPort.getText('https://api.github.test/x', { urlPolicy: ALLOW_ALL, timeoutMs: 3000 });
    await wire();
    expect(harness.latest().listenerCount('login')).toBe(0);
    harness.latest().emit('response', createFakeMessage(200, {}, [text('ok')]));
    await pending;
  });

  it('follows a validated redirect (relative Location) and can still complete', async () => {
    const harness = createHarness({ proxy: () => '' });
    const network = createElectronUpdateNetwork({ surface: harness.surface, readProxy: harness.readProxy });
    const pending = network.httpPort.getText('https://api.github.test/x', { urlPolicy: ALLOW_ALL, timeoutMs: 3000 });
    await wire();
    const fake = harness.latest();

    fake.emit('redirect', 302, 'GET', '/moved', {});
    expect(fake.calls.followRedirect).toBe(1);

    fake.emit('response', createFakeMessage(200, {}, [text('done')]));
    await expect(pending).resolves.toBe('done');
  });

  it('blocks a redirect whose target the policy rejects', async () => {
    const harness = createHarness({ proxy: () => '' });
    const network = createElectronUpdateNetwork({ surface: harness.surface, readProxy: harness.readProxy });
    const pending = network.httpPort.getText('https://api.github.test/x', {
      urlPolicy: (url) => url.startsWith('https://api.github.test/'), timeoutMs: 3000,
    });
    await wire();
    const fake = harness.latest();

    fake.emit('redirect', 302, 'GET', 'https://evil.test/steal', {});
    await expect(pending).rejects.toThrow(/blocked redirect/);
    expect(fake.calls.followRedirect).toBe(0);
  });

  it('rejects a response whose declared size exceeds the per-call budget', async () => {
    const harness = createHarness({ proxy: () => '' });
    const network = createElectronUpdateNetwork({ surface: harness.surface, readProxy: harness.readProxy });
    const pending = network.httpPort.getText('https://api.github.test/big', {
      urlPolicy: ALLOW_ALL, maxBytes: 10, timeoutMs: 3000,
    });
    await wire();
    harness.latest().emit('response', createFakeMessage(200, { 'content-length': '999999' }, []));
    await expect(pending).rejects.toThrow(/too large/);
  });
});

