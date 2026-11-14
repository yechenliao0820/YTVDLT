/**
 * D-166 (+ its follow-up) · the Windows autostart adapter.
 *
 * Every test runs against an injected `runReg` double, so no real registry
 * value is ever touched. What is pinned:
 *   - reg.exe is driven by argv arrays (the `shell: false` story);
 *   - `reg delete` on an already-absent value is the desired end state, other
 *     nonzero exits are failures;
 *   - `read()` reports the REAL entry state and THROWS on a query that failed,
 *     so the settings toggle can fall back to the config mirror instead of
 *     silently showing "off" for an unknown state.
 */
import { describe, it, expect } from 'vitest';
import { planAutostart } from '@ytvdlt/core';
import {
  createWinStartup, parseRegQueryValue, planToRegArgs, isRegValueAbsent,
} from '../../apps/desktop/src/main/adapters/win-startup.js';

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_LINE = '    YTVDLT    REG_SZ    "C:\\Program Files\\YTVDLT\\YTVDLT.exe" --autostart';
const ABSENT_STDERR = 'ERROR: The system was unable to find the specified registry key or value.';
/** D-194: `reg.exe` localises this line; English is not the only Windows locale. */
const ABSENT_LOCALIZED = [
  '错误: 系统找不到指定的注册表项或值。',          // zh-CN
  '錯誤: 系統找不到指定的登錄機碼或值。',          // zh-TW
  'エラー: 指定されたレジストリ キーまたは値が見つかりませんでした。', // ja-JP
];

type RegResult = { code: number; stdout: string; stderr: string };

function winAdapter(runReg: (args: readonly string[]) => Promise<RegResult>) {
  return createWinStartup({ exePath: 'C:\\Program Files\\YTVDLT\\YTVDLT.exe', platform: 'win32', runReg });
}

describe('win-startup · reg query output parsing (pure)', () => {
  it('reads the value line of a reg query dump', () => {
    expect(parseRegQueryValue(VALUE_LINE, 'YTVDLT'))
      .toBe('"C:\\Program Files\\YTVDLT\\YTVDLT.exe" --autostart');
  });

  it('ignores other value names, the key header and empty output', () => {
    const stdout = [RUN_KEY, '    OtherApp    REG_SZ    C:\\other.exe', VALUE_LINE].join('\n');
    expect(parseRegQueryValue(stdout, 'YTVDLT')).toContain('--autostart');
    expect(parseRegQueryValue(stdout, 'Missing')).toBeNull();
    expect(parseRegQueryValue('', 'YTVDLT')).toBeNull();
  });
});

describe('win-startup · plan → reg argv (pure)', () => {
  it('builds the add argv for a set plan', () => {
    const plan = planAutostart({ enabled: true, platform: 'win32', exePath: 'C:/Program Files/YTVDLT/YTVDLT.exe' });
    expect(planToRegArgs(plan)).toEqual([
      'add', RUN_KEY, '/v', 'YTVDLT', '/t', 'REG_SZ',
      '/d', '"C:/Program Files/YTVDLT/YTVDLT.exe" --autostart', '/f',
    ]);
  });

  it('builds the delete argv for a remove plan and nothing for unsupported ones', () => {
    const plan = planAutostart({ enabled: false, platform: 'win32', exePath: 'C:/x.exe' });
    expect(planToRegArgs(plan)).toEqual(['delete', RUN_KEY, '/v', 'YTVDLT', '/f']);
    expect(planToRegArgs(planAutostart({ enabled: true, platform: 'darwin', exePath: '/x' }))).toEqual([]);
  });
});

describe('win-startup · apply()', () => {
  it('spawns reg add for the enabled state', async () => {
    const calls: string[][] = [];
    const port = winAdapter(async (args) => {
      calls.push([...args]);
      return { code: 0, stdout: '', stderr: '' };
    });
    await expect(port.apply(true)).resolves.toEqual({ ok: true });
    expect(calls[0]?.[0]).toBe('add');
    expect(calls[0]?.[1]).toBe(RUN_KEY);
  });

  it('treats deleting an already-absent value as success, other exits as failure', async () => {
    const absent = winAdapter(async () => ({ code: 1, stdout: '', stderr: ABSENT_STDERR }));
    await expect(absent.apply(false)).resolves.toEqual({ ok: true });
    const broken = winAdapter(async () => ({ code: 1, stdout: '', stderr: 'Access is denied.' }));
    await expect(broken.apply(false)).resolves.toMatchObject({ ok: false });
  });

  it('never spawns reg on unsupported platforms', async () => {
    let calls = 0;
    const port = createWinStartup({
      exePath: '/x', platform: 'darwin',
      runReg: async () => { calls += 1; return { code: 0, stdout: '', stderr: '' }; },
    });
    await expect(port.apply(true)).resolves.toEqual({ ok: false, reason: 'unsupported-platform' });
    expect(calls).toBe(0);
  });
});

describe('win-startup · read() shows the real entry state', () => {
  it('reads true when the value exists, false when a successful query does not list it', async () => {
    const present = winAdapter(async () => ({ code: 0, stdout: VALUE_LINE, stderr: '' }));
    await expect(present.read()).resolves.toBe(true);
    const othersOnly = winAdapter(async () => ({
      code: 0, stdout: `    OtherApp    REG_SZ    C:\\other.exe`, stderr: '',
    }));
    await expect(othersOnly.read()).resolves.toBe(false);
  });

  it('reads false when the Run key or value is confirmed absent', async () => {
    const absent = winAdapter(async () => ({ code: 1, stdout: '', stderr: ABSENT_STDERR }));
    await expect(absent.read()).resolves.toBe(false);
  });

  it('throws on a genuinely failed query instead of lying "off"', async () => {
    const broken = winAdapter(async () => ({ code: 1, stdout: '', stderr: 'Access is denied.' }));
    await expect(broken.read()).rejects.toThrow(/reg exited 1/);
    const spawnless = winAdapter(async () => { throw new Error('spawn failed'); });
    await expect(spawnless.read()).rejects.toThrow(/spawn failed/);
  });

  it('throws on unsupported platforms so the caller can fall back', async () => {
    const port = createWinStartup({
      exePath: '/x', platform: 'darwin',
      runReg: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    await expect(port.read()).rejects.toThrow(/unsupported platform/);
  });
});

// ---------------------------------------------------------------------------
// D-194 · 在线审计 P2：中文 Windows 的「值不存在」判断
// ---------------------------------------------------------------------------
describe('D-194 · localized "value not found" diagnostics', () => {
  it('isRegValueAbsent 正向识别中英日，且对真错误/成功退出保持 false', () => {
    for (const stderr of [ABSENT_STDERR, ...ABSENT_LOCALIZED]) {
      expect(isRegValueAbsent({ code: 1, stdout: '', stderr })).toBe(true);
    }
    expect(isRegValueAbsent({ code: 1, stdout: '', stderr: 'Access is denied.' })).toBe(false);
    expect(isRegValueAbsent({ code: 1, stdout: '', stderr: 'Fehler: unbekannter Fehler' })).toBe(false);
    expect(isRegValueAbsent({ code: 0, stdout: '', stderr: ABSENT_STDERR })).toBe(false);
  });

  it('中文 Windows 删除一个已不存在的值仍是成功终态', async () => {
    for (const stderr of ABSENT_LOCALIZED) {
      const port = winAdapter(async () => ({ code: 1, stdout: '', stderr }));
      await expect(port.apply(false)).resolves.toEqual({ ok: true });
    }
  });

  it('中文 Windows 的 reg query 读到 false，不再抛错回落 config 镜像', async () => {
    for (const stderr of ABSENT_LOCALIZED) {
      const port = winAdapter(async () => ({ code: 1, stdout: '', stderr }));
      await expect(port.read()).resolves.toBe(false);
    }
  });

  it('真错误（拒绝访问）仍按失败处理，不被多语言匹配误吞', async () => {
    const port = winAdapter(async () => ({ code: 1, stdout: '', stderr: '错误: 拒绝访问。' }));
    await expect(port.apply(false)).resolves.toMatchObject({ ok: false });
    await expect(port.read()).rejects.toThrow(/reg exited 1/);
  });
});

// ---------------------------------------------------------------------------
// D-205 · D-194 本地化扩展（de/fr/ru/it/es/ko/pt）+ fail-closed 负例。
//
// 来源等级如实标注（source level, honestly labeled per string):
//   real-run   = 2026-11-14 在本机（zh-CN Windows 10, OEM 代码页 936）用真实
//                reg.exe 跑过：值缺失 → exit 1 + stderr「错误:
//                系统找不到指定的注册表项或值。」；值存在 → exit 0 + stdout
//                值行；reg add/delete 成功 → stdout「操作成功完成。」；
//                拒绝访问（reg query HKLM\SECURITY）→ exit 1 + stderr
//                「错误: 拒绝访问。」。
//   documented = Microsoft 文档 / 已发布的 reg.exe 本地化字符串，未在本机复现。
//                任何字符串在未真实执行前不得标注为 real-run。
// ---------------------------------------------------------------------------
const ABSENT_LOCALIZED_D205: ReadonlyArray<readonly [string, string]> = [
  ['de-DE (documented)', 'FEHLER: Das System kann den angegebenen Registrierungsschlüssel oder -wert nicht finden.'],
  ['fr-FR (documented)', 'ERREUR : Le système n\'a pas pu trouver la clé ou la valeur du Registre spécifiée.'],
  ['ru-RU (documented)', 'Ошибка: системе не удалось найти указанный раздел реестра или значение.'],
  ['it-IT (documented)', 'ERRORE: Impossibile trovare la chiave o il valore del Registro di sistema specificato.'],
  ['it-IT doc variant (documented)', 'Il sistema non è riuscito a trovare la chiave o il valore specificato.'],
  ['es-ES (documented)', 'ERROR: no puede encontrar la clave o el valor del Registro especificados.'],
  ['es-ES doc variant (documented)', 'El sistema no pudo encontrar la clave o valor especificado.'],
  ['ko-KR (documented)', '오류: 시스템이 지정된 레지스트리 키 또는 값을 찾을 수 없습니다.'],
  ['pt-BR (documented)', 'ERRO: O sistema não pôde encontrar a chave ou o valor do Registro especificado.'],
];

/** Access-Denied in every locale must NEVER classify as confirmed absence. */
const ACCESS_DENIED_LOCALIZED_D205: ReadonlyArray<readonly [string, string]> = [
  ['en-US (documented)', 'ERROR: Access is denied.'],
  ['de-DE (documented)', 'FEHLER: Zugriff verweigert.'],
  ['fr-FR (documented)', 'ERREUR : Accès refusé.'],
  ['ru-RU (documented)', 'ОШИБКА: Отказано в доступе.'],
  ['it-IT (documented)', 'ERRORE: Accesso negato.'],
  ['es-ES (documented)', 'ERROR: Acceso denegado.'],
  ['ko-KR (documented)', '오류: 액세스가 거부되었습니다.'],
  ['pt-BR (documented)', 'ERRO: Acesso negado.'],
];

describe('D-205 · localized "value not found" extension (de/fr/ru/it/es/ko/pt) + fail-closed negatives', () => {
  it('isRegValueAbsent: 每个新语种在 exit 1 时确认缺席——且只在 exit 1 时', () => {
    for (const [locale, stderr] of ABSENT_LOCALIZED_D205) {
      expect(isRegValueAbsent({ code: 1, stdout: '', stderr }), `${locale} 应分类为确认缺席`).toBe(true);
      // code 门槛与文本无关：成功退出码永远不会被判为「不存在」。
      expect(isRegValueAbsent({ code: 0, stdout: '', stderr }), `${locale} 在 exit 0 时绝不能算缺席`).toBe(false);
    }
  });

  it('read()/apply(false) 认可新语种：确认缺席读到 false，删除即成功终态', async () => {
    for (const [locale, stderr] of ABSENT_LOCALIZED_D205) {
      const port = winAdapter(async () => ({ code: 1, stdout: '', stderr }));
      await expect(port.read(), `${locale} read()`).resolves.toBe(false);
      await expect(port.apply(false), `${locale} apply(false)`).resolves.toEqual({ ok: true });
    }
  });

  it('全语种 Access-Denied 绝不能被判为「不存在」——read 抛错、delete 失败', async () => {
    for (const [locale, stderr] of ACCESS_DENIED_LOCALIZED_D205) {
      expect(isRegValueAbsent({ code: 1, stdout: '', stderr }), `${locale} 拒绝访问不能算缺席`).toBe(false);
      const port = winAdapter(async () => ({ code: 1, stdout: '', stderr }));
      await expect(port.read(), `${locale} read()`).rejects.toThrow(/reg exited 1/);
      // delete：失败必须透传（现状 reason 保持 'reg exited 1'，不被误吞成 ok:true）。
      await expect(port.apply(false), `${locale} apply(false)`).resolves.toEqual({ ok: false, reason: 'reg exited 1' });
    }
  });

  it('未知语言/乱码 fail-closed：read 抛错（绝不返回 false），delete 绝不视为成功', async () => {
    const unknownErrors: ReadonlyArray<readonly [string, string]> = [
      // 未覆盖的真实语种（pl-PL 风格的「值不存在」句式）——必须保持 fail-closed，
      // 不允许为了兼容而猜测性地归入「确认缺席」。
      ['pl-PL not-found（未覆盖语种）', 'Błąd: system nie może odnaleźć określonego klucza rejestru lub wartości.'],
      ['乱码（代码页解码失败）', '\uFFFD\uFFFD\uFFFD\uFFFD ... ?? \uFFFD'],
      ['仅错误码、无文本', 'reg exited with 0x80070005'],
      ['无关错误文本', 'FEHLER: Unbekannter Fehler.'],
    ];
    for (const [locale, stderr] of unknownErrors) {
      expect(isRegValueAbsent({ code: 1, stdout: '', stderr }), locale).toBe(false);
      const port = winAdapter(async () => ({ code: 1, stdout: '', stderr }));
      await expect(port.read(), `${locale} read()`).rejects.toThrow(/reg exited 1/);
      await expect(port.apply(false), `${locale} apply(false)`).resolves.toMatchObject({ ok: false });
    }
  });

  it('新语种短语绝不吞掉合法的成功输出（有值查询 / 操作成功）', () => {
    // real-run（2026-11-14，zh-CN 本机）：reg query 有值时的真实 stdout 形态。
    const realRunValueDump = [
      '',
      'HKEY_CURRENT_USER\\Software\\YTVDLT_D205',
      '    YTVDLT    REG_SZ    C:\\YTVDLT_D205\\YTVDLT.exe',
      '',
      '',
    ].join('\r\n');
    const successOutputs = [
      realRunValueDump,
      '操作成功完成。',                          // real-run（reg add/delete 成功行）
      'The operation completed successfully.',   // documented 英文成功行
    ];
    for (const output of successOutputs) {
      // 即便串到 stderr 位置（回归围栏），也不能被判为缺席。
      expect(isRegValueAbsent({ code: 1, stdout: '', stderr: output })).toBe(false);
      expect(isRegValueAbsent({ code: 0, stdout: output, stderr: '' })).toBe(false);
    }
  });

  it('delete 三态：缺失→成功；存在→成功；拒绝访问→失败且真实原因透传', async () => {
    // (1) 确认缺席（documented de-DE 句式，exit 1）→ 成功终态。
    const absent = winAdapter(async () => ({
      code: 1, stdout: '',
      stderr: 'FEHLER: Das System kann den angegebenen Registrierungsschlüssel oder -wert nicht finden.',
    }));
    await expect(absent.apply(false)).resolves.toEqual({ ok: true });
    // (2) 值存在（real-run 成功行，exit 0）→ 成功。
    const present = winAdapter(async () => ({ code: 0, stdout: '操作成功完成。', stderr: '' }));
    await expect(present.apply(false)).resolves.toEqual({ ok: true });
    // (3) 拒绝访问（documented de-DE）→ 失败；reason 维持现状透传真实退出码。
    const denied = winAdapter(async () => ({ code: 1, stdout: '', stderr: 'FEHLER: Zugriff verweigert.' }));
    await expect(denied.apply(false)).resolves.toEqual({ ok: false, reason: 'reg exited 1' });
  });
});
