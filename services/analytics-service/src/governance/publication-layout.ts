/**
 * The publication layout of one governance block (ADR-071 § 5 (6), revision 2), as a pure
 * function — ahead of RUN-001 PR 7, which cuts releases and stores what this decides. Nothing
 * calls it yet, and no route serves a governance number in this PR; it is here so the layout
 * the ADR prescribes, and the claim of § 5 (7) that no combination of published numbers
 * isolates a group below the thresholds, are executable and tested now
 * (`publication-layout.spec.ts`).
 *
 * A **block** is the facts of one release, one hierarchy root and one group (`PERIOD` or
 * `LATE`). Blocks share no fact, and governance views are served only at roots, which share no
 * organization (PM ruling after #335 review round 2). Within a block:
 *
 *   - one fixed partition: the cells come from the indicator's definition, not from the data;
 *   - only two levels are published: each cell, and the block total — never an intermediate
 *     marginal, which would be a second partition of the same facts;
 *   - a cell below either threshold is suppressed with every one of its measures;
 *   - complementary, in one dimension: when the total is published, the suppressed cells
 *     together are empty or meet both thresholds, else the smallest published cell is
 *     suppressed too, until they do.
 *
 * Thresholds are configuration with no default (Q-141 (2)); none configured suppresses every
 * number. A minimum of organizations below three is refused: with two, each contributor learns
 * the other's figure by subtracting its own.
 */

export interface Thresholds {
  readonly minOrganizations: number;
  readonly minRecords: number;
}

/** One fact of the block, already in exactly one cell of the partition. */
export interface BlockFact {
  readonly organizationId: string;
  readonly cell: string;
  readonly measures: Readonly<Record<string, bigint>>;
}

export interface BlockInput {
  /** The partition's cells, in the indicator definition's order. */
  readonly cells: readonly string[];
  /** Measures that may be summed across every cell (a count may; two currencies may not). */
  readonly totalMeasures: readonly string[];
  readonly facts: readonly BlockFact[];
  readonly thresholds: Thresholds | undefined;
}

export type Published =
  | { readonly status: 'AVAILABLE'; readonly measures: Readonly<Record<string, bigint>> }
  | { readonly status: 'SUPPRESSED' };

export interface BlockLayout {
  readonly cells: readonly ({ readonly cell: string } & Published)[];
  /** `null` when the indicator has no measure summable across cells. */
  readonly total: Published | null;
}

export const MIN_ORGANIZATIONS_FLOOR = 3;

export function assertThresholds(thresholds: Thresholds): void {
  if (
    !Number.isSafeInteger(thresholds.minOrganizations) ||
    !Number.isSafeInteger(thresholds.minRecords)
  ) {
    throw new Error('Governance thresholds are whole numbers');
  }
  if (thresholds.minOrganizations < MIN_ORGANIZATIONS_FLOOR) {
    throw new Error(
      `A governance minimum of organizations below ${MIN_ORGANIZATIONS_FLOOR} lets one contributor ` +
        'learn another’s figure by subtracting its own',
    );
  }
  if (thresholds.minRecords < 1) {
    throw new Error('A governance minimum of records is at least 1');
  }
}

export function layoutBlock(input: BlockInput): BlockLayout {
  const known = new Set(input.cells);
  const stray = input.facts.find((fact) => !known.has(fact.cell));
  if (stray) {
    // The partition is the definition's; a fact outside it would be a cell nobody declared.
    throw new Error(`A fact falls in no declared cell (${stray.cell})`);
  }

  const factsIn = new Map(
    input.cells.map((cell) => [cell, input.facts.filter((f) => f.cell === cell)]),
  );
  const thresholds = input.thresholds;
  if (thresholds) assertThresholds(thresholds);
  const meets = (facts: readonly BlockFact[]) =>
    thresholds !== undefined &&
    facts.length >= thresholds.minRecords &&
    new Set(facts.map((f) => f.organizationId)).size >= thresholds.minOrganizations;

  const published = new Set(input.cells.filter((cell) => meets(factsIn.get(cell) ?? [])));
  const totalPublished = input.totalMeasures.length > 0 && meets(input.facts);

  if (totalPublished) {
    for (;;) {
      const residual = input.facts.filter((fact) => !published.has(fact.cell));
      if (residual.length === 0 || meets(residual)) break;
      // Every published cell meets the thresholds, so the residual grows until it does too;
      // with every cell suppressed it is the whole block, which does.
      const smallest = [...published].sort((x, y) => compareSize(factsIn, x, y))[0];
      if (smallest === undefined) break;
      published.delete(smallest);
    }
  }

  return {
    cells: input.cells.map((cell) =>
      published.has(cell)
        ? { cell, status: 'AVAILABLE', measures: sum(factsIn.get(cell) ?? [], measureNames(input)) }
        : { cell, status: 'SUPPRESSED' },
    ),
    total:
      input.totalMeasures.length === 0
        ? null
        : totalPublished
          ? { status: 'AVAILABLE', measures: sum(input.facts, input.totalMeasures) }
          : { status: 'SUPPRESSED' },
  };
}

function compareSize(factsIn: Map<string, readonly BlockFact[]>, x: string, y: string): number {
  const fx = factsIn.get(x) ?? [];
  const fy = factsIn.get(y) ?? [];
  return (
    fx.length - fy.length ||
    new Set(fx.map((f) => f.organizationId)).size - new Set(fy.map((f) => f.organizationId)).size ||
    (x < y ? -1 : x > y ? 1 : 0)
  );
}

function measureNames(input: BlockInput): string[] {
  return [...new Set(input.facts.flatMap((fact) => Object.keys(fact.measures)))].sort();
}

function sum(facts: readonly BlockFact[], names: readonly string[]): Record<string, bigint> {
  return Object.fromEntries(
    names.map((name) => [
      name,
      facts.reduce((total, fact) => total + (fact.measures[name] ?? 0n), 0n),
    ]),
  );
}
