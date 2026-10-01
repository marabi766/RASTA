/**
 * @jest-environment node
 */
import { FLASH_TTL_SECONDS, mintFlash, readFlash } from './flash';
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

const NOW = 1_800_000_000_000;
const ACTIONS = ['created', 'updated'] as const;

/**
 * The banner a write's redirect shows. What matters is who can make it appear:
 * only a write this person's own request produced, for the record it produced
 * it for.
 */
describe('the flash after a write', () => {
  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });
  afterAll(() => {
    process.env = original;
  });

  it('confirms the action for the record it was minted for', () => {
    const token = mintFlash(SESSION, 'AST_1', 'created', NOW);
    expect(readFlash(SESSION, token, 'AST_1', ACTIONS, NOW)).toBe('created');
  });

  it.each(['1', 'true', 'created', 'created=1', ''])(
    'is not asserted by typing %j into the URL',
    (typed) => {
      expect(readFlash(SESSION, typed, 'AST_1', ACTIONS, NOW)).toBeUndefined();
    },
  );

  it('is not asserted by leaving the parameter out', () => {
    expect(readFlash(SESSION, undefined, 'AST_1', ACTIONS, NOW)).toBeUndefined();
  });

  it('does not confirm a write to a different record', () => {
    const token = mintFlash(SESSION, 'AST_1', 'created', NOW);
    expect(readFlash(SESSION, token, 'AST_2', ACTIONS, NOW)).toBeUndefined();
  });

  it('does not confirm for somebody else, or after a new login', () => {
    const token = mintFlash(SESSION, 'AST_1', 'created', NOW);
    expect(
      readFlash({ ...SESSION, subject: 'USR_2' }, token, 'AST_1', ACTIONS, NOW),
    ).toBeUndefined();
    expect(
      readFlash({ ...SESSION, csrfToken: 'the-next-login' }, token, 'AST_1', ACTIONS, NOW),
    ).toBeUndefined();
  });

  it('expires', () => {
    const token = mintFlash(SESSION, 'AST_1', 'created', NOW);
    expect(readFlash(SESSION, token, 'AST_1', ACTIONS, NOW + FLASH_TTL_SECONDS * 1000)).toBe(
      'created',
    );
    expect(
      readFlash(SESSION, token, 'AST_1', ACTIONS, NOW + (FLASH_TTL_SECONDS + 1) * 1000),
    ).toBeUndefined();
  });

  it('says nothing for an action the page does not know', () => {
    const token = mintFlash(SESSION, 'AST_1', 'deleted-everything', NOW);
    expect(readFlash(SESSION, token, 'AST_1', ACTIONS, NOW)).toBeUndefined();
  });

  it('is a token, not a word: it cannot be guessed from the action', () => {
    const a = mintFlash(SESSION, 'AST_1', 'created', NOW);
    const b = mintFlash(SESSION, 'AST_1', 'created', NOW + 1000);
    expect(a).not.toBe(b);
    expect(a).not.toContain('created');
  });
});
