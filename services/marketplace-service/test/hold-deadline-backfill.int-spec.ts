import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withUtcSession } from '@rasta/config';
import { runUnscoped } from '@rasta/nest-common';
import { OrderStatus, PrismaClient } from '../src/generated/prisma';
import { BackfillRefused, backfillLegacyHoldDeadlines } from '../src/ops/hold-deadline-backfill';
import { eligibilityClockWrite } from '@rasta/testing';
import { HOLD_FENCE } from '../src/temporal/economic-refusal';
import { asActor, cleanup, id, key, newPrisma, publishOffer, tenants, wire } from './helpers';

/** FU-234: the legacy hold-deadline backfill, on orders placed and driven as the service does. */
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const SINCE = ago(2 * HOUR);
const ASSIGNABLE = ['PENDING', 'CANCELLING', 'CANCELLED', 'FAILED'] as const;
const OPERATOR = 'itest.operator@example.org';
const TICKET = 'ITEST-1335';
const MIGRATION = join(
  __dirname,
  '../prisma/migrations/20261107130000_order_hold_deadline_backfill',
);
/** A psql script's statements, its `:'name'` variables bound as literals (test values only). */
function statements(file: string, vars: Record<string, string> = {}): string[] {
  const sql = readFileSync(file, 'utf8').replace(/^--.*$/gm, '');
  const bound = sql.replace(/:'(\w+)'/g, (_all, name: string) => {
    const value = vars[name];
    if (value === undefined || !/^[\w.@-]*$/.test(value)) throw new Error(`no safe value: ${name}`);
    return `'${value}'`;
  });
  // A dollar-quoted body is one statement: split at a `;` ending a line, outside one.
  const parts = bound.split('$$');
  const out: string[] = [''];
  parts.forEach((part, i) => {
    const pieces = i % 2 === 1 ? [part] : part.split(/;\s*\n/);
    pieces.forEach((piece, j) => {
      if (j > 0) out.push('');
      out[out.length - 1] += (i > 0 && j === 0 ? '$$' : '') + piece;
    });
  });
  return out.map((statement) => statement.trim().replace(/;$/, '')).filter(Boolean);
}

describe('the legacy hold-deadline backfill (PostgreSQL)', () => {
  const prisma = newPrisma();
  const wiring = wire(prisma);
  const org = tenants();
  let owner: PrismaClient;
  const run = (over: Partial<Parameters<typeof backfillLegacyHoldDeadlines>[1]> = {}) =>
    backfillLegacyHoldDeadlines(prisma.client, {
      apply: true,
      economicRuleSince: SINCE,
      operator: OPERATOR,
      ticket: TICKET,
      batchSize: 200,
      maxBatches: 100,
      ...over,
    });

  beforeAll(() => {
    const url = process.env.DATABASE_URL_MARKETPLACE_MIGRATOR;
    if (!url) throw new Error('DATABASE_URL_MARKETPLACE_MIGRATOR is required by this suite');
    owner = new PrismaClient({ datasources: { db: { url: withUtcSession(url) } } });
  });
  afterAll(async () => {
    await owner.$disconnect();
    await cleanup(prisma, [org.buyer, org.supplier]);
    await prisma.onModuleDestroy();
  });

  async function place() {
    const { offerId } = await publishOffer(wiring, org.supplier);
    const placed = await asActor({ organizationId: org.buyer }, () =>
      wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('backfill')),
    );
    return { id: placed.id, organizationId: org.buyer };
  }
  /** As the fence migration left an order placed before it: one send counted, no deadline. */
  async function legacy(status: OrderStatus, held = false) {
    const order = await place();
    await owner.order.update({
      where: { id: order.id },
      data: {
        holdSendClaims: 1,
        status,
        economicTransactionId: held ? id('TXN') : null,
        // What each status's own constraints ask of a row that reached it.
        ...{ failureReason: 'x', cancelledAt: new Date(), cancellationReason: 'x' },
        ...{ cancellationCause: 'BUYER', completedAt: new Date(), economicSettlementId: id('STL') },
        ...{ receiptConfirmedAt: new Date(), receiptConfirmedBy: 'USR-ITEST' },
      },
    });
    return order;
  }
  const row = (order: { id: string }) =>
    owner.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { holdNotAfter: true, holdSendClaims: true, holdSendsClosedAt: true, status: true },
    });
  const audit = (order: { id: string }) =>
    owner.orderHoldDeadlineBackfill.findMany({ where: { orderId: order.id } });

  it('a dry run reports the plan and writes nothing', async () => {
    const order = await legacy('PENDING');
    const report = await run({ apply: false });
    expect(report).toMatchObject({ mode: 'dry-run', assigned: [] });
    expect(report.plan.assignable).toBeGreaterThanOrEqual(1);
    expect(await row(order)).toMatchObject({ holdNotAfter: null, holdSendClaims: 1 });
    expect(await audit(order)).toEqual([]);
  });

  it('gives a legacy row in every state the order can be in without a hold a deadline, recorded', async () => {
    const orders = await Promise.all(ASSIGNABLE.map((status) => legacy(status)));
    // A saga from before protocol 10 on this build: it counted its send and fixed nothing.
    const counted = await place();
    await wiring.orders.claimHoldSend(counted, undefined);
    const before = Date.now();
    const report = await run();
    for (const order of [...orders, counted]) {
      const given = (await row(order)).holdNotAfter?.getTime() ?? 0;
      expect(given).toBeGreaterThanOrEqual(before + HOLD_FENCE.sendWindowMs - 60_000);
      expect(given).toBeLessThanOrEqual(Date.now() + HOLD_FENCE.sendWindowMs + 60_000);
      const [record] = await audit(order);
      expect(record).toMatchObject({
        runId: report.runId,
        holdSendClaims: 1,
        operator: OPERATOR,
        ticket: TICKET,
        // Stamped by the database: the runtime role's login, and where it connected from.
        dbRole: expect.not.stringMatching(/migrator|owner/i),
        clientAddr: expect.stringMatching(/./),
      });
      expect(record?.holdNotAfter.getTime()).toBe(given);
      expect(record?.economicRuleSince.toISOString()).toBe(SINCE);
      expect(report.assigned).toContainEqual(expect.objectContaining({ orderId: order.id }));
    }
    expect(report.assigned.find((a) => a.orderId === orders[0]?.id)?.status).toBe('PENDING');
    // The saga's next send carries it, and the row proves nothing before it and the margin.
    const claim = await wiring.orders.claimHoldSend(orders[0]!, ago(-HOUR));
    expect(claim).toMatchObject({
      holdNotAfter: (await row(orders[0]!)).holdNotAfter?.toISOString(),
      claims: 2,
    });
    expect(
      await wiring.orders.closeHoldSendsIfNoneCanLand(orders[0]!, HOLD_FENCE.clockMarginMs),
    ).toBe(false);
  });

  it('leaves alone a row with a deadline, with no send, with its sends closed, or with its hold', async () => {
    const fenced = await place();
    const deadline = ago(-5 * HOUR);
    await wiring.orders.claimHoldSend(fenced, deadline);
    const unsent = await place();
    const closed = await legacy('PENDING');
    await owner.order.update({ where: { id: closed.id }, data: { holdSendsClosedAt: new Date() } });
    // Held, in every status there is: the hold landed and is on the order.
    const held = await Promise.all(
      Object.values(OrderStatus).map((status) => legacy(status, true)),
    );
    const all = [fenced, unsent, closed, ...held];
    const before = await Promise.all(all.map(row));
    const report = await run();
    expect(await Promise.all(all.map(row))).toEqual(before);
    expect(before[0]?.holdNotAfter?.toISOString()).toBe(deadline);
    for (const order of all) expect(await audit(order)).toEqual([]);
    // Nor refused: each of them is classified, not guessed at.
    const refused = new Set(report.refused.map((r) => r.orderId));
    expect(all.filter((order) => refused.has(order.id))).toEqual([]);
    expect(report.plan.held).toBeGreaterThanOrEqual(1);
  });

  it('refuses, reports and never writes a row whose state cannot follow from the order’s life', async () => {
    // A count below zero: no writer of this service makes one. Copied from a placed order.
    const source = await place();
    const odd = { id: id('ORD'), organizationId: org.buyer };
    await eligibilityClockWrite(owner)`
      INSERT INTO "order" (
        id, organization_id, supplier_organization_id, placed_by, total_amount_minor, currency,
        idempotency_key, correlation_id, created_by, created_at, updated_at,
        saga_start_next_attempt_at, hold_send_claims
      )
      SELECT ${odd.id}, organization_id, supplier_organization_id, placed_by, total_amount_minor,
        currency, ${key('odd')}, correlation_id, created_by, now(), now(),
        now() + interval '24 hours', -1
      FROM "order" WHERE id = ${source.id}`;
    const report = await run();
    expect(report.refused).toContainEqual({
      orderId: odd.id,
      organizationId: org.buyer,
      status: 'PENDING',
    });
    expect(await row(odd)).toMatchObject({ holdNotAfter: null, holdSendClaims: -1 });
    expect(await audit(odd)).toEqual([]);
    expect(report.plan.refused).toBeGreaterThanOrEqual(1);
    expect(report.converged).toBe(false);
    await owner.order.update({ where: { id: odd.id }, data: { holdSendsClosedAt: new Date() } });
  });

  it('a rerun is a no-op', async () => {
    const order = await legacy('CANCELLED');
    await run();
    const first = await row(order);
    const again = await run();
    expect(again.assigned).toEqual([]);
    expect(await row(order)).toEqual(first);
    expect(await audit(order)).toHaveLength(1);
  });

  it('works in bounded batches and says what is left', async () => {
    const orders = await Promise.all([1, 2, 3].map(() => legacy('PENDING')));
    const sliced = await run({ batchSize: 1, maxBatches: 2 });
    expect(sliced.assigned).toHaveLength(2);
    expect(sliced.remaining).toBeGreaterThanOrEqual(1);
    expect(sliced.converged).toBe(false);
    await run();
    for (const order of orders) expect((await row(order)).holdNotAfter).not.toBeNull();
  });

  it.each([
    ['too recent for the margin', ago(HOUR / 2)],
    ['in the future', ago(-HOUR)],
  ])(
    'refuses the whole run when economic-service’s rule is %s, dry run too',
    async (_name, since) => {
      const order = await legacy('PENDING');
      for (const apply of [false, true]) {
        await expect(run({ apply, economicRuleSince: since })).rejects.toBeInstanceOf(
          BackfillRefused,
        );
      }
      expect(await row(order)).toMatchObject({ holdNotAfter: null });
      await run();
    },
  );

  it('the record is append-only: no role changes, erases or truncates it, nor deletes its order', async () => {
    const order = await legacy('PENDING');
    await run();
    const [record] = await audit(order);
    const refusedAll = async (client: { $executeRawUnsafe: PrismaClient['$executeRawUnsafe'] }) => {
      for (const sql of [
        `UPDATE order_hold_deadline_backfill SET operator = 'someone.else' WHERE order_id = $1`,
        `UPDATE order_hold_deadline_backfill SET hold_not_after = hold_not_after + interval '1 hour'
           WHERE order_id = $1`,
        `DELETE FROM order_hold_deadline_backfill WHERE order_id = $1`,
      ]) {
        await expect(client.$executeRawUnsafe(sql, order.id)).rejects.toThrow(
          /ck_order_hold_deadline_audit_append_only/,
        );
      }
    };
    await runUnscoped('the suite tries to rewrite the audit as the runtime role', () =>
      refusedAll(prisma.client),
    );
    await refusedAll(owner);
    await expect(
      owner.$executeRawUnsafe('TRUNCATE order_hold_deadline_backfill CASCADE'),
    ).rejects.toThrow(/ck_order_hold_deadline_audit_append_only/);
    await expect(owner.order.delete({ where: { id: order.id } })).rejects.toThrow();
    expect(await audit(order)).toEqual([record]);
    // Restricted by the keys themselves, not only by the trigger a cascade would meet.
    expect(
      await owner.$queryRaw`SELECT conname, confdeltype FROM pg_constraint
        WHERE conname IN ('fk_order_hold_deadline_backfill_tenant',
          'fk_order_hold_deadline_revocation_assignment') ORDER BY conname`,
    ).toEqual([
      { conname: 'fk_order_hold_deadline_backfill_tenant', confdeltype: 'r' },
      { conname: 'fk_order_hold_deadline_revocation_assignment', confdeltype: 'r' },
    ]);
  });

  it('refuses a run that does not say who ran it, and the table refuses such a row', async () => {
    const order = await legacy('PENDING');
    for (const over of [{ operator: '' }, { ticket: ' ' }, { operator: 'a b' }]) {
      await expect(run(over)).rejects.toBeInstanceOf(BackfillRefused);
    }
    expect(await row(order)).toMatchObject({ holdNotAfter: null });
    expect(await audit(order)).toEqual([]);
    await run();
    const given = (await row(order)).holdNotAfter!;
    // Even a writer that skips the command: the CHECK is the boundary (before the key).
    const record = (deadline: Date, operator: string, ticket: string) =>
      owner.$executeRaw`INSERT INTO order_hold_deadline_backfill (organization_id, order_id,
        hold_not_after, run_id, status, hold_send_claims, economic_rule_since, operator, ticket)
        VALUES (${order.organizationId}, ${order.id}, ${deadline}, 'r', 'PENDING', 1,
          ${new Date(SINCE)}, ${operator}, ${ticket})`;
    for (const [operator, ticket] of [
      ['', TICKET],
      [OPERATOR, ''],
      [' x', TICKET],
    ]) {
      await expect(record(given, operator!, ticket!)).rejects.toThrow(
        /ck_order_hold_deadline_backfill_actor/,
      );
    }
    // Nor does any role record a deadline the order does not carry, or one taken back it does.
    await expect(record(new Date(given.getTime() + HOUR), OPERATOR, TICKET)).rejects.toThrow(
      /ck_order_hold_deadline_audit_matches_order/,
    );
    await expect(
      runUnscoped(
        'the suite tries to forge a revocation as the runtime role',
        () =>
          prisma.client.$executeRaw`INSERT INTO order_hold_deadline_revocation (organization_id,
          order_id, hold_not_after, revoked_by, ticket)
          VALUES (${order.organizationId}, ${order.id}, ${given}, ${OPERATOR}, ${TICKET})`,
      ),
    ).rejects.toThrow(/ck_order_hold_deadline_audit_matches_order/);
  });

  it('a rollback takes the deadline back and records it, deleting nothing', async () => {
    const [taken, held] = await Promise.all([legacy('PENDING'), legacy('CANCELLING')]);
    const report = await run();
    const given = (await row(taken)).holdNotAfter;
    // Since then this one held: what it proved stays proven.
    await owner.order.update({
      where: { id: held.id },
      data: { economicTransactionId: id('TXN') },
    });
    const revoke = statements(join(__dirname, '../prisma/ops/hold-deadline-revoke.sql'), {
      run_id: report.runId,
      operator: 'jane.doe@example.org',
      ticket: 'OPS-1335',
    });
    const once = () =>
      owner.$transaction(async (tx) => {
        for (const sql of revoke) await tx.$executeRawUnsafe(sql);
      });
    await once();
    await once();
    expect(await row(taken)).toMatchObject({ holdNotAfter: null, holdSendClaims: 1 });
    expect((await row(held)).holdNotAfter).not.toBeNull();
    expect(await audit(taken)).toEqual([expect.objectContaining({ holdNotAfter: given })]);
    expect(await audit(held)).toHaveLength(1);
    const revocations = (order: { id: string }) =>
      owner.orderHoldDeadlineRevocation.findMany({ where: { orderId: order.id } });
    expect(await revocations(taken)).toEqual([
      expect.objectContaining({
        holdNotAfter: given,
        revokedBy: 'jane.doe@example.org',
        ticket: 'OPS-1335',
        dbRole: expect.stringMatching(/./),
        clientAddr: expect.stringMatching(/./),
      }),
    ]);
    expect(await revocations(held)).toEqual([]);
    await expect(
      owner.$executeRaw`DELETE FROM order_hold_deadline_revocation WHERE order_id = ${taken.id}`,
    ).rejects.toThrow(/ck_order_hold_deadline_audit_append_only/);
    // The fence's trigger is on again, and a later run gives a new deadline, a new row.
    await expect(
      owner.order.update({ where: { id: held.id }, data: { holdNotAfter: null } }),
    ).rejects.toThrow();
    await run();
    expect(await audit(taken)).toHaveLength(2);
  });

  it('the migration’s down.sql refuses while the record has rows', async () => {
    await run();
    expect(await owner.orderHoldDeadlineBackfill.count()).toBeGreaterThan(0);
    const down = statements(join(MIGRATION, 'down.sql'));
    // In a transaction rolled back whatever happens: DDL is transactional.
    const reached: string[] = [];
    await expect(
      owner.$transaction(async (tx) => {
        for (const sql of down) {
          reached.push(sql);
          await tx.$executeRawUnsafe(sql);
        }
        throw new Error('down.sql ran to its end');
      }),
    ).rejects.toThrow(/ck_order_hold_deadline_audit_kept/);
    expect(reached.at(-1)).toMatch(/^DO \$\$/);
    expect(await owner.orderHoldDeadlineBackfill.count()).toBeGreaterThan(0);
  });

  /** Waits until `n` sessions of this database wait for a lock. */
  async function waiting(n: number) {
    for (let i = 0; i < 200; i += 1) {
      const [{ count }] = await owner.$queryRaw<{ count: bigint }[]>`
        SELECT count(DISTINCT l.pid) AS count FROM pg_locks l
        WHERE NOT l.granted AND l.pid IN (
          SELECT pid FROM pg_stat_activity WHERE datname = current_database())`;
      if (Number(count) >= n) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`fewer than ${n} sessions ever waited`);
  }
  /** Runs `first`, then `second`, both queued behind a lock on the order, in that order. */
  async function inOrder(
    order: { id: string },
    first: () => Promise<unknown>,
    second: () => Promise<unknown>,
  ) {
    let results: Promise<unknown[]> | undefined;
    await owner.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "order" WHERE id = ${order.id} FOR UPDATE`;
      const a = first();
      await waiting(1);
      const b = second();
      await waiting(2);
      results = Promise.all([a, b]);
    });
    return results!;
  }

  it.each(['claim first', 'backfill first'] as const)(
    'concurrent with a saga’s claimHoldSend on a used row (%s): one deadline, recorded as it is',
    async (which) => {
      const order = await legacy('PENDING');
      const proposed = ago(-2 * HOUR);
      const claim = () => wiring.orders.claimHoldSend(order, proposed);
      const backfill = () => run();
      const [claimed] =
        which === 'claim first'
          ? await inOrder(order, claim, backfill)
          : (await inOrder(order, backfill, claim)).reverse();
      const after = await row(order);
      const [record] = await audit(order);
      // A row with a send counted never takes the saga's proposal: only the backfill fences it.
      expect(after.holdNotAfter).not.toBeNull();
      expect(after.holdNotAfter?.toISOString()).not.toBe(proposed);
      expect(after.holdSendClaims).toBe(2);
      expect(record?.holdNotAfter).toEqual(after.holdNotAfter);
      // The record says what the row was when the deadline was given.
      expect(record?.holdSendClaims).toBe(which === 'claim first' ? 2 : 1);
      // The claim's send carries the deadline only if it came after it.
      expect(claimed).toEqual({
        holdNotAfter: which === 'claim first' ? null : after.holdNotAfter?.toISOString(),
        claims: 2,
      });
    },
  );
});
