/**
 * Task log buffer (M4-5) — per-task, bounded, redaction-friendly line store.
 *
 * The UI's "任务日志页" needs line-by-line output with copy / cancel / retry.
 * Lines are stored as an ARRAY (never one big string) so the renderer can
 * virtualise and copy exactly what it shows. Control characters are stripped
 * and multi-line chunks are split, so a single `\r` progress refresh cannot
 * grow one giant line.
 */
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export interface TaskLogOptions {
  /** Ring size per task. Defaults to 2000 lines. */
  maxLinesPerTask?: number;
}

export class TaskLogBuffer {
  private readonly maxLines: number;
  private readonly lines = new Map<string, string[]>();

  constructor(options: TaskLogOptions = {}) {
    this.maxLines = Math.max(10, Math.trunc(options.maxLinesPerTask ?? 2000));
  }

  /** Append a chunk; newlines split into separate entries, blank lines kept. */
  append(taskId: string, chunk: string): void {
    if (typeof chunk !== 'string' || chunk.length === 0) return;
    const clean = chunk.replace(CONTROL_RE, '');
    const parts = clean.split(/\r?\n/);
    // A trailing newline produces a final empty entry: drop it (it is not a line yet).
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
    const target = this.lines.get(taskId) ?? [];
    for (const part of parts) {
      target.push(part);
      if (target.length > this.maxLines) target.shift();
    }
    this.lines.set(taskId, target);
  }

  /** Last `limit` lines (default 200). */
  tail(taskId: string, limit = 200): readonly string[] {
    const target = this.lines.get(taskId);
    if (target === undefined) return [];
    const count = Math.max(1, Math.trunc(limit));
    return target.slice(Math.max(0, target.length - count));
  }

  /** All retained lines for "复制日志". */
  all(taskId: string): readonly string[] {
    return [...(this.lines.get(taskId) ?? [])];
  }

  /** Clipboard payload: plain text, one line per entry. */
  copy(taskId: string): string {
    return this.all(taskId).join('\n');
  }

  size(taskId: string): number {
    return (this.lines.get(taskId) ?? []).length;
  }

  taskIds(): readonly string[] {
    return [...this.lines.keys()];
  }

  clear(taskId: string): boolean {
    return this.lines.delete(taskId);
  }

  clearAll(): void {
    this.lines.clear();
  }
}
