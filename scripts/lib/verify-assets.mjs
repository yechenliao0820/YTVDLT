#!/usr/bin/env node
/** B3 asset verification helper: extraResources config + full manifest hash check. */
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const RUNTIME = join(ROOT, 'resources', 'runtime', 'win-x64');

const builder = await readFile(join(ROOT, 'apps', 'desktop', 'electron-builder.yml'), 'utf8');
// Strip YAML comments: the config documents the exclusion in prose, which must
// not be mistaken for an actual `files:` entry.
const configOnly = builder.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n');
const extraResourcesOk =
  /from:\s*resources\/runtime\/win-x64/.test(configOnly) &&
  /to:\s*runtime/.test(configOnly) &&
  /filter:/.test(configOnly) &&
  /\*\*\/\*/.test(configOnly);
const filesSection = configOnly.split('extraResources')[0] ?? '';
const filesExcludesRuntime = !/resources\/runtime/.test(filesSection);

const manifest = JSON.parse(await readFile(join(RUNTIME, 'runtime-manifest.json'), 'utf8'));
const results = [];
for (const item of manifest.items) {
  const file = join(RUNTIME, ...item.path.split('/'));
  const info = await stat(file);
  const hash = createHash('sha256').update(await readFile(file)).digest('hex');
  results.push({
    path: item.path,
    shaOk: hash === item.sha256,
    sizeOk: info.size === item.sizeBytes,
    posixRelative: !item.path.includes('\\') && !item.path.includes(':') && !item.path.includes('win-x64'),
  });
}
const bad = results.filter((r) => !r.shaOk || !r.sizeOk || !r.posixRelative);
const ytdlpItem = manifest.items.find((i) => i.path === 'yt-dlp.exe');
const sums = await readFile(join(RUNTIME, 'SHA2-256SUMS'), 'utf8');
const official = /^([0-9a-f]{64})\s+\*?yt-dlp\.exe$/m.exec(sums)?.[1] ?? null;
const officialOk = official !== null && official === ytdlpItem?.sha256;

const out = {
  extraResourcesOk,
  filesExcludesRuntime,
  manifestItems: manifest.items.length,
  hashAndSizeOk: results.length - bad.length,
  bad,
  posixRelativePaths: results.every((r) => r.posixRelative),
  officialSumsCrossCheck: officialOk,
  ytDlpSha256: ytdlpItem?.sha256 ?? null,
};
console.log(JSON.stringify(out, null, 2));
if (!extraResourcesOk || !filesExcludesRuntime || bad.length > 0 || !officialOk) process.exitCode = 1;
