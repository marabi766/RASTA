/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadWebServerEnv } from './env';

/**
 * What the portal refuses to start without, and why each refusal is the
 * kinder option (ADR-059).
 */

const REQUIRED = {
  API_GATEWAY_URL: 'http://localhost:3000',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
};

/** The required set without one key, which is what every refusal test needs. */
function omitting(key: keyof typeof REQUIRED): Record<string, string> {
  const rest: Record<string, string> = { ...REQUIRED };
  delete rest[key];
  return rest;
}

describe('the portal refuses to start without a session key', () => {
  it('needs the key at all', () => {
    expect(() => loadWebServerEnv(omitting('WEB_SESSION_SECRET'))).toThrow(/WEB_SESSION_SECRET/);
  });

  it('refuses a short key', () => {
    // A key that is really a password somebody typed. The failure this
    // prevents is silent: the cookie is still "encrypted", just not by much.
    expect(() => loadWebServerEnv({ ...REQUIRED, WEB_SESSION_SECRET: 'short' })).toThrow();
  });

  it('never puts the key in the message it throws', () => {
    // The message reaches a log and a terminal. Names only.
    try {
      loadWebServerEnv({ ...REQUIRED, WEB_SESSION_SECRET: 'short-secret-value' });
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as Error).message).not.toContain('short-secret-value');
      expect((error as Error).message).toContain('WEB_SESSION_SECRET');
    }
  });
});

describe('the rest of the configuration', () => {
  it.each(['API_GATEWAY_URL', 'OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'WEB_PUBLIC_ORIGIN'] as const)(
    'requires %s',
    (key) => {
      expect(() => loadWebServerEnv(omitting(key))).toThrow(new RegExp(key));
    },
  );

  it('refuses a gateway address that is not a url', () => {
    expect(() => loadWebServerEnv({ ...REQUIRED, API_GATEWAY_URL: 'gateway:3000' })).toThrow();
  });

  it('bounds the session lifetime rather than trusting the number', () => {
    expect(() => loadWebServerEnv({ ...REQUIRED, WEB_SESSION_MAX_AGE_SECONDS: '10' })).toThrow();
    expect(() =>
      loadWebServerEnv({ ...REQUIRED, WEB_SESSION_MAX_AGE_SECONDS: '99999999' }),
    ).toThrow();
    expect(loadWebServerEnv(REQUIRED).WEB_SESSION_MAX_AGE_SECONDS).toBe(12 * 60 * 60);
  });

  it('defaults the cookie to Secure', () => {
    // The unsafe direction has to be asked for, and the only reason it exists
    // is local development over plain HTTP.
    expect(loadWebServerEnv(REQUIRED).WEB_COOKIE_SECURE).toBe(true);
    expect(loadWebServerEnv({ ...REQUIRED, WEB_COOKIE_SECURE: 'false' }).WEB_COOKIE_SECURE).toBe(
      false,
    );
  });
});

describe('refresh coordination in production (ADR-059 addendum)', () => {
  it('refuses to start in production without WEB_REDIS_URL', () => {
    // Two replicas are the documented topology; without shared coordination
    // they race for every refresh token.
    expect(() => loadWebServerEnv({ ...REQUIRED, NODE_ENV: 'production' })).toThrow(
      /WEB_REDIS_URL/,
    );
  });

  it('names every missing key at once, WEB_REDIS_URL among them', () => {
    expect(() =>
      loadWebServerEnv({ ...omitting('OIDC_CLIENT_ID'), NODE_ENV: 'production' }),
    ).toThrow(/OIDC_CLIENT_ID, WEB_REDIS_URL/);
  });

  it('starts in production with it', () => {
    const env = loadWebServerEnv({
      ...REQUIRED,
      NODE_ENV: 'production',
      WEB_REDIS_URL: 'redis://redis:6379',
    });
    expect(env.WEB_REDIS_URL).toBe('redis://redis:6379');
  });

  it.each(['development', 'test', undefined])('leaves it optional when NODE_ENV is %s', (mode) => {
    expect(() =>
      loadWebServerEnv({ ...REQUIRED, ...(mode ? { NODE_ENV: mode } : {}) }),
    ).not.toThrow();
  });

  it('refuses a Redis address that is not a redis URL', () => {
    expect(() => loadWebServerEnv({ ...REQUIRED, WEB_REDIS_URL: 'http://redis:6379' })).toThrow(
      /WEB_REDIS_URL/,
    );
  });
});

describe('nothing secret reaches the browser bundle', () => {
  it('declares no NEXT_PUBLIC_ variable', () => {
    // Next.js decides what ships to the browser by exactly that prefix, and
    // `docs/16 § ۱۶٫۱۱` forbids a secret behind it. Asserted against the file
    // rather than the parsed object, because the risk is somebody *adding* one.
    const source = readFileSync(join(__dirname, 'env.ts'), 'utf8');
    // A declaration or a read, not the prose above them — the comment in
    // `env.ts` names the prefix precisely so a reader knows why it is absent.
    expect(source).not.toMatch(/^\s*NEXT_PUBLIC_[A-Z0-9_]+\s*:/m);
    expect(source).not.toMatch(/process\.env\.NEXT_PUBLIC_/);
  });

  it('keeps every key out of anything a page could serialise', () => {
    const env = loadWebServerEnv(REQUIRED);
    for (const key of Object.keys(env)) {
      expect(key).not.toMatch(/^NEXT_PUBLIC_/);
    }
  });
});
