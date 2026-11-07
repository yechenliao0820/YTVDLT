/**
 * Crash guard (M5 · A-4.5-08) — never swallow an exception, and tell the user
 * about it on the next start.
 *
 * `Logger.writeCrashReport()` (M1) already writes `logs/crash-<epoch>.json` with
 * the app version, OS and a redacted context. What was missing is the lifecycle:
 *
 *   capture -> the file exists and the error is re-thrown to the caller
 *   pending -> which crash files have NOT been acknowledged yet
 *   ack     -> rename `crash-*.json` to `crash-*.ack.json` (kept, never deleted)
 *   notice  -> "last run crashed" banner data for the next start
 *
 * Files are never removed: a crash report that the user did not acknowledge must
 * survive a restart, otherwise the evidence disappears exactly when it matters.
 */
import type { CorePorts } from '@ytvdlt/shared';
import type { ILogger } from '../ports.js';

export interface CrashReportMeta {
  readonly path: string;
  readonly fileName: string;
  readonly ts: string;
  readonly appVersion: string;
  readonly os: string | null;
  readonly message: string;
  readonly acknowledged: boolean;
}

export interface CrashGuardDeps {
  readonly ports: CorePorts;
  readonly logger: ILogger;
  readonly appVersion: string;
}

const CRASH_RE = /^crash-(\d+)(?:-(\d+))?\.json$/;
const ACK_RE = /^crash-(\d+)(?:-(\d+))?\.ack\.json$/;

export function isCrashFile(fileName: string): boolean {
  return CRASH_RE.test(fileName);
}

export function isAcknowledgedCrashFile(fileName: string): boolean {
  return ACK_RE.test(fileName);
}

export class CrashGuard {
  private readonly deps: CrashGuardDeps;

  constructor(deps: CrashGuardDeps) {
    this.deps = deps;
  }

  /**
   * Write a crash report and hand the path back. The caller is responsible for
   * re-throwing — `capture` deliberately does NOT swallow anything.
   */
  async capture(error: unknown, context: Record<string, unknown> = {}): Promise<string> {
    await this.freeSlot();
    return this.deps.logger.writeCrashReport(error, {
      ...context,
      appVersion: this.deps.appVersion,
      source: String(context['source'] ?? 'unhandled'),
    });
  }

  /**
   * Two crashes inside the same millisecond would collide on the logger's
   * `crash-<epoch>.json` name. Move the older one to `crash-<epoch>-<n>.json`
   * first, so no report is silently overwritten.
   */
  private async freeSlot(): Promise<void> {
    const dir = this.deps.ports.env.logsDir();
    const epoch = this.deps.ports.clock.nowEpochMs();
    const base = `${dir}/crash-${epoch}.json`;
    try {
      if (!(await this.deps.ports.fs.exists(base))) return;
      let sequence = 1;
      while (await this.deps.ports.fs.exists(`${dir}/crash-${epoch}-${sequence}.json`)) sequence += 1;
      await this.deps.ports.fs.rename(base, `${dir}/crash-${epoch}-${sequence}.json`);
    } catch {
      // Best effort: a failed rename must not block the new report.
    }
  }

  /** Capture inside a wrapper: the error always propagates after being recorded. */
  async guard<T>(context: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      await this.capture(error, context).catch(() => undefined);
      throw error;
    }
  }

  private async readMeta(fileName: string, acknowledged: boolean): Promise<CrashReportMeta | null> {
    const path = `${this.deps.ports.env.logsDir()}/${fileName}`;
    try {
      const parsed = JSON.parse(await this.deps.ports.fs.readText(path)) as Record<string, unknown>;
      return {
        path,
        fileName,
        ts: String(parsed['ts'] ?? ''),
        appVersion: String(parsed['appVersion'] ?? 'unknown'),
        os: typeof parsed['os'] === 'string' ? parsed['os'] : null,
        message: String(parsed['message'] ?? ''),
        acknowledged,
      };
    } catch {
      return null;
    }
  }

  /** Crash reports written by previous runs that the user has not seen yet. */
  async pending(): Promise<readonly CrashReportMeta[]> {
    const dir = this.deps.ports.env.logsDir();
    let names: string[] = [];
    try {
      names = await this.deps.ports.fs.readdir(dir);
    } catch {
      return [];
    }
    const crashes: CrashReportMeta[] = [];
    for (const name of names.filter(isCrashFile).sort()) {
      const meta = await this.readMeta(name, false);
      if (meta !== null) crashes.push(meta);
    }
    return crashes;
  }

  /** Every crash report on disk, acknowledged or not (support bundle / About). */
  async history(): Promise<readonly CrashReportMeta[]> {
    const dir = this.deps.ports.env.logsDir();
    let names: string[] = [];
    try {
      names = await this.deps.ports.fs.readdir(dir);
    } catch {
      return [];
    }
    const all: CrashReportMeta[] = [];
    for (const name of names.sort()) {
      if (isCrashFile(name)) {
        const meta = await this.readMeta(name, false);
        if (meta !== null) all.push(meta);
      } else if (isAcknowledgedCrashFile(name)) {
        const meta = await this.readMeta(name, true);
        if (meta !== null) all.push(meta);
      }
    }
    return all;
  }

  /** Mark one report as seen: renamed to `*.ack.json`, never deleted. */
  async acknowledge(path: string): Promise<boolean> {
    if (!isCrashFile(path.split(/[\\/]/).pop() ?? '')) return false;
    const target = path.replace(/\.json$/, '.ack.json');
    try {
      if (await this.deps.ports.fs.exists(path)) {
        await this.deps.ports.fs.rename(path, target);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  /** Banner payload for the next start; `null` when the last run was clean. */
  async startupNotice(): Promise<{ readonly count: number; readonly latest: CrashReportMeta } | null> {
    const pending = await this.pending();
    if (pending.length === 0) return null;
    const latest = pending[pending.length - 1];
    if (latest === undefined) return null;
    return { count: pending.length, latest };
  }
}
