/**
 * ErrorMapper — stderr keyword → ErrorCode + zh-CN message + retryable +
 * fully-redacted `report`. Ordered rules with FIRST-match semantics.
 * Pure logic: no I/O, no `node:*` / `electron` imports.
 * Report generation is one of the three MANDATORY redaction exits (§4.6).
 */
import type { AppError, ErrorCode, ErrorContext, ClockPort } from '@ytvdlt/shared';
import type { IErrorMapper } from '../ports.js';
import { redact, redactText, redactArgv } from '../logger/redactor.js';
import { ORDERED_RULES, UNKNOWN_RULE, CODE_META, type ErrorRule } from './rules.js';

export interface ErrorMapperDeps {
  clock?: ClockPort;
}

function defaultClock(): ClockPort {
  return {
    nowIso: () => new Date().toISOString(),
    nowEpochMs: () => Date.now(),
  };
}

export class ErrorMapper implements IErrorMapper {
  private readonly clock: ClockPort;

  constructor(deps: ErrorMapperDeps = {}) {
    this.clock = deps.clock ?? defaultClock();
  }

  /** First matching rule wins; never throws. */
  map(stderr: string, ctx: ErrorContext): AppError {
    const rule = ORDERED_RULES.find((candidate) =>
      candidate.patterns.some((pattern) => pattern.test(stderr)),
    ) ?? UNKNOWN_RULE;
    return this.build(rule.code, rule.message, rule.retryable, stderr, ctx);
  }

  /** Proactive construction (INVALID_URL pre-check, runtime-missing codes, etc.). */
  fromCode(code: ErrorCode, ctx: ErrorContext): AppError {
    const meta = CODE_META[code];
    return this.build(code, meta.message, meta.retryable, ctx.stderr, ctx);
  }

  private build(
    code: ErrorCode,
    message: string,
    retryable: boolean,
    stderr: string,
    ctx: ErrorContext,
  ): AppError {
    const detail = redactText(stderr);
    const reportObject = {
      timestamp: this.clock.nowIso(),
      os: redactText(ctx.os),
      appVersion: redactText(ctx.appVersion),
      engineVersion: redactText(ctx.engineVersion),
      code,
      message,
      url: redactText(ctx.url),
      stderr: detail,
      argv: redactArgv(ctx.argv ?? []),
      retryable,
    };
    const report = JSON.stringify(redact(reportObject));
    return { code, message, detail, retryable, report };
  }
}
