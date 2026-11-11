/**
 * vitest 配置（0.1.6 后重建）。
 *
 * 两个消费方决定了这里的字段，别随意删：
 *   - `scripts/acceptance.mjs` 读 `reports/vitest-results.json`（assertionCount / 失败清单）
 *   - `scripts/handoff-check.mjs` 读 `coverage/coverage-summary.json`（四维最低值）
 * 覆盖率四维门限 70：低于它 `npm test` 直接非零退出。
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  // Workspace packages are consumed as TypeScript sources (their package.json
  // points `main`/`types` at src/index.ts), so the test runner needs the same
  // aliases the bundler uses.
  resolve: {
    alias: {
      '@ytvdlt/shared': pkg('shared'),
      '@ytvdlt/core': pkg('core'),
      '@ytvdlt/engine-ytdlp': pkg('engine-ytdlp'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // `tests/integration/online/**` performs real international traffic and real
    // downloads. It must only run through `vitest.online.config.ts` on purpose;
    // the default suite stays offline and deterministic.
    exclude: ['**/node_modules/**', 'tests/e2e/**', 'tests/integration/online/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['default', ['json', { outputFile: 'reports/vitest-results.json' }]],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
      include: [
        'packages/shared/src/**/*.ts',
        'packages/core/src/**/*.ts',
        'packages/engine-ytdlp/src/**/*.ts',
        'apps/desktop/src/**/*.ts',
      ],
      exclude: ['**/*.d.ts', '**/node_modules/**'],
      thresholds: {
        lines: 70,
        branches: 70,
        functions: 70,
        statements: 70,
      },
    },
  },
});
