/**
 * M4 assembly seam · buildDownloadRequest (pure five-domain assembly).
 */
import { describe, it, expect } from 'vitest';
import { buildDownloadRequest } from '@ytvdlt/core';

describe('buildDownloadRequest · defaults', () => {
  it('produces a complete, valid request without any defaults', () => {
    const request = buildDownloadRequest({ taskId: 't1', url: 'https://example.org/v', kind: 'video' });
    expect(request.taskId).toBe('t1');
    expect(request.url).toBe('https://example.org/v');
    expect(request.format.quality).toBe('best');
    expect(request.format.extractAudio).toBe(false);
    expect(request.subtitle.enabled).toBe(false);
    expect(request.subtitle.convertTo).toBe('none');
    expect(request.paths.outputTemplate).toContain('%(title)');
    expect(request.paths.privateMode).toBe(false);
    expect(request.network.proxy).toBeNull();
    expect(request.advanced.playlistItems).toBeNull();
    expect(request.advanced.customCommand).toBeNull();
  });

  it('applies per-domain overrides from config', () => {
    const request = buildDownloadRequest({
      taskId: 't2',
      url: 'https://example.org/v',
      kind: 'audio',
      defaults: {
        format: { quality: '1080p', videoCodecPref: 'h264', extractAudio: true, audioFormat: 'mp3' },
        subtitle: { enabled: true, languages: 'zh.*,en.*', embed: true },
        paths: { videoDir: 'D:/V', outputTemplate: '%(id)s.%(ext)s' },
        network: { proxy: 'http://127.0.0.1:7890', concurrentFragments: 4 },
        advanced: { sponsorblockRemove: 'sponsor', splitChapters: true },
      },
    });
    expect(request.format).toMatchObject({ quality: '1080p', videoCodecPref: 'h264', extractAudio: true, audioFormat: 'mp3' });
    expect(request.subtitle).toMatchObject({ enabled: true, languages: 'zh.*,en.*', embed: true });
    expect(request.paths).toMatchObject({ videoDir: 'D:/V', outputTemplate: '%(id)s.%(ext)s' });
    expect(request.network).toMatchObject({ proxy: 'http://127.0.0.1:7890', concurrentFragments: 4 });
    expect(request.advanced).toMatchObject({ sponsorblockRemove: 'sponsor', splitChapters: true });
  });

  it('lets the per-task playlist item win over the template default', () => {
    const request = buildDownloadRequest({
      taskId: 't3', url: 'https://example.org/p', kind: 'video',
      defaults: { advanced: { playlistItems: '9' } },
      playlistItems: '3',
    });
    expect(request.advanced.playlistItems).toBe('3');
  });

  it('privateMode can be forced per task', () => {
    expect(buildDownloadRequest({
      taskId: 't4', url: 'https://example.org/v', kind: 'video', privateMode: true,
    }).paths.privateMode).toBe(true);
    expect(buildDownloadRequest({
      taskId: 't5', url: 'https://example.org/v', kind: 'video',
      defaults: { paths: { privateMode: true } },
    }).paths.privateMode).toBe(true);
  });

  it('returns a fresh object each call (no shared nested state)', () => {
    const a = buildDownloadRequest({ taskId: 'a', url: 'https://example.org/v', kind: 'video' });
    const b = buildDownloadRequest({ taskId: 'b', url: 'https://example.org/v', kind: 'video' });
    expect(a.format).not.toBe(b.format);
    expect(a.advanced).not.toBe(b.advanced);
    (a.format as { quality: string }).quality = 'lowest';
    expect(b.format.quality).toBe('best');
  });
});
