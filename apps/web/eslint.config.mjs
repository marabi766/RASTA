import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/** The services' rule, restated: zod 4's `.default()` skips parsing; `.prefault()` is zod 3's. */
const NO_ZOD_DEFAULT = {
  selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='default']",
  message: "zod 4's .default() skips parsing the value; use .prefault() (zod 3's .default()).",
};

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
        NO_ZOD_DEFAULT,
      ],
    },
  },
  {
    files: ['**/env.ts'],
    rules: { 'no-restricted-syntax': ['error', NO_ZOD_DEFAULT] },
  },
);
