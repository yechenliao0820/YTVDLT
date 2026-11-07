#!/usr/bin/env node
/**
 * YTVDLT M1 runtime fetcher.
 *
 * Usage:
 *   node scripts/fetch-runtime.mjs --only=ytdlp|node|ffmpeg|all
 *   node scripts/fetch-runtime.mjs --only=<key> --verify-only
 *   node scripts/fetch-runtime.mjs --finalize          (write/refresh manifest)
 *
 * Long downloads are intended to be launched as background tasks, one
 * `--only=<key>` at a time, then each verified with `--verify-only`.
 * Downloads land in `resources/.cache/` and are atomically placed into
 * `resources/runtime/win-x64/`. Binaries are NOT committed to git.
 */
import { readFile, writeFile, mkdir, rm, rename, readdir, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { downloadFile, fileSize } from './lib/download.mjs';
import { sha256File, verifyAgainstSums } from './lib/hash.mjs';
import { listZipEntries, readZipEntry } from './lib/zip.mjs';
import {
  readManifest, writeManifest, upsertItem, verifyManifestOnDisk,
  buildItem, fromManifestPath, MANIFEST_FILENAME,
} from './lib/manifest.mjs';

const execFileAsync = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNTIME_DIR = join(ROOT, 'resources', 'runtime', 'win-x64');
const FFMPEG_DIR = join(RUNTIME_DIR, 'ffmpeg');
const CACHE_DIR = join(ROOT, 'resources', '.cache');
const MANIFEST_PATH = join(RUNTIME_DIR, MANIFEST_FILENAME);

const YTDLP_TAG = '2026.10.26';
const YTDLP_VERSION = '2026.10.26';
const YTDLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_TAG}/yt-dlp.exe`;
const YTDLP_SUMS_URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_TAG}/SHA2-256SUMS`;
const YTDLP_EXPECTED_SIZE = 23_575_744;

const NODE_TAG = 'v24.22.2';
const NODE_VERSION = 'v24.22.2';
const NODE_ZIP_URL = `https://nodejs.org/dist/${NODE_TAG}/node-${NODE_TAG}-win-x64.zip`;
const NODE_ZIP_ENTRY = `node-${NODE_TAG}-win-x64/node.exe`;

const FFMPEG_TAG = 'latest';
const FFMPEG_ASSET = 'ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip';
const FFMPEG_URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_TAG}/${FFMPEG_ASSET}`;
const FFMPEG_FALLBACK_TAG = 'autobuild-2026-11-04-12-51';
const FFMPEG_FALLBACK_ASSET = 'ffmpeg-n9.0.2-47-gb204e94e90-win64-lgpl-shared-9.0.zip';
const FFMPEG_FALLBACK_URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_FALLBACK_TAG}/${FFMPEG_FALLBACK_ASSET}`;
const FFMPEG_EXPECTED_SIZE = 76_568_576;
const FFMPEG_FALLBACK_SIZE = 76_577_144;

function log(...args) { console.log(...args); }
function fail(message) { console.error(`[fetch-runtime] ERROR: ${message}`); process.exitCode = 3; }

function parseArgs(argv) {
  const args = { only: 'all', verifyOnly: false, finalize: false };
  for (const raw of argv) {
    if (raw.startsWith('--only=')) args.only = raw.slice('--only='.length);
    else if (raw === '--verify-only') args.verifyOnly = true;
    else if (raw === '--finalize') args.finalize = true;
    else if (raw === '--json') args.json = true;
  }
  return args;
}

/** Spawn a bundled binary with argv[] (never a shell string). */
async function probeVersion(exePath, argv) {
  const { stdout, stderr } = await execFileAsync(exePath, argv, {
    windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  const text = `${stdout || ''}${stderr || ''}`.trim();
  return text.split(/\r?\n/)[0] ?? '';
}

async function resolveLatestRelease() {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['-e', `fetch('https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/latest',{headers:{'User-Agent':'YTVDLT-M1'}}).then(r=>r.json()).then(j=>process.stdout.write(JSON.stringify({tag:j.tag_name,published:j.published_at,name:j.name,assets:(j.assets||[]).map(a=>a.name)}))).catch(()=>process.stdout.write('{}'))`],
      { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout || '{}');
    if (parsed && parsed.tag) return parsed;
  } catch { /* fall through to static URL */ }
  return null;
}

/** Fetch + place yt-dlp.exe and the official SHA2-256SUMS; cross-verify. */
async function fetchYtDlp() {
  const exePath = join(RUNTIME_DIR, 'yt-dlp.exe');
  const sumsPath = join(RUNTIME_DIR, 'SHA2-256SUMS');
  const cachedExe = join(CACHE_DIR, 'yt-dlp.exe');
  const cachedSums = join(CACHE_DIR, 'SHA2-256SUMS');

  await downloadFile(YTDLP_URL, cachedExe, { label: 'yt-dlp.exe', expectedSize: YTDLP_EXPECTED_SIZE });
  await downloadFile(YTDLP_SUMS_URL, cachedSums, { label: 'SHA2-256SUMS' });

  const check = await verifyAgainstSums(cachedSums, 'yt-dlp.exe', await sha256File(cachedExe));
  if (!check.ok) {
    throw new Error(`yt-dlp.exe official SHA2-256SUMS mismatch: expected ${check.expected}, got ${check.actual}`);
  }
  await mkdir(RUNTIME_DIR, { recursive: true });
  await rm(exePath, { force: true });
  await rename(cachedExe, exePath);
  await rm(sumsPath, { force: true });
  await rename(cachedSums, sumsPath);
  log(`[fetch-runtime] ytdlp OK sha256=${check.actual} size=${await fileSize(exePath)}`);
  return { check, sumsText: await readFile(sumsPath, 'utf8') };
}

/** Fetch the Node zip and extract only node.exe. */
async function fetchNode() {
  const exePath = join(RUNTIME_DIR, 'node.exe');
  const zipPath = join(CACHE_DIR, 'node-win-x64.zip');
  await downloadFile(NODE_ZIP_URL, zipPath, { label: 'node win-x64 zip' });
  const buffer = await readFile(zipPath);
  const entry = listZipEntries(buffer).find((e) => e.name === NODE_ZIP_ENTRY);
  if (!entry) throw new Error(`node.exe entry not found in zip (${NODE_ZIP_ENTRY})`);
  const payload = readZipEntry(buffer, entry);
  const tmp = `${exePath}.tmp`;
  await mkdir(RUNTIME_DIR, { recursive: true });
  await writeFile(tmp, payload);
  await rm(exePath, { force: true });
  await rename(tmp, exePath);
  log(`[fetch-runtime] node OK sha256=${await sha256File(exePath)} size=${payload.length}`);
}

/** Fetch BtbN LGPL shared zip and place the ENTIRE bin/ verbatim. */
async function fetchFfmpeg() {
  const zipPath = join(CACHE_DIR, 'ffmpeg-lgpl-shared.zip');
  let sourceUrl = FFMPEG_URL;
  let releaseTag = `latest/${FFMPEG_ASSET}`;
  let expectedSize = FFMPEG_EXPECTED_SIZE;

  const meta = await resolveLatestRelease();
  if (meta) {
    const hasAsset = Array.isArray(meta.assets) && meta.assets.includes(FFMPEG_ASSET);
    releaseTag = `${meta.tag}/${FFMPEG_ASSET}/published:${meta.published ?? 'unknown'}`;
    if (!hasAsset) {
      // Rolling tag moved on: use the reproducible autobuild pin instead.
      sourceUrl = FFMPEG_FALLBACK_URL;
      releaseTag = `${FFMPEG_FALLBACK_TAG}/${FFMPEG_FALLBACK_ASSET}`;
      expectedSize = FFMPEG_FALLBACK_SIZE;
    }
  }

  let downloaded = false;
  try {
    await downloadFile(sourceUrl, zipPath, { label: 'ffmpeg LGPL shared zip', expectedSize });
    downloaded = true;
  } catch (error) {
    if (sourceUrl === FFMPEG_URL) {
      log(`[fetch-runtime] latest asset unavailable (${error.message}); using pinned autobuild`);
      sourceUrl = FFMPEG_FALLBACK_URL;
      releaseTag = `${FFMPEG_FALLBACK_TAG}/${FFMPEG_FALLBACK_ASSET}`;
      expectedSize = FFMPEG_FALLBACK_SIZE;
      await rm(zipPath, { force: true });
      await downloadFile(sourceUrl, zipPath, { label: 'ffmpeg LGPL shared zip (pinned)', expectedSize });
      downloaded = true;
    } else {
      throw error;
    }
  }
  if (!downloaded) throw new Error('ffmpeg download did not complete');

  const buffer = await readFile(zipPath);
  const entries = listZipEntries(buffer);
  const binEntries = entries.filter((e) => /(^|\/)bin\/[^/]+$/.test(e.name) && !e.name.endsWith('/'));
  if (binEntries.length < 2) throw new Error('ffmpeg zip bin/ is missing or empty');

  await mkdir(FFMPEG_DIR, { recursive: true });
  // Staging directory, then atomic-ish swap of the whole bin/ contents.
  const staging = join(CACHE_DIR, 'ffmpeg-bin-stage');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  for (const entry of binEntries) {
    const payload = readZipEntry(buffer, entry);
    await writeFile(join(staging, basename(entry.name)), payload);
  }
  for (const name of await readdir(FFMPEG_DIR)) {
    await rm(join(FFMPEG_DIR, name), { recursive: true, force: true });
  }
  for (const name of await readdir(staging)) {
    await rename(join(staging, name), join(FFMPEG_DIR, name));
  }

  // Copy the license text shipped inside the zip as FFMPEG-LICENSE.txt.
  // Directory entries (trailing slash / zero size) must be skipped — the zip
  // root folder is itself named "*lgpl-shared*" and would otherwise match.
  const licenseEntry = entries.find((e) =>
    !e.name.endsWith('/') &&
    e.uncompressedSize > 100 &&
    e.uncompressedSize < 200_000 &&
    /^(LICENSE|COPYING|COPYING\.LESSER)(\.txt|\.md)?$/i.test(basename(e.name)),
  );
  const licensePath = join(RUNTIME_DIR, 'FFMPEG-LICENSE.txt');
  if (licenseEntry) {
    await writeFile(licensePath, readZipEntry(buffer, licenseEntry));
  } else if ((await fileSize(licensePath)) === null || (await fileSize(licensePath)) === 0) {
    await writeFile(licensePath, [
      'FFmpeg is licensed under the GNU Lesser General Public License (LGPL) version 2.1 or later.',
      'This build is BtbN FFmpeg-Builds *-win64-lgpl-shared (dynamic DLL linking, no --enable-gpl).',
      'Source and build scripts: https://github.com/BtbN/FFmpeg-Builds',
      'License text: https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt',
      `Asset: ${basename(sourceUrl)}`,
    ].join('\n') + '\n', 'utf8');
  }
  log(`[fetch-runtime] ffmpeg OK bin files=${binEntries.length} source=${sourceUrl}`);
  return { sourceUrl, releaseTag, binNames: binEntries.map((e) => basename(e.name)) };
}

/** Version metadata for manifest items. */
async function collectVersions() {
  const versions = {};
  try { versions.ytdlp = (await probeVersion(join(RUNTIME_DIR, 'yt-dlp.exe'), ['--version'])).trim(); } catch { versions.ytdlp = YTDLP_VERSION; }
  try { versions.node = (await probeVersion(join(RUNTIME_DIR, 'node.exe'), ['--version'])).trim(); } catch { versions.node = NODE_VERSION; }
  try {
    const firstLine = await probeVersion(join(FFMPEG_DIR, 'ffmpeg.exe'), ['-version']);
    const m = /ffmpeg version (\S+)/i.exec(firstLine);
    versions.ffmpeg = m ? m[1] : firstLine.trim() || 'n9.0';
  } catch { versions.ffmpeg = 'n9.0'; }
  return versions;
}

async function toolVersions() {
  const nodeBinDir = dirname(process.execPath);
  const candidates = {
    node: [process.execPath, ['-v']],
    npm: [process.execPath, [join(nodeBinDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '-v']],
    pnpm: [process.execPath, [join(nodeBinDir, 'node_modules', 'corepack', 'dist', 'pnpm.js'), '-v']],
  };
  const values = { node: process.version, npm: 'unknown', pnpm: 'unknown' };
  for (const key of ['node', 'npm', 'pnpm']) {
    const [file, argv] = candidates[key];
    try {
      const { stdout } = await execFileAsync(file, argv, { windowsHide: true, timeout: 20_000 });
      const text = stdout.trim();
      if (text.length > 0) values[key] = text;
    } catch { /* fall back to the package.json files below */ }
  }
  // Fallback: read the CLI package.json versions directly (Windows .cmd shims
  // cannot be spawned with execFile, so we resolve their real JS/package paths).
  for (const [key, rel] of [
    ['npm', ['node_modules', 'npm', 'package.json']],
    ['pnpm', ['node_modules', 'corepack', 'package.json']],
  ]) {
    if (values[key] !== 'unknown') continue;
    try {
      const pkg = JSON.parse(await readFile(join(nodeBinDir, ...rel), 'utf8'));
      if (typeof pkg.version === 'string') values[key] = key === 'pnpm' ? `${pkg.version} (corepack)` : pkg.version;
    } catch { /* keep unknown */ }
  }
  return values;
}

/** Build/refresh the full manifest from what is actually on disk. */
async function finalizeManifest() {
  const versions = await collectVersions();
  const tools = await toolVersions();
  const sumsText = await readFile(join(RUNTIME_DIR, 'SHA2-256SUMS'), 'utf8').catch(() => '');
  const sumsMap = new Map();
  for (const line of sumsText.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m) sumsMap.set(m[2].trim(), m[1].toLowerCase());
  }
  const ffmpegTagLine = await readFile(join(CACHE_DIR, 'ffmpeg-release-tag.txt'), 'utf8').catch(() => `latest/${FFMPEG_ASSET}`);
  const ffmpegSourceUrl = await readFile(join(CACHE_DIR, 'ffmpeg-source-url.txt'), 'utf8').catch(() => FFMPEG_URL);

  let manifest;
  try { manifest = await readManifest(MANIFEST_PATH); } catch {
    manifest = { schemaVersion: 1, platform: 'win-x64', generatedAt: new Date().toISOString(), toolVersions: tools, items: [] };
  }
  manifest.toolVersions = tools;
  manifest.generatedAt = new Date().toISOString();

  const ytdlpMeta = {
    version: versions.ytdlp || YTDLP_VERSION, sourceUrl: YTDLP_URL, releaseTag: YTDLP_TAG,
    license: 'Unlicense', required: true, kind: 'ytdlp', group: 'ytdlp',
  };
  const nodeMeta = {
    version: versions.node || NODE_VERSION, sourceUrl: NODE_ZIP_URL, releaseTag: NODE_TAG,
    license: 'MIT', required: true, kind: 'node', group: 'node',
  };
  const ffmpegMeta = {
    version: versions.ffmpeg, sourceUrl: ffmpegSourceUrl.trim(), releaseTag: ffmpegTagLine.trim(),
    // The shipped BtbN LGPL build carries LGPLv3 text (DECISIONS D-08).
    license: 'LGPL-3.0', required: true, kind: 'ffmpeg', group: 'ffmpeg',
  };

  const ytdlpExe = join(RUNTIME_DIR, 'yt-dlp.exe');
  upsertItem(manifest, await buildItem(RUNTIME_DIR, ytdlpExe, ytdlpMeta));
  const official = sumsMap.get('yt-dlp.exe');
  if (official) {
    const item = manifest.items.find((i) => i.path === 'yt-dlp.exe');
    if (item && item.sha256 !== official) {
      throw new Error(`yt-dlp.exe manifest sha256 ${item.sha256} != official SUMS ${official}`);
    }
  }

  upsertItem(manifest, await buildItem(RUNTIME_DIR, join(RUNTIME_DIR, 'node.exe'), nodeMeta));
  for (const name of await readdir(FFMPEG_DIR)) {
    if (!/\.(exe|dll)$/i.test(name)) continue;
    const kind = /^ffprobe/i.test(name) ? 'ffprobe' : 'ffmpeg';
    upsertItem(manifest, await buildItem(RUNTIME_DIR, join(FFMPEG_DIR, name), { ...ffmpegMeta, kind }));
  }
  await writeManifest(MANIFEST_PATH, manifest);
  log(`[fetch-runtime] manifest written: ${manifest.items.length} items`);
  return manifest;
}

async function verify(args) {
  const manifest = await readManifest(MANIFEST_PATH);
  const groupPaths = {
    ytdlp: ['yt-dlp.exe'],
    node: ['node.exe'],
    ffmpeg: manifest.items.filter((i) => i.group === 'ffmpeg').map((i) => i.path),
    all: manifest.items.map((i) => i.path),
  };
  const onlyPaths = groupPaths[args.only] ?? groupPaths.all;
  const results = await verifyManifestOnDisk(RUNTIME_DIR, manifest, onlyPaths);
  let ok = true;
  for (const r of results) {
    log(`[verify] ${r.status.padEnd(13)} ${r.path}`);
    if (r.status !== 'OK') ok = false;
  }
  if (args.only === 'ytdlp' || args.only === 'all') {
    try {
      const cross = await verifyAgainstSums(join(RUNTIME_DIR, 'SHA2-256SUMS'), 'yt-dlp.exe', await sha256File(join(RUNTIME_DIR, 'yt-dlp.exe')));
      log(`[verify] OFFICIAL_SUMS ${cross.ok ? 'OK' : 'FAIL'} expected=${cross.expected} actual=${cross.actual}`);
      if (!cross.ok) ok = false;
    } catch (error) {
      log(`[verify] OFFICIAL_SUMS FAIL ${error.message}`);
      ok = false;
    }
  }
  if (!ok) { fail('verification failed'); return false; }
  log(`[fetch-runtime] verify-only OK (${results.length} items)`);
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.verifyOnly) {
    await verify(args);
    return;
  }
  if (args.finalize) {
    await finalizeManifest();
    return;
  }
  const keys = args.only === 'all' ? ['ytdlp', 'node', 'ffmpeg'] : [args.only];
  for (const key of keys) {
    if (!['ytdlp', 'node', 'ffmpeg'].includes(key)) throw new Error(`unknown --only key: ${key}`);
  }
  await mkdir(CACHE_DIR, { recursive: true });
  for (const key of keys) {
    if (key === 'ytdlp') await fetchYtDlp();
    if (key === 'node') await fetchNode();
    if (key === 'ffmpeg') {
      const result = await fetchFfmpeg();
      await writeFile(join(CACHE_DIR, 'ffmpeg-release-tag.txt'), result.releaseTag, 'utf8');
      await writeFile(join(CACHE_DIR, 'ffmpeg-source-url.txt'), result.sourceUrl, 'utf8');
    }
  }
}

main().catch((error) => {
  fail(error.stack || error.message);
});
