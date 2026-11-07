/**
 * Local-only static HTTP fixture server for L2 tests.
 * Node built-in `http` only, binds 127.0.0.1 exclusively, supports Range.
 *
 * M2: `rateBytesPerSec` throttles the body so a cancel test can reliably
 * interrupt a download mid-flight — the 308 KB fixture completes instantly on
 * loopback without throttling, making cancellation untestable.
 * Never leaves a background process: callers MUST close() in a finally block.
 */
import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';

const CONTENT_TYPES = {
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.vtt': 'text/vtt',
  '.srt': 'application/x-subrip',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.json': 'application/json',
};

/**
 * Start the server.
 * @param {{files: Record<string,string>, host?:string, port?:number,
 *          rateBytesPerSec?:number}} options
 *   `files` maps a URL path (e.g. '/fixture.mp4') to an absolute file path.
 *   `rateBytesPerSec` throttles response bodies (0/undefined = unthrottled).
 * @returns {Promise<{url:string, port:number, close:()=>Promise<void>}>}
 */
export async function startMockServer(options) {
  const files = options.files ?? {};
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const rateBytesPerSec = options.rateBytesPerSec ?? 0;

  const server = createServer((request, response) => {
    const rawPath = (request.url ?? '/').split('?')[0];
    const urlPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    const filePath = files[urlPath];
    if (!filePath) {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('not found');
      return;
    }

    let size;
    try {
      size = statSync(filePath).size;
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('missing file');
      return;
    }
    const contentType = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const baseHeaders = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };

    if (request.method === 'HEAD') {
      response.writeHead(200, { ...baseHeaders, 'Content-Length': String(size) });
      response.end();
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }

    // Resolve the byte range (single-range only, which is all yt-dlp needs).
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
      ...baseHeaders,
      ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      'Content-Length': String(length),
    });

    if (!rateBytesPerSec || rateBytesPerSec <= 0) {
      createReadStream(filePath, { start, end }).pipe(response);
      return;
    }

    // Throttled streaming: emit ~10 chunks/second at the configured rate.
    const buffer = readFileSync(filePath).subarray(start, end + 1);
    const chunkSize = Math.max(1, Math.floor(rateBytesPerSec / 10));
    let offset = 0;
    let closed = false;
    response.on('close', () => { closed = true; });
    const pump = () => {
      if (closed) return;
      if (offset >= buffer.length) { response.end(); return; }
      const slice = buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length));
      offset += slice.length;
      response.write(slice);
      setTimeout(pump, 100);
    };
    pump();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  const url = `http://${host}:${actualPort}`;

  const close = () => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    // Force-release any keep-alive sockets so the process can exit promptly.
    server.closeAllConnections?.();
  });

  return { url, port: actualPort, close, nameOf: (p) => basename(p) };
}
