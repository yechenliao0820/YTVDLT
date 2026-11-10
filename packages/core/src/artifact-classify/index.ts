/**
 * Artifact classification barrel (stage 4, append-only).
 *
 * One extension table for engine + verifier + history + detail, one association
 * rule for subtitle files, and one requested-vs-produced verdict.
 */
export * from './kinds.js';
export * from './associate.js';
export * from './requested.js';
