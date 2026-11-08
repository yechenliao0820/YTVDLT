/**
 * App-update decision logic (0.2.1, D-93). Offline: every rule here runs without
 * a network, an Electron binary or a real release.
 */
import { describe, expect, it } from 'vitest';
import {
  compareVersions, flattenReleaseNotes, isNewerVersion, normalizeVersion,
  parseGitHubRelease, parseVersionSegments, selectInstallerAsset, shouldPromptForUpdate,
} from '@ytvdlt/core';
import type { AppReleaseAsset, AppUpdateState } from '@ytvdlt/shared';

describe('app update · version comparison', () => {
  it('parses a tag with or without the v prefix', () => {
    expect(parseVersionSegments('v0.2.1')).toEqual([0, 2, 1]);
    expect(parseVersionSegments('0.1.10-beta')).toEqual([0, 1, 10]);
    expect(parseVersionSegments('release-1.37.0')).toEqual([]);
  });

  it('treats a missing segment as zero', () => {
    expect(compareVersions('0.2', '0.2.0')).toBe(0);
    expect(compareVersions('0.2', '0.1.9')).toBe(1);
  });

  it('ranks the historical 0.1.10 below 0.2.0 and above 0.1.9', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('0.1.10', '0.2.0')).toBe(-1);
  });

  it('lets the decimal-carry rule decide the next release', () => {
    expect(isNewerVersion('0.2.1', '0.1.10')).toBe(true);
    expect(isNewerVersion('0.2.0', '0.2.1')).toBe(false);
  });

  it('never reports an unparsable version as newer', () => {
    expect(compareVersions('', '0.2.1')).toBe(-1);
    expect(compareVersions('0.2.1', '')).toBe(1);
    expect(isNewerVersion('nightly', '0.2.1')).toBe(false);
  });

  it('normalises without dropping trailing zeros', () => {
    expect(normalizeVersion('v0.2.0')).toBe('0.2.0');
    expect(normalizeVersion('  1.0 ')).toBe('1.0');
  });
});

describe('app update · release payload', () => {
  const release = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    tag_name: 'v0.2.1',
    name: 'YTVDLT 0.2.1',
    body: '## 修复\n\n- **进度**显示总大小',
    html_url: 'https://github.com/yechenliao0820/YTVDLT/releases/tag/v0.2.1',
    published_at: '2026-11-08T10:00:00Z',
    draft: false,
    prerelease: false,
    assets: [
      {
        name: 'YTVDLT-Setup-0.2.1.exe',
        browser_download_url: 'https://github.com/yechenliao0820/YTVDLT/releases/download/v0.2.1/YTVDLT-Setup-0.2.1.exe',
        size: 226_356_479,
        digest: `sha256:${'a'.repeat(64)}`,
      },
      {
        name: 'YTVDLT-Setup-0.2.1.exe.blockmap',
        browser_download_url: 'https://github.com/x/y.blockmap',
        size: 1024,
      },
      {
        name: 'YTVDLT-Portable-0.2.1.exe',
        browser_download_url: 'https://github.com/x/portable.exe',
        size: 230_000_000,
      },
    ],
    ...over,
  });

  it('reads tag, notes, page and installer', () => {
    const parsed = parseGitHubRelease(release());
    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBe('0.2.1');
    expect(parsed?.tag).toBe('v0.2.1');
    expect(parsed?.installer?.name).toBe('YTVDLT-Setup-0.2.1.exe');
    expect(parsed?.installer?.sha256).toBe('a'.repeat(64));
    expect(parsed?.notes).toContain('进度显示总大小');
  });

  it('rejects drafts and prereleases', () => {
    expect(parseGitHubRelease(release({ draft: true }))).toBeNull();
    expect(parseGitHubRelease(release({ prerelease: true }))).toBeNull();
  });

  it('survives a malformed payload instead of throwing', () => {
    expect(parseGitHubRelease(null)).toBeNull();
    expect(parseGitHubRelease('nope')).toBeNull();
    expect(parseGitHubRelease({ tag_name: '' })).toBeNull();
  });

  it('prefers a Setup exe over a portable build and never picks a blockmap', () => {
    const assets: AppReleaseAsset[] = [
      { name: 'app-portable.exe', url: 'https://github.com/a', sizeBytes: 10, sha256: null },
      { name: 'app.blockmap', url: 'https://github.com/b', sizeBytes: 1, sha256: null },
      { name: 'app-Setup-x64.exe', url: 'https://github.com/c', sizeBytes: 5, sha256: null },
    ];
    expect(selectInstallerAsset(assets)?.name).toBe('app-Setup-x64.exe');
    expect(selectInstallerAsset([{ name: 'x.blockmap', url: 'https://github.com/d', sizeBytes: 1, sha256: null }])).toBeNull();
  });
});

describe('app update · release notes', () => {
  it('flattens markdown into readable text', () => {
    const text = flattenReleaseNotes('## 标题\n\n- **粗体** 与 `代码`\n- [链接](https://example.org)\n\n![截图](https://example.org/a.png)');
    expect(text).toContain('标题');
    expect(text).toContain('粗体 与 代码');
    expect(text).toContain('链接');
    expect(text).not.toContain('**');
    expect(text).not.toContain('https://example.org/a.png');
  });

  it('caps a runaway changelog', () => {
    const text = flattenReleaseNotes('x'.repeat(500), 100);
    expect(text.length).toBeLessThanOrEqual(102);
    expect(text.endsWith('…')).toBe(true);
  });

  it('returns an empty string for an empty body', () => {
    expect(flattenReleaseNotes('')).toBe('');
  });
});

describe('app update · prompt gate', () => {
  const base: AppUpdateState = {
    phase: 'available',
    currentVersion: '0.1.10',
    latest: {
      version: '0.2.1', tag: 'v0.2.1', name: 'YTVDLT 0.2.1', notes: '',
      pageUrl: 'https://github.com/yechenliao0820/YTVDLT/releases/tag/v0.2.1',
      publishedAt: '', installer: null,
    },
    message: '',
    downloadedBytes: 0,
    totalBytes: null,
    skippedVersion: null,
    lastCheckedAt: null,
    canAutoInstall: false,
  };

  it('shows once per available version', () => {
    expect(shouldPromptForUpdate(base, { dismissedThisSession: false })).toBe(true);
  });

  it('stays silent for a skipped version', () => {
    expect(shouldPromptForUpdate({ ...base, skippedVersion: '0.2.1' }, { dismissedThisSession: false })).toBe(false);
    expect(shouldPromptForUpdate({ ...base, skippedVersion: '0.2.0' }, { dismissedThisSession: false })).toBe(true);
  });

  it('stays silent after the user closes it for this run', () => {
    expect(shouldPromptForUpdate(base, { dismissedThisSession: true })).toBe(false);
  });

  it('stays silent when nothing is available', () => {
    expect(shouldPromptForUpdate({ ...base, phase: 'idle' }, { dismissedThisSession: false })).toBe(false);
    expect(shouldPromptForUpdate({ ...base, latest: null }, { dismissedThisSession: false })).toBe(false);
    expect(shouldPromptForUpdate(null, { dismissedThisSession: false })).toBe(false);
  });
});
