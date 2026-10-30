import { randomBytes } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader, SignJWT } from 'jose';
import { mintTestInternalToken, type TestInternalTokenKey } from '@rasta/testing';
import { InternalTokenService } from './token-verifier';
import { InternalHttpClient, type InternalGrant } from '../http/internal-http-client';

/**
 * Test token factories mint with @rasta/testing's `mintTestInternalToken`, not
 * with the production issuer (PR #503 r2 prep). They test the services' guards
 * only while their tokens are the tokens production sends: for the same key
 * and grant, the test minter and `InternalHttpClient` must produce the same
 * protected header and the same claims, and verify to the same `ServiceClaims`.
 * A change to either side's layout fails here.
 */

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const ORG_A = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YA';
const ISSUER = 'rasta-internal';

/** Only the clock: jose's `iat`/`exp` read `new Date()`; promises and crypto run as usual. */
beforeEach(() => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
});
afterEach(() => jest.useRealTimers());

function keyOf(ttlSeconds: number, issuer = ISSUER): TestInternalTokenKey {
  return { secret: randomBytes(32).toString('hex'), issuer, ttlSeconds };
}

/** The token InternalHttpClient puts on the wire for a grant, captured at the transport. */
async function clientToken(tokens: InternalTokenService, grant: InternalGrant): Promise<string> {
  let sent: Record<string, string> = {};
  const transport = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    sent = init?.headers as Record<string, string>;
    return new Response('{}');
  }) as typeof fetch;
  const sender = await new InternalHttpClient(tokens, transport).authorize(grant);
  await sender.send('http://target.test/v1/internal/x', {});
  return sent['x-internal-token'];
}

function testToken(key: TestInternalTokenKey, grant: InternalGrant): Promise<string> {
  return 'organizationId' in grant
    ? mintTestInternalToken(key, grant.from, grant.to, grant.purpose, grant.organizationId)
    : mintTestInternalToken(key, grant.from, grant.to, grant.purpose);
}

/** Everything about a token but its signature. */
const layout = (token: string) => ({
  header: decodeProtectedHeader(token),
  claims: decodeJwt(token),
});

const GRANTS: Array<[string, InternalGrant]> = [
  [
    'a tenant-scoped SERVICE grant',
    { from: 'fleet-service', to: 'identity-service', purpose: 'SERVICE', organizationId: ORG_A },
  ],
  [
    'a platform-wide SERVICE grant',
    { from: 'fleet-service', to: 'asset-service', purpose: 'SERVICE' },
  ],
  ['a RELAY grant', { from: 'api-gateway', to: 'economic-service', purpose: 'RELAY' }],
];

describe('mintTestInternalToken and InternalHttpClient mint the same token layout', () => {
  it.each(GRANTS)('%s: same header and claims, same verified claims', async (_name, grant) => {
    const key = keyOf(300);
    const tokens = new InternalTokenService(key.secret, key.issuer, key.ttlSeconds);
    const [fromClient, fromTest] = [await clientToken(tokens, grant), await testToken(key, grant)];

    expect(layout(fromTest)).toStrictEqual(layout(fromClient));
    expect(layout(fromTest).claims.exp).toBe(NOW / 1000 + 300);
    expect(await tokens.verify(fromTest, grant.to)).toStrictEqual(
      await tokens.verify(fromClient, grant.to),
    );
  });

  it('carries the key’s issuer and lifetime, as the service’s own issuer does', async () => {
    const key = keyOf(30, 'rasta-internal-other');
    const tokens = new InternalTokenService(key.secret, key.issuer, key.ttlSeconds);
    const grant = GRANTS[0][1];

    const fromTest = await testToken(key, grant);
    expect(layout(fromTest)).toStrictEqual(layout(await clientToken(tokens, grant)));
    expect(layout(fromTest).claims).toMatchObject({
      iss: 'rasta-internal-other',
      exp: NOW / 1000 + 30,
    });
  });

  it('refuses a key the issuer would refuse: a secret under 32 characters', async () => {
    const key = { ...keyOf(300), secret: 'x'.repeat(31) };
    expect(() => new InternalTokenService(key.secret, key.issuer, key.ttlSeconds)).toThrow(
      'at least 32 characters',
    );
    await expect(testToken(key, GRANTS[0][1])).rejects.toThrow('at least 32 characters');
  });

  it('the comparison sees a layout drift: renamed, missing, extra or retyped fields', async () => {
    const key = keyOf(300);
    const tokens = new InternalTokenService(key.secret, key.issuer, key.ttlSeconds);
    const grant = GRANTS[0][1];
    const reference = layout(await clientToken(tokens, grant));
    const secret = new TextEncoder().encode(key.secret);
    const drifted = (
      claims: Record<string, unknown>,
      header: { alg: string; typ?: string } = { alg: 'HS256', typ: 'JWT' },
    ) =>
      new SignJWT(claims)
        .setProtectedHeader(header)
        .setIssuer(key.issuer)
        .setAudience(grant.to)
        .setSubject(grant.from)
        .setIssuedAt()
        .setExpirationTime('300s')
        .sign(secret);
    const exact = { svc: grant.from, purpose: 'SERVICE', org_id: ORG_A };

    expect(layout(await drifted(exact))).toStrictEqual(reference);
    for (const token of [
      await drifted({ svc: grant.from, purpose: 'SERVICE', org: ORG_A }),
      await drifted({ svc: grant.from, org_id: ORG_A }),
      await drifted({ ...exact, extra: true }),
      await drifted(exact, { alg: 'HS256' }),
    ]) {
      expect(layout(token)).not.toStrictEqual(reference);
    }
  });
});
