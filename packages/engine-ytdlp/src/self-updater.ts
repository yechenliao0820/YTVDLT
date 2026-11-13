/**
 * SelfUpdater — engine (`yt-dlp.exe`) update orchestration (M5-5, D-62).
 *
 * Pure orchestration: every byte of I/O goes through `CorePorts`, so the whole
 * flow — checksum mismatch, mid-swap failure, rollback — is exercised offline
 * in L0 with an in-memory filesystem.
 *
 * Honest scope note: this is **logical** atomic replacement (write `.new`,
 * rename over the target, verify, roll back on mismatch), not a Windows
 * `ReplaceFile` transaction. A power cut between `rename()` and the verify step
 * can still leave the new binary in place; the `.bak` is kept until the verify
 * passes precisely so a manual rollback is always possible.
 *
 * Rules that must not be relaxed:
 *   - checksum mismatch writes NOTHING (no `.new`, no `.bak`, target untouched);
 *   - the backup is written before the target is touched;
 *   - `resume()` runs in `finally` — an update can never wedge the queue;
 *   - nothing here calls `TaskQueue.cancel()`; pausing is a flag, not a cancel.
 */
import type {
  CorePorts, EngineUpdateSource, QueueIntakeGate, UpdateChannel, UpdateResult,
  ChecksumEntry,
} from '@ytvdlt/shared';
import type { ILogger } from '@ytvdlt/core';

export interface SelfUpdaterDeps {
  readonly ports: CorePorts;
  readonly logger: ILogger;
  readonly source: EngineUpdateSource;
  /** Null when no queue is attached (CLI / check-runtime). */
  readonly intakeGate: QueueIntakeGate | null;
  /** Absolute path of the installed binary (yt-dlp.exe, aria2c.exe, …). */
  readonly enginePath: string;
  readonly channel: UpdateChannel;
  /**
   * D-67: which file to look up in `SHA2-256SUMS`. Defaults to `yt-dlp.exe`
   * (the original single-component behaviour); aria2c passes `aria2c.exe`.
   */
  readonly componentFileName?: string;
  /** Human label for logs, e.g. `yt-dlp`. Defaults to the file name. */
  readonly componentLabel?: string;
}

/** `SHA2-256SUMS` line: `<64 hex>  [*]<file>`. */
const CHECKSUM_LINE = /^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/;

/** D-171: how long a component swap waits for running downloads to finish. */
export const QUEUE_IDLE_TIMEOUT_MS = 60_000;

/**
 * `yt-dlp --version` → `2026.10.26`; `aria2c --version` → `aria2 1.35.0` → `1.35.0`.
 * Kept here (not in the caller) so every surface reports the same string.
 */
export function normalizeToolVersion(output: string): string {
  const firstLine = String(output ?? '').split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  const version = /(\d+(?:\.\d+)+)/.exec(firstLine);
  return version?.[1] ?? firstLine.trim().slice(0, 40);
}

export function parseChecksums(text: string, fileName: string): ChecksumEntry | null {
  const wanted = fileName.trim().toLowerCase();
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const match = CHECKSUM_LINE.exec(raw.trim());
    if (match === null) continue;
    const hash = match[1];
    const name = match[2];
    if (hash === undefined || name === undefined) continue;
    if (name.toLowerCase() !== wanted) continue;
    return { sha256: hash.toLowerCase(), fileName: name };
  }
  return null;
}

export class SelfUpdater {
  private readonly deps: SelfUpdaterDeps;

  constructor(deps: SelfUpdaterDeps) {
    this.deps = deps;
  }

  static parseChecksums(text: string, fileName: string): ChecksumEntry | null {
    return parseChecksums(text, fileName);
  }

  private result(
    fromVersion: string,
    toVersion: string,
    changed: boolean,
    reason?: string,
    rolledBack = false,
  ): UpdateResult {
    return {
      fromVersion,
      toVersion,
      channel: this.deps.channel,
      changed,
      ...(rolledBack ? { rolledBack } : {}),
      ...(reason === undefined ? {} : { reason }),
    };
  }

  private async installedVersion(): Promise<string> {
    try {
      const run = await this.deps.ports.process.spawn(this.deps.enginePath, ['--version'], {
        shell: false,
        windowsHide: true,
        timeoutMs: 15_000,
      });
      return normalizeToolVersion(run.stdout ?? '');
    } catch {
      return '';
    }
  }

  /** Restore `<enginePath>.bak` over the target; returns true when it worked. */
  private async rollback(): Promise<boolean> {
    const { ports, enginePath, logger } = this.deps;
    try {
      if (!(await ports.fs.exists(`${enginePath}.bak`))) return false;
      await ports.fs.rename(`${enginePath}.bak`, enginePath);
      await logger.warn('self-update', 'engine rolled back from .bak', { enginePath });
      return true;
    } catch (error) {
      await logger.error('self-update', 'rollback failed; .bak kept for manual recovery', {
        enginePath,
        detail: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private fileName(): string {
    return this.deps.componentFileName ?? 'yt-dlp.exe';
  }

  private label(): string {
    return this.deps.componentLabel ?? this.fileName();
  }

  async update(): Promise<UpdateResult> {
    const { ports, logger, source, intakeGate, enginePath, channel } = this.deps;
    const fromVersion = await this.installedVersion();

    // 1) Checksum manifest — the only trusted source of truth.
    let entry: ChecksumEntry | null;
    try {
      entry = parseChecksums(await source.fetchChecksums(), this.fileName());
    } catch (error) {
      await logger.error('self-update', 'checksum manifest unavailable', {
        source: source.kind,
        detail: error instanceof Error ? error.message : String(error),
      });
      return this.result(fromVersion, fromVersion, false, 'manifest-unavailable');
    }
    if (entry === null) {
      await logger.warn('self-update', `no checksum line for ${this.fileName()}; refusing to swap`, {
        source: source.kind,
        component: this.label(),
      });
      return this.result(fromVersion, fromVersion, false, 'no-checksum-line');
    }

    // 1b) Already current? Skip the write entirely — repeated clicks must be cheap
    //     and must never churn a working binary.
    try {
      if (await ports.fs.exists(enginePath)
        && (await ports.hash.sha256File(enginePath)).toLowerCase() === entry.sha256) {
        await logger.info('self-update', 'component already up to date', {
          component: this.label(), version: fromVersion,
        });
        return this.result(fromVersion, fromVersion, false, 'up-to-date');
      }
    } catch {
      // A read error means "unknown", not "current" — fall through and update.
    }

    // 2) Binary + verify BEFORE touching the disk.
    let bytes: Uint8Array;
    try {
      bytes = await source.fetchEngineBinary();
    } catch (error) {
      await logger.error('self-update', 'engine binary download failed', {
        source: source.kind,
        detail: error instanceof Error ? error.message : String(error),
      });
      return this.result(fromVersion, fromVersion, false, 'download-failed');
    }

    const actual = (await ports.hash.sha256Bytes(bytes)).toLowerCase();
    if (actual !== entry.sha256) {
      await logger.error('self-update', 'checksum mismatch; nothing written', {
        expected: entry.sha256,
        actual,
        source: source.kind,
      });
      return this.result(fromVersion, fromVersion, false, 'checksum-mismatch');
    }

    // 3) Pause intake, wait for the slots to drain, swap, verify, clean up.
    intakeGate?.pause();
    // D-171: `pause()` stops new work only; a transfer that is already running
    // keeps `yt-dlp.exe` open and the rename below fails. Wait for the queue to
    // go idle, and refuse to swap at all when it does not.
    const idle = intakeGate?.waitForIdle === undefined
      ? true
      : await intakeGate.waitForIdle(QUEUE_IDLE_TIMEOUT_MS);
    if (!idle) {
      await logger.error('self-update', 'queue still busy; update deferred', {
        timeoutMs: QUEUE_IDLE_TIMEOUT_MS,
      });
      return this.result(fromVersion, fromVersion, false, 'queue-busy');
    }
    try {
      if (await ports.fs.exists(enginePath)) {
        await ports.fs.writeBytesAtomic(`${enginePath}.bak`, await ports.fs.readBytes(enginePath));
      }
      await ports.fs.writeBytesAtomic(`${enginePath}.new`, bytes);
      await ports.fs.rename(`${enginePath}.new`, enginePath);

      const swapped = (await ports.hash.sha256File(enginePath)).toLowerCase();
      if (swapped !== entry.sha256) {
        await logger.error('self-update', 'post-swap checksum mismatch; rolling back', {
          expected: entry.sha256,
          actual: swapped,
        });
        const rolledBack = await this.rollback();
        return this.result(fromVersion, fromVersion, false, 'checksum-mismatch', rolledBack);
      }

      await ports.fs.unlink(`${enginePath}.bak`);
      const toVersion = await this.installedVersion();
      await logger.info('self-update', 'component updated', {
        component: this.label(), fromVersion, toVersion, channel,
      });
      return this.result(fromVersion, toVersion, true);
    } catch (error) {
      await logger.error('self-update', 'swap failed; rolling back', {
        detail: error instanceof Error ? error.message : String(error),
      });
      const rolledBack = await this.rollback();
      return this.result(fromVersion, fromVersion, false, 'swap-failed', rolledBack);
    } finally {
      // Never leave the queue parked, even if the process is about to die.
      intakeGate?.resume();
    }
  }
}
