/**
 * Engine factory — production is ALWAYS `ytdlp`; `fake` is test/acceptance only
 * (used for L2 replay if U3 were NOT_SUPPORTED). U3 was SUPPORTED (DECISIONS).
 */
import type {
  DownloadEngine, CorePorts, RuntimeManifest, EngineUpdateSource, QueueIntakeGate,
} from '@ytvdlt/shared';
import type { ILogger, IErrorMapper } from '@ytvdlt/core';
import { YtDlpEngine } from './yt-dlp-engine.js';
import { FakeEngine } from './fake-engine.js';

export type EngineKind = 'ytdlp' | 'fake';

export interface EngineFactoryOptions {
  ports: CorePorts;
  logger: ILogger;
  mapper: IErrorMapper;
  enginePath: string;
  jsRuntimePath: string;
  fixturesDir: string;
  appVersion: string;
  manifest?: RuntimeManifest;
  /** M5-5 append-only (D-62): engine update source + queue intake switch. */
  updateSource?: EngineUpdateSource;
  intakeGate?: QueueIntakeGate;
}

/** Create the requested engine. `manifest` is accepted for signature parity. */
export function createEngine(
  kind: EngineKind,
  options: EngineFactoryOptions,
  _manifest?: RuntimeManifest,
): DownloadEngine {
  if (kind === 'fake') {
    return new FakeEngine({
      ports: options.ports,
      fixturesDir: options.fixturesDir,
    });
  }
  return new YtDlpEngine({
    ports: options.ports,
    logger: options.logger,
    mapper: options.mapper,
    enginePath: options.enginePath,
    jsRuntimePath: options.jsRuntimePath,
    appVersion: options.appVersion,
    ...(options.updateSource === undefined ? {} : { updateSource: options.updateSource }),
    ...(options.intakeGate === undefined ? {} : { intakeGate: options.intakeGate }),
  });
}
