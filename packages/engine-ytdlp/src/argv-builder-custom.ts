/**
 * buildCustomDownload — argv for a user command template (M4-5).
 *
 * Security model (two independent layers):
 *   1. `validateTemplateArgs()` — positive allowlist + per-option grammar; the
 *      `--` separator and every known-dangerous option are impossible;
 *   2. `assertNoForbiddenOptions()` — defence in depth over the final argv,
 *      which also contains the fixed compliance prefix/suffix.
 *
 * The URL is the ONLY token after `--`, and the engine path never enters argv.
 */
import type { AppError } from '@ytvdlt/shared';
import { validateTemplateArgs, customCommandRejected } from '@ytvdlt/core';
import { assertHttpUrl } from './argv-builder.js';
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
