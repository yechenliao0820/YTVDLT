import type { MediaInfo, PlaylistInfo } from './media.js';
import type { ProbeOptions, DownloadRequest } from './request.js';
import type { EngineEvent, CancelHandle, UpdateResult } from './events.js';

/**
 * HANDOFF §6.4 — engine replaceability is a HARD requirement.
 * `YtDlpEngine` and `FakeEngine` both implement exactly these 5 methods.
 * Signatures are frozen in M1; later milestones only append, never change.
 */
export interface DownloadEngine {
  version(): Promise<string>;
  probe(url: string, opts: ProbeOptions): Promise<MediaInfo>;
  probePlaylist(url: string, opts: ProbeOptions): Promise<PlaylistInfo>;
  download(req: DownloadRequest, onEvent: (e: EngineEvent) => void): CancelHandle;
  selfUpdate(channel: 'stable' | 'nightly'): Promise<UpdateResult>;
}
