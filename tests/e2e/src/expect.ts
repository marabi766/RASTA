import {
  test as base,
  expect as playwrightExpect,
  request,
  type APIRequestContext,
} from '@playwright/test';
import {
  guardEveryRequestContext,
  guardRequestContext,
  guardedAbsenceMatchers,
  installRequestContextGuard,
} from '@rasta/testing';

/**
 * Playwright's `expect` with the disclosure guard every Jest suite has
 * (`jest.disclosure-guard.cjs`): `not.toContain` / `not.toMatch` over a string
 * that carries a generated value the sentinel could occur inside is refused
 * (#452). Every spec takes `expect` from `./api`, which re-exports this one;
 * scripts/disclosure-guard-wiring.test.mjs holds them to it.
 */
export const expect = playwrightExpect.extend(guardedAbsenceMatchers(playwrightExpect));

/** Playwright resets test.expect on extend; guard every descendant at its creation. */
function withGuard<T extends typeof base>(derived: T): T {
  const extend = derived.extend;
  return Object.assign(derived, {
    expect,
    extend: ((fixtures) => withGuard(extend(fixtures))) as T['extend'],
  });
}

/**
 * Every exported test.expect must share the same guarded assertion origin.
 *
 * A worker fixture guards the request class before hooks/tests run (Q-155 N1).
 * page.request, context.request and factory-created contexts all refuse
 * redirects, including contexts obtained by destructuring or reflection.
 * The existing per-context wrappers and lint remain additional layers.
 */
export const test = withGuard(
  base.extend<object, { requestContextGuard: void }>({
    // `provide` is Playwright's fixture `use`.
    request: async ({ request }, provide) => provide(guardRequestContext(request)),
    requestContextGuard: [
      async ({ playwright }, provide) => {
        await installRequestContextGuard(playwright.request);
        await provide();
      },
      { scope: 'worker', auto: true },
    ],
  }),
);

/** A Playwright API request context outside a test (global setup), guarded the same way. */
export async function newApiContext(): Promise<APIRequestContext> {
  const context = await request.newContext();
  guardEveryRequestContext(context);
  return guardRequestContext(context);
}
export type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Locator,
  Page,
  Route,
} from '@playwright/test';
