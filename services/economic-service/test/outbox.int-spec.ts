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

    it('puts a whole transaction lifecycle on one partition key', async () => {
      // ADR-036, the invariant Q-26 asked for. Before it, these rows carried
      // four different keys — the hold, the journal, the settlement's own id
      // and the transaction — so a consumer rebuilding one transaction could
      // see the money released before it learned it had been held.
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

      const rows = await outboxFor(organizationId);
      const ofThisTransaction = rows.filter(
        (row) =>
          (row.payload as { payload?: { transactionId?: string } })?.payload?.transactionId ===
          transaction.id,
      );

      // The hold, its release, and both journals — every row whose payload
      // names this transaction.
      expect(new Set(ofThisTransaction.map((row) => row.eventName))).toEqual(
        new Set(['FUNDS_HELD', 'FUNDS_RELEASED', 'SETTLEMENT_COMPLETED', 'JOURNAL_POSTED']),
      );
      expect(ofThisTransaction.length).toBeGreaterThanOrEqual(4);
      expect(new Set(ofThisTransaction.map((row) => row.partitionKey))).toEqual(
        new Set([transaction.id]),
      );

      // And the aggregate identity is *not* flattened along with the key: each
      // row still names the entity it is about, which is what an auditor reads.
      const held = ofThisTransaction.find((row) => row.eventName === 'FUNDS_HELD');
      expect(held?.aggregateType).toBe('WalletHold');
      expect(held?.aggregateId).not.toBe(transaction.id);
      expect(held?.partitionKey).toBe(transaction.id);

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
      expect(commission?.aggregateType).toBe('Commission');

      await cleanup(prisma, [organizationId]);
    });

    it('lets two transactions of one wallet partition independently', async () => {
      // Ordering is per transaction, not global and not per wallet. Two
      // unrelated obligations on the same wallet have no causal order between
      // them, and forcing one would serialise the whole domain behind a single
      // busy tenant.
      const organizationId = `${org.a}-OUTBOX-KEY-2`;
      await fundWallet(wiring, organizationId, 2_000_000n);

      const create = () =>
        asActor({ organizationId }, () =>
          wiring.transactions.create({
            transactionType: 'MARKETPLACE_ORDER',
            counterpartyOrganizationId: org.b,
            grossAmountMinor: '500000',
            currency: 'IRR',
            holdFunds: true,
          }),
        );

      const first = await create();
      const second = await create();

      const holds = (await outboxFor(organizationId)).filter(
        (row) => row.eventName === 'FUNDS_HELD',
      );

      expect(holds.map((row) => row.partitionKey).sort()).toEqual([first.id, second.id].sort());

      await cleanup(prisma, [organizationId]);
    });

    it('keys a wallet-only event by the wallet', async () => {
      // `WALLET_OPENED` has no transaction and is not given one. It is ordered
      // against the wallet it opened, which is the only thing it is about.
      const organizationId = `${org.a}-OUTBOX-KEY-WALLET`;
      await fundWallet(wiring, organizationId, 100_000n);

      const opened = (await outboxFor(organizationId)).find(
        (row) => row.eventName === 'WALLET_OPENED',
      );
      const walletId = (opened?.payload as { payload?: { walletId?: string } })?.payload?.walletId;

      expect(walletId).toBeTruthy();
      expect(opened?.partitionKey).toBe(walletId);
      expect(opened?.aggregateType).toBe('Wallet');

      await cleanup(prisma, [organizationId]);
    });

    it('keys a journal with no transaction by the journal', async () => {
      // The wallet's opening credit in `fundWallet` is posted without a
      // transaction, exactly like a reward grant. Its `JOURNAL_POSTED` has
      // nothing to be ordered with, so it is ordered by itself — rather than
      // borrowing a transaction id that does not belong to it.
      const organizationId = `${org.a}-OUTBOX-KEY-JOURNAL`;
      await fundWallet(wiring, organizationId, 100_000n);

      const journals = (await outboxFor(organizationId)).filter(
        (row) => row.eventName === 'JOURNAL_POSTED',
      );
      const detached = journals.filter(
        (row) =>
          (row.payload as { payload?: { transactionId?: string | null } })?.payload
            ?.transactionId == null,
      );

      expect(detached.length).toBeGreaterThan(0);
      for (const row of detached) {
        const journalId = (row.payload as { payload?: { journalId?: string } })?.payload?.journalId;
        expect(journalId).toBeTruthy();
        expect(row.partitionKey).toBe(journalId);
      }

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

    it('retries a failed row with the key it was written with', async () => {
      // ADR-036. A retry that re-derived the key — or lost it — would move the
      // event to another partition and undo the ordering on the second
      // attempt, which is the attempt nobody watches.
      const id = `OBX_ITEST_${ulid()}`;
      const transactionId = `TXN_ITEST_${ulid()}`;

      await runUnscoped('the outbox audit writes platform plumbing', () =>
        prisma.client.outboxMessage.create({
          data: {
            id,
            aggregateType: 'WalletHold',
            aggregateId: `HLD_ITEST_${ulid()}`,
            eventName: 'FUNDS_HELD',
            topic: ECONOMIC_TOPIC,
            partitionKey: transactionId,
            payload: {},
            headers: {},
            organizationId: org.a,
            correlationId: 'itest',
          },
        }),
      );

      await store.markFailed(id, 'broker unreachable');
      await store.markFailed(id, 'broker unreachable again');

      const retried = (await store.claimPending(500)).find((row) => row.id === id);

      expect(retried).toBeDefined();
      expect(retried?.attempts).toBe(2);
      // The key is a stored column, not something recomputed at publish time,
      // so the second attempt and the tenth carry what the first did.
      expect(retried?.partitionKey).toBe(transactionId);
      // A manual DLQ replay reads the same row (docs/runbooks/replay-dlq.md);
      // every economic event is in `NEVER_AUTO_REPLAY`, so this is the only
      // path back onto the topic, and it cannot reorder what it republishes.
      expect(retried?.aggregateType).toBe('WalletHold');
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
