import { test as base, expect as playwrightExpect } from '@playwright/test';
import { guardedAbsenceMatchers } from '@rasta/testing';

/**
 * Playwright's `expect` with the disclosure guard every Jest suite has
 * (`jest.disclosure-guard.cjs`): `not.toContain` / `not.toMatch` over a string
 * that carries a generated value the sentinel could occur inside is refused
 * (#452). Every spec takes `expect` from `./api`, which re-exports this one;
 * scripts/disclosure-guard-wiring.test.mjs holds them to it.
 */
export const expect = playwrightExpect.extend(guardedAbsenceMatchers(playwrightExpect));

/** Every exported test.expect must share the same guarded assertion origin. */
export const test = Object.assign(base.extend({}), { expect });
export type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Locator,
  Page,
  Route,
} from '@playwright/test';

export { request } from '@playwright/test';
