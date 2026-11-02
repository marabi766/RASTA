import { ITEST_ISSUER, testEnv } from './helpers';

describe('the economic fixture environment', () => {
  it('keeps the fixture issuer when a full host environment supplies a different issuer', () => {
    const inherited = process.env.OIDC_ISSUER_URL;
    try {
      process.env.OIDC_ISSUER_URL = 'https://host-environment.invalid/realms/other';
      expect(testEnv().OIDC_ISSUER_URL).toBe(ITEST_ISSUER);
    } finally {
      if (inherited === undefined) delete process.env.OIDC_ISSUER_URL;
      else process.env.OIDC_ISSUER_URL = inherited;
    }
  });
});
