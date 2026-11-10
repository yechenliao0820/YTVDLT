/**
 * ArtifactVerifier — runs C1…C12 in order and aggregates a VerificationReport.
 * All I/O goes through injected `CorePorts`; ffmpeg/ffprobe paths are derived
 * from the runtime dir exposed by `EnvPort` (never hard-coded).
 */
import type { CorePorts, VerificationReport, ArtifactVerification } from '@ytvdlt/shared';
import type { IArtifactVerifier, VerifierInput } from '../ports.js';
import {
  checkC1, checkC2, checkC3, checkC4, checkC5, checkC6,
  checkC7, checkC8, checkC9, checkC10, checkC11, checkC12,
  type CheckContext,
} from './criteria.js';
import { collectAttachmentProbes } from './attachments.js';

export interface ArtifactVerifierDeps {
  ports: CorePorts;
  /** Optional overrides (tests); default derived from `ports.env.runtimeDir()`. */
  ffprobePath?: string;
  ffmpegPath?: string;
}

export class ArtifactVerifier implements IArtifactVerifier {
  private readonly deps: ArtifactVerifierDeps;

  constructor(deps: ArtifactVerifierDeps) {
    this.deps = deps;
  }

  private contextOf(input: VerifierInput): CheckContext {
    const runtimeDir = this.deps.ports.env.runtimeDir().replace(/[\\/]+$/, '');
    return {
      taskId: input.taskId,
      artifacts: input.artifacts,
      expected: input.expected,
      postprocessed: input.postprocessed,
      expectedManifest: input.expectedManifest ?? null,
      historyEntry: input.historyEntry ?? null,
      // exactOptionalPropertyTypes: only add `kind` when it is defined.
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      // Stage 4: advisory-only input (embedded subtitle probe). Never scored.
      ...(input.subtitleRequest === undefined ? {} : { subtitleRequest: input.subtitleRequest }),
      ports: this.deps.ports,
      ffprobePath: this.deps.ffprobePath ?? `${runtimeDir}/ffmpeg/ffprobe.exe`,
      ffmpegPath: this.deps.ffmpegPath ?? `${runtimeDir}/ffmpeg/ffmpeg.exe`,
    };
  }

  async verify(input: VerifierInput): Promise<VerificationReport> {
    const started = Date.now();
    const ctx = this.contextOf(input);

    // C1..C11 run independently; C12 inspects their results.
    const criteria: ArtifactVerification[] = [
      await checkC1(ctx),
      await checkC2(ctx),
      await checkC3(ctx),
      await checkC4(ctx),
      await checkC5(ctx),
      await checkC6(ctx),
      await checkC7(ctx),
      await checkC8(ctx),
      await checkC9(ctx),
      await checkC10(ctx),
      await checkC11(ctx),
    ];
    criteria.push(checkC12(criteria));

    // Stage 4 / D-127: attachment probes are ADVISORY. They are reported so the
    // queue can annotate the record, but they never take part in `ok` /
    // `failureCode` / C12 — a subtitle problem is not a broken video.
    const attachments = await collectAttachmentProbes(ctx);

    const failures = criteria.filter((criterion) => criterion.status === 'FAIL');
    // C11 (history) failing means "already downloaded", which is a distinct
    // user-facing outcome from a generic incomplete artifact.
    const c11Failed = criteria.some((c) => c.id === 'C11' && c.status === 'FAIL');
    const failureCode = failures.length === 0
      ? null
      : (c11Failed ? 'ALREADY_DOWNLOADED' : 'ARTIFACT_INCOMPLETE');

    return {
      taskId: input.taskId,
      artifacts: [...input.artifacts],
      postprocessed: input.postprocessed,
      criteria,
      ok: failures.length === 0,
      failureCode,
      durationMs: Date.now() - started,
      ...(attachments.length === 0 ? {} : { attachments }),
    };
  }
}
