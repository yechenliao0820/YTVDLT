/**
 * runtime-manifest.json read/write/verify helpers.
 * Paths in the manifest are POSIX-style paths RELATIVE to the runtime root
 * (no `win-x64` layer), so dev and packaged layouts share one manifest.
 */
import { readFile, writeFile, rename, rm, mkdir, stat } from 'node:fs/promises';
import { dirname, join, posix, sep } from 'node:path';
import { sha256File } from './hash.mjs';

export const MANIFEST_FILENAME = 'runtime-manifest.json';
export const MANIFEST_SCHEMA_VERSION = 1;

/** Convert an absolute path inside runtimeDir to a POSIX relative manifest path. */
export function toManifestPath(runtimeDir, absolutePath) {
  return posix.normalize(
    absolutePath.slice(runtimeDir.length).replace(/\\/g, '/').replace(/^\/+/, ''),
  );
}

/** Join a runtime root with a manifest-relative path using platform separators. */
export function fromManifestPath(runtimeDir, manifestPath) {
  return join(runtimeDir, ...manifestPath.split('/'));
}

/** Create an empty, schema-conformant manifest. */
export function emptyManifest(toolVersions) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    platform: 'win-x64',
    generatedAt: new Date().toISOString(),
    toolVersions,
    items: [],
  };
}

/** Read and structurally validate a manifest JSON file. */
export async function readManifest(manifestPath) {
  const text = await readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(text);
  if (parsed?.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(`manifest schemaVersion mismatch: ${parsed?.schemaVersion}`);
  }
  if (parsed?.platform !== 'win-x64') {
    throw new Error(`manifest platform mismatch: ${parsed?.platform}`);
  }
  if (!Array.isArray(parsed?.items)) {
    throw new Error('manifest.items must be an array');
  }
  for (const item of parsed.items) {
    for (const field of ['path', 'sha256', 'sizeBytes', 'version', 'sourceUrl', 'releaseTag', 'license', 'required', 'kind', 'group']) {
      if (item[field] === undefined || item[field] === null) {
        throw new Error(`manifest item missing field ${field}: ${item.path}`);
      }
    }
    if (!/^[0-9a-f]{64}$/.test(item.sha256)) {
      throw new Error(`manifest item sha256 not lowercase hex: ${item.path}`);
    }
    if (item.path.includes('\\') || item.path.includes(':')) {
      throw new Error(`manifest item path must be POSIX relative: ${item.path}`);
    }
  }
  return parsed;
}

/** Atomically write the manifest (tmp + rename). */
export async function writeManifest(manifestPath, manifest) {
  await mkdir(dirname(manifestPath), { recursive: true });
  const tmp = `${manifestPath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rm(manifestPath, { force: true });
  await rename(tmp, manifestPath);
}

/** Upsert an item by path, keeping the array deterministically sorted. */
export function upsertItem(manifest, item) {
  const next = manifest.items.filter((existing) => existing.path !== item.path);
  next.push(item);
  next.sort((a, b) => a.path.localeCompare(b.path));
  manifest.items = next;
  manifest.generatedAt = new Date().toISOString();
  return manifest;
}

/** Verify every manifest item against files on disk (sha256 + size). */
export async function verifyManifestOnDisk(runtimeDir, manifest, onlyPaths = null) {
  const results = [];
  for (const item of manifest.items) {
    if (onlyPaths !== null && !onlyPaths.includes(item.path)) continue;
    const absolute = fromManifestPath(runtimeDir, item.path);
    const record = {
      path: item.path,
      sha256Expected: item.sha256,
      sha256Actual: null,
      sizeBytesExpected: item.sizeBytes,
      sizeBytesActual: null,
      status: 'MISSING',
    };
    try {
      const info = await stat(absolute);
      record.sizeBytesActual = info.size;
      record.sha256Actual = await sha256File(absolute);
      if (record.sha256Actual !== item.sha256) record.status = 'HASH_MISMATCH';
      else if (record.sizeBytesActual !== item.sizeBytes) record.status = 'HASH_MISMATCH';
      else record.status = 'OK';
    } catch {
      record.status = 'MISSING';
    }
    results.push(record);
  }
  return results;
}

/** Build one manifest item from a file on disk. */
export async function buildItem(runtimeDir, absolutePath, metadata) {
  const info = await stat(absolutePath);
  return {
    path: absolutePath.slice(runtimeDir.length).replace(/\\/g, '/').replace(/^\/+/, ''),
    sha256: await sha256File(absolutePath),
    sizeBytes: info.size,
    version: metadata.version,
    sourceUrl: metadata.sourceUrl,
    releaseTag: metadata.releaseTag,
    license: metadata.license,
    required: metadata.required,
    kind: metadata.kind,
    group: metadata.group,
  };
}

/** Native absolute path separator helper (kept for readability). */
export function nativeJoin(...parts) {
  return parts.join(sep);
}
