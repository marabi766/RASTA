import {
  DEFAULT_THEME,
  DEVICE_THEME_COOKIE,
  THEME_COOKIE_MAX_AGE_SECONDS,
  THEME_COOKIE_NAME,
  parseTheme,
  resolveTheme,
  themeCookie,
} from './theme';

/**
 * The resolver every page's `data-theme` comes from. Owner decision
 * 2026-10-24: light for everyone until they choose, so every way of not having
 * a usable choice is light.
 */

const jar = (cookies: Record<string, string>) => (name: string) =>
  Object.hasOwn(cookies, name) ? cookies[name] : undefined;

describe('resolveTheme', () => {
  it('is light with no cookie at all', () => {
    expect(resolveTheme(DEVICE_THEME_COOKIE, jar({}))).toBe('light');
    expect(DEFAULT_THEME).toBe('light');
  });

  it('is light for a stored light', () => {
    expect(resolveTheme(DEVICE_THEME_COOKIE, jar({ [DEVICE_THEME_COOKIE]: 'light' }))).toBe(
      'light',
    );
  });

  it('is dark for a stored dark', () => {
    expect(resolveTheme(DEVICE_THEME_COOKIE, jar({ [DEVICE_THEME_COOKIE]: 'dark' }))).toBe('dark');
  });

  it.each([
    '',
    'Dark',
    'DARK',
    ' dark',
    'dark ',
    'dark;',
    'dark,light',
    'system',
    'auto',
    '1',
    'true',
    'null',
    'undefined',
    '<script>',
    '{"theme":"dark"}',
    'dark'.repeat(1000),
  ])('is light for the invalid value %j', (raw) => {
    expect(resolveTheme(DEVICE_THEME_COOKIE, jar({ [DEVICE_THEME_COOKIE]: raw }))).toBe('light');
  });

  it("ignores another person's cookie: it reads the one name it is given and no other", () => {
    const mine = 'rasta_theme_aaaaaaaaaaaaaaaaaaaaaaaa';
    const theirs = 'rasta_theme_bbbbbbbbbbbbbbbbbbbbbbbb';
    const cookies = jar({ [theirs]: 'dark', [DEVICE_THEME_COOKIE]: 'dark' });
    expect(resolveTheme(mine, cookies)).toBe('light');
    expect(resolveTheme(theirs, cookies)).toBe('dark');
    // …and the device cookie is only the signed-out page's.
    expect(resolveTheme(mine, jar({ [DEVICE_THEME_COOKIE]: 'dark' }))).toBe('light');
  });
});

describe('parseTheme', () => {
  it('accepts exactly the two words and nothing of any other type', () => {
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('light')).toBe('light');
    for (const raw of [undefined, null, 0, 1, true, {}, [], ['dark'], { toString: () => 'dark' }]) {
      expect(parseTheme(raw)).toBe('light');
    }
  });
});

describe('themeCookie', () => {
  it('writes the word, a year, the whole site, SameSite=Lax — and nothing else', () => {
    expect(themeCookie(DEVICE_THEME_COOKIE, 'dark', false)).toBe(
      `rasta_theme=dark; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`,
    );
    expect(THEME_COOKIE_MAX_AGE_SECONDS).toBe(31_536_000);
  });

  it('is Secure only where the deployment terminates TLS', () => {
    expect(themeCookie(DEVICE_THEME_COOKIE, 'light', true)).toMatch(/; Secure$/);
    expect(themeCookie(DEVICE_THEME_COOKIE, 'light', false)).not.toMatch(/Secure/);
  });

  it('can only ever write a valid word', () => {
    expect(themeCookie(DEVICE_THEME_COOKIE, 'purple' as never, false)).toMatch(
      /^rasta_theme=light;/,
    );
  });

  it('never marks the cookie HttpOnly (the switch writes it from the page)', () => {
    expect(themeCookie(DEVICE_THEME_COOKIE, 'dark', true)).not.toMatch(/HttpOnly/i);
  });
});

describe('the cookie names the theme may use', () => {
  it('are the device name and one 24-hex tag per person', () => {
    expect(THEME_COOKIE_NAME.test('rasta_theme')).toBe(true);
    expect(THEME_COOKIE_NAME.test('rasta_theme_0123456789abcdef01234567')).toBe(true);
    for (const name of [
      'rasta_session',
      'rasta_theme_',
      'rasta_theme_USR_1',
      'rasta_theme_0123456789abcdef0123456',
      'rasta_theme_0123456789ABCDEF01234567',
      'rasta_theme_0123456789abcdef012345678',
    ]) {
      expect(THEME_COOKIE_NAME.test(name)).toBe(false);
    }
  });
});
