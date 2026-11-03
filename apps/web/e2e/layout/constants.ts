import { randomBytes } from 'node:crypto';

/**
 * Where the phone-layout suite's throwaway portal and fixture gateway listen
 * (`playwright.config.ts`, `e2e/layout/harness.ts`). Kept apart from the
 * harness so the config imports nothing but these constants.
 */
export const LAYOUT_PORT = 3201;
export const LAYOUT_GATEWAY_PORT = 3291;
export const LAYOUT_ORIGIN = `http://localhost:${LAYOUT_PORT}`;

/**
 * The layout portal's session secret: random per run, chosen once by whichever
 * process loads the config first and inherited by the workers through the
 * environment — never a repository value.
 */
export function layoutSessionSecret(): string {
  process.env.LAYOUT_SESSION_SECRET ??= randomBytes(32).toString('hex');
  return process.env.LAYOUT_SESSION_SECRET;
}
