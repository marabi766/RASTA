import { ulid } from 'ulid';
import { runUnscoped, runWithContext, type RequestContext } from '@rasta/nest-common';
import { LedgerBalanceAudit } from '../src/wallet/balance-audit';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { cleanup, fundWallet, newPrisma, tenants, testEnv, wire, type Wiring } from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * What the platform records when the actor is not a person.
 *
 * Every state change has to name who made it (AGENTS.md S-06), and a
 * consumer, a workflow activity or a timer has no `userId` to name. Each of
 * those paths falls back to the **service** rather than leaving the column
 * empty, and an empty actor on a financial record is the difference between an
 * audit trail and a list of amounts.
 *
 * Driven through the domain services with a service-typed context rather than
 * over HTTP, because that is the shape the consumers actually construct
 * (`createSystemContext`) — and because the HTTP route for a service caller
 * cannot resolve a tenant today (docs/24 Q-28).
 */
describe('a system actor', () => {
  let prisma: PrismaService;
  let wiring: Wiring;

  const org = tenants();

  /**
   * A context with genuinely **no** user, which is the whole point.
   *
   * `asActor` invents a user id when none is given, so it cannot express this
   * shape — and an empty string would not either: `userId ?? SERVICE_NAME`
   * treats `''` as a perfectly good user and writes it into the actor column.
   * The context is therefore built here, exactly as `createSystemContext`
   * builds one for a consumer.
   */
  const asSystem = <T>(fn: () => Promise<T>, organizationId = org.a): Promise<T> => {
    const context: RequestContext = {
      correlationId: `system-itest-${ulid()}`,
      requestId: `system-itest-${ulid()}`,
      organizationId,
      roles: ['SERVICE'],
      authType: 'SERVICE',
      callerService: 'marketplace-service',
      startedAt: Date.now(),
    };
    return runWithContext(context, async () => fn());
  };

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.onModuleDestroy();
  });

  async function heldTransaction(amountMinor = 40_000n): Promise<string> {
    await fundWallet(wiring, org.a, amountMinor * 4n);
    const created = await asSystem(() =>
      wiring.transactions.create({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: org.b,
        grossAmountMinor: amountMinor.toString(),
        currency: 'IRR',
        holdFunds: true,
      }),
    );
    return created.id;
  }

  const rowFor = (transactionId: string) =>
    runUnscoped('the system-actor suite verifies what was written across tenants', () =>
      prisma.client.transaction.findUnique({ where: { id: transactionId } }),
    );

  // -------------------------------------------------------------------------

  it('names itself on a transaction it creates', async () => {
    const transactionId = await heldTransaction();

    const row = await rowFor(transactionId);
    expect(row?.createdBy).toBe('economic-service');
  });

  it('names itself on a dispute, its resolution and a cancellation', async () => {
    const transactionId = await heldTransaction();

    await asSystem(() => wiring.transactions.authoriseSettlement(transactionId));
    await asSystem(() =>
      wiring.transactions.dispute(transactionId, {
        reason: 'raised by an automated reconciliation, with no person behind it',
      }),
    );

    let row = await rowFor(transactionId);
    expect(row?.status).toBe('DISPUTED');
    expect(row?.disputedBy).toBe('economic-service');

    await asSystem(() =>
      wiring.transactions.resolveDispute(transactionId, {
        resolution: 'resolved by the same automation, recorded as the service',
      }),
    );
    row = await rowFor(transactionId);
    expect(row?.disputeResolvedBy).toBe('economic-service');

    const cancellable = await asSystem(() =>
      wiring.transactions.create({
        transactionType: 'LOGISTICS',
        counterpartyOrganizationId: org.b,
        grossAmountMinor: '900',
        currency: 'IRR',
        holdFunds: false,
      }),
    );
    await asSystem(() => wiring.transactions.cancel(cancellable.id, 'withdrawn by automation'));
    expect((await rowFor(cancellable.id))?.status).toBe('CANCELLED');
  });

  it('names itself on a refund, and returns the escrow', async () => {
    const transactionId = await heldTransaction(12_000n);

    await asSystem(() => wiring.transactions.refund(transactionId, 'returned by automation'));

    const row = await rowFor(transactionId);
    expect(row?.status).toBe('REFUNDED');
  });

  it('names itself on a settlement', async () => {
    const transactionId = await heldTransaction(15_000n);
    await asSystem(() => wiring.transactions.authoriseSettlement(transactionId));

    const result = await asSystem(() => wiring.settlements.settle(transactionId, 'ORDER_SAGA'));

    const settlement = await runUnscoped('the suite reads the settlement it produced', () =>
      prisma.client.settlement.findUnique({ where: { id: result.settlementId } }),
    );
    // The caller names the actor explicitly here, because a settlement's
    // authority comes from whatever asked for it — a saga, an operator — and
    // the row has to say which.
    expect(settlement?.settledBy).toBe('ORDER_SAGA');
  });

  it('names itself on a governance rule it writes', async () => {
    const commission = await asSystem(() =>
      wiring.commissions.createRule({
        organizationId: org.a,
        transactionType: 'LOGISTICS',
        rateBasisPoints: 120,
        // `status` omitted: the service supplies the default rather than
        // leaving a rule in an undefined state.
        // JUSTIFIED-ANY: the DTO is a Zod inference whose defaults are applied
        // at the HTTP boundary, and this call deliberately bypasses it.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    );
    expect(commission.status).toBe('ACTIVE');

    const rewardRule = await asSystem(() =>
      wiring.rewards.createRule({
        organizationId: org.a,
        triggerEvent: 'USAGE_RECORDED',
        points: 4,
        // `rewardType` omitted too — points, never cashback, until the
        // regulatory review concludes (docs/24 Q-07).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    );
    expect(rewardRule.rewardType).toBe('POINTS');
    expect(rewardRule.status).toBe('ACTIVE');

    const rows = await runUnscoped('the suite reads back the rules it wrote', () =>
      prisma.client.commissionRule.findMany({ where: { id: commission.id } }),
    );
    expect(rows[0]?.createdBy).toBe('economic-service');
  });

  it('grants nothing when the trigger names no subject at all', async () => {
    // A context with no user reaches the reward path from a consumer whose
    // event carried no actor. Points for "the system" would be a fabricated
    // subject, so the answer is none.
    const outcomes = await asSystem(() =>
      wiring.rewards.grantFor({
        organizationId: org.a,
        userId: null,
        triggerEvent: 'USAGE_RECORDED',
        sourceReference: `USG_${ulid()}`,
        occurredAt: new Date(),
        payload: {},
      }),
    );
    expect(outcomes).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The ledger's aggregate reads
  // -------------------------------------------------------------------------

  describe('the trial balance', () => {
    it('sums every account platform-wide, and balances', async () => {
      await fundWallet(wiring, org.c, 55_000n);

      const balance = await wiring.ledger.trialBalance('IRR');

      // Platform-wide by nature: a single organization slice does not balance,
      // because a settlement's counterparty and commission legs belong
      // elsewhere (docs/10 § 10.13).
      expect(balance.balanced).toBe(true);
      expect(BigInt(balance.totalDebitMinor)).toBe(BigInt(balance.totalCreditMinor));
      expect(balance.accounts.length).toBeGreaterThan(0);
      for (const account of balance.accounts) {
        expect(typeof account.balanceMinor).toBe('string');
        expect(account.accountCode).not.toBe('(unknown)');
      }
    });

    it('reports nothing rather than zero for a currency nobody uses', async () => {
      // An empty report and a balanced one are different facts. Reporting
      // `balanced: true` over no accounts at all would be true and useless.
      const balance = await wiring.ledger.trialBalance('XTS');
      expect(balance.accounts).toHaveLength(0);
      expect(BigInt(balance.totalDebitMinor)).toBe(0n);
    });

    it('lists an organization’s accounts, and every account when none is named', async () => {
      // Funded here rather than relying on the test above: a suite whose cases
      // depend on execution order is one that passes for reasons nobody can
      // see (AGENTS.md § 5).
      await fundWallet(wiring, org.c, 12_000n);

      // Tenant-scoped, so it needs a context — the guard refuses a read it
      // cannot attribute to an organization, which is the point of it.
      const scoped = await asSystem(() => wiring.ledgerRepository.listAccounts(org.c), org.c);
      expect(scoped.length).toBeGreaterThan(0);
      for (const account of scoped) expect(account.organizationId).toBe(org.c);

      // The unscoped form is what the trial balance uses. It exists precisely
      // because a cross-organization report cannot be assembled from a
      // tenant-filtered read.
      const ids = scoped.map((account) => account.id);
      const byId = await asSystem(() => wiring.ledgerRepository.accountsByIds(ids), org.c);
      expect(byId.map((account) => account.id).sort()).toEqual([...ids].sort());

      // And the guard refuses a read narrowed to somebody else's organization
      // outright, rather than running it and returning nothing. The difference
      // matters: an empty result reads as "no such accounts", which is a fact
      // about another tenant's data that this caller is not entitled to learn.
      await expect(
        asSystem(() => wiring.ledgerRepository.accountsByIds(ids, org.a), org.c),
      ).rejects.toThrow(/acts for/);
    });
  });

  // -------------------------------------------------------------------------
  // Upkeep with nothing to do
  // -------------------------------------------------------------------------

  /** An unpublished outbox row, under whichever tenant is named. */
  async function writeOutboxRow(organizationId: string): Promise<string> {
    const rowId = `OBX_${ulid()}`;
    await runUnscoped('the system-actor suite writes an outbox row directly', () =>
      prisma.client.outboxMessage.create({
        data: {
          id: rowId,
          aggregateType: 'Wallet',
          aggregateId: `WLT_${rowId}`,
          eventName: 'WALLET_OPENED',
          eventVersion: 1,
          topic: 'rasta.economic.v1',
          partitionKey: `WLT_${rowId}`,
          payload: { walletId: `WLT_${rowId}` },
          headers: {},
          organizationId,
          correlationId: `system-itest-${rowId}`,
        },
      }),
    );
    return rowId;
  }

  /**
   * How many of exactly these rows are still outstanding.
   *
   * The predicate `pendingCount()` applies, narrowed to rows this test wrote.
   * That narrowing exists only here: the production gauge is deliberately
   * platform-wide, because the outbox is plumbing and a per-tenant backlog
   * gauge would hide the outage it exists to reveal (ADR-006).
   */
  const pendingAmong = (ids: string[]) =>
    runUnscoped('the suite counts its own pending rows', () =>
      prisma.client.outboxMessage.count({ where: { id: { in: ids }, publishedAt: null } }),
    );

  /**
   * The upkeep gauges, asserted over rows this test owns.
   *
   * What used to stand here stamped `published_at = now()` on **every**
   * unpublished row in the database — no organization, no id list, no bound —
   * and then asserted the global queue was empty. The rows were not sent to
   * Kafka; they were simply made unclaimable, because `claimPendingSql`
   * selects on `published_at IS NULL`. A concurrent or later suite waiting for
   * one of those events then failed with a timeout naming the broker, which is
   * a "message never arrived" diagnosis whose true cause was this line.
   *
   * The queue being globally empty was never a property of the code under
   * test. It was a property of nobody else using the database. So the exact
   * assertions are made about named rows, and the platform gauges get the
   * bounds that genuinely hold — including a lower bound proved by a row this
   * suite deliberately does not own.
   */
  it('publishes only the rows it owns, and reads the gauges over them', async () => {
    const store = new PrismaOutboxStore(prisma);

    // A row belonging to nobody in this run. It is the negative control: if
    // the publish below is unbounded again, this row is the one that shows it.
    const foreignOrg = `ORG-FOREIGN-CONTROL-${ulid().slice(-10)}`;
    const foreignId = await writeOutboxRow(foreignOrg);

    try {
      const mine = [
        await writeOutboxRow(org.a),
        await writeOutboxRow(org.a),
        await writeOutboxRow(org.b),
      ];

      expect(await pendingAmong(mine)).toBe(3);

      // Exactly these ids. The relay is not involved — this test is about the
      // gauges, and nothing here claims to have delivered anything.
      await runUnscoped('the suite publishes the rows it created, by id', () =>
        prisma.client.outboxMessage.updateMany({
          where: { id: { in: mine } },
          data: { publishedAt: new Date() },
        }),
      );

      // Exact, because it names the rows.
      expect(await pendingAmong(mine)).toBe(0);

      // And the row this suite does not own is untouched: still there, still
      // unpublished, still claimable by whoever wrote it.
      const foreign = await runUnscoped('the suite reads the row it must not have touched', () =>
        prisma.client.outboxMessage.findUnique({ where: { id: foreignId } }),
      );
      expect(foreign).not.toBeNull();
      expect(foreign?.publishedAt).toBeNull();

      // The platform gauge counts rows this suite does not own — which is the
      // whole reason it cannot be asserted to be zero. One such row is pending
      // right now, by construction, so this bound is exact rather than vacuous.
      expect(await store.pendingCount()).toBeGreaterThanOrEqual(1);

      // Zero rather than null, which is the property an operator depends on:
      // the gauge is scraped every fifteen seconds and a null would render as
      // a gap in a graph, read as "the exporter is down" rather than "the
      // queue is empty". A number is what makes those two distinguishable.
      const age = await store.oldestPendingAgeSeconds();
      expect(age).not.toBeNull();
      expect(Number.isFinite(age)).toBe(true);
      expect(age).toBeGreaterThanOrEqual(0);

      // The default retention, taken rather than passed.
      expect(await store.purgePublished()).toBeGreaterThanOrEqual(0);
    } finally {
      await runUnscoped('the suite removes the control row it seeded', () =>
        prisma.client.outboxMessage.deleteMany({ where: { id: foreignId } }),
      );
    }
  });

  it('finds a wallet whose three stored balances disagree with each other', async () => {
    const { walletId } = await fundWallet(wiring, org.b, 60_000n);

    // `ck_wallet_balances` makes this impossible through any code path, so the
    // constraint is suspended for exactly as long as it takes to write the row
    // the reconciliation exists to notice. The audit must not depend on the
    // constraint being present — a dropped constraint is one of the things it
    // is there to catch.
    //
    // Three things about the recovery path, each of which was wrong here:
    //
    //   - The restore is in a `finally`. It used to run only after the
    //     assertions below, so a failing assertion left the constraint off.
    //   - The row is repaired *before* the constraint comes back, so the
    //     constraint can be added fully validated. It used to be re-added
    //     `NOT VALID` with the `VALIDATE` a separate statement further down —
    //     enforced for new writes, not for existing rows — and a failure in
    //     between left it permanently unvalidated. A later suite's
    //     reconciliation then finds deviations it did not create.
    //   - The definition restored is the **original** one. The old text
    //     re-added only `available = ledger - pending` and silently dropped
    //     the three `>= 0` clauses, so a suite that ran this test left the
    //     database with a weaker invariant than the migration installed.
    //
    // Each half is one transaction, so a crash inside either rolls it back. A
    // kill in the gap between them still leaves the constraint absent — that
    // gap closes only with a per-run schema, and until then
    // `isolation-controls.int-spec.ts` is what notices.
    try {
      await runUnscoped('the suite writes a row the constraint would refuse', () =>
        prisma.transaction(async (tx) => {
          // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE. The row it
          // exists for is named on the next line, and the `finally` below
          // restores the constraint on every path out of this test.
          await tx.$executeRawUnsafe('ALTER TABLE wallet DROP CONSTRAINT ck_wallet_balances');
          await tx.$executeRawUnsafe(
            `UPDATE wallet SET available_balance_minor = available_balance_minor + 7 WHERE id = $1`,
            walletId,
          );
        }),
      );

      const audit = new LedgerBalanceAudit(wiring.walletRepository, wiring.ledger, testEnv());
      const deviations = await audit.run();

      const found = deviations.find((row) => row.walletId === walletId);
      expect(found?.kind).toBe('INTERNAL_INCONSISTENCY');
    } finally {
      await runUnscoped('the suite restores the row and the constraint together', () =>
        prisma.transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE wallet SET available_balance_minor = available_balance_minor - 7 WHERE id = $1`,
            walletId,
          );
          // ISOLATION-ALLOW-UNBOUNDED: the restore half of the DDL above,
          // word for word as `20260828202043_init_economic` installs it.
          await tx.$executeRawUnsafe(
            `ALTER TABLE wallet ADD CONSTRAINT ck_wallet_balances
               CHECK (
                 "ledger_balance_minor"    >= 0 AND
                 "pending_balance_minor"   >= 0 AND
                 "available_balance_minor" >= 0 AND
                 "available_balance_minor" = "ledger_balance_minor" - "pending_balance_minor"
               )`,
          );
        }),
      );
    }
  });
  it('supplies the currency when a caller that bypasses the schema omits it', async () => {
    // The Zod schema defaults `currency` at the HTTP boundary, so this branch
    // is only reachable by a caller inside the process — a consumer, or a
    // workflow activity. It has to hold there too: a transaction with no
    // currency cannot be settled against a ledger that is per-currency.
    await fundWallet(wiring, org.a, 40_000n);

    const created = await asSystem(() =>
      wiring.transactions.create({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: org.b,
        grossAmountMinor: '6000',
        holdFunds: true,
        // JUSTIFIED-ANY: deliberately omitting the field the schema would have
        // defaulted, which is the whole point of the case.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    );

    expect(created.currency).toBe('IRR');
    const row = await rowFor(created.id);
    expect(row?.currency).toBe('IRR');
  });

  it('reads no reward standing for a caller that is not a person', async () => {
    // A service has no points. Returning somebody's balance because the
    // request happened to carry an organization would be answering a question
    // about a user who does not exist.
    await expect(asSystem(() => wiring.rewards.myRewards(25))).rejects.toThrow();
  });

  it('reports a settlement of a transaction that is not there as not found', async () => {
    // Through the service rather than the controller: the controller reads the
    // transaction first and refuses there, so the settlement's own guard — and
    // the error mapping around it — is only reachable from inside.
    await expect(
      asSystem(() => wiring.settlements.settle(`TXN_${ulid()}`, 'ORDER_SAGA')),
    ).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});
