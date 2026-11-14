/**
 * D-166 — Windows "start with the system" adapter.
 *
 * Why this file exists: `planAutostart()` in `@ytvdlt/core` has been the
 * documented policy since M4 (HKCU Run key, quoted exe path, `--autostart`,
 * never elevation) and had ZERO callers — the settings switch wrote a debug
 * `<pre>` and nothing else. The policy stays pure; this adapter is the only
 * place that touches the registry.
 *
 * Hard rules:
 *  - `HKCU` only. `AutostartPlan.requiresAdmin` is `false` by contract: writing
 *    `HKLM` would need elevation and would break the "no admin" install story.
 *  - `reg.exe` is spawned with an argv ARRAY and `shell: false`. A value name or
 *    path containing spaces/quotes must never be re-parsed by a shell.
 *  - `read()` queries the real registry, so the toggle cannot lie after a user
 *    (or another installer) removes the entry behind the app's back.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { planAutostart, type AutostartPlan } from '@ytvdlt/core';
import type { ISystemStartupPort } from '@ytvdlt/shared';

export interface WinStartupOptions {
  /** Absolute path of the application executable. */
  readonly exePath: string;
  /** Defaults to `process.platform`; injected in tests. */
  readonly platform?: string;
  /** Defaults to `%SystemRoot%\System32\reg.exe`; injected in tests. */
  readonly regExe?: string;
  /** Runs one `reg` invocation; injected in tests so no registry is touched. */
  readonly runReg?: (args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  readonly valueName?: string;
}

function defaultRegExe(): string {
  const root = process.env['SystemRoot'] ?? 'C:\\Windows';
  return join(root, 'System32', 'reg.exe');
}

function runRegProcess(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(defaultRegExe(), [...args], { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error: Error) => { resolve({ code: -1, stdout, stderr: error.message }); });
    child.on('close', (code: number | null) => { resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

/**
 * D-194 · `reg.exe` LOCALISES its "value not found" diagnostic. English is not
 * the only locale: a Simplified-Chinese Windows prints
 * `错误: 系统找不到指定的注册表项或值。`, Traditional Chinese `錯誤: 系統找不到…`,
 * Japanese `…見つかりませんでした。`. Matching `/unable to find/` alone made
 * `read()` throw for an already-absent value — the settings toggle then fell
 * back to a possibly stale config mirror — and `apply(false)` reported a
 * failure for what is already the desired end state.
 *
 * Deliberately POSITIVE and narrow: an unknown locale still fails closed
 * (throws / reports failure), and a real error such as "Access is denied." is
 * never mistaken for absence.
 *
 * D-205 · per-phrase provenance for every alternative below. Each entry is a
 * MULTI-WORD phrase (never a bare verb such as `finden` / `trouver` /
 * `найти`, which would over-match unrelated prose), matched against
 * `stderr` of a reg.exe run that already exited with code 1 (see
 * `isRegValueAbsent`). Source levels: "real-run" = executed against real
 * reg.exe on this zh-CN dev host (2026-11-14, OEM code page 936);
 * "documented" = Microsoft docs / published reg.exe localisation strings,
 * NOT reproduced locally.
 *   en-US  "ERROR: The system was unable to find the specified registry key or value."
 *          → `unable to find` [documented: Microsoft Learn troubleshooting pages]
 *   zh-CN  "错误: 系统找不到指定的注册表项或值。"
 *          → `找不到` / `不存在` / `未找到` [real-run 2026-11-14, exit 1 on stderr]
 *   zh-TW  "錯誤: 系統找不到指定的登錄機碼或值。" → `找不到` [documented]
 *   ja-JP  "エラー: 指定されたレジストリ キーまたは値が見つかりませんでした。"
 *          → `見つかりません` [documented]
 *   de-DE  "FEHLER: Das System kann den angegebenen Registrierungsschlüssel oder -wert nicht finden."
 *          → `nicht finden` [documented: Microsoft Learn (de-de) + reproduced reports]
 *   fr-FR  "ERREUR : Le système n'a pas pu trouver la clé ou la valeur du Registre spécifiée."
 *          → `pas pu trouver` [documented: Microsoft Learn (fr-fr) configure-endpoints-vdi]
 *   ru-RU  "Ошибка: системе не удалось найти указанный раздел реестра или значение."
 *          → `не удалось найти` [documented: reproduced reports, exit 1]
 *   it-IT  "ERRORE: Impossibile trovare la chiave o il valore del Registro di sistema specificato."
 *          → `impossibile trovare` [documented: reproduced reports, exit 1];
 *          doc wording "Il sistema non è riuscito a trovare la chiave o il valore specificato."
 *          → `non è riuscito a trovare` [documented: Microsoft Learn (it-it)]
 *   es-ES  "ERROR: no puede encontrar la clave o el valor del Registro especificados."
 *          → `no puede encontrar` [documented: reproduced reports];
 *          doc wording "…el sistema no pudo encontrar la clave o valor especificado."
 *          → `no pudo encontrar` [documented: Microsoft Learn (es-es)]
 *   ko-KR  "오류: 시스템이 지정된 레지스트리 키 또는 값을 찾을 수 없습니다."
 *          → `찾을 수 없` [documented: vendor docs quoting Korean reg.exe]
 *   pt-BR  "ERRO: O sistema não pôde encontrar a chave ou o valor do Registro especificado."
 *          → `não pôde encontrar` [documented: reproduced reports]
 * Fail-closed guarantees (pinned by tests): none of the phrases above occurs
 * in any locale's Access-Denied diagnostic ("Access is denied." / "错误: 拒绝访问。"
 * [zh-CN real-run] / "Zugriff verweigert" / "Accès refusé" / "Отказано в доступе" /
 * "Accesso negato" / "Acceso denegado" / "액세스가 거부되었습니다." / "Acesso negado",
 * the non-zh ones documented), in localized SUCCESS output ("操作成功完成。"
 * [real-run], "The operation completed successfully."), or in a value dump;
 * and an unknown locale (e.g. Polish) still fails closed.
 */
const REG_NOT_FOUND_RE =
  /unable to find|找不到|不存在|未找到|見つかりません|nicht finden|pas pu trouver|не удалось найти|impossibile trovare|non è riuscito a trovare|no puede encontrar|no pudo encontrar|찾을 수 없|não pôde encontrar/i;

/** True only for a confirmed "key or value does not exist" reg failure. */
export function isRegValueAbsent(result: {
  readonly code: number; readonly stdout: string; readonly stderr: string;
}): boolean {
  return result.code === 1 && REG_NOT_FOUND_RE.test(result.stderr);
}

/** `reg query` prints `    YTVDLT    REG_SZ    "C:\...\YTVDLT.exe" --autostart`. */
export function parseRegQueryValue(stdout: string, valueName: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s{2,}(\S.*?)\s{2,}REG_SZ\s{2,}(.*)$/.exec(line);
    if (match === null) continue;
    const [, name, value] = match;
    if (name === valueName) return (value ?? '').trim();
  }
  return null;
}

/** Build the exact argv for one plan. Pure, so it is unit-testable. */
export function planToRegArgs(plan: AutostartPlan): readonly string[] {
  if (!plan.supported || plan.registryPath === null) return [];
  if (plan.action === 'remove') {
    return ['delete', plan.registryPath, '/v', plan.valueName, '/f'];
  }
  if (plan.action === 'set' && plan.command !== null) {
    return ['add', plan.registryPath, '/v', plan.valueName, '/t', 'REG_SZ', '/d', plan.command, '/f'];
  }
  return [];
}

export function createWinStartup(options: WinStartupOptions): ISystemStartupPort {
  const platform = options.platform ?? process.platform;
  const valueName = options.valueName ?? 'YTVDLT';
  const runReg = options.runReg ?? runRegProcess;

  const planFor = (enabled: boolean): AutostartPlan => planAutostart({
    enabled,
    platform,
    exePath: options.exePath,
    ...(options.valueName === undefined ? {} : { valueName: options.valueName }),
  });

  return {
    async apply(enabled: boolean): Promise<{ ok: boolean; reason?: string }> {
      const plan = planFor(enabled);
      if (!plan.supported) return { ok: false, reason: 'unsupported-platform' };
      const args = planToRegArgs(plan);
      if (args.length === 0) return { ok: false, reason: 'nothing-to-do' };
      const result = await runReg(args);
      // `reg delete` returns 1 when the value is already absent — that is the
      // desired end state, not a failure.
      if (result.code !== 0 && !(plan.action === 'remove' && isRegValueAbsent(result))) {
        return { ok: false, reason: `reg exited ${result.code}` };
      }
      return { ok: true };
    },

    /**
     * The settings toggle shows this value, so a FAILED query must not
     * masquerade as "off" — it throws and lets the channel layer fall back to
     * the config mirror. Only a confirmed absence (see `isRegValueAbsent`,
     * locale-aware; the same tolerance the `reg delete` above enjoys) reads
     * `false`.
     */
    async read(): Promise<boolean> {
      const plan = planFor(true);
      if (!plan.supported || plan.registryPath === null) {
        throw new Error('autostart: unsupported platform');
      }
      const result = await runReg(['query', plan.registryPath, '/v', valueName]);
      if (result.code === 0) return parseRegQueryValue(result.stdout, valueName) !== null;
      if (isRegValueAbsent(result)) return false;
      throw new Error(`autostart read failed: reg exited ${result.code}`);
    },
  };
}
