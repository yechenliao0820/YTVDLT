/**
 * D-120 — real filesystem adapters for the two main-process jobs that must
 * distinguish "gone" from "cannot be deleted".
 *
 * This file belongs in `apps/desktop/src/main/adapters`: it is the ONLY place
 * that touches `node:fs` for these features. Everything above it (channel
 * layer, core, renderer) receives ports and stays offline-testable.
 *
 * `shell.trashItem` is injected, not imported, so the adapter has no `electron`
 * dependency and its error classification can be unit tested with fakes.
 */
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalContainmentRoots, isPathInsideRoots, normalizedForContainment } from '@ytvdlt/core';
import type { TrashFileOutcome, TrashFilesPort, TrashPreflightVerdict } from '../m5-channels.js';
import {
  createLocalFileStatusProbe, type LocalFileStatusPort, type StatOutcome,
} from '../local-file-status.js';

/** `stat` never throws: the errno is data, not a crash. */
export async function nodeStat(path: string): Promise<StatOutcome> {
  try {
    const info = await fs.stat(path);
    if (info.isDirectory()) return { kind: 'dir' };
    if (info.isFile()) return { kind: 'file' };
    return { kind: 'other' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return { kind: 'error', code: typeof code === 'string' ? code : 'UNKNOWN' };
  }
}

export function createLocalFileStatusPort(): LocalFileStatusPort {
  return createLocalFileStatusProbe({ stat: nodeStat });
}

/**
 * Electron's `shell.trashItem` can reject with an OS error whose `code` is
 * absent. Only an explicit not-found errno / Windows shell code counts as
 * "already gone"; permission, sharing-violation and unknown errors stay errors.
 */
export function classifyTrashError(error: unknown): 'missing' | 'error' {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  const text = error instanceof Error ? error.message : String(error);
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
  if (/\bENOENT\b/.test(text) || /\bERROR_FILE_NOT_FOUND\b/.test(text)) return 'missing';
  return 'error';
}

export function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code !== '' ? `${code}: ${text}` : text;
}

// ---------------------------------------------------------------------------
// D-207 · delete-chain pre-flight (the counterpart of D-204's open face)
// ---------------------------------------------------------------------------
// The string gate (`isPathInsideRoots`) compares NAMES. On Windows the kernel
// silently resolves a reparse point placed in a MIDDLE path component, so a
// recorded `<videoDir>/link/file.mp4` can physically live ANYWHERE while every
// name-level check passes — and the per-entry lstat guard below only sees the
// LAST component (`lstat('…/link/file.mp4')` reports a plain file). The
// deletion chain therefore gets the same treatment the open face got in
// D-204: resolve each path to its FINAL real location and re-run containment
// on the RESOLVED path before anything destructive may happen.
//
// Decision tree per path (fail-closed: the owner acceptance criterion is
// "a file that cannot be PROVEN to belong to the current task is never
// deleted"):
//   1. `lstat` reports a symlink/junction for the entry itself  -> refuse
//      (D-203 policy, hoisted here so a MIXED batch is refused as a whole
//      before any `trashItem` — nothing may enter the bin ahead of a refusal);
//   2. `realpath(path)` resolves and sits outside the roots     -> refuse;
//   3. `realpath(path)` resolves inside                         -> ok;
//   4. `realpath(path)` throws ENOENT/ENOTDIR -> disambiguate via the PARENT:
//        - parent resolves inside-or-equal-to a root -> `missing` (the D-120
//          idempotent case: the file was deleted externally, the context is
//          decidable, nothing there to delete — the record may go);
//        - parent resolves OUTSIDE (the recorded path escapes through a
//          mid-path junction; the escape target may itself have vanished)
//          -> refuse;
//        - parent unresolvable (dangling junction: ENOENT/EACCES/…) -> refuse
//          with the REAL errno — the context cannot prove ownership;
//   5. `realpath` throws anything else (EACCES / EPERM / ELOOP / …) -> refuse
//      with the REAL errno: a real path we cannot obtain is one we cannot
//      prove safe.
//
// `roots` equality is allowed ONLY where the parent is judged (step 4): a file
// that lived directly in `videoDir` and was deleted externally resolves its
// parent ONTO the trusted root itself. FILES (step 2) keep strict-inside —
// same asymmetry as D-204's `allowRootItself`.
//
// The per-entry lstat guard inside `trash()` stays in place UNCHANGED behind
// this gate as the TOCTOU second line (spec item: "预检之后、trash 之前的第二
// 道防线").

/** Single canonical refusal copy for an end-component symlink / junction. */
const LINK_REFUSAL_REASON = '符号链接/联接无法验证归属，已拒绝移入回收站';
/** Single canonical refusal copy for a real path that lands outside the roots. */
const OUTSIDE_REFUSAL_REASON = '产物真实路径指向任务输出目录之外（符号链接/联接），已拒绝回收';

/** The real errno of a filesystem error, `UNKNOWN` when the code is absent. */
function errnoOf(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code !== '' ? code : 'UNKNOWN';
}

/** D-204-style reason detail: the real errno plus the OS message. */
function errnoDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const code = errnoOf(error);
  return code !== 'UNKNOWN' && !detail.includes(code) ? `${code}: ${detail}` : detail;
}

/**
 * D-204 parity helper (`pathEqualsAnyRoot` there): true when the resolved path
 * IS one of the trusted roots (normalized equality). Needed only for the
 * parent-directory judgement, where the root itself is a legitimate
 * resolution target; strict-inside stays the rule for the file entries.
 */
function pathEqualsAnyRoot(candidate: string, roots: readonly string[]): boolean {
  const normalized = normalizedForContainment(candidate);
  if (normalized === null) return false;
  return roots.some((root) => normalizedForContainment(root) === normalized);
}

export interface TrashPreflightContext {
  /** The record's trusted output roots (`trustedArtifactRoots()`, non-null). */
  readonly roots: readonly string[];
  /** Resolves through every symlink / junction (production: `fs.realpath`). */
  readonly realpath: (path: string) => Promise<string>;
  /** Does NOT follow the final component (production: `fs.lstat`). */
  readonly lstat: (path: string) => Promise<{ isSymbolicLink(): boolean }>;
}

type PreflightEntry =
  | { readonly kind: 'ok' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'refused'; readonly reason: string };

async function preflightOnePath(
  path: string,
  context: TrashPreflightContext,
  // D-208: string roots PLUS their canonical (realpath) aliases — see
  // `canonicalContainmentRoots`. The verdicts below compare a REALPATH
  // resolution, which on Windows can legitimately be in a different form
  // (8.3 short name vs long name) than the configured root string.
  verificationRoots: readonly string[],
): Promise<PreflightEntry> {
  // (1) end-component link -> refuse. An lstat FAILURE is no verdict here: a
  // dangling mid-path junction lstat-ENOENTs through its children, and that
  // case is decided by the realpath tree below — never as "missing".
  try {
    if ((await context.lstat(path)).isSymbolicLink()) {
      return { kind: 'refused', reason: LINK_REFUSAL_REASON };
    }
  } catch {
    // fall through: only the realpath resolution below may classify absence.
  }
  // (2..4) resolve the FINAL real location through every junction / symlink.
  let real: string;
  try {
    real = await context.realpath(path);
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // The entry itself is gone. Split "deleted externally, decidable
      // context" from "undecidable context" BEFORE calling this `missing` —
      // misclassifying a dangling junction here is exactly the A-2c escape
      // (the record would be dropped while the reparse point stays behind).
      let parentReal: string;
      try {
        parentReal = await context.realpath(dirname(path));
      } catch (parentError) {
        return {
          kind: 'refused',
          reason: `无法解析产物父目录真实路径（${errnoDetail(parentError)}），`
            + '无法证明产物归属（悬空符号链接/联接或目录上下文不可判定），已拒绝回收',
        };
      }
      if (!isPathInsideRoots(parentReal, verificationRoots) && !pathEqualsAnyRoot(parentReal, verificationRoots)) {
        // The parent resolved, but through a junction its REAL location sits
        // outside the roots — the recorded path escapes containment exactly
        // like the resolved-file case, so it cannot be proven to be this
        // task's own.
        return { kind: 'refused', reason: OUTSIDE_REFUSAL_REASON };
      }
      return { kind: 'missing' };
    }
    // (5) EACCES / EPERM / ELOOP / …: fail closed with the real errno.
    return {
      kind: 'refused',
      reason: `无法解析产物真实路径（${errnoDetail(error)}），无法证明产物归属，已拒绝回收`,
    };
  }
  if (!isPathInsideRoots(real, verificationRoots)) {
    return { kind: 'refused', reason: OUTSIDE_REFUSAL_REASON };
  }
  return { kind: 'ok' };
}

/**
 * D-207: validate a WHOLE removal batch before anything destructive. Pure at
 * the layer boundary: every filesystem primitive arrives via `context`, so the
 * decision tree is unit-testable without disk access.
 *
 * ONE unprovable path refuses the WHOLE batch (`kind: 'refused'` with the
 * FIRST offender's real reason and the honest offender count) — the caller
 * must then never reach the recycle bin and must keep the record. Provably
 * gone entries come back as `missingPaths` (exact input strings) and are the
 * caller's D-120 `filesMissing` bookkeeping; they are excluded from the trash
 * call.
 *
 * D-221 re-audit · root binding: an `ok` verdict also carries the
 * `verificationRoots` this verdict was judged against (the D-208 canonical
 * alias list), so the caller can hand them back to `trash()` as its
 * `expectedCanonicalRoots` — the executor then verifies root IDENTITY against
 * the pre-flight record instead of re-deriving the roots at execution time.
 * A `refused` verdict carries no roots: nothing may execute behind it.
 */
export async function preflightTrashPaths(
  paths: readonly string[],
  context: TrashPreflightContext,
): Promise<TrashPreflightVerdict> {
  // D-208: the verdicts compare realpath RESOLUTIONS — give them the string
  // roots plus their canonical aliases so an 8.3 short-name / reparse-point
  // root form does not refuse legitimate files.
  const verificationRoots = await canonicalContainmentRoots(context.roots, context.realpath);
  const missingPaths: string[] = [];
  let refusedReason: string | null = null;
  let refusedCount = 0;
  for (const path of paths) {
    const entry = await preflightOnePath(path, context, verificationRoots);
    if (entry.kind === 'refused') {
      refusedReason ??= entry.reason;
      refusedCount += 1;
    } else if (entry.kind === 'missing') {
      missingPaths.push(path);
    }
  }
  if (refusedReason !== null) {
    return { kind: 'refused', reason: refusedReason, refusedCount };
  }
  return { kind: 'ok', missingPaths, verificationRoots };
}

/**
 * Idempotent local-file cleanup:
 *  - exists        -> move to the Recycle Bin (`trashed`)
 *  - ENOENT        -> already cleaned (`missing`); NOT a failure
 *  - stat/trash error other than not-found -> `error` + the real reason
 *
 * No path is ever unlinked. Deletions stay inside the OS recycle bin, and the
 * caller decides whether a record may be dropped — never this adapter.
 *
 * D-203 · symlink / junction guard: a symbolic link (on Windows an NTFS
 * junction is indistinguishable from one under `lstat`) cannot prove WHERE its
 * target lives. The link's own path may sit inside a trusted root while the
 * target is any external file, so the DESTRUCTIVE call must never follow it:
 * every entry is `lstat`-ed before `trashItem` and a link is refused with an
 * `error` outcome. The refusal applies even when the link itself is inside a
 * trusted root — "we cannot prove the target is internal" is enough. A dangling
 * entry (lstat fails) is left to the `stat` probe below, which keeps the
 * ENOENT -> `missing` idempotency contract byte-for-byte unchanged.
 *
 * D-207 · the port now also carries the `preflight` pre-flight gate described
 * above: the M5 withFiles branch runs it over the WHOLE batch BEFORE `trash()`
 * and refuses the batch when any path cannot be proven to belong to the task.
 *
 * D-207 backstop · executor-side re-validation: the pre-flight and `trash()`
 * are two separate calls, so a local attacker with write access to an output
 * directory still has a window BETWEEN them to swap a recorded path (or one of
 * its middle components) for a junction pointing outside the roots —
 * `shell.trashItem` follows reparse points and would bin the EXTERNAL target.
 * When the caller passes `roots`, `trash()` therefore re-resolves every entry
 * through `realpath` IMMEDIATELY before its `trashItem` call (after the per-
 * entry lstat guard and the stat probe) and re-runs containment on the
 * RESOLVED path with the same `canonicalContainmentRoots` aliases the
 * pre-flight uses. Decision tree per entry (fail-closed):
 *   - resolves outside the roots          -> `error`（回收前复检）, NO trashItem;
 *   - realpath throws ENOENT/ENOTDIR      -> the existing `missing` idempotent
 *     semantics (the entry vanished after the stat probe said "present" —
 *     exactly what `trashItem` itself would have classified as `missing`);
 *   - realpath throws anything else       -> `error` with the real errno
 *     (same wording as the pre-flight), NO trashItem;
 *   - `roots` is an empty array           -> refuse (a verdict that compares
 *     against NO roots cannot prove ownership — `isPathInsideRoots` fails OPEN
 *     on empty roots by design, so the empty case must never reach it);
 *   - `roots` omitted (undefined)         -> behaviour byte-for-byte unchanged
 *     (lstat + stat + trashItem), legacy callers keep their contract.
 *
 * This narrows the race from "any time between the pre-flight and the recycle
 * bin" to "between this realpath and `trashItem`" — two adjacent path-level
 * calls. It cannot reach zero at the kernel level (see the residual-window
 * note below); the acceptance criterion it implements is the D-203/D-207 one:
 * a file that cannot be PROVEN to belong to the current task is never deleted.
 *
 * D-221 re-audit · root binding (optional third parameter
 * `expectedCanonicalRoots`): the check above still re-derives the canonical
 * roots from the `roots` argument AT EXECUTION TIME, so a root directory
 * itself swapped between the pre-flight and `trash()` (e.g. replaced by a
 * junction pointing elsewhere) would be re-judged under its NEW identity —
 * trust-baseline drift. When the caller passes the pre-flight verdict's
 * `verificationRoots` here, `trash()` first verifies that baseline (see
 * `verifyBoundRootIdentity`: the canonical roots are re-derived from the same
 * string roots and must reproduce the recorded list — a swapped / dangling /
 * unreadable confirmed root refuses the WHOLE batch with every entry `error`
 * and zero `trashItem` calls); the per-entry re-validation then judges
 * against these pre-flight-confirmed roots instead of re-derived ones.
 * Omitted (undefined) → the legacy re-derive-at-execution behaviour above,
 * byte-for-byte unchanged.
 */
/**
 * D-221 re-audit · root identity re-verification (the trust-baseline half of
 * the executor backstop). `expectedCanonicalRoots` is the pre-flight verdict's
 * `verificationRoots` passed back verbatim — the canonical root list the
 * verdict was judged against. `roots` is the same string-root list the caller
 * gave the pre-flight (both wired callers pass it to both calls).
 *
 * The naive "re-realpath every recorded entry" cannot distinguish a root that
 * was CONFIRMED by realpath at pre-flight and has since been swapped / deleted
 * from a root that NEVER resolved at pre-flight: `canonicalContainmentRoots`
 * keeps the string form of an unresolvable root as comparison-only evidence
 * (a request's `tempDir` legitimately may not exist on disk yet — it is still
 * a judging root). Requiring the latter to resolve would refuse every
 * legitimate batch whose record names a not-yet-created directory. The check
 * therefore re-derives EXACTLY what the pre-flight derived — same primitive,
 * same string roots — and compares it against the recorded baseline:
 *
 *   - any RE-DERIVED entry the pre-flight never recorded -> the baseline moved:
 *     a root swapped identity (e.g. replaced by a junction pointing elsewhere)
 *     -> refuse (identity). Post-fix review precision note: only a NEWLY
 *     derived entry whose normalized identity differs from the baseline refuses
 *     here; a same-identity benign creation (e.g. the tempDir being mkdir-ed
 *     between pre-flight and trash) re-derives to an already-recorded string
 *     form and does NOT refuse.
 *   - a RECORDED entry the re-derivation can no longer produce -> only a
 *     confirmed realpath ALIAS can go missing (string forms always re-derive):
 *     the root that used to resolve to it is gone / dangling / unreadable.
 *     Diagnosed at the recorded form itself:
 *       ENOENT / ENOTDIR -> refuse (D-203: an unresolvable confirmed root can
 *       prove ownership of nothing beneath it — never "missing");
 *       anything else (EACCES / ELOOP / …) -> refuse, fail-closed;
 *       resolves but the alias still no longer derives -> the root moved away
 *       while the old target persists -> refuse (identity).
 *   - everything re-derives -> the trust baseline is intact; the per-entry
 *     re-validation judges against the RECORDED list, not the re-derived one.
 *
 * Comparison is by `normalizedForContainment` (D-208: an 8.3 short-name root
 * resolving to its long-form alias is the SAME directory, not drift).
 *
 * `roots` omitted (undefined — no wired caller does this): nothing to
 * re-derive from, so every recorded form is treated as pre-flight-confirmed
 * and re-checked strictly (ENOENT refuses). Defensive fail-closed corner.
 *
 * Returns the refusal reason for the WHOLE batch, or `null` when the recorded
 * baseline still reproduces exactly.
 */
const ROOT_IDENTITY_CHANGED_REASON = '回收前复检发现输出根目录身份已变化，已拒绝移入回收站';
const ROOT_GONE_REASON = '回收前复检发现输出根目录已消失或悬空（无法解析真实路径），已拒绝移入回收站';

function rootUnresolvableReason(error: unknown): string {
  return `回收前复检无法解析输出根目录真实路径（${errnoDetail(error)}），已拒绝移入回收站`;
}

async function verifyBoundRootIdentity(
  expectedCanonicalRoots: readonly string[],
  roots: readonly string[] | undefined,
  realpath: (path: string) => Promise<string>,
): Promise<string | null> {
  const recorded = new Set<string>();
  for (const root of expectedCanonicalRoots) {
    const normalized = normalizedForContainment(root);
    if (normalized !== null) recorded.add(normalized);
  }
  if (roots === undefined) {
    // Defensive corner: no string roots to re-derive from — strict per-form.
    for (const root of expectedCanonicalRoots) {
      let real: string;
      try {
        real = await realpath(root);
      } catch (error) {
        const code = errnoOf(error);
        return code === 'ENOENT' || code === 'ENOTDIR' ? ROOT_GONE_REASON : rootUnresolvableReason(error);
      }
      const normalizedReal = normalizedForContainment(real);
      if (normalizedReal === null || !recorded.has(normalizedReal)) {
        return ROOT_IDENTITY_CHANGED_REASON;
      }
    }
    return null;
  }
  // One canonical-alias re-derivation per BATCH (the same call shape the
  // unbound legacy path makes — no extra primitive per entry).
  const derived = await canonicalContainmentRoots(roots, realpath);
  const derivedSet = new Set<string>();
  for (const entry of derived) {
    const normalized = normalizedForContainment(entry);
    if (normalized === null || !recorded.has(normalized)) {
      // A resolution the pre-flight never confirmed: never judge containment
      // under the NEW identity — refuse the whole batch instead.
      return ROOT_IDENTITY_CHANGED_REASON;
    }
    derivedSet.add(normalized);
  }
  for (const root of expectedCanonicalRoots) {
    const normalized = normalizedForContainment(root);
    if (normalized === null || derivedSet.has(normalized)) continue;
    // A recorded form the re-derivation can no longer produce — a confirmed
    // alias whose root stopped resolving to it. Diagnose at the recorded form.
    try {
      await realpath(root);
    } catch (error) {
      const code = errnoOf(error);
      return code === 'ENOENT' || code === 'ENOTDIR' ? ROOT_GONE_REASON : rootUnresolvableReason(error);
    }
    // The recorded form itself still resolves, but the root that used to
    // resolve to it no longer does — the resolution target moved.
    return ROOT_IDENTITY_CHANGED_REASON;
  }
  return null;
}

export function createTrashFilesPort(
  trashItem: (path: string) => Promise<void>,
  stat: (path: string) => Promise<StatOutcome> = nodeStat,
  // Injected for the unit tests of the re-validation itself; production uses
  // the real `fs.realpath` (same primitive the pre-flight gate resolves with).
  realpath: (path: string) => Promise<string> = (path: string) => fs.realpath(path),
): TrashFilesPort {
  return {
    preflight: (paths: readonly string[], roots: readonly string[]): Promise<TrashPreflightVerdict> =>
      preflightTrashPaths(paths, {
        roots,
        realpath: (path: string) => fs.realpath(path),
        lstat: (path: string) => fs.lstat(path),
      }),
    async trash(
      paths: readonly string[],
      roots?: readonly string[],
      expectedCanonicalRoots?: readonly string[],
    ): Promise<readonly TrashFileOutcome[]> {
      // D-221 re-audit · root binding (third parameter): when the caller hands
      // back the pre-flight's `verificationRoots`, verify the IDENTITY of every
      // bound root FIRST — a root swapped / gone / unresolvable since the
      // pre-flight refuses the WHOLE batch before a single `trashItem` call.
      // The per-entry re-validation below then judges against these
      // pre-flight-confirmed roots, NOT against roots re-derived here.
      if (expectedCanonicalRoots !== undefined) {
        const rootRefusal = await verifyBoundRootIdentity(expectedCanonicalRoots, roots, realpath);
        if (rootRefusal !== null) {
          return paths.map((path) => ({ path, status: 'error' as const, reason: rootRefusal }));
        }
      }
      // One canonical-alias resolution per BATCH (not per entry): the verdicts
      // compare realpath resolutions against the same D-208 alias list the
      // pre-flight uses, so an 8.3 short-name / reparse-point root form never
      // refuses a legitimate file. With a bound root list the re-derivation is
      // SKIPPED on purpose — the pre-flight's confirmed roots are the trust
      // baseline; re-deriving them here would judge under whatever identity
      // the root directory has NOW.
      const verificationRoots = expectedCanonicalRoots !== undefined
        ? expectedCanonicalRoots
        : roots === undefined
          ? undefined
          : await canonicalContainmentRoots(roots, realpath);
      const outcomes: TrashFileOutcome[] = [];
      for (const path of paths) {
        // D-203: refuse links BEFORE any destructive action. This runs ahead of
        // the `stat` probe on purpose — a junction `stat`s as its TARGET (often
        // a directory), which would misreport the reason and, for a link to a
        // file, would otherwise sail through to `trashItem`. Only an lstat
        // failure falls through: an absent entry is the probe's ENOENT business.
        try {
          if ((await fs.lstat(path)).isSymbolicLink()) {
            outcomes.push({ path, status: 'error', reason: '符号链接/联接无法验证归属，已拒绝移入回收站' });
            continue;
          }
        } catch {
          // Absent or unreadable for lstat: the stat probe below decides.
        }
        const probe = await stat(path);
        if (probe.kind === 'error') {
          if (probe.code === 'ENOENT' || probe.code === 'ENOTDIR') {
            outcomes.push({ path, status: 'missing' });
          } else {
            outcomes.push({ path, status: 'error', reason: `无法访问本地文件（${probe.code ?? 'UNKNOWN'}）` });
          }
          continue;
        }
        if (probe.kind !== 'file') {
          outcomes.push({ path, status: 'error', reason: '记录的产物路径不是文件' });
          continue;
        }
        // D-207 backstop · executor-side re-validation, immediately before the
        // destructive call. The pre-flight already ran in the caller, but the
        // two calls are separated in time: this re-check is what closes the
        // swap-in window down to the irreducible realpath→trashItem gap.
        if (verificationRoots !== undefined) {
          if (verificationRoots.length === 0) {
            // Fail closed: with NO roots to compare against, ownership cannot
            // be proven (`isPathInsideRoots` fails OPEN on empty roots by
            // design — the empty case must never be allowed to reach it).
            outcomes.push({
              path, status: 'error',
              reason: '无法验证产物文件归属（回收前复检缺少可用的输出根目录），已拒绝移入回收站',
            });
            continue;
          }
          let real: string;
          try {
            real = await realpath(path);
          } catch (error) {
            const code = errnoOf(error);
            if (code === 'ENOENT' || code === 'ENOTDIR') {
              // Vanished between the stat probe and here — the same situation
              // `trashItem` itself classifies as `missing` (existing D-120
              // idempotency). One outcome per path, never a double report.
              outcomes.push({ path, status: 'missing' });
              continue;
            }
            // EACCES / EPERM / ELOOP / …: fail closed with the real errno —
            // same wording as the pre-flight's unresolvable-real-path refusal.
            outcomes.push({
              path, status: 'error',
              reason: `无法解析产物真实路径（${errnoDetail(error)}），无法证明产物归属，已拒绝回收`,
            });
            continue;
          }
          if (!isPathInsideRoots(real, verificationRoots)) {
            // The string sat inside the roots, its FINAL resolution does not:
            // a middle component was (or became) a reparse point. The external
            // target must never enter the bin under this record's name.
            outcomes.push({
              path, status: 'error',
              reason: '产物真实路径指向任务输出目录之外（回收前复检）',
            });
            continue;
          }
        }
        // Residual window (honest note): `realpath` and `trashItem` are still
        // two separate path-level calls — an attacker who wins the race
        // BETWEEN them can still swap the path. Zeroing that requires
        // opening the target by handle and unlink-by-handle OS semantics,
        // which `shell.trashItem` (Electron) does not expose. This backstop
        // reduces the exploitability from "any moment after the pre-flight"
        // to "the microseconds between two adjacent syscalls", which is the
        // accepted, registered residual risk (AI-MAINTENANCE §10). The bound
        // roots above close a DIFFERENT gap — trust-baseline drift (the
        // executor judging by roots re-derived from a root directory whose
        // identity changed after the pre-flight confirmed them); they do NOT
        // change this remaining realpath→trashItem window, which stays as
        // registered.
        try {
          await trashItem(path);
          outcomes.push({ path, status: 'trashed' });
        } catch (error) {
          const kind = classifyTrashError(error);
          outcomes.push(kind === 'missing'
            ? { path, status: 'missing' }
            : { path, status: 'error', reason: reasonOf(error) });
        }
      }
      return outcomes;
    },
  };
}
