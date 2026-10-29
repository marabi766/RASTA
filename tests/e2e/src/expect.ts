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

/** Playwright resets test.expect on extend; guard every descendant at its creation. */
function withGuard<T extends typeof base>(derived: T): T {
  const extend = derived.extend;
  return Object.assign(derived, {
    expect,
    extend: ((fixtures) => withGuard(extend(fixtures))) as T['extend'],
  });
}

export const test = withGuard(base.extend({}));
export type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Locator,
  Page,
  Route,
} from '@playwright/test';

export { request } from '@playwright/test';
