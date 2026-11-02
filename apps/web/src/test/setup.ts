import { TextDecoder, TextEncoder } from 'node:util';
import '@testing-library/jest-dom';
import { toHaveNoViolations } from 'jest-axe';

import { resetUnrecordedOutcomes } from '@/lib/unresolved-tenancy';

import { installTurboInputsGuard } from './turbo-inputs-guard';

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

// A spec that reads another package's source as text must have turbo hash it
// (see `turbo-inputs-guard.ts`); a forgotten input is a failure here, not a
// stale cached green later.
installTurboInputsGuard();

// A late answer that storage refused is held in this document's memory
// (`lib/unresolved-tenancy.ts`); each test is a new document.
beforeEach(() => resetUnrecordedOutcomes());

// An unmapped service sentence is reported with a one-line structured
// diagnostic on stderr (`server/write.ts`, `reportUnmappedMessage`). Specs
// exercise that path on purpose, so the line is swallowed here; a spec that
// cares asserts on `console.error` (it stays a jest spy). Any other
// `console.error` still reaches the terminal.
const realConsoleError = console.error.bind(console);
beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('web.unmapped_service_message')) return;
    realConsoleError(...args);
  });
});
