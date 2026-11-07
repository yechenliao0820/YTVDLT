/**
 * Error report builder (M4-6).
 *
 * The report is what the user pastes into an issue: OS / app / engine versions,
 * the URL, the task state and the FULL stderr — with every credential masked.
 *
 * Redaction happens HERE, not in the UI: `redactText()` covers `Cookie`,
 * `Authorization`, bearer tokens and URL userinfo, and `maskUrlSecrets()` covers
 * signed-query parameters (`token`, `sig`, `expire`, `key`, ...). `MediaFormat.url`
 * is never included because the report only reads the top-level task fields.
 */
import type { TaskRecord } from '@ytvdlt/shared';
import { redactText, REDACTED } from '../logger/redactor.js';

export interface ErrorReportInput {
  readonly task: TaskRecord;
  readonly appVersion: string;
  readonly engineVersion: string;
  readonly os: string;
  readonly stderr?: string;
  readonly argv?: readonly string[];
}

export interface ErrorReport {
  readonly generatedAt: string;
  readonly os: string;
  readonly appVersion: string;
  readonly engineVersion: string;
  readonly taskId: string;
  readonly url: string;
  readonly state: string;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly lastPercent: number | null;
  readonly artifactCount: number;
  readonly stderr: string;
  readonly argv: readonly string[];
}

const SECRET_QUERY_KEYS = new Set([
  'token', 'access_token', 'id_token', 'sig', 'signature', 'expire', 'expires',
  'exp', 'key', 'apikey', 'api_key', 'auth', 'authorization', 'password', 'secret',
  'sp', 'sparams', 'po_token', 'potoken',
]);

/**
 * Mask the VALUES of signed/session query parameters, keep the shape readable.
 *
 * Deliberately does NOT run the generic `redactText()` inline-secret pass over
 * the whole URL: that rule consumes the rest of the line (`token=***` would
 * swallow `&sig=…`). URL userinfo is masked separately here.
 */
export function maskUrlSecrets(raw: string): string {
  const text = String(raw).replace(/[\u0000-\u001f\u007f]/g, '');
  const withUserinfoMasked = text.replace(
    /^(https?:\/\/)([^/@\s]+):([^/@\s]+)@/i,
    (_match, scheme: string) => `${scheme}***:***@`,
  );
  const questionMark = withUserinfoMasked.indexOf('?');
  if (questionMark === -1) return withUserinfoMasked;
  const head = withUserinfoMasked.slice(0, questionMark);
  const tail = withUserinfoMasked.slice(questionMark + 1);
  const hashIndex = tail.indexOf('#');
  const query = hashIndex === -1 ? tail : tail.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : tail.slice(hashIndex);
  const masked = query.split('&').map((pair) => {
    const equals = pair.indexOf('=');
    if (equals === -1) return pair;
    const name = pair.slice(0, equals);
    return SECRET_QUERY_KEYS.has(name.toLowerCase()) ? `${name}=${REDACTED}` : pair;
  });
  return `${head}?${masked.join('&')}${fragment}`;
}

/** Cap stderr so a 20 MB log cannot be pasted into a textarea. */
const MAX_STDERR_LINES = 400;

export function buildErrorReport(input: ErrorReportInput, generatedAt: string): ErrorReport {
  const { task } = input;
  const stderrLines = redactText(input.stderr ?? '').split(/\r?\n/);
  const stderr = stderrLines.slice(0, MAX_STDERR_LINES).join('\n');
  const argv = (input.argv ?? []).map((token) => maskUrlSecrets(token));
  return {
    generatedAt,
    os: input.os,
    appVersion: input.appVersion,
    engineVersion: input.engineVersion,
    taskId: task.id,
    url: maskUrlSecrets(task.url),
    state: task.state,
    errorCode: task.error?.code ?? null,
    errorMessage: task.error === null ? null : redactText(task.error.message),
    lastPercent: task.lastPercent,
    artifactCount: task.artifacts.length,
    stderr,
    argv,
  };
}

/** Plain-text rendering used by "复制错误报告". */
export function formatErrorReport(report: ErrorReport): string {
  return [
    `YTVDLT error report (${report.generatedAt})`,
    `OS: ${report.os}`,
    `App: ${report.appVersion}`,
    `Engine: ${report.engineVersion}`,
    `Task: ${report.taskId}`,
    `State: ${report.state}`,
    `Code: ${report.errorCode ?? '-'}`,
    `Message: ${report.errorMessage ?? '-'}`,
    `Progress: ${report.lastPercent ?? '-'}%`,
    `URL: ${report.url}`,
    `Artifacts: ${report.artifactCount}`,
    '--- argv ---',
    report.argv.join(' '),
    '--- stderr ---',
    report.stderr,
  ].join('\n');
}
