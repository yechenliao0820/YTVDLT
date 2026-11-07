/**
 * ComponentUpdater — updates the bundled binaries WITHOUT shipping a new app
 * (M5-5 follow-up, D-67).
 *
 * Why this exists: `yt-dlp` is released weekly and `aria2c` occasionally, while
 * the Electron shell changes rarely. Forcing a full 200 MB installer for a
 * 30 MB engine bump is wasteful, and the user explicitly asked for a button
 * that updates the components on their own.
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
 * themselves (GitHub release assets, an object store, or an intranet share).
 */
import type { CorePorts, QueueIntakeGate } from '@ytvdlt/shared';
import type { ILogger } from '@ytvdlt/core';
import {
  HttpUpdateSource, SelfUpdater, normalizeToolVersion,
} from '@ytvdlt/engine-ytdlp';

export interface ComponentSpec {
  /** Stable id used by the UI (`yt-dlp`, `aria2c`). */
  readonly id: string;
  /** Display name. */
  readonly label: string;
  /** File name inside the feed and in the runtime directory. */
  readonly fileName: string;
  /** Absolute path of the installed copy. */
  readonly path: string;
}

export interface ComponentState {
  readonly id: string;
  readonly label: string;
  readonly fileName: string;
  readonly installed: boolean;
  readonly version: string;
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
  run(): Promise<ComponentUpdateResult>;
}

export interface ComponentUpdaterDeps {
  readonly ports: CorePorts;
  readonly logger: ILogger;
  readonly components: readonly ComponentSpec[];
  /** Feed directory (HTTPS). `null` disables the whole feature. */
  readonly baseUrl: string | null;
  readonly intakeGate: QueueIntakeGate | null;
  readonly channel?: 'stable' | 'nightly';
}

/** Re-exported so callers/tests have one spelling for version normalisation. */
export const normalizeVersion = normalizeToolVersion;

export function createComponentUpdater(deps: ComponentUpdaterDeps): ComponentUpdatePort {
  const { ports, logger, components, baseUrl, intakeGate } = deps;
  let updating = false;

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

  return {
    async status(): Promise<ComponentUpdateStatus> {
      const states: ComponentState[] = [];
      for (const component of components) {
        const installed = await ports.fs.exists(component.path);
        states.push({
          id: component.id,
          label: component.label,
          fileName: component.fileName,
          installed,
          version: installed ? await installedVersion(component.path) : '',
        });
      }
      return { components: states, source: baseUrl, updating };
    },

    async run(): Promise<ComponentUpdateResult> {
      if (baseUrl === null) {
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
        for (const component of components) {
          const source = new HttpUpdateSource({
            baseUrl, fileName: component.fileName, http,
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
