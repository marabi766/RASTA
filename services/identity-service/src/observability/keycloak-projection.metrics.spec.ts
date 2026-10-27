import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { registry } from '@rasta/observability';
import { KeycloakFenceSampler, type FenceSampleSource } from '../keycloak/keycloak-fence-sampler';
import type { FenceCounts } from '../keycloak/keycloak-write-fence';
import { readFenceSamplesFrom } from './keycloak-projection.metrics';

/**
 * #458 r1 F3: a replica whose fence sampler is absent — never wired, not
 * started, or stopped — must export **no** age and no lapse backlog, never
 * prom-client's default zero, which reads as fresh and empty: it kept
 * `absent()` false for good and pulled `min(age)` under the stale threshold
 * on every other replica.
 *
 * What is checked is the **real** collector output — the registry's text
 * exposition, as Prometheus scrapes it — and the promtool tests named
 * `collector: …` in `rasta-identity-alerts.test.yml` are held to it, value by
 * value, so the rules are tested over what this service actually exports.
 */

const AGE = 'rasta_identity_keycloak_fence_sample_age_seconds';
const BACKLOG = 'rasta_identity_membership_lapse_backlog';
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
 * A real sampler on a clock the test moves: one successful fence sample and
 * lapse count when it starts, then every later one fails. Its timers never
 * fire by themselves (an interval far beyond the test).
 */
async function sampler(backlog: number) {
  let now = 0;
  let fenceCalls = 0;
  let lapseCalls = 0;
  const source: FenceSampleSource = {
    fences: () =>
      fenceCalls++ === 0 ? Promise.resolve(counts()) : Promise.reject(new Error('down')),
    lapseBacklog: () =>
      lapseCalls++ === 0 ? Promise.resolve(backlog) : Promise.reject(new Error('down')),
  };
  const instance = new KeycloakFenceSampler(source, {
    intervalMs: 3_600 * SECOND,
    lapseIntervalMs: 30 * SECOND,
    clock: () => now,
  });
  instance.start();
  await new Promise((done) => setImmediate(done));
  return {
    reader: () => instance.view(),
    at(ms: number) {
      now = ms;
    },
    /** One more lapse count, which fails. */
    countLapses() {
      instance.sampleLapses();
    },
    stop: () => instance.onModuleDestroy(),
  };
}

afterEach(() => {
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
    one.at(4 * SECOND);
    expect(await scrape(AGE)).toEqual([{ labels: '', value: 4 }]);
    expect(await scrape(BACKLOG)).toEqual([{ labels: '', value: 2 }]);
    await one.stop();
    expect(await scrape(AGE)).toEqual([]);
    expect(await scrape(BACKLOG)).toEqual([]);
    expect(await scrape(FENCES)).toEqual([]);
  });

  it('a lapse count that keeps failing: the last count stands three intervals, then the series goes', async () => {
    const one = await sampler(3);
    try {
      for (const t of [30, 60, 90]) {
        one.at(t * SECOND);
        one.countLapses();
        await new Promise((done) => setImmediate(done));
        expect(await scrape(BACKLOG)).toEqual([{ labels: '', value: 3 }]);
      }
      one.at(91 * SECOND);
      expect(await scrape(BACKLOG)).toEqual([]);
    } finally {
      await one.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// The promtool fixtures are the real collector's output
// ---------------------------------------------------------------------------

type Replica = '3101' | '3111';

/** One replica's exported value of `name` at `t` ms, rendered by the real collector; null: no sample. */
type Render = (replica: Replica, name: string, t: number) => Promise<number | null>;

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
    series.set(pair[1]!, pair[2]!.split(' '));
  }
  const unit = interval[2] === 'm' ? 60 * SECOND : SECOND;
  return { intervalMs: Number(interval[1]) * unit, series };
}

async function expectFixtureIsCollectorOutput(name: string, render: Render): Promise<number> {
  const { intervalMs, series } = fixture(name);
  let checked = 0;
  for (const [selector, values] of series) {
    const metric = /^([a-z_]+)\{/.exec(selector)?.[1];
    if (metric !== AGE && metric !== BACKLOG) continue;
    const replica = /instance="host\.docker\.internal:(\d+)"/.exec(selector)?.[1] as Replica;
    for (const [index, token] of values.entries()) {
      const rendered = await render(replica, metric, index * intervalMs);
      // `_` and `stale`: the collector exported no sample at that scrape.
      const expected = token === '_' || token === 'stale' ? null : Number(token);
      expect({ selector, t: index * intervalMs, value: rendered }).toEqual({
        selector,
        t: index * intervalMs,
        value: expected,
      });
      checked += 1;
    }
  }
  return checked;
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

describe('#458 r1 F3: the promtool tests read what the collector exports', () => {
  it('collector: one replica without a sampler, one whose sampling hangs', async () => {
    const hanging = await sampler(0);
    try {
      const checked = await expectFixtureIsCollectorOutput(
        'collector: one replica without a sampler, one whose sampling hangs',
        async (replica, name, t) => {
          if (replica === '3101') return scrapeReplica(null, name);
          hanging.at(t);
          return scrapeReplica(hanging.reader, name);
        },
      );
      expect(checked).toBe(20);
    } finally {
      await hanging.stop();
    }
  });

  it('collector: no replica has a sampler', async () => {
    const checked = await expectFixtureIsCollectorOutput(
      'collector: no replica has a sampler',
      async (_replica, name) => scrapeReplica(null, name),
    );
    expect(checked).toBe(32);
  });

  it('collector: the lapse count fails on the only replica', async () => {
    const failing = await sampler(3);
    try {
      let counted = 0;
      const checked = await expectFixtureIsCollectorOutput(
        'collector: the lapse count fails on the only replica',
        async (_replica, name, t) => {
          failing.at(t);
          // Its own 30 s timer: one more count — which fails — per interval.
          if (t > counted) {
            counted = t;
            failing.countLapses();
            await new Promise((done) => setImmediate(done));
          }
          return scrapeReplica(failing.reader, name);
        },
      );
      expect(checked).toBe(16);
    } finally {
      await failing.stop();
    }
  });
});
