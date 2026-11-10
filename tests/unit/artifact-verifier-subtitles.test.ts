/**
 * Stage 4 · attachment probes and the verifier's behaviour around subtitles.
 *
 * Two rules under test:
 *  1. A subtitle file is NEVER the "primary artifact" — C3–C8 must not ffprobe
 *     it, and "the task produced only subtitles" is a failure, not a success.
 *  2. Subtitle checks are advisory: an HTML page saved as `.srt`, or a missing
 *     embedded stream, never flips `report.ok` (D-127). A broken subtitle is not
 *     a broken video.
 */
import { describe, it, expect } from 'vitest';
import { ArtifactVerifier, inspectSubtitleText, primaryArtifact } from '@ytvdlt/core';
import type { ExpectedArtifactManifest, MediaInfo, SubtitleDomain } from '@ytvdlt/shared';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const RUNTIME = 'C:/runtime';
const MEDIA = 'C:/out/Clip [id].mp4';
const SHA = 'a'.repeat(64);

const FFPROBE_OK = JSON.stringify({
  format: { duration: '10.000000' },
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 320, height: 240, avg_frame_rate: '25/1' },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
});
const FFPROBE_SUB_STREAM = JSON.stringify({
  streams: [{ codec_type: 'subtitle', codec_name: 'subrip' }],
});
const FFPROBE_NO_SUB_STREAM = JSON.stringify({ streams: [] });

const MANIFEST: ExpectedArtifactManifest = {
  sha256: SHA, sizeBytes: 308666, durationSec: 10, videoCodec: 'h264', audioCodec: 'aac',
  expectedFormat: null, c8Golden: null,
};

const WEBVTT = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi\n';

function seed(options: { subtitleProbe?: string } = {}) {
  const { ports, state } = createInMemoryPorts();
  state.env.runtimeDir = RUNTIME;
  state.files.set(MEDIA, 'video-bytes');
  // The subtitle-stream probe must be registered FIRST: matchers are matched in
  // insertion order and `ffprobe.exe` would otherwise swallow it.
  if (options.subtitleProbe !== undefined) {
    state.spawnResults.set('-select_streams', {
      exitCode: 0, stdout: options.subtitleProbe, stderr: '', timedOut: false,
    });
  }
  state.spawnResults.set('ffprobe.exe', {
    exitCode: 0, stdout: FFPROBE_OK, stderr: '', timedOut: false,
  });
  state.spawnResults.set('-f null -', { exitCode: 0, stdout: '', stderr: '', timedOut: false });
  state.spawnResults.set('framemd5', { exitCode: 0, stdout: 'x\n', stderr: '', timedOut: false });
  return { verifier: new ArtifactVerifier({ ports }), ports, state };
}

const mediaInfo = (overrides: Partial<MediaInfo> = {}): MediaInfo => ({
  id: 'fixture', title: 'fixture', uploader: null, uploader_id: null,
  duration: 10, thumbnail: null, webpage_url: 'http://127.0.0.1:1/fixture.mp4',
  extractor_key: 'generic', description: null, upload_date: null, ext: 'mp4',
  formats: [], subtitles: {}, automatic_captions: {}, chapters: null, _type: 'video', ...overrides,
});

const subtitleDomain = (overrides: Partial<SubtitleDomain> = {}): SubtitleDomain => ({
  enabled: true, languages: 'en', autoCaptions: false, skipTranslated: true,
  convertTo: 'srt', embed: false, keepSubtitleFile: false, ...overrides,
});

const baseInput = {
  taskId: 't1',
  artifacts: [MEDIA],
  expected: mediaInfo(),
  postprocessed: false,
  expectedManifest: MANIFEST,
  historyEntry: null,
  kind: 'video' as const,
};

const byId = (report: { criteria: Array<{ id: string; status: string; detail: string }> }, id: string) =>
  report.criteria.find((criterion) => criterion.id === id);

describe('primaryArtifact · never a subtitle', () => {
  it('picks the media even when the subtitle is listed first', () => {
    expect(primaryArtifact([`${MEDIA}.en.srt`, MEDIA])).toBe(MEDIA);
  });

  it('returns null for a subtitle-only artifact list', () => {
    expect(primaryArtifact(['C:/out/a.en.srt', 'C:/out/a.de.vtt'])).toBeNull();
  });

  it('makes C3 fail with an honest message instead of probing the subtitle', async () => {
    const { verifier } = seed();
    const report = await verifier.verify({ ...baseInput, artifacts: ['C:/out/Clip [id].en.srt'] });
    expect(byId(report, 'C3')?.status).toBe('FAIL');
    expect(byId(report, 'C3')?.detail).toContain('no primary artifact');
    expect(report.ok).toBe(false);
  });
});

describe('inspectSubtitleText · format headers', () => {
  it('accepts every supported format with its real header', () => {
    const samples: Record<string, string> = {
      vtt: WEBVTT,
      srt: '1\n00:00:00,000 --> 00:00:01,000\nhi\n',
      ass: '[Script Info]\nTitle: x\n[Events]\n',
      ssa: '[Script Info]\n',
      lrc: '[00:12.34]hello\n',
      ttml: '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"></tt>',
      dfxp: '<tt xmlns="http://www.w3.org/ns/ttml"></tt>',
      srv3: '<?xml version="1.0"?><timedtext><body/></timedtext>',
      srv1: '<timedtext><body/></timedtext>',
      srv2: '<timedtext><body/></timedtext>',
      json3: '{"events":[{"tStartMs":0}]}',
      sami: '<SAMI><BODY/></SAMI>',
      smi: '<SAMI><BODY/></SAMI>',
      sbv: '0:00:00.000,0:00:01.000\nhi\n',
    };
    for (const [ext, text] of Object.entries(samples)) {
      expect(inspectSubtitleText(ext, text).status, ext).toBe('PASS');
    }
  });

  it('FAILs an HTML page saved as a subtitle (the classic login-wall case)', () => {
    const verdict = inspectSubtitleText('srt', '<!DOCTYPE html><html><body>Sign in</body></html>');
    expect(verdict.status).toBe('FAIL');
    expect(verdict.detail).toContain('HTML');
  });

  it('FAILs empty and wrong-format content', () => {
    expect(inspectSubtitleText('vtt', '   ').status).toBe('FAIL');
    expect(inspectSubtitleText('vtt', '1\n00:00:00,000 --> 00:00:01,000\n').status).toBe('FAIL');
    expect(inspectSubtitleText('srt', 'WEBVTT\n\n').status).toBe('FAIL');
  });

  it('SKIPs a format it has no rule for (never a false failure)', () => {
    expect(inspectSubtitleText('sbv2', 'anything').status).toBe('SKIPPED');
  });
});

describe('verifier · attachments are advisory', () => {
  it('reports an HTML-error subtitle without failing the task', async () => {
    const { verifier, state } = seed();
    const bad = 'C:/out/Clip [id].en.srt';
    state.files.set(bad, '<!DOCTYPE html><html>blocked</html>');
    // No expected manifest: this test is about the advisory verdict, not about
    // C2/C10 byte hashes (which would fail for a fixture with no real bytes).
    const report = await verifier.verify({ ...baseInput, expectedManifest: null, artifacts: [MEDIA, bad] });

    const probe = report.attachments?.find((item) => item.path === bad);
    expect(probe?.status).toBe('FAIL');
    // …and the media verdict is untouched.
    expect(report.ok).toBe(true);
    expect(report.criteria.every((criterion) => criterion.status !== 'FAIL')).toBe(true);
  });

  it.each([false, true])('checks complete large json3 content (truncated=%s)', async (truncated) => {
    const { verifier, state } = seed();
    const path = 'C:/out/Clip [id].en.json3';
    const content = JSON.stringify({ events: [{ text: 'x'.repeat(9000) }] });
    state.files.set(path, truncated ? content.slice(0, -1) : content);
    const report = await verifier.verify({ ...baseInput, expectedManifest: null, artifacts: [MEDIA, path] });
    expect(report.attachments?.find((probe) => probe.path === path)?.status).toBe(truncated ? 'FAIL' : 'PASS');
    expect(report.ok).toBe(true);
  });

  it('skips oversized subtitle content without reading it or failing the media', async () => {
    const { verifier, ports, state } = seed();
    const path = 'C:/out/Clip [id].en.json3';
    state.files.set(path, '{}');
    const stat = ports.fs.stat.bind(ports.fs);
    ports.fs.stat = async (target) => ({ ...await stat(target), ...(target === path ? { sizeBytes: 8 * 1024 * 1024 + 1 } : {}) });
    const readText = ports.fs.readText.bind(ports.fs);
    ports.fs.readText = async (target) => {
      if (target === path) throw new Error('oversized subtitle must not be read');
      return readText(target);
    };
    const report = await verifier.verify({ ...baseInput, expectedManifest: null, artifacts: [MEDIA, path] });
    expect(report.attachments?.[0]?.status).toBe('SKIPPED');
    expect(report.attachments?.[0]?.detail).toContain('8 MiB');
    expect(report.ok).toBe(true);
  });

  it('reports a valid subtitle as PASS', async () => {
    const { verifier, state } = seed();
    const good = 'C:/out/Clip [id].en.srt';
    state.files.set(good, '1\n00:00:00,000 --> 00:00:01,000\nhi\n');
    const report = await verifier.verify({ ...baseInput, artifacts: [MEDIA, good] });
    expect(report.attachments?.[0]?.status).toBe('PASS');
  });

  it('has no attachment section when the task produced no attachments', async () => {
    const { verifier } = seed();
    const report = await verifier.verify(baseInput);
    expect(report.attachments).toBeUndefined();
  });
});

describe('verifier · embedded subtitles are checked against the container', () => {
  it('does not probe at all when embedding was not requested', async () => {
    const { verifier, state } = seed({ subtitleProbe: FFPROBE_SUB_STREAM });
    await verifier.verify({ ...baseInput, subtitleRequest: subtitleDomain({ embed: false }) });
    expect(state.spawnCalls.some((call) => call.argv.includes('-select_streams'))).toBe(false);
  });

  it('PASSes when the container really carries a subtitle stream', async () => {
    const { verifier, state } = seed({ subtitleProbe: FFPROBE_SUB_STREAM });
    const report = await verifier.verify({
      ...baseInput, expectedManifest: null, subtitleRequest: subtitleDomain({ embed: true }),
    });
    expect(state.spawnCalls.some((call) => call.argv.includes('-select_streams'))).toBe(true);
    expect(report.attachments?.some((item) => item.detail.includes('1 subtitle stream'))).toBe(true);
    expect(report.ok).toBe(true);
  });

  it.each([1, 2])('requires enough embedded tracks for requested languages (tracks=%s)', async (count) => {
    const { verifier } = seed({ subtitleProbe: JSON.stringify({
      streams: Array.from({ length: count }, () => ({ codec_type: 'subtitle', codec_name: 'subrip' })),
    }) });
    const track = { lang: 'en', ext: 'vtt', url: 'https://example.test/sub.vtt', name: null };
    const report = await verifier.verify({
      ...baseInput, expectedManifest: null,
      expected: mediaInfo({ subtitles: { en: [track], fr: [{ ...track, lang: 'fr' }] } }),
      subtitleRequest: subtitleDomain({ embed: true, languages: 'all' }),
    });
    expect(report.attachments?.[0]?.status).toBe(count === 1 ? 'FAIL' : 'PASS');
    expect(report.ok).toBe(true);
  });

  it('keeps rejected advisory probes from failing the media', async () => {
    const { verifier, ports } = seed();
    const spawn = ports.process.spawn.bind(ports.process);
    ports.process.spawn = async (file, argv, options) => {
      if (argv.includes('-select_streams')) throw new Error('probe unavailable');
      return spawn(file, argv, options);
    };
    const report = await verifier.verify({
      ...baseInput, expectedManifest: null, subtitleRequest: subtitleDomain({ embed: true }),
    });
    expect(report.attachments?.[0]?.status).toBe('SKIPPED');
    expect(report.ok).toBe(true);
  });

  it('reports a missing stream but still completes (embedding is not the video)', async () => {
    const { verifier } = seed({ subtitleProbe: FFPROBE_NO_SUB_STREAM });
    const report = await verifier.verify({
      ...baseInput, expectedManifest: null, subtitleRequest: subtitleDomain({ embed: true }),
    });
    expect(report.attachments?.some((item) => item.status === 'FAIL')).toBe(true);
    expect(report.ok).toBe(true);
  });
});
