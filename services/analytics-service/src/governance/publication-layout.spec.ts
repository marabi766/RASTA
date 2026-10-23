import {
  assertThresholds,
  layoutBlock,
  type BlockFact,
  type BlockInput,
  type BlockLayout,
  type Thresholds,
} from './publication-layout';

/**
 * ADR-071 § 5 (6)–(7), revision 2 (#335 review round 2, F1, and the PM ruling).
 *
 * Every published number is the sum of a measure over a set of facts. In any linear
 * combination of published numbers, two facts that belong to exactly the same published sets
 * get the same coefficient. So a group whose sum some combination determines is a union of
 * such **signature classes** (facts in no published set get 0 and are in no such group). If
 * every class meets both thresholds, so does every determinable group: no combination, of any
 * numbers from any blocks, isolates a record or a small group. `exposure()` checks exactly
 * that, over every block at once; it may only over-report, never miss.
 */

const THREE: Thresholds = { minOrganizations: 3, minRecords: 3 };

interface Fact extends BlockFact {
  readonly id: string;
}

let sequence = 0;
function fact(organizationId: string, cell: string, amount: bigint): Fact {
  sequence += 1;
  return { id: `F${sequence}`, organizationId, cell, measures: { count: 1n, amount } };
}

/** The fact sets whose sums a block's layout publishes. */
function publishedSets(
  input: Omit<BlockInput, 'facts'> & { facts: readonly Fact[] },
  layout: BlockLayout,
) {
  const sets: { label: string; members: readonly Fact[] }[] = layout.cells
    .filter((cell) => cell.status === 'AVAILABLE')
    .map((cell) => ({
      label: cell.cell,
      members: input.facts.filter((f) => f.cell === cell.cell),
    }));
  if (layout.total?.status === 'AVAILABLE') sets.push({ label: 'total', members: input.facts });
  return sets;
}

function meets(group: readonly Fact[], thresholds: Thresholds): boolean {
  return (
    group.length >= thresholds.minRecords &&
    new Set(group.map((f) => f.organizationId)).size >= thresholds.minOrganizations
  );
}

/** A signature class below the thresholds, described, or null when there is none. */
function exposure(
  sets: readonly { label: string; members: readonly Fact[] }[],
  thresholds: Thresholds,
): string | null {
  const signatureOf = new Map<Fact, string[]>();
  for (const set of sets) {
    for (const member of set.members) {
      signatureOf.set(member, [...(signatureOf.get(member) ?? []), set.label]);
    }
  }
  const classes = new Map<string, Fact[]>();
  for (const [member, signature] of signatureOf) {
    const key = signature.join(' ∩ ');
    classes.set(key, [...(classes.get(key) ?? []), member]);
  }
  for (const [key, members] of classes) {
    if (!meets(members, thresholds)) return `${key} only: ${members.map((f) => f.id).join(', ')}`;
  }
  return null;
}

/** Each fact's coefficient in Σ coefficient × set, the facts at 0 left out. */
function combine(terms: readonly [number, readonly Fact[]][]): Map<Fact, number> {
  const onFact = new Map<Fact, number>();
  for (const [coefficient, members] of terms) {
    for (const member of members) onFact.set(member, (onFact.get(member) ?? 0) + coefficient);
  }
  return new Map([...onFact].filter(([, coefficient]) => coefficient !== 0));
}

describe('the review’s counterexample (#335 round 2, F1)', () => {
  // Thresholds 3 and 3. Parent N contains subtree C and other organizations.
  const insideX = [fact('C1', 'X', 20n), fact('C2', 'X', 20n), fact('C3', 'X', 20n)];
  const insideY = [fact('C1', 'Y', 50n), fact('C2', 'Y', 50n), fact('C3', 'Y', 50n)];
  const outsideX = [fact('O1', 'X', 80n), fact('O2', 'X', 80n), fact('O3', 'X', 80n)];
  const outsideY = [fact('O4', 'Y', 123n)];
  const all = [...insideX, ...insideY, ...outsideX, ...outsideY];

  it('is real, and found by the check, when a child subtree is published beside its parent (round 2’s layout)', () => {
    const nY = [...insideY, ...outsideY];
    const cTotal = [...insideX, ...insideY];

    // N.Y − C.total + C.X = 273 − 210 + 60 = 123: the outside organization's one record.
    const isolated = combine([
      [1, nY],
      [-1, cTotal],
      [1, insideX],
    ]);
    expect([...isolated]).toEqual([[outsideY[0], 1]]);

    const sets = [
      { label: 'N.Y', members: nY },
      { label: 'C.total', members: cTotal },
      { label: 'C.X', members: insideX },
    ];
    expect(exposure(sets, THREE)).toBe(`N.Y only: ${outsideY[0]!.id}`);
  });

  it('cannot be built under the ruling: one root, one block, no child scope', () => {
    const input = { cells: ['X', 'Y'], totalMeasures: ['count'], facts: all, thresholds: THREE };
    const layout = layoutBlock(input);

    expect(layout.cells).toEqual([
      { cell: 'X', status: 'AVAILABLE', measures: { amount: 300n, count: 6n } },
      { cell: 'Y', status: 'AVAILABLE', measures: { amount: 273n, count: 4n } },
    ]);
    expect(layout.total).toEqual({ status: 'AVAILABLE', measures: { count: 10n } });
    expect(exposure(publishedSets(input, layout), THREE)).toBeNull();
  });
});

describe('several blocks at once: two roots, two groups', () => {
  it('exposes nothing, even to a reader of every block', () => {
    const blocks = [
      // Root N, PERIOD: Z is a small cell.
      {
        prefix: 'N',
        cells: ['X', 'Y', 'Z'],
        facts: [
          fact('A1', 'X', 1n),
          fact('A2', 'X', 2n),
          fact('A3', 'X', 3n),
          fact('A4', 'X', 4n),
          fact('A1', 'Y', 5n),
          fact('A2', 'Y', 6n),
          fact('A5', 'Y', 7n),
          fact('A6', 'Z', 99n),
        ],
      },
      // Root N, LATE: one late record.
      { prefix: 'N.late', cells: ['X', 'Y', 'Z'], facts: [fact('A2', 'Y', 17n)] },
      // Root M, PERIOD.
      {
        prefix: 'M',
        cells: ['X', 'Y'],
        facts: [
          fact('B1', 'X', 1n),
          fact('B2', 'X', 1n),
          fact('B3', 'X', 1n),
          fact('B1', 'Y', 8n),
          fact('B4', 'Y', 9n),
          fact('B5', 'Y', 10n),
        ],
      },
    ];

    const sets = blocks.flatMap(({ prefix, cells, facts }) => {
      const input = { cells, totalMeasures: ['count'], facts, thresholds: THREE };
      return publishedSets(input, layoutBlock(input)).map((s) => ({
        ...s,
        label: `${prefix}.${s.label}`,
      }));
    });

    // N: Z alone is one organization, so Y (the smaller published cell) is suppressed with it.
    // N.late: one record, nothing published. M: both cells and the total.
    expect(sets.map((s) => s.label)).toEqual(['N.X', 'N.total', 'M.X', 'M.Y', 'M.total']);
    expect(exposure(sets, THREE)).toBeNull();
  });
});

describe('the layout rules', () => {
  it('suppresses every number while the thresholds are unset (Q-141 (2), fail closed)', () => {
    const layout = layoutBlock({
      cells: ['X'],
      totalMeasures: ['count'],
      facts: ['A', 'B', 'C', 'D'].map((org) => fact(org, 'X', 1n)),
      thresholds: undefined,
    });
    expect(layout).toEqual({
      cells: [{ cell: 'X', status: 'SUPPRESSED' }],
      total: { status: 'SUPPRESSED' },
    });
  });

  const THREE_AND_FOUR = { minOrganizations: 3, minRecords: 4 };
  it.each([
    ['k organizations and m records', ['A', 'B', 'C', 'C'], 'AVAILABLE'],
    ['k − 1 organizations, m records', ['A', 'A', 'B', 'B'], 'SUPPRESSED'],
    ['k organizations, m − 1 records', ['A', 'B', 'C'], 'SUPPRESSED'],
  ])('publishes a cell at exactly the thresholds and not below: %s', (_label, orgs, status) => {
    const layout = layoutBlock({
      cells: ['X'],
      totalMeasures: [],
      facts: orgs.map((org) => fact(org, 'X', 1n)),
      thresholds: THREE_AND_FOUR,
    });
    expect(layout.cells[0]?.status).toBe(status);
  });

  it('suppresses a published cell when the suppressed ones alone would be a small group (complementary)', () => {
    const input = {
      cells: ['X', 'Y', 'Z'],
      totalMeasures: ['count'],
      facts: [
        ...['A', 'B', 'C', 'D', 'E'].map((org) => fact(org, 'X', 1n)),
        ...['A', 'B', 'C', 'D'].map((org) => fact(org, 'Y', 1n)),
        fact('F', 'Z', 1n),
      ],
      thresholds: THREE,
    };
    const layout = layoutBlock(input);

    expect(layout.cells.map((c) => [c.cell, c.status])).toEqual([
      ['X', 'AVAILABLE'],
      ['Y', 'SUPPRESSED'],
      ['Z', 'SUPPRESSED'],
    ]);
    expect(layout.total?.status).toBe('AVAILABLE');
    expect(exposure(publishedSets(input, layout), THREE)).toBeNull();
  });

  it('publishes no total for a measure that cannot be summed across cells, and needs no complement then', () => {
    const input = {
      cells: ['IRR', 'USD'],
      totalMeasures: [],
      facts: [...['A', 'B', 'C'].map((org) => fact(org, 'IRR', 10n)), fact('D', 'USD', 7n)],
      thresholds: THREE,
    };
    const layout = layoutBlock(input);

    expect(layout.total).toBeNull();
    expect(layout.cells.map((c) => c.status)).toEqual(['AVAILABLE', 'SUPPRESSED']);
    expect(exposure(publishedSets(input, layout), THREE)).toBeNull();
  });

  it('refuses a fact outside the declared partition', () => {
    expect(() =>
      layoutBlock({
        cells: ['X'],
        totalMeasures: [],
        facts: [fact('A', 'W', 1n)],
        thresholds: THREE,
      }),
    ).toThrow('no declared cell');
  });

  it.each([
    [{ minOrganizations: 2, minRecords: 3 }, 'below 3'],
    [{ minOrganizations: 3, minRecords: 0 }, 'at least 1'],
    [{ minOrganizations: 3.5, minRecords: 3 }, 'whole numbers'],
  ])('refuses thresholds %j', (thresholds, message) => {
    expect(() => assertThresholds(thresholds)).toThrow(message);
  });
});

describe('the claim of § 5 (7), on random blocks', () => {
  // A fixed-seed generator, so a failure reproduces.
  let state = 0x5eed;
  const next = (bound: number) => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state % bound;
  };

  it('never publishes a combination that isolates a group below the thresholds', () => {
    for (let round = 0; round < 400; round += 1) {
      const cells = ['P', 'Q', 'R', 'S', 'T'].slice(0, 2 + next(4));
      const thresholds = { minOrganizations: 3 + next(2), minRecords: 3 + next(3) };
      const facts = Array.from({ length: next(16) }, () =>
        fact(`O${next(7)}`, cells[next(cells.length)]!, BigInt(next(1000))),
      );
      const input = { cells, totalMeasures: next(2) === 0 ? ['count'] : [], facts, thresholds };
      const layout = layoutBlock(input);

      const found = exposure(publishedSets(input, layout), thresholds);
      if (found) throw new Error(`round ${round}: ${found}`);
    }
  });
});
