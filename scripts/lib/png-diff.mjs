#!/usr/bin/env node
/**
 * png-diff.mjs — zero-dependency PNG decode + RGBA tolerance diff (F026).
 *
 * Uses only Node built-ins (`node:zlib` / `node:crypto`). Supports bit depth 8,
 * non-interlaced, colour types 0/2/3/4/6 and all five PNG row filters
 * (0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth). Chrome headless screenshots are
 * RGB or RGBA; palette support is included for completeness.
 *
 * Main criterion ② of §1.5.3: a pixel differs when ANY RGBA channel delta
 * exceeds `tolerance` (default 2); the whole image passes when the differing
 * pixel ratio is <= `maxRatio` (default 0.001 = 0.1%). PNG byte / SHA-256
 * comparison is deliberately NOT a main criterion (non-deterministic metadata).
 */
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const DEFAULT_TOLERANCE = 2;
/**
 * Zero differing pixels is required. §1.5.3 allows <=0.1% (1024 px) for
 * cross-machine antialiasing, but the fixed 1280x800 / DPR1 / fixed-font render
 * is pixel-identical on this host (verified over 3 consecutive runs). A STRICT
 * ratio of 0 guarantees that QA corrupting even ONE baseline pixel makes the
 * main criterion ② FAIL instead of being silently absorbed by the tolerance.
 * The per-channel tolerance of 2 still absorbs sub-2 antialiasing deltas.
 */
export const DEFAULT_MAX_RATIO = 0;
export const EXPECTED_WIDTH = 1280;
export const EXPECTED_HEIGHT = 800;

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function channelCount(colorType) {
  switch (colorType) {
    case 0: return 1; // grayscale
    case 2: return 3; // RGB
    case 3: return 1; // palette index
    case 4: return 2; // grayscale + alpha
    case 6: return 4; // RGBA
    default: throw new Error(`unsupported PNG colour type: ${colorType}`);
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Convert an unfiltered raw byte row into RGBA. */
function rowToRgba(row, width, colorType, channels, palette, transparency) {
  const out = new Uint8Array(width * 4);
  const stride = channels;
  for (let x = 0; x < width; x += 1) {
    const source = x * stride;
    const dest = x * 4;
    if (colorType === 0) {
      const g = row[source];
      out[dest] = g; out[dest + 1] = g; out[dest + 2] = g; out[dest + 3] = 255;
    } else if (colorType === 2) {
      out[dest] = row[source]; out[dest + 1] = row[source + 1];
      out[dest + 2] = row[source + 2]; out[dest + 3] = 255;
    } else if (colorType === 3) {
      const index = row[source];
      const base = index * 3;
      out[dest] = palette ? palette[base] : 0;
      out[dest + 1] = palette ? palette[base + 1] : 0;
      out[dest + 2] = palette ? palette[base + 2] : 0;
      out[dest + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    } else if (colorType === 4) {
      const g = row[source];
      out[dest] = g; out[dest + 1] = g; out[dest + 2] = g; out[dest + 3] = row[source + 1];
    } else {
      out[dest] = row[source]; out[dest + 1] = row[source + 1];
      out[dest + 2] = row[source + 2]; out[dest + 3] = row[source + 3];
    }
  }
  return out;
}

/**
 * Decode a PNG buffer into `{width, height, colorType, bitDepth, rgba}`.
 * @param {Buffer} buffer
 */
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('decodePng: not a PNG file (bad signature)');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette = null;
  let transparency = null;
  const idat = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error(`decodePng: truncated ${type} chunk`);
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      const compression = data[10];
      const filterMethod = data[11];
      interlace = data[12];
      if (compression !== 0 || filterMethod !== 0) throw new Error('decodePng: unsupported compression/filter method');
      if (bitDepth !== 8) throw new Error(`decodePng: unsupported bit depth ${bitDepth}`);
      if (interlace !== 0) throw new Error('decodePng: interlaced PNG not supported');
    } else if (type === 'PLTE') {
      palette = Uint8Array.from(data);
    } else if (type === 'tRNS') {
      transparency = Uint8Array.from(data);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4; // skip CRC
  }
  if (width === 0 || height === 0 || colorType === -1 || idat.length === 0) {
    throw new Error('decodePng: missing IHDR or IDAT');
  }
  const channels = channelCount(colorType);
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) {
    throw new Error(`decodePng: inflated data too short (${raw.length} < ${height * (stride + 1)})`);
  }

  const rgba = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);
  let position = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[position];
    position += 1;
    for (let i = 0; i < stride; i += 1) {
      const value = raw[position + i];
      const left = i >= channels ? current[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      let reconstructed = value;
      if (filter === 1) reconstructed = value + left;
      else if (filter === 2) reconstructed = value + up;
      else if (filter === 3) reconstructed = value + Math.floor((left + up) / 2);
      else if (filter === 4) reconstructed = value + paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`decodePng: unknown row filter ${filter}`);
      current[i] = reconstructed & 0xff;
    }
    rgba.set(rowToRgba(current, width, colorType, channels, palette, transparency), y * width * 4);
    previous.set(current);
    position += stride;
  }
  return { width, height, colorType, bitDepth, rgba };
}

/**
 * Compare two decoded images (or raw `{width,height,rgba}` objects).
 * Returns a structured verdict; NEVER throws on a visual mismatch.
 */
export function compareRgba(a, b, options = {}) {
  const tolerance = Number.isFinite(options.tolerance) ? options.tolerance : DEFAULT_TOLERANCE;
  const maxRatio = Number.isFinite(options.maxRatio) ? options.maxRatio : DEFAULT_MAX_RATIO;
  const expectedWidth = options.expectedWidth ?? EXPECTED_WIDTH;
  const expectedHeight = options.expectedHeight ?? EXPECTED_HEIGHT;
  const base = {
    tolerance, maxRatio, expectedWidth, expectedHeight,
    width: a.width, height: a.height,
    differPixels: 0, totalPixels: a.width * a.height, ratio: 0, maxChannelDiff: 0,
  };
  if (a.width !== b.width || a.height !== b.height) {
    return { ...base, pass: false, reason: `size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}` };
  }
  if (a.width !== expectedWidth || a.height !== expectedHeight) {
    return { ...base, pass: false, reason: `expected ${expectedWidth}x${expectedHeight}, got ${a.width}x${a.height}` };
  }
  let differ = 0;
  let maxChannelDiff = 0;
  for (let i = 0; i < a.rgba.length; i += 4) {
    let pixelDiffers = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(a.rgba[i + channel] - b.rgba[i + channel]);
      if (delta > maxChannelDiff) maxChannelDiff = delta;
      if (delta > tolerance) pixelDiffers = true;
    }
    if (pixelDiffers) differ += 1;
  }
  const ratio = base.totalPixels === 0 ? 0 : differ / base.totalPixels;
  return {
    ...base, differPixels: differ, ratio, maxChannelDiff,
    pass: ratio <= maxRatio,
    reason: ratio <= maxRatio ? 'within tolerance' : `${differ} differing pixels (${(ratio * 100).toFixed(4)}%) > ${(maxRatio * 100).toFixed(2)}%`,
  };
}

/** Convenience wrapper: decode two PNG buffers then compare. */
export function comparePngBuffers(bufferA, bufferB, options = {}) {
  let a;
  let b;
  try {
    a = decodePng(bufferA);
    b = decodePng(bufferB);
  } catch (error) {
    return {
      pass: false, reason: `decode failed: ${error.message}`,
      tolerance: options.tolerance ?? DEFAULT_TOLERANCE,
      maxRatio: options.maxRatio ?? DEFAULT_MAX_RATIO,
      differPixels: 0, ratio: 1, maxChannelDiff: 0, width: 0, height: 0, totalPixels: 0,
    };
  }
  return compareRgba(a, b, options);
}

/** Flip `count` pixels to a high-contrast colour (QA negative-check helper). */
export function corruptRgba(image, count = 1) {
  const copy = { width: image.width, height: image.height, rgba: Uint8Array.from(image.rgba) };
  const step = Math.max(1, Math.floor(copy.rgba.length / 4 / Math.max(1, count)));
  for (let n = 0; n < count; n += 1) {
    const pixel = (n * step) % (copy.rgba.length / 4);
    const index = pixel * 4;
    copy.rgba[index] = 255 - copy.rgba[index];
    copy.rgba[index + 1] = 255 - copy.rgba[index + 1];
    copy.rgba[index + 2] = 255 - copy.rgba[index + 2];
    copy.rgba[index + 3] = 255;
  }
  return copy;
}
