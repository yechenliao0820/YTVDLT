import type { MediaInfo, PlaylistInfo } from './media.js';
import type { ProbeOptions, DownloadRequest } from './request.js';
import type { EngineEvent, CancelHandle, UpdateResult } from './events.js';
import type { SpawnAbortSignal } from './ports.js';

/**
 * Cooperative cancellation for a one-shot metadata call.
 *
 * Appended (never a change to `ProbeOptions`, which is frozen by D-50): the
 * optional third argument lets the queue abort a probe that is still in
 * flight. Implementations that ignore it stay type-compatible — the parameter
 * is optional and the caller must treat an aborted probe as "no result".
 */
export interface ProbeControl {
  readonly signal?: SpawnAbortSignal;
}

/**
 * HANDOFF §6.4 — engine replaceability is a HARD requirement.
 * `YtDlpEngine` and `FakeEngine` both implement exactly these 5 methods.
 * Signatures are frozen in M1; later milestones only append, never change.
 */
export interface DownloadEngine {
  version(): Promise<string>;
  probe(url: string, opts: ProbeOptions, control?: ProbeControl): Promise<MediaInfo>;
  probePlaylist(url: string, opts: ProbeOptions, control?: ProbeControl): Promise<PlaylistInfo>;
  download(req: DownloadRequest, onEvent: (e: EngineEvent) => void): CancelHandle;
  selfUpdate(channel: 'stable' | 'nightly'): Promise<UpdateResult>;
}
