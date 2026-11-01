import { randomBytes } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { AuthGuard } from '../guards/auth.guard';
import { type TokenVerifier } from '../auth/token-verifier';
import { mintTestInternalToken, type TestInternalTokenKey } from '@rasta/testing';
import { ALLOW_SERVICE_KEY, IS_PUBLIC_KEY } from '../decorators';
import { runWithContext, tryGetContext } from '../context/request-context';
import {
  InternalHttpClient,
  InternalTokenService,
  type InternalGrant,
} from './internal-http-client';

/**
 * What the receiving guard makes of the requests InternalHttpClient sends:
 * the token it puts on the wire carries exactly the authority the grant names
 * (ADR-020, ADR-035) — the signed tenant of a SERVICE grant, no tenant and no
 * service authority for a RELAY, one audience — and an unsigned header still
 * selects nothing.
 */

const SECRET = randomBytes(32).toString('hex');
const tokens = new InternalTokenService(SECRET, 'rasta-internal', 300);
const tokenKey: TestInternalTokenKey = {
  secret: SECRET,
  issuer: 'rasta-internal',
  ttlSeconds: 300,
};
const ORG_A = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YA';
const ORG_B = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YB';
const INTERNAL = { allowService: ['fleet-service'] };
const PUBLIC = { publicReason: 'Self-registration' };

/** The headers the client actually sends for a grant, captured at the transport. */
async function sentHeaders(
  grant: InternalGrant,
  callerHeaders: Record<string, string> = {},
): Promise<Record<string, string>> {
  let sent: Record<string, string> = {};
  const transport = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    sent = init?.headers as Record<string, string>;
    return new Response('{}');
  }) as typeof fetch;
  const sender = await new InternalHttpClient(tokens, transport).authorize(grant);
  await sender.send('http://identity.test/v1/internal/x', { headers: callerHeaders });
  return sent;
}

async function activate(
  endpoint: { allowService?: string[]; publicReason?: string },
  headers: Record<string, string>,
): Promise<{ authType?: string; callerService?: string; organizationId?: string }> {
  const reflector = {
    getAllAndOverride: (key: string) =>
      key === IS_PUBLIC_KEY
        ? endpoint.publicReason
          ? { public: true, reason: endpoint.publicReason }
          : undefined
        : key === ALLOW_SERVICE_KEY
          ? endpoint.allowService
          : undefined,
  } as unknown as Reflector;
  const guard = new AuthGuard(reflector, {
    serviceName: 'identity-service',
    tokenVerifier: {} as TokenVerifier,
    internalTokens: tokens,
  });
  const request = { headers };
  const execution = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
  return runWithContext(
    {
      correlationId: 'COR_1',
      requestId: 'REQ_1',
      roles: [],
      organizationIds: [],
      authType: 'ANONYMOUS',
      startedAt: Date.now(),
    },
    async () => {
      await guard.canActivate(execution);
      const context = tryGetContext();
      return {
        authType: context?.authType,
        callerService: context?.callerService,
        organizationId: context?.organizationId,
      };
    },
  );
}

describe('InternalHttpClient — what the receiving guard accepts', () => {
  it('a SERVICE grant acts for its signed tenant', async () => {
    const headers = await sentHeaders({
      from: 'fleet-service',
      to: 'identity-service',
      purpose: 'SERVICE',
      organizationId: ORG_A,
    });
    await expect(activate(INTERNAL, headers)).resolves.toEqual({
      authType: 'SERVICE',
      callerService: 'fleet-service',
      organizationId: ORG_A,
    });
  });

  it('a header that disagrees with the signed tenant is refused', async () => {
    const headers = await sentHeaders(
      { from: 'fleet-service', to: 'identity-service', purpose: 'SERVICE', organizationId: ORG_A },
      { 'x-organization-id': ORG_B },
    );
    await expect(activate(INTERNAL, headers)).rejects.toMatchObject({
      code: 'SERVICE_TENANT_CONTEXT_INVALID',
      status: 403,
    });
  });

  it('a tenant-less grant selects no tenant, whatever header travels with it', async () => {
    const headers = await sentHeaders({
      from: 'fleet-service',
      to: 'identity-service',
      purpose: 'SERVICE',
    });
    const result = await activate(INTERNAL, headers);
    expect(result.authType).toBe('SERVICE');
    expect(result.organizationId).toBeUndefined();
  });

  it('a RELAY carries no service authority and no tenant', async () => {
    const headers = await sentHeaders({
      from: 'api-gateway',
      to: 'identity-service',
      purpose: 'RELAY',
    });
    await expect(activate(INTERNAL, headers)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const relayed = await activate(PUBLIC, headers);
    expect(relayed.authType).toBe('ANONYMOUS');
    expect(relayed.organizationId).toBeUndefined();
  });

  it('a token minted for another audience is refused', async () => {
    const headers = await sentHeaders({
      from: 'fleet-service',
      to: 'economic-service',
      purpose: 'SERVICE',
      organizationId: ORG_A,
    });
    await expect(activate(INTERNAL, headers)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('a caller-provided internal header never reaches the guard in place of the minted one', async () => {
    const forged = await mintTestInternalToken(
      tokenKey,
      'fleet-service',
      'identity-service',
      'SERVICE',
      ORG_B,
    );
    const headers = await sentHeaders(
      { from: 'fleet-service', to: 'identity-service', purpose: 'SERVICE', organizationId: ORG_A },
      { 'X-Internal-Token': forged },
    );
    expect(
      Object.keys(headers).filter((name) => name.toLowerCase() === 'x-internal-token'),
    ).toEqual(['x-internal-token']);
    await expect(activate(INTERNAL, headers)).resolves.toMatchObject({ organizationId: ORG_A });
  });
});
