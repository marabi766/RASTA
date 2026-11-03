import { render } from '@testing-library/react';

import { PageThemeOwner } from './PageThemeOwner';

/**
 * The page's own owner element (PR 595 review, F1): a subject in, that
 * subject's cookie out — recomputed for every render, so two renders for two
 * accounts differ even when everything above them is the same document.
 */

const SECRET = 'a-secret-that-is-long-enough-to-be-a-key';
Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: SECRET,
});

/* eslint-disable @typescript-eslint/no-require-imports */
const { userThemeCookieName } =
  require('@/server/theme-cookie') as typeof import('@/server/theme-cookie');
const { ThemeOwner } = require('@/ui') as typeof import('@/ui');
/* eslint-enable @typescript-eslint/no-require-imports */

function ownerOf(subject: string | null) {
  const element = PageThemeOwner({ subject });
  expect(element?.type).toBe(ThemeOwner);
  return element!.props as { cookieName: string; secure: boolean };
}

it("names the person's own cookie, and a different one for another person", () => {
  const a = ownerOf('USR_A');
  const b = ownerOf('USR_B');
  expect(a.cookieName).toBe(userThemeCookieName('USR_A', SECRET));
  expect(b.cookieName).toBe(userThemeCookieName('USR_B', SECRET));
  expect(a.cookieName).not.toBe(b.cookieName);
});

it('names the device cookie on a page with no login', () => {
  expect(ownerOf(null).cookieName).toBe('rasta_theme');
});

it('draws nothing itself', () => {
  const { container } = render(<PageThemeOwner subject="USR_A" />);
  expect(container).toBeEmptyDOMElement();
});
