/**
 * L2 `subtitle-artifact-local` (stage 4 acceptance).
 *
 * REAL bundled yt-dlp against a 127.0.0.1 page that advertises subtitles through
 * `<track>` elements — the generic extractor turns them into
 * `requested_subtitles`, exactly like a real site does.
 *
 * What this proves (and a unit test cannot):
 *  1. `after_move:%(filepath)q` records ONLY the media file, so the subtitle
 *     list has to come from the second `--print-to-file` template;
 *  2. the subtitle paths yt-dlp reports still point at the temp dir, and the
 *     engine's basename→media-dir reconciliation finds the real files;
 *  3. subtitle artifacts land in `record.artifacts` but the MEDIA stays primary;
 *  4. `subtitleFiles` carries language / format / source, and the history's
 *     `videoPath` is the video, not a `.srt`.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { startMockServer, type MockRoute } from '../helpers/mock-server.js';
import {
  createL2Context, buildRequest, makeRecord, waitFor, filesIn, FIXTURE,
} from '../helpers/l2-harness.js';
import { classifyArtifact, primaryMediaArtifact } from '@ytvdlt/core';
import type { DownloadRequest } from '@ytvdlt/shared';

const VTT = (label: string): string => `WEBVTT

00:00:00.000 --> 00:00:01.500
${label} first line

00:00:01.500 --> 00:00:03.000
${label} second line
`;

const page = (): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>subtitle fixture</title></head><body>
<video controls width="320">
  <source src="/fixture.mp4" type="video/mp4">
  <track kind="subtitles" src="/sub.en.vtt" srclang="en" label="English" default>
  <track kind="subtitles" src="/sub.zh.vtt" srclang="zh-Hans" label="Chinese (Simplified)">
</video>
</body></html>`;

function subtitleRequest(taskId: string, url: string, dirs: { outDir: string; tempDir: string }): DownloadRequest {
  const base = buildRequest(taskId, url, dirs);
  return {
    ...base,
    subtitle: {
      enabled: true,
      languages: 'en,zh-Hans',
      autoCaptions: false,
      skipTranslated: true,
      convertTo: 'srt',
      embed: false,
      keepSubtitleFile: false,
    },
  };
}

describe('subtitle-artifact-local · real yt-dlp subtitle artifacts', () => {
  it('records subtitle files as artifacts, keeps the media primary, and links languages', async () => {
    const ctx = await createL2Context('subtitle-artifact-local');
    const routes: MockRoute[] = [
      { path: '/page.html', body: page(), contentType: 'text/html; charset=utf-8' },
      { path: '/sub.en.vtt', body: VTT('English'), contentType: 'text/vtt' },
      { path: '/sub.zh.vtt', body: VTT('Chinese'), contentType: 'text/vtt' },
    ];
    const server = await startMockServer(FIXTURE, { routes });
    try {
      const req = subtitleRequest('subtitle-artifact-1', server.urlFor('/page.html'), ctx);
      await ctx.queue.enqueue(makeRecord(req));
      await waitFor(() => ctx.queue.get(req.taskId)?.state === 'Completed', 120_000, 'Completed');

      const record = ctx.queue.get(req.taskId);
      expect(record?.state).toBe('Completed');
      const artifacts = record?.artifacts ?? [];

      // ① media + two converted subtitles, classified correctly.
      const kinds = artifacts.map((path) => classifyArtifact(path));
      expect(kinds.filter((kind) => kind === 'video')).toHaveLength(1);
      expect(kinds.filter((kind) => kind === 'subtitle')).toHaveLength(2);
      const media = primaryMediaArtifact(artifacts);
      expect(media).not.toBeNull();
      expect(media).toMatch(/\.mp4$/);
      // The media is index 0 even though subtitles were written by the same run.
      expect(artifacts[0]).toBe(media);

      // ② the links carry the language tags yt-dlp put in the file names.
      const links = record?.subtitleFiles ?? [];
      expect(links).toHaveLength(2);
      expect(links.map((link) => link.language).sort()).toEqual(['en', 'zh-Hans']);
      for (const link of links) {
        expect(link.ext).toBe('srt');
        expect(link.source).toBe('manual');
        expect(link.mediaPath).toBe(media);
        const content = await readFile(link.path, 'utf8');
        expect(content).toContain('-->');
        expect(content.toLowerCase()).not.toContain('<html');
      }

      // ③ requested-vs-produced reconciliation.
      expect(record?.subtitleOutcome).toBe('ok');

      // ④ history: videoPath is the video; subtitles are attachments.
      const entries = await ctx.history.query({});
      expect(entries).toHaveLength(1);
      expect(entries[0]?.videoPath).toBe(media);
      expect(entries[0]?.subtitlePaths.sort()).toEqual(links.map((link) => link.path).sort());

      // ⑤ no leftover manifest/temp files next to the media.
      const leftovers = await filesIn(ctx.outDir, (name) => name.includes('ytvdlt-'));
      expect(leftovers).toEqual([]);
    } finally {
      await server.close();
      await ctx.cleanup();
    }
  }, 180_000);

  it('completes the video and reports "missing" when the requested language yields no file', async () => {
    const ctx = await createL2Context('subtitle-artifact-absent');
    const routes: MockRoute[] = [
      { path: '/page.html', body: page(), contentType: 'text/html; charset=utf-8' },
      { path: '/sub.en.vtt', body: VTT('English'), contentType: 'text/vtt' },
      { path: '/sub.zh.vtt', body: VTT('Chinese'), contentType: 'text/vtt' },
    ];
    const server = await startMockServer(FIXTURE, { routes });
    try {
      const base = buildRequest('subtitle-artifact-3', server.urlFor('/page.html'), ctx);
      const req: DownloadRequest = {
        ...base,
        // A language the page does not advertise: measured on the bundled
        // yt-dlp 2026.10.26, this exits 0, downloads the media, prints `[]` for
        // `requested_subtitles`, and warns nothing — the exact "green card, no
        // subtitles" case that `subtitleOutcome` exists for.
        subtitle: { ...base.subtitle, enabled: true, languages: 'de', convertTo: 'srt' },
      };
      await ctx.queue.enqueue(makeRecord(req));
      await waitFor(() => ctx.queue.get(req.taskId)?.state === 'Completed', 120_000, 'Completed');

      const record = ctx.queue.get(req.taskId);
      expect(record?.state).toBe('Completed');
      expect(record?.artifacts).toHaveLength(1);
      expect(record?.artifacts[0]).toMatch(/\.mp4$/);
      expect(record?.subtitleFiles).toEqual([]);
      // Requested, produced nothing → the UI must show "subtitle missing",
      // NOT a failed download (D-127).
      expect(record?.subtitleOutcome).toBe('missing');
      const entries = await ctx.history.query({});
      expect(entries[0]?.subtitlePaths).toEqual([]);
    } finally {
      await server.close();
      await ctx.cleanup();
    }
  }, 180_000);
});
