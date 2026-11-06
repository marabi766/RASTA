import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { DeductionRuleRepository } from '../src/deduction/deduction-rule.repository';
import type { ExtendedPrismaClient } from '../src/prisma/prisma.service';
import { computeStatementAmounts } from '../src/statement/amounts';
import { StatementRepository } from '../src/statement/statement.repository';
import {
  RULE_APPROVER,
  RULE_PROPOSER,
  cleanup,
  configureDeductionRule,
  newOrganizationId,
  wire,
  type Wiring,
} from './helpers';

describe('FU-089: statements and RETIRE share a rule serialization point', () => {
  let w: Wiring;
  let statements: StatementRepository;
  const organizations: string[] = [];
  const rules = new DeductionRuleRepository();
  beforeAll(() => {
    w = wire();
    statements = new StatementRepository(w.prisma);
  });
  afterAll(async () => {
    await cleanup(organizations);
    await w.close();
  });
  const session = <T>(fn: (tx: ExtendedPrismaClient) => Promise<T>) =>
    w.prisma.transaction(fn, { timeoutMs: 30_000 });
  const backend = async (tx: ExtendedPrismaClient) =>
    (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
  const retire = async (tx: ExtendedPrismaClient, org: string, id: string) => {
    const pending = await rules.proposeRetire(tx, {
      organizationId: org,
      deductionRuleId: id,
      reason: 'retired by test',
      proposer: RULE_PROPOSER,
      at: new Date(),
    });
    return rules.approve(tx, {
      organizationId: org,
      changeId: pending.id,
      expectedVersion: pending.version,
      actor: RULE_APPROVER,
      at: new Date(),
    });
  };
  // A real second connection, released only once PostgreSQL proves it waits on this holder.
  const blocked = async <T>(holder: number, fn: (tx: ExtendedPrismaClient) => Promise<T>) => {
    let pid: number | undefined;
    let finished = false;
    const outcome = Promise.allSettled([
      session(async (tx) => {
        pid = await backend(tx);
        return fn(tx);
      }),
    ]);
    void outcome.then(() => {
      finished = true;
    });
    const deadline = Date.now() + 15_000;
    while (!finished && Date.now() < deadline) {
      if (pid !== undefined) {
        const [row] = await w.prisma.client.$queryRaw<{ waiting: boolean }[]>`
          SELECT ${holder}::int = ANY(pg_blocking_pids(${pid}::int)) AS waiting`;
        if (row!.waiting) return { outcome, waited: true };
      }
      await new Promise(setImmediate);
    }
    if (!finished) throw new Error('second transaction never reached the rule holder');
    return { outcome, waited: false };
  };
  const fixture = async () => {
    const org = newOrganizationId();
    organizations.push(org);
    const id = `CTR_${ulid()}`;
    await w.prisma.client.$executeRaw`
      INSERT INTO contract
        (id, organization_id, tender_id, project_id, winning_bid_id, contractor_organization_id,
         amount_minor, matrix_digest, awarded_by, awarded_at, status, status_changed_at,
         status_changed_by, source_event_id, created_at, created_by, created_correlation_id, updated_at)
      VALUES (${id}, ${org}, ${`TND_${ulid()}`}, 'PRJ_test', 'BID_test', 'ORG_contractor',
              1000, repeat('a', 64), 'USR_test', now(), 'SIGNED', now(), 'system', 'EVT_test', now(),
              'system', 'COR_test', now())`;
    const rule = await configureDeductionRule(w.prisma, org, 'Retention', 500);
    return { org, id, rule };
  };
  const insert = (tx: ExtendedPrismaClient, f: Awaited<ReturnType<typeof fixture>>) => {
    const amounts = computeStatementAmounts([1000n], [f.rule]);
    if (typeof amounts === 'string') throw new Error(amounts);
    return statements.insert(tx, {
      id: `STM_${ulid()}`,
      organizationId: f.org,
      contractId: f.id,
      statementNumber: 1,
      lines: [{ id: `STL_${ulid()}`, description: 'work', amountMinor: 1000n, milestoneId: null }],
      amounts,
      deductionIds: [`STD_${ulid()}`],
      actor: 'USR_test',
      correlationId: 'COR_test',
      at: new Date(),
    });
  };

  it.each(['read', 'insert'] as const)(
    'draft first: RETIRE waits after the %s until the statement commits',
    async (stage) => {
      const f = await fixture();
      let waiter:
        { outcome: Promise<PromiseSettledResult<unknown>[]>; waited: boolean } | undefined;
      const statement = await session(async (tx) => {
        await w.contracts.lockContract(tx, f.org, f.id);
        if (stage === 'read')
          expect(await statements.rulesInForce(tx, f.org, [f.rule.id])).toHaveLength(1);
        const row = stage === 'insert' ? await insert(tx, f) : undefined;
        // Wrap the promise so returning from blocked does not await the blocked transaction.
        waiter = await blocked(await backend(tx), (other) => retire(other, f.org, f.rule.id));
        return row ?? insert(tx, f);
      });
      expect((await waiter!.outcome)[0]!.status).toBe('fulfilled');
      expect(statement.deductions[0]!.amountMinor).toBe(50n);
      const stored = await runUnscoped('test reads its own committed snapshot', () =>
        w.prisma.client.statement.findFirst({ where: { organizationId: f.org, id: statement.id } }),
      );
      expect(stored!.netMinor).toBe(950n);
      // On 7e8f8f49 the insert-first case commits this deduction AFTER RETIRE committed.
      expect(waiter!.waited).toBe(true);
    },
  );

  it.each(['read', 'insert'] as const)(
    'RETIRE first: a waiting %s cannot carry the retired rule',
    async (stage) => {
      const f = await fixture();
      let waiter:
        { outcome: Promise<PromiseSettledResult<unknown>[]>; waited: boolean } | undefined;
      await session(async (tx) => {
        await retire(tx, f.org, f.rule.id);
        waiter = await blocked<unknown>(await backend(tx), (other) =>
          stage === 'read' ? statements.rulesInForce(other, f.org, [f.rule.id]) : insert(other, f),
        );
      });
      const [result] = await waiter!.outcome;
      if (stage === 'read') expect(result).toEqual({ status: 'fulfilled', value: [] });
      else {
        expect(result!.status).toBe('rejected');
        if (result!.status === 'rejected')
          expect(String(result.reason)).toMatch(/ck_statement_deduction_configured/);
      }
      await expect(session((tx) => insert(tx, f))).rejects.toThrow(
        /ck_statement_deduction_configured/,
      );
      expect(
        await w.prisma.client.$queryRaw`SELECT id FROM statement WHERE organization_id = ${f.org}`,
      ).toEqual([]);
    },
  );
});
