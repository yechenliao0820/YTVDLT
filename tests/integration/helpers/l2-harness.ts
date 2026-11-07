/**
 * L2 harness: REAL ports (createNodePorts) inside a per-case scratch directory,
 * so the offline tests exercise the production adapters (spawnStreaming,
 * taskkill, real fs) without touching the user's profile.
 */
import { mkdir, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodePorts } from '../../../apps/desktop/src/main/adapters/node-ports.js';
import { ArtifactVerifier, HistoryStore, TaskQueue } from '@ytvdlt/core';
import { YtDlpEngine } from '@ytvdlt/engine-ytdlp';
import { Logger, ErrorMapper } from '@ytvdlt/core';
import type {
  CorePorts, DownloadRequest, ExpectedArtifactManifest, TaskRecord,
} from '@ytvdlt/shared';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const RUNTIME = join(ROOT, 'resources', 'runtime', 'win-x64');
export const YTDLP = join(RUNTIME, 'yt-dlp.exe');
export const NODE_EXE = join(RUNTIME, 'node.exe');
export const FIXTURE = join(ROOT, 'tests', 'fixtures', 'media', 'fixture.mp4');
export const FIXTURE_VTT = join(ROOT, 'tests', 'fixtures', 'media', 'fixture.vtt');
export const FIXTURE_JPG = join(ROOT, 'tests', 'fixtures', 'media', 'fixture.jpg');
export const FIXTURE_MANIFEST = join(ROOT, 'tests', 'fixtures', 'manifest.json');

export interface L2Context {
  dir: string;
  outDir: string;
  tempDir: string;
  ports: CorePorts;
  engine: YtDlpEngine;
  queue: TaskQueue;
  history: HistoryStore;
  verifier: ArtifactVerifier;
  events: Array<{ type: string; percent?: number | null; speedBps?: number | null; etaSec?: number | null }>;
  cleanup: () => Promise<void>;
}

export function buildRequest(
  taskId: string,
  url: string,
  dirs: { outDir: string; tempDir: string },
  overrides: Partial<DownloadRequest> = {},
): DownloadRequest {
  return {
    taskId,
    url,
    format: {
      quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null,
      extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto',
      audioFormat: null, audioMultistreams: false,
    },
    subtitle: {
      enabled: false, languages: 'en.*', autoCaptions: false, skipTranslated: true,
      convertTo: 'none', embed: false, keepSubtitleFile: false,
    },
    paths: {
      videoDir: dirs.outDir, audioDir: dirs.outDir, commandDir: dirs.outDir,
      privateMode: false, subdirByExtractor: false, subdirByPlaylist: false,
      outputTemplate: '%(title)s.%(ext)s', tempDir: dirs.tempDir,
    },
    network: {
      rateLimit: null, proxy: null, cookiesFile: null, userAgent: null,
      ipv4Only: false, concurrentFragments: null, aria2cPath: null,
    },
    advanced: {
      sponsorblockRemove: null, downloadSections: null, splitChapters: false,
      customTitle: null, debug: false, downloadArchive: null, customCommand: null,
    },
    ...overrides,
  };
}

export function makeRecord(req: DownloadRequest, privateMode = false): TaskRecord {
  return {
    id: req.taskId, url: req.url, kind: 'video', state: 'Idle',
    createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
    mediaInfo: null, request: req, artifacts: [], lastPercent: null,
    error: null, privateMode, postprocessed: false,
  };
}

export async function createL2Context(caseName: string, expectedManifest: ExpectedArtifactManifest | null = null): Promise<L2Context> {
  // Unique per run: avoids stale `.part` files and bulk-delete churn. These
  // scratch dirs live under reports/ (gitignored) and are never reused.
  const dir = join(ROOT, 'reports', 'l2-tmp', `${caseName}-${process.pid}-${Date.now()}`);
  const outDir = join(dir, 'out');
  const tempDir = join(dir, 'temp');
  for (const path of [dir, outDir, tempDir, join(dir, 'config'), join(dir, 'logs')]) {
    await mkdir(path, { recursive: true });
  }

  const ports = createNodePorts({
    packaged: false,
    resourcesPath: join(ROOT, 'resources'),
    runtimeDir: RUNTIME,
    appDataDir: dir,
    configDir: join(dir, 'config'),
    logsDir: join(dir, 'logs'),
    appVersion: '0.1.0',
  });

  const logger = new Logger({ ports, appVersion: '0.1.0' });
  const mapper = new ErrorMapper({ clock: ports.clock });
  const engine = new YtDlpEngine({
    ports, logger, mapper, enginePath: YTDLP, jsRuntimePath: NODE_EXE, appVersion: '0.1.0',
  });
  const history = new HistoryStore({ ports });
  const verifier = new ArtifactVerifier({ ports });
  const queue = new TaskQueue({
    ports, engine, verifier, history, jsRuntimePath: NODE_EXE,
    expectedManifestFor: () => expectedManifest,
  });

  const events: L2Context['events'] = [];
  queue.onEvent((event) => {
    if (event.type === 'progress') {
      events.push({ type: 'progress', percent: event.percent, speedBps: event.speedBps, etaSec: event.etaSec });
    } else {
      events.push({ type: event.type });
    }
  });

  return {
    dir, outDir, tempDir, ports, engine, queue, history, verifier, events,
    // Best-effort: some environments gate bulk deletes; leftover scratch is harmless.
    cleanup: async () => { try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

/** Poll a predicate until it is true or the timeout elapses. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 60_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`[l2] timed out waiting for ${label}`);
}

/** Files in a directory matching a predicate. */
export async function filesIn(dir: string, predicate: (name: string) => boolean = () => true): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names.filter(predicate).map((name) => join(dir, name));
  } catch {
    return [];
  }
}
