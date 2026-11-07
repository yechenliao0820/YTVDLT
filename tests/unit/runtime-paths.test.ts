/**
 * M5-4 · dev vs packaged path resolution (§6.2-⑤).
 *
 * The packaged build must never read through `process.cwd()`: after packaging
 * that value is whatever directory the launcher happened to be in, so a
 * fixture path assembled from it silently points at a stranger's folder.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { resolveFixtureDir, resolveRuntimeDir } from '../../apps/desktop/src/main/runtime-paths.js';

const dev = { isPackaged: () => false, resourcesPath: () => 'C:/unused/resources' };
const shipped = { isPackaged: () => true, resourcesPath: () => 'C:/Program Files/YTVDLT/resources' };

describe('runtime paths · dev', () => {
  it('reads the win-x64 runtime from the repository', () => {
    expect(resolveRuntimeDir(dev, 'C:/work/ytvdlt')).toBe(join('C:/work/ytvdlt', 'resources', 'runtime', 'win-x64'));
  });

  it('reads fixtures from tests/fixtures next to the cwd', () => {
    expect(resolveFixtureDir(dev, 'C:/work/ytvdlt')).toBe(join('C:/work/ytvdlt', 'tests', 'fixtures'));
  });
});

describe('runtime paths · packaged', () => {
  it('reads runtime from process.resourcesPath', () => {
    expect(resolveRuntimeDir(shipped)).toBe(join('C:/Program Files/YTVDLT/resources', 'runtime'));
  });

  it('reads fixtures from resourcesPath and ignores the cwd entirely', () => {
    const packagedPath = resolveFixtureDir(shipped, 'C:/somewhere/else');
    expect(packagedPath).toBe(join('C:/Program Files/YTVDLT/resources', 'fixtures'));
    expect(packagedPath).not.toContain('somewhere');
    expect(packagedPath).not.toContain('tests');
  });
});
