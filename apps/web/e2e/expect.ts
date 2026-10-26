import { expect as playwrightExpect } from '@playwright/test';
import { guardedAbsenceMatchers } from '@rasta/testing';

/**
 * Playwright's `expect` with the disclosure guard every Jest suite has
 * (`jest.disclosure-guard.cjs`): `not.toContain` / `not.toMatch` over a string
 * that carries a generated value the sentinel could occur inside is refused
 * (#452). Every spec here takes `expect` from this file, never from
 * `@playwright/test`; scripts/disclosure-guard-wiring.test.mjs holds them to it.
 */
export const expect = playwrightExpect.extend(guardedAbsenceMatchers(playwrightExpect));
