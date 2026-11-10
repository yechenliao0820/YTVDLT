/**
 * Subtitle preview · L2 offline end-to-end (stage 2).
 *
 * The unit tests feed hand-built `MediaInfo` objects; this one feeds the REAL
 * engine output from the bundled `yt-dlp.exe` against a 127.0.0.1 fixture, then
 * runs it through the real service. Two things are proven that a fixture cannot
 * prove:
 *
 *   1. `collectSubtitleTracks()` tolerates whatever the engine actually returns
 *      (including the empty bucket maps of a plain MP4);
 *   2. the DTO handed to the renderer carries none of the localhost media URL
 *      that the real probe result contains.
 *
 * Zero external network — the fixture server binds 127.0.0.1 and is closed in
 * `finally`.
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
import { createSubtitlePreviewService } from '../../../apps/desktop/src/main/subtitle-preview-service.js';
import { findUrlLeaks } from '../../unit/helpers/subtitle-media.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RUNTIME = join(ROOT, 'resources', 'runtime', 'win-x64');
const YTDLP = join(RUNTIME, 'yt-dlp.exe');
const NODE_EXE = join(RUNTIME, 'node.exe');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'media', 'fixture.mp4');

describe('subtitle-preview-local · real probe → real service', () => {
  it('previews a real local video, reports "no subtitles" and leaks no URL', async () => {
    expect(existsSync(YTDLP), 'bundled yt-dlp.exe must exist').toBe(true);
    expect(existsSync(NODE_EXE), 'bundled node.exe must exist').toBe(true);
    expect(existsSync(FIXTURE), 'U3 fixture.mp4 must exist').toBe(true);

    const server = await startMockServer(FIXTURE);
    try {
      const { ports, state } = createInMemoryPorts();
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

      let seq = 0;
      const service = createSubtitlePreviewService({
        probe: (url: string) => engine.probe(url, { jsRuntimePath: NODE_EXE, noPlaylist: true }),
        clock: effectivePorts.clock,
        newId: () => `real-${String(++seq).padStart(4, '0')}`,
      });

      const result = await service.preview(server.url);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // A bare MP4 has no subtitle buckets; the empty state is a success.
      expect(result.preview.empty).toBe(true);
      expect(result.preview.tracks).toEqual([]);
      expect(result.preview.media.title.length).toBeGreaterThan(0);
      // The real probe result also carries `formats[].url = http://127.0.0.1/…`;
      // none of it may reach the renderer.
      expect(findUrlLeaks(result.preview)).toEqual([]);
      expect(JSON.stringify(result.preview)).not.toContain(server.url);
      expect(JSON.stringify(result.preview)).not.toContain('127.0.0.1');

      // The ticket still carries the full MediaInfo for the enqueue path.
      const consumed = service.consume(result.preview.previewId, server.url);
      expect(consumed.ok).toBe(true);
      if (!consumed.ok) return;
      expect(consumed.consumption.media.webpage_url).toBe(server.url);

      service.dispose();
    } finally {
      await server.close();
    }
  }, 60_000);
});
