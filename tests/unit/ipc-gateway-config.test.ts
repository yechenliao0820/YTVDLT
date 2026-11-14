/**
 * D-168 follow-up · `CONFIG_GET` domain whitelist.
 *
 * The gateway used to answer `ytvdlt:config:get` with the FULL contents of any
 * domain the renderer named — `paths` (real user directories), `network`
 * (`proxy` / `cookiesFile` at runtime), `saved_links` (stored URLs). The
 * handler now refuses every domain outside `READABLE_CONFIG_DOMAINS` with an
 * error instead of a silent bucket, mirrors `CONFIG_SET`'s read-only contract
 * when no config port is injected, and rejects malformed `domain` values.
 */
import { describe, it, expect } from 'vitest';
import { IPC_CHANNELS } from '@ytvdlt/shared';
import { createIpcGateway, type IpcConfigPort } from '../../apps/desktop/src/main/ipc-gateway.js';

/** Distinct, sensitive-shaped content per domain, as the real store holds it. */
const DOMAINS: Record<string, Record<string, unknown>> = {
  general: { concurrency: 3, theme: 'dark' },
  format: { quality: 'best' },
  subtitle: { languages: 'en.*,.*-orig' },
  paths: { videoDir: 'C:/Users/me/Videos/YTVDLT' },
  network: { proxy: 'http://user:pass@corp-proxy:8080', cookiesFile: 'C:/cookies.txt' },
  saved_links: { items: ['https://example.org/watch?token=SECRET'] },
  advanced: { debug: false },
};

/** Fake port that records which domain the gateway actually asked for. */
function fakePort(): { port: IpcConfigPort; requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    port: {
      getDomain(name) {
        requested.push(name);
        return DOMAINS[name];
      },
      async setDomain(name, patch) {
        Object.assign(DOMAINS[name], patch);
      },
    },
  };
}

function gatewayWithConfig() {
  const { port, requested } = fakePort();
  const gateway = createIpcGateway({ readText: async () => '{}', config: port });
  return { gateway, requested };
}

describe('D-168 follow-up · CONFIG_GET domain whitelist', () => {
  it('serves a whitelisted domain and returns ONLY that domain', async () => {
    const { gateway, requested } = gatewayWithConfig();
    const reply = await gateway.dispatch(IPC_CHANNELS.CONFIG_GET, { domain: 'general' }) as {
      value: Record<string, unknown>;
    };
    expect(requested).toEqual(['general']);
    expect(reply.value).toEqual({ concurrency: 3, theme: 'dark' });
    // The other domains' contents must not bleed into the answer.
    expect(JSON.stringify(reply)).not.toContain('YTVDLT');
    expect(JSON.stringify(reply)).not.toContain('corp-proxy');
    expect(JSON.stringify(reply)).not.toContain('SECRET');
  });

  it('serves every whitelisted domain, each in isolation', async () => {
    const { gateway } = gatewayWithConfig();
    const format = await gateway.dispatch(IPC_CHANNELS.CONFIG_GET, { domain: 'format' }) as { value: unknown };
    expect(format.value).toEqual({ quality: 'best' });
    const subtitle = await gateway.dispatch(IPC_CHANNELS.CONFIG_GET, { domain: 'subtitle' }) as { value: unknown };
    expect(subtitle.value).toEqual({ languages: 'en.*,.*-orig' });
  });

  it('refuses every domain outside the whitelist without touching the port', async () => {
    const { gateway, requested } = gatewayWithConfig();
    for (const domain of ['paths', 'network', 'advanced', 'saved_links']) {
      await expect(gateway.dispatch(IPC_CHANNELS.CONFIG_GET, { domain }))
        .rejects.toThrow(/config domain is not readable/);
    }
    expect(requested).toEqual([]);
  });

  it('refuses malformed domain values', async () => {
    const { gateway, requested } = gatewayWithConfig();
    for (const domain of [42, null, true, undefined, ['general'], { length: 7 }, '']) {
      await expect(gateway.dispatch(IPC_CHANNELS.CONFIG_GET, { domain }))
        .rejects.toThrow(/config domain/);
    }
    // Prototype-chain names and case variants never match the whitelist.
    for (const domain of ['__proto__', 'constructor', 'prototype', 'General', 'GENERAL']) {
      await expect(gateway.dispatch(IPC_CHANNELS.CONFIG_GET, { domain }))
        .rejects.toThrow(/config domain is not readable/);
    }
    expect(requested).toEqual([]);
  });

  it('still rejects payload keys outside the registered whitelist', async () => {
    const { gateway } = gatewayWithConfig();
    await expect(gateway.dispatch(IPC_CHANNELS.CONFIG_GET, { domain: 'general', key: 'theme' }))
      .rejects.toThrow(/payload key not allowed/);
  });

  it('answers read-only instead of pretending, when no config port is injected', async () => {
    const gateway = createIpcGateway({ readText: async () => '{}' });
    const reply = await gateway.dispatch(IPC_CHANNELS.CONFIG_GET, { domain: 'general' }) as {
      value: unknown; reason?: string;
    };
    expect(reply.value).toBeNull();
    expect(reply.reason).toBe('read-only');
  });
});
