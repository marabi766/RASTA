import { Logger } from '@nestjs/common';
import { RastaError } from '@rasta/nest-common';
import { CircuitBreakers, type CircuitOutcome, type CircuitPermit } from './circuit-breaker';

/**
 * FU-113: callers' outcomes alone never move the shared circuit toward OPEN.
 * Several colluding callers — distinct organizations, distinct people,
 * anonymous — satisfy every count of callers, and each chooses how its own
 * request ends. The gateway's own readiness check decides instead.
 */

const THRESHOLD = 5;
const COOLDOWN_MS = 30_000;
const DEADLINE_MS = 60_000;
const TICK_MS = 1_000;
const ATTACK_MS = 30 * 60_000;

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  jest.spyOn(Logger.prototype, 'error').mockImplementation();
  jest.spyOn(Logger.prototype, 'log').mockImplementation();
});
afterAll(() => jest.restoreAllMocks());

type Identity = [organizationId: string | undefined, person: string | undefined];
type Play =
  | 'cancel at once'
  | 'cancel at second 59'
  | 'fail at the deadline'
  | 'fail at once'
  | 'refused (4xx)';

/** N organizations, each a person of its own, plus anonymous and one person without an organization. */
function colluders(n: number): Identity[] {
  const members = Array.from({ length: n }, (_, i): Identity => [`ORG_C${i}`, `P_C${i}`]);
  return [...members, [undefined, undefined], [undefined, 'P_ORGLESS']];
}

function world() {
  let clock = 1_000;
  const state = { ready: false, checks: 0 };
  const circuits = new CircuitBreakers({
    failureThreshold: THRESHOLD,
    resetAfterMs: COOLDOWN_MS,
    now: () => clock,
    checkReady: () => {
      state.checks += 1;
      return state.ready;
    },
  });
  const pending: Array<{ at: number; permit: CircuitPermit; outcome: CircuitOutcome }> = [];
  const admit = ([org, person]: Identity) => circuits.admit('identity', org, person);
  const circuitState = () => circuits.states().identity?.state ?? 'CLOSED';

  /** A genuine outage: three tenants fail, the service is not ready, it opens. */
  function outage() {
    for (const org of ['ORG_X', 'ORG_Y', 'ORG_Z', 'ORG_X', 'ORG_Y']) {
      circuits.settle(admit([org, `P_${org}`]), 'failure');
    }
    expect(circuitState()).toBe('OPEN');
  }

  /** One colluding request, ending as its caller chose. */
  function play(permit: CircuitPermit, how: Play) {
    circuits.dispatched(permit, DEADLINE_MS);
    if (how === 'cancel at once') circuits.settle(permit, 'abandoned');
    else if (how === 'fail at once') circuits.settle(permit, 'failure');
    else if (how === 'refused (4xx)') circuits.settle(permit, 'release');
    else if (how === 'cancel at second 59') {
      pending.push({ at: clock + DEADLINE_MS - 1_000, permit, outcome: 'abandoned' });
    } else pending.push({ at: clock + DEADLINE_MS, permit, outcome: 'failure' });
  }

  /**
   * Every TICK_MS: due requests end, every colluding identity tries first, then
   * one victim request. Returns when the victim was refused, and the state seen.
   */
  function run(identities: Identity[], how: Play, victimOutcome: CircuitOutcome) {
    const refusedAt: number[] = [];
    const states: Array<[number, string]> = [];
    const end = clock + ATTACK_MS;
    for (; clock < end; clock += TICK_MS) {
      for (const due of pending.filter(({ at }) => at <= clock)) {
        pending.splice(pending.indexOf(due), 1);
        circuits.settle(due.permit, due.outcome);
      }
      for (const identity of identities) {
        try {
          play(admit(identity), how);
        } catch (error) {
          if (!(error instanceof RastaError)) throw error;
        }
      }
      try {
        circuits.settle(admit(['ORG_VICTIM', 'P_VICTIM']), victimOutcome);
      } catch (error) {
        if (!(error instanceof RastaError)) throw error;
        refusedAt.push(clock);
      }
      states.push([clock, circuitState()]);
    }
    return { refusedAt, states };
  }

  return {
    state,
    outage,
    run,
    circuitState,
    advance: (ms: number) => (clock += ms),
    now: () => clock,
  };
}

const PLAYS: Play[] = [
  'cancel at once',
  'cancel at second 59',
  'fail at the deadline',
  'fail at once',
  'refused (4xx)',
];
const SCHEDULES = [3, 5, 10].flatMap((n) => PLAYS.map((how) => [n, how] as const));

describe('colluding callers cannot keep a ready service’s circuit open', () => {
  it.each(SCHEDULES)(
    '%i organizations plus anonymous, %s, for 30 minutes: closed within one probe, never re-opened',
    (n, how) => {
      const w = world();
      w.outage();
      w.state.ready = true; // the service has recovered
      w.advance(COOLDOWN_MS);
      const recoveredBy = w.now() + DEADLINE_MS + TICK_MS;

      const { refusedAt, states } = w.run(colluders(n), how, 'success');

      // At most one colluding probe's deadline after the cooldown, then never again.
      expect(refusedAt.filter((at) => at > recoveredBy)).toEqual([]);
      expect(states.filter(([at, state]) => at > recoveredBy && state !== 'CLOSED')).toEqual([]);
      // One check per decision the colluders forced, not one per request.
      expect(w.state.checks).toBeLessThan(ATTACK_MS / TICK_MS);
    },
  );
});

describe('a service that is not ready still opens, and colluders cannot close it', () => {
  it.each(SCHEDULES)(
    '%i organizations plus anonymous, %s, while every real request fails: never CLOSED',
    (n, how) => {
      const w = world();
      w.outage();
      w.advance(COOLDOWN_MS);

      const { states } = w.run(colluders(n), how, 'failure');

      expect(states.filter(([, state]) => state === 'CLOSED')).toEqual([]);
    },
  );

  it('once it is ready again, the next probe’s refusal is enough for the check to close it', () => {
    const w = world();
    w.outage();
    w.advance(COOLDOWN_MS);
    w.state.ready = true;
    w.run([['ORG_C0', 'P_C0']], 'refused (4xx)', 'failure');
    expect(w.circuitState()).toBe('CLOSED');
  });
});

// ---------------------------------------------------------------------------
// The check itself
// ---------------------------------------------------------------------------

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function asyncWorld() {
  let clock = 1_000;
  const checks: Array<ReturnType<typeof deferred>> = [];
  const circuits = new CircuitBreakers({
    failureThreshold: 3,
    resetAfterMs: COOLDOWN_MS,
    now: () => clock,
    checkReady: () => {
      const check = deferred();
      checks.push(check);
      return check.promise as Promise<boolean>;
    },
  });
  const fail = (org: string) =>
    circuits.settle(circuits.admit('identity', org, `P_${org}`), 'failure');
  const state = () => circuits.states().identity?.state;
  return { circuits, checks, fail, state, advance: (ms: number) => (clock += ms) };
}

describe('the gateway’s readiness check', () => {
  it('opens only once it answers not ready; one check in flight serves every failure', async () => {
    const w = asyncWorld();
    w.fail('ORG_A');
    w.fail('ORG_B');
    const decided = w.fail('ORG_C');
    expect(decided).toBeInstanceOf(Promise);
    expect(w.fail('ORG_D')).toBe(decided);
    expect(w.checks).toHaveLength(1);
    expect(w.state()).toBe('CLOSED');
    w.checks[0]!.resolve(false);
    await decided;
    expect(w.state()).toBe('OPEN');
  });

  it('ready spends the run: the same failures cannot ask again, fresh ones from enough organizations can', async () => {
    const w = asyncWorld();
    w.fail('ORG_A');
    w.fail('ORG_B');
    const decided = w.fail('ORG_C');
    w.checks[0]!.resolve(true);
    await decided;
    expect(w.state()).toBe('CLOSED');
    // The threshold is reached again by two organizations: B's and C's spent
    // failures do not make them three.
    expect(w.fail('ORG_A')).toBeUndefined();
    expect(w.fail('ORG_A')).toBeUndefined();
    expect(w.fail('ORG_E')).toBeUndefined();
    expect(w.checks).toHaveLength(1);
    expect(w.fail('ORG_D')).toBeInstanceOf(Promise);
    expect(w.checks).toHaveLength(2);
  });

  it.each<[string, (check: ReturnType<typeof deferred>) => void]>([
    ['a rejection', (check) => check.reject(new Error('socket hang up'))],
    ['a truthy non-boolean', (check) => check.resolve('ok')],
    ['undefined', (check) => check.resolve(undefined)],
  ])('%s is not ready: it opens (fail closed)', async (_label, answer) => {
    const w = asyncWorld();
    w.fail('ORG_A');
    w.fail('ORG_B');
    const decided = w.fail('ORG_C');
    answer(w.checks[0]!);
    await decided;
    expect(w.state()).toBe('OPEN');
  });

  it('a check that throws before answering is not ready', () => {
    const circuits = new CircuitBreakers({
      failureThreshold: 1,
      organizationsToOpen: 1,
      resetAfterMs: COOLDOWN_MS,
      now: () => 1,
      checkReady: () => {
        throw new Error('no route');
      },
    });
    circuits.settle(circuits.admit('identity', 'ORG_A', 'P_A'), 'failure');
    expect(circuits.states().identity?.state).toBe('OPEN');
  });

  it('while it runs after a probe, it holds the slot; its answer decides', async () => {
    const w = asyncWorld();
    w.fail('ORG_A');
    w.fail('ORG_B');
    const opened = w.fail('ORG_C');
    w.checks[0]!.resolve(false);
    await opened;
    expect(w.state()).toBe('OPEN');
    w.advance(COOLDOWN_MS);

    const probe = w.circuits.admit('identity', 'ORG_ATTACKER', 'P_ATTACKER');
    expect(probe.probe).toBe(true);
    const decided = w.circuits.settle(probe, 'release');
    expect(w.checks).toHaveLength(2);
    const refusal = (() => {
      try {
        w.circuits.admit('identity', 'ORG_VICTIM', 'P_VICTIM');
      } catch (error) {
        return error as RastaError;
      }
      throw new Error('admitted while the check runs');
    })();
    expect(refusal.retryAfterSeconds).toBe(1);
    w.checks[1]!.resolve(true);
    await decided;
    expect(w.state()).toBe('CLOSED');
    expect(w.circuits.admit('identity', 'ORG_VICTIM', 'P_VICTIM').probe).toBe(false);
  });
});
