import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import internalTokenTransport from './scripts/internal-token-transport-rule.mjs';
import rawHttpBoundary from './scripts/raw-http-boundary-rule.mjs';
import noZodDefault from './scripts/no-zod-default-rule.mjs';

/**
 * The transport rules, one plugin object for every block that turns them on
 * (flat config refuses a plugin name defined twice with different objects).
 */
export const internalPlugin = {
  rules: { transport: internalTokenTransport, 'raw-http': rawHttpBoundary },
};

const NO_ZOD_COERCE = [
  {
    selector: "MemberExpression[object.name='z'][property.name='coerce']",
    message:
      'z.coerce converts unchecked input (a TypeError is a 500). Use numberInput from @rasta/contracts.',
  },
  {
    selector: "ImportDeclaration[source.value=/^zod/] ImportSpecifier[imported.name='coerce']",
    message:
      'z.coerce converts unchecked input (a TypeError is a 500). Use numberInput from @rasta/contracts.',
  },
];

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
      // `z.coerce.*` converts whatever the client sent before any type check:
      // `Number({"toString":null})` throws, and a 400 becomes a 500. A request
      // schema takes `numberInput` from @rasta/contracts instead; `env.ts`,
      // whose input is `process.env` (only strings), is exempt below.
      'no-restricted-syntax': ['error', ...NO_ZOD_COERCE],
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
    // zod 4's `.default(value)` skips parsing `value`; `.prefault()` is zod 3's
    // `.default()` (GHSA-mrhx-c7xc-m3w5). Every route to the method is refused
    // — bracket, template, extraction, destructuring, call/apply/bind, Reflect
    // (PR #444 r1 F2); `apps/web/eslint.config.mjs` loads the same rule.
    plugins: { zod: { rules: { 'no-default': noZodDefault } } },
    rules: { 'zod/no-default': 'error' },
  },
  {
    // Root `scripts/` — CI checkers, verifiers and campaign tooling, plain Node
    // ESM run by `node scripts/x.mjs` or `node --test`. They are not services:
    // there is no bundler, no DOM, and no structured logger to reach for.
    //
    // Node globals are declared so `no-undef` still catches a real typo
    // instead of drowning in `process`/`Buffer`/`URL`.
    //
    // `no-console` exists to keep service output on the structured logger
    // (AGENTS.md § 3). A CLI's stdout/stderr *is* its interface — a checker
    // prints its verdict, CI captures it, a human reads it — so `log`, `info`,
    // `warn` and `error` are allowed here. `debug`, `trace`, `dir` and the rest
    // stay errors: they are leftovers, not output.
    files: ['scripts/**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-console': ['error', { allow: ['log', 'info', 'warn', 'error'] }],
    },
  },
  {
    // Workspaces re-export this config, so paths must match from their cwd too.
    files: [
      '**/src/**/*.{ts,js,mjs,cjs}',
      '**/dev/**/*.{ts,js,mjs,cjs}',
      '**/prisma/**/*.{ts,js,mjs,cjs}',
      'scripts/**/*.{js,mjs,cjs}',
    ],
    ignores: [
      '**/*.spec.ts',
      '**/*.test.ts',
      '**/*.test.mjs',
      '**/*.int-spec.ts',
      '**/*.e2e-spec.ts',
      '**/test/**',
      // Test-only helpers too: child-process fixtures and fakes, never deployed.
      '**/__tests__/**',
    ],
    plugins: { internal: internalPlugin },
    // Two layers (Q-155). `raw-http` is the boundary: outside the audited
    // transports (AUDITED_TRANSPORTS in the rule) no raw HTTP primitive at all,
    // however it is reached. `transport` is the second layer: a module that
    // spells a credential must name the redirect-refusing transport.
    rules: { 'internal/transport': 'error', 'internal/raw-http': 'error' },
  },
  {
    // Live suites aim at an endpoint the environment names (KEYCLOAK_URL), with
    // real credentials — an admin password grant, an admin bearer — so they get
    // the boundary too (PR #492 r2 F2): they send through guardedFetch, or
    // globalFetchStub when they replace the global (@rasta/testing).
    files: ['**/*.live-spec.ts'],
    plugins: { internal: internalPlugin },
    rules: { 'internal/raw-http': 'error' },
  },
  {
    // @rasta/config's URL reader is plain CommonJS so the scripts can import
    // it before any build (url-reader.js); Node's CommonJS globals apply.
    files: ['**/src/url-reader.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    // `env-issues.spec.ts` builds environment schemas as `env.ts` does, from
    // the same string-only `process.env` input, to test their refusal texts.
    files: ['**/env.ts', '**/env-issues.spec.ts'],
    rules: { 'no-restricted-syntax': 'off' },
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
