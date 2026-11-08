/**
 * A-M2-08 … A-M2-19 · C1–C12 each have an explicit PASS / FAIL / SKIPPED test.
 * Also covers the three误判-prone rules the brief calls out:
 *  - C4: exit 0 + non-empty stderr ⇒ FAIL;
 *  - C5: null duration + manifest ⇒ degrade; both null ⇒ SKIPPED (never FAIL);
 *  - C2/C8: mutually exclusive by `postprocessed`.
 */
import { describe, it, expect } from 'vitest';
import { ArtifactVerifier } from '@ytvdlt/core';
import type { ExpectedArtifactManifest, MediaInfo } from '@ytvdlt/shared';
import { createInMemoryPorts, type InMemoryState } from './helpers/in-memory-ports.js';

const RUNTIME = 'C:/runtime';
const PRIMARY = 'C:/out/Title [id].mp4';
const SHA = 'a'.repeat(64);

const FFPROBE_OK = JSON.stringify({
  format: { duration: '10.000000' },
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 320, height: 240, avg_frame_rate: '25/1' },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
});

const MANIFEST: ExpectedArtifactManifest = {
  sha256: SHA,
  sizeBytes: 308666,
  durationSec: 10,
  videoCodec: 'h264',
  audioCodec: 'aac',
  expectedFormat: null,
  c8Golden: null,
};

function seed(overrides: { ffprobe?: string; ffprobeStderr?: string; ffprobeExit?: number; decodeStderr?: string; decodeExit?: number; framemd5?: string; framemd5Stderr?: string } = {}) {
  const { ports, state } = createInMemoryPorts();
  state.env.runtimeDir = RUNTIME;
  state.files.set(PRIMARY, 'video-bytes');
  state.spawnResults.set('ffprobe.exe', {
    exitCode: overrides.ffprobeExit ?? 0,
    stdout: overrides.ffprobe ?? FFPROBE_OK,
    stderr: overrides.ffprobeStderr ?? '',
    timedOut: false,
  });
  state.spawnResults.set('-f null -', {
    exitCode: overrides.decodeExit ?? 0,
    stdout: '',
    stderr: overrides.decodeStderr ?? '',
    timedOut: false,
  });
  state.spawnResults.set('framemd5', {
    exitCode: 0,
    stdout: overrides.framemd5 ?? 'framemd5-line\n',
    stderr: overrides.framemd5Stderr ?? '',
    timedOut: false,
  });
  const verifier = new ArtifactVerifier({ ports });
  return { verifier, ports, state };
}

const mediaInfo = (overrides: Partial<MediaInfo> = {}): MediaInfo => ({
  id: 'fixture', title: 'fixture', uploader: null, uploader_id: null,
  duration: 10, thumbnail: null, webpage_url: 'http://127.0.0.1:1/fixture.mp4',
  extractor_key: 'generic', description: null, upload_date: null, ext: 'mp4',
  formats: [{ format_id: '0', ext: 'mp4', width: 320, height: 240, vcodec: 'h264', acodec: 'aac', filesize: 1, filesize_approx: null, tbr: 1, fps: 25, format_note: null }],
  subtitles: {}, automatic_captions: {}, chapters: null, _type: 'video', ...overrides,
});

const baseInput = {
  taskId: 't1',
  artifacts: [PRIMARY],
  expected: mediaInfo(),
  postprocessed: false,
  expectedManifest: MANIFEST,
  historyEntry: null,
  kind: 'video' as const,
};

const byId = (report: { criteria: Array<{ id: string; status: string; detail: string }> }, id: string) =>
  report.criteria.find((criterion) => criterion.id === id);

describe('C1 / A-M2-08 artifact presence', () => {
  it('PASSes for a non-empty artifact', async () => {
    const { verifier } = seed();
    expect((await verifier.verify(baseInput)).criteria[0]?.status).toBe('PASS');
  });

  it('FAILs for an empty artifact list and for a missing file', async () => {
    const { verifier } = seed();
    const empty = await verifier.verify({ ...baseInput, artifacts: [] });
    expect(empty.criteria[0]?.status).toBe('FAIL');
    expect(empty.ok).toBe(false);

    const missing = await verifier.verify({ ...baseInput, artifacts: ['C:/out/nope.mp4'] });
    expect(missing.criteria[0]?.status).toBe('FAIL');
  });

  it('FAILs when a `.part` file sneaks into the list', async () => {
    const { verifier } = seed();
    const report = await verifier.verify({ ...baseInput, artifacts: [`${PRIMARY}.part`] });
    expect(report.criteria[0]?.status).toBe('FAIL');
    expect(report.criteria[0]?.detail).toContain('transient');
  });
});

describe('C2 / A-M2-09 byte hash (pure download only)', () => {
  it('PASSes when the hash matches, FAILs when it differs', async () => {
    const { verifier, ports } = seed();
    // in-memory hash of file content must equal the manifest sha
    const actual = await ports.hash.sha256File(PRIMARY);
    const ok = await verifier.verify({ ...baseInput, expectedManifest: { ...MANIFEST, sha256: actual } });
    expect(byId(ok, 'C2')?.status).toBe('PASS');

    const bad = await verifier.verify(baseInput);
    expect(byId(bad, 'C2')?.status).toBe('FAIL');
  });

  it('SKIPs C2 when post-processed (C8 takes over)', async () => {
    const { verifier } = seed();
    const report = await verifier.verify({ ...baseInput, postprocessed: true });
    expect(byId(report, 'C2')?.status).toBe('SKIPPED');
    expect(byId(report, 'C2')?.skipReason).toContain('C8');
  });

  it('SKIPs C2 when no expected manifest is available', async () => {
    const { verifier } = seed();
    const report = await verifier.verify({ ...baseInput, expectedManifest: null });
    expect(byId(report, 'C2')?.status).toBe('SKIPPED');
  });
});

describe('C3 / A-M2-10 container parsability', () => {
  it('PASSes on exit 0 + empty stderr + JSON', async () => {
    const { verifier } = seed();
    expect(byId(await verifier.verify(baseInput), 'C3')?.status).toBe('PASS');
  });

  it('FAILs on exit 0 but non-empty stderr (half-broken container)', async () => {
    const { verifier } = seed({ ffprobeStderr: 'moov atom not found' });
    expect(byId(await verifier.verify(baseInput), 'C3')?.status).toBe('FAIL');
  });

  it('FAILs on unparseable JSON', async () => {
    const { verifier } = seed({ ffprobe: 'not json' });
    expect(byId(await verifier.verify(baseInput), 'C3')?.status).toBe('FAIL');
  });
});

describe('C4 / A-M2-11 full-frame decode (stderr only, never exit code)', () => {
  it('PASSes when stderr is empty', async () => {
    const { verifier } = seed();
    expect(byId(await verifier.verify(baseInput), 'C4')?.status).toBe('PASS');
  });

  it('FAILs on exit 0 + NON-EMPTY stderr (the classic误判)', async () => {
    const { verifier } = seed({ decodeExit: 0, decodeStderr: 'error while decoding MB 3 4' });
    const report = await verifier.verify(baseInput);
    expect(byId(report, 'C4')?.status).toBe('FAIL');
    expect(byId(report, 'C4')?.detail).toContain('stderr');
  });

  it('PASSes when stderr is empty even if exit code is non-zero', async () => {
    const { verifier } = seed({ decodeExit: 1, decodeStderr: '' });
    expect(byId(await verifier.verify(baseInput), 'C4')?.status).toBe('PASS');
  });
});

describe('C5 / A-M2-12 duration (null ⇒ degrade, never FAIL)', () => {
  it('PASSes within tolerance when MediaInfo.duration is known', async () => {
    const { verifier } = seed();
    expect(byId(await verifier.verify(baseInput), 'C5')?.status).toBe('PASS');
  });

  it('FAILs when duration is outside tolerance', async () => {
    const { verifier } = seed({ ffprobe: JSON.stringify({ format: { duration: '30' }, streams: [{ codec_type: 'video' }] }) });
    expect(byId(await verifier.verify(baseInput), 'C5')?.status).toBe('FAIL');
  });

  it('DEGRADES to expectedManifest.durationSec when MediaInfo.duration is null', async () => {
    const { verifier } = seed();
    const report = await verifier.verify({ ...baseInput, expected: mediaInfo({ duration: null }) });
    expect(byId(report, 'C5')?.status).toBe('PASS');
  });

  it('SKIPs (never FAILs) when both durations are unknown', async () => {
    const { verifier } = seed();
    const report = await verifier.verify({
      ...baseInput,
      expected: mediaInfo({ duration: null }),
      expectedManifest: { ...MANIFEST, durationSec: null as never },
    });
    expect(byId(report, 'C5')?.status).toBe('SKIPPED');
    expect(byId(report, 'C5')?.skipReason).toContain('D-20');
  });
});

describe('C6 / A-M2-13 stream completeness', () => {
  it('PASSes for a video artifact with audio', async () => {
    const { verifier } = seed();
    expect(byId(await verifier.verify(baseInput), 'C6')?.status).toBe('PASS');
  });

  it('FAILs for a video task whose artifact has no video stream', async () => {
    const { verifier } = seed({ ffprobe: JSON.stringify({ format: { duration: '10' }, streams: [{ codec_type: 'audio' }] }) });
    expect(byId(await verifier.verify(baseInput), 'C6')?.status).toBe('FAIL');
  });

  it('audio task: PASSes with no video stream, FAILs if a video stream exists', async () => {
    const audioOnly = seed({ ffprobe: JSON.stringify({ format: { duration: '10' }, streams: [{ codec_type: 'audio' }] }) });
    expect(byId(await audioOnly.verifier.verify({ ...baseInput, kind: 'audio' }), 'C6')?.status).toBe('PASS');

    const withVideo = seed();
    expect(byId(await withVideo.verifier.verify({ ...baseInput, kind: 'audio' }), 'C6')?.status).toBe('FAIL');
  });
});

describe('C7 / A-M2-14 measured specs', () => {
  it('records specs and PASSes when there is no explicit format selection', async () => {
    const { verifier } = seed();
    const criterion = byId(await verifier.verify(baseInput), 'C7');
    expect(criterion?.status).toBe('PASS');
    expect(criterion?.detail).toContain('no explicit format selection');
  });

  it('PASSes on a matching selection and FAILs on a mismatch', async () => {
    const matching = seed();
    const okReport = await matching.verifier.verify({
      ...baseInput,
      expectedManifest: { ...MANIFEST, expectedFormat: { formatId: '0', ext: 'mp4', vcodec: 'h264', acodec: 'aac', width: 320, height: 240 } },
    });
    expect(byId(okReport, 'C7')?.status).toBe('PASS');

    const mismatch = seed();
    const badReport = await mismatch.verifier.verify({
      ...baseInput,
      expectedManifest: { ...MANIFEST, expectedFormat: { formatId: '137', ext: 'mp4', vcodec: 'h264', acodec: 'aac', width: 1920, height: 1080 } },
    });
    expect(byId(badReport, 'C7')?.status).toBe('FAIL');
  });
});

describe('C8 / A-M2-15 frame hashes (post-process only)', () => {
  it('SKIPs when there was no post-processing', async () => {
    const { verifier } = seed();
    expect(byId(await verifier.verify(baseInput), 'C8')?.status).toBe('SKIPPED');
  });

  it('SKIPs when post-processed but no golden has been recorded yet', async () => {
    const { verifier } = seed();
    const report = await verifier.verify({ ...baseInput, postprocessed: true });
    expect(byId(report, 'C8')?.status).toBe('SKIPPED');
    expect(byId(report, 'C8')?.skipReason).toContain('golden');
  });

  it('PASSes with a matching golden and FAILs with a different one', async () => {
    const matching = seed({ framemd5: 'abc123\n' });
    const okReport = await matching.verifier.verify({
      ...baseInput, postprocessed: true,
      expectedManifest: { ...MANIFEST, c8Golden: 'abc123' },
    });
    expect(byId(okReport, 'C8')?.status).toBe('PASS');

    const different = seed({ framemd5: 'deadbeef\n' });
    const badReport = await different.verifier.verify({
      ...baseInput, postprocessed: true,
      expectedManifest: { ...MANIFEST, c8Golden: 'abc123' },
    });
    expect(byId(badReport, 'C8')?.status).toBe('FAIL');
  });
});

describe('C9 / A-M2-16 attached artifacts', () => {
  it('PASSes trivially when nothing is attached', async () => {
    const { verifier } = seed();
    expect(byId(await verifier.verify(baseInput), 'C9')?.status).toBe('PASS');
  });

  it('PASSes when declared attachments exist, FAILs when one is missing', async () => {
    const { verifier, state } = seed();
    const srt = 'C:/out/Title [id].en.srt';
    state.files.set(srt, 'WEBVTT\n');
    const ok = await verifier.verify({ ...baseInput, artifacts: [PRIMARY, srt] });
    expect(byId(ok, 'C9')?.status).toBe('PASS');

    const bad = await verifier.verify({ ...baseInput, artifacts: [PRIMARY, 'C:/out/missing.srt'] });
    expect(byId(bad, 'C9')?.status).toBe('FAIL');
  });
});

describe('C10 / A-M2-17 continuation consistency', () => {
  it('PASSes when the resumed hash equals the one-shot hash', async () => {
    const { verifier, ports } = seed();
    const actual = await ports.hash.sha256File(PRIMARY);
    const report = await verifier.verify({ ...baseInput, expectedManifest: { ...MANIFEST, sha256: actual } });
    expect(byId(report, 'C10')?.status).toBe('PASS');
  });

  it('FAILs on hash divergence and SKIPs without a reference', async () => {
    const { verifier } = seed();
    expect(byId(await verifier.verify(baseInput), 'C10')?.status).toBe('FAIL');
    expect(byId(await verifier.verify({ ...baseInput, expectedManifest: null }), 'C10')?.status).toBe('SKIPPED');
  });
});

describe('C11 / A-M2-18 history consistency', () => {
  const entry = {
    id: 'h1', taskId: 't1', url: 'https://example.org/v', title: 'T', uploader: null,
    durationSec: 10, videoPath: PRIMARY, audioPath: null, thumbnailPath: null,
    subtitlePaths: [], sizeBytes: 10, extractorKey: 'generic', downloadType: 'video' as const,
    formatId: null, createdAt: '2026-11-05T00:00:00.000Z', completedAt: '2026-11-05T00:00:00.000Z',
  };

  it('SKIPs when no history entry is supplied', async () => {
    const { verifier } = seed();
    expect(byId(await verifier.verify(baseInput), 'C11')?.status).toBe('SKIPPED');
  });

  it('PASSes when the entry points at an existing artifact', async () => {
    const { verifier } = seed();
    expect(byId(await verifier.verify({ ...baseInput, historyEntry: entry }), 'C11')?.status).toBe('PASS');
  });

  it('FAILs when the entry path is not among the artifacts or is gone', async () => {
    const { verifier } = seed();
    const foreign = await verifier.verify({
      ...baseInput, historyEntry: { ...entry, videoPath: 'C:/elsewhere/x.mp4' },
    });
    expect(byId(foreign, 'C11')?.status).toBe('FAIL');
    expect(foreign.failureCode).toBe('ALREADY_DOWNLOADED');
  });
});

describe('C12 / A-M2-19 no false completion', () => {
  it('PASSes when nothing else failed', async () => {
    const { verifier, ports } = seed();
    const actual = await ports.hash.sha256File(PRIMARY);
    const report = await verifier.verify({ ...baseInput, expectedManifest: { ...MANIFEST, sha256: actual } });
    expect(report.criteria).toHaveLength(12);
    expect(byId(report, 'C12')?.status).toBe('PASS');
    expect(report.ok).toBe(true);
    expect(report.failureCode).toBeNull();
  });

  it('FAILs and reports ARTIFACT_INCOMPLETE when any criterion failed', async () => {
    const { verifier } = seed({ decodeStderr: 'decode error' });
    const report = await verifier.verify(baseInput);
    expect(byId(report, 'C12')?.status).toBe('FAIL');
    expect(report.ok).toBe(false);
    expect(report.failureCode).toBe('ARTIFACT_INCOMPLETE');
  });

  it('always emits exactly 12 criteria in C1..C12 order', async () => {
    const { verifier } = seed();
    const report = await verifier.verify(baseInput);
    expect(report.criteria.map((c) => c.id)).toEqual([
      'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12',
    ]);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('C6/C8 · D-84 audio post-processing regressions', () => {
  const AUDIO_PROBE = JSON.stringify({
    format: { duration: '10.000000' },
    streams: [{ codec_type: 'audio', codec_name: 'opus' }],
  });

  it('C8 hashes the AUDIO stream for an audio task (map 0:a, never 0:v)', async () => {
    const s = seed({ ffprobe: AUDIO_PROBE });
    const report = await s.verifier.verify({ ...baseInput, kind: 'audio', postprocessed: true });
    // No golden for real downloads -> SKIP, but the map must already be right.
    expect(byId(report, 'C8')?.status).toBe('SKIPPED');
    const call = s.state.spawnCalls.find((c) => c.argv.includes('framemd5'));
    expect(call).toBeDefined();
    expect(call!.argv[call!.argv.indexOf('-map') + 1]).toBe('0:a');
  });

  it('C8 keeps hashing the VIDEO stream for a video task (map 0:v)', async () => {
    const s = seed();
    await s.verifier.verify({ ...baseInput, postprocessed: true });
    const call = s.state.spawnCalls.find((c) => c.argv.includes('framemd5'));
    expect(call!.argv[call!.argv.indexOf('-map') + 1]).toBe('0:v');
  });

  it('C8 still FAILs when the framemd5 run writes stderr (audio task)', async () => {
    const s = seed({ ffprobe: AUDIO_PROBE, framemd5Stderr: 'matches no streams' });
    const report = await s.verifier.verify({ ...baseInput, kind: 'audio', postprocessed: true });
    expect(byId(report, 'C8')?.status).toBe('FAIL');
  });

  it('C6 does not treat an embedded cover (attached_pic) as a video stream', async () => {
    const cover = JSON.stringify({
      format: { duration: '10.000000' },
      streams: [
        { codec_type: 'audio', codec_name: 'aac' },
        { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
      ],
    });
    const s = seed({ ffprobe: cover });
    const report = await s.verifier.verify({ ...baseInput, kind: 'audio', postprocessed: true });
    expect(byId(report, 'C6')?.status).toBe('PASS');
  });

  it('C6 still FAILs when an audio task really contains a content video stream', async () => {
    const withVideo = JSON.stringify({
      format: { duration: '10.000000' },
      streams: [
        { codec_type: 'audio', codec_name: 'aac' },
        { codec_type: 'video', codec_name: 'h264', disposition: { attached_pic: 0 } },
      ],
    });
    const s = seed({ ffprobe: withVideo });
    const report = await s.verifier.verify({ ...baseInput, kind: 'audio' });
    expect(byId(report, 'C6')?.status).toBe('FAIL');
  });
});
