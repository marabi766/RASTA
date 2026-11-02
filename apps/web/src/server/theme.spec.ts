/**
 * @jest-environment node
 */

/**
 * Whose theme a page wears (`server/theme.ts`): the signed-in person's own
 * cookie, the device cookie only for the signed-out page, light for everything
 * else — and two people on one device never see each other's choice.
 */

const SECRET = 'a-secret-that-is-long-enough-to-be-a-key';
Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: SECRET,
});

let jar: Record<string, string> = {};
jest.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name in jar ? { value: jar[name] } : undefined),
  }),
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { readThemePreference } = require('./theme') as typeof import('./theme');
const { userThemeCookieName } = require('./theme-cookie') as typeof import('./theme-cookie');
const { sealSession } = require('./session') as typeof import('./session');
const { actingAccessToken } =
  require('@/test/session-token') as typeof import('@/test/session-token');
const { DEVICE_THEME_COOKIE, THEME_COOKIE_NAME } = require('@/ui') as typeof import('@/ui');
/* eslint-enable @typescript-eslint/no-require-imports */

type WebSession = import('./session').WebSession;

function session(overrides: Partial<WebSession> = {}): WebSession {
  const now = Math.floor(Date.now() / 1000);
  return {
    subject: 'USR_A',
    username: 'a',
    organizationId: 'ORG_A',
    accessToken: actingAccessToken('ORG_A'),
    accessTokenExpiresAt: now + 600,
    refreshToken: 'r',
    csrfToken: 'c',
    issuedAt: now - 60,
    ...overrides,
  };
}

const signedInAs = (subject: string, organizationId = 'ORG_A') => {
  jar.rasta_session = sealSession(
    session({ subject, organizationId, accessToken: actingAccessToken(organizationId) }),
    SECRET,
  );
};

const A = () => userThemeCookieName('USR_A', SECRET);
const B = () => userThemeCookieName('USR_B', SECRET);

beforeEach(() => {
  jar = {};
  delete process.env.WEB_COOKIE_SECURE;
});

describe('the per-person cookie name', () => {
  it('is opaque: a 96-bit HMAC tag, never the id, never anything from the session', () => {
    expect(A()).toMatch(/^rasta_theme_[0-9a-f]{24}$/);
    expect(A()).not.toContain('USR_A');
    expect(A()).not.toContain(Buffer.from('USR_A').toString('hex'));
    expect(Buffer.from('USR_A').toString('base64')).not.toContain(A().slice(12));
  });

  it('starts with the device cookie name the design system defines', () => {
    expect(A().startsWith(`${DEVICE_THEME_COOKIE}_`)).toBe(true);
    expect(THEME_COOKIE_NAME.test(A())).toBe(true);
  });

  it('is stable for a person, different between people, and depends on the secret', () => {
    expect(userThemeCookieName('USR_A', SECRET)).toBe(A());
    expect(A()).not.toBe(B());
    expect(userThemeCookieName('USR_A', `${SECRET}-rotated`)).not.toBe(A());
  });

  it('does not change with the organization the session acts for (tenant switching)', () => {
    signedInAs('USR_A', 'ORG_A');
    jar[A()] = 'dark';
    return readThemePreference().then(async (first) => {
      signedInAs('USR_A', 'ORG_B');
      jar[A()] = 'dark';
      const second = await readThemePreference();
      expect(second).toEqual(first);
      expect(second.theme).toBe('dark');
    });
  });
});

describe('a signed-out page (the login page)', () => {
  it('is light with no cookie, and writes the device cookie', async () => {
    expect(await readThemePreference()).toEqual({
      theme: 'light',
      cookieName: 'rasta_theme',
      secure: true,
    });
  });

  it('follows the device cookie', async () => {
    jar.rasta_theme = 'dark';
    expect((await readThemePreference()).theme).toBe('dark');
  });

  it("does not follow a person's cookie", async () => {
    jar[A()] = 'dark';
    expect((await readThemePreference()).theme).toBe('light');
  });

  it('treats a session that will not open like no session', async () => {
    jar.rasta_session = 'not-a-session';
    jar.rasta_theme = 'dark';
    expect(await readThemePreference()).toMatchObject({ theme: 'dark', cookieName: 'rasta_theme' });
  });
});

describe('a signed-in page', () => {
  it('is light with no cookie of its own, and writes its own cookie', async () => {
    signedInAs('USR_A');
    expect(await readThemePreference()).toEqual({ theme: 'light', cookieName: A(), secure: true });
  });

  it('follows its own cookie', async () => {
    signedInAs('USR_A');
    jar[A()] = 'dark';
    expect((await readThemePreference()).theme).toBe('dark');
  });

  it('does NOT fall back to the device cookie of whoever used the login page', async () => {
    signedInAs('USR_A');
    jar.rasta_theme = 'dark';
    expect((await readThemePreference()).theme).toBe('light');
  });

  it("ignores a wrong-user cookie: B on A's device is light, A is dark", async () => {
    jar[A()] = 'dark';
    signedInAs('USR_B');
    expect(await readThemePreference()).toMatchObject({ theme: 'light', cookieName: B() });
    signedInAs('USR_A');
    expect(await readThemePreference()).toMatchObject({ theme: 'dark', cookieName: A() });
  });

  it('shows each person their own choice on one device, and logging out keeps both', async () => {
    jar[A()] = 'dark';
    jar[B()] = 'light';
    jar.rasta_theme = 'dark';
    signedInAs('USR_A');
    expect((await readThemePreference()).theme).toBe('dark');
    signedInAs('USR_B');
    expect((await readThemePreference()).theme).toBe('light');
    delete jar.rasta_session; // log out: no cookie is removed by it
    expect((await readThemePreference()).theme).toBe('dark'); // the device's
    expect(Object.keys(jar).sort()).toEqual([A(), B(), 'rasta_theme'].sort());
  });

  it('is light for a value that is not exactly light or dark', async () => {
    signedInAs('USR_A');
    for (const raw of ['', 'Dark', 'dark ', 'system', 'dark;path=/']) {
      jar[A()] = raw;
      expect((await readThemePreference()).theme).toBe('light');
    }
  });

  it('falls to light and the signed-out cookie when the secret cannot be loaded', async () => {
    signedInAs('USR_A');
    jar[A()] = 'dark';
    const saved = process.env.WEB_SESSION_SECRET;
    process.env.WEB_SESSION_SECRET = 'short';
    jest.resetModules();
    try {
      /* eslint-disable-next-line @typescript-eslint/no-require-imports */
      const fresh = require('./theme') as typeof import('./theme');
      expect(await fresh.readThemePreference()).toEqual({
        theme: 'light',
        cookieName: 'rasta_theme',
        secure: true,
      });
    } finally {
      process.env.WEB_SESSION_SECRET = saved;
    }
  });
});

describe('the Secure flag', () => {
  it('follows WEB_COOKIE_SECURE, like the session cookie', async () => {
    process.env.WEB_COOKIE_SECURE = 'false';
    expect((await readThemePreference()).secure).toBe(false);
    process.env.WEB_COOKIE_SECURE = 'true';
    expect((await readThemePreference()).secure).toBe(true);
  });
});
