import type { ActorIdentity } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { DeductionRuleRepository } from '../src/deduction/deduction-rule.repository';
import type { ExtendedPrismaClient } from '../src/prisma/prisma.service';
import {
  RULE_APPROVER,
  RULE_PROPOSER,
  cleanup,
  configureDeductionRule,
  newOrganizationId,
  wire,
  type Wiring,
} from './helpers';

/**
 * One lock order for everything that changes a rule in force (FU-060, migration
 * 20261104200000). Each test is two sessions in one fixed interleaving: the second is let go only
 * once the first holds what it holds, and the first goes on only once PostgreSQL itself reports the
 * second waiting on it. No sleep decides anything, and a deadlock (40P01) fails the test: it is
 * neither of the answers these tests expect.
 */
describe('one lock per rule: a proposal and a decision never wait on each other in a circle', () => {
  jest.setTimeout(60_000);
  let w: Wiring;
  const organizations: string[] = [];
  const rules = new DeductionRuleRepository();

  beforeAll(() => {
    w = wire();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await w.close();
  });

  const inForce = async () => {
    const org = newOrganizationId();
    organizations.push(org);
    const rule = await configureDeductionRule(w.prisma, org, `Rule ${ulid()}`, 500);
    return { org, rule };
  };

  /** Long enough that a transaction timeout can never pass for what is being tested. */
  const session = <T>(fn: (tx: ExtendedPrismaClient) => Promise<T>) =>
    w.prisma.transaction(fn, { timeoutMs: 30_000 });
  const backend = async (client: ExtendedPrismaClient) => {
    const [row] = await client.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
    return row!.pid;
  };

  /**
   * Starts `second` in its own session and returns when PostgreSQL reports it waiting on `holder`.
   * If it finishes instead, nothing waited: the interleaving this test is about never happened.
   */
  const startBlockedOn = async <T>(
    holder: number,
    second: (tx: ExtendedPrismaClient) => Promise<T>,
  ): Promise<{ outcome: Promise<PromiseSettledResult<T>[]> }> => {
    let pid: number | undefined;
    const outcome = Promise.allSettled([
      session(async (tx) => {
        pid = await backend(tx);
        return second(tx);
      }),
    ]);
    let finished = false;
    void outcome.then(() => {
      finished = true;
    });
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (finished) throw new Error('the second session never waited on the first');
      if (Date.now() > deadline) throw new Error('the second session never reached the first');
      if (pid !== undefined) {
        const [row] = await w.prisma.client.$queryRawUnsafe<{ waiting: boolean }[]>(
          'SELECT $1::int = ANY (pg_blocking_pids($2::int)) AS waiting',
          holder,
          pid,
        );
        if (row!.waiting) return { outcome };
      }
      await new Promise(setImmediate);
    }
  };

  const propose = (tx: ExtendedPrismaClient, org: string, ruleId: string) =>
    rules.proposeRetire(tx, {
      organizationId: org,
      deductionRuleId: ruleId,
      reason: 'no longer owed',
      proposer: RULE_PROPOSER,
      at: new Date(),
    });
  const act = (
    change: { organizationId: string; id: string; version: number },
    actor: ActorIdentity,
  ) => ({
    organizationId: change.organizationId,
    changeId: change.id,
    expectedVersion: change.version,
    actor,
    at: new Date(),
  });
  const code = (result: PromiseSettledResult<unknown>) =>
    result.status === 'fulfilled'
      ? 'PASSED'
      : ((result.reason as { code?: string; message?: string }).code ?? String(result.reason));
  const stateOf = async (org: string, ruleId: string) => {
    const [row] = await w.prisma.client.$queryRawUnsafe<{ retired: boolean; pending: number }[]>(
      `SELECT r.retired_at IS NOT NULL AS retired,
              (SELECT count(*)::int FROM deduction_rule_change c
                WHERE c.organization_id = r.organization_id AND c.deduction_rule_id = r.id
                  AND c.status = 'PENDING_APPROVAL') AS pending
         FROM deduction_rule r WHERE r.organization_id = $1 AND r.id = $2`,
      org,
      ruleId,
    );
    return row;
  };

  it('a proposal and its approval in one transaction, against another proposal: the first finishes, the other is told the rule left force', async () => {
    const { org, rule } = await inForce();
    let other: { outcome: Promise<PromiseSettledResult<unknown>[]> } | undefined;
    await session(async (tx) => {
      const change = await propose(tx, org, rule.id);
      other = await startBlockedOn(await backend(tx), (b) => propose(b, org, rule.id));
      return rules.approve(tx, act(change, RULE_APPROVER));
    });
    expect((await other!.outcome).map(code)).toEqual(['NOT_FOUND']);
    expect(await stateOf(org, rule.id)).toEqual({ retired: true, pending: 0 });
  });

  // A move that holds no lock lets a proposal take the rule and then wait on the pending index for
  // this transaction, which needs the rule next: the same circle, from a move that is not an approval.
  it.each([
    ['withdrawn', RULE_PROPOSER, 'withdraw'],
    ['rejected', RULE_APPROVER, 'reject'],
  ] as const)(
    'a pending RETIRE %s, proposed again and approved in one transaction, against another proposal',
    async (_how, actor, move) => {
      const { org, rule } = await inForce();
      const pending = await session((tx) => propose(tx, org, rule.id));
      let other: { outcome: Promise<PromiseSettledResult<unknown>[]> } | undefined;
      await session(async (tx) => {
        if (move === 'withdraw') await rules.withdraw(tx, act(pending, actor));
        else await rules.reject(tx, { ...act(pending, actor), reason: 'not yet' });
        other = await startBlockedOn(await backend(tx), (b) => propose(b, org, rule.id));
        const again = await propose(tx, org, rule.id);
        return rules.approve(tx, act(again, RULE_APPROVER));
      });
      expect((await other!.outcome).map(code)).toEqual(['NOT_FOUND']);
      expect(await stateOf(org, rule.id)).toEqual({ retired: true, pending: 0 });
    },
  );

  it('a proposal ended without an approval: the one that waited then meets the pending index, or stands alone', async () => {
    const { org, rule } = await inForce();
    let other: { outcome: Promise<PromiseSettledResult<unknown>[]> } | undefined;
    await session(async (tx) => {
      await propose(tx, org, rule.id);
      other = await startBlockedOn(await backend(tx), (b) => propose(b, org, rule.id));
    });
    expect((await other!.outcome).map(code)).toEqual(['ALREADY_EXISTS']);

    // Rolled back: nothing is left in the way of the session that waited.
    const second = await inForce();
    let waited: { outcome: Promise<PromiseSettledResult<unknown>[]> } | undefined;
    await expect(
      session(async (tx) => {
        await propose(tx, second.org, second.rule.id);
        waited = await startBlockedOn(await backend(tx), (b) =>
          propose(b, second.org, second.rule.id),
        );
        throw new Error('changed my mind');
      }),
    ).rejects.toThrow('changed my mind');
    expect((await waited!.outcome).map(code)).toEqual(['PASSED']);
    expect(await stateOf(second.org, second.rule.id)).toEqual({ retired: false, pending: 1 });
  });

  it.each([
    ['one name', (id: string) => [`Rule ${id}`, `Rule ${id}`]],
    ['one key, by case and a space (FU-083)', (id: string) => [`Rule ${id}`, `rule${id}`]],
  ])(
    'a CREATE has no rule to lock: two of %s wait on the pending index, one way only',
    async (_how, names) => {
      const org = newOrganizationId();
      organizations.push(org);
      const [name, sameKey] = names(ulid());
      const proposeCreate = (tx: ExtendedPrismaClient, typed: string) =>
        rules.proposeCreate(tx, {
          organizationId: org,
          name: typed,
          rateBp: 500,
          base: 'GROSS',
          proposer: RULE_PROPOSER,
          at: new Date(),
        });
      let other: { outcome: Promise<PromiseSettledResult<unknown>[]> } | undefined;
      await session(async (tx) => {
        const change = await proposeCreate(tx, name!);
        other = await startBlockedOn(await backend(tx), async (b) => {
          const second = await proposeCreate(b, sameKey!);
          return rules.approve(b, act(second, RULE_APPROVER));
        });
        return rules.approve(tx, act(change, RULE_APPROVER));
      });
      expect((await other!.outcome).map(code)).toEqual(['ALREADY_EXISTS']);
    },
  );

  // A move has locked its change and waits for the rule, and the holder of the rule then meets the
  // pending index on that same change. A pending change is a unique violation at once, not a wait:
  // no circle, and the move finishes. A proposal's trigger takes the rule inside its INSERT, before
  // that INSERT meets the index, so the SELECT stands for that moment.
  type Pending = Awaited<ReturnType<typeof propose>>;
  const moves: [string, (tx: ExtendedPrismaClient, c: Pending) => Promise<unknown>, boolean][] = [
    ['withdrawal', (tx, c) => rules.withdraw(tx, act(c, RULE_PROPOSER)), false],
    [
      'rejection',
      (tx, c) => rules.reject(tx, { ...act(c, RULE_APPROVER), reason: 'not yet' }),
      false,
    ],
    ['approval', (tx, c) => rules.approve(tx, act(c, RULE_APPROVER)), true],
  ];
  it.each(moves)(
    'a holder of the rule meets the pending index while a %s waits for that rule: a conflict, not a circle, and the move finishes',
    async (_how, move, retired) => {
      const { org, rule } = await inForce();
      const pending = await session((tx) => propose(tx, org, rule.id));
      let moved: { outcome: Promise<PromiseSettledResult<unknown>[]> } | undefined;
      await expect(
        session(async (tx) => {
          await tx.$queryRawUnsafe(
            'SELECT 1 FROM deduction_rule WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE',
            org,
            rule.id,
          );
          moved = await startBlockedOn(await backend(tx), (b) => move(b, pending));
          return propose(tx, org, rule.id);
        }),
      ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
      expect((await moved!.outcome).map(code)).toEqual(['PASSED']);
      expect(await stateOf(org, rule.id)).toEqual({ retired, pending: 0 });
    },
  );

  it('the lock is not a key lock: a statement naming the rule is not held up by a proposal or a move', async () => {
    const { org, rule } = await inForce();
    const statementNames = () =>
      w.prisma.client.$queryRawUnsafe<unknown[]>(
        'SELECT 1 FROM deduction_rule WHERE organization_id = $1 AND id = $2 FOR KEY SHARE NOWAIT',
        org,
        rule.id,
      );
    const pending = await session(async (tx) => {
      const change = await propose(tx, org, rule.id);
      expect(await statementNames()).toHaveLength(1);
      return change;
    });
    await session(async (tx) => {
      await rules.withdraw(tx, act(pending, RULE_PROPOSER));
      expect(await statementNames()).toHaveLength(1);
    });
  });
});
