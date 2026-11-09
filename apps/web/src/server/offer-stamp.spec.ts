/**
 * @jest-environment node
 */
import type { WebSession } from './session';
import { drawnOfferVersion, stampOffer } from './offer-stamp';
import { actingAccessToken } from '@/test/session-token';

/**
 * The offer version a page drew (D-156): signed when the page draws the offer,
 * read back by the action as the only source of the body's `offerVersion`.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
  WEB_SESSION_MAX_AGE_SECONDS: '3600',
});

const session = (overrides: Partial<WebSession> = {}): WebSession =>
  ({
    subject: 'user-1',
    organizationId: 'ORG-DEH-0001',
    accessToken: actingAccessToken('ORG-DEH-0001'),
    csrfToken: 'csrf-token-for-this-session',
    ...overrides,
  }) as WebSession;

const OFFER = { id: 'OFR_SEED_AGGREGATE_D2', version: 3 };

describe('an offer stamp', () => {
  it('gives back the version the page drew, for the offer it was drawn for', () => {
    expect(drawnOfferVersion(session(), stampOffer(session(), OFFER), OFFER.id)).toBe(3);
  });

  it('is not another offer’s stamp: a stamp moved to another offer sends nothing', () => {
    expect(drawnOfferVersion(session(), stampOffer(session(), OFFER), 'OFR_OTHER')).toBeNull();
  });

  it.each([
    ['another person', { subject: 'user-2' }],
    ['another login of the same person', { csrfToken: 'another-login' }],
  ])('is refused for %s', (_label, other) => {
    expect(drawnOfferVersion(session(other), stampOffer(session(), OFFER), OFFER.id)).toBeNull();
  });

  it('is refused once the login it was drawn for could have ended', () => {
    const drawnAt = Date.now();
    const token = stampOffer(session(), OFFER, drawnAt);
    expect(drawnOfferVersion(session(), token, OFFER.id, drawnAt + 3_599_000)).toBe(3);
    expect(drawnOfferVersion(session(), token, OFFER.id, drawnAt + 3_601_000)).toBeNull();
  });

  it('cannot be edited into another version', () => {
    const token = stampOffer(session(), OFFER);
    const [body, mac] = token.split('.') as [string, string];
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as object;
    const forged = Buffer.from(JSON.stringify({ ...payload, version: 2 })).toString('base64url');
    expect(drawnOfferVersion(session(), `${forged}.${mac}`, OFFER.id)).toBeNull();
  });

  it.each([undefined, null, '', 'not-a-stamp', 3, { version: 3 }])(
    'reads %p as no stamp at all',
    (token) => {
      expect(drawnOfferVersion(session(), token, OFFER.id)).toBeNull();
    },
  );
});
