/**
 * HTTPS download helper (Node built-ins only: fetch + fs streams).
 * Downloads to `<dest>.part`, verifies size, then atomically renames.
 * Includes bounded retries and an abortable timeout.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

const USER_AGENT = 'YTVDLT-M1-runtime-fetcher/1.0';

/** Return the byte size of a file, or null when it does not exist. */
export async function fileSize(path) {
  try {
    const info = await stat(path);
    return info.size;
  } catch {
    return null;
  }
}

/**
 * Download `url` into `destPath`.
 * @param {string} url
 * @param {string} destPath
 * @param {{retries?:number, timeoutMs?:number, expectedSize?:number|null,
 *          label?:string, onProgress?: (bytes:number)=>void}} options
 */
export async function downloadFile(url, destPath, options = {}) {
  const {
    retries = 3,
    timeoutMs = 180_000,
    expectedSize = null,
    label = url,
    onProgress = () => {},
  } = options;

  const existing = await fileSize(destPath);
  if (existing !== null && (expectedSize === null || existing === expectedSize)) {
    return { destPath, bytes: existing, skipped: true, url };
  }

  await mkdir(dirname(destPath), { recursive: true });
  const partPath = `${destPath}.part`;
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const declared = Number(response.headers.get('content-length') ?? 0);
      let received = 0;
      const webStream = Readable.fromWeb(response.body);
      webStream.on('data', (chunk) => {
        received += chunk.length;
        onProgress(received);
      });
      await pipeline(webStream, createWriteStream(partPath));

      const actual = await fileSize(partPath);
      if (actual === null || actual === 0) {
        throw new Error('downloaded file is empty');
      }
      if (expectedSize !== null && actual !== expectedSize) {
        throw new Error(`size mismatch: expected ${expectedSize}, got ${actual}`);
      }
      if (declared > 0 && declared !== actual) {
        throw new Error(`short read: content-length ${declared}, got ${actual}`);
      }

      await rm(destPath, { force: true });
      await rename(partPath, destPath);
      return { destPath, bytes: actual, skipped: false, url };
    } catch (error) {
      lastError = error;
      await rm(partPath, { force: true });
      // eslint-disable-next-line no-console
      console.error(`[download] ${label}: attempt ${attempt}/${retries} failed: ${error.message}`);
      if (attempt < retries) await delay(1000 * attempt);
    }
  }
  throw new Error(`[download] ${label}: all ${retries} attempts failed: ${lastError?.message}`);
}
