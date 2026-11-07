/**
 * Pure argv builders for the OS shell adapter (A-4.6-02).
 * Zero I/O; the adapter passes these arrays straight to `explorer.exe`.
 */

export type ShellOperation = 'open' | 'reveal';

/**
 * `explorer.exe` argument vector.
 * - open:   `explorer.exe "<path>"`
 * - reveal: `explorer.exe /select,"<path>"` (single argument, comma-joined)
 *
 * M2 boundary: this only proves the *arguments* are correct. Actually launching
 * the user's default player requires Electron `shell` (M3).
 */
export function buildExplorerArgv(operation: ShellOperation, targetPath: string): string[] {
  if (operation === 'open') return [targetPath];
  return [`/select,${targetPath}`];
}
