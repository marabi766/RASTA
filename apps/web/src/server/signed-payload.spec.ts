/**
 * @jest-environment node
 */
import { z } from 'zod';

import { signPayload, verifyPayload } from './signed-payload';
import type { WebSession } from './session';

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'manager',
  organizationId: 'ORG_1',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
};

const ENV = {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
};

const SCHEMA = z.object({ id: z.string(), n: z.number().int() });
const NOW = 1_800_000_000_000;

describe('signed payloads', () => {
  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });
  afterAll(() => {
    process.env = original;
  });

  const sign = (payload: Record<string, unknown> = { id: 'AST_1', n: 3 }, ttl = 60) =>
    signPayload(SESSION, 'test', payload, ttl, NOW);

  it('returns what it signed, without the expiry', () => {
    expect(verifyPayload(SESSION, 'test', sign(), SCHEMA, NOW)).toEqual({ id: 'AST_1', n: 3 });
  });

  it('is good until its expiry and not a moment after', () => {
    const token = sign({ id: 'AST_1', n: 3 }, 60);
    expect(verifyPayload(SESSION, 'test', token, SCHEMA, NOW + 60_000)).not.toBeNull();
    expect(verifyPayload(SESSION, 'test', token, SCHEMA, NOW + 61_000)).toBeNull();
  });

  it('refuses another person’s token', () => {
    expect(verifyPayload({ ...SESSION, subject: 'USR_2' }, 'test', sign(), SCHEMA, NOW)).toBeNull();
  });

  it('refuses a token from an earlier login: a new session has a new CSRF token', () => {
    expect(
      verifyPayload({ ...SESSION, csrfToken: 'the-next-login' }, 'test', sign(), SCHEMA, NOW),
    ).toBeNull();
  });

  it('refuses a token made for another purpose', () => {
    expect(verifyPayload(SESSION, 'something-else', sign(), SCHEMA, NOW)).toBeNull();
  });

  it('is unaffected by the session fields that do not identify the login', () => {
    expect(
      verifyPayload({ ...SESSION, accessToken: 'refreshed' }, 'test', sign(), SCHEMA, NOW),
    ).not.toBeNull();
  });

  it('refuses a body that was changed, even when the MAC is left alone', () => {
    const [, mac] = sign().split('.');
    const forged = Buffer.from(
      JSON.stringify({ id: 'AST_9', n: 3, exp: NOW / 1000 + 60 }),
    ).toString('base64url');
    expect(verifyPayload(SESSION, 'test', `${forged}.${mac}`, SCHEMA, NOW)).toBeNull();
  });

  it('refuses a token whose MAC was altered, one character at a time', () => {
    const [body, mac] = sign().split('.') as [string, string];
    for (let i = 0; i < mac.length; i += 1) {
      const swapped = mac[i] === 'A' ? 'B' : 'A';
      const altered = `${mac.slice(0, i)}${swapped}${mac.slice(i + 1)}`;
      expect(verifyPayload(SESSION, 'test', `${body}.${altered}`, SCHEMA, NOW)).toBeNull();
    }
  });

  it('refuses a token a different secret signed', () => {
    // The environment is read once per module instance, so a verifier with
    // another secret is a fresh instance.
    const verifierWith = (secret: string) => {
      let verify: (token: string) => unknown = () => null;
      jest.isolateModules(() => {
        process.env.WEB_SESSION_SECRET = secret;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fresh = require('./signed-payload') as typeof import('./signed-payload');
        verify = (token) => fresh.verifyPayload(SESSION, 'test', token, SCHEMA, NOW);
      });
      return verify;
    };

    const token = sign();
    // The control: a fresh instance with the same secret accepts, so the
    // refusal below is the secret and not the isolation.
    expect(verifierWith(ENV.WEB_SESSION_SECRET)(token)).not.toBeNull();
    expect(verifierWith('a-different-secret-that-is-also-long-enough')(token)).toBeNull();
  });

  it('refuses a signed payload that is not the shape the reader expects', () => {
    expect(verifyPayload(SESSION, 'test', sign({ id: 'AST_1' }), SCHEMA, NOW)).toBeNull();
    expect(
      verifyPayload(SESSION, 'test', sign({ id: 'AST_1', n: 3, extra: 1 }), SCHEMA, NOW),
    ).toBeNull();
    expect(verifyPayload(SESSION, 'test', sign({ id: 1, n: 3 }), SCHEMA, NOW)).toBeNull();
  });

  it.each([undefined, null, 42, {}, '', 'x', 'a.b', `${'a'.repeat(5000)}.${'b'.repeat(43)}`, '.'])(
    'refuses %j without throwing',
    (value) => {
      expect(verifyPayload(SESSION, 'test', value, SCHEMA, NOW)).toBeNull();
    },
  );

  it('refuses a token that is not signed JSON, however well it is formed', () => {
    const body = Buffer.from('not json').toString('base64url');
    expect(verifyPayload(SESSION, 'test', `${body}.${'A'.repeat(43)}`, SCHEMA, NOW)).toBeNull();
  });
});
