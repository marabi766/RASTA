import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { registry } from '@rasta/observability';
import {
  KeycloakFenceSampler,
  LAPSE_SAMPLE_INTERVAL_MS,
  type FenceSampleSource,
} from '../keycloak/keycloak-fence-sampler';
import type { FenceCounts } from '../keycloak/keycloak-write-fence';
import { readFenceSamplesFrom } from './keycloak-projection.metrics';

/**
 * #458 r1 F3: a replica whose fence sampler is absent — never wired, not
 * started, or stopped — must export **no** age and no lapse backlog, never
 * prom-client's default zero, which reads as fresh and empty: it kept
 * `absent()` false for good and pulled `min(age)` under the stale threshold
 * on every other replica.
 *
 * #458 r2 F6: a lapse count that fails now and then must not reset the
 * backlog alerts. The backlog is the latest **successful** count, kept
 * through failures; how old it is goes in a series of its own
 * (`rasta_identity_membership_lapse_count_age_seconds`), which the
 * unknown-backlog alert reads.
 *
 * What is checked is the **real** collector output — the registry's text
 * exposition, as Prometheus scrapes it — and the promtool tests named
 * `collector: …` in `rasta-identity-alerts.test.yml` are held to it, value by
 * value, so the rules are tested over what this service actually exports:
 * the reviewer's hour of one successful count per 120 s among them.
 */

const AGE = 'rasta_identity_keycloak_fence_sample_age_seconds';
const BACKLOG = 'rasta_identity_membership_lapse_backlog';
const LAPSE_AGE = 'rasta_identity_membership_lapse_count_age_seconds';
const FENCES = 'rasta_identity_keycloak_write_fences';
const SECOND = 1_000;

const RULE_TESTS = resolve(
  __dirname,
  '../../../../infrastructure/docker/prometheus/tests/rasta-identity-alerts.test.yml',
);

/** Every sample line of `name` in one scrape of the registry: labels as written, and the value. */
async function scrape(name: string): Promise<Array<{ labels: string; value: number }>> {
  const text = await registry.metrics();
  const samples: Array<{ labels: string; value: number }> = [];
  for (const line of text.split('\n')) {
    const match = /^([a-z_]+)(\{[^}]*\})?\s+(\S+)$/.exec(line);
    if (match?.[1] === name) samples.push({ labels: match[2] ?? '', value: Number(match[3]) });
  }
  return samples;
}

function counts(): FenceCounts {
  return { live: 0, due: 0, accountMissing: 0, overdue: 0, expired: 0, total: 0, at: new Date(0) };
}

/**
 * The lapse timer's interval in production, driven by hand here: the
 * sampler is configured with it, so a staleness rule on it would show, but
 * its real timer never fires (fake timers, below).
 */
const LAPSE_TICK_MS = LAPSE_SAMPLE_INTERVAL_MS;

/**
 * A real sampler on a clock the test moves: one successful fence sample when
 * it starts, then every later one fails; a lapse count — at its start, then
 * at each tick the test drives — that succeeds with `backlog` when
 * `countsAt(t)` says so and fails otherwise (by default: only the first).
 * Its own timers never fire by themselves (fake timers, below).
 */
async function sampler(backlog: number, countsAt: (t: number) => boolean = (t) => t === 0) {
  let now = 0;
  let fenceCalls = 0;
  const source: FenceSampleSource = {
    fences: () =>
      fenceCalls++ === 0 ? Promise.resolve(counts()) : Promise.reject(new Error('down')),
    lapseBacklog: () =>
      countsAt(now) ? Promise.resolve(backlog) : Promise.reject(new Error('down')),
  };
  const instance = new KeycloakFenceSampler(source, {
    intervalMs: 3_600 * SECOND,
    lapseIntervalMs: LAPSE_TICK_MS,
    clock: () => now,
  });
  instance.start();
  await new Promise((done) => setImmediate(done));
  let ticked = 0;
  return {
    reader: () => instance.view(),
    /** Moves the clock to `ms`, running every lapse tick due on the way. */
    async at(ms: number) {
      for (let tick = ticked + LAPSE_TICK_MS; tick <= ms; tick += LAPSE_TICK_MS) {
        now = tick;
        ticked = tick;
        instance.sampleLapses();
        await new Promise((done) => setImmediate(done));
      }
      now = ms;
    },
    stop: () => instance.stop(),
  };
}

// The samplers' own timers never fire: the test drives every tick, on its own clock.
beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
});

afterEach(() => {
  jest.useRealTimers();
  readFenceSamplesFrom(null);
});

describe('#458 r1 F3: an absent sampler exports no series, never a zero', () => {
  it('no sampler at all: the scrape has no age, no lapse backlog and no fence series', async () => {
    readFenceSamplesFrom(null);
    expect(await scrape(AGE)).toEqual([]);
    expect(await scrape(BACKLOG)).toEqual([]);
    expect(await scrape(FENCES)).toEqual([]);
    // Scraped twice: the first scrape's collection leaves no zero behind.
    expect(await scrape(AGE)).toEqual([]);
  });

  it('a sampler that stopped: detached, so its series go — not frozen, not zero', async () => {
    const one = await sampler(2);
    await one.at(4 * SECOND);
    expect(await scrape(AGE)).toEqual([{ labels: '', value: 4 }]);
    expect(await scrape(BACKLOG)).toEqual([{ labels: '', value: 2 }]);
    expect(await scrape(LAPSE_AGE)).toEqual([{ labels: '', value: 4 }]);
    await one.stop();
    expect(await scrape(AGE)).toEqual([]);
    expect(await scrape(BACKLOG)).toEqual([]);
    expect(await scrape(LAPSE_AGE)).toEqual([]);
    expect(await scrape(FENCES)).toEqual([]);
  });

  it('no sampler: no lapse count age either', async () => {
    readFenceSamplesFrom(null);
    expect(await scrape(LAPSE_AGE)).toEqual([]);
  });
});

describe('#458 r2 F6: a failed lapse count never drops the backlog; its age says how old it is', () => {
  it('a count that keeps failing: the last successful count stands, and its age grows', async () => {
    const one = await sampler(3);
    try {
      for (const t of [30, 60, 90, 120, 600]) {
        await one.at(t * SECOND);
        expect(await scrape(BACKLOG)).toEqual([{ labels: '', value: 3 }]);
        expect(await scrape(LAPSE_AGE)).toEqual([{ labels: '', value: t }]);
      }
    } finally {
      await one.stop();
    }
  });

  it('only a successful count replaces it — recovery to zero included', async () => {
    let backlog = 3;
    let now = 0;
    const instance = new KeycloakFenceSampler(
      {
        fences: () => Promise.resolve(counts()),
        lapseBacklog: () =>
          now === 60 * SECOND ? Promise.resolve(backlog) : Promise.reject(new Error('down')),
      },
      { intervalMs: 3_600 * SECOND, lapseIntervalMs: LAPSE_TICK_MS, clock: () => now },
    );
    instance.start();
    await new Promise((done) => setImmediate(done));
    try {
      // No count yet: no backlog — unknown, not zero — and its age from the start.
      now = 30 * SECOND;
      instance.sampleLapses();
      await new Promise((done) => setImmediate(done));
      expect(await scrape(BACKLOG)).toEqual([]);
      expect(await scrape(LAPSE_AGE)).toEqual([{ labels: '', value: 30 }]);
      backlog = 0;
      now = 60 * SECOND;
      instance.sampleLapses();
      await new Promise((done) => setImmediate(done));
      expect(await scrape(BACKLOG)).toEqual([{ labels: '', value: 0 }]);
      expect(await scrape(LAPSE_AGE)).toEqual([{ labels: '', value: 0 }]);
    } finally {
      await instance.stop();
    }
  });

  it('the sibling: the fence gauges keep the latest successful sample through failed ones (RastaIdentityKeycloakReassertBacklog’s 20 m)', async () => {
    let calls = 0;
    const instance = new KeycloakFenceSampler(
      {
        fences: () =>
          calls++ === 0
            ? Promise.resolve({ ...counts(), live: 1, due: 2, total: 3 })
            : Promise.reject(new Error('down')),
        lapseBacklog: () => Promise.reject(new Error('down')),
      },
      { intervalMs: 3_600 * SECOND, lapseIntervalMs: LAPSE_TICK_MS, clock: () => 0 },
    );
    instance.start();
    await new Promise((done) => setImmediate(done));
    try {
      for (let failed = 0; failed < 5; failed++) {
        instance.tick();
        await new Promise((done) => setImmediate(done));
        expect(await scrape(FENCES)).toEqual(
          expect.arrayContaining([{ labels: '{state="due"}', value: 2 }]),
        );
      }
    } finally {
      await instance.stop();
    }
  });

  it('the reviewer’s hour — one successful count per 120 s, every other one failing: the backlog is 3 at every scrape', async () => {
    const one = await sampler(3, (t) => t % (120 * SECOND) === 0);
    try {
      for (let t = 0; t <= 3_600 * SECOND; t += 15 * SECOND) {
        await one.at(t);
        readFenceSamplesFrom(one.reader);
        // Never "3, absent, 3, absent": nothing resets the 20 minutes.
        expect({ t, backlog: await scrape(BACKLOG) }).toEqual({
          t,
          backlog: [{ labels: '', value: 3 }],
        });
        expect((await scrape(LAPSE_AGE))[0]!.value).toBeLessThan(120);
      }
    } finally {
      await one.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// The promtool fixtures are the real collector's output
// ---------------------------------------------------------------------------

type Replica = '3101' | '3111';

/** One replica's plan: no sampler, or a sampler whose lapse count succeeds at `countsAt`. */
type Plan = null | { backlog: number; countsAt?: (t: number) => boolean };

/**
 * promtool's expanding notation, as `promtool test rules` reads a series'
 * values: `a+bxn` is n+1 values from a by b, `axn` n+1 copies of a, and
 * `_xn` / `stalexn` n of them.
 */
function expand(values: string): string[] {
  const out: string[] = [];
  for (const token of values.trim().split(/\s+/)) {
    const match = /^(_|stale|-?\d+(?:\.\d+)?)(?:([+-]\d+(?:\.\d+)?)?x(\d+))?$/.exec(token);
    if (!match) throw new Error(`unreadable promtool value ${token}`);
    const [, first, step, times] = match;
    if (times === undefined) out.push(first!);
    else if (first === '_' || first === 'stale') {
      for (let i = 0; i < Number(times); i++) out.push(first);
    } else {
      for (let i = 0; i <= Number(times); i++) {
        out.push(String(Number(first) + i * Number(step ?? 0)));
      }
    }
  }
  return out;
}

/** The series of one promtool test, by its name: series selector → its values, one per interval. */
function fixture(name: string): { intervalMs: number; series: Map<string, string[]> } {
  const text = readFileSync(RULE_TESTS, 'utf8');
  const start = text.indexOf(`- name: '${name}'`);
  if (start < 0) throw new Error(`no promtool test named ${name}`);
  const next = text.indexOf('\n  - ', start + 1);
  const block = text.slice(start, next < 0 ? undefined : next);
  const interval = /\n\s+interval: (\d+)(s|m)\n/.exec(block);
  if (!interval) throw new Error(`no interval in ${name}`);
  const series = new Map<string, string[]>();
  const pairs = /- series: '([^']+)'\n\s+values: '([^']+)'/g;
  for (let pair = pairs.exec(block); pair; pair = pairs.exec(block)) {
    series.set(pair[1]!, expand(pair[2]!));
  }
  const unit = interval[2] === 'm' ? 60 * SECOND : SECOND;
  return { intervalMs: Number(interval[1]) * unit, series };
}

/** One scrape of one replica: its sampler (or none) attached, the registry rendered. */
async function scrapeReplica(
  reader: ReturnType<typeof readFenceSamplesFrom>,
  name: string,
): Promise<number | null> {
  readFenceSamplesFrom(reader);
  const samples = await scrape(name);
  readFenceSamplesFrom(null);
  if (samples.length > 1) throw new Error(`${name}: more than one sample`);
  return samples[0]?.value ?? null;
}

const RENDERED = [AGE, BACKLOG, LAPSE_AGE] as const;

/**
 * Runs each replica's plan — a real sampler on a clock the test moves, its
 * lapse ticks every 30 s — for `scrapes` scrapes `intervalMs` apart, and
 * renders the real registry for each replica at each scrape.
 */
async function simulate(
  plans: Record<Replica, Plan>,
  intervalMs: number,
  scrapes: number,
): Promise<Map<string, Array<number | null>>> {
  const rendered = new Map<string, Array<number | null>>();
  const replicas = Object.keys(plans) as Replica[];
  const samplers = new Map<Replica, Awaited<ReturnType<typeof sampler>>>();
  for (const replica of replicas) {
    const plan = plans[replica];
    if (plan) samplers.set(replica, await sampler(plan.backlog, plan.countsAt));
  }
  try {
    for (let index = 0; index < scrapes; index++) {
      const t = index * intervalMs;
      for (const replica of replicas) {
        const one = samplers.get(replica);
        await one?.at(t);
        for (const name of RENDERED) {
          const key = `${replica} ${name}`;
          rendered.set(key, [
            ...(rendered.get(key) ?? []),
            await scrapeReplica(one?.reader ?? null, name),
          ]);
        }
      }
    }
  } finally {
    for (const one of samplers.values()) await one.stop();
  }
  return rendered;
}

/** Holds every value of the fixture's collector series to the simulation; returns how many. */
async function expectFixtureIsCollectorOutput(
  name: string,
  plans: Record<Replica, Plan>,
): Promise<number> {
  const { intervalMs, series } = fixture(name);
  const lengths = new Set([...series.values()].map((values) => values.length));
  if (lengths.size !== 1) throw new Error(`${name}: series of different lengths`);
  const rendered = await simulate(plans, intervalMs, [...lengths][0]!);
  let checked = 0;
  for (const [selector, values] of series) {
    const metric = /^([a-z_]+)\{/.exec(selector)?.[1];
    if (!RENDERED.includes(metric as (typeof RENDERED)[number])) continue;
    const replica = /instance="host\.docker\.internal:(\d+)"/.exec(selector)?.[1] as Replica;
    const actual = rendered.get(`${replica} ${metric}`)!;
    for (const [index, token] of values.entries()) {
      // `_` and `stale`: the collector exported no sample at that scrape.
      const expected = token === '_' || token === 'stale' ? null : Number(token);
      expect({ selector, t: index * intervalMs, value: actual[index] }).toEqual({
        selector,
        t: index * intervalMs,
        value: expected,
      });
      checked += 1;
    }
  }
  return checked;
}

const EVERY_120_S = (t: number) => t % (120 * SECOND) === 0;
const EVERY_120_S_FROM_60 = (t: number) => t % (120 * SECOND) === 60 * SECOND;

describe('#458 r1 F3, r2 F6: the promtool tests read what the collector exports', () => {
  it('collector: one replica without a sampler, one whose sampling hangs', async () => {
    const checked = await expectFixtureIsCollectorOutput(
      'collector: one replica without a sampler, one whose sampling hangs',
      { '3101': null, '3111': { backlog: 0 } },
    );
    expect(checked).toBe(30);
  });

  it('collector: no replica has a sampler', async () => {
    const checked = await expectFixtureIsCollectorOutput('collector: no replica has a sampler', {
      '3101': null,
      '3111': null,
    });
    expect(checked).toBe(48);
  });

  it('collector: the lapse count fails on the only replica', async () => {
    const checked = await expectFixtureIsCollectorOutput(
      'collector: the lapse count fails on the only replica',
      { '3101': { backlog: 3 } } as Record<Replica, Plan>,
    );
    expect(checked).toBe(2 * 51);
  });

  it('collector: the lapse count succeeds once every 120 s on the only replica, for an hour', async () => {
    const checked = await expectFixtureIsCollectorOutput(
      'collector: the lapse count succeeds once every 120 s on the only replica, for an hour',
      { '3101': { backlog: 3, countsAt: EVERY_120_S } } as Record<Replica, Plan>,
    );
    expect(checked).toBe(2 * 241);
  });

  it('collector: two replicas, each counting once every 120 s, a minute apart', async () => {
    const checked = await expectFixtureIsCollectorOutput(
      'collector: two replicas, each counting once every 120 s, a minute apart',
      {
        '3101': { backlog: 3, countsAt: EVERY_120_S },
        '3111': { backlog: 3, countsAt: EVERY_120_S_FROM_60 },
      },
    );
    expect(checked).toBe(4 * 241);
  });

  it('collector: one replica counting once every 120 s, the other without a sampler', async () => {
    const checked = await expectFixtureIsCollectorOutput(
      'collector: one replica counting once every 120 s, the other without a sampler',
      { '3101': { backlog: 3, countsAt: EVERY_120_S }, '3111': null },
    );
    expect(checked).toBe(4 * 241);
  });
});
