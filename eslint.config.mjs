import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Root ESLint flat config for the Rasta monorepo.
 *
 * Workspaces re-export from here rather than redefining rules, so a rule
 * change lands everywhere at once. Two variants are exported: the default for
 * plain TypeScript, and `nestjs` for workspaces using dependency injection.
 */
const base = tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/src/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // `any` is a documented escape hatch, not a default. Justify each use.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'warn',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // A service must never reach into another service's source tree.
              group: ['**/services/*/src/**'],
              message:
                'Cross-service imports are forbidden. Communicate over REST or Kafka events, and share only via @rasta/* packages.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', '**/*.int-spec.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);

export default base;

/**
 * Config for workspaces that use NestJS dependency injection.
 *
 * `consistent-type-imports` and Nest DI are in direct conflict. Nest resolves
 * constructor dependencies from the `design:paramtypes` metadata TypeScript
 * emits, so a parameter's type annotation is simultaneously its injection
 * token. Rewriting those imports to `import type` elides the binding and DI
 * silently resolves to `undefined` at runtime — the exact failure that took a
 * debugging session to find when tsx (esbuild) dropped the same metadata.
 *
 * A linter should not be able to introduce a runtime failure, so the rule is
 * off wherever DI is in play. It stays on in `packages/`, which have none.
 */
export const nestjs = [
  ...base,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
];
