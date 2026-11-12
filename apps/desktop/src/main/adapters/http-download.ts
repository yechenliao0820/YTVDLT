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
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { allowAnyHttpUrl, fetchFollowingRedirects, type RedirectPolicy } from './http-policy.js';

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
  /**
   * D-137 (F-05): applied to the initial URL AND to every redirect hop.
   * Production passes `isTrustedReleaseHost`; omitted callers keep the bounded
   * chain with the permissive default (used by offline cancellation tests).
   */
  readonly hostPolicy?: (url: string) => boolean;
  readonly signal?: AbortSignal;
  readonly trashPartial?: (path: string) => Promise<void>;
}

export class PartialCleanupError extends Error {}

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
  const partPath = `${request.targetPath}.${randomUUID()}.part`;

  await mkdir(dirname(request.targetPath), { recursive: true });
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  request.signal?.addEventListener('abort', abort, { once: true });
  if (request.signal?.aborted) controller.abort();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdleTimer = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
  };

  armIdleTimer();
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let created = false;
  try {
    // D-137: the release JSON is untrusted input. `redirect: 'follow'` used to
    // let a checked github.com URL bounce to an arbitrary host (or an http
    // downgrade) without this layer ever seeing the final address. Every hop is
    // now re-checked, the chain is capped, and the same AbortSignal covers it.
    const redirectPolicy: RedirectPolicy = request.hostPolicy === undefined
      ? allowAnyHttpUrl
      : { allow: request.hostPolicy };
    const response = await fetchFollowingRedirects(request.url, {
      signal: controller.signal,
      headers: { 'user-agent': 'YTVDLT-updater' },
    }, redirectPolicy);
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

    controller.signal.throwIfAborted();
    handle = await open(partPath, 'wx');
    created = true;
    const hash = createHash('sha256');
    const reader = response.body.getReader();
    let downloadedBytes = 0;
    for (;;) {
      const chunk = await reader.read();
      controller.signal.throwIfAborted();
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
    controller.signal.throwIfAborted();

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
    if (created) {
      try {
        if (request.trashPartial === undefined) throw new Error('回收站不可用');
        await request.trashPartial(partPath);
      } catch (cleanupError) {
        throw new PartialCleanupError(`临时文件清理失败，文件保留在 ${partPath}：${String(cleanupError)}`);
      }
    }
    throw error;
  } finally {
    if (idleTimer !== null) clearTimeout(idleTimer);
    request.signal?.removeEventListener('abort', abort);
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
