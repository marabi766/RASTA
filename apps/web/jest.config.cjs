/**
 * The portal's jest configuration.
 *
 * It does **not** reuse the repository's shared `jest.swc.cjs`. That file
 * parses `syntax: 'typescript'` without `tsx`, and turns on the legacy
 * decorator transform so Nest can read `design:paramtypes`. A React component
 * file needs the opposite of the first and has no use for the second, so the
 * options are written out here rather than bent into a shape that serves
 * neither. The one thing deliberately kept identical is the ES2023 target.
 *
 * `jsx: 'automatic'` means components do not import React to use JSX, which is
 * how the App Router expects them to be written.
 */
const swcOptions = {
  jsc: {
    target: 'es2023',
    parser: { syntax: 'typescript', tsx: true, dynamicImport: true },
    transform: { react: { runtime: 'automatic' } },
  },
};

/** @type {import('jest').Config} */
module.exports = {
  displayName: 'web',
  rootDir: __dirname,
  roots: ['<rootDir>/src'],
  // A browser bundle is tested in a browser-shaped environment. `node` would
  // let a component that touches `document` pass here and fail in a browser.
  testEnvironment: 'jsdom',
  testRegex: '.*\\.spec\\.tsx?$',
  transform: { '^.+\\.(t|j)sx?$': ['@swc/jest', swcOptions] },
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // Jest cannot parse CSS. Components are asserted on behaviour and
    // accessibility, never on the stylesheet, so the import is satisfied with
    // an empty module. `design-tokens.spec.ts` reads the file as text instead,
    // because the rules it checks are properties of the stylesheet itself.
    '\\.css$': '<rootDir>/src/test/style-stub.cjs',
    // Resolved at build time by the Next compiler, which does not run here.
    '^next/font/(?:google|local)$': '<rootDir>/src/test/next-font-stub.cjs',
  },
  clearMocks: true,
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.spec.{ts,tsx}', '!src/test/**'],
};
