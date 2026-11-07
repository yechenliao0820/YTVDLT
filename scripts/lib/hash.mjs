/**
 * SHA-256 helpers and official SHA2-256SUMS parsing.
 * Build-time script utilities only (Node I/O is allowed here, never in packages/core).
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';

/** Compute SHA-256 of a file without loading it entirely into memory. */
export async function sha256File(filePath) {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/** Compute SHA-256 of an in-memory byte buffer. */
export function sha256Bytes(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Parse an official `SHA2-256SUMS` file into a Map of filename -> lowercase hex.
 * Lines look like: "<64hex>  yt-dlp.exe" or "<64hex> *yt-dlp.exe".
 */
export function parseSHA2Sums(text) {
  const map = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (match) {
      map.set(match[2].trim().replace(/^\.\//, ''), match[1].toLowerCase());
    }
  }
  return map;
}

/** Read and parse SHA2-256SUMS from disk. */
export async function readSHA2Sums(filePath) {
  return parseSHA2Sums(await readFile(filePath, 'utf8'));
}

/**
 * Cross-check a downloaded file against the official checksum file.
 * @returns {{ ok: boolean, expected: string | null, actual: string, filename: string }}
 */
export async function verifyAgainstSums(sumsPath, filename, actualSha256) {
  const sums = await readSHA2Sums(sumsPath);
  const expected = sums.get(filename) ?? null;
  return {
    ok: expected !== null && expected === actualSha256.toLowerCase(),
    expected,
    actual: actualSha256.toLowerCase(),
    filename,
  };
}
