/**
 * buildCustomDownload — argv for a user command template (M4-5).
 *
 * Security model (three independent layers):
 *   0. `CONFIG_ISOLATION_FLAGS` (D-245) — the user template is EXPLICIT user
 *      input, but the default config/plugin loading it would otherwise inherit
 *      is not: the flags stay the first two elements so user- / portable-dir
 *      config files and plugin directories are never loaded, for every
 *      template. An explicit `--config-locations` cannot appear either — it is
 *      denied by `validateTemplateArgs()` (core) and forbidden again by layer 2.
 *   1. `validateTemplateArgs()` — positive allowlist + per-option grammar; the
 *      `--` separator and every known-dangerous option are impossible;
 *   2. `assertNoForbiddenOptions()` — defence in depth over the final argv,
 *      which also contains the fixed compliance prefix/suffix.
 *
 * The URL is the ONLY token after `--`, and the engine path never enters argv.
 */
import type { AppError } from '@ytvdlt/shared';
import { validateTemplateArgs, customCommandRejected } from '@ytvdlt/core';
import { assertHttpUrl, CONFIG_ISOLATION_FLAGS } from './argv-builder.js';
import { assertNoForbiddenOptions } from './argv-compliance.js';
import { YTVDLT_PROGRESS_TEMPLATE, PROGRESS_DELTA_SECONDS } from './progress-template.js';

export interface CustomCommandContext {
  jsRuntimePath: string;
  ffmpegDir: string;
  artifactManifestPath: string;
}

export function buildCustomDownload(
  args: readonly string[],
  url: string,
  ctx: CustomCommandContext,
): string[] {
  const validation = validateTemplateArgs(args);
  if (!validation.ok) throw customCommandRejected(validation.reason) as AppError;
  assertHttpUrl(url);

  const argv: string[] = [
    // D-245: isolation prefix first, in front of the user's own arguments too.
    ...CONFIG_ISOLATION_FLAGS,
    '--no-warnings',
    '--newline',
    '--no-js-runtimes',
    '--js-runtimes', `node:${ctx.jsRuntimePath}`,
    '--ffmpeg-location', ctx.ffmpegDir,
    ...args,
    '--progress-template', YTVDLT_PROGRESS_TEMPLATE,
    '--progress-delta', PROGRESS_DELTA_SECONDS,
    '--print-to-file', 'after_move:%(filepath)q', ctx.artifactManifestPath,
    '--', url,
  ];

  assertNoForbiddenOptions(argv);
  return argv;
}

export const ArgvBuilderCustom = { buildCustomDownload } as const;
