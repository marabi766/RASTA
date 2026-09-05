import {
  assertReinstatable,
  assertSuspendable,
  canTransitionSupplier,
  isOpenEpisode,
  statusFromEpisodes,
  SUPPLIER_STATUSES,
  SUSPENSION_TRANSITIONS,
  type SupplierStatusName,
} from './suspension.state-machine';

/**
 * Suspension and reinstatement, both directions, plus the shapes that are
 * refused rather than silently accepted.
 */

const ALL_PAIRS: [SupplierStatusName, SupplierStatusName][] = SUPPLIER_STATUSES.flatMap((from) =>
  SUPPLIER_STATUSES.map((to): [SupplierStatusName, SupplierStatusName] => [from, to]),
);

describe('the transition table', () => {
  it('allows suspending an active supplier', () => {
    expect(canTransitionSupplier('ACTIVE', 'SUSPENDED')).toBe(true);
  });

  it('allows reinstating a suspended one — the cycle is repeatable', () => {
    // Unlike qualification, neither state is terminal. A supplier may be
    // suspended, reinstated and suspended again, and each episode is its own
    // auditable row.
    expect(canTransitionSupplier('SUSPENDED', 'ACTIVE')).toBe(true);
  });

  it.each(ALL_PAIRS.filter(([from, to]) => from === to))(
    'refuses the no-op %s → %s',
    (from, to) => {
      expect(canTransitionSupplier(from, to)).toBe(false);
    },
  );

  it('covers every ordered pair, so nothing is legal by omission', () => {
    const declared = Object.entries(SUSPENSION_TRANSITIONS).flatMap(([from, targets]) =>
      targets.map((to) => `${from}->${to}`),
    );

    expect(declared.sort()).toEqual(['ACTIVE->SUSPENDED', 'SUSPENDED->ACTIVE']);
  });
});

describe('suspending', () => {
  it('accepts an active supplier', () => {
    expect(() => assertSuspendable({ id: 'SUP_1', status: 'ACTIVE' })).not.toThrow();
  });

  it('refuses a supplier that is already suspended rather than accepting it quietly', () => {
    // Accepting silently would either overwrite the first episode's reason and
    // actor — losing who actually suspended them — or open a second episode,
    // which `ux_suspension_open` refuses at the database anyway. A refusal here
    // is a diagnosable 422 instead of a constraint violation.
    expect(() => assertSuspendable({ id: 'SUP_1', status: 'SUSPENDED' })).toThrow(
      /already suspended/i,
    );
  });
});

describe('reinstating', () => {
  it('accepts a suspended supplier', () => {
    expect(() => assertReinstatable({ id: 'SUP_1', status: 'SUSPENDED' })).not.toThrow();
  });

  it('refuses a supplier that is not suspended', () => {
    // A reinstatement with no episode to close would write an actor and a
    // timestamp onto nothing, and the audit trail would show a lifting that
    // lifted no suspension.
    expect(() => assertReinstatable({ id: 'SUP_1', status: 'ACTIVE' })).toThrow(/not suspended/i);
  });
});

describe('episodes and the denormalised status', () => {
  const open = { reinstatedAt: null };
  const closed = { reinstatedAt: new Date('2026-03-01T00:00:00.000Z') };

  it('treats an episode with no reinstatement stamp as open', () => {
    expect(isOpenEpisode(open)).toBe(true);
    expect(isOpenEpisode(closed)).toBe(false);
  });

  it('derives ACTIVE from a history with no open episode', () => {
    expect(statusFromEpisodes([])).toBe('ACTIVE');
    expect(statusFromEpisodes([closed, closed])).toBe('ACTIVE');
  });

  it('derives SUSPENDED from any open episode', () => {
    expect(statusFromEpisodes([closed, open])).toBe('SUSPENDED');
  });

  it('keeps closed episodes in the history — reinstating is not deletion', () => {
    // The whole reason suspension is a table rather than a boolean: "who
    // suspended this supplier in March and who lifted it" has to stay
    // answerable afterwards.
    const history = [closed, closed, open];

    expect(history).toHaveLength(3);
    expect(statusFromEpisodes(history)).toBe('SUSPENDED');
  });
});
