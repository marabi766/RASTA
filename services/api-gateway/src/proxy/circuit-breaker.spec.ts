import { randomBytes } from 'node:crypto';
import { EventEmitter, getEventListeners } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InternalTokenService, RastaError, runWithContext } from '@rasta/nest-common';
import { registry } from '@rasta/observability';
import { GatewayHealthController } from '../app.module';
import { SERVICE_NAMES, type ServiceUrls } from '../config/routes';
import {
  CircuitBreakers,
  HALF_OPEN_RETRY_AFTER_SECONDS,
  type CircuitPermit,
} from './circuit-breaker';
import { clientCancellation } from './gateway.controller';
import { ClientCancelledError, ProxyService } from './proxy.service';
import type { RateLimiter } from './rate-limiter';

/**
 * The breaker's state machine on its own (#381 r4 F2), with a clock the test
 * moves: every transition, and every way an outcome can arrive too late, twice,
 * or from the wrong permit. The same rules over real HTTP are in
 * circuit-recovery.spec.ts.
 */

const THRESHOLD = 3;
const RESET_MS = 30_000;

function breakers() {
  let clock = 1_000;
  const circuits = new CircuitBreakers({
    failureThreshold: THRESHOLD,
    resetAfterMs: RESET_MS,
    now: () => clock,
  });
  return {
    circuits,
    advance: (ms: number) => (clock += ms),
    state: () => circuits.states().identity,
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

/** Opens identity's circuit with THRESHOLD failures and moves past the cooldown. */
function openedAndCooled(b: ReturnType<typeof breakers>): void {
  for (let i = 0; i < THRESHOLD; i += 1) {
    b.circuits.settle(b.circuits.admit('identity'), 'failure');
  }
  expect(b.state()).toEqual({ failures: THRESHOLD, open: true, state: 'OPEN' });
  b.advance(RESET_MS);
}

describe('CircuitBreakers: transitions', () => {
  it('CLOSED opens after the threshold of consecutive failures', () => {
    const b = breakers();
    b.circuits.settle(b.circuits.admit('identity'), 'failure');
    b.circuits.settle(b.circuits.admit('identity'), 'failure');
    expect(b.state()).toEqual({ failures: 2, open: false, state: 'CLOSED' });
    b.circuits.settle(b.circuits.admit('identity'), 'failure');
    expect(b.state()).toEqual({ failures: 3, open: true, state: 'OPEN' });
  });

  it('a success that saw every failure clears them', () => {
    const b = breakers();
    b.circuits.settle(b.circuits.admit('identity'), 'failure');
    b.circuits.settle(b.circuits.admit('identity'), 'failure');
    b.circuits.settle(b.circuits.admit('identity'), 'success');
    expect(b.state()).toEqual({ failures: 0, open: false, state: 'CLOSED' });
  });

  it('a success admitted before a failure does not clear it', () => {
    const b = breakers();
    const older = b.circuits.admit('identity');
    b.circuits.settle(b.circuits.admit('identity'), 'failure');
    b.circuits.settle(b.circuits.admit('identity'), 'failure');
    b.circuits.settle(older, 'success');
    expect(b.state()?.failures).toBe(2);
    b.circuits.settle(b.circuits.admit('identity'), 'failure');
    expect(b.state()?.state).toBe('OPEN');
  });

  it('OPEN refuses with the remaining cooldown as Retry-After, until the cooldown is over', () => {
    const b = breakers();
    openedAndCooled(b);
    b.advance(-RESET_MS + 10_500); // 19.5 s left
    const error = refused(() => b.circuits.admit('identity'));
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.retryAfterSeconds).toBe(20);
    b.advance(19_499);
    expect(refused(() => b.circuits.admit('identity')).retryAfterSeconds).toBe(1);
  });

  it('the first request after the cooldown is the probe; every other is refused fast with Retry-After 1', () => {
    const b = breakers();
    openedAndCooled(b);
    const probe = b.circuits.admit('identity');
    expect(probe.probe).toBe(true);
    expect(b.state()).toEqual({ failures: THRESHOLD, open: false, state: 'HALF_OPEN' });
    for (let i = 0; i < 50; i += 1) {
      const error = refused(() => b.circuits.admit('identity'));
      expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(error.retryAfterSeconds).toBe(HALF_OPEN_RETRY_AFTER_SECONDS);
    }
    expect(HALF_OPEN_RETRY_AFTER_SECONDS).toBe(1);
  });

  it('the probe’s success closes the circuit', () => {
    const b = breakers();
    openedAndCooled(b);
    b.circuits.settle(b.circuits.admit('identity'), 'success');
    expect(b.state()).toEqual({ failures: 0, open: false, state: 'CLOSED' });
    expect(b.circuits.admit('identity').probe).toBe(false);
  });

  it('the probe’s failure opens the circuit for a fresh cooldown', () => {
    const b = breakers();
    openedAndCooled(b);
    b.circuits.settle(b.circuits.admit('identity'), 'failure');
    expect(b.state()).toEqual({ failures: THRESHOLD + 1, open: true, state: 'OPEN' });
    expect(refused(() => b.circuits.admit('identity')).retryAfterSeconds).toBe(RESET_MS / 1000);
  });

  it('a released probe frees the slot and changes nothing else', () => {
    const b = breakers();
    openedAndCooled(b);
    b.circuits.settle(b.circuits.admit('identity'), 'release');
    expect(b.state()).toEqual({ failures: THRESHOLD, open: false, state: 'HALF_OPEN' });
    expect(b.circuits.admit('identity').probe).toBe(true);
  });

  it('an abandoned probe keeps the slot until its own deadline, with Retry-After the time left', () => {
    const b = breakers();
    openedAndCooled(b);
    const probe = b.circuits.admit('identity');
    b.circuits.dispatched(probe, 4000);
    b.advance(500);
    b.circuits.settle(probe, 'abandoned');
    expect(b.state()).toEqual({ failures: THRESHOLD, open: false, state: 'HALF_OPEN' });
    expect(refused(() => b.circuits.admit('identity')).retryAfterSeconds).toBe(4); // 3.5 s, up
    b.advance(2000);
    expect(refused(() => b.circuits.admit('identity')).retryAfterSeconds).toBe(2); // 1.5 s, up
    b.advance(1499);
    expect(refused(() => b.circuits.admit('identity')).retryAfterSeconds).toBe(1); // 1 ms, min 1
    b.advance(1);
    const next = b.circuits.admit('identity'); // the deadline has passed
    expect(next.probe).toBe(true);
    expect(b.state()).toEqual({ failures: THRESHOLD, open: false, state: 'HALF_OPEN' });
    expect(refused(() => b.circuits.admit('identity')).retryAfterSeconds).toBe(
      HALF_OPEN_RETRY_AFTER_SECONDS,
    );
    b.circuits.settle(probe, 'success'); // the abandoned one settled once already
    expect(b.state()?.state).toBe('HALF_OPEN');
    b.circuits.settle(next, 'success');
    expect(b.state()?.state).toBe('CLOSED');
  });

  it('an abandoned probe never marked as sent holds the slot for a full cooldown, not none', () => {
    const b = breakers();
    openedAndCooled(b);
    b.circuits.settle(b.circuits.admit('identity'), 'abandoned');
    b.advance(RESET_MS - 1);
    expect(() => b.circuits.admit('identity')).toThrow(RastaError);
    b.advance(1);
    expect(b.circuits.admit('identity').probe).toBe(true);
  });

  it('an abandoned request while CLOSED changes nothing', () => {
    const b = breakers();
    b.circuits.settle(b.circuits.admit('identity'), 'failure');
    const permit = b.circuits.admit('identity');
    b.circuits.dispatched(permit, 4000);
    b.circuits.settle(permit, 'abandoned');
    expect(b.state()).toEqual({ failures: 1, open: false, state: 'CLOSED' });
    expect(b.circuits.admit('identity').probe).toBe(false);
  });

  it('a release while CLOSED changes nothing', () => {
    const b = breakers();
    b.circuits.settle(b.circuits.admit('identity'), 'failure');
    b.circuits.settle(b.circuits.admit('identity'), 'release');
    expect(b.state()).toEqual({ failures: 1, open: false, state: 'CLOSED' });
  });

  it('a service that never failed has no entry, and is CLOSED', () => {
    const b = breakers();
    b.circuits.settle(b.circuits.admit('identity'), 'success');
    b.circuits.settle(b.circuits.admit('identity'), 'release');
    expect(b.circuits.states()).toEqual({});
  });
});

describe('CircuitBreakers: an outcome counts only for the generation and the permit that earned it', () => {
  it.each(['success', 'failure', 'release', 'abandoned'] as const)(
    '%s from a request admitted while CLOSED, settled after the circuit opened, changes nothing',
    (outcome) => {
      const b = breakers();
      const stale = b.circuits.admit('identity');
      openedAndCooled(b);
      const before = b.state();
      b.circuits.settle(stale, outcome);
      expect(b.state()).toEqual(before);
    },
  );

  it.each(['success', 'failure', 'release', 'abandoned'] as const)(
    '%s from a request admitted before the probe neither decides nor releases the probe',
    (outcome) => {
      const b = breakers();
      const stale = b.circuits.admit('identity');
      openedAndCooled(b);
      const probe = b.circuits.admit('identity');
      b.circuits.settle(stale, outcome);
      expect(b.state()?.state).toBe('HALF_OPEN');
      expect(() => b.circuits.admit('identity')).toThrow(RastaError); // the slot is still taken
      b.circuits.settle(probe, 'success');
      expect(b.state()?.state).toBe('CLOSED');
    },
  );

  it.each(['success', 'failure', 'release', 'abandoned'] as const)(
    'an earlier probe, already released, cannot settle its successor as %s',
    (outcome) => {
      const b = breakers();
      openedAndCooled(b);
      const first = b.circuits.admit('identity');
      b.circuits.settle(first, 'release');
      const second = b.circuits.admit('identity');
      b.circuits.settle(first, outcome);
      expect(b.state()).toEqual({ failures: THRESHOLD, open: false, state: 'HALF_OPEN' });
      expect(() => b.circuits.admit('identity')).toThrow(RastaError);
      b.circuits.settle(second, 'success');
      expect(b.state()?.state).toBe('CLOSED');
    },
  );

  it('a probe from an earlier HALF_OPEN cannot decide a later one', () => {
    const b = breakers();
    openedAndCooled(b);
    const first = b.circuits.admit('identity');
    b.circuits.settle(first, 'failure'); // re-opened
    b.advance(RESET_MS);
    const second = b.circuits.admit('identity');
    b.circuits.settle(first, 'success');
    expect(b.state()?.state).toBe('HALF_OPEN');
    b.circuits.settle(second, 'failure');
    expect(b.state()?.state).toBe('OPEN');
  });

  it('a permit settles once: the second outcome is ignored', () => {
    const b = breakers();
    const permit = b.circuits.admit('identity');
    b.circuits.settle(permit, 'failure');
    b.circuits.settle(permit, 'failure');
    b.circuits.settle(permit, 'failure');
    expect(b.state()?.failures).toBe(1);
  });

  it('a forged permit (right service, right generation, not the probe) cannot decide the probe', () => {
    const b = breakers();
    openedAndCooled(b);
    const probe = b.circuits.admit('identity');
    const forged = { ...probe, settled: false } as CircuitPermit;
    b.circuits.settle(forged, 'success');
    expect(b.state()?.state).toBe('HALF_OPEN');
  });

  it('services are independent', () => {
    const b = breakers();
    openedAndCooled(b);
    b.circuits.admit('identity'); // identity's probe in flight
    for (let i = 0; i < 10; i += 1) {
      const permit = b.circuits.admit('organization');
      expect(permit.probe).toBe(false);
      b.circuits.settle(permit, 'success');
    }
    b.circuits.settle(b.circuits.admit('organization'), 'failure');
    expect(b.circuits.states().organization).toEqual({ failures: 1, open: false, state: 'CLOSED' });
    expect(b.state()?.state).toBe('HALF_OPEN');
  });
});

describe('the circuit state gauge', () => {
  async function gaugeValue(service: string): Promise<number | undefined> {
    const metric = await registry.getSingleMetric('rasta_gateway_circuit_state')?.get();
    return metric?.values.find((v) => v.labels.service === service)?.value;
  }

  it('follows the state, labelled by service only', async () => {
    const b = breakers();
    openedAndCooled(b);
    expect(await gaugeValue('identity')).toBe(2);
    const probe = b.circuits.admit('identity');
    expect(await gaugeValue('identity')).toBe(1);
    b.circuits.settle(probe, 'success');
    expect(await gaugeValue('identity')).toBe(0);

    const metric = await registry.getSingleMetric('rasta_gateway_circuit_state')?.get();
    for (const value of metric?.values ?? [])
      expect(Object.keys(value.labels)).toEqual(['service']);
  });
});

// ---------------------------------------------------------------------------
// forward(): every exit settles the permit, and cleans up after itself
// ---------------------------------------------------------------------------

describe('forward settles its permit on every exit path', () => {
  let server: Server;
  let received = 0;
  let urls: ServiceUrls;
  beforeAll(async () => {
    server = createServer((_req, res) => {
      received += 1;
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    urls = Object.fromEntries(
      SERVICE_NAMES.map((name) => [`${name.toUpperCase()}_SERVICE_URL`, url]),
    ) as unknown as ServiceUrls;
  });
  afterAll(async () => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => (received = 0));

  const context = {
    correlationId: 'req-exit',
    requestId: 'req-exit',
    roles: [],
    organizationIds: [],
    authType: 'USER' as const,
    startedAt: 0,
  };

  /**
   * A proxy whose identity circuit is HALF_OPEN-ready: opened once, cooldown
   * over. Its clock never moves again, so a slot freed here is freed at once —
   * a `release` before sending, never an `abandoned` waiting out a deadline.
   */
  async function halfOpenProxy(tokens: Pick<InternalTokenService, 'issue'>) {
    let clock = 0;
    const proxy = new ProxyService(urls, tokens as InternalTokenService, {
      timeoutMs: 2000,
      failureThreshold: 1,
      resetAfterMs: 1000,
      now: () => clock,
    });
    const forward = (signal?: AbortSignal) =>
      runWithContext(context, () =>
        proxy.forward({
          service: 'identity',
          method: 'GET',
          path: '/v1/users/me',
          query: '',
          headers: {},
          body: undefined,
          signal,
        }),
      );
    await expect(forward()).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    clock += 1000;
    received = 0;
    return { proxy, forward };
  }

  const realTokens = new InternalTokenService(
    randomBytes(32).toString('hex'),
    'rasta-internal',
    300,
  );

  it('a caller already gone: nothing is sent, the slot is released', async () => {
    const { proxy, forward } = await halfOpenProxy(realTokens);
    const gone = new AbortController();
    gone.abort();
    await expect(forward(gone.signal)).rejects.toBeInstanceOf(ClientCancelledError);
    expect(received).toBe(0);
    expect(proxy.circuitStates().identity).toEqual({
      failures: 1,
      open: false,
      state: 'HALF_OPEN',
    });
    await expect(forward()).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' }); // next probe
    expect(received).toBe(1);
  });

  it('a caller gone while the internal token is minted: nothing is sent, the slot is released', async () => {
    let mint: ((token: string) => void) | undefined;
    let slow = false;
    const slowTokens = {
      issue: jest.fn(async () => {
        if (!slow) return 'token-sample';
        return new Promise<string>((resolve) => (mint = resolve));
      }),
    };
    const { proxy, forward } = await halfOpenProxy(slowTokens);
    slow = true;
    const caller = new AbortController();
    const pending = forward(caller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mint).toBeDefined();
    caller.abort();
    mint!('token-sample');
    await expect(pending).rejects.toBeInstanceOf(ClientCancelledError);
    expect(received).toBe(0);
    expect(proxy.circuitStates().identity?.state).toBe('HALF_OPEN');
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
    slow = false;
    await expect(forward()).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' }); // next probe
    expect(received).toBe(1);
  });

  it('token issuance failing: the error surfaces, the slot is released, nothing is recorded', async () => {
    let fail = false;
    const flakyTokens = {
      issue: jest.fn(async () => {
        if (fail) throw new Error('signing key unavailable');
        return 'token-sample';
      }),
    };
    const { proxy, forward } = await halfOpenProxy(flakyTokens);
    fail = true;
    await expect(forward()).rejects.toThrow('signing key unavailable');
    expect(received).toBe(0);
    expect(proxy.circuitStates().identity).toEqual({
      failures: 1,
      open: false,
      state: 'HALF_OPEN',
    });
    fail = false;
    await expect(forward()).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' }); // admitted
    expect(received).toBe(1);
  });

  it('removes its abort listener from the caller’s signal once done', async () => {
    const { forward } = await halfOpenProxy(realTokens);
    const caller = new AbortController();
    await expect(forward(caller.signal)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
  });
});

describe('clientCancellation', () => {
  function fakeResponse(state: { closed: boolean; writableFinished: boolean }) {
    return Object.assign(new EventEmitter(), state);
  }

  it('aborts when the connection closes before the response was written, and disposes its listener', () => {
    const response = fakeResponse({ closed: false, writableFinished: false });
    const { signal, dispose } = clientCancellation(response as never);
    expect(response.listenerCount('close')).toBe(1);
    response.emit('close');
    expect(signal.aborted).toBe(true);
    dispose();
    expect(response.listenerCount('close')).toBe(0);
  });

  it('does not abort when the close follows a finished response', () => {
    const response = fakeResponse({ closed: false, writableFinished: false });
    const { signal, dispose } = clientCancellation(response as never);
    response.writableFinished = true;
    response.emit('close');
    expect(signal.aborted).toBe(false);
    dispose();
  });

  it('is already aborted when the connection closed before it was asked', () => {
    const response = fakeResponse({ closed: true, writableFinished: false });
    const { signal } = clientCancellation(response as never);
    expect(signal.aborted).toBe(true);
    expect(response.listenerCount('close')).toBe(0);
  });

  it('dispose removes the listener when nothing happened', () => {
    const response = fakeResponse({ closed: false, writableFinished: false });
    const { signal, dispose } = clientCancellation(response as never);
    dispose();
    expect(response.listenerCount('close')).toBe(0);
    expect(signal.aborted).toBe(false);
  });
});

describe('readiness', () => {
  it('reports each circuit as before, plus its state', async () => {
    const proxy = {
      circuitStates: () => ({ identity: { failures: 1, open: false, state: 'HALF_OPEN' } }),
    } as unknown as ProxyService;
    const limiter = { isHealthy: async () => true } as unknown as RateLimiter;
    const response = { status: jest.fn() };
    const ready = await new GatewayHealthController(limiter, proxy).ready(response as never);
    expect(ready.circuits).toEqual({ identity: { failures: 1, open: false, state: 'HALF_OPEN' } });
    expect(response.status).toHaveBeenCalledWith(200);
  });
});
