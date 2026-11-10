/**
 * TS local HTTP mock server for L2 offline cases.
 * Binds 127.0.0.1 only, supports HEAD + Range, optional throttling, closes in `finally`.
 * Contract mirrors scripts/lib/mock-server.mjs (F065 / M2-F033).
 *
 * Stage 4 (append-only): `routes` lets a case serve an HTML page and the
 * subtitle files it points at, so "real yt-dlp discovers subtitles through a
 * <track> element and writes them" can be tested without any network. The
 * default single-file behaviour (`/fixture.mp4`) is unchanged.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync, statSync } from 'node:fs';

/** One extra endpoint, matched by pathname (absolute-form URIs are normalised). */
export interface MockRoute {
  /** Path portion only, e.g. `/page.html`. */
  path: string;
  /** Serve this file. Range requests are supported. */
  filePath?: string;
  /** Or serve this literal body (no Range support — subtitles do not need it). */
  body?: string;
  contentType: string;
}

export interface MockServerOptions {
  /** Throttle body to this many bytes/second (0/undefined = unthrottled). */
  rateBytesPerSec?: number;
  /** Extra endpoints on top of the default `/fixture.mp4`. */
  routes?: readonly MockRoute[];
}

export interface MockServer {
  url: string;
  port: number;
  /** Absolute URL for a route path (helper for `<track src>` / page URLs). */
  urlFor(path: string): string;
  close(): Promise<void>;
}

export async function startMockServer(
  filePath: string,
  options: MockServerOptions = {},
): Promise<MockServer> {
  const size = statSync(filePath).size;
  const rate = options.rateBytesPerSec ?? 0;
  const routes = new Map<string, MockRoute>();
  for (const route of options.routes ?? []) routes.set(route.path, route);

  const serveFile = (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, path: string, contentType: string, throttle: number): void => {
    const total = statSync(path).size;
    const headers = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };
    if (request.method === 'HEAD') {
      response.writeHead(200, { ...headers, 'Content-Length': String(total) });
      response.end();
      return;
    }
    let start = 0;
    let end = total - 1;
    let partial = false;
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!match) {
        response.writeHead(416, { 'Content-Range': `bytes */${total}` });
        response.end();
        return;
      }
      start = match[1] === '' ? 0 : Number(match[1]);
      end = match[2] === '' ? total - 1 : Number(match[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
        response.writeHead(416, { 'Content-Range': `bytes */${total}` });
        response.end();
        return;
      }
      end = Math.min(end, total - 1);
      partial = true;
    }

    const length = end - start + 1;
    response.writeHead(partial ? 206 : 200, {
      ...headers,
      ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
      'Content-Length': String(length),
    });

    if (!throttle || throttle <= 0) {
      response.end(readFileSync(path).subarray(start, end + 1));
      return;
    }

    const buffer = readFileSync(path).subarray(start, end + 1);
    const chunkSize = Math.max(1, Math.floor(throttle / 10));
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
  };

  const server: Server = createServer((request, response) => {
    // yt-dlp sends absolute-form URIs (`GET http://127.0.0.1:p/x`), so the
    // pathname must be parsed, not compared raw.
    let pathname = '/';
    try {
      pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      pathname = '/';
    }

    const route = routes.get(pathname);
    if (route !== undefined) {
      if (route.filePath !== undefined) {
        serveFile(request, response, route.filePath, route.contentType, 0);
        return;
      }
      const body = Buffer.from(route.body ?? '', 'utf8');
      if (request.method === 'HEAD') {
        response.writeHead(200, { 'Content-Type': route.contentType, 'Content-Length': String(body.length) });
        response.end();
        return;
      }
      response.writeHead(200, { 'Content-Type': route.contentType, 'Content-Length': String(body.length) });
      response.end(body);
      return;
    }

    if (pathname === '/fixture.mp4') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' });
        response.end();
        return;
      }
      serveFile(request, response, filePath, 'video/mp4', rate);
      return;
    }
    response.writeHead(404);
    response.end('not found');
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
    urlFor: (path: string): string => `http://127.0.0.1:${port}${path.startsWith('/') ? path : `/${path}`}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections?.();
    }),
  };
}
