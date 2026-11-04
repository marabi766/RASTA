import { test as base, expect as playwrightExpect, type APIRequestContext } from '@playwright/test';
import {
  guardRequestContext,
  guardedAbsenceMatchers,
  installRequestContextGuard,
} from '@rasta/testing';

/**
 * Playwright's `expect` with the disclosure guard every Jest suite has
 * (`jest.disclosure-guard.cjs`): `not.toContain` / `not.toMatch` over a string
 * that carries a generated value the sentinel could occur inside is refused
 * (#452). Every spec here takes `expect` from this file, never from
 * `@playwright/test`; scripts/disclosure-guard-wiring.test.mjs holds them to it.
 */
export const expect = playwrightExpect.extend(guardedAbsenceMatchers(playwrightExpect));

/**
 * Every exported test.expect must share the same guarded assertion origin.
 *
 * A worker fixture guards the request class before hooks/tests run (Q-155 N1).
 * page.request, context.request and factory-created contexts all refuse
 * redirects, including contexts obtained by destructuring or reflection.
 * The existing per-context wrappers and lint remain additional layers.
 */
export const test = Object.assign(
  base.extend<
    object,
    { newApiContext: () => Promise<APIRequestContext>; requestContextGuard: void }
  >({
    // `provide` is Playwright's fixture `use` (renamed: React's hook rule claims the name).
    request: async ({ request }, provide) => provide(guardRequestContext(request)),
    requestContextGuard: [
      async ({ playwright }, provide) => {
        await installRequestContextGuard(playwright.request);
        await provide();
      },
      { scope: 'worker', auto: true },
    ],
    newApiContext: [
      async ({ playwright }, provide) =>
        provide(async () => guardRequestContext(await playwright.request.newContext())),
      { scope: 'worker' },
    ],
  }),
  { expect },
);
export type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Locator,
  Page,
  Request,
  Route,
} from '@playwright/test';
