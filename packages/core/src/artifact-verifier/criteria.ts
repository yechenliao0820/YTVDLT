/**
 * C1–C12 criteria (ARCHITECTURE-M2 §4.4).
 *
 * Each criterion is an independent async function over a `CheckContext`.
 * Reads/probes go through the injected `CorePorts`; nothing here imports
 * `node:*`, so the whole engine is offline-unit-testable.
 *
 * The three误判-prone rules are implemented exactly as the doc demands:
 *  - C4 judges `stderr === ''` only (never the exit code);
 *  - C5 degrades to `expectedManifest.durationSec` when `duration === null`,
 *    and SKIPs (never FAILs) when neither is known;
 *  - C2 and C8 are mutually exclusive, selected by `postprocessed`.
 */
import type {
  ArtifactVerification, ExpectedArtifactManifest, HistoryEntry, MediaInfo,
  CorePorts, DownloadKind,
} from '@ytvdlt/shared';
import { detectPostprocessed } from '../download-flags.js';

export interface CheckContext {
  taskId: string;
  artifacts: string[];
  expected: MediaInfo | null;
  postprocessed: boolean;
  expectedManifest?: ExpectedArtifactManifest | null;
  historyEntry?: HistoryEntry | null;
  kind?: DownloadKind;
  ports: CorePorts;
  ffprobePath: string;
  ffmpegPath: string;
}

const VIDEO_EXTS = new Set(['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'ts', 'm4v']);
const AUDIO_EXTS = new Set(['m4a', 'mp3', 'opus', 'ogg', 'flac', 'wav', 'aac']);
const SUBTITLE_EXTS = new Set(['vtt', 'srt', 'ass', 'lrc']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']);
const TRANSIENT = /\.(part|ytdl|temp)$/i;

export function extOf(path: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  return (match?.[1] ?? '').toLowerCase();
}

/** The main media artifact: first video/audio file, else first artifact. */
export function primaryArtifact(artifacts: readonly string[]): string | null {
  for (const path of artifacts) {
    const ext = extOf(path);
    if (VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext)) return path;
  }
  return artifacts[0] ?? null;
}

interface FfprobeOutcome {
  ok: boolean;
  stderr: string;
  exitCode: number | null;
  json: Record<string, unknown> | null;
}

async function runFfprobe(ctx: CheckContext, file: string): Promise<FfprobeOutcome> {
  const result = await ctx.ports.process.spawn(
    ctx.ffprobePath,
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
    { shell: false, windowsHide: true, timeoutMs: 30_000 },
  );
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed === 'object' && parsed !== null) {
      json = parsed as Record<string, unknown>;
    }
  } catch {
    json = null;
  }
  return { ok: result.exitCode === 0 && result.stderr.trim() === '', stderr: result.stderr, exitCode: result.exitCode, json };
}

async function runFfmpegDecode(ctx: CheckContext, file: string): Promise<{ stderr: string; exitCode: number | null }> {
  const result = await ctx.ports.process.spawn(
    ctx.ffmpegPath,
    ['-v', 'error', '-i', file, '-f', 'null', '-'],
    { shell: false, windowsHide: true, timeoutMs: 60_000 },
  );
  return { stderr: result.stderr, exitCode: result.exitCode };
}

async function runFramemd5(ctx: CheckContext, file: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const result = await ctx.ports.process.spawn(
    ctx.ffmpegPath,
    ['-v', 'error', '-i', file, '-map', '0:v', '-f', 'framemd5', '-'],
    { shell: false, windowsHide: true, timeoutMs: 60_000 },
  );
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

function streamsOf(json: Record<string, unknown> | null): Array<Record<string, unknown>> {
  const streams = json?.['streams'];
  if (!Array.isArray(streams)) return [];
  return streams.filter((item): item is Record<string, unknown> =>
    typeof item === 'object' && item !== null);
}

function codecTypes(json: Record<string, unknown> | null): string[] {
  return streamsOf(json).map((stream) => String(stream['codec_type'] ?? ''));
}

function formatDuration(json: Record<string, unknown> | null): number | null {
  const format = json?.['format'];
  if (typeof format !== 'object' || format === null) return null;
  const raw = (format as Record<string, unknown>)['duration'];
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

const pass = (id: ArtifactVerification['id'], detail: string, actual?: Record<string, unknown>): ArtifactVerification => ({
  id, status: 'PASS', detail, ...(actual === undefined ? {} : { actual }),
});
const fail = (id: ArtifactVerification['id'], detail: string, actual?: Record<string, unknown>): ArtifactVerification => ({
  id, status: 'FAIL', detail, ...(actual === undefined ? {} : { actual }),
});
const skip = (id: ArtifactVerification['id'], skipReason: string, actual?: Record<string, unknown>): ArtifactVerification => ({
  id, status: 'SKIPPED', detail: skipReason, skipReason, ...(actual === undefined ? {} : { actual }),
});

/** C1 — artifacts exist, are files, are non-empty, and are not transient. */
export async function checkC1(ctx: CheckContext): Promise<ArtifactVerification> {
  if (ctx.artifacts.length === 0) {
    return fail('C1', 'artifact list is empty (manifest had no usable path)');
  }
  const measured: Record<string, unknown> = {};
  for (const path of ctx.artifacts) {
    if (TRANSIENT.test(path)) return fail('C1', `transient file in artifact list: ${path}`);
    try {
      if (!(await ctx.ports.fs.exists(path))) return fail('C1', `missing artifact: ${path}`);
      const stat = await ctx.ports.fs.stat(path);
      measured[path] = { sizeBytes: stat.sizeBytes, isFile: stat.isFile };
      if (!stat.isFile) return fail('C1', `not a regular file: ${path}`, measured);
      if (stat.sizeBytes <= 0) return fail('C1', `empty artifact: ${path}`, measured);
    } catch (error) {
      return fail('C1', `stat failed for ${path}: ${String(error)}`, measured);
    }
  }
  return pass('C1', `${ctx.artifacts.length} artifact(s) exist and are non-empty`, measured);
}

/** C2 — byte-exact hash (only for pure downloads). */
export async function checkC2(ctx: CheckContext): Promise<ArtifactVerification> {
  if (ctx.postprocessed) {
    return skip('C2', 'post-processed output changes bytes; C8 is authoritative (D-19)');
  }
  const primary = primaryArtifact(ctx.artifacts);
  const expectedSha = ctx.expectedManifest?.sha256 ?? null;
  if (primary === null || expectedSha === null) {
    return skip('C2', 'no primary artifact or no expected sha256 available');
  }
  try {
    const actual = await ctx.ports.hash.sha256File(primary);
    const detail = actual === expectedSha
      ? 'byte-exact match with expected sha256'
      : `sha256 mismatch (expected ${expectedSha.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`;
    return actual === expectedSha
      ? pass('C2', detail, { expectedSha256: expectedSha, actualSha256: actual })
      : fail('C2', detail, { expectedSha256: expectedSha, actualSha256: actual });
  } catch (error) {
    return fail('C2', `hash failed: ${String(error)}`);
  }
}

/** C3 — container is parseable (exit 0 AND empty stderr AND valid JSON). */
export async function checkC3(ctx: CheckContext): Promise<ArtifactVerification> {
  const primary = primaryArtifact(ctx.artifacts);
  if (primary === null) return fail('C3', 'no primary artifact');
  const probe = await runFfprobe(ctx, primary);
  const actual = { exitCode: probe.exitCode, stderrEmpty: probe.stderr.trim() === '', json: probe.json !== null };
  return probe.ok && probe.json !== null
    ? pass('C3', 'ffprobe exit 0, stderr empty, JSON parsed', actual)
    : fail('C3', 'ffprobe failed (exit!=0 / stderr not empty / bad JSON)', actual);
}

/** C4 — full-frame decode. Verdict is stderr emptiness ONLY (never exit code). */
export async function checkC4(ctx: CheckContext): Promise<ArtifactVerification> {
  const primary = primaryArtifact(ctx.artifacts);
  if (primary === null) return fail('C4', 'no primary artifact');
  const decode = await runFfmpegDecode(ctx, primary);
  const stderrEmpty = decode.stderr.trim() === '';
  const actual = { exitCode: decode.exitCode, stderrEmpty };
  // Even with exitCode 0, any decode warning means a half-broken artifact.
  return stderrEmpty
    ? pass('C4', 'full decode produced no stderr output', actual)
    : fail('C4', 'decode emitted stderr (artifact not fully decodable)', actual);
}

/** C5 — duration within tolerance; null duration degrades, never FAILs. */
export async function checkC5(ctx: CheckContext): Promise<ArtifactVerification> {
  const primary = primaryArtifact(ctx.artifacts);
  if (primary === null) return fail('C5', 'no primary artifact');
  const probe = await runFfprobe(ctx, primary);
  const actualDuration = formatDuration(probe.json);
  const expectedDuration = ctx.expected?.duration ?? ctx.expectedManifest?.durationSec ?? null;

  if (actualDuration === null) {
    return fail('C5', 'ffprobe reported no duration for the artifact');
  }
  if (expectedDuration === null) {
    return skip('C5', 'no expected duration (probe duration null and no fixture manifest); see D-20', {
      actualDuration,
    });
  }
  const tolerance = Math.max(1, Math.abs(expectedDuration) * 0.02);
  const delta = Math.abs(actualDuration - expectedDuration);
  const ok = delta <= tolerance;
  const actual = { actualDuration, expectedDuration, tolerance, delta };
  return ok
    ? pass('C5', `duration within tolerance (${delta.toFixed(2)}s <= ${tolerance.toFixed(2)}s)`, actual)
    : fail('C5', `duration mismatch (${delta.toFixed(2)}s > ${tolerance.toFixed(2)}s)`, actual);
}

/** C6 — stream completeness (audio tasks must have NO video stream). */
export async function checkC6(ctx: CheckContext): Promise<ArtifactVerification> {
  const primary = primaryArtifact(ctx.artifacts);
  if (primary === null) return fail('C6', 'no primary artifact');
  const probe = await runFfprobe(ctx, primary);
  const types = codecTypes(probe.json);
  const hasVideo = types.includes('video');
  const hasAudio = types.includes('audio');
  const audioOnly = ctx.kind === 'audio';
  const actual = { codecTypes: types, kind: ctx.kind ?? 'video' };

  if (audioOnly) {
    if (hasVideo) return fail('C6', 'audio task produced a video stream', actual);
    return hasAudio ? pass('C6', 'audio-only artifact has an audio stream and no video', actual)
      : fail('C6', 'audio-only artifact has no audio stream', actual);
  }
  if (!hasVideo) return fail('C6', 'video task artifact has no video stream', actual);
  if (ctx.expectedManifest?.audioCodec !== undefined && ctx.expectedManifest.audioCodec !== '')
    return hasAudio ? pass('C6', 'video artifact has both video and audio streams', actual)
      : fail('C6', 'expected audio stream missing', actual);
  return pass('C6', 'video artifact has a video stream', actual);
}

/** C7 — measured specs vs the selected format (no selection ⇒ record-only PASS). */
export async function checkC7(ctx: CheckContext): Promise<ArtifactVerification> {
  const primary = primaryArtifact(ctx.artifacts);
  if (primary === null) return fail('C7', 'no primary artifact');
  const probe = await runFfprobe(ctx, primary);
  const video = streamsOf(probe.json).find((stream) => stream['codec_type'] === 'video');
  const measured = {
    width: video?.['width'] ?? null,
    height: video?.['height'] ?? null,
    codecName: video?.['codec_name'] ?? null,
    avgFrameRate: video?.['avg_frame_rate'] ?? null,
  };
  const expectedFormat = ctx.expectedManifest?.expectedFormat ?? null;

  if (expectedFormat === null) {
    // No explicit selection (local generic link) — record, do not fail.
    return pass('C7', 'no explicit format selection; measured specs recorded', measured);
  }
  const mismatches: string[] = [];
  if (expectedFormat.width !== null && measured.width !== expectedFormat.width) mismatches.push('width');
  if (expectedFormat.height !== null && measured.height !== expectedFormat.height) mismatches.push('height');
  if (expectedFormat.vcodec !== 'none' && measured.codecName !== expectedFormat.vcodec) mismatches.push('vcodec');
  return mismatches.length === 0
    ? pass('C7', 'measured specs match the selected format', measured)
    : fail('C7', `spec mismatch: ${mismatches.join(', ')}`, { ...measured, expected: expectedFormat });
}

/** C8 — frame-hash consistency; only meaningful after post-processing. */
export async function checkC8(ctx: CheckContext): Promise<ArtifactVerification> {
  if (!ctx.postprocessed) {
    return skip('C8', 'no post-processing; C2 (byte hash) is authoritative (D-19)');
  }
  const primary = primaryArtifact(ctx.artifacts);
  if (primary === null) return fail('C8', 'no primary artifact');
  const golden = ctx.expectedManifest?.c8Golden ?? null;
  const out = await runFramemd5(ctx, primary);
  if (out.stderr.trim() !== '') {
    return fail('C8', 'framemd5 run emitted stderr', { stderr: out.stderr.slice(0, 400) });
  }
  if (golden === null || golden.length === 0) {
    return skip('C8', 'no golden framemd5 recorded yet (first run); see O-M2-02', {
      framemd5Length: out.stdout.length,
    });
  }
  const normalize = (text: string): string => text.replace(/\r/g, '').trim();
  const matches = normalize(out.stdout) === normalize(golden);
  return matches
    ? pass('C8', 'frame hashes match the golden reference', { framemd5Length: out.stdout.length })
    : fail('C8', 'frame hashes differ from the golden reference', { framemd5Length: out.stdout.length });
}

/** C9 — attached artifacts (subtitles / thumbnail / info.json) exist. */
export async function checkC9(ctx: CheckContext): Promise<ArtifactVerification> {
  const attached = ctx.artifacts.filter((path) => {
    const ext = extOf(path);
    return SUBTITLE_EXTS.has(ext) || IMAGE_EXTS.has(ext) || ext === 'json';
  });
  if (attached.length === 0) {
    return pass('C9', 'no attached artifacts declared for this task');
  }
  const measured: Record<string, unknown> = {};
  for (const path of attached) {
    try {
      const stat = await ctx.ports.fs.stat(path);
      measured[path] = stat.sizeBytes;
      if (!stat.isFile || stat.sizeBytes <= 0) {
        return fail('C9', `attached artifact is empty: ${path}`, measured);
      }
    } catch {
      return fail('C9', `attached artifact missing: ${path}`, measured);
    }
  }
  return pass('C9', `${attached.length} attached artifact(s) present`, measured);
}

/** C10 — continuation consistency: final hash equals a one-shot download hash. */
export async function checkC10(ctx: CheckContext): Promise<ArtifactVerification> {
  const primary = primaryArtifact(ctx.artifacts);
  const expectedSha = ctx.expectedManifest?.sha256 ?? null;
  if (primary === null || expectedSha === null) {
    return skip('C10', 'no primary artifact or no reference sha256 for continuation check');
  }
  if (ctx.postprocessed) {
    return skip('C10', 'post-processed output changes bytes; continuation hash not comparable');
  }
  try {
    const actual = await ctx.ports.hash.sha256File(primary);
    const actualSummary = { expectedSha256: expectedSha, actualSha256: actual };
    return actual === expectedSha
      ? pass('C10', 'resumed download matches the one-shot download hash', actualSummary)
      : fail('C10', 'resumed download hash differs from the one-shot hash', actualSummary);
  } catch (error) {
    return fail('C10', `hash failed: ${String(error)}`);
  }
}

/** C11 — history consistency: entry path exists and points at a C1 artifact. */
export async function checkC11(ctx: CheckContext): Promise<ArtifactVerification> {
  const entry = ctx.historyEntry ?? null;
  if (entry === null) {
    return skip('C11', 'no history entry supplied to verification');
  }
  const normalize = (value: string): string => value.replace(/\//g, '\\').toLowerCase();
  const inArtifacts = ctx.artifacts.some((path) => normalize(path) === normalize(entry.videoPath));
  if (!inArtifacts) {
    return fail('C11', 'history videoPath is not one of the verified artifacts', {
      videoPath: entry.videoPath,
    });
  }
  try {
    const stat = await ctx.ports.fs.stat(entry.videoPath);
    return stat.sizeBytes > 0
      ? pass('C11', 'history entry points at an existing non-empty artifact', {
        videoPath: entry.videoPath, sizeBytes: stat.sizeBytes,
      })
      : fail('C11', 'history videoPath is empty on disk', { videoPath: entry.videoPath });
  } catch {
    return fail('C11', 'history videoPath does not exist on disk', { videoPath: entry.videoPath });
  }
}

/** C12 — no false completion: any other FAIL means the task must not complete. */
export function checkC12(others: readonly ArtifactVerification[]): ArtifactVerification {
  const failures = others.filter((criterion) => criterion.status === 'FAIL');
  return failures.length === 0
    ? pass('C12', 'no failing criterion; completion is legitimate')
    : fail('C12', `cannot mark Completed: ${failures.map((f) => f.id).join(', ')} failed`, {
      failed: failures.map((f) => f.id),
    });
}

/**
 * Request-derived post-processing flag (exposed for callers that do not have
 * the `DownloadRequest` in scope). Kept here so criteria and queue agree.
 */
export function requestTriggersPostprocess(req: Parameters<typeof detectPostprocessed>[0]): boolean {
  return detectPostprocessed(req);
}
