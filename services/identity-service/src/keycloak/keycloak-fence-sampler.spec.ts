import { MembershipExpiryScanner } from '../identity/membership-expiry.scanner';
import type { IdentityRepository } from '../identity/identity.repository';
import type { IdentityService } from '../identity/identity.service';
import type { KeycloakProjector } from './keycloak.projector';
import type { FenceCounts, KeycloakWriteFences } from './keycloak-write-fence';
import { returnedBy, watch } from '../../test/test-clock';
import {
  keycloakFenceSampleAge,
  keycloakFenceSamplesTotal,
  keycloakWriteFences,
} from '../observability/keycloak-projection.metrics';
// SAMPLER-IMPORT-BEGIN
import {
  FENCE_SAMPLE_BUDGET_MS,
  FENCE_SAMPLE_INTERVAL_MS,
  FENCE_SAMPLE_RETENTION_MS,
  FENCE_SAMPLE_STALE_SECONDS,
  KeycloakFenceSampler,
  type FenceSampleSource,
} from './keycloak-fence-sampler';
// SAMPLER-IMPORT-END

/**
 * #402 r3 R3-2: the overdue signal must not depend on the sweep's serial
 * work. A logical clock (Jest's fake timers) drives the **real** scanner and
 * the **real** sampler; the database is a model of one fence, judged on that
 * clock; a "scrape" reads the gauges through the registry every 15 s, as
 * Prometheus does.
 */

const SECOND = 1_000;

/** One fence of the reviewer's probe: deadline 10 s, takeover 130 s, settle 120 s. */
function oneFence() {
  const fence = { deadline: 10 * SECOND, takeover: 130 * SECOND, takenOver: false };
  const counts = (now: number): FenceCounts => {
    const present = !fence.takenOver;
    const live = present && now < fence.takeover;
    const halfway = fence.deadline + (fence.takeover - fence.deadline) / 2;
    return {
      live: live ? 1 : 0,
      due: present && !live ? 1 : 0,
      accountMissing: 0,
      overdue: live && now >= halfway ? 1 : 0,
      expired: present && !live ? 1 : 0,
      total: present ? 1 : 0,
      at: new Date(now),
    };
  };
  return { fence, counts };
}

async function scrape(state: string): Promise<number | undefined> {
  return (await keycloakWriteFences.get()).values.find((v) => v.labels.state === state)?.value;
}

async function ageAtScrape(): Promise<number | undefined> {
  return (await keycloakFenceSampleAge.get()).values[0]?.value;
}

describe('R3-2: the overdue gauge does not depend on the sweep (logical clock)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('the reviewer’s probe — deadline 10 s, takeover 130 s, the sweep busy 60..140 s with 8 lapses of 10 s — a scrape sees the overdue fence', async () => {
    jest.useFakeTimers({ now: 0 });
    const { fence, counts } = oneFence();
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    // Eight unrelated lapses, each taking ten seconds of the sweep's pass.
    const lapses = Array.from({ length: 8 }, (_, i) => ({
      id: `MBR_${i}`,
      userId: `USR_L${i}`,
      validUntil: new Date(0),
    }));
    const handled = new Set<string>();
    const repository = {
      findLapsedMemberships: jest.fn(async () => lapses.filter((l) => !handled.has(l.id))),
      deferLapse: jest.fn(async () => undefined),
      countLapsedMemberships: jest.fn(async () => lapses.length - handled.size),
    };
    const identity = {
      expireLapsedMembership: jest.fn(async (lapse: { id: string }) => {
        await sleep(10 * SECOND);
        handled.add(lapse.id);
        return true;
      }),
    };
    // The re-assertion takes the fence over once it is due (the projection deletes it).
    const projector = {
      project: jest.fn(async () => {
        fence.takenOver = true;
        return 'projected';
      }),
    };
    const fences = {
      dueUsers: jest.fn(async () =>
        !fence.takenOver && Date.now() >= fence.takeover ? ['USR_FENCED'] : [],
      ),
      deferReassert: jest.fn(async () => undefined),
      recoverOwed: jest.fn(async () => 0),
      counts: jest.fn(async () => counts(Date.now())),
    };
    const scanner = new MembershipExpiryScanner(
      repository as unknown as IdentityRepository,
      identity as unknown as IdentityService,
      { enabled: true, intervalSeconds: 60, batchSize: 50 },
      projector as unknown as Pick<KeycloakProjector, 'project'>,
      fences as unknown as Pick<KeycloakWriteFences, 'dueUsers' | 'deferReassert' | 'recoverOwed'>,
    );
    scanner.onModuleInit();
    // SAMPLER-BEGIN
    const source: FenceSampleSource = {
      fences: async () => counts(Date.now()),
      lapseBacklog: async () => lapses.length - handled.size,
    };
    const sampler = new KeycloakFenceSampler(source, { clock: () => Date.now() });
    sampler.start();
    // SAMPLER-END

    // Prometheus: a scrape every 15 s, from 0 to 200 s.
    const seen: Array<{ t: number; overdue: number | undefined }> = [];
    for (let t = 0; t <= 200 * SECOND; t += 15 * SECOND) {
      if (t > 0) await jest.advanceTimersByTimeAsync(15 * SECOND);
      seen.push({ t: t / SECOND, overdue: await scrape('overdue') });
    }
    await scanner.stop({ deadlineAt: Date.now() });
    // SAMPLER-STOP-BEGIN
    await sampler.stop();
    // SAMPLER-STOP-END

    // The sweep really was busy across the whole window, as in the probe:
    // its lapses ran 60..140 s and it took the fence over only after takeover.
    expect(identity.expireLapsedMembership).toHaveBeenCalledTimes(8);
    expect(fence.takenOver).toBe(true);
    // The overdue window is [70, 130) s: a scrape inside it, or within one
    // scrape after it, saw the fence.
    const inWindow = seen.filter((s) => s.t >= 70 && s.t <= 145);
    expect(inWindow.some((s) => (s.overdue ?? 0) >= 1)).toBe(true);
  });
});

// SAMPLER-UNIT-BEGIN
describe('KeycloakFenceSampler', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  function counted(overrides: Partial<FenceCounts> = {}): FenceCounts {
    return {
      live: 0,
      due: 0,
      accountMissing: 0,
      overdue: 0,
      expired: 0,
      total: 0,
      at: new Date(),
      ...overrides,
    };
  }

  function harness(fences: FenceSampleSource['fences']) {
    const source: FenceSampleSource = { fences, lapseBacklog: async () => 0 };
    const sampler = new KeycloakFenceSampler(source, { clock: () => Date.now() });
    return { sampler };
  }

  /** Its stop waits at most one budget for a hung sample — on the fake clock too. */
  async function stopOnFakeTimers(sampler: KeycloakFenceSampler): Promise<void> {
    const stopped = sampler.stop();
    await jest.advanceTimersByTimeAsync(10 * SECOND);
    await stopped;
  }

  it('exports no fence series before its first success, and its age from its start — never a zero it did not see', async () => {
    jest.useFakeTimers({ now: 0 });
    const { sampler } = harness(() => new Promise<FenceCounts>(() => undefined));
    sampler.start();
    await jest.advanceTimersByTimeAsync(4 * SECOND);
    expect(await scrape('overdue')).toBeUndefined();
    expect(await scrape('live')).toBeUndefined();
    expect(await ageAtScrape()).toBe(4);
    await jest.advanceTimersByTimeAsync(10 * SECOND);
    expect(await ageAtScrape()).toBe(14);
    await stopOnFakeTimers(sampler);
  });

  it('its age keeps growing while a sample hangs, and is computed at scrape — never reset by the sampler', async () => {
    jest.useFakeTimers({ now: 0 });
    let hang = false;
    const { sampler } = harness(async () => {
      if (hang) return new Promise<FenceCounts>(() => undefined);
      return counted();
    });
    sampler.start();
    await jest.advanceTimersByTimeAsync(3 * SECOND);
    expect(await ageAtScrape()).toBeLessThanOrEqual(FENCE_SAMPLE_INTERVAL_MS / SECOND);
    hang = true;
    const busy = async () =>
      (await keycloakFenceSamplesTotal.get()).values.find((v) => v.labels.outcome === 'busy')
        ?.value ?? 0;
    const busyBefore = await busy();
    await jest.advanceTimersByTimeAsync(20 * SECOND);
    // The last success started at 2 s: 21 s later, at this scrape.
    expect(await ageAtScrape()).toBe(21);
    expect(await ageAtScrape()).toBeGreaterThan(FENCE_SAMPLE_STALE_SECONDS);
    // Its own guard: ticks while the hung sample holds its connection are `busy`.
    expect(await busy()).toBeGreaterThan(busyBefore);
    await stopOnFakeTimers(sampler);
  });

  it('a sample past its budget is a failure, whenever its query answers', async () => {
    jest.useFakeTimers({ now: 0 });
    const slow = () =>
      new Promise<FenceCounts>((resolve) =>
        setTimeout(() => resolve(counted({ overdue: 1 })), FENCE_SAMPLE_BUDGET_MS + 500),
      );
    const { sampler } = harness(slow);
    sampler.start();
    await jest.advanceTimersByTimeAsync(10 * SECOND);
    // Never counted: none answered within its budget.
    expect(await scrape('overdue')).toBeUndefined();
    expect(await ageAtScrape()).toBe(10);
    await stopOnFakeTimers(sampler);
  });

  it('keeps an overdue sample for the retention window, so a scrape after a short window still sees it', async () => {
    jest.useFakeTimers({ now: 0 });
    // Overdue for one sample only (2..4 s), zero before and after.
    const { sampler } = harness(async () =>
      counted({ overdue: Date.now() >= 2 * SECOND && Date.now() < 3 * SECOND ? 1 : 0 }),
    );
    sampler.start();
    await jest.advanceTimersByTimeAsync(15 * SECOND);
    expect(await scrape('overdue')).toBe(1);
    await jest.advanceTimersByTimeAsync(FENCE_SAMPLE_RETENTION_MS);
    expect(await scrape('overdue')).toBe(0);
    await stopOnFakeTimers(sampler);
  });

  it('a gap between two successes is reported for the retention window, even once sampling recovered', async () => {
    jest.useFakeTimers({ now: 0 });
    let down = false;
    const { sampler } = harness(async () => {
      if (down) throw new Error('connection refused');
      return counted();
    });
    sampler.start();
    await jest.advanceTimersByTimeAsync(2 * SECOND);
    down = true;
    await jest.advanceTimersByTimeAsync(8 * SECOND);
    down = false;
    // Recovered at the 12 s tick: the gap since the success at 2 s is 10 s,
    // and the scrape then still reports it, though the latest sample is fresh.
    await jest.advanceTimersByTimeAsync(2 * SECOND);
    expect(await ageAtScrape()).toBe(10);
    // Kept for the whole retention window, and gone one interval after it.
    await jest.advanceTimersByTimeAsync(FENCE_SAMPLE_RETENTION_MS);
    expect(await ageAtScrape()).toBe(10);
    await jest.advanceTimersByTimeAsync(FENCE_SAMPLE_INTERVAL_MS);
    expect(await ageAtScrape()).toBeLessThanOrEqual(FENCE_SAMPLE_INTERVAL_MS / SECOND);
    await stopOnFakeTimers(sampler);
  });

  it('its stop is bounded by one budget, and nothing it starts afterwards runs', async () => {
    // On the test's clock (#910): bounded by the budget itself — not before
    // it, and by it — never by how fast the runner is.
    jest.useFakeTimers({
      now: 0,
      doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'queueMicrotask'],
    });
    const calls: number[] = [];
    const sampler = new KeycloakFenceSampler(
      {
        fences: () => {
          calls.push(Date.now());
          return new Promise<FenceCounts>(() => undefined);
        },
        lapseBacklog: () => new Promise<number>(() => undefined),
      },
      { budgetMs: 100, lapseBudgetMs: 100 },
    );
    sampler.start();
    const stopping = sampler.stop();
    const stop = watch(stopping);
    await jest.advanceTimersByTimeAsync(99);
    await new Promise((resolve) => setImmediate(resolve));
    expect(stop.settled).toBe(false);
    expect(await returnedBy(stopping, 1)).toEqual({
      status: 'fulfilled',
      value: undefined,
      settledAt: 100,
    });
    sampler.tick();
    expect(calls).toHaveLength(1);
  });
});
// SAMPLER-UNIT-END
