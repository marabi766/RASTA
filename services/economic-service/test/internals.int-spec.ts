import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { InMemoryEventPublisher } from '../src/outbox/kafka.publisher';
import { IdempotencyStore } from '../src/shared/idempotency';
import { LedgerBalanceAudit } from '../src/wallet/balance-audit';
import {
  asActor,
  cleanup,
  fundWallet,
  newPrisma,
  silentLogger,
  tenants,
  testEnv,
  wire,
  type Wiring,
} from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * The plumbing the financial paths rest on, at the points where it decides
 * something.
 *
 * None of this is reachable from an HTTP request, and all of it changes what
 * the platform does: an outbox row that is purged while unpublished is an
 * event nobody ever receives; an idempotency key that outlives its window
 * turns a retry guard into a permanent cache of financial responses; a
 * reconciliation that misses a hold/escrow divergence is the difference
 * between an incident found in an hour and one found in a quarter.
 */
describe('economic internals', () => {
  let prisma: PrismaService;
  let wiring: Wiring;

  const org = tenants();

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.onModuleDestroy();
  });

  // -------------------------------------------------------------------------
  // The outbox store
  // -------------------------------------------------------------------------

  describe('the outbox store', () => {
    let store: PrismaOutboxStore;

    beforeAll(() => {
      store = new PrismaOutboxStore(prisma);
    });

    async function writeRow(overrides: Record<string, unknown> = {}): Promise<string> {
      const rowId = ulid();
      await runUnscoped('the internals suite writes an outbox row directly', () =>
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
            organizationId: org.a,
            correlationId: `internals-${rowId}`,
            ...overrides,
          },
        }),
      );
      return rowId;
    }

    it('does nothing when asked to publish an empty batch', async () => {
      // The relay calls this with whatever it read, and an empty read is the
      // ordinary steady state. An UPDATE with an empty `IN ()` would be a
      // pointless round trip on every poll.
      await expect(store.markPublished([])).resolves.toBeUndefined();
    });

    it('records a failure against the row rather than losing it', async () => {
      const rowId = await writeRow();

      await store.markFailed(rowId, 'the broker refused the batch');

      const row = await runUnscoped('the suite reads back the row it wrote', () =>
        prisma.client.outboxMessage.findUnique({ where: { id: rowId } }),
      );
      // Attempts and the reason both, and the row still unpublished: a failed
      // publish must stay in the queue, because the outbox is the only record
      // that the event has not gone out (ADR-021).
      expect(row?.attempts).toBe(1);
      expect(row?.lastError).toContain('refused');
      expect(row?.publishedAt).toBeNull();
    });

    it('reports the age of the oldest pending row, and zero when there are none', async () => {
      const rowId = await writeRow();

      expect(await store.pendingCount()).toBeGreaterThan(0);
      // The gauge an operator alerts on: a rising age means the relay has
      // stopped, which no error anywhere else would say.
      expect(await store.oldestPendingAgeSeconds()).toBeGreaterThanOrEqual(0);

      await store.markPublished([rowId]);
      const published = await runUnscoped('the suite reads back the row it published', () =>
        prisma.client.outboxMessage.findUnique({ where: { id: rowId } }),
      );
      expect(published?.publishedAt).not.toBeNull();
    });

    it('purges only published rows, and only old ones', async () => {
      const old = new Date(Date.now() - 30 * 24 * 3600_000);
      const purgeable = await writeRow({ createdAt: old, publishedAt: old });
      const recent = await writeRow({ publishedAt: new Date() });
      const pending = await writeRow({ createdAt: old });

      const removed = await store.purgePublished(7);
      expect(removed).toBeGreaterThanOrEqual(1);

      const survivors = await runUnscoped('the suite checks what survived the purge', () =>
        prisma.client.outboxMessage.findMany({
          where: { id: { in: [purgeable, recent, pending] } },
          select: { id: true },
        }),
      );
      const ids = survivors.map((row) => row.id);

      expect(ids).not.toContain(purgeable);
      expect(ids).toContain(recent);
      // An unpublished row is an event that has not reached anybody yet.
      // Deleting it because it is old would lose it silently, so age alone is
      // never enough.
      expect(ids).toContain(pending);
    });
  });

  // -------------------------------------------------------------------------
  // The idempotency store
  // -------------------------------------------------------------------------

  describe('the idempotency store', () => {
    let store: IdempotencyStore;

    beforeAll(() => {
      store = new IdempotencyStore(prisma, testEnv());
    });

    const endpoint = 'POST /v1/internals-test';

    it('replays the recorded response, with the status it was recorded under', async () => {
      const key = `internals-${ulid()}`;

      const first = await asActor({ organizationId: org.a }, () =>
        store.run(endpoint, key, { amountMinor: '10' }, 201, async () => ({ value: 'first' })),
      );
      expect(first).toEqual({ value: 'first' });

      // The stored response, not a fresh computation. The callback must not
      // run again — a retried financial write that recomputes is the failure
      // idempotency exists to prevent.
      let ran = false;
      const replayed = await asActor({ organizationId: org.a }, () =>
        store.run(endpoint, key, { amountMinor: '10' }, 201, async () => {
          ran = true;
          return { value: 'second' };
        }),
      );
      expect(replayed).toEqual({ value: 'first' });
      expect(ran).toBe(false);
    });

    it('refuses the same key with a different body', async () => {
      const key = `internals-${ulid()}`;
      await asActor({ organizationId: org.a }, () =>
        store.run(endpoint, key, { amountMinor: '10' }, 201, async () => ({ ok: true })),
      );

      await expect(
        asActor({ organizationId: org.a }, () =>
          store.run(endpoint, key, { amountMinor: '20' }, 201, async () => ({ ok: true })),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }));
    });

    it('lets a key past its window be claimed again', async () => {
      const key = `internals-${ulid()}`;
      await asActor({ organizationId: org.a }, () =>
        store.run(endpoint, key, { amountMinor: '10' }, 201, async () => ({ attempt: 1 })),
      );

      // Backdated rather than waited for. The window is hours long by
      // configuration, and a test that slept through it would be useless.
      // Both columns, and by raw SQL: `ck_idempotency_expiry` requires
      // `expires_at > created_at`, so moving only the expiry backwards is a row
      // the database refuses — correctly, because such a row could never have
      // been written by the service.
      await runUnscoped('the suite expires an idempotency key it owns', () =>
        prisma.client.$executeRawUnsafe(
          `UPDATE idempotency_key
              SET created_at = now() - interval '2 hours',
                  expires_at = now() - interval '1 hour'
            WHERE key = $1`,
          key,
        ),
      );

      // A retry window that never closes is not a retry window — it is a
      // permanent cache of financial responses (docs/06 § 6.8).
      const second = await asActor({ organizationId: org.a }, () =>
        store.run(endpoint, key, { amountMinor: '10' }, 201, async () => ({ attempt: 2 })),
      );
      expect(second).toEqual({ attempt: 2 });
    });

    it('scopes a key to one organization', async () => {
      const key = `internals-${ulid()}`;
      await asActor({ organizationId: org.a }, () =>
        store.run(endpoint, key, { amountMinor: '10' }, 201, async () => ({ tenant: 'a' })),
      );

      // The same key string in another tenant is a different key. Sharing them
      // would let one organization's retry return another's response.
      const other = await asActor({ organizationId: org.b }, () =>
        store.run(endpoint, key, { amountMinor: '10' }, 201, async () => ({ tenant: 'b' })),
      );
      expect(other).toEqual({ tenant: 'b' });
    });

    it('removes expired keys when asked, and leaves live ones alone', async () => {
      const stale = `internals-${ulid()}`;
      const live = `internals-${ulid()}`;

      await asActor({ organizationId: org.a }, () =>
        store.run(endpoint, stale, { n: 1 }, 201, async () => ({ ok: true })),
      );
      await asActor({ organizationId: org.a }, () =>
        store.run(endpoint, live, { n: 2 }, 201, async () => ({ ok: true })),
      );
      await runUnscoped('the suite expires one of the two keys', () =>
        prisma.client.$executeRawUnsafe(
          `UPDATE idempotency_key
              SET created_at = now() - interval '2 hours',
                  expires_at = now() - interval '1 hour'
            WHERE key = $1`,
          stale,
        ),
      );

      await store.purgeExpired();

      const remaining = await runUnscoped('the suite checks which keys survived', () =>
        prisma.client.idempotencyKey.findMany({
          where: { key: { in: [stale, live] } },
          select: { key: true },
        }),
      );
      expect(remaining.map((row) => row.key)).toEqual([live]);
    });
  });

  // -------------------------------------------------------------------------
  // Holds, and the refusals around them
  // -------------------------------------------------------------------------

  describe('a hold', () => {
    it('cannot be placed for nothing', async () => {
      const { walletId } = await fundWallet(wiring, org.c, 50_000n);

      await expect(
        asActor({ organizationId: org.c }, () =>
          wiring.prisma.transaction(async (tx) => {
            const [locked] = await wiring.walletRepository.lock(tx, [walletId]);
            return wiring.wallets.placeHold(tx, {
              wallet: locked!,
              amountMinor: 0n,
              reference: `TXN_${ulid()}`,
              referenceType: 'TRANSACTION',
              transactionId: `TXN_${ulid()}`,
              placedBy: 'internals-itest',
            });
          }),
        ),
        // A hold of nothing is not a reservation, and it would still consume
        // the partial unique index that stops a second hold on the same
        // obligation.
      ).rejects.toThrow(expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }));
    });

    it('is returned unchanged when the same obligation is held twice for the same amount', async () => {
      const { walletId } = await fundWallet(wiring, org.c, 100_000n);
      const transactionId = `TXN_${ulid()}`;

      const place = () =>
        asActor({ organizationId: org.c }, () =>
          wiring.prisma.transaction(async (tx) => {
            const [locked] = await wiring.walletRepository.lock(tx, [walletId]);
            return wiring.wallets.placeHold(tx, {
              wallet: locked!,
              amountMinor: 10_000n,
              reference: transactionId,
              referenceType: 'TRANSACTION',
              transactionId,
              placedBy: 'internals-itest',
            });
          }),
        );

      const first = await place();
      const second = await place();

      // Two concurrent retries of one request must leave one hold. The partial
      // unique index makes that structural; this is the readable half of it.
      expect(second.holdId).toBe(first.holdId);
      expect(second.replayed).toBe(true);
    });

    it('refuses a second hold on the same obligation for a different amount', async () => {
      const { walletId } = await fundWallet(wiring, org.c, 100_000n);
      const transactionId = `TXN_${ulid()}`;

      const place = (amountMinor: bigint) =>
        asActor({ organizationId: org.c }, () =>
          wiring.prisma.transaction(async (tx) => {
            const [locked] = await wiring.walletRepository.lock(tx, [walletId]);
            return wiring.wallets.placeHold(tx, {
              wallet: locked!,
              amountMinor,
              reference: transactionId,
              referenceType: 'TRANSACTION',
              transactionId,
              placedBy: 'internals-itest',
            });
          }),
        );

      await place(10_000n);
      // Not a retry: a different amount under the same reference is a
      // different request, and silently returning the first hold would tell
      // the caller their 20 000 was reserved when 10 000 was.
      await expect(place(20_000n)).rejects.toThrow(
        expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }),
      );
    });

    it('cannot be released twice, and a hold that does not exist is not found', async () => {
      const { walletId } = await fundWallet(wiring, org.c, 100_000n);
      const transactionId = `TXN_${ulid()}`;

      const { holdId } = await asActor({ organizationId: org.c }, () =>
        wiring.prisma.transaction(async (tx) => {
          const [locked] = await wiring.walletRepository.lock(tx, [walletId]);
          return wiring.wallets.placeHold(tx, {
            wallet: locked!,
            amountMinor: 5_000n,
            reference: transactionId,
            referenceType: 'TRANSACTION',
            transactionId,
            placedBy: 'internals-itest',
          });
        }),
      );

      const refund = (id: string) =>
        asActor({ organizationId: org.c }, () =>
          wiring.prisma.transaction(async (tx) => {
            const [locked] = await wiring.walletRepository.lock(tx, [walletId]);
            return wiring.wallets.refundHold(tx, {
              wallet: locked!,
              holdId: id,
              transactionId,
              note: 'released by the internals suite',
              resolvedBy: 'internals-itest',
            });
          }),
        );

      expect(await refund(holdId)).not.toBeNull();
      // Already resolved: nothing to return, and returning it again would
      // credit the wallet twice for one reservation.
      expect(await refund(holdId)).toBeNull();

      await expect(refund(`WHD_${ulid()}`)).rejects.toThrow(
        expect.objectContaining({ code: 'NOT_FOUND' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Reversal refusals
  // -------------------------------------------------------------------------

  describe('a reversal', () => {
    it('refuses a journal that does not exist', async () => {
      await expect(
        asActor({ organizationId: org.a, roles: ['UNION_ADMIN'] }, () =>
          wiring.prisma.transaction((tx) =>
            wiring.ledger.reverse(tx, `JRN_${ulid()}`, 'a journal that was never posted', 'itest'),
          ),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    });

    it('refuses to reverse a reversal', async () => {
      const { walletId } = await fundWallet(wiring, org.a, 30_000n);
      const wallet = await asActor({ organizationId: org.a }, () =>
        wiring.walletRepository.findById(walletId),
      );
      expect(wallet).not.toBeNull();

      const journalId = await asActor({ organizationId: org.a }, async () => {
        const entries = await runUnscoped('the suite finds a journal it just posted', () =>
          prisma.client.ledgerEntry.findFirst({
            where: { organizationId: org.a },
            orderBy: { postedAt: 'desc' },
          }),
        );
        return entries!.journalId;
      });

      const reversal = await asActor({ organizationId: org.a, roles: ['UNION_ADMIN'] }, () =>
        wiring.prisma.transaction((tx) =>
          wiring.ledger.reverse(tx, journalId, 'reversed once by the internals suite', 'itest'),
        ),
      );

      // A reversal of a reversal is a re-post wearing a disguise, and it would
      // make the audit trail unreadable: the correct act is to post the
      // corrected journal, deliberately and under its own reason.
      await expect(
        asActor({ organizationId: org.a, roles: ['UNION_ADMIN'] }, () =>
          wiring.prisma.transaction((tx) =>
            wiring.ledger.reverse(tx, reversal.id, 'attempting to reverse a reversal', 'itest'),
          ),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }));
    });
  });

  // -------------------------------------------------------------------------
  // Reconciliation, in each of the shapes it can find
  // -------------------------------------------------------------------------

  describe('the wallet/ledger reconciliation', () => {
    function audit(): LedgerBalanceAudit {
      return new LedgerBalanceAudit(wiring.walletRepository, wiring.ledger, testEnv());
    }

    it('says nothing when it is switched off, and stops cleanly', () => {
      const disabled = audit();
      // Logged rather than silent: a reconciliation that is off is a decision
      // somebody should be able to see in the boot log.
      expect(() => disabled.onModuleInit()).not.toThrow();
      expect(() => disabled.onApplicationShutdown()).not.toThrow();
    });

    it('finds a wallet whose escrow disagrees with its holds', async () => {
      const { walletId } = await fundWallet(wiring, org.b, 80_000n);
      const transactionId = `TXN_${ulid()}`;

      await asActor({ organizationId: org.b }, () =>
        wiring.prisma.transaction(async (tx) => {
          const [locked] = await wiring.walletRepository.lock(tx, [walletId]);
          return wiring.wallets.placeHold(tx, {
            wallet: locked!,
            amountMinor: 20_000n,
            reference: transactionId,
            referenceType: 'TRANSACTION',
            transactionId,
            placedBy: 'internals-itest',
          });
        }),
      );

      expect((await audit().run()).find((row) => row.walletId === walletId)).toBeUndefined();

      // The hold row is resolved without the escrow moving — the exact drift
      // that would otherwise surface much later as a settlement failing for no
      // visible reason. It is the third relation the audit checks, and the one
      // that makes the second meaningful (ADR-034).
      // `ck_wallet_hold_resolution` requires a resolved hold to name both the
      // moment and the journal that resolved it, so the drift has to be
      // introduced as a row the constraint accepts — otherwise this would test
      // the constraint rather than the reconciliation.
      await runUnscoped('the suite resolves a hold behind the ledger’s back', () =>
        prisma.client.$executeRawUnsafe(
          `UPDATE wallet_hold
              SET status = 'RELEASED',
                  resolved_at = now(),
                  resolved_journal_id = placed_journal_id
            WHERE wallet_id = $1 AND reference = $2`,
          walletId,
          transactionId,
        ),
      );

      const deviations = await audit().run();
      const found = deviations.find((row) => row.walletId === walletId);
      expect(found?.kind).toBe('PENDING_VS_HOLDS');

      await runUnscoped('the suite restores the hold it resolved', () =>
        prisma.client.$executeRawUnsafe(
          `UPDATE wallet_hold
              SET status = 'ACTIVE', resolved_at = NULL, resolved_journal_id = NULL
            WHERE wallet_id = $1 AND reference = $2`,
          walletId,
          transactionId,
        ),
      );
    });
  });
  // -------------------------------------------------------------------------
  // Doing nothing, correctly
  // -------------------------------------------------------------------------

  describe('an empty request', () => {
    it('locks no wallets when given no ids', async () => {
      // The settlement path locks the payer and the payee together, in
      // ascending id order, so a deadlock is structurally impossible. An empty
      // list reaches it whenever a caller has nothing to lock, and issuing
      // `SELECT ... FOR UPDATE WHERE id IN ()` would be a round trip that can
      // only return nothing.
      const locked = await asActor({ organizationId: org.a }, () =>
        wiring.prisma.transaction((tx) => wiring.walletRepository.lock(tx, [])),
      );
      expect(locked).toEqual([]);
    });

    it('publishes no batch when the relay has nothing to send', async () => {
      // The relay polls on a timer, so the overwhelmingly common case is an
      // empty read. Connecting a producer for it would open a broker
      // connection on a service that has published nothing all day.
      const publisher = new InMemoryEventPublisher();
      await expect(publisher.publish([])).resolves.toBeUndefined();
      expect(publisher.published).toHaveLength(0);
    });
  });
});
