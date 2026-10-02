import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from 'jose';
import { AuthGuard } from './auth.guard';
import { InternalTokenService, TokenVerifier } from '../auth/token-verifier';
import {
  assertDistinctActors,
  compareActors,
  currentActor,
  type ActorIdentity,
} from '../auth/separation-of-duties';
import { AllowService, RequirePlatformUserId } from '../decorators';
import { runWithContext, tryGetContext, type RequestContext } from '../context/request-context';
import { RastaError } from '../errors/rasta-error';

/**
 * One person, two user ids (#188) — through the real token verifier, against a
 * JWKS served from this process, and the real `AuthGuard` reading real
 * decorators with Nest's own `Reflector`. Nothing in the path under test is a
 * stub.
 *
 * The guard sets `userId = rasta_uid ?? sub`, so these three tokens for one
 * subject carry three different user ids:
 *
 *   PLATFORM_U1   sub alice, rasta_uid USR_U1
 *   PLATFORM_U2   sub alice, rasta_uid USR_U2   (a wrong IdP mapping)
 *   NO_RASTA_UID  sub alice                     (userId falls back to the subject)
 *
 * Every pair of them must compare as one person, and a route that carries
 * `@RequirePlatformUserId()` must refuse the third outright.
 */

const ISSUER = 'http://keycloak.test/realms/rasta';
const AUDIENCE = 'rasta-api';
const THIS_SERVICE = 'construction-service';
const ALICE = 'kc-subject-alice';
const BOB = 'kc-subject-bob';

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

function userToken(subject: string, rastaUid?: string, issuer = ISSUER): Promise<string> {
  return new SignJWT({
    realm_access: { roles: ['SYSTEM_ADMIN'] },
    ...(rastaUid ? { rasta_uid: rastaUid } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(subject)
    .setIssuer(issuer)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

// The routes, decorated the way a service decorates them.
class FourEyesController {
  @RequirePlatformUserId()
  approve(): void {}

  open(): void {}

  @RequirePlatformUserId()
  @AllowService('fleet-service')
  internalApprove(): void {}
}

@RequirePlatformUserId()
class WholeControllerGuarded {
  decide(): void {}
}

type Route = { cls: new () => object; handler: string };
const APPROVE: Route = { cls: FourEyesController, handler: 'approve' };
const OPEN: Route = { cls: FourEyesController, handler: 'open' };
const INTERNAL_APPROVE: Route = { cls: FourEyesController, handler: 'internalApprove' };
const CLASS_LEVEL: Route = { cls: WholeControllerGuarded, handler: 'decide' };

const internalTokens = new InternalTokenService(
  randomBytes(32).toString('hex'),
  'rasta-internal',
  300,
);

function guard(): AuthGuard {
  return new AuthGuard(new Reflector(), {
    serviceName: THIS_SERVICE,
    tokenVerifier: new TokenVerifier({ jwksUri, issuer: ISSUER, audience: AUDIENCE }),
    internalTokens,
  });
}

function execution(route: Route, headers: Record<string, string>): ExecutionContext {
  const request = { headers };
  const prototype = route.cls.prototype as Record<string, () => void>;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => prototype[route.handler],
    getClass: () => route.cls,
  } as unknown as ExecutionContext;
}

const ANONYMOUS: RequestContext = {
  correlationId: 'COR_1',
  requestId: 'REQ_1',
  organizationIds: [],
  roles: [],
  authType: 'ANONYMOUS',
  startedAt: 0,
};

/** Runs the real guard for one request; returns the context it left, or what it threw. */
async function through(
  route: Route,
  headers: Record<string, string>,
): Promise<{ context?: RequestContext; actor?: ActorIdentity; error?: RastaError }> {
  return runWithContext(ANONYMOUS, async () => {
    try {
      await guard().canActivate(execution(route, headers));
    } catch (error) {
      if (error instanceof RastaError) return { error };
      throw error;
    }
    const context = tryGetContext();
    return {
      context,
      actor: context?.authType === 'USER' ? currentActor() : undefined,
    };
  });
}

async function actorOf(token: string): Promise<ActorIdentity> {
  const { actor, error } = await through(OPEN, { authorization: `Bearer ${token}` });
  if (!actor) throw error ?? new Error('no actor');
  return actor;
}

describe('the stable identity reaches the request context', () => {
  it('a token with rasta_uid: platform id, issuer, subject, platformUserId', async () => {
    const { context } = await through(OPEN, {
      authorization: `Bearer ${await userToken(ALICE, 'USR_U1')}`,
    });
    expect(context).toMatchObject({
      authType: 'USER',
      userId: 'USR_U1',
      issuer: ISSUER,
      subject: ALICE,
      platformUserId: true,
    });
  });

  it('a token without rasta_uid: userId falls back to the subject, platformUserId false', async () => {
    const { context } = await through(OPEN, {
      authorization: `Bearer ${await userToken(ALICE)}`,
    });
    expect(context).toMatchObject({
      userId: ALICE,
      issuer: ISSUER,
      subject: ALICE,
      platformUserId: false,
    });
  });

  it('only the one configured issuer is ever accepted', async () => {
    const { error } = await through(OPEN, {
      authorization: `Bearer ${await userToken(ALICE, 'USR_U1', 'http://evil.test/realms/rasta')}`,
    });
    expect(error).toMatchObject({ code: 'TOKEN_INVALID' });
  });
});

describe('paired tokens for one subject compare as one person', () => {
  it('platform id U1 vs U2 — SAME, and the separation is refused', async () => {
    const proposer = await actorOf(await userToken(ALICE, 'USR_U1'));
    const approver = await actorOf(await userToken(ALICE, 'USR_U2'));
    // The defect: the user ids differ.
    expect(proposer.userId).not.toBe(approver.userId);
    expect(compareActors(proposer, approver)).toBe('SAME');
    expect(() => assertDistinctActors(proposer, approver, 'four eyes')).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
    );
  });

  it('with vs without rasta_uid — SAME, and the separation is refused', async () => {
    const proposer = await actorOf(await userToken(ALICE, 'USR_U1'));
    const approver = await actorOf(await userToken(ALICE));
    expect(proposer.userId).not.toBe(approver.userId);
    expect(compareActors(proposer, approver)).toBe('SAME');
    expect(compareActors(approver, proposer)).toBe('SAME');
  });

  it('against a record that stored only a userId — UNKNOWN, refused with ACTOR_IDENTITY_UNKNOWN', async () => {
    const approver = await actorOf(await userToken(ALICE, 'USR_U2'));
    const recorded: ActorIdentity = { userId: 'USR_U1', issuer: null, subject: null };
    expect(compareActors(recorded, approver)).toBe('UNKNOWN');
    expect(() => assertDistinctActors(recorded, approver, 'four eyes')).toThrow(
      expect.objectContaining({ code: 'ACTOR_IDENTITY_UNKNOWN', status: 422 }),
    );
  });

  it('positive control: two people are DISTINCT and pass', async () => {
    const proposer = await actorOf(await userToken(ALICE, 'USR_U1'));
    const approver = await actorOf(await userToken(BOB, 'USR_U3'));
    expect(compareActors(proposer, approver)).toBe('DISTINCT');
    expect(() => assertDistinctActors(proposer, approver, 'four eyes')).not.toThrow();
  });
});

describe('@RequirePlatformUserId()', () => {
  it('refuses a user token without rasta_uid — 403, fixed message, no claim values', async () => {
    const { error } = await through(APPROVE, {
      authorization: `Bearer ${await userToken(ALICE)}`,
    });
    expect(error).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(error?.message).toBe('This action requires signing in with a platform user account');
    expect(JSON.stringify({ ...error, message: error?.message })).not.toContain(ALICE);
  });

  it('refuses it on a class-level decoration too', async () => {
    const { error } = await through(CLASS_LEVEL, {
      authorization: `Bearer ${await userToken(ALICE)}`,
    });
    expect(error).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('admits the same person with rasta_uid', async () => {
    const { context, error } = await through(APPROVE, {
      authorization: `Bearer ${await userToken(ALICE, 'USR_U1')}`,
    });
    expect(error).toBeUndefined();
    expect(context).toMatchObject({ userId: 'USR_U1', platformUserId: true });
  });

  it('leaves an undecorated route as it was: the token without rasta_uid is admitted', async () => {
    const { context, error } = await through(OPEN, {
      authorization: `Bearer ${await userToken(ALICE)}`,
    });
    expect(error).toBeUndefined();
    expect(context?.userId).toBe(ALICE);
  });

  it('does not touch a service caller: @AllowService decides', async () => {
    const allowed = await through(INTERNAL_APPROVE, {
      'x-internal-token': await internalTokens.issue('fleet-service', THIS_SERVICE, 'SERVICE'),
    });
    expect(allowed.error).toBeUndefined();
    expect(allowed.context).toMatchObject({ authType: 'SERVICE', callerService: 'fleet-service' });

    const refused = await through(INTERNAL_APPROVE, {
      'x-internal-token': await internalTokens.issue('asset-service', THIS_SERVICE, 'SERVICE'),
    });
    expect(refused.error).toMatchObject({ code: 'FORBIDDEN' });
  });
});
