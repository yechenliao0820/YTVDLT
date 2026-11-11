/**
 * TASK-03 evidence — what the RUNNING engine can parse, and how a URL pre-check
 * classifies real inputs. Offline: only local processes and 127.0.0.1.
 *
 *   node --import tsx scripts/task03-site-evidence.mjs
 *
 * Writes `reports/task03/site-support.json`. Never connects to a network.
 */
import { join } from 'node:path';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { YtDlpEngine } from '../packages/engine-ytdlp/src/index.ts';
import { Logger, ErrorMapper } from '../packages/core/src/index.ts';
import { createNodePorts } from '../apps/desktop/src/main/adapters/node-ports.ts';

const ROOT = process.cwd();
const RUNTIME = join(ROOT, 'resources', 'runtime', 'win-x64');
const dir = mkdtempSync(join(tmpdir(), 'ytvdlt-t3-'));
const ports = createNodePorts({
  packaged: false, resourcesPath: RUNTIME, runtimeDir: RUNTIME,
  appDataDir: join(dir, 'd'), configDir: join(dir, 'd/c'), logsDir: join(dir, 'd/l'),
  appVersion: '0.2.9',
});
const engine = new YtDlpEngine({
  ports, logger: new Logger({ ports, appVersion: '0.2.9' }),
  mapper: new ErrorMapper({ clock: ports.clock }),
  enginePath: join(RUNTIME, 'yt-dlp.exe'),
  jsRuntimePath: join(RUNTIME, 'node.exe'),
  appVersion: '0.2.9',
});
const JS = join(RUNTIME, 'node.exe');

const report = { generatedAt: new Date().toISOString(), networkUsed: false, catalog: null, precheck: [] };

// ---- A · the catalog ----
const started = Date.now();
const catalogResult = await engine.listExtractors();
report.catalog = { ok: catalogResult.ok, ms: Date.now() - started };
if (catalogResult.ok) {
  const c = catalogResult.catalog;
  Object.assign(report.catalog, {
    engineVersion: c.engineVersion, enginePath: c.enginePath,
    totalEntries: c.extractors.length, siteCount: c.siteCount,
    subExtractorCount: c.subExtractorCount, brokenCount: c.brokenCount, empty: c.empty,
    generic: c.extractors.find((e) => e.isGeneric) ?? null,
    firstFive: c.extractors.slice(0, 5).map((e) => e.name),
    lastFive: c.extractors.slice(-5).map((e) => e.name),
    sampleSub: c.extractors.find((e) => e.parent !== '') ?? null,
    sampleBroken: c.extractors.find((e) => e.broken) ?? null,
  });
  process.stdout.write(`${c.engineVersion}: ${c.extractors.length} entries, ${c.siteCount} sites, `
    + `${c.subExtractorCount} sub-extractors, ${c.brokenCount} engine-flagged broken\n`);
} else {
  report.catalog.reason = catalogResult.reason;
  report.catalog.detail = catalogResult.detail;
  process.stdout.write(`catalog FAILED: ${catalogResult.reason}\n`);
}

// ---- B · the pre-check, against real inputs ----
// A local page with a real media file: the engine's GenericIE should resolve it.
const media = new Uint8Array(4096);
const page = '<html><head><title>Local</title></head><body>'
  + '<video src="/clip.mp4" title="Clip"></video></body></html>';
const server = createServer((request, response) => {
  const path = String(request.url ?? '').split('?')[0];
  if (path === '/page.html') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(page);
    return;
  }
  if (path === '/text.html') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<html><body><p>no media here at all</p></body></html>');
    return;
  }
  if (path === '/clip.mp4') {
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(media.byteLength) });
    response.end(Buffer.from(media));
    return;
  }
  response.writeHead(404);
  response.end('nope');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const CASES = [
  ['local page with a media file', `${base}/page.html`, 'SUPPORTED or INDETERMINATE'],
  ['local page with NO media', `${base}/text.html`, 'NO_MEDIA or INDETERMINATE'],
  ['nonexistent local path', `${base}/missing.html`, 'INDETERMINATE'],
  ['loopback with an unroutable port', 'http://127.0.0.1:1/x.mp4', 'INDETERMINATE'],
  ['unsupported scheme is rejected by the whitelist', 'ftp://example.org/x.mp4', 'UNSUPPORTED'],
  ['local file path is rejected by the whitelist', 'C:/Users/x/video.mp4', 'UNSUPPORTED'],
  ['plain sentence is not a URL', 'this is not a url', 'UNSUPPORTED'],
];

for (const [label, url, expectation] of CASES) {
  const t = Date.now();
  const result = await engine.checkUrlSupport(url, { jsRuntimePath: JS, timeoutMs: 20_000 });
  report.precheck.push({
    label, url, expectation, ms: Date.now() - t,
    state: result.state, extractor: result.extractor, reason: result.reason,
  });
  process.stdout.write(`  ${label.padEnd(44)} -> ${result.state.padEnd(14)} `
    + `extractor=${result.extractor || '-'} (${Date.now() - t}ms)\n`);
}

await new Promise((resolve) => server.close(resolve));
mkdirSync(join(ROOT, 'reports', 'task03'), { recursive: true });
const outPath = join(ROOT, 'reports', 'task03', 'site-support.json');
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`\nwrote ${outPath}\n`);
