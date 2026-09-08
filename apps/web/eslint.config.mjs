import base from '../../eslint.config.mjs';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Lint rules for the user portal.
 *
 * Everything the monorepo enforces, plus the two things a browser workspace
 * adds: accessibility, which docs/16 § 16.9 makes an acceptance criterion
 * rather than a nicety, and the physical-direction ban ADR-003 lists under
 * Compliance — «قاعده Lint: منع کلاس‌های فیزیکی چپ و راست به نفع Logical
 * Property».
 *
 * The direction rules are syntactic rather than a review convention on
 * purpose. A `margin-left` in an RTL layout is not a style disagreement; it is
 * a component that renders correctly in exactly one of the two directions this
 * application ships in, and reviewers do not reliably catch it.
 */

/** Physical CSS properties that have a logical counterpart. */
const PHYSICAL_STYLE_PROPERTIES = [
  'marginLeft',
  'marginRight',
  'paddingLeft',
  'paddingRight',
  'borderLeft',
  'borderRight',
  'borderLeftWidth',
  'borderRightWidth',
  'borderLeftColor',
  'borderRightColor',
  'borderLeftStyle',
  'borderRightStyle',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomLeftRadius',
  'borderBottomRightRadius',
  'left',
  'right',
];

const LOGICAL_HINT =
  'Use the logical property instead (marginInlineStart, paddingInlineEnd, insetInlineStart, ' +
  'text-start …). Physical left/right does not mirror in RTL — ADR-003 Compliance, docs/16 § 16.3.';

/** Tailwind utilities whose physical variants do not mirror under `dir="rtl"`. */
const PHYSICAL_CLASS_PATTERN =
  '(^|[\\\\s:])-?(ml|mr|pl|pr|border-l|border-r|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br|left|right)-|(^|[\\\\s:])text-(left|right)(\\\\s|$)';

export default [
  ...base,
  jsxA11y.flatConfigs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Two of the plugin's newer compiler-preview rules are turned off, with
      // the reason stated rather than left as a mystery:
      //
      // `set-state-in-effect` flags the synchronous `setState` that resets a
      // view to "loading" at the top of an effect that then subscribes to an
      // external system — the OIDC user manager, an in-flight `fetch`. That is
      // one extra render on a transition the user is already waiting through,
      // and the alternative (deriving the reset during render) would leave a
      // stale tenant's data on screen while the next one loads.
      //
      // `refs` flags a ref read inside a closure that the surrounding
      // `useMemo` only *builds*. `ApiClient`'s session reader runs at request
      // time, never during render; reading the token during render is exactly
      // what it is written to avoid, so the diagnostic is inverted here.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: `Property[key.name=/^(${PHYSICAL_STYLE_PROPERTIES.join('|')})$/]`,
          message: `Physical direction style property. ${LOGICAL_HINT}`,
        },
        {
          selector: `JSXAttribute[name.name="className"] Literal[value=/${PHYSICAL_CLASS_PATTERN}/]`,
          message: `Physical direction utility class. ${LOGICAL_HINT}`,
        },
        {
          selector: `JSXAttribute[name.name="className"] TemplateElement[value.raw=/${PHYSICAL_CLASS_PATTERN}/]`,
          message: `Physical direction utility class. ${LOGICAL_HINT}`,
        },
        {
          // docs/16 § 16.11: nothing in a browser bundle may read a secret, and
          // a public OIDC client has none to read (ADR-008).
          selector:
            'MemberExpression[object.property.name="env"] > Identifier[name=/SECRET|PASSWORD|PRIVATE_KEY/]',
          message:
            'A browser bundle must never read a secret. Public clients use Authorization Code + PKCE (ADR-008).',
        },
        {
          selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
          message: 'Forbidden by docs/16 § 16.11.',
        },
      ],
    },
  },
  {
    // Tests may name physical properties in order to prove production code does
    // not use them.
    files: ['**/*.spec.ts', '**/*.spec.tsx', 'src/test/**/*.{ts,tsx}', 'e2e/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // The root config already exempts `*.spec.ts` from this; it predates
      // `.tsx` tests existing anywhere in the repository.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
];
