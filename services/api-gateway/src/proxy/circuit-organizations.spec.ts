import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { InternalTokenService, RastaError, runWithContext } from '@rasta/nest-common';
import { registry } from '@rasta/observability';
import { gatewayEnvSchema, type GatewayEnv } from '../config/env';
import { SERVICE_NAMES, type ServiceUrls } from '../config/routes';
import {
  CircuitBreakers,
  MAX_TRACKED_CALLERS,
  VOTE_WINDOW_COOLDOWNS,
  type CircuitPermit,
} from './circuit-breaker';
import { ProxyService, proxyOptionsOf } from './proxy.service';

/**
 * FU-085: a service 5xx or a deadline is something one tenant can provoke, so one
 * organization alone can never open the circuit every tenant shares, while an
 * outage many tenants see opens it on the very failure it always did.
 */

const THRESHOLD = 5;
const COOLDOWN_MS = 30_000;

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  jest.spyOn(Logger.prototype, 'error').mockImplementation();
  jest.spyOn(Logger.prototype, 'log').mockImplementation();
});
afterAll(() => jest.restoreAllMocks());

// ---------------------------------------------------------------------------
// Over real HTTP: a service with one route that crashes and one that hangs
// ---------------------------------------------------------------------------

describe('forwarding: who failed decides who is refused', () => {
  let server: Server;
  let seen: string[];
  let outage: boolean;
  let proxy: ProxyService;
  let clock: number;

  beforeEach(async () => {
    seen = [];
    outage = false;
    clock = 1_000;
    server = createServer((req, res) => {
      seen.push(req.url ?? '');
      if (req.url === '/v1/users/hang') return;
      res.writeHead(outage || req.url === '/v1/users/poison' ? 500 : 200, {
        'content-type': 'application/json',
      });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const urls = Object.fromEntries(
      SERVICE_NAMES.map((name) => [
        `${name.toUpperCase()}_SERVICE_URL`,
        `http://127.0.0.1:${port}`,
      ]),
    ) as unknown as ServiceUrls;
    // The breaker's own default: nothing here sets how many organizations it takes.
    proxy = new ProxyService(
      urls,
      new InternalTokenService(randomBytes(32).toString('hex'), 'rasta-internal', 300),
      { timeoutMs: 300, failureThreshold: THRESHOLD, resetAfterMs: COOLDOWN_MS, now: () => clock },
    );
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  /** A person of its own per organization, unless `subject` says who it is. */
  function forward(
    organizationId: string | undefined,
    path = '/v1/users/me',
    headers: Record<string, string> = {},
    subject = organizationId && `SUB_${organizationId}`,
  ) {
    return runWithContext(
      {
        correlationId: 'req-fu085',
        requestId: 'req-fu085',
        ...(organizationId ? { organizationId } : {}),
        // A user id per organization: one person's tokens may carry two (#188).
        ...(subject ? { subject, userId: `USR_${organizationId ?? subject}` } : {}),
        roles: [],
        organizationIds: organizationId ? [organizationId] : [],
        authType: subject ? ('USER' as const) : ('ANONYMOUS' as const),
        startedAt: 0,
      },
      () =>
        proxy.forward({
          service: 'identity',
          method: 'GET',
          path,
          query: '',
          headers,
          body: undefined,
        }),
    );
  }

  it.each([
    ['5xx', '/v1/users/poison', 'UPSTREAM_UNAVAILABLE'],
    ['deadlines', '/v1/users/hang', 'UPSTREAM_TIMEOUT'],
  ])('one tenant hammering %s opens nothing for another', async (_label, path, code) => {
    for (let i = 0; i < THRESHOLD; i += 1) {
      await expect(forward('ORG_ATTACKER', path)).rejects.toMatchObject({ code });
    }
    for (let i = 0; i < 20; i += 1) {
      await expect(forward('ORG_ATTACKER', path)).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
    }

    await expect(forward('ORG_OTHER')).resolves.toMatchObject({ status: 200 });
    expect(proxy.circuitStates().identity).toMatchObject({ open: false, state: 'CLOSED' });
    // It shed itself: nothing past its own threshold reached the service.
    expect(seen.filter((url) => url === path)).toHaveLength(THRESHOLD);
  });

  it('a header cannot make one caller look like many organizations', async () => {
    for (let i = 0; i < 3 * THRESHOLD; i += 1) {
      await forward('ORG_ATTACKER', '/v1/users/poison', { 'x-organization-id': `ORG_${i}` }).catch(
        () => undefined,
      );
    }
    await expect(forward('ORG_OTHER')).resolves.toMatchObject({ status: 200 });
    expect(seen.filter((url) => url === '/v1/users/poison')).toHaveLength(THRESHOLD);
  });

  it('one person acting for three of its organizations is one vote, not three', async () => {
    outage = true;
    for (let i = 0; i < 4 * THRESHOLD; i += 1) {
      await forward(`ORG_${i % 3}`, '/v1/users/me', {}, 'SUB_ONE_PERSON').catch(() => undefined);
    }
    expect(proxy.circuitStates().identity?.state).toBe('CLOSED');
    // Two more people make it a genuine outage.
    await forward('ORG_X').catch(() => undefined);
    await forward('ORG_Y').catch(() => undefined);
    expect(proxy.circuitStates().identity?.state).toBe('OPEN');
  });

  it('a verified caller without an organization sheds only itself, not others without one', async () => {
    for (let i = 0; i < THRESHOLD; i += 1) {
      await forward(undefined, '/v1/users/poison', {}, 'SUB_NO_ORG').catch(() => undefined);
    }
    await expect(forward(undefined, '/v1/users/me', {}, 'SUB_NO_ORG')).rejects.toMatchObject({
      cause: { reason: 'caller-shed' },
    });
    await expect(
      forward(undefined, '/v1/users/me', {}, 'SUB_PLATFORM_ADMIN'),
    ).resolves.toMatchObject({ status: 200 });
    await expect(forward(undefined)).resolves.toMatchObject({ status: 200 });
  });

  it('an organization and anonymous callers together open nothing', async () => {
    for (let i = 0; i < 3 * THRESHOLD; i += 1) {
      await forward('ORG_ATTACKER', '/v1/users/poison').catch(() => undefined);
      await forward(undefined, '/v1/users/poison').catch(() => undefined);
    }
    await expect(forward('ORG_OTHER')).resolves.toMatchObject({ status: 200 });
  });

  it('an outage many tenants see opens on the very failure it always did', async () => {
    outage = true;
    for (let i = 1; i < THRESHOLD; i += 1) {
      await expect(forward(`ORG_${i}`)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
      expect(proxy.circuitStates().identity?.state).toBe('CLOSED');
    }
    await expect(forward(`ORG_${THRESHOLD}`)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    expect(proxy.circuitStates().identity).toEqual({
      failures: THRESHOLD,
      open: true,
      state: 'OPEN',
    });

    seen.length = 0;
    await expect(forward('ORG_NEVER_FAILED')).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      retryAfterSeconds: 30,
    });
    expect(seen).toHaveLength(0);

    // HALF_OPEN recovers as it always did: one probe, whose success closes it.
    outage = false;
    clock += COOLDOWN_MS;
    await expect(forward('ORG_NEVER_FAILED')).resolves.toMatchObject({ status: 200 });
    expect(proxy.circuitStates().identity?.state).toBe('CLOSED');
    expect(seen).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The rules, on the breaker's own clock
// ---------------------------------------------------------------------------

/** Each organization is a person of its own, unless the test names one. */
class People extends CircuitBreakers {
  override admit(
    service: Parameters<CircuitBreakers['admit']>[0],
    organizationId: string | undefined,
    person: string | undefined = organizationId ? `P_${organizationId}` : undefined,
  ): CircuitPermit {
    return super.admit(service, organizationId, person);
  }
}

function breakers(options: { organizationsToOpen?: number; failureThreshold?: number } = {}) {
  let clock = 1_000;
  const circuits = new People({
    failureThreshold: 3,
    resetAfterMs: COOLDOWN_MS,
    now: () => clock,
    // These schedules are outages: the gateway's own check finds the service not ready.
    checkReady: () => false,
    ...options,
  });
  return {
    circuits,
    advance: (ms: number) => (clock += ms),
    fail: (org: string | undefined, person?: string) =>
      circuits.settle(circuits.admit('identity', org, person), 'failure'),
    succeed: (org: string | undefined) =>
      circuits.settle(circuits.admit('identity', org), 'success'),
    state: () => circuits.states().identity?.state,
  };
}

function refused(admit: () => unknown): RastaError {
  try {
    admit();
  } catch (error) {
    if (error instanceof RastaError) return error;
    throw error;
  }
  throw new Error('admitted');
}

describe('opening takes several organizations', () => {
  it('two organizations never open it, however often they fail; the third does', () => {
    const b = breakers();
    // All admitted first, as a burst is: neither is shed yet when these settle.
    const burst = Array.from({ length: 40 }, (_, i) =>
      b.circuits.admit('identity', i % 2 === 0 ? 'ORG_A' : 'ORG_B'),
    );
    for (const permit of burst) b.circuits.settle(permit, 'failure');
    expect(b.state()).toBe('CLOSED');
    b.fail('ORG_C');
    expect(b.state()).toBe('OPEN');
  });

  it('a failure run below the threshold opens nothing, however many organizations', () => {
    const b = breakers({ failureThreshold: 5 });
    for (const org of ['ORG_A', 'ORG_B', 'ORG_C', 'ORG_D']) b.fail(org);
    expect(b.state()).toBe('CLOSED');
    b.fail('ORG_E');
    expect(b.state()).toBe('OPEN');
  });

  it('a failure too old stops counting, exactly at the end of its window', () => {
    const windowMs = VOTE_WINDOW_COOLDOWNS * COOLDOWN_MS;
    const stale = breakers();
    stale.fail('ORG_OLD');
    stale.advance(windowMs);
    stale.fail('ORG_A');
    stale.fail('ORG_B');
    expect(stale.state()).toBe('CLOSED');

    const recent = breakers();
    recent.fail('ORG_OLD');
    recent.advance(windowMs - 1);
    recent.fail('ORG_A');
    recent.fail('ORG_B');
    expect(recent.state()).toBe('OPEN');
  });

  it('an organization’s later success withdraws its failure, while another keeps failing', () => {
    const b = breakers();
    b.fail('ORG_B');
    const later = b.circuits.admit('identity', 'ORG_B');
    b.fail('ORG_A');
    b.circuits.settle(later, 'success');
    expect(b.circuits.states().identity?.failures).toBe(2); // not the run: A failed after it
    b.fail('ORG_C');
    expect(b.state()).toBe('CLOSED');
    b.fail('ORG_D');
    expect(b.state()).toBe('OPEN');
  });

  it('an older success of the same organization withdraws nothing', () => {
    const b = breakers();
    const older = b.circuits.admit('identity', 'ORG_B');
    b.fail('ORG_B');
    b.circuits.settle(older, 'success');
    b.fail('ORG_A');
    b.fail('ORG_C');
    expect(b.state()).toBe('OPEN');
  });

  it('failures before a clearing success are not evidence for the next run', () => {
    const b = breakers();
    b.fail('ORG_A');
    b.fail('ORG_B');
    b.succeed('ORG_D');
    expect(b.circuits.states().identity?.failures).toBe(0);
    for (let i = 0; i < 3; i += 1) b.fail('ORG_C');
    expect(b.state()).toBe('CLOSED');
  });

  it('once it has closed, what opened it does not count for one organization alone', () => {
    const b = breakers();
    for (const org of ['ORG_A', 'ORG_B', 'ORG_C']) b.fail(org);
    expect(b.state()).toBe('OPEN');
    b.advance(COOLDOWN_MS);
    b.succeed('ORG_D');
    expect(b.state()).toBe('CLOSED');
    for (let i = 0; i < 3; i += 1) b.fail('ORG_A');
    expect(b.state()).toBe('CLOSED');
  });
});

describe('an organization alone sheds only itself', () => {
  it('refuses it for a cooldown, with the time left; the first failure after sheds it again', () => {
    const b = breakers();
    for (let i = 0; i < 2; i += 1) b.fail('ORG_A');
    b.circuits.settle(b.circuits.admit('identity', 'ORG_A'), 'release');
    b.circuits.admit('identity', 'ORG_A'); // below its threshold: still forwarded
    b.fail('ORG_A');

    b.advance(10_500);
    const error = refused(() => b.circuits.admit('identity', 'ORG_A'));
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.retryAfterSeconds).toBe(20);
    expect(b.circuits.admit('identity', 'ORG_B').probe).toBe(false);

    b.advance(19_500);
    b.fail('ORG_A');
    expect(refused(() => b.circuits.admit('identity', 'ORG_A')).retryAfterSeconds).toBe(30);
    expect(b.state()).toBe('CLOSED');
  });

  it('its own success ends it', () => {
    const b = breakers();
    for (let i = 0; i < 3; i += 1) b.fail('ORG_A');
    b.advance(COOLDOWN_MS);
    b.succeed('ORG_A');
    b.fail('ORG_A');
    expect(b.circuits.admit('identity', 'ORG_A').probe).toBe(false);
  });

  it('only on the service it failed on', () => {
    const b = breakers();
    for (let i = 0; i < 3; i += 1) b.fail('ORG_A');
    expect(b.circuits.admit('organization', 'ORG_A').probe).toBe(false);
  });

  it('counts refusals by service alone: no tenant in the metric or on readiness', async () => {
    const b = breakers();
    for (let i = 0; i < 3; i += 1) b.fail('ORG_METRIC_LEAK');
    refused(() => b.circuits.admit('identity', 'ORG_METRIC_LEAK'));

    expect(JSON.stringify(b.circuits.states())).not.toContain('ORG_METRIC_LEAK');
    const metrics = await registry.metrics();
    expect(metrics).toMatch(
      /rasta_gateway_circuit_shed_refusals_total\{service="identity"\} [1-9]/,
    );
    expect(metrics).not.toContain('ORG_METRIC_LEAK');
  });
});

describe('no organization is its own bucket and never counts toward opening', () => {
  it('even where two organizations would be enough', () => {
    const b = breakers({ organizationsToOpen: 2, failureThreshold: 3 });
    for (let i = 0; i < 2; i += 1) b.fail(undefined);
    b.fail('ORG_A');
    b.fail(undefined);
    expect(b.state()).toBe('CLOSED');
    b.fail('ORG_B');
    expect(b.state()).toBe('OPEN');
  });

  it('verified people without an organization never count toward opening either', () => {
    const b = breakers({ organizationsToOpen: 2, failureThreshold: 3 });
    b.fail(undefined, 'P_NO_ORG_1');
    b.fail(undefined, 'P_NO_ORG_2');
    b.fail('ORG_A');
    expect(b.state()).toBe('CLOSED');
    b.fail('ORG_B');
    expect(b.state()).toBe('OPEN');
  });

  it('sheds only itself, and every such caller is the same bucket', () => {
    const b = breakers();
    b.fail(undefined);
    b.fail('');
    b.fail(undefined);
    expect(refused(() => b.circuits.admit('identity', '')).code).toBe('UPSTREAM_UNAVAILABLE');
    expect(b.circuits.admit('identity', 'ORG_A').probe).toBe(false);
  });

  it('cannot be reached by an organization named after it', () => {
    const b = breakers();
    for (let i = 0; i < 3; i += 1) b.fail(undefined);
    expect(b.circuits.admit('identity', 'no-organization').probe).toBe(false);
  });
});

describe('re-opening takes as many organizations', () => {
  function opened() {
    const b = breakers();
    for (const org of ['ORG_A', 'ORG_B', 'ORG_C']) b.fail(org);
    expect(b.state()).toBe('OPEN');
    b.advance(COOLDOWN_MS);
    return b;
  }

  it('one failed probe sheds its organization; the next caller probes and recovers it', () => {
    const b = opened();
    b.fail('ORG_ATTACKER');
    expect(b.state()).toBe('HALF_OPEN');
    expect(refused(() => b.circuits.admit('identity', 'ORG_ATTACKER')).retryAfterSeconds).toBe(30);
    b.succeed('ORG_OTHER');
    expect(b.state()).toBe('CLOSED');
  });

  it('it takes that many failed probes, one at a time, then a fresh cooldown', () => {
    const b = opened();
    b.fail('ORG_A');
    b.fail('ORG_B');
    expect(b.state()).toBe('HALF_OPEN');
    const third = b.circuits.admit('identity', 'ORG_C');
    expect(third.probe).toBe(true);
    expect(refused(() => b.circuits.admit('identity', 'ORG_D')).retryAfterSeconds).toBe(1);
    b.circuits.settle(third, 'failure');
    expect(b.state()).toBe('OPEN');
    expect(refused(() => b.circuits.admit('identity', 'ORG_D')).retryAfterSeconds).toBe(30);
    b.advance(COOLDOWN_MS);
    b.succeed('ORG_D');
    expect(b.state()).toBe('CLOSED');
  });

  it('what opened it is spent: those organizations must fail a probe again', () => {
    const b = opened();
    b.fail('ORG_D');
    b.fail('ORG_E');
    expect(b.state()).toBe('HALF_OPEN');
  });

  it('alone, it may probe again after a cooldown, so it can still recover', () => {
    const b = opened();
    b.fail('ORG_ONLY');
    b.advance(COOLDOWN_MS - 1);
    expect(refused(() => b.circuits.admit('identity', 'ORG_ONLY')).retryAfterSeconds).toBe(1);
    b.advance(1);
    b.succeed('ORG_ONLY');
    expect(b.state()).toBe('CLOSED');
  });

  it('one attacker, as an organization and as anonymous, cannot keep it open for others', () => {
    const b = opened();
    for (let round = 0; round < 20; round += 1) {
      for (const caller of ['ORG_ATTACKER', undefined, 'ORG_ATTACKER', undefined]) {
        try {
          b.fail(caller);
        } catch {
          // Refused: shed.
        }
      }
      expect(b.state()).toBe('HALF_OPEN');
      b.advance(COOLDOWN_MS);
    }
    expect(b.circuits.admit('identity', 'ORG_OTHER').probe).toBe(true);
  });

  it('an abandoned probe sheds its organization past its deadline; it cannot retake the slot', () => {
    const b = opened();
    const probe = b.circuits.admit('identity', 'ORG_ATTACKER');
    b.circuits.dispatched(probe, 2_000);
    b.circuits.settle(probe, 'abandoned');
    expect(refused(() => b.circuits.admit('identity', 'ORG_OTHER')).retryAfterSeconds).toBe(2);
    b.advance(2_000);

    // Shed for the hold again plus a cooldown: 2 s + 30 s from here.
    expect(refused(() => b.circuits.admit('identity', 'ORG_ATTACKER')).retryAfterSeconds).toBe(32);
    b.advance(2_000 + COOLDOWN_MS - 1);
    expect(refused(() => b.circuits.admit('identity', 'ORG_ATTACKER')).retryAfterSeconds).toBe(1);
    b.succeed('ORG_OTHER');
    expect(b.state()).toBe('CLOSED');
  });

  it('a released probe sheds nobody', () => {
    const b = opened();
    b.circuits.settle(b.circuits.admit('identity', 'ORG_A'), 'release');
    expect(b.circuits.admit('identity', 'ORG_A').probe).toBe(true);
  });
});

describe('adversarial review: what the first version let through', () => {
  const TENDER_DEADLINE_MS = 60_000;

  function opened() {
    const b = breakers();
    for (const org of ['ORG_A', 'ORG_B', 'ORG_C']) b.fail(org);
    b.advance(COOLDOWN_MS);
    return b;
  }

  it('two identities taking turns at holding the probe still leave a slot for everyone else', () => {
    const b = opened();
    const identities: Array<[string | undefined, string | undefined]> = [
      ['ORG_ATTACKER', undefined],
      [undefined, undefined],
      [undefined, 'P_ATTACKER_NO_ORG'],
    ];
    let holds = 0;
    for (;;) {
      let taken: CircuitPermit | undefined;
      for (const [org, person] of identities) {
        try {
          taken = b.circuits.admit('identity', org, person);
          break;
        } catch {
          // Shed or barred: the next identity tries.
        }
      }
      if (!taken) break;
      expect(taken.probe).toBe(true);
      b.circuits.dispatched(taken, TENDER_DEADLINE_MS);
      b.circuits.settle(taken, 'abandoned');
      b.advance(TENDER_DEADLINE_MS);
      holds += 1;
      expect(holds).toBeLessThanOrEqual(2);
    }
    expect(holds).toBe(2);
    b.succeed('ORG_VICTIM');
    expect(b.state()).toBe('CLOSED');
  });

  it('a failed probe without an organization bars every caller without one from the next probe', () => {
    const b = opened();
    b.fail(undefined);
    expect(
      refused(() => b.circuits.admit('identity', undefined, 'P_NO_ORG')).retryAfterSeconds,
    ).toBe(30);
    b.advance(COOLDOWN_MS - 1);
    expect(() => b.circuits.admit('identity', undefined, 'P_NO_ORG')).toThrow(RastaError);
    b.advance(1);
    b.circuits.settle(b.circuits.admit('identity', undefined, 'P_NO_ORG'), 'success');
    expect(b.state()).toBe('CLOSED');
  });

  it('closing lifts the bar', () => {
    const b = opened();
    const held = b.circuits.admit('identity', undefined);
    b.circuits.dispatched(held, TENDER_DEADLINE_MS);
    b.circuits.settle(held, 'abandoned');
    b.advance(TENDER_DEADLINE_MS);
    b.succeed('ORG_D');
    expect(b.state()).toBe('CLOSED');
    for (const org of ['ORG_E', 'ORG_F', 'ORG_G']) b.fail(org);
    b.advance(COOLDOWN_MS);
    expect(b.circuits.admit('identity', undefined, 'P_NO_ORG').probe).toBe(true);
  });

  it('an organization may still probe while those without one are barred', () => {
    const b = opened();
    b.fail(undefined, 'P_NO_ORG');
    expect(b.circuits.admit('identity', 'ORG_D').probe).toBe(true);
  });

  it('stray failures older than one cooldown do not complete one organization’s burst', () => {
    const b = breakers({ failureThreshold: THRESHOLD });
    b.fail('ORG_B');
    b.fail('ORG_C');
    b.advance(VOTE_WINDOW_COOLDOWNS * COOLDOWN_MS);
    for (let i = 0; i < 3; i += 1) b.fail('ORG_ATTACKER');
    expect(b.circuits.states().identity).toMatchObject({ failures: 5, state: 'CLOSED' });
    expect(VOTE_WINDOW_COOLDOWNS).toBe(1);
  });

  it.each([
    [1, 3],
    [2, 3],
    [5, 5],
  ])('threshold %i opens on failure %i, from distinct organizations', (threshold, opensOn) => {
    const b = breakers({ failureThreshold: threshold });
    for (let i = 1; i < opensOn; i += 1) {
      b.fail(`ORG_${i}`);
      expect(b.state()).toBe('CLOSED');
    }
    b.fail('ORG_LAST');
    expect(b.state()).toBe('OPEN');
  });

  it('one person with three memberships is one vote; three people are three', () => {
    const one = breakers();
    for (const org of ['ORG_1', 'ORG_2', 'ORG_3', 'ORG_1', 'ORG_2']) one.fail(org, 'P_SAME');
    expect(one.state()).toBe('CLOSED');
    one.fail('ORG_4', 'P_OTHER');
    expect(one.state()).toBe('CLOSED');
    one.fail('ORG_5', 'P_THIRD');
    expect(one.state()).toBe('OPEN');
  });

  it('an organization’s failure with nobody named behind it never counts toward opening', () => {
    const raw = new CircuitBreakers({
      failureThreshold: 3,
      resetAfterMs: COOLDOWN_MS,
      now: () => 1,
      checkReady: () => false,
    });
    for (const org of ['ORG_A', 'ORG_B', 'ORG_C', 'ORG_D']) {
      raw.settle(raw.admit('identity', org), 'failure');
    }
    expect(raw.states().identity?.state).toBe('CLOSED');
  });

  it('a burst in HALF_OPEN admits exactly one probe', () => {
    const b = opened();
    let admitted = 0;
    for (let i = 0; i < 2_000; i += 1) {
      try {
        b.circuits.admit('identity', i % 3 === 0 ? undefined : `ORG_${i}`);
        admitted += 1;
      } catch {
        // Refused.
      }
    }
    expect(admitted).toBe(1);
  });

  it('one organization, with anonymous help and any mix of outcomes, never opens it', () => {
    const b = breakers({ failureThreshold: THRESHOLD });
    const outcomes = ['failure', 'failure', 'abandoned', 'release'] as const;
    for (let cycle = 0; cycle < 20; cycle += 1) {
      const burst: CircuitPermit[] = [];
      for (let i = 0; i < 100; i += 1) {
        try {
          burst.push(b.circuits.admit('identity', i % 2 ? 'ORG_A' : undefined));
        } catch {
          // Shed.
        }
      }
      burst.forEach((permit, i) => b.circuits.settle(permit, outcomes[i % outcomes.length]!));
      expect(b.state()).toBe('CLOSED');
      b.advance(COOLDOWN_MS);
    }
  });
});

describe('one person cannot monopolize recovery, under any of its identities (#758 r1 R1)', () => {
  const TENDER_DEADLINE_MS = 60_000;
  type Identity = [organizationId: string | undefined, person: string | undefined];
  type Play = 'cancel at once' | 'cancel at second 59' | 'fail at the deadline';

  /**
   * After a genuine outage, the attacker tries every identity it has, first, at
   * every instant the slot frees; the victim gets the slot only when none of them
   * can take it. Returns how many probes the attacker held before that.
   */
  function race(identities: Identity[], play: Play) {
    const b = breakers();
    for (const org of ['ORG_X', 'ORG_Y', 'ORG_Z']) b.fail(org);
    expect(b.state()).toBe('OPEN');
    b.advance(COOLDOWN_MS);
    for (let holds = 0; holds < 30; holds += 1) {
      let taken: CircuitPermit | undefined;
      for (const [org, person] of identities) {
        try {
          taken = b.circuits.admit('identity', org, person);
          break;
        } catch {
          // Excluded: the next identity tries.
        }
      }
      if (!taken) {
        const victim = b.circuits.admit('identity', 'ORG_VICTIM', 'P_VICTIM');
        return { holds, victim };
      }
      b.circuits.dispatched(taken, TENDER_DEADLINE_MS);
      if (play === 'cancel at once') {
        b.circuits.settle(taken, 'abandoned');
        b.advance(TENDER_DEADLINE_MS);
      } else if (play === 'cancel at second 59') {
        b.advance(TENDER_DEADLINE_MS - 1_000);
        b.circuits.settle(taken, 'abandoned');
        b.advance(1_000);
      } else {
        b.advance(TENDER_DEADLINE_MS);
        b.circuits.settle(taken, 'failure');
      }
    }
    return { holds: 30, victim: undefined };
  }

  it.each<[string, Identity[], Play, number]>([
    [
      'three memberships, cancelling at once',
      [
        ['ORG_A', 'P_ATTACKER'],
        ['ORG_B', 'P_ATTACKER'],
        ['ORG_C', 'P_ATTACKER'],
      ],
      'cancel at once',
      1,
    ],
    [
      'two memberships, cancelling at second 59',
      [
        ['ORG_A', 'P_ATTACKER'],
        ['ORG_B', 'P_ATTACKER'],
      ],
      'cancel at second 59',
      1,
    ],
    [
      'two memberships, failing at the deadline',
      [
        ['ORG_A', 'P_ATTACKER'],
        ['ORG_B', 'P_ATTACKER'],
      ],
      'fail at the deadline',
      1,
    ],
    [
      'a membership and anonymous, cancelling at second 59',
      [
        ['ORG_A', 'P_ATTACKER'],
        [undefined, undefined],
      ],
      'cancel at second 59',
      2,
    ],
    [
      'no organization, anonymous and a membership, failing at the deadline',
      [
        [undefined, 'P_ATTACKER'],
        [undefined, undefined],
        ['ORG_A', 'P_ATTACKER'],
      ],
      'fail at the deadline',
      2,
    ],
    [
      'one organization, three of the people it provisioned, cancelling at once',
      [
        ['ORG_A', 'P_ONE'],
        ['ORG_A', 'P_TWO'],
        ['ORG_A', 'P_THREE'],
      ],
      'cancel at once',
      1,
    ],
  ])('%s: another caller gets the slot', (_label, identities, play, maxHolds) => {
    const { holds, victim } = race(identities, play);
    expect(victim?.probe).toBe(true);
    expect(holds).toBeLessThanOrEqual(maxHolds);
  });
});

describe('memory is bounded, whatever the ids', () => {
  beforeAll(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation());
  afterAll(() => jest.restoreAllMocks());

  const tracked = (b: ReturnType<typeof breakers>) =>
    (
      b.circuits as unknown as { circuits: Map<string, { callers: Map<unknown, unknown> }> }
    ).circuits.get('identity')!.callers;

  it('50,000 fake organizations leave at most the cap, least recently failed forgotten first', () => {
    const b = breakers({ organizationsToOpen: 1_000_000, failureThreshold: 1 });
    b.fail('ORG_FIRST');
    b.fail('ORG_TOUCHED');
    for (let i = 0; i < MAX_TRACKED_CALLERS - 2; i += 1) b.fail(`ORG_FAKE_${i}`);
    expect(tracked(b).size).toBe(MAX_TRACKED_CALLERS);
    // Being refused touches nothing: ORG_FIRST is still the oldest, and goes first.
    refused(() => b.circuits.admit('identity', 'ORG_FIRST'));
    b.fail('ORG_ONE_MORE');
    expect(tracked(b).size).toBe(MAX_TRACKED_CALLERS);
    expect(tracked(b).has('org:ORG_FIRST')).toBe(false);

    // A failure makes the oldest the newest: the next oldest goes instead.
    b.advance(COOLDOWN_MS);
    b.fail('ORG_TOUCHED');
    b.fail('ORG_TWO_MORE');
    expect(tracked(b).size).toBe(MAX_TRACKED_CALLERS);
    expect(tracked(b).has('org:ORG_TOUCHED')).toBe(true);
    expect(tracked(b).has('org:ORG_FAKE_0')).toBe(false);
    expect(tracked(b).has('org:ORG_FAKE_1')).toBe(true);

    for (let i = 0; i < 50_000; i += 1) b.fail(`ORG_FLOOD_${i}`);
    expect(tracked(b).size).toBe(MAX_TRACKED_CALLERS);
    expect(b.state()).toBe('CLOSED');
  });

  it('recovery exclusions stay within the cap, however many failed probes', () => {
    const b = breakers();
    for (const org of ['ORG_X', 'ORG_Y', 'ORG_Z']) b.fail(org);
    b.advance(COOLDOWN_MS);
    // One failed probe per cooldown: never K at once, so it never re-opens.
    for (let i = 0; i < MAX_TRACKED_CALLERS; i += 1) {
      b.fail(`ORG_PROBE_${i}`);
      b.advance(COOLDOWN_MS);
    }
    const excluded = (
      b.circuits as unknown as { circuits: Map<string, { excluded: Map<string, number> }> }
    ).circuits.get('identity')!.excluded;
    expect(excluded.size).toBe(MAX_TRACKED_CALLERS);
    expect(b.state()).toBe('HALF_OPEN');
  });

  it('a success, or being admitted, remembers nothing', () => {
    const b = breakers();
    b.fail('ORG_A');
    for (let i = 0; i < 5_000; i += 1) b.succeed(`ORG_FAKE_${i}`);
    for (let i = 0; i < 5_000; i += 1) b.circuits.admit('identity', `ORG_IDLE_${i}`);
    expect(tracked(b).size).toBe(1);
  });
});

describe('configuration', () => {
  const env = (value?: string) =>
    gatewayEnvSchema.shape.GATEWAY_CIRCUIT_ORGANIZATIONS_TO_OPEN.safeParse(value);

  it('defaults to three and can never be set to one organization', () => {
    expect(env()).toMatchObject({ success: true, data: 3 });
    expect(env('2')).toMatchObject({ success: true, data: 2 });
    expect(env('1').success).toBe(false);
    expect(env('0').success).toBe(false);
    expect(env('2.5').success).toBe(false);
    expect(env('101').success).toBe(false);
  });

  it('reaches the breaker', () => {
    expect(
      proxyOptionsOf({ GATEWAY_CIRCUIT_ORGANIZATIONS_TO_OPEN: 7 } as GatewayEnv)
        .organizationsToOpen,
    ).toBe(7);
  });
});
