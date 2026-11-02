import { test as base, expect as playwrightExpect, type APIRequestContext } from '@playwright/test';
import { guardRequestContext, guardedAbsenceMatchers } from '@rasta/testing';

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
 * And every API request context a spec can reach refuses redirects (Q-155,
 * PR #492 r1 F2): the `request` fixture, and `newApiContext()` for a context
 * outside a test (`beforeAll`). Specs send bearers, idempotent writes and
 * signed storage URLs through them; Playwright would otherwise follow a
 * 307/308 with the body, keep `authorization` on a same-origin hop, and hand
 * back the redirect target's success. `internal/raw-http` refuses every other
 * route to a context (`playwright.request`, `page.request`, `context.request`).
 */
export const test = Object.assign(
  base.extend<object, { newApiContext: () => Promise<APIRequestContext> }>({
    // `provide` is Playwright's fixture `use` (renamed: React's hook rule claims the name).
    request: async ({ request }, provide) => provide(guardRequestContext(request)),
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
  Route,
} from '@playwright/test';
