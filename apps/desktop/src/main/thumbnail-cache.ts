/**
 * ThumbnailCache — cover images for the queue cards (0.2.1, D-96).
 *
 * Why cache instead of pointing `<img>` at the remote URL:
 *   1. the project rule is that no media URL leaves the main process (a signed
 *      link must never end up in the DOM or a screenshot);
 *   2. a card must keep its cover after the source rotates its CDN URL;
 *   3. offline / privacy mode then simply has no cover, which is the same
 *      fallback as "this extractor has none".
 *
 * Failures are never fatal: every method resolves to `null`, the card keeps its
 * letter badge, and a task with a broken URL costs exactly one request.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import type { HttpPort } from '@ytvdlt/shared';
import type { ILogger } from '@ytvdlt/core';

export interface ThumbnailCacheOptions {
  /** `<dataDir>/thumbs` — created on demand. */
  readonly dir: string;
  readonly http?: HttpPort;
  readonly logger: ILogger;
  /** Anything bigger is not a thumbnail; defaults to 6 MiB. */
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

export interface ThumbnailCache {
  /** Cached absolute path for a task, or null when nothing usable exists. */
  pathOf(taskId: string): string | null;
  /** Best-effort fetch + cache; resolves to the path when it worked. */
  ensure(taskId: string, url: string | null | undefined): Promise<string | null>;
  /** Drop the mapping when the task record is gone (the file stays on disk). */
  forget(taskId: string): void;
}

const DEFAULT_MAX_BYTES = 6 * 1024 * 1024;

interface ImageSignature {
  readonly ext: string;
  readonly test: (bytes: Uint8Array) => boolean;
}

const SIGNATURES: readonly ImageSignature[] = [
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  {
    ext: 'webp',
    test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
  { ext: 'gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
];

function signatureOf(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  for (const signature of SIGNATURES) {
    if (signature.test(bytes)) return signature.ext;
  }
  return null;
}

export function createThumbnailCache(options: ThumbnailCacheOptions): ThumbnailCache {
  const { dir, http, logger } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? 10_000;
  /** taskId -> absolute file path. */
  const byTask = new Map<string, string>();
  /** taskId -> in-flight attempt, so a 1.2 s poll cannot fan out requests. */
  const inFlight = new Map<string, Promise<string | null>>();

  async function fetchAndStore(taskId: string, url: string): Promise<string | null> {
    if (http === undefined) return null;
    if (!/^https:\/\//i.test(url)) return null;
    try {
      const bytes = await http.getBytes(url, { timeoutMs });
      if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return null;
      const ext = signatureOf(bytes);
      if (ext === null) return null;

      const name = `${createHash('sha1').update(url).digest('hex')}.${ext}`;
      const target = `${dir}/${name}`;
      const existing = await stat(target).catch(() => null);
      if (existing === null || !existing.isFile() || existing.size !== bytes.byteLength) {
        await mkdir(dir, { recursive: true });
        const temp = `${target}.part`;
        await writeFile(temp, bytes);
        await rename(temp, target);
      }
      // Confirm the bytes really are on disk before advertising the path.
      const stored = await readFile(target).catch(() => null);
      if (stored === null) return null;
      byTask.set(taskId, target);
      return target;
    } catch (error) {
      await logger.warn('thumbnail', 'cover fetch failed; card keeps its letter badge', {
        taskId,
        detail: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  return {
    pathOf(taskId: string): string | null {
      return byTask.get(taskId) ?? null;
    },

    ensure(taskId: string, url: string | null | undefined): Promise<string | null> {
      const cached = byTask.get(taskId);
      if (cached !== undefined) return Promise.resolve(cached);
      if (typeof url !== 'string' || url.trim() === '') return Promise.resolve(null);
      const pending = inFlight.get(taskId);
      if (pending !== undefined) return pending;
      const attempt = fetchAndStore(taskId, url.trim()).finally(() => {
        inFlight.delete(taskId);
      });
      inFlight.set(taskId, attempt);
      return attempt;
    },

    forget(taskId: string): void {
      byTask.delete(taskId);
      inFlight.delete(taskId);
    },
  };
}
