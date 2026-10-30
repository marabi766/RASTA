import { randomBytes } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { InternalTokenService, type TokenVerifier, type UserClaims } from '../auth/token-verifier';
import { mintTestInternalToken, type TestInternalTokenKey } from '@rasta/testing';
import { IS_PUBLIC_KEY, ALLOW_SERVICE_KEY } from '../decorators';
import { tryGetContext } from '../context/request-context';
import { RequestContextMiddleware } from '../middleware/request-context.middleware';
import { RastaError } from '../errors/rasta-error';

/**
 * Which correlation id a request ends up carrying, through the real middleware
 * and the real guard.
 *
 * The middleware runs before authentication and holds everyone to the external
 * rule: a bare ULID or UUID, else a fresh id. A verified service-to-service
 * call may keep a looser id — bounded, safe charset — because a chain that
 * started before that rule (an order a workflow resumes under `corr-1`) must
 * not be split. Nothing that is not such a call gets the looser rule: not a
 * user's bearer, not a gateway-forwarded request, not a relay.
 */

const SECRET = randomBytes(32).toString('hex');
const THIS_SERVICE = 'economic-service';
const ORG_A = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YA';
const ULID_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** Codex r4: a whole UUID behind a label. */
const LABELLED_UUID = 'access_token_secret123-3f2b8c1e-9d4a-4e6b-8a7c-1f0e2d3c4b5a';

const internalTokens = new InternalTokenService(SECRET, 'rasta-internal', 300);
const tokenKey: TestInternalTokenKey = {
  secret: SECRET,
  issuer: 'rasta-internal',
  ttlSeconds: 300,
};

const claims: UserClaims = {
  sub: 'keycloak-subject',
  rastaUserId: 'USR_01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
  organizationId: ORG_A,
  organizationIds: [ORG_A],
  roles: ['ORGANIZATION_ADMIN'],
  organizationRoles: [`${ORG_A}:ORGANIZATION_ADMIN`],
  username: 'dehyari.admin',
  expiresAt: Date.now() + 60_000,
};

const tokenVerifier = {
  verifyUserToken: async (candidate: string): Promise<UserClaims> => {
    if (candidate !== 'user-token') throw new RastaError('TOKEN_INVALID', 'Token is not valid');
    return claims;
  },
} as unknown as TokenVerifier;

function guardFor(endpoint: { publicReason?: string; allowService?: string[] }): AuthGuard {
  const reflector = {
    getAllAndOverride: (key: string) => {
      if (key === IS_PUBLIC_KEY) {
        return endpoint.publicReason ? { public: true, reason: endpoint.publicReason } : undefined;
      }
      if (key === ALLOW_SERVICE_KEY) return endpoint.allowService;
      return undefined;
    },
  } as unknown as Reflector;
  return new AuthGuard(reflector, { serviceName: THIS_SERVICE, tokenVerifier, internalTokens });
}

interface Outcome {
  admitted: boolean;
  /** What the handler, or the filter answering a refusal, would see. */
  context: string;
  /** What the response header says at that point. */
  response: string;
}

/** Middleware, then guard, then a look at the context as the handler sees it. */
async function carried(
  headers: Record<string, string>,
  endpoint: { publicReason?: string; allowService?: string[] } = { allowService: [] },
): Promise<Outcome> {
  const echoed: Record<string, string> = {};
  const response = {
    setHeader: (name: string, value: string) => {
      echoed[name] = value;
    },
  };
  const request = { headers, method: 'POST', originalUrl: '/v1/x' };
  const execution = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;

  let outcome: Promise<Outcome> | undefined;
  new RequestContextMiddleware().use(request, response, () => {
    // Read whether the guard admits or refuses: the exception filter writes a
    // refusal under the same context.
    const seen = (admitted: boolean): Outcome => ({
      admitted,
      context: tryGetContext()!.correlationId,
      response: echoed['x-correlation-id']!,
    });
    outcome = guardFor(endpoint)
      .canActivate(execution)
      .then(
        () => seen(true),
        () => seen(false),
      );
  });
  if (outcome === undefined) throw new Error('the middleware did not call next');
  return outcome;
}

const serviceToken = () =>
  mintTestInternalToken(tokenKey, 'marketplace-service', THIS_SERVICE, 'SERVICE');
const relayToken = () => mintTestInternalToken(tokenKey, 'api-gateway', THIS_SERVICE, 'RELAY');

describe('AuthGuard, the correlation id a service call keeps', () => {
  it.each([
    ['a legacy id a resumed order was placed under', 'corr-1'],
    ['a background-work id', 'maintenance-due-MSC_01JBQ8Z4K7M2N5P8R1T3V6X9Y2'],
    ['a bare ULID', '01JBQ8Z4K7M2N5P8R1T3V6X9Y2'],
  ])('keeps %s', async (_, id) => {
    const outcome = await carried({
      'x-internal-token': await serviceToken(),
      'x-correlation-id': id,
    });
    expect(outcome).toEqual({ admitted: true, context: id, response: id });
  });

  it('keeps it when it refuses the call, so the refusal is traced under the same id', async () => {
    const outcome = await carried(
      { 'x-internal-token': await serviceToken(), 'x-correlation-id': 'corr-1' },
      { allowService: ['contract-service'] },
    );
    expect(outcome).toEqual({ admitted: false, context: 'corr-1', response: 'corr-1' });
  });

  it.each([
    ['a credential', 'access_token=secret123'],
    ['a line break and a forged log line', 'corr-1\nforged log line'],
    ['an id past the length bound', 'a'.repeat(129)],
  ])('still refuses %s and carries a fresh id', async (_, header) => {
    const outcome = await carried({
      'x-internal-token': await serviceToken(),
      'x-correlation-id': header,
    });
    expect(outcome.context).toMatch(ULID_SHAPE);
    expect(outcome.response).toBe(outcome.context);
  });
});

describe('AuthGuard, the correlation id an external caller keeps', () => {
  it.each([
    ['a user bearer', async () => ({ authorization: 'Bearer user-token' })],
    [
      // The gateway sends the caller's bearer with its own SERVICE token; the
      // bearer names the actor, so this is the caller's request, not a service's.
      'a gateway-forwarded request (bearer and service token)',
      async () => ({
        authorization: 'Bearer user-token',
        'x-internal-token': await serviceToken(),
      }),
    ],
  ])('over %s: a labelled UUID and a legacy id are both re-minted', async (_, credentials) => {
    for (const header of [LABELLED_UUID, 'corr-1']) {
      const outcome = await carried({ ...(await credentials()), 'x-correlation-id': header });
      expect(outcome.context).toMatch(ULID_SHAPE);
      expect(outcome.response).toBe(outcome.context);
    }
  });

  it('a relayed anonymous request is held to the external rule', async () => {
    const outcome = await carried(
      { 'x-internal-token': await relayToken(), 'x-correlation-id': 'corr-1' },
      { publicReason: 'self-registration' },
    );
    expect(outcome.context).toMatch(ULID_SHAPE);
    expect(outcome.response).toBe(outcome.context);
  });

  it('a user bearer keeps a bare UUID, as the web app sends', async () => {
    const id = '3f2b8c1e-9d4a-4e6b-8a7c-1f0e2d3c4b5a';
    const outcome = await carried({ authorization: 'Bearer user-token', 'x-correlation-id': id });
    expect(outcome).toEqual({ admitted: true, context: id, response: id });
  });
});
