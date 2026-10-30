import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**', '**/.next/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: [
            'packages/**/src/**/*.int.test.ts',
            'apps/**/src/**/*.int.test.ts',
            'apps/admin/lib/api-server/**/*.int.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/.next/**'],
          environment: 'node',
          testTimeout: 90_000,
          hookTimeout: 90_000,
          fileParallelism: false,
          setupFiles: ['./test/integration-setup.ts'],
        },
      },
      {
        // Admin UI (Next.js): pure helpers run in `node`; component tests opt into DOM with a
        // `// @vitest-environment happy-dom` docblock. Browser e2e lives in `pnpm test:admin-e2e`.
        resolve: {
          alias: [{ find: /^@\//, replacement: fileURLToPath(new URL('./apps/admin/', import.meta.url)) }],
        },
        test: {
          name: 'admin',
          include: ['apps/admin/**/*.test.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/.next/**', '**/*.int.test.*', 'apps/admin/e2e/**'],
          environment: 'node',
        },
      },
    ],
  },
});
