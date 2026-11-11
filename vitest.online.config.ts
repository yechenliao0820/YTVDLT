/**
 * Online (live-network) audit configuration — deliberately SEPARATE from
 * `vitest.config.ts`.
 *
 * Why: the default suite must stay runnable offline (CI / 干净机 / 代理不可用).
 * Any test under `tests/integration/online/` performs real international
 * traffic and real downloads, so it must be opted into explicitly:
 *
 *   npx vitest run --config vitest.online.config.ts
 *
 * No coverage reporter: the app-side safe-delete shim rejects the bulk delete
 * of `coverage/`, and coverage is irrelevant to a live functional audit.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@ytvdlt/shared': pkg('shared'),
      '@ytvdlt/core': pkg('core'),
      '@ytvdlt/engine-ytdlp': pkg('engine-ytdlp'),
    },
  },
  test: {
    include: ['tests/integration/online/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    environment: 'node',
    // Real YouTube downloads of 13–22 minute episodes need headroom.
    testTimeout: 900_000,
    hookTimeout: 120_000,
    reporters: ['default'],
    // One file, one worker: the audit is I/O heavy and order does not matter.
    fileParallelism: false,
  },
});
