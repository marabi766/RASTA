import {
  assertDisposableTarget,
  DISPOSABLE_REALM_ATTRIBUTE,
  disposableRealmRefusal,
  environmentRefusals,
  isLoopbackHost,
  LiveTargetRefusedError,
} from './live-target-guard';

/**
 * The `keycloak-live` suite's write gate, without a Keycloak (review of #129,
 * finding 1). Runs in the `unit` project, so every CI run checks it — not
 * only the `e2e` job that has a Keycloak.
 */

const DISPOSABLE = { realm: 'rasta', attributes: { [DISPOSABLE_REALM_ATTRIBUTE]: 'true' } };
const TEST_ENV = { NODE_ENV: 'test', KEYCLOAK_URL: 'http://localhost:8080' };

describe('keycloak-live target guard', () => {
  describe('the environment, before anything is contacted', () => {
    it('accepts NODE_ENV=test and a loopback Keycloak', () => {
      expect(environmentRefusals(TEST_ENV)).toEqual([]);
      expect(environmentRefusals({ ...TEST_ENV, KEYCLOAK_URL: 'http://127.0.0.2:8080' })).toEqual(
        [],
      );
      expect(environmentRefusals({ ...TEST_ENV, KEYCLOAK_URL: 'http://[::1]:8080' })).toEqual([]);
    });

    it.each([undefined, 'development', 'production', 'TEST', ' test'])(
      'refuses NODE_ENV=%p',
      (NODE_ENV) => {
        expect(environmentRefusals({ ...TEST_ENV, NODE_ENV })).toEqual([
          'NODE_ENV is not exactly "test"',
        ]);
      },
    );

    it.each([
      'http://keycloak.staging.example:8080',
      'http://10.0.0.5:8080',
      'http://127.0.0.1.example.com:8080',
      'http://localhost.example.com',
    ])('refuses a Keycloak off loopback, and does not echo it: %s', (KEYCLOAK_URL) => {
      const reasons = environmentRefusals({ ...TEST_ENV, KEYCLOAK_URL });
      expect(reasons).toEqual(['KEYCLOAK_URL is not a loopback address']);
      expect(reasons.join()).not.toContain(new URL(KEYCLOAK_URL).hostname);
    });

    it.each(['not a url', 'ftp://localhost/', ''])('refuses %p as a URL', (KEYCLOAK_URL) => {
      expect(environmentRefusals({ ...TEST_ENV, KEYCLOAK_URL })).toEqual([
        'KEYCLOAK_URL is not an http(s) URL',
      ]);
    });

    it('knows loopback when it sees it', () => {
      expect(isLoopbackHost('LOCALHOST')).toBe(true);
      expect(isLoopbackHost('127.255.255.255')).toBe(true);
      expect(isLoopbackHost('127.0.0.256')).toBe(false);
      expect(isLoopbackHost('128.0.0.1')).toBe(false);
    });
  });

  describe('the realm marker', () => {
    it('accepts the disposable development realm', () => {
      expect(disposableRealmRefusal(DISPOSABLE, 'rasta')).toBeNull();
    });

    it.each([
      ['no marker', { realm: 'rasta', attributes: {} }],
      ['no attributes', { realm: 'rasta' }],
      [
        'the marker as anything but "true"',
        { realm: 'rasta', attributes: { [DISPOSABLE_REALM_ATTRIBUTE]: true } },
      ],
      [
        'the marker "false"',
        { realm: 'rasta', attributes: { [DISPOSABLE_REALM_ATTRIBUTE]: 'false' } },
      ],
      ['another realm', { ...DISPOSABLE, realm: 'other' }],
      ['no representation', null],
      ['a string', 'rasta'],
    ])('refuses %s', (_label, representation) => {
      expect(disposableRealmRefusal(representation, 'rasta')).toEqual(expect.any(String));
    });
  });

  describe('the whole gate', () => {
    it('passes a disposable target', async () => {
      await expect(
        assertDisposableTarget({
          env: TEST_ENV,
          realm: 'rasta',
          readRealm: async () => DISPOSABLE,
        }),
      ).resolves.toBeUndefined();
    });

    it('refuses a loopback Keycloak whose realm lacks the marker — a tunnel to a shared one', async () => {
      await expect(
        assertDisposableTarget({
          env: TEST_ENV,
          realm: 'rasta',
          readRealm: async () => ({ realm: 'rasta', attributes: {} }),
        }),
      ).rejects.toBeInstanceOf(LiveTargetRefusedError);
    });

    it('refuses the environment without contacting Keycloak at all', async () => {
      const readRealm = jest.fn(async () => DISPOSABLE);
      await expect(
        assertDisposableTarget({
          env: { ...TEST_ENV, NODE_ENV: 'development' },
          realm: 'rasta',
          readRealm,
        }),
      ).rejects.toBeInstanceOf(LiveTargetRefusedError);
      expect(readRealm).not.toHaveBeenCalled();
    });
  });
});
