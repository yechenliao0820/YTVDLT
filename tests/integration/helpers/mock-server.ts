/**
 * TS local HTTP mock server for L2 offline cases.
 * Binds 127.0.0.1 only, supports HEAD + Range, optional throttling, closes in `finally`.
 * Contract mirrors scripts/lib/mock-server.mjs (F065 / M2-F033).
 */
import { createServer, type Server } from 'node:http';
import { readFileSync, statSync } from 'node:fs';

export interface MockServerOptions {
  /** Throttle body to this many bytes/second (0/undefined = unthrottled). */
  rateBytesPerSec?: number;
}

export interface MockServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startMockServer(
  filePath: string,
  options: MockServerOptions = {},
): Promise<MockServer> {
  const size = statSync(filePath).size;
  const rate = options.rateBytesPerSec ?? 0;

  const server: Server = createServer((request, response) => {
    const headers = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };
    if (request.method === 'HEAD') {
      response.writeHead(200, { ...headers, 'Content-Length': String(size) });
      response.end();
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }

    let start = 0;
    let end = size - 1;
    let partial = false;
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!match) {
        response.writeHead(416, { 'Content-Range': `bytes */${size}` });
        response.end();
        return;
      }
      start = match[1] === '' ? 0 : Number(match[1]);
      end = match[2] === '' ? size - 1 : Number(match[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        response.writeHead(416, { 'Content-Range': `bytes */${size}` });
        response.end();
        return;
      }
      end = Math.min(end, size - 1);
      partial = true;
    }

    const length = end - start + 1;
    response.writeHead(partial ? 206 : 200, {
      ...headers,
      ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      'Content-Length': String(length),
    });

    if (!rate || rate <= 0) {
      response.end(readFileSync(filePath).subarray(start, end + 1));
      return;
    }

    const buffer = readFileSync(filePath).subarray(start, end + 1);
    const chunkSize = Math.max(1, Math.floor(rate / 10));
    let offset = 0;
    let closed = false;
    response.on('close', () => { closed = true; });
    const pump = (): void => {
      if (closed) return;
      if (offset >= buffer.length) { response.end(); return; }
      const slice = buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length));
      offset += slice.length;
      response.write(slice);
      setTimeout(pump, 100);
    };
    pump();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/fixture.mp4`,
    port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections?.();
    }),
  };
}
