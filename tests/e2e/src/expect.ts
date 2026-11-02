import {
  test as base,
  expect as playwrightExpect,
  request,
  type APIRequestContext,
} from '@playwright/test';
import { guardRequestContext, guardedAbsenceMatchers } from '@rasta/testing';

/**
 * Playwright's `expect` with the disclosure guard every Jest suite has
 * (`jest.disclosure-guard.cjs`): `not.toContain` / `not.toMatch` over a string
 * that carries a generated value the sentinel could occur inside is refused
 * (#452). Every spec takes `expect` from `./api`, which re-exports this one;
 * scripts/disclosure-guard-wiring.test.mjs holds them to it.
 */
export const expect = playwrightExpect.extend(guardedAbsenceMatchers(playwrightExpect));

/**
 * Every exported test.expect must share the same guarded assertion origin.
 *
 * And the `request` fixture refuses redirects (Q-155, PR #492 r1 F2), as
 * send() does for the actors: Playwright would follow a 307/308 with the body
 * and answer with the redirect target's success.
 */
export const test = Object.assign(
  base.extend({
    // `provide` is Playwright's fixture `use`.
    request: async ({ request }, provide) => provide(guardRequestContext(request)),
  }),
  { expect },
);

/** A Playwright API request context outside a test (global setup), guarded the same way. */
export async function newApiContext(): Promise<APIRequestContext> {
  return guardRequestContext(await request.newContext());
}
export type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Locator,
  Page,
  Route,
} from '@playwright/test';
