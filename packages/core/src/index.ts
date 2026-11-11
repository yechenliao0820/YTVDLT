/**
 * @ytvdlt/core — pure TypeScript, ZERO `electron` / ZERO `node:*` imports.
 * Every component receives its I/O through injected `CorePorts`.
 */
export * from './ports.js';
export * from './config-store/index.js';
export * from './logger/index.js';
export * from './error-mapper/index.js';
export * from './runtime-resolver/index.js';
// M2 additions (append-only).
export * from './shell-commands.js';
export * from './download-flags.js';
export * from './artifact-verifier/index.js';
export * from './task-queue/index.js';
export * from './history-store/index.js';
export * from './task-store/index.js';
// M3 additions (append-only): pure decision / selector / planner / resolver.
export * from './decision/index.js';
export * from './format-selector/index.js';
export * from './subtitle-planner/index.js';
export * from './path-resolver/index.js';
// M4 additions (append-only): playlist batch planning.
export * from './playlist/index.js';
// M4-5 additions (append-only): command templates + per-task log buffer.
export * from './command-template/index.js';
export * from './task-log/index.js';
// M4-6 additions (append-only): notifications, task detail, error report.
export * from './notifications/index.js';
export * from './task-detail/index.js';
export * from './error-report/index.js';
// M4 assembly seam (append-only): five-domain request assembly from config.
export * from './request-builder/index.js';
// M5 additions (append-only): appearance policy (theme / accent / motion).
export * from './appearance/index.js';
// M5-2 additions (append-only): i18n key policy + keyboard shortcut policy.
export * from './i18n/index.js';
export * from './shortcuts/index.js';
// M5-3 additions (append-only): task list tabs / search / empty states.
export * from './task-view/index.js';
// M5 additions (append-only): crash guard + desktop platform policy.
export * from './crash/index.js';
export * from './platform/index.js';
// 0.2.1 additions (append-only): GitHub-release app update (D-93).
export * from './app-update/index.js';
// D-103 (append-only): pure retention policy for the cover-image cache.
export * from './thumbnail-cache-policy/index.js';
// D-109 (append-only): stable error code → one plain-language failure bucket.
export * from './failure-summary/index.js';
// Subtitle preview (append-only, stage 2): source-aware projection + bounded,
// single-use ticket cache. No probe, no spawn, no disk.
export * from './subtitle-preview/index.js';
// Stage 4 (append-only): one artifact extension table, subtitle↔media links and
// the requested-vs-produced verdict. Pure, no I/O.
export * from './artifact-classify/index.js';
// TXT batch import (append-only): pure line parsing, URL transport validation
// is INJECTED so core never depends on the engine package.
export * from './txt-import/index.js';
