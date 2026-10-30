import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/coverage/**', '**/next-env.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@aptamind/*/src/*'],
              message: 'Import packages through their public entry points.',
            },
          ],
        },
      ],
    },
  },
  {
    // Architecture boundary: the generic workflow runtime must not depend on a domain (Market, Professional).
    files: [
      'packages/workflows/**/*.ts',
      'packages/workflow-sdk/**/*.ts',
      'packages/workflow-nodes/**/*.ts',
      'packages/db/**/*.ts',
      'packages/queue/**/*.ts',
      'packages/storage/**/*.ts',
      'packages/ai/**/*.ts',
      'packages/net/**/*.ts',
      'packages/observability/**/*.ts',
      'packages/provenance/**/*.ts',
      'packages/contracts/**/*.ts',
      'packages/config/**/*.ts',
      'packages/taxonomy/**/*.ts',
      'packages/testing/**/*.ts',
    ],
    rules: {
      // Repeats the deep-import pattern: in flat config a later block replaces the rule.
      // Package-level layering is also enforced by scripts/check-architecture.ts.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@aptamind/*/src/*'],
              message: 'Import packages through their public entry points.',
            },
            {
              group: ['@aptamind/market', '@aptamind/market/*'],
              message: 'Shared packages must not depend on the Market domain.',
            },
            {
              group: ['@aptamind/professional', '@aptamind/professional/*'],
              message: 'Shared packages must not depend on the Professional domain.',
            },
          ],
        },
      ],
    },
  },
  {
    // Domains never import each other (ADR-0020; also enforced by scripts/check-architecture.ts).
    files: ['packages/professional/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@aptamind/*/src/*'],
              message: 'Import packages through their public entry points.',
            },
            {
              group: ['@aptamind/market', '@aptamind/market/*'],
              message:
                'Professional must not depend on the Market domain; share concepts via taxonomy/provenance.',
            },
          ],
        },
      ],
    },
  },
  {
    // The admin UI talks to the internal API only; it must never touch persistence directly.
    files: ['apps/admin/**/*.ts', 'apps/admin/**/*.tsx'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@aptamind/db', '@aptamind/queue', '@aptamind/storage', 'mongodb', 'bullmq', 'ioredis'],
              message: 'Admin must use the internal API, not persistence or queue packages.',
            },
          ],
        },
      ],
    },
  },
  {
    // Design-system primitives are domain-free (docs/design/admin-design-system.md §11): no API
    // client, server actions, API/domain types, workspace packages or record/legacy components.
    files: ['apps/admin/components/ui/**/*.ts', 'apps/admin/components/ui/**/*.tsx'],
    rules: {
      // Repeats the admin block's persistence patterns: in flat config a later block replaces the rule.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@aptamind/*', 'mongodb', 'bullmq', 'ioredis'],
              message: 'UI primitives must not import workspace packages, persistence or queues.',
            },
            {
              group: ['@/lib/*', '@/lib/**', '!@/lib/format'],
              message:
                'UI primitives are domain-free: only pure helpers (@/lib/format) may be imported; pass data in as props.',
            },
            {
              group: ['..', '../*', '../**'],
              message:
                'UI primitives may not reach outside components/ui with relative imports; use `@/` aliases.',
            },
            {
              group: ['@/app/**', '@/components/**', '!@/components/ui', '!@/components/ui/**'],
              message: 'UI primitives may only import other primitives (components/ui) and pure helpers.',
            },
          ],
        },
      ],
    },
  },
);
