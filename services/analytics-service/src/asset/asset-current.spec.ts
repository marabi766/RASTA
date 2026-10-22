import {
  EMPTY_ASSET_STATE,
  applyAssetEvent,
  type AssetEvent,
  type AssetOutcome,
  type AssetState,
} from './asset-current';

/**
 * ADR-071 § 3-الف, revision 2 (#335 review round 2, F2): transfers and creations that arrive
 * out of order are not contradictions, and the projection converges on the producer's state
 * whatever the arrival order.
 */

const A = 'ORG-A';
const B = 'ORG-B';
const C = 'ORG-C';
const X = 'ORG-X';

const created: AssetEvent = { kind: 'CREATED', seq: 1, tenant: A, type: 'TRUCK', status: 'DRAFT' };
const activated: AssetEvent = { kind: 'STATUS', seq: 2, tenant: A, status: 'ACTIVE' };
const aToB: AssetEvent = { kind: 'TRANSFERRED', seq: 10, tenant: B, from: A, to: B, generation: 1 };
const bToC: AssetEvent = { kind: 'TRANSFERRED', seq: 11, tenant: C, from: B, to: C, generation: 2 };

function run(events: readonly AssetEvent[]): { state: AssetState; outcomes: AssetOutcome[] } {
  let state = EMPTY_ASSET_STATE;
  const outcomes: AssetOutcome[] = [];
  for (const event of events) {
    const outcome = applyAssetEvent(state, event);
    outcomes.push(outcome);
    if (outcome.outcome === 'APPLIED') state = outcome.state;
  }
  return { state, outcomes };
}

/** The state with its sets in a fixed order, so two arrival orders compare equal. */
function normalized(state: AssetState) {
  return {
    current: state.current,
    ownership: [...state.ownership].sort(
      (x, y) => x.generation - y.generation || x.kind.localeCompare(y.kind),
    ),
    ownershipEvents: [...state.ownershipEvents].sort((x, y) => x.seq - y.seq),
  };
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

const PRODUCER_STATE = {
  current: {
    organizationId: C,
    ownerKnown: true,
    ownerSeq: 11,
    ownerGeneration: 2,
    // The last transfer reset it, as asset-service does in the transfer's own transaction
    // (#335 review round 3, F1): the same in every arrival order, and the producer's value.
    status: 'REGISTERED',
    statusSeq: 11,
    type: 'TRUCK',
  },
  ownership: [
    { organizationId: A, generation: 0, kind: 'END' },
    { organizationId: A, generation: 0, kind: 'START' },
    { organizationId: B, generation: 1, kind: 'END' },
    { organizationId: B, generation: 1, kind: 'START' },
    { organizationId: C, generation: 2, kind: 'START' },
  ],
  ownershipEvents: [
    { seq: 1, generation: 0 },
    { seq: 10, generation: 1 },
    { seq: 11, generation: 2 },
  ],
};

describe('the review’s chain: B→C arrives before A→B', () => {
  it('accepts both, ends with C as the owner, and keeps every transition', () => {
    const { state, outcomes } = run([created, bToC, aToB]);

    expect(outcomes.map((o) => o.outcome)).toEqual(['APPLIED', 'APPLIED', 'APPLIED']);
    expect(state.current).toMatchObject({ organizationId: C, ownerGeneration: 2, ownerSeq: 11 });
    expect(normalized(state).ownership).toEqual(PRODUCER_STATE.ownership);
  });

  it('counts the asset in C’s fleet only, after either order', () => {
    for (const order of [
      [created, aToB, bToC],
      [created, bToC, aToB],
    ]) {
      const owner = run(order).state.current?.organizationId;
      expect([A, B, C].filter((org) => org === owner)).toEqual([C]);
    }
  });
});

describe('convergence', () => {
  const events = [created, activated, aToB, bToC];

  it.each(permutations(events).map((order) => [order.map((e) => e.seq).join('→'), order]))(
    'reaches the producer’s state in arrival order %s',
    (_label, order) => {
      const { state, outcomes } = run(order as AssetEvent[]);
      expect(outcomes.every((o) => o.outcome === 'APPLIED')).toBe(true);
      expect(normalized(state)).toEqual(PRODUCER_STATE);
    },
  );

  it('reaches the same state with any one event delivered twice, at any point', () => {
    for (const order of permutations(events)) {
      for (const repeated of order) {
        for (let at = 0; at <= order.length; at += 1) {
          const delivered = [...order.slice(0, at), repeated, ...order.slice(at)];
          expect(normalized(run(delivered).state)).toEqual(PRODUCER_STATE);
        }
      }
    }
  });
});

describe('activation before creation (the review’s second case)', () => {
  it('keeps the activation’s status and still takes the type from the later-arriving creation', () => {
    const { state, outcomes } = run([activated, created]);

    expect(outcomes.map((o) => o.outcome)).toEqual(['APPLIED', 'APPLIED']);
    expect(state.current).toMatchObject({
      organizationId: A,
      ownerKnown: true,
      status: 'ACTIVE',
      statusSeq: 2,
      type: 'TRUCK',
    });
  });
});

describe('a predecessor that never arrives', () => {
  it('takes B→C alone: owner C, type unknown, status the transfer’s, nothing dead-lettered', () => {
    const { state, outcomes } = run([bToC]);

    expect(outcomes.map((o) => o.outcome)).toEqual(['APPLIED']);
    expect(state.current).toMatchObject({ organizationId: C, type: null, status: 'REGISTERED' });
  });
});

describe('the tenant of a status event is not an ownership statement', () => {
  it('applies a status stamped under B while the row still shows A, and moves the row only with the transfer', () => {
    const outOfService: AssetEvent = {
      kind: 'STATUS',
      seq: 12,
      tenant: B,
      status: 'OUT_OF_SERVICE',
    };

    const before = run([created, outOfService]);
    expect(before.outcomes.map((o) => o.outcome)).toEqual(['APPLIED', 'APPLIED']);
    expect(before.state.current).toMatchObject({ organizationId: A, status: 'OUT_OF_SERVICE' });

    const after = run([created, outOfService, aToB]);
    expect(after.state.current).toMatchObject({ organizationId: B, status: 'OUT_OF_SERVICE' });
  });

  it('keeps a provisional owner only until an ownership event, and the same one in either order', () => {
    const underA: AssetEvent = { kind: 'STATUS', seq: 3, tenant: A, status: 'ACTIVE' };
    const underB: AssetEvent = { kind: 'STATUS', seq: 12, tenant: B, status: 'IDLE' };

    for (const order of [
      [underA, underB],
      [underB, underA],
    ]) {
      expect(run(order).state.current).toMatchObject({
        organizationId: B,
        ownerKnown: false,
        status: 'IDLE',
      });
      // An ownership event outranks the provisional owner even with a lower sequence.
      expect(run([...order, aToB]).state.current).toMatchObject({
        organizationId: B,
        ownerKnown: true,
        ownerSeq: 10,
      });
      expect(run([...order, created]).state.current).toMatchObject({
        organizationId: A,
        ownerKnown: true,
      });
    }
  });

  it('lets an event this projection does not read change nothing, before or after the row exists', () => {
    const updated: AssetEvent = { kind: 'OTHER', seq: 20, tenant: X };
    expect(run([updated]).state).toEqual(EMPTY_ASSET_STATE);
    expect(run([updated, created]).state).toEqual(run([created, updated]).state);
    expect(run([created, updated]).state).toEqual(run([created]).state);

    // Not even a provisional owner, which only a status event may set.
    const underA: AssetEvent = { kind: 'STATUS', seq: 3, tenant: A, status: 'ACTIVE' };
    expect(run([underA, updated]).state).toEqual(run([underA]).state);
    expect(run([updated, underA]).state).toEqual(run([underA]).state);
  });
});

describe('real contradictions, whichever arrives second', () => {
  const xToC: AssetEvent = {
    kind: 'TRANSFERRED',
    seq: 11,
    tenant: C,
    from: X,
    to: C,
    generation: 2,
  };
  const createdAsBus: AssetEvent = { ...created, type: 'BUS' } as AssetEvent;
  // Generation 0 after generation 1 in sequence order.
  const lateCreation: AssetEvent = { ...created, seq: 15 } as AssetEvent;

  it.each([
    ['two owners for generation 1 (A→B, then X→C)', aToB, xToC],
    ['a second type', created, createdAsBus],
    ['sequence and generation in opposite orders', aToB, lateCreation],
  ])('refuses %s in both orders and leaves the state as it was', (_label, first, second) => {
    for (const [one, two] of [
      [first, second],
      [second, first],
    ]) {
      const held = run([one]).state;
      const outcome = applyAssetEvent(held, two);
      expect(outcome.outcome).toBe('CONTRADICTION');
    }
  });

  it('is not a contradiction that the row sits with neither the origin nor the destination', () => {
    const held = run([created]).state; // owner A
    expect(applyAssetEvent(held, bToC).outcome).toBe('APPLIED');
  });
});

describe('what is invalid before anything is compared', () => {
  it.each([
    ['a transfer not published under its destination', { ...bToC, tenant: B }],
    ['a transfer from an organization to itself', { ...bToC, from: C }],
    ['a transfer to generation 0', { ...bToC, generation: 0 }],
    ['an event with no stream sequence', { ...activated, seq: 0 }],
    ['an event with a fractional sequence', { ...activated, seq: 2.5 }],
  ])('refuses %s', (_label, event) => {
    expect(applyAssetEvent(EMPTY_ASSET_STATE, event as AssetEvent).outcome).toBe('INVALID');
  });
});

describe('the status after a transfer (#335 review round 3, F1)', () => {
  it.each(permutations([created, activated, aToB]).map((o) => [o.map((e) => e.seq).join('→'), o]))(
    'is REGISTERED under the new owner, as the producer holds it — arrival order %s',
    (_label, order) => {
      expect(run(order as AssetEvent[]).state.current).toMatchObject({
        organizationId: B,
        status: 'REGISTERED',
        statusSeq: 10,
      });
    },
  );

  it('a late activation from before the transfer does not bring its status back', () => {
    expect(run([created, aToB, activated]).state.current).toMatchObject({
      organizationId: B,
      status: 'REGISTERED',
    });
  });

  it('a reactivation after the transfer is ACTIVE again, in either arrival order', () => {
    const reactivated: AssetEvent = { kind: 'STATUS', seq: 11, tenant: B, status: 'ACTIVE' };
    for (const order of [
      [created, activated, aToB, reactivated],
      [created, reactivated, activated, aToB],
    ]) {
      expect(run(order).state.current).toMatchObject({
        organizationId: B,
        status: 'ACTIVE',
        statusSeq: 11,
      });
    }
  });
});
