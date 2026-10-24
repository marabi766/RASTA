import { randomBytes } from 'node:crypto';
import {
  RastaError,
  runWithContext,
  type AuthState,
  type RequestContext,
} from '@rasta/nest-common';
import { registry } from '@rasta/observability';
import { GatewayController } from '../proxy/gateway.controller';
import type { ProxyService } from '../proxy/proxy.service';
import type { RateLimiter } from '../proxy/rate-limiter';
import type { GatewayEnv } from '../config/env';
import {
  RevocationFeed,
  type RevocationLogMessage,
  type RevocationLogSource,
} from './revocation-feed';
import { RevocationList, revocationTiming } from './revocation-list';
import { RevocationGate } from './revocation-gate';

/**
 * The gateway's decision (ADR-060, gateway revocation list addendum § 6–§ 8): who is evaluated,
 * what is refused and with which code, that it fails closed, and that a refused request — a
 * payment retried with its key included — reaches nothing upstream.
 */

const T0 = Date.parse('2026-10-24T10:00:00.000Z');
const NOW = T0 + 60_000;
const timing = revocationTiming(900, 5, 10);

function feedStub(state: { current: boolean; caughtUp?: boolean; failed?: boolean }) {
  return {
    isCurrent: () => state.current,
    hasCaughtUp: () => state.caughtUp ?? state.current,
    hasFailed: () => state.failed ?? false,
  } as unknown as RevocationFeed;
}

function gateWith(options: { current?: boolean; revokedAt?: number } = {}) {
  const list = new RevocationList(timing, 1_000);
  if (options.revokedAt !== undefined) {
    list.apply(
      {
        kind: 'revoke',
        userId: 'U1',
        organizationId: 'ORG_A',
        roles: ['DRIVER'],
        atMs: options.revokedAt,
        membershipId: 'M1',
        seq: 1,
        ends: false,
      },
      options.revokedAt,
    );
  }
  const state = { current: options.current ?? true, caughtUp: true };
  const gate = RevocationGate.enforce(list, feedStub(state), {
    retryAfterSeconds: 7,
    now: () => NOW,
  });
  return { gate, list, state };
}

const userAuth = (
  overrides: Partial<AuthState> = {},
  token: Partial<NonNullable<AuthState['token']>> = {},
) =>
  ({
    authType: 'USER',
    userId: 'U1',
    platformUserId: true,
    organizationId: 'ORG_A',
    roles: ['DRIVER'],
    token: {
      issuedAt: NOW - 30_000,
      // The realm's lifetime from whatever `iat` the test chose, unless it chose `exp` too.
      expiresAt: ('issuedAt' in token ? (token.issuedAt ?? NOW) : NOW - 30_000) + 900_000,
      tenantRoles: ['DRIVER'],
      ...token,
    },
    ...overrides,
  }) satisfies AuthState;

function refusal(gate: RevocationGate, auth: AuthState | undefined) {
  const headers: Record<string, string> = {};
  try {
    gate.check(auth, { setHeader: (name, value) => (headers[name] = value) });
  } catch (error) {
    return { error: error as RastaError, headers };
  }
  return undefined;
}

describe('RevocationGate — who is evaluated', () => {
  it('off evaluates nothing', () => {
    expect(
      refusal(RevocationGate.off(), userAuth({ platformUserId: false }, { issuedAt: undefined })),
    ).toBeUndefined();
    expect(RevocationGate.off().isReady()).toBe(true);
  });

  it.each([
    ['anonymous', { authType: 'ANONYMOUS', roles: [] }],
    ['a service token', { authType: 'SERVICE', roles: [], callerService: 'fleet-service' }],
    ['a user acting for no organization', userAuth({ organizationId: undefined })],
  ] as const)(
    '%s names no pair and passes even while the list cannot be vouched for',
    (_label, auth) => {
      expect(refusal(gateWith({ current: false }).gate, auth as AuthState)).toBeUndefined();
    },
  );

  it('a request without any auth state is refused, not read as anonymous', () => {
    expect(refusal(gateWith().gate, undefined)?.error.code).toBe('TOKEN_INVALID');
  });

  it('a tenant-scoped user without the platform id is refused: the list is keyed by it', () => {
    const refused = refusal(
      gateWith().gate,
      userAuth({ platformUserId: false, userId: 'kc-subject' }),
    );
    expect(refused?.error.code).toBe('FORBIDDEN');
  });
});

describe('RevocationGate — the token facts', () => {
  it('refuses a token without `iat` rather than defaulting it', () => {
    expect(refusal(gateWith().gate, userAuth({}, { issuedAt: undefined }))?.error.code).toBe(
      'TOKEN_INVALID',
    );
  });

  it('refuses an `iat` beyond the clock tolerance in the future, admits one within it', () => {
    const { gate } = gateWith();
    expect(
      refusal(gate, userAuth({}, { issuedAt: NOW + 5_001, expiresAt: NOW + 600_000 }))?.error.code,
    ).toBe('TOKEN_INVALID');
    expect(
      refusal(gate, userAuth({}, { issuedAt: NOW + 5_000, expiresAt: NOW + 600_000 })),
    ).toBeUndefined();
  });

  it('refuses a lifetime above the supported one: the list would forget before the token expires', () => {
    const { gate } = gateWith();
    const issuedAt = NOW - 1_000;
    expect(
      refusal(gate, userAuth({}, { issuedAt, expiresAt: issuedAt + 900_001 }))?.error.code,
    ).toBe('TOKEN_INVALID');
    expect(
      refusal(gate, userAuth({}, { issuedAt, expiresAt: issuedAt + 900_000 })),
    ).toBeUndefined();
  });

  it('refuses a user token that carries no token facts at all', () => {
    expect(refusal(gateWith().gate, userAuth({ token: undefined }))?.error.code).toBe(
      'TOKEN_INVALID',
    );
  });
});

describe('RevocationGate — the decision', () => {
  it('refuses a token issued before the revocation with TOKEN_REVOKED, saying nothing of why', () => {
    const refused = refusal(
      gateWith({ revokedAt: T0 }).gate,
      userAuth({}, { issuedAt: T0 - 1_000 }),
    );
    expect(refused?.error.code).toBe('TOKEN_REVOKED');
    expect(refused?.error.status).toBe(401);
    const said = JSON.stringify({
      message: refused?.error.message,
      details: refused?.error.details,
    });
    for (const detail of ['U1', 'ORG_A', 'DRIVER', 'ROLE', 'MEMBERSHIP', String(T0)]) {
      expect(said).not.toContain(detail);
    }
  });

  it('admits a token issued after the revocation carrying the roles still held', () => {
    expect(
      refusal(
        gateWith({ revokedAt: T0 }).gate,
        userAuth({}, { issuedAt: T0 + timing.graceMs + 1_000 }),
      ),
    ).toBeUndefined();
  });

  it('refuses a token issued after the revocation that still carries a removed role', () => {
    const refused = refusal(
      gateWith({ revokedAt: T0 }).gate,
      userAuth(
        {},
        { issuedAt: T0 + timing.graceMs + 1_000, tenantRoles: ['DRIVER', 'ORGANIZATION_ADMIN'] },
      ),
    );
    expect(refused?.error.code).toBe('TOKEN_REVOKED');
  });

  it('fails closed: a list that cannot be vouched for refuses every pair with 503 and Retry-After', () => {
    const refused = refusal(gateWith({ current: false }).gate, userAuth());
    expect(refused?.error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(refused?.error.status).toBe(503);
    expect(refused?.headers['Retry-After']).toBe('7');
  });

  it('fails closed: a held list refuses a pair it has no entry for', () => {
    const { gate, list } = gateWith();
    list.hold(T0);
    expect(refusal(gate, userAuth({ userId: 'U2', organizationId: 'ORG_B' }))?.error.code).toBe(
      'UPSTREAM_UNAVAILABLE',
    );
  });

  it('tenant isolation: U1 revoked in ORG_A still acts in ORG_B, and U2 in ORG_A', () => {
    const { gate } = gateWith({ revokedAt: T0 });
    const old = { issuedAt: T0 - 1_000 };
    expect(refusal(gate, userAuth({}, old))?.error.code).toBe('TOKEN_REVOKED');
    expect(refusal(gate, userAuth({ organizationId: 'ORG_B' }, old))).toBeUndefined();
    expect(refusal(gate, userAuth({ userId: 'U2' }, old))).toBeUndefined();
  });

  it('counts refusals by reason alone — no label names a user or an organization', async () => {
    refusal(gateWith({ revokedAt: T0 }).gate, userAuth({}, { issuedAt: T0 - 1_000 }));
    const metric = await registry.getSingleMetricAsString(
      'rasta_gateway_revocation_refusals_total',
    );
    expect(metric).toContain('reason="revoked"');
    expect(metric).not.toMatch(/U1|ORG_A|user|organization/);
  });
});

describe('RevocationGate — readiness', () => {
  it('is not ready before the feed has caught up once, nor after its reader failed', () => {
    const list = new RevocationList(timing, 10);
    const state = { current: false, caughtUp: false, failed: false };
    const gate = RevocationGate.enforce(list, feedStub(state), {
      retryAfterSeconds: 7,
      now: () => NOW,
    });
    expect(gate.isReady()).toBe(false);
    state.caughtUp = true;
    expect(gate.isReady()).toBe(true);
    state.failed = true;
    expect(gate.isReady()).toBe(false);
  });

  it('stays ready while stale or held — every replica shares that — but refuses every pair', () => {
    const { gate, list, state } = gateWith();
    expect(gate.isRefusingEveryPair()).toBe(false);
    state.current = false;
    expect(gate.isReady()).toBe(true);
    expect(gate.isRefusingEveryPair()).toBe(true);
    state.current = true;
    list.hold(NOW);
    expect(gate.isRefusingEveryPair()).toBe(true);
  });
});

describe('a refused request reaches nothing upstream — a retried payment included', () => {
  const KEY = `pay-${randomBytes(8).toString('hex')}`;
  const env = {
    GATEWAY_RATE_LIMIT_MAX: 300,
    GATEWAY_RATE_LIMIT_WINDOW_MS: 60_000,
    GATEWAY_TENANT_RATE_LIMIT_MAX: 3000,
    GATEWAY_ANON_RATE_LIMIT_MAX: 60,
  } as unknown as GatewayEnv;
  const context: RequestContext = {
    correlationId: 'COR-REV',
    requestId: 'REQ-REV',
    organizationId: 'ORG_A',
    userId: 'U1',
    roles: ['DRIVER'],
    organizationIds: ['ORG_A'],
    authType: 'USER',
    startedAt: 0,
  };

  async function send(gate: RevocationGate, method: string, path: string, auth: AuthState) {
    const forward = jest.fn(async () => ({ status: 200, headers: {}, body: {} }));
    const consume = jest.fn(async () => ({
      allowed: true,
      limit: 1,
      remaining: 1,
      resetAt: 0,
      retryAfterSeconds: 0,
    }));
    const controller = new GatewayController(
      { forward } as unknown as ProxyService,
      { consume } as unknown as RateLimiter,
      env,
      gate,
    );
    const request = {
      method,
      path,
      originalUrl: path,
      // A form opened before the demotion, submitted after it, with the key it was given then.
      headers: { 'idempotency-key': KEY },
      body: { amount: '100000' },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      rastaAuth: auth,
    } as never;
    const response = {
      setHeader: () => undefined,
      status: () => response,
      json: () => undefined,
      end: () => undefined,
    };
    const outcome = await runWithContext(context, () =>
      controller.handle(request, response as never),
    ).then(
      () => 'forwarded',
      (error: RastaError) => error.code,
    );
    return { outcome, forwarded: forward.mock.calls.length, counted: consume.mock.calls.length };
  }

  it.each([
    ['POST', '/v1/payment-intents'],
    ['POST', '/v1/payment-intents/PI_1/refunds'],
    ['POST', '/v1/transactions'],
  ])(
    '%s %s with a pre-revocation token: refused before the rate limit, the key and the upstream',
    async (method, path) => {
      const { gate } = gateWith({ revokedAt: T0 });
      const result = await send(gate, method, path, userAuth({}, { issuedAt: T0 - 1_000 }));
      expect(result).toEqual({ outcome: 'TOKEN_REVOKED', forwarded: 0, counted: 0 });
    },
  );

  it('the same request on a list that cannot be vouched for: refused, nothing forwarded', async () => {
    const { gate } = gateWith({ current: false });
    const result = await send(gate, 'POST', '/v1/payment-intents', userAuth());
    expect(result).toEqual({ outcome: 'UPSTREAM_UNAVAILABLE', forwarded: 0, counted: 0 });
  });

  it('the same request with a token issued after the change is forwarded once', async () => {
    const { gate } = gateWith({ revokedAt: T0 });
    const result = await send(
      gate,
      'POST',
      '/v1/payment-intents',
      userAuth({}, { issuedAt: T0 + timing.graceMs + 1_000 }),
    );
    expect(result.outcome).toBe('forwarded');
    expect(result.forwarded).toBe(1);
  });
  describe('the PR #381 r1 F2 and F3 scenarios, with the key the form was given before', () => {
    const ADMIN = ['DRIVER', 'ORGANIZATION_ADMIN'];
    const PATHS = [
      ['POST', '/v1/payment-intents'],
      ['POST', '/v1/payment-intents/PI_1/refunds'],
      ['POST', '/v1/transactions'],
    ] as const;

    function membershipEvent(
      eventName: string,
      membershipId: string,
      seq: number,
      atMs: number,
      roles: string[] = [],
    ) {
      const pair = { membershipId, userId: 'U1', organizationId: 'ORG_A' };
      return JSON.stringify({
        eventId: `E-${membershipId}-${seq}`,
        eventName,
        eventVersion: 1,
        occurredAt: new Date(atMs).toISOString(),
        producer: 'identity-service',
        aggregateType: 'Membership',
        aggregateId: membershipId,
        tenantId: 'ORG_A',
        correlationId: 'COR-1',
        streamSeq: seq,
        streamKey: membershipId,
        payload:
          eventName === 'MEMBERSHIP_CREATED'
            ? { ...pair, roles }
            : eventName === 'MEMBERSHIP_REVOKED'
              ? { ...pair, reason: 'x' }
              : { ...pair, previousRoles: [], newRoles: roles, reason: 'x' },
      });
    }

    /** A real feed over a one-partition identity topic holding `values`, read to the end. */
    async function enforcedFrom(values: string[]) {
      const list = new RevocationList(timing, 1_000);
      const control: { reading?: Promise<void>; deliver?: (m: RevocationLogMessage) => void } = {};
      const source: RevocationLogSource = {
        highWatermarks: async () => {
          const wait = control.reading;
          control.reading = undefined;
          if (wait) await wait;
          return new Map([[0, values.length]]);
        },
        offsetsAt: async () => new Map([[0, 0]]),
        start: async (_from, onMessage) => {
          control.deliver = onMessage;
        },
        stop: async () => undefined,
      };
      const feed = new RevocationFeed(source, list, {
        maxStalenessMs: 30_000,
        probeIntervalMs: 5_000,
        now: () => NOW,
      });
      await feed.start();
      values.forEach((value, offset) =>
        control.deliver?.({ partition: 0, offset, timestampMs: T0, value }),
      );
      expect(feed.isCurrent()).toBe(true);
      const gate = RevocationGate.enforce(list, feed, { retryAfterSeconds: 7, now: () => NOW });
      return { gate, feed, control };
    }

    // A stale administrator token: issued after the cutoff and its grace, still carrying the
    // role the demotion took away.
    const staleAdmin = () =>
      userAuth({ roles: ADMIN }, { issuedAt: T0 + 20_000, tenantRoles: ADMIN });

    it.each(PATHS)(
      'F2 — %s %s: a demotion stamped before the grant it follows still refuses the old role',
      async (method, path) => {
        const { gate } = await enforcedFrom([
          membershipEvent('ROLE_ASSIGNED', 'M1', 2, T0 + 4_000, ADMIN),
          membershipEvent('ROLE_REVOKED', 'M1', 3, T0 + 1_000, ['DRIVER']),
        ]);
        expect(await send(gate, method, path, staleAdmin())).toEqual({
          outcome: 'TOKEN_REVOKED',
          forwarded: 0,
          counted: 0,
        });
      },
    );

    it.each(PATHS)(
      'F2 — %s %s: a delayed grant of a revoked membership does not lend its role to the new one',
      async (method, path) => {
        const { gate } = await enforcedFrom([
          membershipEvent('MEMBERSHIP_CREATED', 'M2', 1, T0 + 20_000, ['DRIVER']),
          membershipEvent('ROLE_ASSIGNED', 'M1', 2, T0 + 23_000, ADMIN),
        ]);
        expect(
          await send(
            gate,
            method,
            path,
            userAuth({}, { issuedAt: T0 + 30_000, tenantRoles: ADMIN }),
          ),
        ).toEqual({ outcome: 'TOKEN_REVOKED', forwarded: 0, counted: 0 });
      },
    );

    // F1, closed with identity writing Keycloak before it stamps the cutoff (D-064, PR #402):
    // the latest administrator token Keycloak may still mint after the demotion is issued at
    // the cutoff plus skew plus propagation — inside the grace.
    it.each(PATHS)(
      'F1 — %s %s: the latest token Keycloak may mint with the removed role is refused, nothing forwarded',
      async (method, path) => {
        const { gate } = await enforcedFrom([
          membershipEvent('ROLE_REVOKED', 'M1', 2, T0, ['DRIVER']),
        ]);
        const latestStale = T0 + timing.clockToleranceMs + timing.propagationMs;
        expect(
          await send(
            gate,
            method,
            path,
            userAuth({ roles: ADMIN }, { issuedAt: latestStale, tenantRoles: ADMIN }),
          ),
        ).toEqual({ outcome: 'TOKEN_REVOKED', forwarded: 0, counted: 0 });
        // The cutoff decides it, not the role restriction: one minted at the same instant with
        // the demoted roles only is refused as well.
        expect(
          await send(
            gate,
            method,
            path,
            userAuth({}, { issuedAt: latestStale, tenantRoles: ['DRIVER'] }),
          ),
        ).toEqual({ outcome: 'TOKEN_REVOKED', forwarded: 0, counted: 0 });
      },
    );

    it.each(PATHS)(
      'F1 — %s %s: a token minted after the grace with the demoted roles is forwarded once',
      async (method, path) => {
        const { gate } = await enforcedFrom([
          membershipEvent('ROLE_REVOKED', 'M1', 2, T0, ['DRIVER']),
        ]);
        const result = await send(
          gate,
          method,
          path,
          userAuth({}, { issuedAt: T0 + timing.graceMs + 1_000, tenantRoles: ['DRIVER'] }),
        );
        expect(result).toMatchObject({ outcome: 'forwarded', forwarded: 1 });
      },
    );

    it.each(PATHS)('F3 — %s %s after stop(): refused, nothing forwarded', async (method, path) => {
      const { gate, feed } = await enforcedFrom([]);
      await feed.stop();
      expect(await send(gate, method, path, userAuth())).toEqual({
        outcome: 'UPSTREAM_UNAVAILABLE',
        forwarded: 0,
        counted: 0,
      });
    });

    it('F3 — a probe resolving after stop() does not let the payment through', async () => {
      const { gate, feed, control } = await enforcedFrom([]);
      let release!: () => void;
      control.reading = new Promise<void>((resolve) => (release = resolve));
      const probing = feed.probe();
      await feed.stop();
      release();
      await probing;
      expect(await send(gate, 'POST', '/v1/payment-intents', userAuth())).toEqual({
        outcome: 'UPSTREAM_UNAVAILABLE',
        forwarded: 0,
        counted: 0,
      });
    });
  });
});
