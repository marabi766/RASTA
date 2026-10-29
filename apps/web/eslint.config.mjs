import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
// The services' rule itself, not a copy: zod 4's `.default()` skips parsing;
// `.prefault()` is zod 3's (GHSA-mrhx-c7xc-m3w5, PR #444 r1 F2).
import noZodDefault from '../../scripts/no-zod-default-rule.mjs';
// Also the services' rule, not a copy: a module that sends a bearer token,
// cookie, API key or secret/grant form field must send it through
// credentialFetch, which refuses redirects (Q-155).
import credentialTransport from '../../scripts/internal-token-transport-rule.mjs';
// And the transport boundary: no raw HTTP primitive outside the audited
// transports, however it is reached (Q-155 Follow-up 1).
import rawHttpBoundary from '../../scripts/raw-http-boundary-rule.mjs';

const internal = { rules: { transport: credentialTransport, 'raw-http': rawHttpBoundary } };

/**
 * The portal's lint rules.
 *
 * `jsx-a11y` is not advisory here. docs/16 § 16.9 commits this product to
 * WCAG 2.1 AA, and an accessibility rule that only warns is a rule that ships
 * broken markup — so the recommended set is raised to `error`.
 */
export default tseslint.config(
  { ignores: ['.next/**', 'coverage/**', 'next-env.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Jest's own plumbing is CommonJS and lives under `src` so that it is
    // linted rather than parked outside the tree to dodge the rules. Flat
    // config assumes ES modules, so these files declare what they actually are.
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
  },
  {
    plugins: { zod: { rules: { 'no-default': noZodDefault } } },
    rules: { 'zod/no-default': 'error' },
  },
  {
    // Production source only, as in the services: specs and test helpers
    // build credential sentinels against local fakes.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['**/*.spec.{ts,tsx}', 'src/test/**'],
    plugins: { internal },
    rules: { 'internal/transport': 'error', 'internal/raw-http': 'error' },
  },
  {
    // The browser suite's helpers and specs send real credentials (the
    // Keycloak admin password, password grants, bearers) and signed storage
    // URLs: all of them, specs included, go through guardedFetch or the
    // request fixture that e2e/expect.ts guards (PR #492 r1 F2).
    files: ['e2e/**/*.ts'],
    plugins: { internal },
    rules: {
      'internal/transport': 'error',
      'internal/raw-http': ['error', { playwright: true }],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'jsx-a11y': jsxA11y, 'react-hooks': reactHooks },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...Object.fromEntries(
        Object.keys(jsxA11y.configs.recommended.rules).map((rule) => [rule, 'error']),
      ),
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // AGENTS.md § 3: no `console.log`. The portal has no structured logger of
      // its own yet, so the browser console is allowed only for real failures.
      'no-console': ['error', { allow: ['error'] }],
      '@typescript-eslint/no-explicit-any': 'error',
      // The services' rule, restated (importing the root config here would load
      // typescript-eslint from two roots): only `env.ts` may use `z.coerce`.
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='z'][property.name='coerce']",
          message:
            'z.coerce converts unchecked input (a TypeError is a 500). Use numberInput from @rasta/contracts.',
        },
        {
          selector:
            "ImportDeclaration[source.value=/^zod/] ImportSpecifier[imported.name='coerce']",
          message:
            'z.coerce converts unchecked input (a TypeError is a 500). Use numberInput from @rasta/contracts.',
        },
      ],
    },
  },
  {
    files: ['**/env.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
