/**
 * FakeEngine — implements the SAME `DownloadEngine` interface (A-INF-10).
 * Replays recorded fixtures for offline L1/L2 tests; used for L2 replay only
 * when U3 = NOT_SUPPORTED. U3 was SUPPORTED, so M1 L2 uses the real engine —
 * this class still exists to prove engine replaceability.
 *
 * Pure TS: all file reads go through the injected FileSystemPort.
 */
import type {
  DownloadEngine, MediaInfo, PlaylistInfo, DownloadRequest, EngineEvent,
  CancelHandle, UpdateResult, ProbeOptions, CorePorts,
} from '@ytvdlt/shared';
import { toMediaInfo, toPlaylistInfo } from './json-mapper.js';
import { parseProgressChunk } from './progress-parser.js';

export interface FakeEngineDeps {
  ports: CorePorts;
  /** Absolute directory holding recorded fixtures. */
  fixturesDir: string;
  infoFile?: string;
  playlistFile?: string;
  progressLogFile?: string;
  recordedVersion?: string;
  /** Artifact returned by download(); defaults to `<fixturesDir>/media/fixture.mp4`. */
  artifactPath?: string;
}

/** Join a fixture directory (with or without trailing separator) to a file name. */
function fixturePath(dir: string, file: string): string {
  return `${dir.replace(/[\\/]+$/, '')}/${file}`;
}

export class FakeEngine implements DownloadEngine {
  private readonly deps: FakeEngineDeps;

  constructor(deps: FakeEngineDeps) {
    this.deps = deps;
  }

  async version(): Promise<string> {
    return this.deps.recordedVersion ?? 'fake-engine-1.0.0';
  }

  async probe(_url: string, _opts: ProbeOptions): Promise<MediaInfo> {
    const file = fixturePath(this.deps.fixturesDir, this.deps.infoFile ?? 'info-video.json');
    const raw: unknown = JSON.parse(await this.deps.ports.fs.readText(file));
    return toMediaInfo(raw);
  }

  async probePlaylist(_url: string, _opts: ProbeOptions): Promise<PlaylistInfo> {
    const file = fixturePath(this.deps.fixturesDir, this.deps.playlistFile ?? 'info-flat-playlist.json');
    const raw: unknown = JSON.parse(await this.deps.ports.fs.readText(file));
    return toPlaylistInfo(raw);
  }

  /**
   * Replay recorded progress events line-by-line, then emit `completed` with a
   * fixture artifact. Async so the caller observes progress before completion.
   */
  download(_req: DownloadRequest, onEvent: (e: EngineEvent) => void): CancelHandle {
    const taskId = _req.taskId;
    let canceled = false;
    const artifactPath = this.deps.artifactPath
      ?? `${this.deps.fixturesDir.replace(/[\\/]+$/, '')}/media/fixture.mp4`;
    void (async () => {
      onEvent({ type: 'stage', taskId, stage: 'downloading' });
      let text = '';
      try {
        text = await this.deps.ports.fs.readText(
          `${this.deps.fixturesDir.replace(/[\\/]+$/, '')}/${this.deps.progressLogFile ?? 'progress-basic.log'}`,
        );
      } catch { text = ''; }
      if (canceled) { onEvent({ type: 'canceled', taskId }); return; }
      const { events } = parseProgressChunk(`${text}\n`, taskId);
      for (const event of events) {
        if (canceled) { onEvent({ type: 'canceled', taskId }); return; }
        onEvent({
          type: 'progress', taskId,
          percent: event.percent, downloadedBytes: event.downloadedBytes,
          totalBytes: event.totalBytes, speedBps: event.speedBps,
          etaSec: event.etaSec, rawLine: event.rawLine,
        });
      }
      if (canceled) { onEvent({ type: 'canceled', taskId }); return; }
      let sizeBytes: number | null = null;
      try { sizeBytes = (await this.deps.ports.fs.stat(artifactPath)).sizeBytes; } catch { sizeBytes = null; }
      onEvent({
        type: 'completed', taskId,
        artifacts: [{ taskId, path: artifactPath, kind: 'video', sizeBytes }],
      });
    })();
    return {
      cancel: async () => { canceled = true; return true; },
      pid: null,
    };
  }

  async selfUpdate(channel: 'stable' | 'nightly'): Promise<UpdateResult> {
    return {
      fromVersion: await this.version(),
      toVersion: await this.version(),
      channel,
      changed: false,
    };
  }
}
