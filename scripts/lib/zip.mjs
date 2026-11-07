/**
 * Minimal, dependency-free ZIP reader for build-time runtime extraction.
 *
 * Supports the common "stored" (0) and "deflate" (8) methods used by the
 * Node.js Windows zip and the BtbN FFmpeg builds. ZIP64 is not needed: all
 * entries we ship are far below 4 GiB. Only central-directory metadata is
 * parsed; entry payloads are inflated lazily, one at a time, so a ~200 MiB
 * uncompressed FFmpeg bundle never has to be held in memory at once.
 */
import { inflateRawSync } from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** Locate the End Of Central Directory record by scanning backwards. */
function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === SIG_EOCD) {
      const commentLength = buffer.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === buffer.length) return offset;
    }
  }
  throw new Error('ZIP: end-of-central-directory record not found');
}

/**
 * List every entry in a zip buffer.
 * @returns {Array<{name:string, method:number, compressedSize:number,
 *                   uncompressedSize:number, localOffset:number, dataOffset:number}>}
 */
export function listZipEntries(buffer) {
  const eocd = findEocd(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(cursor) !== SIG_CENTRAL) {
      throw new Error(`ZIP: bad central directory signature at ${cursor}`);
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString('utf8')
      .replace(/\\/g, '/');

    // The local header repeats the name/extra lengths; payload starts after it.
    if (buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`ZIP: bad local header signature at ${localOffset}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;

    entries.push({ name, method, compressedSize, uncompressedSize, localOffset, dataOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Decompress a single entry's payload. */
export function readZipEntry(buffer, entry) {
  const payload = buffer.subarray(
    entry.dataOffset,
    entry.dataOffset + entry.compressedSize,
  );
  if (entry.method === 0) return Buffer.from(payload);
  if (entry.method === 8) {
    const out = inflateRawSync(payload);
    if (out.length !== entry.uncompressedSize) {
      throw new Error(`ZIP: size mismatch for ${entry.name}`);
    }
    return out;
  }
  throw new Error(`ZIP: unsupported compression method ${entry.method} for ${entry.name}`);
}
