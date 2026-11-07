/**
 * Logger — structured JSONL output with mandatory redaction at ALL three exits
 * (`log` / `logArgv` / ErrorMapper report). All writes go through LogSinkPort.
 * Zero `node:*` / `electron` imports.
 */
import type { CorePorts } from '@ytvdlt/shared';
import type { ILogger, LogEvent, LogLevel } from '../ports.js';
import {
  REDACTED, redactContext, redactArgv, detectComplianceBlocked,
} from './redactor.js';

export interface LoggerDeps {
  ports: CorePorts;
  appVersion: string;
}

export class Logger implements ILogger {
  private readonly ports: CorePorts;
  private readonly appVersion: string;
  private readonly lines: string[] = [];

  constructor(deps: LoggerDeps) {
    this.ports = deps.ports;
    this.appVersion = deps.appVersion;
  }

  /** Single structured line: `{ts, level, scope, event, payload?}` — payload redacted. */
  async log(e: LogEvent): Promise<void> {
    const payload = e.payload === undefined ? undefined : redactContext(e.payload);
    const line = JSON.stringify({
      ts: this.ports.clock.nowIso(),
      level: e.level,
      scope: e.scope,
      event: e.event,
      ...(payload === undefined ? {} : { payload }),
    });
    this.lines.push(line);
    await this.ports.logSink.appendJsonl(line);
  }

  info(scope: string, event: string, payload?: Record<string, unknown>): Promise<void> {
    return this.log({ level: 'INFO', scope, event, ...(payload === undefined ? {} : { payload }) });
  }

  warn(scope: string, event: string, payload?: Record<string, unknown>): Promise<void> {
    return this.log({ level: 'WARNING', scope, event, ...(payload === undefined ? {} : { payload }) });
  }

  error(scope: string, event: string, payload?: Record<string, unknown>): Promise<void> {
    return this.log({ level: 'ERROR', scope, event, ...(payload === undefined ? {} : { payload }) });
  }

  /** argv is redacted BEFORE it reaches the sink; forbidden options are flagged. */
  async logArgv(scope: string, argv: readonly string[]): Promise<void> {
    await this.log({
      level: 'INFO', scope, event: 'argv', payload: { argv: redactArgv(argv) },
    });
    const blocked = detectComplianceBlocked(argv);
    if (blocked.length > 0) {
      await this.log({
        level: 'WARNING', scope, event: 'COMPLIANCE_BLOCKED',
        payload: { tokens: blocked, action: 'rejected', mask: REDACTED },
      });
    }
  }

  /** M1 placeholder: writes a versioned crash report file; returns its absolute path. */
  async writeCrashReport(err: unknown, context: Record<string, unknown>): Promise<string> {
    const message = err instanceof Error ? err.message : String(err);
    const path = `${this.ports.env.logsDir()}/crash-${this.ports.clock.nowEpochMs()}.json`;
    const report = {
      ts: this.ports.clock.nowIso(),
      appVersion: this.appVersion,
      os: this.ports.env.platform(),
      osRelease: this.ports.env.osRelease(),
      message,
      context: redactContext(context),
    };
    await this.ports.fs.mkdir(this.ports.env.logsDir());
    await this.ports.fs.writeTextAtomic(path, `${JSON.stringify(report, null, 2)}\n`);
    await this.log({ level: 'FATAL', scope: 'crash', event: 'report.written', payload: { path } });
    return path;
  }

  /** M1 placeholder: export the accumulated JSONL lines (M5 adds rotation/export). */
  async exportLogs(): Promise<string> {
    return `${this.lines.join('\n')}\n`;
  }
}
