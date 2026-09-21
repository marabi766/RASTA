import { TextDecoder, TextEncoder } from 'node:util';
import '@testing-library/jest-dom';
import { toHaveNoViolations } from 'jest-axe';

/**
 * jsdom does not publish `TextEncoder` or `TextDecoder`, and every real
 * browser does.
 *
 * Without them, importing anything that touches `jose` — the portal's server
 * code, reached from a page under test — fails at module load with a
 * `ReferenceError` that names neither the page nor the library. The globals
 * are Node's own, so this narrows the gap between the test environment and
 * both runtimes rather than inventing a stand-in for either.
 */
Object.assign(globalThis, {
  TextEncoder: globalThis.TextEncoder ?? TextEncoder,
  TextDecoder: globalThis.TextDecoder ?? TextDecoder,
});

// docs/16 § 16.9 makes WCAG 2.1 AA a requirement rather than an aspiration.
// Registering the matcher globally means any suite can assert it without
// remembering to wire it up, and a suite that forgets to assert accessibility
// is a review finding rather than a silent pass.
expect.extend(toHaveNoViolations);
