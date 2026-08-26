import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Root ESLint flat config for the Rasta monorepo.
 * Individual workspaces extend this via their own eslint.config.mjs.
 */
export default tseslint.config(
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
    /**
     * NestJS resolves constructor dependencies from `emitDecoratorMetadata`,
     * which only records a *value* import. Rewriting an injected dependency to
     * `import type` erases that metadata and the class silently fails to
     * resolve at runtime — a bug the type checker cannot see.
     *
     * The rule is therefore off wherever DI is used. It stays on for pure
     * libraries, where it is a genuine improvement.
     */
    // Globs are basePath-relative, and each workspace runs eslint from its own
    // directory, so these must not be anchored to the repository root.
    files: [
      '**/guards/**/*.ts',
      '**/interceptors/**/*.ts',
      '**/filters/**/*.ts',
      '**/middleware/**/*.ts',
      '**/pipes/**/*.ts',
      '**/*.controller.ts',
      '**/*.service.ts',
      '**/*.repository.ts',
      '**/*.module.ts',
      '**/*.consumer.ts',
      '**/*.resolver.ts',
    ],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
