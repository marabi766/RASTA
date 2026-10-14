import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from 'jose';
import { InternalTokenService, TokenVerifier } from './token-verifier';
import { RastaError } from '../errors/rasta-error';

/**
 * Both verifiers refuse a token that carries no `exp`.
 *
 * jose checks `exp` only when it is present, so before `requiredClaims` a
 * token that simply omitted it verified — and never expired. A stolen one
 * would have been valid forever.
 *
 * The user-token verifier is exercised against a real JWKS served from this
 * process, fetched the way it fetches Keycloak's: no stub stands in for the
 * code under test.
 */

const ISSUER = 'http://keycloak.test/realms/rasta';
const AUDIENCE = 'rasta-api';

let server: Server;
let jwksUri: string;
let privateKey: KeyLike;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  jwksUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/certs`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function userToken(options: { exp?: boolean } = {}): Promise<string> {
  const jwt = new SignJWT({ realm_access: { roles: ['DRIVER'] }, org_id: 'ORG_A' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject('kc-user-1')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt();
  if (options.exp !== false) jwt.setExpirationTime('5m');
  return jwt.sign(privateKey);
}

const verifier = () => new TokenVerifier({ jwksUri, issuer: ISSUER, audience: AUDIENCE });

describe('user tokens', () => {
  it('accepts a token with an expiry, and reports it in milliseconds', async () => {
    const claims = await verifier().verifyUserToken(await userToken());
    expect(claims.sub).toBe('kc-user-1');
    expect(claims.expiresAt).toBeGreaterThan(Date.now());
  });

  it('refuses a token that carries no expiry, which would otherwise never expire', async () => {
    await expect(verifier().verifyUserToken(await userToken({ exp: false }))).rejects.toMatchObject(
      { code: 'TOKEN_INVALID' },
    );
  });

  it('refuses it as invalid, not as expired — the probe learns nothing about which check failed', async () => {
    const error = await verifier()
      .verifyUserToken(await userToken({ exp: false }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RastaError);
    expect((error as RastaError).code).not.toBe('TOKEN_EXPIRED');
  });
});

describe('internal service tokens', () => {
  // Generated, not written down: a literal here is exactly what a secret
  // scanner exists to refuse, and it cannot tell a fixture from a leak.
  const SECRET = randomBytes(32).toString('base64url');
  const tokens = new InternalTokenService(SECRET, 'rasta-internal', 300);

  it('accepts a token minted by `issue`, which always sets an expiry', async () => {
    const token = await tokens.issue('notification-service', 'identity-service');
    const claims = await tokens.verify(token, 'identity-service');
    expect(claims.callerService).toBe('notification-service');
    expect(claims.expiresAt).toBeGreaterThan(Date.now());
  });

  it('refuses one signed with the right key but without an expiry', async () => {
    // Anything holding the shared secret could mint this. `issue` never
    // would, so the only way to meet it is a token that did not come from
    // `issue` — and it must not live forever.
    const forged = await new SignJWT({ purpose: 'SERVICE' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('notification-service')
      .setIssuer('rasta-internal')
      .setAudience('identity-service')
      .setIssuedAt()
      .sign(new TextEncoder().encode(SECRET));

    await expect(tokens.verify(forged, 'identity-service')).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });
});

/**
 * jose checks `crit` before the signature, and its refusal quotes the entry it
 * did not recognise — text the caller chose, in a token nobody signed. The
 * refusal keeps jose's code for the log and nothing of its message (S-09).
 */
describe('a refused token never puts its own text in the log', () => {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = (alg: string): string =>
    [
      encode({ alg, kid: 'test-key', crit: ['access_token=secret123'] }),
      encode({ sub: 'x' }),
      'AAAA',
    ].join('.');

  it.each([
    ['a user token', () => verifier().verifyUserToken(unsigned('RS256'))],
    [
      'an internal token',
      () =>
        new InternalTokenService(
          randomBytes(32).toString('base64url'),
          'rasta-internal',
          300,
        ).verify(unsigned('HS256'), 'identity-service'),
    ],
  ])('%s', async (_label, verify) => {
    const error = (await verify().catch((e: unknown) => e)) as RastaError;

    expect(error).toBeInstanceOf(RastaError);
    expect(error.code).toBe('TOKEN_INVALID');
    expect(error.internalContext).toEqual({ joseCode: 'ERR_JOSE_NOT_SUPPORTED' });
    expect(JSON.stringify([error.message, error.internalContext])).not.toContain('secret123');
  });
});
