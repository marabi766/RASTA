import {
  judgeStep,
  openChain,
  separationOf,
  statusOfDecisions,
  withinApprovedCap,
  type RecordedDecision,
  type SnapshotStep,
} from './decisions';
import { STATEMENT_STATES } from './statement.state-machine';

const step = (chain: 'TECHNICAL' | 'FINANCIAL', stepOrder: number): SnapshotStep => ({
  chain,
  stepOrder,
  authorityOrganizationId: `ORG_${chain}_${stepOrder}`,
  authorityRole: 'ORGANIZATION_ADMIN',
});
/** Two technical steps (orders 1 and 3: a policy's own orders, gaps allowed) and one financial. */
const STEPS = [step('TECHNICAL', 3), step('FINANCIAL', 1), step('TECHNICAL', 1)];
const approved = (chain: 'TECHNICAL' | 'FINANCIAL', stepOrder: number): RecordedDecision => ({
  chain,
  stepOrder,
  outcome: 'APPROVED',
});

describe('openChain: technical, then financial (Q-96 (2))', () => {
  it('opens the technical chain on SUBMITTED, the financial on TECHNICALLY_APPROVED, nothing else', () => {
    expect(STATEMENT_STATES.map((status) => [status, openChain(status)])).toEqual([
      ['DRAFT', null],
      ['SUBMITTED', 'TECHNICAL'],
      ['TECHNICALLY_APPROVED', 'FINANCIAL'],
      ['APPROVED', null],
      ['REJECTED', null],
    ]);
  });
});

describe('judgeStep', () => {
  it('takes the open chain’s steps in their order: the first approval completes nothing, the last completes the chain', () => {
    const first = judgeStep(
      'SUBMITTED',
      STEPS,
      [],
      { chain: 'TECHNICAL', stepOrder: 1 },
      'APPROVED',
    );
    expect(first).toEqual({ ok: true, step: step('TECHNICAL', 1), to: 'SUBMITTED', command: null });
    const last = judgeStep(
      'SUBMITTED',
      STEPS,
      [approved('TECHNICAL', 1)],
      { chain: 'TECHNICAL', stepOrder: 3 },
      'APPROVED',
    );
    expect(last).toEqual({
      ok: true,
      step: step('TECHNICAL', 3),
      to: 'TECHNICALLY_APPROVED',
      command: 'approve_technical',
    });
    const financial = judgeStep(
      'TECHNICALLY_APPROVED',
      STEPS,
      [approved('TECHNICAL', 1), approved('TECHNICAL', 3)],
      { chain: 'FINANCIAL', stepOrder: 1 },
      'APPROVED',
    );
    expect(financial).toMatchObject({ ok: true, to: 'APPROVED', command: 'approve_financial' });
  });

  it('rejects the statement from any step of either open chain, the first included (Q-96 (7))', () => {
    expect(
      judgeStep('SUBMITTED', STEPS, [], { chain: 'TECHNICAL', stepOrder: 1 }, 'REJECTED'),
    ).toMatchObject({ ok: true, to: 'REJECTED', command: 'reject' });
    expect(
      judgeStep(
        'TECHNICALLY_APPROVED',
        STEPS,
        [approved('TECHNICAL', 1), approved('TECHNICAL', 3)],
        { chain: 'FINANCIAL', stepOrder: 1 },
        'REJECTED',
      ),
    ).toMatchObject({ ok: true, to: 'REJECTED', command: 'reject' });
  });

  it.each([
    ['a draft', 'DRAFT', [], 'TECHNICAL', 1, 'STATEMENT_NOT_SUBMITTED'],
    ['an approved statement', 'APPROVED', [], 'FINANCIAL', 1, 'STATEMENT_DECIDED'],
    ['a rejected statement', 'REJECTED', [], 'TECHNICAL', 1, 'STATEMENT_DECIDED'],
    [
      'a step the rejection did not decide, on a rejected statement',
      'REJECTED',
      [{ chain: 'TECHNICAL', stepOrder: 1, outcome: 'REJECTED' }],
      'FINANCIAL',
      1,
      'STATEMENT_DECIDED',
    ],
    [
      'a step its chains do not have, on an approved statement',
      'APPROVED',
      [approved('TECHNICAL', 1), approved('TECHNICAL', 3), approved('FINANCIAL', 1)],
      'FINANCIAL',
      2,
      'STATEMENT_DECIDED',
    ],
    [
      'the final financial step once its approval made the statement APPROVED',
      'APPROVED',
      [approved('TECHNICAL', 1), approved('TECHNICAL', 3), approved('FINANCIAL', 1)],
      'FINANCIAL',
      1,
      'STEP_DECIDED',
    ],
    [
      'the step whose rejection made the statement REJECTED',
      'REJECTED',
      [
        approved('TECHNICAL', 1),
        approved('TECHNICAL', 3),
        { chain: 'FINANCIAL', stepOrder: 1, outcome: 'REJECTED' },
      ],
      'FINANCIAL',
      1,
      'STEP_DECIDED',
    ],
    [
      'an approved earlier step, on a statement rejected later',
      'REJECTED',
      [approved('TECHNICAL', 1), { chain: 'TECHNICAL', stepOrder: 3, outcome: 'REJECTED' }],
      'TECHNICAL',
      1,
      'STEP_DECIDED',
    ],
    ['a step the snapshot does not have', 'SUBMITTED', [], 'TECHNICAL', 2, 'STEP_NOT_IN_CHAIN'],
    ['a decided step', 'SUBMITTED', [approved('TECHNICAL', 1)], 'TECHNICAL', 1, 'STEP_DECIDED'],
    [
      'a technical step once the chain is done',
      'TECHNICALLY_APPROVED',
      [approved('TECHNICAL', 1), approved('TECHNICAL', 3)],
      'TECHNICAL',
      3,
      'STEP_DECIDED',
    ],
    [
      'the financial chain before the technical one',
      'SUBMITTED',
      [],
      'FINANCIAL',
      1,
      'CHAIN_NOT_OPEN',
    ],
    ['a later step before an earlier one', 'SUBMITTED', [], 'TECHNICAL', 3, 'STEP_NOT_NEXT'],
  ] as const)('refuses %s', (_what, status, decisions, chain, stepOrder, reason) => {
    for (const outcome of ['APPROVED', 'REJECTED'] as const) {
      expect(judgeStep(status, STEPS, decisions, { chain, stepOrder }, outcome)).toEqual({
        ok: false,
        reason,
      });
    }
  });
});

describe('withinApprovedCap: the cap judged in bigint, at the largest bigint too (ADR-068 § 5)', () => {
  const MAX = 9223372036854775807n; // 2^63 - 1
  const contract = (
    amountMinor: bigint,
    approvedTotalMinor: bigint,
    amendmentsTotalMinor = 0n,
  ) => ({
    amountMinor,
    amendmentsTotalMinor,
    approvedTotalMinor,
  });
  it.each([
    ['up to the price exactly', contract(1000n, 600n), 400n, true],
    ['one past the price', contract(1000n, 600n), 401n, false],
    ['up to the price plus the amendments', contract(1000n, 600n, 500n), 900n, true],
    ['one past the price plus the amendments', contract(1000n, 600n, 500n), 901n, false],
    [
      'a sum past 2^63 - 1 under a cap of 2^63 - 1',
      contract(MAX, 6000000000000000000n),
      4000000000000000000n,
      false,
    ],
    [
      'the cap of 2^63 - 1 reached exactly',
      contract(MAX, 6000000000000000000n),
      MAX - 6000000000000000000n,
      true,
    ],
    [
      'one past a cap of 2^63 - 1',
      contract(MAX, 6000000000000000000n),
      MAX - 5999999999999999999n,
      false,
    ],
    ['one more at a total of 2^63 - 1', contract(MAX, MAX), 1n, false],
    ['the largest gross on an empty total under a cap of 2^63 - 1', contract(MAX, 0n), MAX, true],
    [
      'a cap of 2^63 - 1 split between price and amendments',
      contract(MAX - 5n, MAX - 1n, 5n),
      1n,
      true,
    ],
    [
      'one past a cap split between price and amendments',
      contract(MAX - 5n, MAX - 1n, 5n),
      2n,
      false,
    ],
  ] as const)('%s', (_what, given, gross, within) => {
    expect(withinApprovedCap(given, gross)).toBe(within);
  });
});

describe('statusOfDecisions: the rule the database holds at commit', () => {
  const counts = { TECHNICAL: 2, FINANCIAL: 1 };
  it.each([
    [[], 'SUBMITTED'],
    [[approved('TECHNICAL', 1)], 'SUBMITTED'],
    [[approved('TECHNICAL', 1), approved('TECHNICAL', 3)], 'TECHNICALLY_APPROVED'],
    [[approved('TECHNICAL', 1), approved('TECHNICAL', 3), approved('FINANCIAL', 1)], 'APPROVED'],
    [[{ chain: 'TECHNICAL', stepOrder: 1, outcome: 'REJECTED' }], 'REJECTED'],
    [
      [
        approved('TECHNICAL', 1),
        approved('TECHNICAL', 3),
        { chain: 'FINANCIAL', stepOrder: 1, outcome: 'REJECTED' },
      ],
      'REJECTED',
    ],
  ] as const)('%j → %s', (decisions, status) => {
    expect(statusOfDecisions(counts, decisions)).toBe(status);
  });

  it('agrees with judgeStep along a whole approval', () => {
    const decisions: RecordedDecision[] = [];
    let status = statusOfDecisions(counts, decisions);
    for (const [chain, stepOrder] of [
      ['TECHNICAL', 1],
      ['TECHNICAL', 3],
      ['FINANCIAL', 1],
    ] as const) {
      const judged = judgeStep(status, STEPS, decisions, { chain, stepOrder }, 'APPROVED');
      if (!judged.ok) throw new Error(judged.reason);
      decisions.push(approved(chain, stepOrder));
      status = statusOfDecisions(counts, decisions);
      expect(status).toBe(judged.to);
    }
    expect(status).toBe('APPROVED');
  });
});

describe('separationOf (Q-96 (3), #188)', () => {
  const ISS = 'https://idp.example/realms/rasta';
  const who = (userId: string, subject: string, issuer: string | null = ISS) => ({
    userId,
    issuer,
    subject: issuer === null ? null : subject,
  });
  const submitter = who('USR_S', 'sub-s');
  const earlier = [who('USR_A', 'sub-a')];

  it('is DISTINCT only for a person provably neither the submitter nor an earlier decider', () => {
    expect(separationOf(who('USR_B', 'sub-b'), submitter, earlier)).toBe('DISTINCT');
    expect(separationOf(who('USR_B', 'sub-b'), submitter, [])).toBe('DISTINCT');
  });

  it('names the submitter, by user id, by identity, or by a user id that is the other’s subject', () => {
    expect(separationOf(who('USR_S', 'sub-other'), submitter, earlier)).toBe('SUBMITTER');
    expect(separationOf(who('USR_S2', 'sub-s'), submitter, earlier)).toBe('SUBMITTER');
    expect(separationOf(who('sub-s', 'sub-x'), submitter, earlier)).toBe('SUBMITTER');
  });

  it('names an earlier decider of either chain the same way', () => {
    expect(separationOf(who('USR_A2', 'sub-a'), submitter, earlier)).toBe('ALREADY_DECIDED');
    expect(separationOf(who('USR_A', 'sub-a-new'), submitter, earlier)).toBe('ALREADY_DECIDED');
  });

  it('fails closed: another issuer, or a recorded actor without an identity, is UNKNOWN', () => {
    expect(separationOf(who('USR_B', 'sub-b', 'https://other/realms/x'), submitter, earlier)).toBe(
      'UNKNOWN',
    );
    expect(separationOf(who('USR_B', 'sub-b'), who('USR_S', 'x', null), earlier)).toBe('UNKNOWN');
    expect(separationOf(who('USR_B', 'sub-b'), submitter, [who('USR_A', 'x', null)])).toBe(
      'UNKNOWN',
    );
  });

  it('prefers a proven match to an unknown one: the more precise refusal', () => {
    expect(
      separationOf(who('USR_A', 'sub-a'), submitter, [
        who('USR_Z', 'x', null),
        who('USR_A', 'sub-a'),
      ]),
    ).toBe('ALREADY_DECIDED');
  });
});
