/**
 * Artifact verification DTOs (C1–C12). Pure types only.
 */

export type CriterionId =
  | 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6'
  | 'C7' | 'C8' | 'C9' | 'C10' | 'C11' | 'C12';

export type CriterionStatus = 'PASS' | 'FAIL' | 'SKIPPED';

/** Result of a single criterion. */
export interface ArtifactVerification {
  id: CriterionId;
  status: CriterionStatus;
  /** Human-readable, already-redacted verdict explanation. */
  detail: string;
  /** Measured values (for the report / re-computation). */
  actual?: Record<string, unknown>;
  /** Why it was skipped (e.g. C5 degradation when duration is null). */
  skipReason?: string;
}

export interface VerificationReport {
  taskId: string;
  /** Absolute paths that took part in verification. */
  artifacts: string[];
  /** Whether post-processing happened (decides C2 vs C8). */
  postprocessed: boolean;
  /** Exactly 12 entries, ordered C1..C12. */
  criteria: ArtifactVerification[];
  /** All PASS or SKIPPED (no FAIL). */
  ok: boolean;
  failureCode: 'ARTIFACT_INCOMPLETE' | 'ALREADY_DOWNLOADED' | 'UNKNOWN' | null;
  durationMs: number;
}

/** L2 expectation manifest (derived from `tests/fixtures/manifest.json`). */
export interface ExpectedArtifactManifest {
  sha256: string;
  sizeBytes: number;
  durationSec: number;
  videoCodec: string;
  audioCodec: string;
  /** Expected primary format for C7 (optional; absent = record-only). */
  expectedFormat?: {
    formatId: string;
    ext: string;
    vcodec: string;
    acodec: string;
    width: number | null;
    height: number | null;
  } | null;
  /** Golden framemd5 text for C8 (optional; generated on first L2 run). */
  c8Golden?: string | null;
}
