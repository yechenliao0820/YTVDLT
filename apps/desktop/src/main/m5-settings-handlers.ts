/**
 * M5 settings/platform-domain IPC handlers (task 4, mechanical extraction
 * from `m5-channels.ts`): SETTINGS_GET/SET (D-166 registry-first autostart),
 * PATH_ACTION (D-98/D-193 root-specificity gate), APP_INFO (D-114), the
 * D-67/D-93/D-94 component + app update channels and D-173 clipboard write.
 *
 * The handler bodies are VERBATIM. `readPaths` keeps its exported name here
 * and is re-exported from `m5-channels.ts`, so the original import path and
 * every consumer stay untouched.
 */
import { IPC_CHANNELS } from '@ytvdlt/shared';
import type { AppUpdateAction } from '@ytvdlt/shared';
import {
  ACCENT_PRESETS, DEFAULT_PATH_TOKENS, isSpecificRoot,
  normalizeHexColor, normalizeThemeMode, normalizeMotionMode, parseAccent,
} from '@ytvdlt/core';
import { validateM5Payload } from './m5-contracts.js';
import type {
  AppearanceDto, M5ChannelDeps, M5HandlerContext, M5Handler, M5HandlerMap, PathsDto,
} from './m5-channels.js';

/**
 * D-173: how much TEXT the renderer may hand to the clipboard channel.
 * 1,000,000 UTF-16 units is ~10x any realistic task log (thousands of lines of
 * ~100 chars) and ≤ ~3 MB even in the worst all-CJK UTF-8 case — far below what
 * the OS clipboard or the Electron IPC pipe cares about, while still bounding a
 * runaway dump. Counted in code units, not bytes: the string is not decoded or
 * truncated here, the cap only refuses absurd payloads before they reach the OS.
 */
const MAX_CLIPBOARD_TEXT_CHARS = 1_000_000;

/** D-93: the only actions the renderer may trigger. */
const APP_UPDATE_ACTIONS: readonly AppUpdateAction[] = [
  'check', 'download', 'cancel-download', 'install', 'open-page', 'skip-version', 'dismiss',
];

/** D-98: paths are user input; keep them short and printable. */
const MAX_PATH_LENGTH = 400;
const PATH_ACTIONS: readonly string[] = ['pick', 'reset', 'open'];

/**
 * D-98: stored value (`%USERPROFILE%/...`) → the absolute path the engine uses.
 *
 * An empty or non-string value falls back to the shipped default instead of
 * producing `''` — an empty output dir is exactly the "save failed" case the
 * user must never hit.
 */
export function readPaths(deps: Pick<M5ChannelDeps, 'config' | 'expandPath'>): PathsDto {
  const expand = deps.expandPath ?? ((raw: string): string => raw);
  const read = (key: 'videoDir' | 'audioDir'): string => {
    const raw = deps.config.get<string>('paths', key);
    const value = typeof raw === 'string' ? raw.trim() : '';
    return expand(value === '' ? DEFAULT_PATH_TOKENS[key] : value);
  };
  return { videoDir: read('videoDir'), audioDir: read('audioDir') };
}

/**
 * D-166 follow-up: the HKCU Run entry is the operating system's real state, so
 * the settings toggle must show it — `config.json` only mirrors what the app
 * last wrote, and a registry cleaner / manual `reg delete` can remove the
 * entry behind the app's back. Policy: the registry wins whenever it can be
 * read; when the port is absent (non-Windows / test builds) or `read()` throws,
 * the config value is shown so a failed query can never break SETTINGS_GET or
 * the settings page. On a confirmed mismatch the config mirror is reconciled
 * to the registry value (best-effort: a failed write-back only leaves the
 * mirror stale, the registry stays the truth).
 */
async function readAutostart(deps: M5ChannelDeps): Promise<boolean> {
  const configValue = deps.config.get('general', 'autostart') === true;
  const port = deps.systemStartup;
  if (port === undefined) return configValue;
  let registryValue: boolean;
  try {
    registryValue = (await port.read()) === true;
  } catch {
    // Unknown registry state — show the mirror, never reconcile a guess.
    return configValue;
  }
  if (registryValue !== configValue) {
    try {
      await deps.config.setDomain('general', { autostart: registryValue });
    } catch {
      // Display-only hygiene; nothing functional depends on the mirror.
    }
  }
  return registryValue;
}

async function readAppearance(deps: M5ChannelDeps): Promise<AppearanceDto> {
  return {
    theme: normalizeThemeMode(deps.config.get('general', 'theme')),
    accent: parseAccent(deps.config.get('general', 'accent')),
    motion: normalizeMotionMode(deps.config.get('general', 'motion')),
    language: String(deps.config.get('general', 'language')).toLowerCase().startsWith('en') ? 'en' : 'zh-CN',
    privateMode: deps.config.get('general', 'privateMode') === true,
    autostart: await readAutostart(deps),
    autoCheckAppUpdate: deps.config.get('advanced', 'autoCheckAppUpdate') !== false,
    autoCheckEngineUpdate: deps.config.get('advanced', 'autoCheckEngineUpdate') !== false,
    // D-286: absent / non-boolean config resolves to ON, like the two above.
    autoCleanUpdateInstaller: deps.config.get('advanced', 'autoCleanUpdateInstaller') !== false,
    systemAccent: deps.systemAppearance.accent(),
    prefersDark: deps.systemAppearance.prefersDark(),
    prefersReducedMotion: deps.systemAppearance.prefersReducedMotion(),
    ...readPaths(deps),
  };
}

export function createSettingsHandlers(ctx: M5HandlerContext): M5HandlerMap {
  const handlers = new Map<string, M5Handler>();
  const deps = ctx.deps;


    handlers.set(IPC_CHANNELS.COMPONENT_STATUS, async (payload) => {
    validateM5Payload(IPC_CHANNELS.COMPONENT_STATUS, payload);
    if (deps.componentUpdate === undefined) {
      return { components: [], source: null, updating: false };
    }
    return deps.componentUpdate.status();
  });

  handlers.set(IPC_CHANNELS.COMPONENT_UPDATE, async (payload) => {
    validateM5Payload(IPC_CHANNELS.COMPONENT_UPDATE, payload);
    if (deps.componentUpdate === undefined) {
      return { ok: false, source: null, reason: '当前构建未启用组件更新', results: [] };
    }
    return deps.componentUpdate.run();
  });

  // 0.2.1 (D-94): the network half of the component surface. Kept separate from
  // COMPONENT_STATUS so the settings page can render versions instantly and only
  // pay for a request when the user (or the startup toggle) asks for one.
  handlers.set(IPC_CHANNELS.COMPONENT_CHECK, async (payload) => {
    validateM5Payload(IPC_CHANNELS.COMPONENT_CHECK, payload);
    if (deps.componentUpdate === undefined) {
      return { checkedAt: '', results: [] };
    }
    return deps.componentUpdate.check();
  });

  // 0.2.1 (D-93): app update. `status` is a pure read of the in-memory state, so
  // the queue page can poll it on the same tick as TASK_LIST without a request.
  handlers.set(IPC_CHANNELS.APP_UPDATE_STATUS, async (payload) => {
    validateM5Payload(IPC_CHANNELS.APP_UPDATE_STATUS, payload);
    if (deps.appUpdate === undefined) {
      return {
        phase: 'idle', currentVersion: '', latest: null,
        releaseNotes: [], omittedReleaseNotes: 0,
        message: '此构建不含更新器', downloadedBytes: 0, totalBytes: null,
        skippedVersion: null, lastCheckedAt: null, canAutoInstall: false,
      };
    }
    return deps.appUpdate.state();
  });

  handlers.set(IPC_CHANNELS.APP_UPDATE_ACTION, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.APP_UPDATE_ACTION, payload);
    const action = record['action'];
    if (typeof action !== 'string' || !APP_UPDATE_ACTIONS.includes(action as AppUpdateAction)) {
      throw new Error('[m5-ipc] unknown app update action');
    }
    if (deps.appUpdate === undefined) {
      return { ok: false, action, message: '此构建不含更新器', state: null };
    }
    return deps.appUpdate.perform(action as AppUpdateAction);
  });

    // 0.2.1 (D-98): the download root. `pick` is the only way to change it — the
  // renderer can never hand us an arbitrary string to write into the config.
  handlers.set(IPC_CHANNELS.PATH_ACTION, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.PATH_ACTION, payload);
    const action = record['action'];
    const kind = record['kind'];
    if (typeof action !== 'string' || !PATH_ACTIONS.includes(action)) {
      throw new Error('[m5-ipc] unknown path action');
    }
    if (kind !== 'video' && kind !== 'audio') throw new Error('[m5-ipc] path kind must be video|audio');
    const key: 'videoDir' | 'audioDir' = kind === 'audio' ? 'audioDir' : 'videoDir';
    const before = readPaths(deps);

    if (action === 'reset') {
      await deps.config.setDomain('paths', { [key]: DEFAULT_PATH_TOKENS[key] });
      const paths = readPaths(deps);
      return { ok: true, action, kind, canceled: false, error: null, path: paths[key], paths };
    }

    if (deps.pathPicker === undefined) {
      return {
        ok: false, action, kind, canceled: false,
        error: '当前构建不支持选择目录', path: null, paths: before,
      };
    }

    if (action === 'open') {
      try {
        await deps.pathPicker.open(before[key]);
        return { ok: true, action, kind, canceled: false, error: null, path: before[key], paths: before };
      } catch (error) {
        return {
          ok: false, action, kind, canceled: false,
          error: error instanceof Error ? error.message : String(error),
          path: null, paths: before,
        };
      }
    }

    const picked = await deps.pathPicker.pick(kind, before[key]);
    if (picked.path === null) {
      return {
        ok: false, action, kind,
        // No error + no path = the user closed the dialog; not a failure.
        canceled: picked.error === null,
        error: picked.error,
        path: null,
        paths: before,
      };
    }
    const next = picked.path.trim();
    if (next === '' || next.length > MAX_PATH_LENGTH || /[\u0000-\u001f]/.test(next)) {
      return {
        ok: false, action, kind, canceled: false,
        error: '所选路径无效', path: null, paths: before,
      };
    }
    // D-193 (P2-2): the artifact containment gate trusts only SPECIFIC roots
    // (`isSpecificRoot`), so a drive root (`C:\`), the POSIX root or a bare UNC
    // share stored here would make every later download fail containment with
    // a misleading message. Refuse at the pick boundary with the SAME predicate
    // the gate uses, so the user gets the feedback now instead of at download
    // time. `reset` and the default tokens never pass through this branch.
    if (!isSpecificRoot(next)) {
      return {
        ok: false, action, kind, canceled: false,
        code: 'PATH_ROOT_NOT_SPECIFIC',
        error: '所选目录是盘符根或共享根（如 C:\\），不能作为下载目录，请选择其中的具体文件夹',
        path: null, paths: before,
      };
    }
    await deps.config.setDomain('paths', { [key]: next });
    const paths = readPaths(deps);
    return { ok: true, action, kind, canceled: false, error: null, path: paths[key], paths };
  });

    // D-114: read-only build identity. Deliberately NOT derived from the page
  // URL: the value must survive a navigation that drops query parameters, and
  // it must never be a literal shipped inside the renderer bundle.
  handlers.set(IPC_CHANNELS.APP_INFO, async (payload) => {
    validateM5Payload(IPC_CHANNELS.APP_INFO, payload);
    const info = deps.appInfo;
    return {
      version: typeof info?.version === 'string' ? info.version : '',
      name: typeof info?.name === 'string' && info.name !== '' ? info.name : 'YTVDLT',
      packaged: info?.packaged === true,
    };
  });

    // D-173: the main process owns the real clipboard (A-4.1-02). Since D-170 the
  // session denies every renderer permission — including the
  // `clipboard-sanitized-write` check behind `navigator.clipboard.writeText` —
  // so a renderer-side copy silently fails in the packaged app. Here the write
  // goes through the injected `ClipboardPort` (Electron `clipboard.writeText`),
  // which never passes a permission handler. Success/failure is an explicit
  // `{ok}` answer, never a silent void; the codes reuse the TASK_ACTION copy
  // vocabulary (`CLIPBOARD_UNAVAILABLE`, task-detail.ts).
  handlers.set(IPC_CHANNELS.CLIPBOARD_WRITE, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.CLIPBOARD_WRITE, payload);
    const text = record['text'];
    if (typeof text !== 'string' || text.length > MAX_CLIPBOARD_TEXT_CHARS) {
      throw new Error('[m5-ipc] CLIPBOARD_WRITE requires a bounded text string');
    }
    const port = deps.clipboard;
    if (port === undefined) return { ok: false, code: 'CLIPBOARD_UNAVAILABLE' };
    try {
      await port.writeText(text);
      return { ok: true };
    } catch {
      return { ok: false, code: 'CLIPBOARD_WRITE_FAILED' };
    }
  });

  handlers.set(IPC_CHANNELS.SETTINGS_GET, async (payload) => {
    validateM5Payload(IPC_CHANNELS.SETTINGS_GET, payload);
    return readAppearance(deps);
  });
  handlers.set(IPC_CHANNELS.SETTINGS_SET, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.SETTINGS_SET, payload);
    const patch: Record<string, unknown> = {};
    if (record['theme'] !== undefined) {
      const theme = normalizeThemeMode(record['theme']);
      if (theme !== record['theme']) throw new Error('[m5-ipc] invalid theme');
      patch['theme'] = theme;
    }
    if (record['accent'] !== undefined) {
      const accent = record['accent'];
      const valid = typeof accent === 'string' && (
        accent === 'system'
        || (ACCENT_PRESETS as readonly string[]).includes(accent)
        || normalizeHexColor(accent) !== null
      );
      if (!valid) throw new Error('[m5-ipc] invalid accent');
      patch['accent'] = accent;
    }
    if (record['motion'] !== undefined) {
      const motion = normalizeMotionMode(record['motion']);
      if (motion !== record['motion']) throw new Error('[m5-ipc] invalid motion');
      patch['motion'] = motion;
    }
    if (record['language'] !== undefined) {
      const language = String(record['language']);
      if (language !== 'zh-CN' && language !== 'en') throw new Error('[m5-ipc] invalid language');
      patch['language'] = language;
    }
    // D-88: private mode lives in `general.privateMode` (already a declared
    // default since M1). The host reads it on window close / before-quit.
    if (record['privateMode'] !== undefined) {
      if (typeof record['privateMode'] !== 'boolean') throw new Error('[m5-ipc] invalid privateMode');
      patch['privateMode'] = record['privateMode'];
    }
    // 0.2.1: the update switches live in `advanced`, not `general`.
    const advancedPatch: Record<string, unknown> = {};
    for (const key of ['autoCheckAppUpdate', 'autoCheckEngineUpdate', 'autoCleanUpdateInstaller'] as const) {
      const value = record[key];
      if (value === undefined) continue;
      if (typeof value !== 'boolean') throw new Error(`[m5-ipc] invalid ${key}`);
      advancedPatch[key] = value;
    }
    // D-166: the registry is written FIRST. If `reg` fails, the config keeps
    // saying what is actually true on disk instead of promising a startup entry
    // that does not exist.
    if (record['autostart'] !== undefined) {
      if (typeof record['autostart'] !== 'boolean') {
        throw new Error('[m5-ipc] autostart must be a boolean');
      }
      const port = deps.systemStartup;
      if (port === undefined) throw new Error('[m5-ipc] autostart is not available in this build');
      const applied = await port.apply(record['autostart']);
      if (!applied.ok) {
        throw new Error(`[m5-ipc] autostart failed: ${applied.reason ?? 'unknown'}`);
      }
      patch['autostart'] = record['autostart'];
    }

    if (Object.keys(patch).length > 0) await deps.config.setDomain('general', patch);
    if (Object.keys(advancedPatch).length > 0) await deps.config.setDomain('advanced', advancedPatch);
    const snapshot = await readAppearance(deps);
    deps.onAppearanceChanged?.(snapshot);
    return snapshot;
  });

  return handlers;
}
