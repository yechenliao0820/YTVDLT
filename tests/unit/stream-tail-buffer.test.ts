/**
 * D-144 — bounded tail retention for the streaming (download) spawn path.
 *
 * Two levels, mirroring probe-output-limit.test.ts:
 *
 *  L0 · the tail-buffer accounting itself — byte-exactness (UTF-8 CJK glyphs,
 *       surrogate pairs, chunk boundaries, landing exactly on the ceiling),
 *       the once-only FRONT marker, last-line preservation, and the deque
 *       staying SMALL during a flood (the O(chunk) performance contract that
 *       keeps the shared event loop — and with it the kill path — responsive).
 *       Pure: no child process, no timing. Both implementations are exercised:
 *       the adapter's (`process-streaming.ts`, Buffer.byteLength) and the
 *       engine's (`yt-dlp-engine.ts`, utf8ByteLength) — same algorithm,
 *       layer-appropriate byte counting.
 *
 *  L2 · the REAL `process-streaming` adapter spawning the REAL bundled
 *       node.exe — both streams above the 1 MiB ceiling: `done()` is bounded
 *       and marked, the last line survives, `onChunk` still receives EVERY
 *       byte (progress parsing stays unlimited), exitCode is preserved, and a
 *       cancelled flood still settles with `exitCode: null`.
 *
 * Why node.exe: a tail needs an output PRODUCER whose size is controllable to
 * the byte (`node -e '...'`); the bundled node.exe exercises the identical
 * adapter code path with deterministic input — fully offline.
 */
import { afterAll, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STREAM_TAIL_MAX_BYTES, STREAM_TAIL_TRUNCATED_MARKER,
} from '@ytvdlt/shared';
import { ErrorMapper } from '@ytvdlt/core';
import { utf8ByteLength } from '@ytvdlt/engine-ytdlp';
import { appendUtf8Tail, assembleUtf8Tail, utf8TailText } from '../../packages/engine-ytdlp/src/yt-dlp-engine.js';
import {
  appendToStreamTail, assembleStreamTail, newStreamTail, streamTailText,
  createStreamingProcessPort,
} from '../../apps/desktop/src/main/adapters/process-streaming.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NODE_EXE = join(ROOT, 'resources', 'runtime', 'win-x64', 'node.exe');

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ytvdlt-tail-'));
  cleanup.push(dir);
  return dir;
};

const MARKER_BYTES = Buffer.byteLength(`${STREAM_TAIL_TRUNCATED_MARKER}\n`, 'utf8');

/** A lone (unpaired) surrogate means a cut landed inside a code point. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ---------------------------------------------------------------------------
// L0 · adapter tail accounting (process-streaming.ts)
// ---------------------------------------------------------------------------

describe('D-144 · adapter tail accounting (L0)', () => {
  it('keeps everything byte-exact below the ceiling, with no marker', () => {
    const tail = newStreamTail();
    appendToStreamTail(tail, 'alpha\n', 100);
    appendToStreamTail(tail, 'beta\n', 100);
    expect(tail.truncated).toBe(false);
    expect(streamTailText(tail)).toBe('alpha\nbeta\n');
    expect(assembleStreamTail(tail)).toBe('alpha\nbeta\n');
    expect(Buffer.byteLength(assembleStreamTail(tail), 'utf8')).toBe(11);
  });

  it('treats landing EXACTLY on the ceiling as accepted', () => {
    const tail = newStreamTail();
    appendToStreamTail(tail, 'x'.repeat(100), 100);
    expect(tail.truncated).toBe(false);
    expect(assembleStreamTail(tail)).toBe('x'.repeat(100));
  });

  it('drops from the HEAD, marks ONCE in front, and keeps the tail', () => {
    const tail = newStreamTail();
    appendToStreamTail(tail, 'a'.repeat(600), 1000);
    appendToStreamTail(tail, 'b'.repeat(600), 1000);
    // 1200 bytes over a 1000 ceiling → 200 head bytes dropped.
    expect(tail.truncated).toBe(true);
    const assembled = assembleStreamTail(tail);
    expect(assembled.startsWith(`${STREAM_TAIL_TRUNCATED_MARKER}\n`)).toBe(true);
    expect(assembled.split(STREAM_TAIL_TRUNCATED_MARKER).length - 1).toBe(1);
    expect(assembled).toBe(`${STREAM_TAIL_TRUNCATED_MARKER}\n${'a'.repeat(400)}${'b'.repeat(600)}`);
    expect(tail.bytes).toBe(1000);
    expect(Buffer.byteLength(streamTailText(tail), 'utf8')).toBe(1000);
  });

  it('a single chunk larger than the ceiling keeps that chunk\'s OWN tail', () => {
    const tail = newStreamTail();
    appendToStreamTail(tail, 'h'.repeat(50) + 't'.repeat(2000), 1000);
    expect(tail.truncated).toBe(true);
    expect(streamTailText(tail)).toBe('t'.repeat(1000));
    expect(streamTailText(tail).startsWith('h')).toBe(false);
  });

  it('counts BYTES, not UTF-16 units, for a CJK payload (D-133 lesson, 手册坑 23)', () => {
    // 1000 CJK glyphs = 3000 UTF-8 bytes but only 1000 JS characters: a
    // `text.length` accounting would never truncate this against 2999.
    const tail = newStreamTail();
    appendToStreamTail(tail, '中'.repeat(1000), 2999);
    expect(tail.truncated).toBe(true);
    expect(Buffer.byteLength(streamTailText(tail), 'utf8')).toBe(2997);
    expect(streamTailText(tail)).toBe('中'.repeat(999));
    expect(Buffer.byteLength(streamTailText(tail), 'utf8') % 3).toBe(0);
  });

  it('cuts on code-point boundaries — surrogate pairs move as one 4-byte unit', () => {
    const tail = newStreamTail();
    // 🙂 is 4 UTF-8 bytes and a surrogate PAIR (2 UTF-16 units).
    appendToStreamTail(tail, '🙂'.repeat(600), 2999); // 2400 bytes, fits
    appendToStreamTail(tail, '🙂'.repeat(600), 2999); // 4800 bytes, 1801 over
    expect(tail.truncated).toBe(true);
    expect(tail.bytes).toBe(Buffer.byteLength(streamTailText(tail), 'utf8'));
    expect(tail.bytes).toBeLessThanOrEqual(2999);
    // 2996 = the largest multiple of 4 ≤ 2999 → every glyph whole.
    expect(tail.bytes).toBe(2996);
    expect(LONE_SURROGATE.test(streamTailText(tail))).toBe(false);
    expect(assembleStreamTail(tail).endsWith('🙂'.repeat(749))).toBe(true);
  });

  it('a cut that lands mid-line still keeps the FINAL line intact', () => {
    const tail = newStreamTail();
    appendToStreamTail(tail, 'old-1\nold-2\n', 1000);
    appendToStreamTail(tail, 'x'.repeat(990), 1000);
    appendToStreamTail(tail, 'ERROR: last line\n', 1000);
    expect(tail.truncated).toBe(true);
    expect(streamTailText(tail).endsWith('ERROR: last line\n')).toBe(true);
    expect(streamTailText(tail)).not.toContain('old-1');
  });

  it('stays marked after repeated breaches and never grows past the ceiling', () => {
    const tail = newStreamTail();
    const chunkOf = (round: number): string => `r${round}-`.padEnd(64, 'z');
    for (let round = 0; round < 50; round += 1) {
      appendToStreamTail(tail, chunkOf(round), 1000);
      expect(tail.bytes).toBeLessThanOrEqual(1000);
      expect(tail.bytes).toBe(Buffer.byteLength(streamTailText(tail), 'utf8'));
    }
    expect(tail.truncated).toBe(true);
    expect(assembleStreamTail(tail).split(STREAM_TAIL_TRUNCATED_MARKER).length - 1).toBe(1);
    expect(assembleStreamTail(tail).endsWith(chunkOf(49))).toBe(true);
  });

  it('the deque stays SMALL under a flood — no per-chunk O(retained) copies', () => {
    // 20 000 chunks of 64 B over a 1 MiB window. The performance contract is
    // O(chunk) per append: the dropped-prefix deque must be compacted, not
    // grown (a growing deque would keep EVERY chunk alive — unbounded memory,
    // the very thing D-144 removes).
    const tail = newStreamTail();
    for (let i = 0; i < 20_000; i += 1) {
      appendToStreamTail(tail, `chunk-${String(i).padStart(5, '0')}-${'y'.repeat(48)}\n`, 1000);
    }
    expect(tail.truncated).toBe(true);
    expect(tail.bytes).toBeLessThanOrEqual(1000);
    // Bounded live window + at most one compaction threshold of garbage.
    expect(tail.parts.length - tail.headIndex).toBeLessThanOrEqual(40);
    expect(tail.parts.length).toBeLessThan(200);
    // The MOST RECENT chunk (the diagnostic tail's whole point) is intact.
    expect(streamTailText(tail).endsWith(`chunk-19999-${'y'.repeat(48)}\n`)).toBe(true);
  });

  it('an empty chunk is a no-op', () => {
    const tail = newStreamTail();
    appendToStreamTail(tail, '', 10);
    expect(tail.truncated).toBe(false);
    expect(streamTailText(tail)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// L0 · engine tail accounting (yt-dlp-engine.ts, utf8ByteLength walk)
// ---------------------------------------------------------------------------

describe('D-144 · engine stderrAll tail accounting (L0)', () => {
  const engineTail = () => ({ parts: [] as string[], headIndex: 0, bytes: 0, truncated: false });

  it('behaves identically to the adapter tail below and above the ceiling', () => {
    const tail = engineTail();
    appendUtf8Tail(tail, 'a'.repeat(600), 1000);
    appendUtf8Tail(tail, 'b'.repeat(600), 1000);
    expect(tail.truncated).toBe(true);
    expect(utf8TailText(tail)).toBe(`${'a'.repeat(400)}${'b'.repeat(600)}`);
    expect(tail.bytes).toBe(1000);
    expect(assembleUtf8Tail(tail))
      .toBe(`${STREAM_TAIL_TRUNCATED_MARKER}\n${'a'.repeat(400)}${'b'.repeat(600)}`);
  });

  it('a CJK flood is bounded on UTF-8 bytes although the chunk looks short', () => {
    const tail = engineTail();
    appendUtf8Tail(tail, '中'.repeat(500_000), STREAM_TAIL_MAX_BYTES);
    expect(tail.truncated).toBe(true);
    expect(tail.bytes).toBe(STREAM_TAIL_MAX_BYTES - (STREAM_TAIL_MAX_BYTES % 3));
    expect(utf8TailText(tail).length).toBeLessThan(tail.bytes); // 3 bytes per glyph, 1 UTF-16 unit each
    expect(assembleUtf8Tail(tail).endsWith('中')).toBe(true);
  });

  it('an untruncated tail assembles without any marker', () => {
    const tail = engineTail();
    appendUtf8Tail(tail, 'ERROR: last line\n', 1000);
    expect(assembleUtf8Tail(tail)).toBe('ERROR: last line\n');
  });

  it('a chunked CJK flood keeps whole glyphs at the boundary and stays compact', () => {
    const tail = engineTail();
    for (let i = 0; i < 4000; i += 1) {
      appendUtf8Tail(tail, `第${i}行：${'告'.repeat(20)}\n`, 2048);
      expect(tail.bytes).toBeLessThanOrEqual(2048);
    }
    expect(tail.truncated).toBe(true);
    expect(tail.bytes).toBe(utf8ByteLength(utf8TailText(tail)));
    expect(utf8TailText(tail).endsWith('\n')).toBe(true);
    expect(tail.parts.length - tail.headIndex).toBeLessThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// L0 · the marker is neutral for the error keyword table
// ---------------------------------------------------------------------------

describe('D-144 · STREAM_TAIL_TRUNCATED_MARKER neutrality', () => {
  it('is a fixed [ytvdlt] string carrying no error-mapper keyword', () => {
    expect(STREAM_TAIL_TRUNCATED_MARKER).toMatch(/^\[ytvdlt\]/);
    for (const word of [
      'timeout', 'timed out', 'denied', 'permission', 'network', '429',
      '403', 'dns', 'unsupported', 'not available', 'downloaded', 'disk full',
      'eacces', 'eperm', 'enoent', 'ffmpeg', 'ejs', 'js runtime',
    ]) {
      expect(STREAM_TAIL_TRUNCATED_MARKER.toLowerCase()).not.toContain(word);
    }
  });

  it('maps to UNKNOWN — truncation is a fact, never an error class', () => {
    const mapper = new ErrorMapper({ clock: { nowIso: () => 'x', nowEpochMs: () => 0 } });
    const ctx = {
      url: 'https://example.org/v', stderr: STREAM_TAIL_TRUNCATED_MARKER,
      engineVersion: 'x', appVersion: 'x', os: 'win32', argv: [] as string[],
    };
    expect(mapper.map(STREAM_TAIL_TRUNCATED_MARKER, ctx).code).toBe('UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// L2 · the real adapter, real bundled node.exe
// ---------------------------------------------------------------------------

describe('D-144 · streaming spawn against the real bundled node.exe (L2)', () => {
  const N = 24_000;
  const lineOf = (i: number): string => `line-${String(i).padStart(5, '0')}-${'x'.repeat(36)}\n`;
  const expectedFull = Array.from({ length: N }, (_, i) => lineOf(i)).join('');
  // lineOf(i) = 11 + 36 + 1 = 48 bytes; 24000 lines = 1,152,000 > 1 MiB.
  const script = `const N=${N};`
    + 'for(let i=0;i<N;i+=1){const s="line-"+String(i).padStart(5,"0")+"-"+"x".repeat(36)+"\\n";'
    + 'process.stdout.write(s);process.stderr.write(s);}';

  it('1 · >1 MiB on BOTH streams: done() bounded+marked, last line kept, onChunk whole', async () => {
    const port = createStreamingProcessPort();
    const seen: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
    const handle = port.spawnStreaming(
      NODE_EXE, ['-e', script], { shell: false, windowsHide: true, timeoutMs: 30_000 },
      (chunk) => seen.push(chunk),
    );
    const done = await handle.done;

    expect(done.exitCode).toBe(0);
    expect(done.timedOut).toBe(false);

    // onChunk is untouched: BOTH streams delivered every byte, in order.
    const stdoutChunks = seen.filter((c) => c.stream === 'stdout').map((c) => c.text).join('');
    const stderrChunks = seen.filter((c) => c.stream === 'stderr').map((c) => c.text).join('');
    expect(stdoutChunks).toBe(expectedFull);
    expect(stderrChunks).toBe(expectedFull);

    for (const assembled of [done.stdout, done.stderr]) {
      expect(assembled.startsWith(`${STREAM_TAIL_TRUNCATED_MARKER}\n`)).toBe(true);
      expect(assembled.split(STREAM_TAIL_TRUNCATED_MARKER).length - 1).toBe(1);
      const totalBytes = Buffer.byteLength(assembled, 'utf8');
      expect(totalBytes).toBeLessThanOrEqual(STREAM_TAIL_MAX_BYTES + MARKER_BYTES);
      // The retained tail sits close to the ceiling (48-byte chunks, so the
      // window is nearly full) and the FINAL line is intact.
      expect(totalBytes).toBeGreaterThanOrEqual(STREAM_TAIL_MAX_BYTES + MARKER_BYTES - 96);
      expect(assembled.endsWith(lineOf(N - 1))).toBe(true);
      // The head is gone and what remains is exactly a suffix of the stream.
      expect(assembled).not.toContain(lineOf(0));
      expect(expectedFull.endsWith(assembled.slice(MARKER_BYTES))).toBe(true);
    }
    // The child printed the same bytes to both streams, so both tails are the
    // same last-1-MiB window — asserting they differ would be wrong.
  }, 30_000);

  it('2 · a CJK flood is cut on its BYTE budget inside the real pipe', async () => {
    const port = createStreamingProcessPort();
    // 600k glyphs = 1.8 MB UTF-8 but only 600k JS characters — a
    // `String.length` accounting would have kept it ALL (600k units < 1 MiB).
    const script = 'process.stderr.write("中".repeat(600_000));';
    const seen: string[] = [];
    const handle = port.spawnStreaming(
      NODE_EXE, ['-e', script], { shell: false, windowsHide: true, timeoutMs: 30_000 },
      (chunk) => { if (chunk.stream === 'stderr') seen.push(chunk.text); },
    );
    const done = await handle.done;
    expect(done.exitCode).toBe(0);
    expect(done.stderr.startsWith(`${STREAM_TAIL_TRUNCATED_MARKER}\n`)).toBe(true);
    const retained = done.stderr.slice(MARKER_BYTES);
    const retainedBytes = Buffer.byteLength(retained, 'utf8');
    // Whole glyphs only: 3 bytes each, so the retained byte count is a
    // multiple of 3 and sits just under the ceiling.
    expect(retainedBytes % 3).toBe(0);
    expect(retainedBytes).toBeLessThanOrEqual(STREAM_TAIL_MAX_BYTES);
    expect(retainedBytes).toBeGreaterThan(STREAM_TAIL_MAX_BYTES - 3);
    expect(retained.endsWith('中')).toBe(true);
    // Every byte still crossed onChunk (progress parsing stays unlimited).
    expect(Buffer.byteLength(seen.join(''), 'utf8')).toBe(1_800_000);
  }, 30_000);

  it('3 · below the ceiling the result stays complete and unmarked', async () => {
    const port = createStreamingProcessPort();
    const handle = port.spawnStreaming(
      NODE_EXE, ['-e', 'process.stdout.write("ok");process.stderr.write("warn\\n")'],
      { shell: false, windowsHide: true, timeoutMs: 30_000 },
      () => undefined,
    );
    const done = await handle.done;
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toBe('ok');
    expect(done.stderr).toBe('warn\n');
    expect(done.stdout).not.toContain(STREAM_TAIL_TRUNCATED_MARKER);
    expect(done.stderr).not.toContain(STREAM_TAIL_TRUNCATED_MARKER);
  }, 30_000);

  it('4 · cancelling a flooding child still settles with exitCode null and a bounded tail', async () => {
    const port = createStreamingProcessPort();
    const script = 'const c="f".repeat(65_536);'
      + '(function p(){ process.stdout.write(c); setImmediate(p); })();';
    const handle = port.spawnStreaming(
      NODE_EXE, ['-e', script], { shell: false, windowsHide: true, timeoutMs: 30_000 },
      () => undefined,
    );
    expect(handle.pid).not.toBe(null);
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    expect(await handle.kill()).toBe(true);
    const done = await handle.done;
    // D-137/D-142 semantics preserved: a requested kill poisons the exit code.
    expect(done.exitCode).toBe(null);
    expect(done.timedOut).toBe(false);
    // The diagnostic copy is bounded even though the child flooded for 400 ms.
    expect(Buffer.byteLength(done.stdout, 'utf8'))
      .toBeLessThanOrEqual(STREAM_TAIL_MAX_BYTES + MARKER_BYTES);
    expect(done.stdout.startsWith(`${STREAM_TAIL_TRUNCATED_MARKER}\n`)).toBe(true);
    expect(await port.isAlive(handle.pid as number)).toBe(false);
  }, 30_000);
});
