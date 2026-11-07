/**
 * M1's ONLY L2 case — `--case probe-local` (A-INF-07 / A-INF-03).
 *
 * U3 = SUPPORTED (DECISIONS.md §U3), so this uses the REAL YtDlpEngine.probe()
 * against the bundled yt-dlp.exe + a 127.0.0.1 HTTP fixture server.
 * Zero external network; server is always closed in `finally`.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { YtDlpEngine } from '@ytvdlt/engine-ytdlp';
import { Logger, ErrorMapper } from '@ytvdlt/core';
import { createInMemoryPorts } from '../../unit/helpers/in-memory-ports.js';
import { startMockServer } from '../helpers/mock-server.js';
import { createRealProcessPort } from '../helpers/real-process-port.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RUNTIME = join(ROOT, 'resources', 'runtime', 'win-x64');
const YTDLP = join(RUNTIME, 'yt-dlp.exe');
const NODE_EXE = join(RUNTIME, 'node.exe');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'media', 'fixture.mp4');

describe('probe-local · L2 offline end-to-end (A-INF-07)', () => {
  it('probe-local: real probe() over 127.0.0.1 returns a complete MediaInfo', async () => {
    expect(existsSync(YTDLP), 'bundled yt-dlp.exe must exist').toBe(true);
    expect(existsSync(NODE_EXE), 'bundled node.exe must exist').toBe(true);
    expect(existsSync(FIXTURE), 'U3 fixture.mp4 must exist').toBe(true);

    const server = await startMockServer(FIXTURE);
    try {
      const { ports, state } = createInMemoryPorts();
      // Point the injected runtime dir at the real bundled runtime without
      // clobbering the rest of the in-memory env (vars / configDir / logsDir).
      state.env.runtimeDir = RUNTIME;
      const real = createRealProcessPort();
      const effectivePorts = { ...ports, process: real.process };
      const logger = new Logger({ ports: effectivePorts, appVersion: '0.1.0' });
      const mapper = new ErrorMapper({ clock: effectivePorts.clock });
      const engine = new YtDlpEngine({
        ports: effectivePorts,
        logger,
        mapper,
        enginePath: YTDLP,
        appVersion: '0.1.0',
      });

      const info = await engine.probe(server.url, { jsRuntimePath: NODE_EXE });

      // Complete MediaInfo DTO (A-4.1-04 contract).
      expect(typeof info.id).toBe('string');
      expect(info.id.length).toBeGreaterThan(0);
      expect(typeof info.title).toBe('string');
      expect(info.title.length).toBeGreaterThan(0);
      expect(typeof info.webpage_url).toBe('string');
      expect(info.webpage_url).toBe(server.url);
      expect(typeof info.extractor_key).toBe('string');
      expect(typeof info.ext).toBe('string');
      expect(Array.isArray(info.formats)).toBe(true);
      expect(info.formats.length).toBeGreaterThan(0);
      expect(info.formats[0]?.format_id.length).toBeGreaterThan(0);
      expect(Array.isArray(info.subtitles)).toBe(false); // object map
      expect(typeof info.subtitles).toBe('object');
      expect(info._type).toBe('video');

      // spawn 铁律: absolute path + argv[] + shell:false + windowsHide:true.
      expect(real.calls).toHaveLength(1);
      const call = real.calls[0];
      expect(call?.file).toBe(YTDLP);
      expect(call?.opts.shell).toBe(false);
      expect(call?.opts.windowsHide).toBe(true);
      expect(call?.argv).toContain('-J');
      expect(call?.argv).toContain('--dump-single-json');
      expect(call?.argv).toContain('--no-js-runtimes');
      expect(call?.argv).toContain('--js-runtimes');
      expect(call?.argv).toContain(`node:${NODE_EXE}`);
      expect(call?.argv).toContain('--');
      expect(call?.argv[call.argv.length - 1]).toBe(server.url);
      expect(call?.opts.env?.PATH).toContain('ffmpeg');

      // argv was logged through the redacting Logger (no raw secrets).
      expect(state.logLines.some((line) => line.includes('"event":"argv"'))).toBe(true);
    } finally {
      await server.close();
    }
  }, 90_000);
});
