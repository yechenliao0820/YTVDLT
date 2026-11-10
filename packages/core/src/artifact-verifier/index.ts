export {
  ArtifactVerifier, type ArtifactVerifierDeps,
} from './artifact-verifier.js';
export * from './criteria.js';
// Stage 4 (append-only): advisory attachment probes (subtitle content sanity,
// embedded-subtitle stream check). Never part of the C1–C12 verdict.
export * from './attachments.js';
