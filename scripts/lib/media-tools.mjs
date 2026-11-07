/**
 * Shared ffprobe/ffmpeg helpers for build-time scripts (u3-verify, verify-artifact).
 * Absolute binary paths + argv[] only; never a shell string.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Run a bundled binary.
 * @returns {{exitCode:number|null, stdout:string, stderr:string, timedOut:boolean}}
 */
export async function runBinary(file, argv, options = {}) {
  const { cwd, env, timeoutMs = 120_000 } = options;
  try {
    const { stdout, stderr } = await execFileAsync(file, argv, {
      ...(cwd === undefined ? {} : { cwd }),
      ...(env === undefined ? {} : { env }),
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: stdout ?? '', stderr: stderr ?? '', timedOut: false };
  } catch (error) {
    return {
      exitCode: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: `${error.stderr ?? ''}${error.message ? `\n${error.message}` : ''}`,
      timedOut: Boolean(error.killed),
    };
  }
}

/** `ffprobe -v error -show_format -show_streams -of json <file>` */
export async function ffprobeJson(ffprobePath, file) {
  const result = await runBinary(ffprobePath, [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', file,
  ]);
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { json = null; }
  return { ...result, json };
}

/** C4-style decode check: verdict is `stderr === ''` (exit code is NOT the verdict). */
export async function ffmpegDecodeCheck(ffmpegPath, file) {
  const result = await runBinary(ffmpegPath, ['-v', 'error', '-i', file, '-f', 'null', '-']);
  return { ...result, stderrEmpty: result.stderr.trim() === '' };
}

/** C8: frame hashes for the video stream. */
export async function framemd5(ffmpegPath, file) {
  const result = await runBinary(ffmpegPath, [
    '-v', 'error', '-i', file, '-map', '0:v', '-f', 'framemd5', '-',
  ]);
  return { ...result, text: result.stdout };
}
