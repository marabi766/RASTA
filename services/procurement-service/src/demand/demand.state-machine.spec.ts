import {
  AGGREGATION_COMMANDS,
  AGGREGATION_STATES,
  AGGREGATION_TRANSITIONS,
  DEMAND_COMMANDS,
  DEMAND_STATES,
  DEMAND_TRANSITIONS,
  FINAL_AGGREGATION_STATES,
  FINAL_DEMAND_STATES,
  INITIAL_AGGREGATION_STATE,
  INITIAL_DEMAND_STATE,
  canTransitionAggregation,
  canTransitionDemand,
  closingInstant,
  extendedClosingInstant,
  windowOutcome,
  type AggregationStateName,
  type DemandStateName,
  type WindowSnapshot,
} from './demand.state-machine';

const DEMAND_DECLARED: ReadonlyArray<readonly [DemandStateName, DemandStateName]> = [
  ['SUBMITTED', 'WITHDRAWN'],
  ['SUBMITTED', 'REFERRED'],
  ['SUBMITTED', 'LAPSED'],
];

const AGGREGATION_DECLARED: ReadonlyArray<readonly [AggregationStateName, AggregationStateName]> = [
  ['OPEN', 'READY'],
  ['OPEN', 'OPEN'],
  ['OPEN', 'REFERRED'],
  ['OPEN', 'LAPSED'],
  ['READY', 'RFQ_ISSUED'],
  ['READY', 'CANCELLED'],
];

describe('the demand lifecycle (ADR-070 § 2)', () => {
  it('declares exactly the transitions of the ADR', () => {
    expect(DEMAND_TRANSITIONS.map((entry) => [entry.from, entry.to])).toEqual(DEMAND_DECLARED);
    expect([...DEMAND_STATES]).toEqual(['SUBMITTED', 'WITHDRAWN', 'REFERRED', 'LAPSED']);
  });

  it('walks every (from, to) pair: only the declared ones are transitions', () => {
    for (const from of DEMAND_STATES) {
      for (const to of DEMAND_STATES) {
        const declared = DEMAND_DECLARED.some(([a, b]) => a === from && b === to);
        expect([from, to, canTransitionDemand(from, to)]).toEqual([from, to, declared]);
      }
    }
  });

  it('starts SUBMITTED, and nothing leaves a final state', () => {
    expect(INITIAL_DEMAND_STATE).toBe('SUBMITTED');
    for (const final of FINAL_DEMAND_STATES) {
      expect(DEMAND_TRANSITIONS.filter((entry) => entry.from === final)).toEqual([]);
    }
  });

  it('gives every command exactly one transition', () => {
    for (const command of DEMAND_COMMANDS) {
      expect(DEMAND_TRANSITIONS.filter((entry) => entry.command === command)).toHaveLength(1);
    }
  });

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(DEMAND_TRANSITIONS)).toBe(true);
    for (const entry of DEMAND_TRANSITIONS) expect(Object.isFrozen(entry)).toBe(true);
  });
});

describe('the aggregation lifecycle (ADR-070 § 2)', () => {
  it('declares exactly the transitions of the ADR', () => {
    expect(AGGREGATION_TRANSITIONS.map((entry) => [entry.from, entry.to])).toEqual(
      AGGREGATION_DECLARED,
    );
  });

  it('walks every (from, to) pair: only the declared ones are transitions', () => {
    for (const from of AGGREGATION_STATES) {
      for (const to of AGGREGATION_STATES) {
        const declared = AGGREGATION_DECLARED.some(([a, b]) => a === from && b === to);
        expect([from, to, canTransitionAggregation(from, to)]).toEqual([from, to, declared]);
      }
    }
  });

  it('starts OPEN; RFQ_ISSUED, REFERRED, LAPSED and CANCELLED are final', () => {
    expect(INITIAL_AGGREGATION_STATE).toBe('OPEN');
    expect([...FINAL_AGGREGATION_STATES]).toEqual([
      'RFQ_ISSUED',
      'REFERRED',
      'LAPSED',
      'CANCELLED',
    ]);
    for (const final of FINAL_AGGREGATION_STATES) {
      expect(AGGREGATION_TRANSITIONS.filter((entry) => entry.from === final)).toEqual([]);
    }
  });

  it('gives every command exactly one transition, and READY back to OPEN none (Q-121 (4))', () => {
    for (const command of AGGREGATION_COMMANDS) {
      expect(AGGREGATION_TRANSITIONS.filter((entry) => entry.command === command)).toHaveLength(1);
    }
    expect(canTransitionAggregation('READY', 'OPEN')).toBe(false);
    expect(canTransitionAggregation('RFQ_ISSUED', 'READY')).toBe(false);
  });
});

describe('the end of a window', () => {
  const snapshot = (overrides: Partial<WindowSnapshot> = {}): WindowSnapshot => ({
    windowHours: 168,
    minQuantity: 10,
    shortfallPolicy: 'EXTEND',
    ...overrides,
  });
  const closesAt = new Date('2026-10-16T10:00:00.000Z');
  const HOUR = 3_600_000;

  it('is READY with a live demand and the total at the threshold — or past it', () => {
    for (const total of [10n, 11n]) {
      expect(
        windowOutcome(snapshot(), { liveDemands: 2, totalQuantity: total }, closesAt, closesAt),
      ).toEqual({ command: 'reachThreshold', to: 'READY' });
    }
  });

  it('is READY with any live demand when the threshold is zero (Q-10’s default)', () => {
    expect(
      windowOutcome(
        snapshot({ minQuantity: 0 }),
        { liveDemands: 1, totalQuantity: 1n },
        closesAt,
        closesAt,
      ).to,
    ).toBe('READY');
  });

  it('is LAPSED with no live demand, whatever the policy and the threshold', () => {
    for (const shortfallPolicy of ['EXTEND', 'REFER', 'CLOSE'] as const) {
      expect(
        windowOutcome(
          snapshot({ shortfallPolicy, minQuantity: 0 }),
          { liveDemands: 0, totalQuantity: 0n },
          closesAt,
          closesAt,
        ),
      ).toEqual({ command: 'lapse', to: 'LAPSED', demandsTo: 'LAPSED' });
    }
  });

  it('follows the snapshot’s policy one short of the threshold', () => {
    const short = { liveDemands: 1, totalQuantity: 9n };
    expect(
      windowOutcome(snapshot({ shortfallPolicy: 'REFER' }), short, closesAt, closesAt),
    ).toEqual({ command: 'refer', to: 'REFERRED', demandsTo: 'REFERRED' });
    expect(
      windowOutcome(snapshot({ shortfallPolicy: 'CLOSE' }), short, closesAt, closesAt),
    ).toEqual({ command: 'lapse', to: 'LAPSED', demandsTo: 'LAPSED' });
    expect(windowOutcome(snapshot(), short, closesAt, closesAt)).toEqual({
      command: 'extend',
      to: 'OPEN',
      windows: 1,
    });
  });

  it('extends by as many lengths as it takes to reach past now, the end itself counting as past', () => {
    const short = { liveDemands: 1, totalQuantity: 1n };
    const at = (ms: number) => new Date(closesAt.getTime() + ms);
    const windowsAt = (ms: number) => {
      const outcome = windowOutcome(snapshot({ windowHours: 2 }), short, closesAt, at(ms));
      return outcome.command === 'extend' ? outcome.windows : null;
    };
    expect(windowsAt(0)).toBe(1);
    expect(windowsAt(2 * HOUR - 1)).toBe(1);
    expect(windowsAt(2 * HOUR)).toBe(2);
    expect(windowsAt(5 * HOUR)).toBe(3);
    const moved = extendedClosingInstant(closesAt, 2, 3);
    expect(moved.getTime() - at(5 * HOUR).getTime()).toBeGreaterThan(0);
  });

  it('closes a window its length after it opened (exclusive end)', () => {
    const opened = new Date('2026-10-09T10:00:00.000Z');
    expect(closingInstant(opened, 168).toISOString()).toBe(closesAt.toISOString());
  });
});
