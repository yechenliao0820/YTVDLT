#!/usr/bin/env node
/**
 * Generate `apps/desktop/build/icon.ico` — the YTVDLT brand mark (0.1.10).
 *
 * Drawn entirely from geometry, no external artwork and no image dependency:
 * a rounded blue-gradient tile, a white PLAY triangle (video) and a white
 * DOWNLOAD arrow underneath. The same two glyphs form the in-app SVG badge in
 * `pages/queue/index.html`, so the window, taskbar, desktop shortcut and
 * installer all match the product. Original design — nothing is copied.
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

/** Matches the in-app badge gradient (`#3b8cf0` -> `#174ea6`). */
const TOP = [59, 140, 240];
const BOTTOM = [23, 78, 166];
const WHITE = [255, 255, 255];
const SIZES = [16, 32, 48, 256];

/** Signed distance to a rounded rectangle centred in a `size` box. */
function insideRoundedRect(x, y, size, inset, radius) {
  const min = inset;
  const max = size - inset;
  const cx = Math.min(Math.max(x, min + radius), max - radius);
  const cy = Math.min(Math.max(y, min + radius), max - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

/**
 * Normalised glyph test in a 256-unit square.
 *
 * PLAY:  A(88,54) B(190,110) C(88,166) — solid right-pointing triangle.
 * ARROW: shaft x[114,142] y[176,208], head apex (128,234) base y=204.
 * At 16px the triangle is ~6px and the arrow ~2px, both still legible.
 */
function insideGlyph(x, y) {
  // Play triangle.
  if (y >= 54 && y <= 166 && x >= 88) {
    const span = 190 - 88;
    const right = y <= 110
      ? 88 + span * ((y - 54) / (110 - 54))
      : 88 + span * ((166 - y) / (166 - 110));
    if (x <= right) return true;
  }
  // Download arrow: vertical shaft.
  if (x >= 114 && x <= 142 && y >= 176 && y <= 208) return true;
  // Download arrow: triangular head (apex down).
  if (y >= 202 && y < 234) {
    const halfWidth = 34 * (1 - (y - 202) / (234 - 202));
    if (Math.abs(x - 128) <= halfWidth) return true;
  }
  return false;
}

/** Box-filtered RGBA bitmap at one size (samples 4x4 per pixel). */
function render(size) {
  const scale = 256 / size;
  const samples = 4;
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    // Vertical gradient, sampled at the pixel centre.
    const grad = (py + 0.5) / size;
    const bg = TOP.map((channel, index) => channel + (BOTTOM[index] - channel) * grad);
    for (let px = 0; px < size; px += 1) {
      let bgHits = 0;
      let fgHits = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const u = (px + (sx + 0.5) / samples) * scale;
          const v = (py + (sy + 0.5) / samples) * scale;
          if (!insideRoundedRect(u, v, 256, 6, 46)) continue;
          bgHits += 1;
          if (insideGlyph(u, v)) fgHits += 1;
        }
      }
      const total = samples * samples;
      if (bgHits === 0) continue;
      const fg = fgHits / bgHits;
      const offset = (py * size + px) * 4;
      const color = bg.map((channel, index) => Math.round(channel + (WHITE[index] - channel) * fg));
      pixels[offset] = color[2];     // B
      pixels[offset + 1] = color[1]; // G
      pixels[offset + 2] = color[0]; // R
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
