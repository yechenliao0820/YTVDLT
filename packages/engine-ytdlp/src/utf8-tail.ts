/**
 * D-133 / D-144 / D-153: UTF-8 byte-accounting helpers for the engine's
 * streaming paths (probe output bounding, progress line assembly, diagnostic
 * stderr tail).
 *
 * Extracted VERBATIM from `yt-dlp-engine.ts` (task 3, low-risk pure-logic
 * migration — one function cluster, the old import path stays alive through
 * re-exports there). Pure string + byte math: no DOM, no bridge, no timer,
 * no process, no I/O, no hidden globals, no closure state — the only
 * cross-module dependency is the `STREAM_TAIL_TRUNCATED_MARKER` constant
 * from `@ytvdlt/shared`.
 *
 * This package must never import `node:*` / `electron` (layering gate,
 * `scripts/check-layering.mjs`); see the D-133 note on `utf8ByteLength` for
 * why even `TextEncoder` is off the table here.
 */
import { STREAM_TAIL_TRUNCATED_MARKER } from '@ytvdlt/shared';

/**
 * D-133: UTF-8 byte length of an already-decoded string, WITHOUT `TextEncoder`.
 *
 * Why not `TextEncoder`: this package compiles with `lib: ["ES2022"]` and
 * `types: []` (no DOM, no `@types/node`), so the global is outside its type
 * surface — the layering gate exists precisely to keep this package free of
 * runtime globals. Why not `String.length`: that counts UTF-16 code units, so a
 * CJK glyph costs 1-2 units but 3 UTF-8 bytes, which is the exact 3x
 * understatement this decision is about.
 *
 * Only used for the diagnostic payload on an overflow — the enforcement itself
 * happens on raw Buffers in the adapter, which is always exact.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: a valid pair is one code point at 4 bytes; consume the
      // low surrogate too. A lone surrogate is emitted as 3 bytes by every
      // well-behaved encoder (WHATWG replacement), which is what we book here.
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * D-153: drop the OLDEST prefix of `text` that covers at least `drop` UTF-8
 * bytes, cutting on a code-point boundary — the working-buffer sibling of
 * `appendUtf8Tail` (D-144 keeps a tail of stderr diagnostics; this trims the
 * head of the stdout line-assembly buffer). When the requested cut lands
 * inside a multi-byte glyph the cut moves FORWARD to the next boundary, so
 * the retained tail can be a few bytes SHORTER than the caller's ceiling but
 * is never malformed: the byte walk books exactly what `utf8ByteLength` books
 * (1/2/3 bytes per code point, a surrogate pair as one 4-byte unit, a lone
 * surrogate as 3), which keeps the caller's incremental accounting exact:
 * `droppedBytes + utf8ByteLength(rest) === utf8ByteLength(text)`.
 *
 * O(drop) — the walk stops once the overflow is covered and never rescans the
 * retained tail, so the per-chunk cost of the flood guard stays proportional
 * to the arriving chunk, not to the buffer (same performance contract as
 * appendUtf8Tail, 手册坑 23).
 *
 * Exported for the D-153 unit tests (pure byte-accounting, no child process).
 */
export function dropUtf8Prefix(
  text: string,
  drop: number,
): { rest: string; droppedBytes: number } {
  if (drop <= 0 || text.length === 0) return { rest: text, droppedBytes: 0 };
  const total = utf8ByteLength(text);
  if (drop >= total) return { rest: '', droppedBytes: total };
  // Identical classification to utf8ByteLength / appendUtf8Tail: advance by
  // WHOLE code points until the requested byte count is covered.
  let index = 0;
  let walked = 0;
  while (walked < drop && index < text.length) {
    const code = text.charCodeAt(index);
    let unitBytes: number;
    let units = 1;
    if (code < 0x80) unitBytes = 1;
    else if (code < 0x800) unitBytes = 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) { unitBytes = 4; units = 2; }
      else unitBytes = 3;
    } else {
      unitBytes = 3;
    }
    walked += unitBytes;
    index += units;
  }
  return { rest: text.slice(index), droppedBytes: walked };
}

/**
 * D-144: bounded tail accumulator for the DOWNLOAD path's stderr.
 *
 * The old `stderrAll += chunk.text` kept every byte of every job, so a verbose
 * or long-batch download grew memory for as long as it ran. The realtime stage
 * parser still sees the full stream (the `onChunk` callback forwards every
 * chunk unchanged); only this diagnostic copy is bounded: when appending a
 * chunk would push `bytes` past the ceiling, whole code points are dropped
 * from the HEAD — failure lines sit at the end of stderr, which is exactly
 * what `result.stderr || stderrAll` feeds the error mapper — and `truncated`
 * latches so `assembleUtf8Tail` stamps STREAM_TAIL_TRUNCATED_MARKER once, in
 * front, and a clipped log can never be mistaken for a complete one.
 *
 * This package may not import `node:*`, so byte accounting reuses the D-133
 * `utf8ByteLength` walk — never `String.length` (UTF-16 units understate CJK
 * by 3x, 手册坑 23). `setEncoding('utf8')` in the adapter guarantees a
 * multi-byte sequence is never split across chunks, so per-chunk byte lengths
 * add up exactly. The desktop adapter enforces the same discipline with
 * `Buffer.byteLength` (`process-streaming.ts`), so both copies of the stream
 * are bounded.
 *
 * PERFORMANCE CONTRACT (why the retained content is a deque, not one string):
 * every append must cost O(chunk), never O(retained) — the shared event loop
 * also drives the cancel/kill path, and the adapter's measured evidence
 * (probe-output-limit 9a) shows an O(retained) per-chunk bookkeeping starves
 * it for seconds under a flood. Hence whole chunks are dropped by index bump
 * (O(1)) and only the ONE boundary chunk is walked and re-sliced (O(chunk));
 * the retained text is materialized once, at assembly.
 */
export interface Utf8Tail {
  /** Retained chunks in order; everything before `headIndex` is dropped. */
  parts: string[];
  headIndex: number;
  /** Exact UTF-8 bytes of the retained text (parts[headIndex..]). */
  bytes: number;
  truncated: boolean;
}

/** Exported for the D-144 unit tests (pure byte-accounting, no child process). */
export function appendUtf8Tail(tail: Utf8Tail, chunk: string, limit: number): void {
  if (chunk.length === 0) return;
  tail.parts.push(chunk);
  tail.bytes += utf8ByteLength(chunk);
  if (tail.bytes <= limit) return;
  tail.truncated = true;
  // Drop whole head parts while that alone covers the overflow (O(1) each),
  // then cut inside the ONE boundary part for the remainder. A surrogate pair
  // moves as one 4-byte unit; a lone surrogate books 3 bytes, matching
  // `utf8ByteLength`.
  let drop = tail.bytes - limit;
  while (drop > 0 && tail.headIndex < tail.parts.length) {
    const head = tail.parts[tail.headIndex] as string;
    const headBytes = utf8ByteLength(head);
    if (headBytes <= drop) {
      drop -= headBytes;
      tail.bytes -= headBytes;
      tail.headIndex += 1;
    } else {
      // Walk the head of THIS chunk only, until the overflow is covered.
      let index = 0;
      let walked = 0;
      while (walked < drop && index < head.length) {
        const code = head.charCodeAt(index);
        let unitBytes: number;
        let units = 1;
        if (code < 0x80) unitBytes = 1;
        else if (code < 0x800) unitBytes = 2;
        else if (code >= 0xd800 && code <= 0xdbff) {
          const next = index + 1 < head.length ? head.charCodeAt(index + 1) : 0;
          if (next >= 0xdc00 && next <= 0xdfff) { unitBytes = 4; units = 2; }
          else unitBytes = 3;
        } else {
          unitBytes = 3;
        }
        walked += unitBytes;
        index += units;
      }
      tail.parts[tail.headIndex] = head.slice(index);
      tail.bytes -= walked;
      drop = 0;
    }
  }
  // The dropped prefix is garbage; keep the deque from growing without bound
  // without ever copying retained bytes (references only, and only when the
  // dropped prefix has outgrown the retained part).
  if (tail.headIndex > 64 && tail.headIndex * 2 > tail.parts.length) {
    tail.parts = tail.parts.slice(tail.headIndex);
    tail.headIndex = 0;
  }
}

/** The retained tail text, materialized (one join; O(retained), call-site only). */
export function utf8TailText(tail: Utf8Tail): string {
  return tail.headIndex === 0 ? tail.parts.join('') : tail.parts.slice(tail.headIndex).join('');
}

/** Diagnostic value for the error mapper: the marker (once, in front) + tail. */
export function assembleUtf8Tail(tail: Utf8Tail): string {
  const text = utf8TailText(tail);
  return tail.truncated ? `${STREAM_TAIL_TRUNCATED_MARKER}\n${text}` : text;
}
