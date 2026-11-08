/**
 * Streaming download for release assets (0.2.1, D-93).
 *
 * `HttpPort.getBytes` is the wrong tool here: the installer is ~220 MB, and
 * buffering that in the main process — twice, once for the write and once for
 * the hash — is how an update becomes an OOM. This adapter streams to
 * `<target>.part`, reports bytes as they land, and only renames on success, so
 * an interrupted download never leaves a half file that looks installable.
 *
 * This file is allowed to use `node:*`: it is a main-process adapter, not Core.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface DownloadProgress {
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
}

export interface DownloadRequest {
  readonly url: string;
  readonly targetPath: string;
  /** From the release asset; used when the CDN omits `content-length`. */
  readonly expectedBytes?: number | null;
  readonly onProgress?: (progress: DownloadProgress) => void;
  /** Abort when no byte arrived for this long. Defaults to 45 s. */
  readonly idleTimeoutMs?: number;
  /** Hard ceiling; a "installer" bigger than this is a bug or an attack. */
  readonly maxBytes?: number;
}

export interface DownloadResult {
  readonly path: string;
  readonly bytes: number;
  /** SHA-256 of the bytes on disk, lowercase hex. */
  readonly sha256: string;
}

const DEFAULT_IDLE_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

export async function downloadToFile(request: DownloadRequest): Promise<DownloadResult> {
  const maxBytes = request.maxBytes ?? DEFAULT_MAX_BYTES;
  const idleTimeoutMs = request.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const partPath = `${request.targetPath}.part`;

  await mkdir(dirname(request.targetPath), { recursive: true });
  // A leftover `.part` from a crashed attempt must not be resumed blindly.
  await unlink(partPath).catch(() => undefined);

  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdleTimer = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
  };

  armIdleTimer();
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const response = await fetch(request.url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'YTVDLT-updater' },
    });
    if (!response.ok || response.body === null) {
      throw new Error(`HTTP ${response.status} for ${request.url}`);
    }

    const headerLength = Number(response.headers.get('content-length') ?? '');
    const totalBytes = Number.isFinite(headerLength) && headerLength > 0
      ? headerLength
      : (request.expectedBytes ?? null);
    if (totalBytes !== null && totalBytes > maxBytes) {
      throw new Error(`asset too large: ${totalBytes} bytes`);
    }

    handle = await open(partPath, 'w');
    const hash = createHash('sha256');
    const reader = response.body.getReader();
    let downloadedBytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (value === undefined) continue;
      downloadedBytes += value.byteLength;
      if (downloadedBytes > maxBytes) throw new Error(`asset too large: >${maxBytes} bytes`);
      armIdleTimer();
      hash.update(value);
      await handle.write(value);
      request.onProgress?.({ downloadedBytes, totalBytes });
    }
    await handle.sync();
    await handle.close();
    handle = null;

    if (downloadedBytes === 0) throw new Error('empty download');
    if (totalBytes !== null && downloadedBytes !== totalBytes) {
      throw new Error(`size mismatch: expected ${totalBytes}, got ${downloadedBytes}`);
    }

    await rename(partPath, request.targetPath);
    return {
      path: request.targetPath,
      bytes: downloadedBytes,
      sha256: hash.digest('hex').toLowerCase(),
    };
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => undefined);
    await unlink(partPath).catch(() => undefined);
    throw error;
  } finally {
    if (idleTimer !== null) clearTimeout(idleTimer);
  }
}

/** `%1` / `%2` — a Windows executable starts with `MZ`. */
export async function looksLikeExecutable(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(2);
    const read = await handle.read(buffer, 0, 2, 0);
    return read.bytesRead === 2 && buffer[0] === 0x4d && buffer[1] === 0x5a;
  } finally {
    await handle.close();
  }
}

/** Size on disk, or -1 when missing. */
export async function fileSize(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : -1;
  } catch {
    return -1;
  }
}
