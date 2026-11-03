import { createHmac } from 'node:crypto';

/**
 * The name of one person's theme cookie (`server/theme.ts` explains why there
 * is one per person). Its own file, with nothing but `node:crypto` in it, so
 * the browser tests can compute the same name the server does.
 */

/** The device cookie's name (`DEVICE_THEME_COOKIE` in the design system); pinned equal by `theme.spec.ts`. */
const PREFIX = 'rasta_theme';
const TAG_BYTES = 12;
const TAG_DOMAIN = 'rasta-web-theme-v1:';

/** `rasta_theme_<24 hex>` for this person; stable for the life of the secret. */
export function userThemeCookieName(subject: string, secret: string): string {
  const tag = createHmac('sha256', secret)
    .update(`${TAG_DOMAIN}${subject}`, 'utf8')
    .digest()
    .subarray(0, TAG_BYTES)
    .toString('hex');
  return `${PREFIX}_${tag}`;
}
