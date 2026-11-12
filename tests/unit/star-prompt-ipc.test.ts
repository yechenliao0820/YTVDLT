/**
 * D-148 · the Star-prompt IPC surface, end to end on fakes.
 *
 * Covers the three layers the renderer cannot bypass:
 *   - the pure service adapter (config + injected clock + injected openExternal);
 *   - the M5 channel handlers (zero-payload CHECK, enum-only ACTION, whitelist);
 *   - the host composition (the channels really dispatch through the merged
 *     gateway, and recordLaunch really persisted the five advanced keys).
 *
 * The THREE cable tables (§5) are asserted to agree: shared `IPC_CHANNELS`
 * values, the preload `BRIDGE_CHANNELS` whitelist (derived from that table)
 * and the renderer `ipc-bridge.js` ALLOWED_COMMANDS / CHANNEL_STRINGS.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC_CHANNELS } from '@ytvdlt/shared';
import { CommandTemplateStore, ConfigStore } from '@ytvdlt/core';
import type { TaskRecord, TaskDetailAction, TaskDetailResult } from '@ytvdlt/shared';
import {
  createM5Handlers, M5_CHANNELS, validateM5Payload,
  type M5ChannelDeps, type SystemAppearancePort,
} from '../../apps/desktop/src/main/m5-channels.js';
import { createM5Host } from '../../apps/desktop/src/main/m5-host.js';
import {
  createStarPromptService, STAR_PROMPT_REPO_URL,
} from '../../apps/desktop/src/main/star-prompt-service.js';
import { createInMemoryPorts, type InMemoryPorts } from './helpers/in-memory-ports.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const UI_ROOT = join(ROOT, 'packages', 'ui', 'src');
const APP_VERSION = '0.3.0';
const DAY = 24 * 60 * 60 * 1000;

const appearance: SystemAppearancePort = {
  prefersDark: () => false,
  prefersReducedMotion: () => false,
  accent: () => '#0f6b64',
};

function emptyQueue(): M5ChannelDeps['queue'] {
  return { list: () => [] as readonly TaskRecord[], get: () => undefined };
}

const taskDetail = {
  async perform(taskId: string, action: TaskDetailAction): Promise<TaskDetailResult> {
    return { action, ok: true, code: 'OK', message: taskId };
  },
};

interface ServiceHarness {
  ports: InMemoryPorts;
  config: ConfigStore;
  service: ReturnType<typeof createStarPromptService>;
  opened: string[];
}

async function serviceHarness(appVersion: string = APP_VERSION): Promise<ServiceHarness> {
  const ports = createInMemoryPorts();
  const config = new ConfigStore({ ports: ports.ports });
  await config.load();
  const opened: string[] = [];
  const service = createStarPromptService({
    config,
    clock: ports.ports.clock,
    appVersion,
    openExternal: async (url: string) => { opened.push(url); },
  });
  return { ports, config, service, opened };
}

describe('star prompt service · launch bookkeeping', () => {
  it('records each launch into the five advanced keys', async () => {
    const { config, service } = await serviceHarness();
    await service.recordLaunch();
    await service.recordLaunch();
    await service.recordLaunch();
    expect(config.get('advanced', 'starPromptVersion')).toBe(APP_VERSION);
    expect(config.get('advanced', 'starPromptLaunches')).toBe(3);
    expect(config.get('advanced', 'starPromptPromptedCount')).toBe(0);
    expect(config.get('advanced', 'starPromptLastPromptedAt')).toBe('');
    expect(config.get('advanced', 'starPromptNever')).toBe(false);
  });

  it('resets the counters when the app version changes', async () => {
    const { config, ports, service } = await serviceHarness();
    await service.recordLaunch();
    await service.recordLaunch();
    await service.recordLaunch();
    // Upgrade: a new service for the new version records the first launch.
    const upgraded = createStarPromptService({
      config, clock: ports.ports.clock, appVersion: '0.3.1',
    });
    await upgraded.recordLaunch();
    expect(config.get('advanced', 'starPromptVersion')).toBe('0.3.1');
    expect(config.get('advanced', 'starPromptLaunches')).toBe(1);
    expect(config.get('advanced', 'starPromptPromptedCount')).toBe(0);
  });
});

describe('star prompt service · check / applyAction', () => {
  it('answers show:false before the third launch and show:true from it on', async () => {
    const { service } = await serviceHarness();
    await service.recordLaunch();
    await service.recordLaunch();
    expect(await service.check()).toEqual({ show: false });
    await service.recordLaunch();
    expect(await service.check()).toEqual({ show: true });
  });

  it('later: stamps the 7-day gap and stays quiet until it elapses (fake clock)', async () => {
    const { ports, service } = await serviceHarness();
    for (let index = 0; index < 3; index += 1) await service.recordLaunch();
    expect(await service.check()).toEqual({ show: true });
    await service.applyAction('later');
    expect(ports.state.nowEpochMs).toBeDefined();
    expect(await service.check()).toEqual({ show: false });
    ports.state.nowEpochMs += 7 * DAY;
    expect(await service.check()).toEqual({ show: true });
    // Second "later" hits the per-version cap: quiet forever within 0.3.0.
    await service.applyAction('later');
    ports.state.nowEpochMs += 30 * DAY;
    expect(await service.check()).toEqual({ show: false });
  });

  it('star opens the MAIN-process repo URL and silences permanently', async () => {
    const { config, opened, service } = await serviceHarness();
    for (let index = 0; index < 3; index += 1) await service.recordLaunch();
    expect(await service.applyAction('star')).toEqual({ ok: true, action: 'star' });
    // The renderer never chose the URL: the port got the frozen constant.
    expect(opened).toEqual([STAR_PROMPT_REPO_URL]);
    expect(config.get('advanced', 'starPromptNever')).toBe(true);
    expect(await service.check()).toEqual({ show: false });
  });

  it('a failed shell call still records the answer (best-effort open)', async () => {
    const ports = createInMemoryPorts();
    const config = new ConfigStore({ ports: ports.ports });
    await config.load();
    const service = createStarPromptService({
      config, clock: ports.ports.clock, appVersion: APP_VERSION,
      openExternal: async () => { throw new Error('shell exploded'); },
    });
    for (let index = 0; index < 3; index += 1) await service.recordLaunch();
    expect(await service.applyAction('star')).toEqual({ ok: true, action: 'star' });
    expect(config.get('advanced', 'starPromptNever')).toBe(true);
  });

  it('rejects anything outside the three-button enum', async () => {
    const { service } = await serviceHarness();
    await expect(service.applyAction('format')).rejects.toThrow(/unknown action/);
    await expect(service.applyAction(42)).rejects.toThrow(/unknown action/);
    await expect(service.applyAction(undefined)).rejects.toThrow(/unknown action/);
  });
});

async function handlersHarness(
  starPrompt: M5ChannelDeps['starPrompt'],
  overrides: Partial<M5ChannelDeps> = {},
): Promise<Map<string, (payload: unknown) => Promise<unknown>>> {
  const ports = createInMemoryPorts();
  const config = new ConfigStore({ ports: ports.ports });
  await config.load();
  const templates = new CommandTemplateStore({ ports: ports.ports });
  await templates.init();
  const deps: M5ChannelDeps = {
    queue: emptyQueue(),
    taskDetail,
    templates: templates as CommandTemplateStoreType,
    config,
    systemAppearance: appearance,
    ...(starPrompt === undefined ? {} : { starPrompt }),
    ...overrides,
  };
  return createM5Handlers(deps);
}

describe('star prompt channels · payload rules (§5 whitelist)', () => {
  it('CHECK takes zero payload — any key is a protocol error', async () => {
    const handlers = await handlersHarness({ check: async () => ({ show: true }), applyAction: async () => ({ ok: true, action: 'later' }) });
    const check = handlers.get(IPC_CHANNELS.STAR_PROMPT_CHECK);
    expect(await check?.({})).toEqual({ show: true });
    await expect(check?.({ fake: true })).rejects.toThrow(/key not allowed/);
    await expect(() => validateM5Payload(IPC_CHANNELS.STAR_PROMPT_CHECK, 'x')).toThrow(/must be an object/);
  });

  it('ACTION takes only the enum value; unknown values and extra keys are refused', async () => {
    const seen: unknown[] = [];
    const handlers = await handlersHarness({
      check: async () => ({ show: false }),
      async applyAction(action: unknown) { seen.push(action); return { ok: true, action: action as 'later' }; },
    });
    const action = handlers.get(IPC_CHANNELS.STAR_PROMPT_ACTION);
    expect(await action?.({ action: 'never' })).toEqual({ ok: true, action: 'never' });
    expect(seen).toEqual(['never']);
    await expect(action?.({ action: 'open-browser' })).rejects.toThrow(/unknown star prompt action/);
    await expect(action?.({ action: 'star', url: 'https://evil.example' })).rejects.toThrow(/key not allowed/);
  });

  it('without the service CHECK stays false and ACTION refuses with a stable code', async () => {
    const handlers = await handlersHarness(undefined);
    const check = handlers.get(IPC_CHANNELS.STAR_PROMPT_CHECK);
    const action = handlers.get(IPC_CHANNELS.STAR_PROMPT_ACTION);
    expect(await check?.({})).toEqual({ show: false });
    expect(await action?.({ action: 'later' })).toEqual({ ok: false, action: 'later', code: 'STAR_PROMPT_UNAVAILABLE' });
  });
});

describe('star prompt channels · the three cable tables agree (§5)', () => {
  it('both channels are in M5_CHANNELS and in the shared IPC table', () => {
    expect(M5_CHANNELS).toContain(IPC_CHANNELS.STAR_PROMPT_CHECK);
    expect(M5_CHANNELS).toContain(IPC_CHANNELS.STAR_PROMPT_ACTION);
    expect(IPC_CHANNELS.STAR_PROMPT_CHECK).toBe('ytvdlt:starPrompt:check');
    expect(IPC_CHANNELS.STAR_PROMPT_ACTION).toBe('ytvdlt:starPrompt:action');
  });

  it('the preload whitelist (BRIDGE_CHANNELS) accepts both wire strings', async () => {
    const { BRIDGE_CHANNELS } = await import('../../apps/desktop/src/preload/bridge.js');
    expect(BRIDGE_CHANNELS).toContain('ytvdlt:starPrompt:check');
    expect(BRIDGE_CHANNELS).toContain('ytvdlt:starPrompt:action');
  });

  it('the renderer bridge (ipc-bridge.js) knows both symbolic names and wire strings', () => {
    const source = readFileSync(join(UI_ROOT, 'ipc-bridge.js'), 'utf8');
    const sandbox: Record<string, unknown> = {};
    // eslint-disable-next-line no-new-func
    new Function('window', source)(sandbox);
    const bridge = sandbox['YTVDLT'] as {
      bridge: { ALLOWED_COMMANDS: readonly string[]; invoke(command: string): unknown };
    };
    expect(bridge.bridge.ALLOWED_COMMANDS).toContain('STAR_PROMPT_CHECK');
    expect(bridge.bridge.ALLOWED_COMMANDS).toContain('STAR_PROMPT_ACTION');
    // Outside the whitelist the renderer dispatch refuses BEFORE reaching main.
    expect(bridge.bridge.invoke('STAR_PROMPT_CHECK')).toBeDefined();
    expect(bridge.bridge.invoke('ytvdlt:starPrompt:check')).toEqual({
      ok: false, reason: 'command-not-allowed', command: 'ytvdlt:starPrompt:check',
    });
  });
});

describe('star prompt · host composition dispatches the channels for real', () => {
  const engine = {
    async version() { return '2026.11.06'; },
    async probe() { throw new Error('not used'); },
    async probePlaylist() { throw new Error('not used'); },
    async download() { throw new Error('not used'); },
    async selfUpdate() {
      return { fromVersion: '', toVersion: '', channel: 'stable', changed: false };
    },
  };

  const verifier = {
    async verify() {
      return {
        taskId: 'x', artifacts: [], postprocessed: false, criteria: [],
        ok: true, failureCode: null, durationMs: 1,
      };
    },
  };

  it('recordLaunch ran at assembly and CHECK/ACTION answer through the gateway', async () => {
    const ports = createInMemoryPorts();
    const opened: string[] = [];
    const built = await createM5Host({
      ports: ports.ports,
      engine: engine as never,
      verifier: verifier as never,
      enginePath: 'C:/runtime/yt-dlp.exe',
      siteSupportNetwork: () => ({}),
      jsRuntimePath: 'C:/runtime/node.exe',
      videoFixturePath: 'C:/fixtures/info-video.json',
      playlistFixturePath: 'C:/fixtures/info-flat-playlist.json',
      appVersion: APP_VERSION,
      engineVersion: '2026.11.06',
      systemAppearance: appearance,
      openExternal: async (url: string) => { opened.push(url); },
    });
    // `recordLaunch()` is fire-and-forget at assembly; a no-op write drains the
    // ConfigStore write queue so the test reads the settled state.
    await built.m4.task.config.setDomain('advanced', {});
    // Assembly recorded exactly one launch for this version.
    expect(built.m4.task.config.get('advanced', 'starPromptVersion')).toBe(APP_VERSION);
    expect(built.m4.task.config.get('advanced', 'starPromptLaunches')).toBe(1);
    // Two launches short of the threshold: quiet.
    expect(await built.gateway.dispatch(IPC_CHANNELS.STAR_PROMPT_CHECK, {}))
      .toEqual({ show: false });
    // ACTION persists the user's answer.
    expect(await built.gateway.dispatch(IPC_CHANNELS.STAR_PROMPT_ACTION, { action: 'never' }))
      .toEqual({ ok: true, action: 'never' });
    expect(built.m4.task.config.get('advanced', 'starPromptNever')).toBe(true);
    // `star` is the only action that opens anything, and only the frozen URL.
    expect(await built.gateway.dispatch(IPC_CHANNELS.STAR_PROMPT_ACTION, { action: 'star' }))
      .toEqual({ ok: true, action: 'star' });
    expect(opened).toEqual([STAR_PROMPT_REPO_URL]);
    expect(opened.every((url) => url === STAR_PROMPT_REPO_URL)).toBe(true);
    await expect(
      built.gateway.dispatch(IPC_CHANNELS.STAR_PROMPT_ACTION, { action: 'bogus' }),
    ).rejects.toThrow(/unknown star prompt action/);
    built.dispose();
  });
});
