/**
 * The error normaliser, split out of `task-queue.ts` (task-6 refactor).
 *
 * `toAppError` was moved VERBATIM from `task-queue.ts` — behaviour is
 * byte-identical. It is pure: it maps an unknown thrown value onto the
 * `AppError` shape (passing through anything that already IS one, filling the
 * report string otherwise) and never touches the queue's mutable state, so the
 * class keeps owning every error FIELD (`record.error`) and every transition
 * decision around it.
 */
import type { AppError } from '@ytvdlt/shared';

export function toAppError(error: unknown): AppError {
  const candidate = error as Partial<AppError>;
  if (typeof candidate?.code === 'string' && typeof candidate.message === 'string') {
    return {
      code: candidate.code,
      message: candidate.message,
      detail: candidate.detail ?? '',
      retryable: candidate.retryable ?? true,
      report: candidate.report ?? `${candidate.code}: ${candidate.message}`,
    };
  }
  return {
    code: 'UNKNOWN', message: '未知错误', detail: String(error), retryable: true,
    report: `UNKNOWN: ${String(error)}`,
  };
}
