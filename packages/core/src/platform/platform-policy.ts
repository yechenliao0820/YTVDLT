/**
 * Platform policy (M5 · A-4.6-07) — desktop replacements for Android-only
 * behaviour, plus the "no residual Android UI" check.
 *
 * A-4.6-07 reads: "无残留 Android 专用 UI 或报错；改为可选「开机自启/后台运行」".
 * Two concrete things follow:
 *   1. auto-start is OPTIONAL and per-user (HKCU Run), never HKLM / never admin;
 *   2. the shipped UI must not contain Android-only calls or permission text
 *      (`HapticFeedback`, `Toast.makeText`, `android.permission.*`, ...).
 *
 * `findAndroidResidue()` is used by the test against the REAL `packages/ui/src`
 * tree, so a stray Android string in a page fails the build instead of shipping.
 */

export interface AutostartPlan {
  readonly supported: boolean;
  readonly action: 'set' | 'remove' | 'none';
  /** `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run` on Windows. */
  readonly registryPath: string | null;
  readonly valueName: string;
  /** Command line written to the Run key (quoted exe path). */
  readonly command: string | null;
  /** Auto-start must never require elevation. */
  readonly requiresAdmin: false;
}

export interface AutostartInput {
  readonly enabled: boolean;
  readonly platform: string;
  readonly exePath: string;
  /** Defaults to `YTVDLT`. */
  readonly valueName?: string;
}

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/** Windows: per-user Run key. macOS/Linux: unsupported in this milestone. */
export function planAutostart(input: AutostartInput): AutostartPlan {
  const valueName = input.valueName ?? 'YTVDLT';
  if (input.platform !== 'win32') {
    return {
      supported: false,
      action: 'none',
      registryPath: null,
      valueName,
      command: null,
      requiresAdmin: false,
    };
  }
  return {
    supported: true,
    action: input.enabled ? 'set' : 'remove',
    registryPath: RUN_KEY,
    valueName,
    command: `"${input.exePath}" --autostart`,
    requiresAdmin: false,
  };
}

/** Strings that only exist in the Android client; none may survive in the UI. */
export const ANDROID_ONLY_MARKERS: readonly string[] = [
  'android.permission.',
  'HapticFeedback',
  'Toast.makeText',
  'ActivityCompat',
  'onBackPressed',
  'Monet',
  'AndroidManifest',
  'WRITE_EXTERNAL_STORAGE',
  'foregroundServiceType',
];

export interface SourceFile {
  readonly file: string;
  readonly text: string;
}

export interface ResidueFinding {
  readonly file: string;
  readonly marker: string;
  readonly line: number;
}

/** Line-by-line scan, so the report can point at the exact place. */
export function findAndroidResidue(sources: readonly SourceFile[]): readonly ResidueFinding[] {
  const findings: ResidueFinding[] = [];
  for (const source of sources) {
    const lines = source.text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const marker of ANDROID_ONLY_MARKERS) {
        if (line.includes(marker)) {
          // One finding per line: overlapping markers are not separate defects.
          findings.push({ file: source.file, marker, line: index + 1 });
          break;
        }
      }
    });
  }
  return findings;
}

/** Progress used by both the tray tooltip and the queue header (§5.1). */
export function concurrencyLabel(active: number, limit: number): string {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 1;
  const safeActive = Number.isFinite(active) && active > 0 ? Math.trunc(active) : 0;
  return `${safeActive}/${safeLimit}`;
}
