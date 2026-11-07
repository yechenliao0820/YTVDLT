/**
 * @ytvdlt/shared — frozen M1 contract surface (A-INF-01 check point).
 *
 * Pure TypeScript types + constants ONLY. No I/O, no `node:*`, no `electron`.
 * All cross-layer data crosses through these DTOs; `packages/core` and
 * `packages/engine-ytdlp` never import Electron or Node built-ins.
 */

export * from './errors.js';
export * from './events.js';
export * from './media.js';
export * from './request.js';
export * from './runtime.js';
export * from './engine.js';
export * from './ipc.js';
export * from './ports.js';
// M2 additions (append-only).
export * from './progress.js';
export * from './verification.js';
export * from './task.js';
export * from './history.js';
// M3 additions (append-only): independent types, five frozen domains untouched.
export * from './download-plan.js';
export * from './dialog-dto.js';
// M5 additions (append-only): update domain types, no I/O.
export * from './update.js';
