#!/usr/bin/env node
/**
 * Generate `apps/desktop/build/icon.ico` (M5-4).
 *
 * The repository shipped no icon at all: electron-builder would fall back to the
 * stock Electron icon and the tray constructor would throw (bootstrap degrades
 * silently, so nobody would notice). This script draws the icon from scratch —
 * no binary asset is checked in, no design tool is needed, and the output is
 * reproducible.
 *
 * Format: multi-size 32-bit BMP-in-ICO (16/32/48/256). BMP entries are chosen
 * over PNG entries because NSIS — which builds the installer — is happiest with
 * uncompressed DIBs.
 *
 *   node scripts/make-icon.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'apps', 'desktop', 'build');

const TEAL = [15, 107, 100];
const WHITE = [246, 250, 252];
const SIZES = [16, 32, 48, 256];

/** Signed distance to a rounded rectangle centred in a `size` box. */
function insideRoundedRect(x, y, size, inset, radius) {
  const min = inset;
  const max = size - inset;
  const cx = Math.min(Math.max(x, min + radius), max - radius);
  const cy = Math.min(Math.max(y, min + radius), max - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

/** Normalised glyph test in a 256-unit square. */
function insideGlyph(x, y) {
  const shaft = x >= 112 && x < 144 && y >= 52 && y < 148;
  if (shaft) return true;
  // Arrow head: apex (128, 198), base y = 148, half width 46.
  if (y >= 148 && y < 198) {
    const halfWidth = 46 * (1 - (y - 148) / 50);
    if (Math.abs(x - 128) <= halfWidth) return true;
  }
  // Tray: a bar with rounded caps.
  if (y >= 214 && y < 228) {
    const dx = Math.max(0, Math.abs(x - 128) - 52);
    if (dx === 0) return true;
    return dx ** 2 + (y - 221) ** 2 <= 49;
  }
  return false;
}

/** Box-filtered RGBA bitmap at one size (samples 4x4 per pixel). */
function render(size) {
  const scale = 256 / size;
  const samples = 4;
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let bgHits = 0;
      let fgHits = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const u = (px + (sx + 0.5) / samples) * scale;
          const v = (py + (sy + 0.5) / samples) * scale;
          if (!insideRoundedRect(u, v, 256, 6, 44)) continue;
          bgHits += 1;
          if (insideGlyph(u, v)) fgHits += 1;
        }
      }
      const total = samples * samples;
      if (bgHits === 0) continue;
      const fg = fgHits / bgHits;
      const offset = (py * size + px) * 4;
      const color = TEAL.map((channel, index) => Math.round(channel + (WHITE[index] - channel) * fg));
      pixels[offset] = color[2];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[0];
      pixels[offset + 3] = Math.round((bgHits / total) * 255);
    }
  }
  return pixels;
}

/** BITMAPINFOHEADER + bottom-up BGRA + AND mask. */
function dibFor(size) {
  const pixels = render(size);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(size * size * 4, 20);

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const source = (size - 1 - y) * size * 4;
    pixels.copy(xor, y * size * 4, source, source + size * 4);
  }
  const maskStride = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(maskStride * size);
  return Buffer.concat([header, xor, and]);
}

function icoEntry(size, dib, offset) {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0);
  entry.writeUInt8(size >= 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(dib.length, 8);
  entry.writeUInt32LE(offset, 12);
  return entry;
}

function main() {
  const images = SIZES.map((size) => ({ size, dib: dibFor(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = [];
  for (const image of images) {
    entries.push(icoEntry(image.size, image.dib, offset));
    offset += image.dib.length;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, 'icon.ico');
  writeFileSync(out, Buffer.concat([header, ...entries, ...images.map((image) => image.dib)]));
  console.log(`[make-icon] ${out} (${SIZES.join('/')}px, ${(offset / 1024).toFixed(0)} KB)`);
}

main();
