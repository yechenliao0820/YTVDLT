/**
 * M5 · desktop platform policy (A-4.6-07).
 *
 * Two verifiable claims:
 *   1. auto-start is optional, per-user and never needs elevation;
 *   2. the shipped UI carries no Android-only residue — checked against the REAL
 *      `packages/ui/src` tree, not a fixture.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ANDROID_ONLY_MARKERS, concurrencyLabel, findAndroidResidue, planAutostart,
  type SourceFile,
} from '@ytvdlt/core';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function readSources(dir: string, acc: SourceFile[] = []): SourceFile[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) readSources(full, acc);
    else if (/\.(js|html|css)$/.test(entry)) {
      acc.push({ file: full.slice(ROOT.length).replace(/\\/g, '/'), text: readFileSync(full, 'utf8') });
    }
  }
  return acc;
}

describe('platform policy · auto-start', () => {
  it('uses the per-user Run key and never asks for admin', () => {
    const plan = planAutostart({ enabled: true, platform: 'win32', exePath: 'C:/Program Files/YTVDLT/YTVDLT.exe' });
    expect(plan.supported).toBe(true);
    expect(plan.action).toBe('set');
    expect(plan.registryPath).toBe('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
    expect(plan.registryPath).not.toContain('HKLM');
    expect(plan.command).toBe('"C:/Program Files/YTVDLT/YTVDLT.exe" --autostart');
    expect(plan.requiresAdmin).toBe(false);
  });

  it('removes the value when the option is off, and is a no-op elsewhere', () => {
    expect(planAutostart({ enabled: false, platform: 'win32', exePath: 'C:/x.exe' }).action).toBe('remove');
    const mac = planAutostart({ enabled: true, platform: 'darwin', exePath: '/Applications/YTVDLT.app' });
    expect(mac.supported).toBe(false);
    expect(mac.action).toBe('none');
    expect(mac.registryPath).toBeNull();
    expect(planAutostart({ enabled: true, platform: 'win32', exePath: 'C:/x.exe', valueName: 'Custom' }).valueName).toBe('Custom');
  });

  it('formats the concurrency counter defensively', () => {
    expect(concurrencyLabel(2, 3)).toBe('2/3');
    expect(concurrencyLabel(-1, 0)).toBe('0/1');
    expect(concurrencyLabel(Number.NaN, 5)).toBe('0/5');
  });
});

describe('platform policy · no Android residue in the shipped UI', () => {
  it('detects every marker on a synthetic file', () => {
    const findings = findAndroidResidue([{
      file: 'fake.js',
      text: [
        'const x = HapticFeedback.perform();',
        'Toast.makeText(ctx, "hi", 0);',
        'android.permission.WRITE_EXTERNAL_STORAGE',
      ].join('\n'),
    }]);
    expect(findings.map((finding) => finding.marker)).toEqual([
      'HapticFeedback', 'Toast.makeText', 'android.permission.',
    ]);
    expect(findings[0]?.line).toBe(1);
    expect(ANDROID_ONLY_MARKERS.length).toBeGreaterThanOrEqual(8);
  });

  it('finds zero residue in packages/ui/src', () => {
    const sources = readSources(join(ROOT, 'packages', 'ui', 'src'));
    expect(sources.length).toBeGreaterThan(10);
    expect(findAndroidResidue(sources)).toEqual([]);
  });
});
