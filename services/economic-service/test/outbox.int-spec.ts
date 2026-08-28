import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { asActor, cleanup, fundWallet, newPrisma, tenants, wire, type Wiring } from './helpers';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { ECONOMIC_TOPIC } from '../src/config/env';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * The transactional outbox (ADR-021), against a real database.
 *
 * The guarantee is stated as a pair, and only the pair is useful:
 *
 *   a state change that commits **always** publishes its event
 *   a state change that rolls back **never** publishes its event
 *
 * The second half is the one this suite exists for. It is easy to write an
 * outbox that satisfies the first and silently satisfies the second only
 * because nothing has failed yet — so every negative case here forces a
 * failure and then checks that the topic row is gone with the money.
 *
 * In a financial service the consequence is concrete: a phantom
 * `SETTLEMENT_COMPLETED` tells marketplace-service an order was paid for when
 * it was not, and a lost one leaves a supplier permanently unpaid.
 */
describe('transactional outbox (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  let store: PrismaOutboxStore;
  const org = tenants();

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
    store = new PrismaOutboxStore(prisma);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.onModuleDestroy();
  });

  function outboxFor(organizationId: string) {
    return runUnscoped('the outbox audit reads platform plumbing', () =>
      prisma.client.outboxMessage.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  describe('a committed change always publishes', () => {
    it('writes the event in the same transaction as the money', async () => {
      const organizationId = `${org.a}-OUTBOX`;
      await fundWallet(wiring, organizationId, 3_000_000n);

      const rows = await outboxFor(organizationId);
      const names = rows.map((row) => row.eventName);

      // Opening the wallet and crediting it each announced themselves.
      expect(names).toContain('WALLET_OPENED');
      expect(names).toContain('JOURNAL_POSTED');

      await cleanup(prisma, [organizationId]);
    });

    it('writes one row per event of a settlement, all on the economic topic', async () => {
      const organizationId = `${org.a}-OUTBOX-SETTLE`;
      await fundWallet(wiring, organizationId, 2_000_000n);

      const transaction = await asActor({ organizationId }, () =>
        wiring.transactions.create({
          transactionType: 'MARKETPLACE_ORDER',
          counterpartyOrganizationId: org.b,
          grossAmountMinor: '2000000',
          currency: 'IRR',
          holdFunds: true,
        }),
      );
      await asActor({ organizationId }, () =>
        wiring.transactions.authoriseSettlement(transaction.id),
      );
      await asActor({ organizationId }, () =>
        wiring.settlements.settle(transaction.id, 'USR-ITEST'),
      );

      const rows = await outboxFor(organizationId);
      const names = new Set(rows.map((row) => row.eventName));

      expect(names).toContain('FUNDS_HELD');
      expect(names).toContain('FUNDS_RELEASED');
      expect(names).toContain('SETTLEMENT_COMPLETED');
      expect(names).toContain('JOURNAL_POSTED');

      for (const row of rows) {
        expect(row.topic).toBe(ECONOMIC_TOPIC);
        expect(row.correlationId).toBeTruthy();
        expect(row.partitionKey).toBeTruthy();
        expect(row.publishedAt).toBeNull();
      }

      await cleanup(prisma, [organizationId]);
    });

    it('keys a settlement event by its transaction, so the pair stays ordered', async () => {
      // ADR-006. `FUNDS_HELD` and `SETTLEMENT_COMPLETED` for one transaction
      // must reach a consumer in the order they happened — reversed, it would
      // see money released before it was ever held.
      const organizationId = `${org.a}-OUTBOX-KEY`;
      await fundWallet(wiring, organizationId, 1_000_000n);

      const transaction = await asActor({ organizationId }, () =>
        wiring.transactions.create({
          transactionType: 'MARKETPLACE_ORDER',
          counterpartyOrganizationId: org.b,
          grossAmountMinor: '1000000',
          currency: 'IRR',
          holdFunds: true,
        }),
      );
      await asActor({ organizationId }, () =>
        wiring.transactions.authoriseSettlement(transaction.id),
      );
      await asActor({ organizationId }, () =>
        wiring.settlements.settle(transaction.id, 'USR-ITEST'),
      );

      const settlement = (await outboxFor(organizationId)).find(
        (row) => row.eventName === 'SETTLEMENT_COMPLETED',
      );
      expect(settlement?.partitionKey).toBe(transaction.id);

      // `COMMISSION_APPLIED` is filed under the **payee**, because the
      // commission is charged out of their proceeds — so it is looked up there
      // rather than under the payer. It is keyed by the transaction all the
      // same, so a consumer reconciling one transaction sees the commission in
      // order with the settlement that produced it.
      // Matched on the payload rather than on order: the payee accumulates
      // rows from every settlement in this suite, so "the most recent one" is
      // not the same statement as "this transaction's".
      const commission = (await outboxFor(org.b)).find(
        (row) =>
          row.eventName === 'COMMISSION_APPLIED' &&
          (row.payload as { payload?: { transactionId?: string } })?.payload?.transactionId ===
            transaction.id,
      );
      expect(commission).toBeDefined();
      expect(commission?.partitionKey).toBe(transaction.id);

      await cleanup(prisma, [organizationId]);
    });

    it('carries the envelope headers a consumer filters on', async () => {
      const organizationId = `${org.a}-OUTBOX-HEADERS`;
      await fundWallet(wiring, organizationId, 500_000n);

      const rows = await outboxFor(organizationId);
      const headers = rows[0]?.headers as Record<string, string>;

      expect(headers['x-event-id']).toBeTruthy();
      expect(headers['x-event-name']).toBeTruthy();
      expect(headers['x-correlation-id']).toBeTruthy();
      expect(headers['x-producer']).toBe('economic-service');
      expect(headers['x-tenant-id']).toBe(organizationId);

      await cleanup(prisma, [organizationId]);
    });
  });

  describe('a rolled-back change never publishes', () => {
    it('leaves no outbox row when the settlement fails', async () => {
      // The half that matters. Without it, a failed settlement would announce
      // itself to every consumer on the platform and a supplier would be told
      // it had been paid.
      const organizationId = `${org.c}-OUTBOX-FAIL`;
      await fundWallet(wiring, organizationId, 1_000_000n);

      const transaction = await asActor({ organizationId }, () =>
        wiring.transactions.create({
          transactionType: 'MARKETPLACE_ORDER',
          counterpartyOrganizationId: org.b,
          grossAmountMinor: '1000000',
          currency: 'IRR',
          holdFunds: true,
        }),
      );
      await asActor({ organizationId }, () =>
        wiring.transactions.authoriseSettlement(transaction.id),
      );

      const before = (await outboxFor(organizationId)).length;

      const record = jest
        .spyOn(wiring.commissions, 'record')
        .mockRejectedValueOnce(new Error('injected failure'));

      await expect(
        asActor({ organizationId }, () => wiring.settlements.settle(transaction.id, 'USR-ITEST')),
      ).rejects.toThrow('injected failure');

      record.mockRestore();

      const rows = await outboxFor(organizationId);
      expect(rows).toHaveLength(before);
      expect(rows.map((row) => row.eventName)).not.toContain('SETTLEMENT_COMPLETED');

      await cleanup(prisma, [organizationId]);
    });

    it('leaves no outbox row when a hold is refused', async () => {
      const organizationId = `${org.c}-OUTBOX-POOR`;
      await fundWallet(wiring, organizationId, 100n);
      const before = (await outboxFor(organizationId)).length;

      await expect(
        asActor({ organizationId }, () =>
          wiring.transactions.create({
            transactionType: 'MARKETPLACE_ORDER',
            counterpartyOrganizationId: org.b,
            grossAmountMinor: '999999',
            currency: 'IRR',
            holdFunds: true,
          }),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' }));

      const rows = await outboxFor(organizationId);
      expect(rows).toHaveLength(before);
      expect(rows.map((row) => row.eventName)).not.toContain('FUNDS_HELD');

      await cleanup(prisma, [organizationId]);
    });

    it('refuses to enqueue a payload that does not match its contract', async () => {
      // Publish-time validation (docs/07 § 7.8). A malformed event never
      // enters the log at all — the alternative is discovering it in somebody
      // else's dead-letter topic, where a financial event may not be replayed
      // automatically.
      await expect(
        asActor({ organizationId: org.a }, () =>
          prisma.transaction((tx) =>
            wiring.ledger.enqueue(tx, {
              eventName: 'SETTLEMENT_COMPLETED',
              aggregateId: 'STL_BAD',
              organizationId: org.a,
              payload: { settlementId: 'STL_BAD', grossAmountMinor: 12345 },
            }),
          ),
        ),
      ).rejects.toThrow();
    });
  });

  describe('the relay claim', () => {
    it('claims only unpublished rows, oldest first', async () => {
      const organizationId = `${org.a}-OUTBOX-CLAIM`;
      await fundWallet(wiring, organizationId, 100_000n);

      const claimed = await store.claimPending(100);
      expect(claimed.length).toBeGreaterThan(0);
      for (const row of claimed) {
        expect(row.publishedAt).toBeNull();
      }

      const ids = claimed.map((row) => row.id);
      await store.markPublished(ids);

      const afterPublish = await runUnscoped('the outbox audit reads platform plumbing', () =>
        prisma.client.outboxMessage.findMany({ where: { id: { in: ids } } }),
      );
      for (const row of afterPublish) {
        expect(row.publishedAt).not.toBeNull();
      }

      await cleanup(prisma, [organizationId]);
    });

    it('records a failure without losing the row', async () => {
      // An unpublished row is an event nobody has received yet. It is retried,
      // never dropped.
      const id = `OBX_ITEST_${ulid()}`;
      await runUnscoped('the outbox audit writes platform plumbing', () =>
        prisma.client.outboxMessage.create({
          data: {
            id,
            aggregateType: 'Journal',
            aggregateId: 'JRN_ITEST',
            eventName: 'JOURNAL_POSTED',
            topic: ECONOMIC_TOPIC,
            partitionKey: 'JRN_ITEST',
            payload: {},
            headers: {},
            organizationId: org.a,
            correlationId: 'itest',
          },
        }),
      );

      await store.markFailed(id, 'broker unreachable');

      const row = await runUnscoped('the outbox audit reads platform plumbing', () =>
        prisma.client.outboxMessage.findUnique({ where: { id } }),
      );

      expect(row?.attempts).toBe(1);
      expect(row?.lastError).toBe('broker unreachable');
      expect(row?.publishedAt).toBeNull();
    });

    it('purges only published rows past their retention window', async () => {
      // An unpublished row is never purged, however old: deleting it would
      // lose the event silently.
      const unpublished = `OBX_KEEP_${ulid()}`;
      await runUnscoped('the outbox audit writes platform plumbing', () =>
        prisma.client.outboxMessage.create({
          data: {
            id: unpublished,
            aggregateType: 'Journal',
            aggregateId: 'JRN_OLD',
            eventName: 'JOURNAL_POSTED',
            topic: ECONOMIC_TOPIC,
            partitionKey: 'JRN_OLD',
            payload: {},
            headers: {},
            organizationId: org.a,
            correlationId: 'itest',
            createdAt: new Date('2020-01-01T00:00:00.000Z'),
          },
        }),
      );

      await store.purgePublished(1);

      const survivor = await runUnscoped('the outbox audit reads platform plumbing', () =>
        prisma.client.outboxMessage.findUnique({ where: { id: unpublished } }),
      );
      expect(survivor).not.toBeNull();
    });
  });
});
