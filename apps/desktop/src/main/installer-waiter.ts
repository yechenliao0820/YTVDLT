/**
 * D-284 / D-289 / D-291 · schedule the verified installer to start AFTER this
 * process has exited.
 *
 * Why a waiter at all: the NSIS package runs `_CHECK_APP_RUNNING` in `.onInit`.
 * If the app is still alive it shows a 确定/取消 box — **取消 quits the
 * installer** — and its kill step matches by `$INSTDIR` prefix, so a helper or
 * the old uninstaller can keep a retry loop alive. Launching with `--updated`
 * (the parameter `StdUtils.TestParameter "updated"` reads) skips every dialog;
 * waiting for our PID first removes the race entirely.
 *
 * Why the ACK handshake (D-291): the previous implementation resolved `true`
 * on the child's `spawn` event, which only proves that a PowerShell PROCESS was
 * created — not that the script runs. An AV / group-policy block can kill it a
 * moment later, and the app then quit 300 ms later with no installer scheduled
 * and no fallback. The waiter's FIRST statement writes an ACK file; only that
 * file makes the scheduling "confirmed". Without it the waiter is killed (it
 * must never launch the installer behind a still-running app) and the caller
 * falls back to `openPath`.
 *
 * Extracted from `electron-entry.ts` so the handshake is unit-testable without
 * importing Electron.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { stat as statFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The narrow child surface this module needs (fakes stay trivial). */
export interface WaiterChild {
  /**
   * `ChildProcess.pid` is `number | undefined` under
   * `exactOptionalPropertyTypes`, so the optional slot spells `undefined` out.
   */
  readonly pid?: number | undefined;
  once(event: 'error' | 'exit', listener: () => void): void;
  unref(): void;
}

export interface InstallerWaiterDeps {
  readonly pid: number;
  readonly spawn: (command: string, args: readonly string[], options: SpawnOptions) => WaiterChild;
  readonly statIsFile: (path: string) => Promise<boolean>;
  readonly remove: (path: string) => Promise<void>;
  /** Test seam: shorten the 3 s ACK window / 100 ms poll. */
  readonly ackTimeoutMs?: number;
  readonly pollMs?: number;
  /** Test seam: record the kill instead of spawning `taskkill`. */
  readonly killTree?: (pid: number) => void;
}

const DEFAULT_ACK_TIMEOUT_MS = 3_000;
const DEFAULT_POLL_MS = 100;

function defaultKillTree(pid: number): void {
  try {
    const killer = nodeSpawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true, stdio: 'ignore', detached: true,
    });
    killer.once('error', () => undefined);
    killer.unref();
  } catch { /* best effort */ }
}

/**
 * Build the PowerShell one-liner. Installer and ACK paths travel through the
 * ENVIRONMENT, never interpolated into the command text — a quoting mistake
 * there would be a command-injection seam.
 */
function waiterScript(pid: number): string {
  return [
    // D-291: FIRST statement — a running script is the only proof that the
    // waiter will still be alive after this process exits.
    'try { Set-Content -LiteralPath $env:YTVDLT_LAUNCH_ACK -Value $PID -ErrorAction Stop } catch { }',
    '$deadline = (Get-Date).AddSeconds(45)',
    `while ((Get-Process -Id ${pid} -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 200 }`,
    '$ok = $false',
    'for ($i = 0; $i -lt 3 -and -not $ok; $i++) { try { Start-Process -FilePath $env:YTVDLT_INSTALLER -ArgumentList \'--updated\' -ErrorAction Stop; $ok = $true } catch { Start-Sleep -Milliseconds 700 } }',
    'try { Add-Content -Path $env:YTVDLT_LAUNCH_LOG -Value ((Get-Date -Format o) + $(if ($ok) { " launched: " } else { " launch failed: " }) + $env:YTVDLT_INSTALLER) -ErrorAction Stop } catch { }',
  ].join('; ');
}

export function scheduleInstallerAfterExit(
  installerPath: string,
  deps: InstallerWaiterDeps,
): Promise<boolean> {
  const ackTimeoutMs = deps.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const killTree = deps.killTree ?? defaultKillTree;
  // One ACK file per attempt: a stale file from an earlier run must never be
  // read as this attempt's confirmation.
  const ackPath = join(dirname(installerPath), `installer-launch.${deps.pid}.ack`);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearInterval(timer);
      resolve(ok);
    };
    let child: WaiterChild;
    try {
      child = deps.spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', waiterScript(deps.pid),
      ], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          YTVDLT_INSTALLER: installerPath,
          YTVDLT_LAUNCH_ACK: ackPath,
          // D-289: the only channel left after this process exits.
          YTVDLT_LAUNCH_LOG: join(dirname(installerPath), 'installer-launch.log'),
        },
      });
    } catch {
      resolve(false);
      return;
    }
    child.once('error', () => finish(false));
    // Exiting before the ACK means the script never ran (blocked / killed).
    child.once('exit', () => finish(false));
    const deadline = Date.now() + ackTimeoutMs;
    timer = setInterval(() => {
      void deps.statIsFile(ackPath).then((isFile) => {
        if (!isFile) return;
        child.unref();
        void deps.remove(ackPath).catch(() => undefined);
        finish(true);
      }).catch(() => undefined);
      if (Date.now() >= deadline) {
        if (child.pid !== undefined) killTree(child.pid);
        finish(false);
      }
    }, pollMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

/** Production wiring (kept here so electron-entry stays a thin composition root). */
export function realInstallerWaiter(installerPath: string): Promise<boolean> {
  return scheduleInstallerAfterExit(installerPath, {
    pid: process.pid,
    spawn: (command, args, options) => nodeSpawn(command, [...args], options) as ChildProcess,
    statIsFile: async (path) => (await statFile(path)).isFile(),
    remove: async (path) => { await unlink(path); },
  });
}
