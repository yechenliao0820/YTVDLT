#!/usr/bin/env node
/**
 * U3 empirical test (P0-14 / A-INF-03, M1 highest priority).
 *
 * Confirms that yt-dlp's generic extractor can handle a local direct media
 * link, and that the bundled LGPL FFmpeg is usable for merge/post-processing.
 * Uses ONLY bundled binaries + Node built-ins + bare argv[] commands; it does
 * NOT import any Core / engine-ytdlp TypeScript code (order adjustment D-01).
 *
 *   node scripts/u3-verify.mjs --json > reports/u3.json
 */
import { mkdir, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startMockServer } from './lib/mock-server.mjs';
import { sha256File } from './lib/hash.mjs';
import {
  buildGeneratedFixtureManifest, writeFixtureManifest,
} from './lib/fixture-manifest.mjs';

const execFileAsync = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNTIME = join(ROOT, 'resources', 'runtime', 'win-x64');
const FFMPEG_DIR = join(RUNTIME, 'ffmpeg');
const YTDLP = join(RUNTIME, 'yt-dlp.exe');
const NODE_EXE = join(RUNTIME, 'node.exe');
const FFMPEG = join(FFMPEG_DIR, 'ffmpeg.exe');
const FFPROBE = join(FFMPEG_DIR, 'ffprobe.exe');
const MEDIA_DIR = join(ROOT, 'tests', 'fixtures', 'media');
const FIXTURE = join(MEDIA_DIR, 'fixture.mp4');
const TMP_DIR = join(ROOT, 'reports', 'u3-tmp');
const REPORTS_DIR = join(ROOT, 'reports');

/** Run a bundled binary with an argv[] (absolute path, shell:false, hidden). */
async function run(file, argv, options = {}) {
  const { timeoutMs = 120_000, env = process.env, cwd = ROOT } = options;
  try {
    const { stdout, stderr } = await execFileAsync(file, argv, {
      cwd,
      env,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (error) {
    return {
      exitCode: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: `${error.stderr ?? ''}${error.message ? `\n${error.message}` : ''}`,
    };
  }
}

/** Detect an available H.264 / MPEG-4 video encoder in the LGPL build. */
async function detectVideoEncoder() {
  const result = await run(FFMPEG, ['-hide_banner', '-encoders']);
  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/);
  const hasLibx264 = lines.some((l) => /\blibx264\b/.test(l));
  const hasOpenH264 = lines.some((l) => /\blibopenh264\b/.test(l));
  const hasMpeg4 = lines.some((l) => /\smpeg4\s/.test(l));
  if (hasLibx264) return { codec: 'libx264', scheme: 'A', encoderLine: 'libx264' };
  if (hasOpenH264) return { codec: 'libopenh264', scheme: 'A', encoderLine: 'libopenh264' };
  if (hasMpeg4) return { codec: 'mpeg4', scheme: 'A-prime', encoderLine: 'mpeg4' };
  return { codec: 'mpeg4', scheme: 'A-prime-fallback', encoderLine: 'mpeg4 (assumed)' };
}

/** Generate a 10s fixture.mp4 (video + audio) with the bundled FFmpeg. */
async function ensureFixture(encoder) {
  await mkdir(MEDIA_DIR, { recursive: true });
  const existing = await stat(FIXTURE).catch(() => null);
  if (existing && existing.size > 0) {
    return { generated: false, command: '(reused existing fixture.mp4)' };
  }
  const videoArgs = encoder.codec === 'mpeg4'
    ? ['-c:v', 'mpeg4', '-q:v', '3']
    : ['-c:v', encoder.codec, '-b:v', '400k'];
  const argv = [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=10:size=320x240:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=10',
    ...videoArgs, '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-shortest', '-movflags', '+faststart',
    FIXTURE,
  ];
  const result = await run(FFMPEG, argv);
  if (result.exitCode !== 0) {
    throw new Error(`fixture generation failed (exit ${result.exitCode}): ${result.stderr.slice(-2000)}`);
  }
  return { generated: true, command: `${FFMPEG} ${argv.join(' ')}` };
}

/** ffprobe JSON of the fixture, plus C3/C5/C6 checks. */
async function probeFixture() {
  const result = await run(FFPROBE, [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', FIXTURE,
  ]);
  if (result.exitCode !== 0 || result.stderr.trim() !== '') {
    throw new Error(`ffprobe failed: exit=${result.exitCode} stderr=${result.stderr}`);
  }
  const json = JSON.parse(result.stdout);
  const streams = Array.isArray(json.streams) ? json.streams : [];
  const video = streams.filter((s) => s.codec_type === 'video');
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const duration = Number(json.format?.duration ?? NaN);
  return {
    duration,
    videoCount: video.length,
    audioCount: audio.length,
    videoCodec: video[0]?.codec_name ?? null,
    audioCodec: audio[0]?.codec_name ?? null,
    sizeBytes: (await stat(FIXTURE)).size,
    sha256: await sha256File(FIXTURE),
    c3ContainerOk: true,
    c5DurationOk: Number.isFinite(duration) && Math.abs(duration - 10) <= 1,
    c6StreamsOk: video.length >= 1 && audio.length >= 1,
  };
}

/** Full-frame decode; C4 verdict is "stderr empty", NOT exit code. */
async function decodeArtifact(artifactPath) {
  const result = await run(FFMPEG, ['-v', 'error', '-i', artifactPath, '-f', 'null', '-']);
  return { exitCode: result.exitCode, stderr: result.stderr, c4Ok: result.stderr.trim() === '' };
}

async function ffprobeArtifact(artifactPath) {
  const result = await run(FFPROBE, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', artifactPath]);
  if (result.exitCode !== 0) return { c3Ok: false, duration: null, streams: [], stderr: result.stderr };
  try {
    const json = JSON.parse(result.stdout);
    const streams = Array.isArray(json.streams) ? json.streams : [];
    return {
      c3Ok: result.stderr.trim() === '',
      duration: Number(json.format?.duration ?? NaN),
      streams: streams.map((s) => s.codec_type),
      stderr: result.stderr,
    };
  } catch (error) {
    return { c3Ok: false, duration: null, streams: [], stderr: String(error) };
  }
}

async function main() {
  const asJson = process.argv.includes('--json');
  await mkdir(REPORTS_DIR, { recursive: true });
  await mkdir(TMP_DIR, { recursive: true });
  const started = Date.now();
  const report = {
    id: 'U3',
    assertion: 'A-INF-03',
    timestamp: new Date().toISOString(),
    platform: 'win-x64',
    runtime: {},
    fixture: {},
    localServer: null,
    probe: null,
    download: null,
    postprocess: null,
    u8: null,
    conclusion: 'NOT_SUPPORTED',
    errors: [],
  };

  report.runtime = {
    ytdlp: (await run(YTDLP, ['--version'])).stdout.trim(),
    node: (await run(NODE_EXE, ['--version'])).stdout.trim(),
    ffmpeg: (await run(FFMPEG, ['-version'])).stdout.split(/\r?\n/)[0]?.trim() ?? '',
    devNode: process.version,
  };

  const encoder = await detectVideoEncoder();
  report.fixture = { ...(await ensureFixture(encoder)), ...(await probeFixture()), encoder };
  // Merge, never overwrite: later milestones add keys (expectedFormat/c8Golden)
  // that this script does not know about (M2 QA P1-2).
  const manifestWrite = await writeFixtureManifest(
    join(ROOT, 'tests', 'fixtures', 'manifest.json'),
    buildGeneratedFixtureManifest(report.fixture, encoder),
  );
  report.fixtureManifest = { preservedKeys: manifestWrite.preservedKeys };

  const server = await startMockServer({ files: { '/fixture.mp4': FIXTURE } });
  report.localServer = { url: server.url, port: server.port, boundHost: '127.0.0.1', rangeSupported: true };
  const url = `${server.url}/fixture.mp4`;
  const nodeArg = `node:${NODE_EXE}`;

  try {
    // ---- ① raw U3 probe (bare exe, exact frozen argv order) ----
    const probeArgv = [
      '-J', '--dump-single-json', '--no-playlist', '--no-warnings',
      '--socket-timeout', '5', '-R', '1',
      '--no-js-runtimes', '--js-runtimes', nodeArg,
      '--', url,
    ];
    const probeResult = await run(YTDLP, probeArgv, { timeoutMs: 90_000 });
    await writeFile(join(REPORTS_DIR, 'u3-probe-raw.json'), probeResult.stdout || '{}', 'utf8');
    let parsed = null;
    try { parsed = JSON.parse(probeResult.stdout); } catch { /* handled below */ }
    const fields = parsed ? {
      id: 'id' in parsed, title: 'title' in parsed, duration: 'duration' in parsed,
      formats: Array.isArray(parsed.formats), ext: 'ext' in parsed,
      webpage_url: 'webpage_url' in parsed, extractor_key: 'extractor_key' in parsed,
      thumbnail: 'thumbnail' in parsed,
    } : null;
    report.probe = {
      command: `${YTDLP} ${probeArgv.join(' ')}`,
      exitCode: probeResult.exitCode,
      stderr: probeResult.stderr.slice(0, 4000),
      jsonParseOk: parsed !== null,
      fields,
      extractorKey: parsed?.extractor_key ?? null,
      formatCount: Array.isArray(parsed?.formats) ? parsed.formats.length : 0,
      duration: parsed?.duration ?? null,
      ok: probeResult.exitCode === 0 && parsed !== null && !/ERROR:/.test(probeResult.stderr),
    };

    // ---- U8: --ffmpeg-location support ----
    const help = await run(YTDLP, ['--help']);
    report.u8 = {
      ffmpegLocationSupported: /--ffmpeg-location/.test(`${help.stdout}${help.stderr}`),
      fallback: 'PATH-prepend <runtimeDir>/ffmpeg before spawn (§12.4 铁律 5)',
    };

    // ---- ② real download incl. ffmpeg merge / post-process ----
    const outTemplate = join(TMP_DIR, '%(title)s.%(ext)s');
    const downloadArgv = [
      '--no-playlist', '--no-warnings', '--socket-timeout', '5', '-R', '1',
      '--no-js-runtimes', '--js-runtimes', nodeArg,
      '--ffmpeg-location', FFMPEG_DIR,
      '-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4', '--remux-video', 'mp4',
      '-o', outTemplate,
      '--', url,
    ];
    const env = { ...process.env, PATH: `${FFMPEG_DIR};${process.env.PATH ?? ''}` };
    const dl = await run(YTDLP, downloadArgv, { timeoutMs: 180_000, env });
    const produced = (await import('node:fs/promises')).readdir(TMP_DIR)
      .then((names) => names.filter((n) => /\.(mp4|mkv|webm|m4a)$/i.test(n)))
      .catch(() => []);
    const names = await produced;
    const artifactPath = names.length > 0 ? join(TMP_DIR, names[0]) : null;
    let artifact = null;
    if (artifactPath) {
      const size = (await stat(artifactPath)).size;
      artifact = {
        path: artifactPath,
        sizeBytes: size,
        sha256: await sha256File(artifactPath),
        c1Ok: size > 0,
        ...(await ffprobeArtifact(artifactPath)),
        c4: await decodeArtifact(artifactPath),
      };
      artifact.c5Ok = artifact.duration !== null && Math.abs(artifact.duration - 10) <= 1;
      artifact.c6Ok = artifact.streams.includes('video') && artifact.streams.includes('audio');
    }
    report.download = {
      command: `${YTDLP} ${downloadArgv.join(' ')}`,
      exitCode: dl.exitCode,
      stdout: dl.stdout.slice(0, 6000),
      stderr: dl.stderr.slice(0, 4000),
      artifact,
      ffmpegInvocationSeen: /\[(PostProcess|Merge|Remux)|ffmpeg/i.test(`${dl.stdout}${dl.stderr}`),
    };

    // ---- ③ explicit remux fallback proves post-processing path ----
    if (artifactPath) {
      const merged = join(TMP_DIR, 'merged.mp4');
      const remux = await run(FFMPEG, [
        '-hide_banner', '-y', '-i', artifactPath, '-c', 'copy', '-movflags', '+faststart', merged,
      ]);
      report.postprocess = {
        command: `${FFMPEG} -hide_banner -y -i <artifact> -c copy -movflags +faststart merged.mp4`,
        exitCode: remux.exitCode,
        stderr: remux.stderr.slice(0, 2000),
        ok: remux.exitCode === 0 && (await stat(merged).catch(() => ({ size: 0 }))).size > 0,
      };
    }

    const artifactOk = Boolean(
      report.probe.ok &&
      report.download.exitCode === 0 &&
      report.download.artifact?.c1Ok &&
      report.download.artifact?.c3Ok &&
      report.download.artifact?.c4?.c4Ok &&
      report.download.artifact?.c5Ok &&
      report.download.artifact?.c6Ok,
    );
    report.conclusion = artifactOk ? 'SUPPORTED' : 'NOT_SUPPORTED';
  } catch (error) {
    report.errors.push(error.stack || String(error));
    report.conclusion = 'NOT_SUPPORTED';
  } finally {
    await server.close();
  }

  report.durationMs = Date.now() - started;
  await writeFile(join(REPORTS_DIR, 'u3.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(`U3 conclusion: ${report.conclusion}`);
    console.log(`  probe      exit=${report.probe?.exitCode} json=${report.probe?.jsonParseOk} fields=${JSON.stringify(report.probe?.fields)}`);
    console.log(`  download   exit=${report.download?.exitCode} artifact=${report.download?.artifact?.sizeBytes ?? 0}B c1=${report.download?.artifact?.c1Ok} c3=${report.download?.artifact?.c3Ok} c4=${report.download?.artifact?.c4?.c4Ok} c5=${report.download?.artifact?.c5Ok} c6=${report.download?.artifact?.c6Ok}`);
    console.log(`  postproc   ${report.postprocess?.ok ? 'OK' : 'N/A'}  U8 --ffmpeg-location=${report.u8?.ffmpegLocationSupported}`);
    console.log(`  fixture    ${report.fixture?.videoCodec}+${report.fixture?.audioCodec} ${report.fixture?.duration}s sha256=${report.fixture?.sha256}`);
    console.log(`  reports/u3.json + reports/u3-probe-raw.json written`);
  }
  process.exitCode = report.conclusion === 'SUPPORTED' ? 0 : 1;
}

main().catch((error) => {
  console.error(`[u3-verify] fatal: ${error.stack || error.message}`);
  process.exitCode = 1;
});
