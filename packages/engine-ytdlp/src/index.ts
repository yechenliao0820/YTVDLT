/**
 * @ytvdlt/engine-ytdlp — pure TypeScript, ZERO `electron` / ZERO `node:*`.
 * spawn capability comes exclusively from the injected ProcessPort.
 */
export {
  build, assertHttpUrl, invalidUrlError, ArgvBuilder, FROZEN_PROBE_PREFIX,
} from './argv-builder.js';
export {
  toMediaInfo, toPlaylistInfo, mapProbeResult, JsonMapper,
} from './json-mapper.js';
export * from './media-guards.js';
export { YtDlpEngine, type YtDlpEngineDeps } from './yt-dlp-engine.js';
export { FakeEngine, type FakeEngineDeps } from './fake-engine.js';
export {
  createEngine, type EngineKind, type EngineFactoryOptions,
} from './engine-factory.js';
export * from './probe-result.js';
export * from './runtime-check.js';
// M2 additions (append-only).
export {
  buildDownload, ArgvBuilderDownload, DOWNLOAD_ARGV_FROZEN_ORDER,
  DOWNLOAD_ARGV_M3_SEGMENTS, type M3Segment, type DownloadContext,
} from './argv-builder-download.js';
export * from './progress-template.js';
export * from './progress-parser.js';
export * from './artifact-manifest.js';
// M3 additions (append-only): compliance whitelist + forbidden-option guard.
export {
  ALLOWED_DOWNLOAD_OPTIONS, M3_FORBIDDEN_OPTIONS, assertNoForbiddenOptions,
} from './argv-compliance.js';
// M4-5 additions (append-only): validated custom-command argv builder.
export {
  buildCustomDownload, ArgvBuilderCustom, type CustomCommandContext,
} from './argv-builder-custom.js';
// M5-5 additions (append-only): engine self-update orchestration (D-62).
export {
  SelfUpdater, parseChecksums, normalizeToolVersion, type SelfUpdaterDeps,
} from './self-updater.js';
export { HttpUpdateSource, type HttpUpdateSourceOptions } from './http-update-source.js';
