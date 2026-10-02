import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { eventEnvelopeSchema } from '@rasta/contracts';
import { RastaError, runUnscoped, runWithContext } from '@rasta/nest-common';
import { PrismaClient } from '../src/generated/prisma';
import {
  bidOpeningConflictChecksTotal,
  bidOpeningRefusalsTotal,
} from '../src/observability/metrics';
import {
  EnvKekProvider,
  type KeyContext,
  type WrappedKey,
} from '../src/tender/sealing/key-provider';
import {
  genesisReceipt,
  nextReceipt,
  sealBid,
  type SealedBid,
} from '../src/tender/sealing/sealing';
import {
  asAdmin,
  asBidder,
  asUser,
  bidContent,
  cleanup,
  context,
  loadStanding,
  newOrganizationId,
  newUserId,
  outboxFor,
  ownerDatabaseUrl,
  publishedForBids,
  qualify,
  testEnv,
  untilASessionWaitsOnALock,
  wire,
  type Wiring,
} from './helpers';

/**
 * Opening a tender's bids and the owner's reads of them, against PostgreSQL
 * (ADR-065 § 1, ADR-066 § 2-5): only after CLOSED on the database clock after the lock;
 * the chain and head from audit-service (a stand-in here, proven against the real
 * projection and the real client elsewhere) and never from this service's own tables;
 * every bid opened against those receipts; every read audited; the key unwrapped only in
 * memory, for the call that needs it.
 */

const PRICES = ['1111', '2222', '3333'];
const MARKERS = ['Fixed price, materials included', 'Licence 1234, valid'];

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

const payloadOf = (row: { payload: unknown }) => eventEnvelopeSchema.parse(row.payload).payload;

describe('opening the bids of a tender', () => {
  let w: Wiring;
  const organizations: string[] = [];
  let unwrap: jest.SpyInstance;

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  const sql = (reason: string, statement: string) =>
    runUnscoped(reason, () => w.prisma.client.$executeRawUnsafe(statement));

  const rowOf = (tenderId: string) =>
    runUnscoped('the suite reads the tender it made', () =>
      w.prisma.client.tender.findFirstOrThrow({ where: { id: tenderId } }),
    );

  const bidRows = (tenderId: string) =>
    runUnscoped('the suite reads the bids', () =>
      w.prisma.client.bid.findMany({ where: { tenderId }, orderBy: { id: 'asc' } }),
    );

  const logOf = (tenderId: string) =>
    runUnscoped('the suite reads the access log', () =>
      w.prisma.client.bidAccessLog.findMany({ where: { tenderId }, orderBy: { id: 'asc' } }),
    );

  const eventsOf = async (owner: string, name: string, tenderId?: string) =>
    (await outboxFor(w.prisma, owner)).filter(
      (row) => row.eventName === name && (tenderId === undefined || row.aggregateId === tenderId),
    );

  /** A CLOSED tender with `prices.length` standing bids, and the owner who holds it. */
  const closedTender = async (prices: string[] = PRICES.slice(0, 2)) => {
    const owner = org();
    const bidders: string[] = [];
    for (let i = 0; i < prices.length; i += 1) {
      const bidder = org();
      await qualify(w, bidder);
      bidders.push(bidder);
    }
    const { tenderId, keyId } = await publishedForBids(w, owner);
    for (const [i, bidder] of bidders.entries()) {
      await asBidder(bidder, () => w.bids.submit(tenderId, { content: bidContent(prices[i]) }));
    }
    await makeOverdue(tenderId);
    await w.tenderClose.close({ organizationId: owner, tenderId });
    expect((await rowOf(tenderId)).status).toBe('CLOSED');
    return { owner, bidders, tenderId, keyId };
  };

  const makeOverdue = (tenderId: string) =>
    sql(
      'the suite lets the deadline pass',
      `UPDATE "tender" SET "bid_opening_at" = now() - interval '2 hours',
         "bid_closing_at" = now() - interval '1 minute' WHERE "id" = '${tenderId}'`,
    );

  const open = (owner: string, tenderId: string) =>
    asAdmin(owner, () => w.tenderOpen.open(tenderId));

  const codeOf = async (call: Promise<unknown>): Promise<{ code?: string; message?: string }> =>
    ((await call.then(
      () => undefined,
      (e: unknown) => e,
    )) ?? {}) as { code?: string; message?: string };

  /** The refusal's closed reason, from the 422's message. */
  const refusalOf = async (call: Promise<unknown>): Promise<string> => {
    const error = await codeOf(call);
    expect(error.code).toBe('BUSINESS_RULE_VIOLATION');
    return error.message ?? '';
  };

  /** Nothing was opened: the tender is as it was, its bids are SUBMITTED, no BIDS_OPENED left. */
  const expectNothingOpened = async (owner: string, tenderId: string) => {
    expect(await rowOf(tenderId)).toMatchObject({
      status: 'CLOSED',
      openedAt: null,
      openedBy: null,
    });
    for (const bid of await bidRows(tenderId)) expect(bid.status).toBe('SUBMITTED');
    expect(await eventsOf(owner, 'BIDS_OPENED', tenderId)).toHaveLength(0);
  };

  /** Changes what the database owner can change and the application role cannot: the triggers lifted. */
  const asDatabaseOwner = async (work: (tx: PrismaClient) => Promise<void>) => {
    const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    try {
      await owner.$transaction(async (tx) => {
        for (const [table, trigger] of [
          ['bid', 'tg_bid_guard'],
          ['bid_receipt', 'tg_bid_receipt_append_only'],
        ] as const) {
          await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
        }
        await work(tx as unknown as PrismaClient);
        for (const [table, trigger] of [
          ['bid', 'tg_bid_guard'],
          ['bid_receipt', 'tg_bid_receipt_append_only'],
        ] as const) {
          await tx.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
        }
      });
    } finally {
      await owner.$disconnect();
    }
  };

  /** Another content sealed to the tender's own public key, as an operator could make it. */
  const forgeFor = async (
    tenderId: string,
    keyId: string,
    bid: { id: string; bidderOrganizationId: string; revision: number },
  ) => {
    const key = await runUnscoped('the suite reads the tender key', () =>
      w.prisma.client.tenderKey.findFirstOrThrow({ where: { tenderId } }),
    );
    return sealBid({
      publicKeyPem: key.publicKeyPem,
      binding: {
        tenderId,
        bidId: bid.id,
        bidderOrganizationId: bid.bidderOrganizationId,
        revision: bid.revision,
        keyId,
      },
      content: { priceMinor: '1' },
    });
  };

  const replaceBid = (tx: PrismaClient, bidId: string, forged: SealedBid) =>
    tx.bid.update({
      where: { id: bidId },
      data: {
        nonce: new Uint8Array(forged.nonce),
        ciphertext: new Uint8Array(forged.ciphertext),
        tag: new Uint8Array(forged.tag),
        wrappedContentKey: new Uint8Array(forged.wrappedContentKey),
        contentCommitment: forged.contentCommitment,
        ciphertextSha256: forged.ciphertextSha256,
      },
    });

  beforeAll(async () => {
    // One person opens: the four-eyes rule (Q-91) has its own describe, below.
    w = wire(testEnv({ CONSTRUCTION_TENDER_OPEN_FOUR_EYES: 'false' }));
    await loadStanding(w);
  });

  beforeEach(() => {
    unwrap = jest.spyOn(w.keys, 'unwrap');
  });

  afterEach(() => {
    unwrap.mockRestore();
    w.clock.fixed = undefined;
    w.clock.onDecision = undefined;
    w.evidence.failure = undefined;
    w.evidence.afterRead = undefined;
    w.evidence.served.clear();
    w.evidence.asked.length = 0;
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  // ---------------------------------------------------------------------------------------------

  describe('opening', () => {
    it('opens a CLOSED tender: every standing bid OPENED, the tender EVALUATING, one BIDS_OPENED with a count and a digest of the ids only', async () => {
      const { owner, bidders, tenderId } = await closedTender();
      const before = await rowOf(tenderId);
      const chain = await w.evidence.fetchChain(owner, tenderId);
      w.evidence.asked.length = 0;

      const view = await open(owner, tenderId);

      const row = await rowOf(tenderId);
      expect(view).toMatchObject({
        tenderId,
        status: 'EVALUATING',
        bidCount: 2,
        alreadyOpened: false,
        openedAt: row.openedAt!.toISOString(),
      });
      expect(row).toMatchObject({ status: 'EVALUATING', version: before.version + 1 });
      expect(row.openedBy).toBe(view.openedBy);
      expect(row.openedAt!.getTime()).toBeGreaterThanOrEqual(row.closedAt!.getTime());
      expect(row.statusChangedAt).toEqual(row.openedAt);
      const bids = await bidRows(tenderId);
      expect(bids.map((bid) => bid.status)).toEqual(['OPENED', 'OPENED']);
      expect(bids.map((bid) => bid.bidderOrganizationId).sort()).toEqual([...bidders].sort());

      // The head came from the evidence, asked for the tender owner's organization.
      expect(w.evidence.asked).toEqual([{ organizationId: owner, tenderId }]);

      const [event, ...rest] = await eventsOf(owner, 'BIDS_OPENED', tenderId);
      expect(rest).toHaveLength(0);
      expect(event).toMatchObject({
        aggregateType: 'Tender',
        aggregateId: tenderId,
        partitionKey: tenderId,
      });
      expect(payloadOf(event!)).toEqual({
        tenderId,
        projectId: before.projectId,
        organizationId: owner,
        bidCount: 2,
        bidIdsDigest: createHash('sha256')
          .update(
            bids
              .map((bid) => bid.id)
              .sort()
              .join('\n'),
          )
          .digest('hex'),
        receiptHead: chain.head,
        openedAt: row.openedAt!.toISOString(),
        openedBy: view.openedBy,
        proposedBy: null,
      });
    });

    it('audits every opening: one granted OPEN_BIDS row and one BID_ACCESSED per bid, and no content anywhere', async () => {
      const { owner, tenderId } = await closedTender();
      const view = await open(owner, tenderId);

      const rows = await logOf(tenderId);
      const bids = await bidRows(tenderId);
      expect(rows).toHaveLength(2);
      for (const bid of bids) {
        expect(rows.find((row) => row.bidId === bid.id)).toMatchObject({
          organizationId: owner,
          accessorOrganizationId: owner,
          accessorUserId: view.openedBy,
          purpose: 'OPEN_BIDS',
          outcome: 'GRANTED',
        });
      }
      const accessed = await eventsOf(owner, 'BID_ACCESSED', tenderId);
      expect(accessed.map((event) => payloadOf(event))).toEqual(
        expect.arrayContaining(
          bids.map((bid) =>
            expect.objectContaining({ bidId: bid.id, purpose: 'OPEN_BIDS', outcome: 'GRANTED' }),
          ),
        ),
      );
      // The content never reaches an event or the log, and the key never does either.
      const everything = JSON.stringify(
        [await outboxFor(w.prisma, owner), rows],
        (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      );
      for (const marker of [...MARKERS, ...PRICES]) expect(everything).not.toContain(marker);
      expect(everything).not.toMatch(/PRIVATE KEY|wrappedPrivateKey/i);
    });

    it('unwraps the tender key only for the opening and zeroises what it unwrapped', async () => {
      const { owner, tenderId } = await closedTender();
      const handedOut: Buffer[] = [];
      const original = EnvKekProvider.prototype.unwrap;
      unwrap.mockImplementation((wrapped: WrappedKey, keyContext: KeyContext) => {
        const der = original.call(w.keys, wrapped, keyContext);
        handedOut.push(der);
        return der;
      });

      await open(owner, tenderId);

      expect(unwrap).toHaveBeenCalledTimes(1);
      expect(handedOut).toHaveLength(1);
      expect(handedOut[0]!.length).toBeGreaterThan(0);
      expect(handedOut[0]!.every((byte) => byte === 0)).toBe(true);
    });

    it('opens a tender that had no bids, and never touches the key for it', async () => {
      const { owner, tenderId } = await closedTender([]);

      const view = await open(owner, tenderId);

      expect(view).toMatchObject({ status: 'EVALUATING', bidCount: 0, alreadyOpened: false });
      expect(unwrap).not.toHaveBeenCalled();
      expect(await eventsOf(owner, 'BIDS_OPENED', tenderId)).toHaveLength(1);
      // No bid was opened, and the opening is on the record all the same: a tender-level row.
      expect(await logOf(tenderId)).toEqual([
        expect.objectContaining({ purpose: 'OPEN_BIDS', outcome: 'GRANTED', bidId: null }),
      ]);
      expect(
        (await eventsOf(owner, 'BID_ACCESSED', tenderId)).map((event) => payloadOf(event)),
      ).toEqual([
        expect.objectContaining({ purpose: 'OPEN_BIDS', outcome: 'GRANTED', bidId: null }),
      ]);
    });

    it('leaves a withdrawn bid withdrawn, and opens the rest', async () => {
      const owner = org();
      const [keeps, leaves] = [org(), org()];
      await qualify(w, keeps);
      await qualify(w, leaves);
      const { tenderId } = await publishedForBids(w, owner);
      await asBidder(keeps, () => w.bids.submit(tenderId, { content: bidContent('1111') }));
      const second = await asBidder(leaves, () =>
        w.bids.submit(tenderId, { content: bidContent('2222') }),
      );
      await asBidder(leaves, () =>
        w.bids.withdraw(tenderId, second.bidId, { expectedRevision: 1 }),
      );
      await makeOverdue(tenderId);
      await w.tenderClose.close({ organizationId: owner, tenderId });

      const view = await open(owner, tenderId);

      expect(view.bidCount).toBe(1);
      const statuses = Object.fromEntries(
        (await bidRows(tenderId)).map((b) => [b.bidderOrganizationId, b.status]),
      );
      expect(statuses).toEqual({ [keeps]: 'OPENED', [leaves]: 'WITHDRAWN' });
    });
  });

  describe('when it may happen', () => {
    it('refuses a tender that is still PUBLISHED, even one past its deadline whose sweeper has not run', async () => {
      const owner = org();
      const bidder = org();
      await qualify(w, bidder);
      const { tenderId } = await publishedForBids(w, owner);
      await asBidder(bidder, () => w.bids.submit(tenderId, { content: bidContent() }));
      await makeOverdue(tenderId);

      expect(await refusalOf(open(owner, tenderId))).toContain('NOT_CLOSED');

      expect(await rowOf(tenderId)).toMatchObject({ status: 'PUBLISHED', openedAt: null });
      expect((await bidRows(tenderId))[0]!.status).toBe('SUBMITTED');
      expect(w.evidence.asked).toHaveLength(0);
      expect(unwrap).not.toHaveBeenCalled();
      expect(await eventsOf(owner, 'BIDS_OPENED', tenderId)).toHaveLength(0);
      // The refusal is itself on the record.
      expect(await logOf(tenderId)).toEqual([
        expect.objectContaining({
          purpose: 'OPEN_BIDS',
          outcome: 'REFUSED',
          bidId: null,
          accessorOrganizationId: owner,
        }),
      ]);
    });

    it('judges the instant on the clock read after the lock: a decision before the close is refused', async () => {
      const { owner, tenderId } = await closedTender();
      const row = await rowOf(tenderId);
      w.clock.fixed = new Date(row.bidClosingAt!.getTime() - 1000);

      expect(await refusalOf(open(owner, tenderId))).toContain('NOT_CLOSED');

      await expectNothingOpened(owner, tenderId);
      expect(unwrap).not.toHaveBeenCalled();
    });

    it('refuses a cancelled tender, one that cancelled while the opening waited for the lock, and nothing is opened', async () => {
      const { owner, tenderId } = await closedTender();
      const holding = deferred();
      const release = deferred();
      const holder = asAdmin(owner, () =>
        w.prisma.transaction(async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "tender" WHERE "id" = ${tenderId} FOR UPDATE`;
          holding.resolve();
          await release.promise;
          await tx.$executeRawUnsafe(
            `UPDATE "tender" SET "status" = 'CANCELLED', "status_reason" = 'withdrawn by the owner',
               "status_reason_code" = 'OWNER_REQUEST', "version" = "version" + 1 WHERE "id" = '${tenderId}'`,
          );
        }),
      );
      await holding.promise;

      const opening = refusalOf(open(owner, tenderId));
      await untilASessionWaitsOnALock(w.prisma);
      release.resolve();
      await holder;

      expect(await opening).toContain('NOT_CLOSED');
      expect(await rowOf(tenderId)).toMatchObject({ status: 'CANCELLED', openedAt: null });
      expect(await eventsOf(owner, 'BIDS_OPENED', tenderId)).toHaveLength(0);
      for (const bid of await bidRows(tenderId)) expect(bid.status).toBe('SUBMITTED');
    });
  });

  describe('idempotent', () => {
    it('answers the same view a second time, writing and publishing nothing', async () => {
      const { owner, tenderId } = await closedTender();
      const first = await open(owner, tenderId);
      const rowAfter = await rowOf(tenderId);
      const logAfter = await logOf(tenderId);
      w.evidence.asked.length = 0;
      unwrap.mockClear();

      const second = await open(owner, tenderId);

      expect(second).toEqual({ ...first, alreadyOpened: true });
      expect(await rowOf(tenderId)).toEqual(rowAfter);
      expect(await logOf(tenderId)).toEqual(logAfter);
      expect(await eventsOf(owner, 'BIDS_OPENED', tenderId)).toHaveLength(1);
      expect(w.evidence.asked).toHaveLength(0);
      expect(unwrap).not.toHaveBeenCalled();
    });

    it('two callers at once end with one opening and one event', async () => {
      const { owner, tenderId } = await closedTender();
      const held = deferred();
      const release = deferred();
      // The first to reach its decision (after the lock) is held; the second queues behind it.
      w.clock.onDecision = async () => {
        held.resolve();
        await release.promise;
      };
      const first = open(owner, tenderId);
      await held.promise;
      const second = open(owner, tenderId);
      await untilASessionWaitsOnALock(w.prisma);
      release.resolve();

      const views = await Promise.all([first, second]);

      expect(views.map((view) => view.alreadyOpened).sort()).toEqual([false, true]);
      expect(views[0].openedAt).toBe(views[1].openedAt);
      expect(await eventsOf(owner, 'BIDS_OPENED', tenderId)).toHaveLength(1);
      expect(await logOf(tenderId)).toHaveLength(2);
    });
  });

  describe('the close sweeper', () => {
    it('does nothing to a tender that was opened, and a stale claim does not close it again', async () => {
      const owner = org();
      const bidder = org();
      await qualify(w, bidder);
      const { tenderId } = await publishedForBids(w, owner);
      await asBidder(bidder, () => w.bids.submit(tenderId, { content: bidContent() }));
      await makeOverdue(tenderId);
      const claimed = (await w.tenderCloses.claimDue(500, 600, 'fence-a')).find(
        (c) => c.id === tenderId,
      )!;
      await sql(
        'the suite gives back the claims it did not mean to take',
        `UPDATE "tender" SET "close_lease_until" = NULL, "close_fence" = NULL WHERE "close_fence" = 'fence-a' AND "id" <> '${tenderId}'`,
      );
      expect(claimed).toBeDefined();
      // Closed by hand while the sweeper holds the claim, then opened.
      expect(await w.tenderClose.close({ organizationId: owner, tenderId })).toBe('CLOSED');
      await open(owner, tenderId);

      expect(
        await w.tenderClose.close({ organizationId: owner, tenderId, fence: claimed.fence }),
      ).toBe('NOT_OWNER');
      await w.tenderCloseSweeper.runOnce();

      expect(await rowOf(tenderId)).toMatchObject({ status: 'EVALUATING' });
      expect(await eventsOf(owner, 'TENDER_CLOSED', tenderId)).toHaveLength(1);
      expect(await eventsOf(owner, 'BIDS_OPENED', tenderId)).toHaveLength(1);
    });

    it('a close queued behind the opening waits for it, then finds nothing to do', async () => {
      const { owner, tenderId } = await closedTender();
      const held = deferred();
      const release = deferred();
      w.clock.onDecision = async () => {
        held.resolve();
        await release.promise;
      };
      const opening = open(owner, tenderId);
      await held.promise;

      const closing = w.tenderClose.close({ organizationId: owner, tenderId });
      await untilASessionWaitsOnALock(w.prisma);
      release.resolve();

      expect((await opening).alreadyOpened).toBe(false);
      expect(await closing).toBe('NOOP');
      expect(await rowOf(tenderId)).toMatchObject({ status: 'EVALUATING' });
      expect(await eventsOf(owner, 'TENDER_CLOSED', tenderId)).toHaveLength(1);
    });

    it('opening and the sweeper racing on overdue tenders: either order, one close, at most one opening, never a torn state', async () => {
      const made: { owner: string; tenderId: string }[] = [];
      for (let i = 0; i < 4; i += 1) {
        const owner = org();
        const bidder = org();
        await qualify(w, bidder);
        const { tenderId } = await publishedForBids(w, owner);
        await asBidder(bidder, () => w.bids.submit(tenderId, { content: bidContent() }));
        await makeOverdue(tenderId);
        made.push({ owner, tenderId });
      }

      const outcomes = await Promise.all([
        w.tenderCloseSweeper.runOnce(),
        ...made.map(({ owner, tenderId }) => codeOf(open(owner, tenderId))),
      ]);
      void outcomes;
      await w.tenderCloseSweeper.runOnce();

      for (const { owner, tenderId } of made) {
        const row = await rowOf(tenderId);
        // Closed by the sweeper; opened only if the opening came after the close.
        expect(['CLOSED', 'EVALUATING']).toContain(row.status);
        expect(await eventsOf(owner, 'TENDER_CLOSED', tenderId)).toHaveLength(1);
        const opened = await eventsOf(owner, 'BIDS_OPENED', tenderId);
        expect(opened).toHaveLength(row.status === 'EVALUATING' ? 1 : 0);
        const bids = await bidRows(tenderId);
        expect(
          bids.every(
            (bid) => bid.status === (row.status === 'EVALUATING' ? 'OPENED' : 'SUBMITTED'),
          ),
        ).toBe(true);
      }
    });
  });

  describe('the head is audit-service’s, not ours', () => {
    it('refuses, and opens nothing, when audit-service cannot be reached (503/504, no fallback to the local chain)', async () => {
      const { owner, tenderId } = await closedTender();

      w.evidence.failure = RastaError.upstreamUnavailable('audit-service');
      expect(await codeOf(open(owner, tenderId))).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
      w.evidence.failure = RastaError.upstreamTimeout('audit-service', 1);
      expect(await codeOf(open(owner, tenderId))).toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
      w.evidence.failure = new Error('connect ECONNREFUSED');
      expect(await codeOf(open(owner, tenderId))).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });

      await expectNothingOpened(owner, tenderId);
      expect(unwrap).not.toHaveBeenCalled();
      const refused = (await logOf(tenderId)).filter((row) => row.outcome === 'REFUSED');
      expect(refused).toHaveLength(3);
    });

    it('refuses a forged head: a chain that does not end at its own newest link, or does not start at this tender’s genesis', async () => {
      const { owner, tenderId } = await closedTender();
      const honest = await w.evidence.fetchChain(owner, tenderId);

      w.evidence.served.set(tenderId, { ...honest, head: 'f'.repeat(64) });
      expect(await refusalOf(open(owner, tenderId))).toContain('INTEGRITY');
      w.evidence.served.set(tenderId, { ...honest, genesis: 'e'.repeat(64) });
      expect(await refusalOf(open(owner, tenderId))).toContain('INTEGRITY');

      await expectNothingOpened(owner, tenderId);
      expect(unwrap).not.toHaveBeenCalled();
    });

    it('refuses a head that a consistent local forgery agrees with but audit-service never announced', async () => {
      const { owner, bidders, tenderId, keyId } = await closedTender();
      const honest = await w.evidence.fetchChain(owner, tenderId);
      const target = (await bidRows(tenderId))[0]!;
      const forged = await forgeFor(tenderId, keyId, target);

      // The operator replaces one bid and rewrites the receipt chain so it verifies on its own.
      await asDatabaseOwner(async (tx) => {
        const links = await tx.bidReceipt.findMany({
          where: { tenderId },
          orderBy: { seq: 'asc' },
        });
        let previous = genesisReceipt(tenderId);
        for (const link of links) {
          const replaced = link.bidId === target.id;
          const next = {
            ciphertextSha256: replaced ? forged.ciphertextSha256 : link.ciphertextSha256,
            contentCommitment: replaced ? forged.contentCommitment : link.contentCommitment,
          };
          const receipt = nextReceipt(tenderId, previous, {
            bidId: link.bidId,
            revision: link.revision,
            receivedAt: link.receivedAt,
            ...next,
          });
          await tx.bidReceipt.update({
            where: {
              organizationId_tenderId_seq: {
                organizationId: link.organizationId,
                tenderId,
                seq: link.seq,
              },
            },
            data: { ...next, previousReceipt: previous, receipt },
          });
          previous = receipt;
        }
        await replaceBid(tx, target.id, forged);
      });
      expect(bidders).toHaveLength(2);

      // audit-service still holds what was announced.
      expect(await refusalOf(open(owner, tenderId))).toContain('INTEGRITY');

      await expectNothingOpened(owner, tenderId);
      expect(unwrap).not.toHaveBeenCalled();
      expect((await w.evidence.fetchChain(owner, tenderId)).head).toBe(honest.head);
    });

    it('refuses a substituted bid even when its stored digest and commitment were rewritten to match', async () => {
      const { owner, tenderId, keyId } = await closedTender();
      const target = (await bidRows(tenderId))[1]!;
      const forged = await forgeFor(tenderId, keyId, target);
      await asDatabaseOwner(async (tx) => {
        await replaceBid(tx, target.id, forged);
      });

      expect(await refusalOf(open(owner, tenderId))).toContain('INTEGRITY');

      await expectNothingOpened(owner, tenderId);
    });

    it('refuses a tampered ciphertext', async () => {
      const { owner, tenderId } = await closedTender();
      const target = (await bidRows(tenderId))[0]!;
      await asDatabaseOwner(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE "bid" SET "ciphertext" = set_byte("ciphertext", 0, get_byte("ciphertext", 0) # 255) WHERE "id" = '${target.id}'`,
        );
      });

      expect(await refusalOf(open(owner, tenderId))).toContain('INTEGRITY');

      await expectNothingOpened(owner, tenderId);
    });

    it('refuses a locally rewritten head and a bid row added behind the chain', async () => {
      const { owner, tenderId } = await closedTender();
      const links = await runUnscoped('the suite reads the chain', () =>
        w.prisma.client.bidReceipt.findMany({ where: { tenderId }, orderBy: { seq: 'asc' } }),
      );
      await asDatabaseOwner(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE "bid_receipt" SET "receipt" = '${'a'.repeat(64)}' WHERE "tender_id" = '${tenderId}' AND "seq" = ${links[links.length - 1]!.seq}`,
        );
      });

      expect(await refusalOf(open(owner, tenderId))).toContain('INTEGRITY');

      await expectNothingOpened(owner, tenderId);
    });

    it('refuses audit-service being behind (a retry later), and a chain with a link the local copy does not have', async () => {
      const { owner, tenderId } = await closedTender();
      const honest = await w.evidence.fetchChain(owner, tenderId);

      // Behind: audit-service has only the first receipt. Not a forgery, and not ready either.
      const [first] = honest.links;
      w.evidence.served.set(tenderId, { ...honest, head: first!.receipt, links: [first!] });
      expect(await codeOf(open(owner, tenderId))).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });

      // Ahead: audit-service holds a receipt this service has no bid for.
      const extra = {
        seq: 3,
        bidId: 'BID_01HZZZZZZZZZZZZZZZZZZZZZZZ',
        revision: 1,
        receivedAt: new Date().toISOString(),
        ciphertextSha256: 'b'.repeat(64),
        contentCommitment: 'c'.repeat(64),
        previousReceipt: honest.head,
        receipt: nextReceipt(tenderId, honest.head, {
          bidId: 'BID_01HZZZZZZZZZZZZZZZZZZZZZZZ',
          revision: 1,
          receivedAt: new Date(),
          ciphertextSha256: 'b'.repeat(64),
          contentCommitment: 'c'.repeat(64),
        }),
      };
      extra.receivedAt = new Date().toISOString();
      w.evidence.served.set(tenderId, {
        ...honest,
        links: [...honest.links, extra],
        head: extra.receipt,
      });
      expect(await refusalOf(open(owner, tenderId))).toContain('INTEGRITY');

      await expectNothingOpened(owner, tenderId);
      expect(unwrap).not.toHaveBeenCalled();
    });

    it('writes a REFUSED row for each refusal, with no bid named and nothing of the content', async () => {
      const { owner, tenderId } = await closedTender();
      w.evidence.failure = new Error('connect ECONNREFUSED');
      await codeOf(open(owner, tenderId));

      const rows = await logOf(tenderId);
      expect(rows).toEqual([
        expect.objectContaining({
          purpose: 'OPEN_BIDS',
          outcome: 'REFUSED',
          bidId: null,
          accessorOrganizationId: owner,
        }),
      ]);
      const events = await eventsOf(owner, 'BID_ACCESSED', tenderId);
      expect(events.map((event) => payloadOf(event))).toEqual([
        expect.objectContaining({ purpose: 'OPEN_BIDS', outcome: 'REFUSED', bidId: null }),
      ]);
    });
  });

  describe('who may open', () => {
    it('refuses the bidder role, the platform administrator, the oversight role and a service token', async () => {
      const { owner, tenderId } = await closedTender();

      for (const roles of [
        ['CONTRACTOR'],
        ['SYSTEM_ADMIN'],
        ['AUDITOR'],
        ['UNION_ADMIN'],
        // Refused whenever present: the owner's own role does not make them harmless.
        ['SYSTEM_ADMIN', 'ORGANIZATION_ADMIN'],
        ['CONTRACTOR', 'ORGANIZATION_ADMIN'],
        ['AUDITOR', 'ORGANIZATION_ADMIN'],
      ]) {
        expect(await codeOf(asUser(owner, roles, () => w.tenderOpen.open(tenderId)))).toMatchObject(
          {
            code: expect.stringMatching(/FORBIDDEN|INSUFFICIENT_ROLE/),
          },
        );
      }
      const service = runWithContext(
        context({
          organizationId: owner,
          organizationIds: [owner],
          userId: newUserId(),
          roles: ['ORGANIZATION_ADMIN'],
          authType: 'SERVICE',
        }),
        () => w.tenderOpen.open(tenderId),
      );
      expect(await codeOf(service)).toMatchObject({ code: 'FORBIDDEN' });

      await expectNothingOpened(owner, tenderId);
      expect(unwrap).not.toHaveBeenCalled();
    });

    it('refuses a member of an organization that bid on the tender (ADR-067 § 4), whatever role they hold', async () => {
      const { owner, bidders, tenderId } = await closedTender();

      const conflicted = runWithContext(
        context({
          organizationId: owner,
          organizationIds: [owner, bidders[0]!],
          userId: newUserId(),
          roles: ['ORGANIZATION_ADMIN'],
        }),
        () => w.tenderOpen.open(tenderId),
      );

      expect(await codeOf(conflicted)).toMatchObject({ code: 'FORBIDDEN' });
      await expectNothingOpened(owner, tenderId);
      expect(unwrap).not.toHaveBeenCalled();
      expect((await logOf(tenderId)).map((row) => row.outcome)).toEqual(['REFUSED']);
    });

    it('refuses that member on every owner route, before and after the opening, before any answer about the bids', async () => {
      const { owner, bidders, tenderId } = await closedTender();
      const asMember = <T>(fn: () => T) =>
        runWithContext(
          context({
            organizationId: owner,
            organizationIds: [owner, bidders[0]!],
            userId: newUserId(),
            roles: ['ORGANIZATION_ADMIN'],
          }),
          fn,
        );
      const granted = async () =>
        (await logOf(tenderId)).filter((row) => row.outcome === 'GRANTED').length;
      const [bid] = await bidRows(tenderId);

      // Before the opening: not the opening, the proposal, the counts and receipt times, nor the log.
      const beforeCalls: (() => Promise<unknown>)[] = [
        () => w.tenderOpen.open(tenderId),
        () => w.tenderOpen.proposeOpening(tenderId),
        () => w.tenderOpen.listBids(tenderId),
        () => w.tenderOpen.listAccessLog(tenderId, { limit: 10 }),
      ];
      for (const call of beforeCalls) {
        expect(await codeOf(asMember(call))).toMatchObject({ code: 'FORBIDDEN' });
      }
      expect(await granted()).toBe(0);

      // After it: not the already-opened answer, the opened view, one bid's content, nor the log.
      await open(owner, tenderId);
      const grantedByOpening = await granted();
      const afterCalls: (() => Promise<unknown>)[] = [
        () => w.tenderOpen.open(tenderId),
        () => w.tenderOpen.listBids(tenderId),
        () => w.tenderOpen.getBid(tenderId, bid!.id),
        () => w.tenderOpen.listAccessLog(tenderId, { limit: 10 }),
      ];
      for (const call of afterCalls) {
        expect(await codeOf(asMember(call))).toMatchObject({ code: 'FORBIDDEN' });
      }
      expect(await granted()).toBe(grantedByOpening);
    });

    it('takes its roles from configuration, by default the owner role set', async () => {
      const configured = wire(
        testEnv({
          CONSTRUCTION_TENDER_OPEN_ROLES: 'PROCUREMENT_USER',
          CONSTRUCTION_TENDER_OPEN_FOUR_EYES: 'false',
        }),
      );
      try {
        const { owner, tenderId } = await closedTender();

        // The default role set is replaced, not added to.
        expect(
          await codeOf(asAdmin(owner, () => configured.tenderOpen.open(tenderId))),
        ).toMatchObject({
          code: 'INSUFFICIENT_ROLE',
        });
        await expectNothingOpened(owner, tenderId);

        const view = await asUser(owner, ['PROCUREMENT_USER'], () =>
          configured.tenderOpen.open(tenderId),
        );
        expect(view.status).toBe('EVALUATING');
      } finally {
        await configured.close();
      }
    });
  });

  describe('tenant isolation', () => {
    it('answers another organization 404 for every route, changes nothing, and tells the owner who asked', async () => {
      const { owner, tenderId } = await closedTender();
      const stranger = org();
      const asStranger = <T>(fn: () => T) => asAdmin(stranger, fn);

      const calls: (() => Promise<unknown>)[] = [
        () => w.tenderOpen.open(tenderId),
        () => w.tenderOpen.proposeOpening(tenderId),
        () => w.tenderOpen.listBids(tenderId),
        () => w.tenderOpen.getBid(tenderId, 'BID_X'),
        () => w.tenderOpen.listAccessLog(tenderId, { limit: 10 }),
      ];
      for (const call of calls) {
        expect(await codeOf(asStranger(call))).toMatchObject({ code: 'NOT_FOUND' });
      }

      await expectNothingOpened(owner, tenderId);
      expect(w.evidence.asked).toHaveLength(0);
      expect(unwrap).not.toHaveBeenCalled();
      // The tender owner's log shows the strangers' attempts, never the strangers' own.
      const rows = await logOf(tenderId);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).toMatchObject({
          organizationId: owner,
          accessorOrganizationId: stranger,
          outcome: 'REFUSED',
        });
      }
      expect(
        await codeOf(asStranger(() => w.tenderOpen.listAccessLog(tenderId, { limit: 10 }))),
      ).toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('answers an unknown tender 404 and logs nothing', async () => {
      const owner = org();
      expect(await codeOf(open(owner, 'TND_DOES_NOT_EXIST'))).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('never asks audit-service under any organization but the tender owner’s', async () => {
      const { owner, tenderId } = await closedTender();
      await open(owner, tenderId);
      await asAdmin(owner, () => w.tenderOpen.listBids(tenderId));

      expect(w.evidence.asked.length).toBeGreaterThan(0);
      for (const asked of w.evidence.asked)
        expect(asked).toEqual({ organizationId: owner, tenderId });
    });
  });

  describe('reading the bids', () => {
    it('before the opening: how many and when — not who, not what — and the key is not touched', async () => {
      const { owner, bidders, tenderId } = await closedTender();

      const view = await asAdmin(owner, () => w.tenderOpen.listBids(tenderId));

      expect(view).toMatchObject({ tenderId, opened: false, bidCount: 2, bids: [] });
      expect(view.receivedAt).toHaveLength(2);
      const text = JSON.stringify(view);
      for (const bidder of bidders) expect(text).not.toContain(bidder);
      for (const marker of [...MARKERS, ...PRICES]) expect(text).not.toContain(marker);
      expect(unwrap).not.toHaveBeenCalled();
      expect(w.evidence.asked).toHaveLength(0);
      expect(await logOf(tenderId)).toEqual([
        expect.objectContaining({ purpose: 'COUNT_BIDS', outcome: 'GRANTED', bidId: null }),
      ]);
    });

    it('records a tender-level access (no bid named) when a read finds no bid to show', async () => {
      const { owner, tenderId } = await closedTender([]);
      await open(owner, tenderId);

      const view = await asAdmin(owner, () => w.tenderOpen.listBids(tenderId));

      expect(view).toMatchObject({ opened: true, bidCount: 0, bids: [] });
      expect((await logOf(tenderId)).filter((row) => row.purpose === 'LIST_BIDS')).toEqual([
        expect.objectContaining({ bidId: null, outcome: 'GRANTED', accessorOrganizationId: owner }),
      ]);
      const accessed = (await eventsOf(owner, 'BID_ACCESSED', tenderId)).map(
        (event) => payloadOf(event) as { purpose: string; bidId: string | null },
      );
      expect(accessed.filter((p) => p.purpose === 'LIST_BIDS')).toEqual([
        expect.objectContaining({ bidId: null }),
      ]);
      expect(unwrap).not.toHaveBeenCalled();
    });

    it('refuses to read one bid before the opening: 422, logged, and the key is not touched', async () => {
      const { owner, tenderId } = await closedTender();
      const [bid] = await bidRows(tenderId);

      expect(
        await refusalOf(asAdmin(owner, () => w.tenderOpen.getBid(tenderId, bid!.id))),
      ).toContain('NOT_OPENED');

      expect(unwrap).not.toHaveBeenCalled();
      expect((await logOf(tenderId)).map((row) => [row.purpose, row.outcome])).toEqual([
        ['READ_BID', 'REFUSED'],
      ]);
    });

    it('after the opening: each bid with its content, read from the sealed bytes, every read audited', async () => {
      const { owner, bidders, tenderId } = await closedTender();
      await open(owner, tenderId);
      unwrap.mockClear();

      const view = await asAdmin(owner, () => w.tenderOpen.listBids(tenderId));

      expect(view).toMatchObject({ opened: true, bidCount: 2 });
      expect(view.bids.map((bid) => bid.bidderOrganizationId).sort()).toEqual([...bidders].sort());
      expect(view.bids.map((bid) => bid.content.priceMinor).sort()).toEqual(['1111', '2222']);
      expect(view.bids.every((bid) => bid.status === 'OPENED')).toBe(true);
      expect(unwrap).toHaveBeenCalledTimes(1);

      const listed = (await logOf(tenderId)).filter((row) => row.purpose === 'LIST_BIDS');
      expect(listed.map((row) => row.bidId).sort()).toEqual(
        view.bids.map((bid) => bid.bidId).sort(),
      );

      const one = await asAdmin(owner, () => w.tenderOpen.getBid(tenderId, view.bids[0]!.bidId));
      expect(one).toEqual(view.bids[0]);
      expect((await logOf(tenderId)).filter((row) => row.purpose === 'READ_BID')).toEqual([
        expect.objectContaining({
          bidId: one.bidId,
          outcome: 'GRANTED',
          accessorUserId: expect.any(String),
        }),
      ]);
    });

    it('does not show a withdrawn bid, and answers 404 for a bid that is not of this tender', async () => {
      const owner = org();
      const [keeps, leaves] = [org(), org()];
      await qualify(w, keeps);
      await qualify(w, leaves);
      const { tenderId } = await publishedForBids(w, owner);
      await asBidder(keeps, () => w.bids.submit(tenderId, { content: bidContent('1111') }));
      const second = await asBidder(leaves, () =>
        w.bids.submit(tenderId, { content: bidContent('2222') }),
      );
      await asBidder(leaves, () =>
        w.bids.withdraw(tenderId, second.bidId, { expectedRevision: 1 }),
      );
      await makeOverdue(tenderId);
      await w.tenderClose.close({ organizationId: owner, tenderId });
      await open(owner, tenderId);

      const view = await asAdmin(owner, () => w.tenderOpen.listBids(tenderId));
      expect(view.bids.map((bid) => bid.content.priceMinor)).toEqual(['1111']);
      expect(
        await codeOf(asAdmin(owner, () => w.tenderOpen.getBid(tenderId, second.bidId))),
      ).toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('refuses a read, and logs it, when audit-service is down or a bid no longer matches its receipt', async () => {
      const { owner, tenderId } = await closedTender();
      await open(owner, tenderId);
      const logged = (await logOf(tenderId)).length;

      w.evidence.failure = new Error('connect ECONNREFUSED');
      expect(await codeOf(asAdmin(owner, () => w.tenderOpen.listBids(tenderId)))).toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
      w.evidence.failure = undefined;

      const target = (await bidRows(tenderId))[0]!;
      await asDatabaseOwner(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE "bid" SET "tag" = set_byte("tag", 0, get_byte("tag", 0) # 255) WHERE "id" = '${target.id}'`,
        );
      });
      expect(await refusalOf(asAdmin(owner, () => w.tenderOpen.listBids(tenderId)))).toContain(
        'INTEGRITY',
      );
      expect(
        await refusalOf(asAdmin(owner, () => w.tenderOpen.getBid(tenderId, target.id))),
      ).toContain('INTEGRITY');

      const rows = (await logOf(tenderId)).slice(logged);
      expect(rows.map((row) => [row.purpose, row.outcome])).toEqual([
        ['LIST_BIDS', 'REFUSED'],
        ['LIST_BIDS', 'REFUSED'],
        ['READ_BID', 'REFUSED'],
      ]);
    });

    it('fails the read when its log row cannot be written (the audit is part of the read)', async () => {
      const { owner, tenderId } = await closedTender();
      await open(owner, tenderId);
      const before = (await logOf(tenderId)).length;
      const insert = jest
        .spyOn(w.bidRepository, 'insertAccess')
        .mockRejectedValue(new Error('log write failed'));
      try {
        await expect(asAdmin(owner, () => w.tenderOpen.listBids(tenderId))).rejects.toThrow(
          'log write failed',
        );
      } finally {
        insert.mockRestore();
      }
      expect((await logOf(tenderId)).length).toBe(before);
    });

    it('lists the access log newest first, a page at a time, without logging the reading of the log', async () => {
      const { owner, tenderId } = await closedTender();
      await open(owner, tenderId);
      await asAdmin(owner, () => w.tenderOpen.listBids(tenderId));
      const total = (await logOf(tenderId)).length;

      const first = await asAdmin(owner, () => w.tenderOpen.listAccessLog(tenderId, { limit: 2 }));
      expect(first.items).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      const second = await asAdmin(owner, () =>
        w.tenderOpen.listAccessLog(tenderId, { limit: 50, cursor: first.nextCursor! }),
      );

      expect([...first.items, ...second.items]).toHaveLength(total);
      const ids = [...first.items, ...second.items].map((item) => item.id);
      expect([...ids].sort().reverse()).toEqual(ids);
      expect((await logOf(tenderId)).length).toBe(total);
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('who the reader is NOW (identity-service), on every owner read', () => {
    const carol = newUserId();
    const identityRefusals = async (): Promise<number> =>
      (await bidOpeningRefusalsTotal.get()).values
        .filter((value) => value.labels.reason === 'identity_unavailable')
        .reduce((sum, value) => sum + value.value, 0);
    const asCarol = <T>(owner: string, fn: () => T) => asAdmin(owner, fn, carol);

    afterEach(() => w.memberships.reset());

    it('refuses a reader who joined a bidding organization after their token was issued: every route, before and after the opening', async () => {
      const { owner, bidders, tenderId } = await closedTender();
      // Before the opening: the counts and receipt times are not for a bidder's member either.
      w.memberships.of.set(carol, [bidders[0]!]);
      expect(await codeOf(asCarol(owner, () => w.tenderOpen.listBids(tenderId)))).toMatchObject({
        code: 'FORBIDDEN',
      });
      w.memberships.of.clear();
      await open(owner, tenderId);
      const [bid] = await bidRows(tenderId);
      const logged = (await logOf(tenderId)).length;

      // The token names only the owner; identity-service says she belongs to a bidder.
      w.memberships.of.set(carol, [bidders[0]!]);
      const calls: Array<() => Promise<unknown>> = [
        () => w.tenderOpen.listBids(tenderId),
        () => w.tenderOpen.getBid(tenderId, bid!.id),
        () => w.tenderOpen.listAccessLog(tenderId, { limit: 10 }),
        () => w.tenderOpen.open(tenderId),
      ];
      for (const call of calls) {
        expect(await codeOf(asCarol(owner, call))).toMatchObject({ code: 'FORBIDDEN' });
      }

      // Nothing was shown or granted her: only refusals under her name.
      const rows = (await logOf(tenderId)).slice(logged);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows)
        expect(row).toMatchObject({ accessorUserId: carol, outcome: 'REFUSED' });
      // And once she belongs to none of them she reads.
      w.memberships.of.set(carol, [owner]);
      expect((await asCarol(owner, () => w.tenderOpen.listBids(tenderId))).bids).toHaveLength(2);
    });

    it('refuses an administrator whose membership of the owner was revoked, though their token is still valid: every route, nothing shown', async () => {
      const { owner, tenderId } = await closedTender();
      await open(owner, tenderId);
      const [bid] = await bidRows(tenderId);
      const logged = (await logOf(tenderId)).length;
      // The token still says ORGANIZATION_ADMIN of the owner; identity-service has no such membership.
      w.memberships.revoked.add(carol);

      const calls: Array<() => Promise<unknown>> = [
        () => w.tenderOpen.listBids(tenderId),
        () => w.tenderOpen.getBid(tenderId, bid!.id),
        () => w.tenderOpen.listAccessLog(tenderId, { limit: 10 }),
        () => w.tenderOpen.open(tenderId),
        () => w.tenderOpen.proposeOpening(tenderId),
        () => w.tenderOpen.withdrawProposal(tenderId),
      ];
      for (const call of calls) {
        expect(await codeOf(asCarol(owner, call))).toMatchObject({ code: 'FORBIDDEN' });
      }

      // Nothing was shown: only refusals under their name (the access log is refused before any row).
      for (const row of (await logOf(tenderId)).slice(logged)) {
        expect(row).toMatchObject({ accessorUserId: carol, outcome: 'REFUSED' });
      }
      // And a member who is still one reads.
      w.memberships.revoked.clear();
      expect((await asCarol(owner, () => w.tenderOpen.listBids(tenderId))).opened).toBe(true);
    });

    it('refuses an administrator who no longer holds a role that opens bids in the owner, though the token still says so', async () => {
      const { owner, tenderId } = await closedTender();
      await open(owner, tenderId);
      w.memberships.rolesOf.set(carol, ['OPERATOR']);

      expect(await codeOf(asCarol(owner, () => w.tenderOpen.listBids(tenderId)))).toMatchObject({
        code: 'FORBIDDEN',
      });

      // The roles that open bids are enough, and one that must never read them is not made harmless by another.
      w.memberships.rolesOf.set(carol, ['OPERATOR', 'ORGANIZATION_ADMIN']);
      expect((await asCarol(owner, () => w.tenderOpen.listBids(tenderId))).opened).toBe(true);
      w.memberships.rolesOf.set(carol, ['CONTRACTOR', 'ORGANIZATION_ADMIN']);
      expect(await codeOf(asCarol(owner, () => w.tenderOpen.listBids(tenderId)))).toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('fails closed on every owner read when identity-service cannot say: nothing shown, counted as identity_unavailable', async () => {
      const { owner, tenderId } = await closedTender();
      await open(owner, tenderId);
      const [bid] = await bidRows(tenderId);
      const before = await identityRefusals();
      w.memberships.failure = RastaError.upstreamUnavailable('identity-service');

      const calls: Array<() => Promise<unknown>> = [
        () => w.tenderOpen.listBids(tenderId),
        () => w.tenderOpen.getBid(tenderId, bid!.id),
        () => w.tenderOpen.listAccessLog(tenderId, { limit: 10 }),
        () => w.tenderOpen.open(tenderId),
        () => w.tenderOpen.proposeOpening(tenderId),
        () => w.tenderOpen.withdrawProposal(tenderId),
      ];
      for (const call of calls) {
        expect(await codeOf(asCarol(owner, call))).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
      }

      expect(await identityRefusals()).toBe(before + 6);
      w.memberships.failure = undefined;
      expect((await asCarol(owner, () => w.tenderOpen.listBids(tenderId))).opened).toBe(true);
    });

    it('asks identity-service about the caller, whoever the caller is, and the owner’s 404 comes first', async () => {
      const { owner, tenderId } = await closedTender();
      await open(owner, tenderId);
      w.memberships.asked.length = 0;

      await asCarol(owner, () => w.tenderOpen.listBids(tenderId));
      expect(w.memberships.asked).toEqual([carol]);

      // Another organization's tender is a 404 and identity-service is not troubled.
      w.memberships.asked.length = 0;
      w.memberships.failure = RastaError.upstreamUnavailable('identity-service');
      expect(
        await codeOf(asCarol(org(), () => w.tenderOpen.listAccessLog(tenderId, { limit: 5 }))),
      ).toMatchObject({ code: 'NOT_FOUND' });
      expect(w.memberships.asked).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('four eyes (Q-91): a proposal by one user, the approval of a second', () => {
    let w4: Wiring;
    const [alice, bob] = [newUserId(), newUserId()];

    beforeAll(() => {
      w4 = wire(testEnv({ CONSTRUCTION_TENDER_OPEN_FOUR_EYES: 'true' }));
    });
    afterAll(async () => {
      await w4.close();
    });

    const propose = (owner: string, tenderId: string, user: string) =>
      asAdmin(owner, () => w4.tenderOpen.proposeOpening(tenderId), user);
    const approve = (owner: string, tenderId: string, user: string) =>
      asAdmin(owner, () => w4.tenderOpen.open(tenderId), user);

    it('refuses to open with no proposal: 422 PROPOSAL_REQUIRED, nothing opened', async () => {
      const { owner, tenderId } = await closedTender();

      expect(await refusalOf(approve(owner, tenderId, alice))).toContain('PROPOSAL_REQUIRED');

      await expectNothingOpened(owner, tenderId);
    });

    it('refuses the proposer approving their own proposal: 422 SECOND_PERSON_REQUIRED', async () => {
      const { owner, tenderId } = await closedTender();
      expect(await propose(owner, tenderId, alice)).toEqual({
        tenderId,
        proposedBy: alice,
        alreadyProposed: false,
      });

      expect(await refusalOf(approve(owner, tenderId, alice))).toContain('SECOND_PERSON_REQUIRED');

      await expectNothingOpened(owner, tenderId);
      expect(await rowOf(tenderId)).toMatchObject({ openingProposedBy: alice });
    });

    it('opens on a second user’s approval, records both, and says so on BIDS_OPENED', async () => {
      const { owner, tenderId } = await closedTender();
      await propose(owner, tenderId, alice);

      const view = await approve(owner, tenderId, bob);

      expect(view).toMatchObject({ status: 'EVALUATING', openedBy: bob, alreadyOpened: false });
      const row = await rowOf(tenderId);
      expect(row).toMatchObject({ openedBy: bob, openingProposedBy: alice });
      expect(row.openingProposedAt!.getTime()).toBeLessThanOrEqual(row.openedAt!.getTime());
      const [event] = await eventsOf(owner, 'BIDS_OPENED', tenderId);
      expect(payloadOf(event!)).toMatchObject({ openedBy: bob, proposedBy: alice });
    });

    it('keeps the first proposal: a second proposer is answered with it, and may then approve', async () => {
      const { owner, tenderId } = await closedTender();
      await propose(owner, tenderId, alice);

      expect(await propose(owner, tenderId, bob)).toEqual({
        tenderId,
        proposedBy: alice,
        alreadyProposed: true,
      });
      expect(await propose(owner, tenderId, alice)).toMatchObject({ alreadyProposed: true });

      expect((await approve(owner, tenderId, bob)).openedBy).toBe(bob);
    });

    it('proposes only a CLOSED tender, and not one already opened', async () => {
      const owner = org();
      const bidder = org();
      await qualify(w, bidder);
      const { tenderId } = await publishedForBids(w, owner);
      await asBidder(bidder, () => w.bids.submit(tenderId, { content: bidContent() }));
      await makeOverdue(tenderId);

      expect(await refusalOf(propose(owner, tenderId, alice))).toContain('NOT_CLOSED');

      await w.tenderClose.close({ organizationId: owner, tenderId });
      await propose(owner, tenderId, alice);
      await approve(owner, tenderId, bob);
      expect(await refusalOf(propose(owner, tenderId, alice))).toContain('NOT_CLOSED');
    });

    it('refuses a member of a bidding organization as proposer and as approver', async () => {
      const { owner, bidders, tenderId } = await closedTender();
      const asMember = <T>(fn: () => T, userId: string) =>
        runWithContext(
          context({
            organizationId: owner,
            organizationIds: [owner, bidders[0]!],
            userId,
            roles: ['ORGANIZATION_ADMIN'],
          }),
          fn,
        );

      expect(
        await codeOf(asMember(() => w4.tenderOpen.proposeOpening(tenderId), alice)),
      ).toMatchObject({ code: 'FORBIDDEN' });
      await propose(owner, tenderId, bob);
      expect(await codeOf(asMember(() => w4.tenderOpen.open(tenderId), alice))).toMatchObject({
        code: 'FORBIDDEN',
      });

      await expectNothingOpened(owner, tenderId);
    });

    describe('who they are NOW, at the approval', () => {
      afterEach(() => w4.memberships.reset());

      it('refuses when the proposer has joined a bidding organization since proposing, and CLEARS the proposal so another user can propose', async () => {
        const { owner, bidders, tenderId } = await closedTender();
        await propose(owner, tenderId, alice);
        w4.memberships.of.set(alice, [owner, bidders[0]!]);

        expect(await codeOf(approve(owner, tenderId, bob))).toMatchObject({ code: 'FORBIDDEN' });

        await expectNothingOpened(owner, tenderId);
        expect(w4.memberships.asked).toEqual(expect.arrayContaining([alice, bob]));
        // Cleared, audited, with its event: no one is stuck behind alice.
        expect(await rowOf(tenderId)).toMatchObject({
          openingProposedBy: null,
          openingProposedAt: null,
        });
        const [event] = await eventsOf(owner, 'BID_OPENING_PROPOSAL_WITHDRAWN', tenderId);
        expect(payloadOf(event!)).toMatchObject({
          proposedBy: alice,
          withdrawnBy: bob,
          reason: 'PROPOSER_CONFLICTED',
        });
        expect(
          (await logOf(tenderId)).filter((row) => row.purpose === 'WITHDRAW_PROPOSAL'),
        ).toEqual([expect.objectContaining({ accessorUserId: bob, outcome: 'GRANTED' })]);
        // Afresh: bob proposes, carol approves, and the conflicted alice has nothing to do with it.
        const carol = newUserId();
        expect(await propose(owner, tenderId, bob)).toMatchObject({
          proposedBy: bob,
          alreadyProposed: false,
        });
        expect((await approve(owner, tenderId, carol)).status).toBe('EVALUATING');
      });

      it('leaves a proposal standing when only the approver is conflicted', async () => {
        const { owner, bidders, tenderId } = await closedTender();
        await propose(owner, tenderId, alice);
        w4.memberships.of.set(bob, [bidders[0]!]);

        expect(await codeOf(approve(owner, tenderId, bob))).toMatchObject({ code: 'FORBIDDEN' });

        expect(await rowOf(tenderId)).toMatchObject({ openingProposedBy: alice });
        expect(await eventsOf(owner, 'BID_OPENING_PROPOSAL_WITHDRAWN', tenderId)).toHaveLength(0);
      });

      it('refuses when the approver has joined one, though the token says otherwise', async () => {
        const { owner, bidders, tenderId } = await closedTender();
        await propose(owner, tenderId, alice);
        w4.memberships.of.set(bob, [bidders[1]!]);

        expect(await codeOf(approve(owner, tenderId, bob))).toMatchObject({ code: 'FORBIDDEN' });

        await expectNothingOpened(owner, tenderId);
      });

      it('opens when neither belongs to a bidding organization now', async () => {
        const { owner, tenderId } = await closedTender();
        await propose(owner, tenderId, alice);
        w4.memberships.of.set(alice, [owner]);
        w4.memberships.of.set(bob, [owner]);

        expect((await approve(owner, tenderId, bob)).status).toBe('EVALUATING');
      });

      it('does not clear a FRESH proposal by the same user when the approval that found the old one conflicted is stale', async () => {
        const { owner, bidders, tenderId } = await closedTender();
        await propose(owner, tenderId, alice);
        const stale = await rowOf(tenderId);
        // Between bob reading alice's proposal and the clearing, alice withdraws and proposes afresh.
        w4.memberships.beforeAnswer.set(alice, async () => {
          await asAdmin(owner, () => w4.tenderOpen.withdrawProposal(tenderId), alice);
          await new Promise((resolve) => setTimeout(resolve, 10));
          await propose(owner, tenderId, alice);
          w4.memberships.of.set(alice, [bidders[0]!]);
        });

        // The old proposal's proposer is conflicted per identity-service; bob's approval is stale: 409, retry.
        expect(await codeOf(approve(owner, tenderId, bob))).toMatchObject({
          code: 'OPTIMISTIC_LOCK_FAILED',
        });

        const row = await rowOf(tenderId);
        expect(row.openingProposedBy).toBe(alice);
        expect(row.openingProposedAt!.getTime()).toBeGreaterThan(
          stale.openingProposedAt!.getTime(),
        );
        // Only alice's own withdrawal is on record; the stale approval cleared nothing.
        expect(
          (await eventsOf(owner, 'BID_OPENING_PROPOSAL_WITHDRAWN', tenderId)).map(
            (event) => (payloadOf(event) as { reason: string }).reason,
          ),
        ).toEqual(['WITHDRAWN_BY_PROPOSER']);
      });

      it('fails closed when identity-service cannot say: 502, nothing opened', async () => {
        const { owner, tenderId } = await closedTender();
        await propose(owner, tenderId, alice);
        w4.memberships.failure = RastaError.upstreamUnavailable('identity-service');

        expect(await codeOf(approve(owner, tenderId, bob))).toMatchObject({
          code: 'UPSTREAM_UNAVAILABLE',
        });

        await expectNothingOpened(owner, tenderId);
        w4.memberships.failure = undefined;
        expect((await approve(owner, tenderId, bob)).status).toBe('EVALUATING');
      });
    });

    describe('a proposal withdrawn by its proposer', () => {
      afterEach(() => w4.memberships.reset());
      const withdraw = (owner: string, tenderId: string, user: string) =>
        asAdmin(owner, () => w4.tenderOpen.withdrawProposal(tenderId), user);

      it('is cleared, audited and announced; anyone eligible may then propose afresh', async () => {
        const { owner, tenderId } = await closedTender();
        await propose(owner, tenderId, alice);

        expect(await withdraw(owner, tenderId, alice)).toEqual({
          tenderId,
          withdrawnProposal: alice,
        });

        expect(await rowOf(tenderId)).toMatchObject({
          openingProposedBy: null,
          openingProposedAt: null,
        });
        const [event] = await eventsOf(owner, 'BID_OPENING_PROPOSAL_WITHDRAWN', tenderId);
        expect(payloadOf(event!)).toMatchObject({
          proposedBy: alice,
          withdrawnBy: alice,
          reason: 'WITHDRAWN_BY_PROPOSER',
        });
        expect(
          (await logOf(tenderId)).filter((row) => row.purpose === 'WITHDRAW_PROPOSAL'),
        ).toEqual([expect.objectContaining({ accessorUserId: alice, outcome: 'GRANTED' })]);
        expect(await refusalOf(approve(owner, tenderId, bob))).toContain('PROPOSAL_REQUIRED');
        expect((await propose(owner, tenderId, bob)).alreadyProposed).toBe(false);
        expect((await approve(owner, tenderId, alice)).openedBy).toBe(alice);
      });

      it('is the proposer’s alone: another user is refused 403 and the proposal stands', async () => {
        const { owner, tenderId } = await closedTender();
        await propose(owner, tenderId, alice);

        expect(await codeOf(withdraw(owner, tenderId, bob))).toMatchObject({ code: 'FORBIDDEN' });

        expect(await rowOf(tenderId)).toMatchObject({ openingProposedBy: alice });
        expect(await eventsOf(owner, 'BID_OPENING_PROPOSAL_WITHDRAWN', tenderId)).toHaveLength(0);
      });

      it('has something to withdraw, and a tender to withdraw it from: NO_PROPOSAL, NOT_CLOSED', async () => {
        const { owner, tenderId } = await closedTender();
        expect(await refusalOf(withdraw(owner, tenderId, alice))).toContain('NO_PROPOSAL');

        await propose(owner, tenderId, alice);
        await approve(owner, tenderId, bob);
        expect(await refusalOf(withdraw(owner, tenderId, alice))).toContain('NOT_CLOSED');
      });

      it('is refused for a member of a bidding organization, like every owner route', async () => {
        const { owner, bidders, tenderId } = await closedTender();
        await propose(owner, tenderId, alice);
        w4.memberships.of.set(alice, [bidders[0]!]);

        expect(await codeOf(withdraw(owner, tenderId, alice))).toMatchObject({ code: 'FORBIDDEN' });
      });
    });

    describe('after the commit: a membership created in the race (the residual, ADR-066 § 4)', () => {
      const checks = async (outcome: string): Promise<number> =>
        (await bidOpeningConflictChecksTotal.get()).values
          .filter((value) => value.labels.outcome === outcome)
          .reduce((sum, value) => sum + value.value, 0);
      afterEach(() => w4.memberships.reset());

      it('raises the alert and BID_OPENING_CONFLICT_DETECTED, ids only, when the approver or the proposer held a bidder’s membership in the window from the decision to the check; the opening stands', async () => {
        const { owner, bidders, tenderId } = await closedTender();
        await propose(owner, tenderId, alice);
        // At the approval identity-service said nobody belongs to a bidder (the default answer);
        // over the window after the decision, as its history now has it, both did.
        w4.memberships.since.set(bob, [owner, bidders[1]!]);
        w4.memberships.since.set(alice, [bidders[0]!, bidders[1]!]);
        const asOf = new Date(Date.now() + 5_000);
        w4.memberships.intervalAsOf = asOf;
        const before = await checks('conflict');

        const view = await approve(owner, tenderId, bob);

        expect(view).toMatchObject({ status: 'EVALUATING', openedBy: bob });
        expect(await checks('conflict')).toBe(before + 1);
        const row = await rowOf(tenderId);
        expect(w4.memberships.askedSince.map((ask) => ask.userId).sort()).toEqual(
          [alice, bob].sort(),
        );
        for (const ask of w4.memberships.askedSince) {
          // The interval opens at the decision instant itself — not at some later "commit" instant,
          // from which a membership that began in between would be missed.
          expect(ask.from.getTime()).toBe(row.openedAt!.getTime());
        }
        const [event] = await eventsOf(owner, 'BID_OPENING_CONFLICT_DETECTED', tenderId);
        const payload = payloadOf(event!) as { conflicts: unknown[] };
        expect(payload).toMatchObject({
          tenderId,
          organizationId: owner,
          openedBy: bob,
          proposedBy: alice,
          // The window: opened at the decision, checked as identity-service answered.
          openedAt: row.openedAt!.toISOString(),
          checkedAt: asOf.toISOString(),
        });
        expect(payload.conflicts).toEqual(
          expect.arrayContaining([
            {
              userId: bob,
              role: 'APPROVER',
              organizationIds: [bidders[1]!],
              organizationCount: 1,
            },
            {
              userId: alice,
              role: 'PROPOSER',
              organizationIds: [...bidders].sort(),
              organizationCount: 2,
            },
          ]),
        );
        // Ids only: nothing of any bid.
        expect(JSON.stringify(payload)).not.toContain('priceMinor');
      });

      it('says nothing when neither held a bidder’s membership in the window', async () => {
        const { owner, tenderId } = await closedTender();
        await propose(owner, tenderId, alice);
        w4.memberships.since.set(alice, [owner]);
        const [clear, conflict] = [await checks('clear'), await checks('conflict')];

        await approve(owner, tenderId, bob);

        expect(await checks('clear')).toBe(clear + 1);
        expect(await checks('conflict')).toBe(conflict);
        expect(await eventsOf(owner, 'BID_OPENING_CONFLICT_DETECTED', tenderId)).toHaveLength(0);
      });

      it('does not undo or fail the opening when the check cannot be made: counted and logged', async () => {
        const { owner, tenderId } = await closedTender();
        await propose(owner, tenderId, alice);
        w4.memberships.sinceFailure = RastaError.upstreamUnavailable('identity-service');
        const before = await checks('unavailable');

        expect((await approve(owner, tenderId, bob)).status).toBe('EVALUATING');

        expect(await checks('unavailable')).toBe(before + 1);
        expect(await eventsOf(owner, 'BID_OPENING_CONFLICT_DETECTED', tenderId)).toHaveLength(0);
      });

      it('does not ask again when the bids were already open', async () => {
        const { owner, tenderId } = await closedTender();
        await propose(owner, tenderId, alice);
        await approve(owner, tenderId, bob);
        w4.memberships.askedSince.length = 0;

        expect((await approve(owner, tenderId, bob)).alreadyOpened).toBe(true);

        expect(w4.memberships.askedSince).toEqual([]);
      });
    });

    it('leaves the evidence of a proposal: an access row and BID_ACCESSED, ids only, in its transaction', async () => {
      const { owner, tenderId } = await closedTender();

      await propose(owner, tenderId, alice);
      await propose(owner, tenderId, bob);

      const rows = (await logOf(tenderId)).filter((row) => row.purpose === 'PROPOSE_OPENING');
      expect(rows.map((row) => `${row.accessorUserId}:${row.outcome}:${row.bidId}`)).toEqual([
        `${alice}:GRANTED:null`,
        `${bob}:GRANTED:null`,
      ]);
      const events = (await eventsOf(owner, 'BID_ACCESSED', tenderId)).map((row) => payloadOf(row));
      expect(events).toContainEqual(
        expect.objectContaining({
          purpose: 'PROPOSE_OPENING',
          accessedBy: alice,
          outcome: 'GRANTED',
          bidId: null,
        }),
      );
    });

    it('tells a member of a bidding organization nothing of the tender’s state: conflict before NOT_CLOSED / NOT_OPENED', async () => {
      const owner = org();
      const bidder = org();
      await qualify(w, bidder);
      const { tenderId } = await publishedForBids(w, owner);
      await asBidder(bidder, () => w.bids.submit(tenderId, { content: bidContent() }));
      const asMember = <T>(fn: () => T) =>
        runWithContext(
          context({
            organizationId: owner,
            organizationIds: [owner, bidder],
            userId: alice,
            roles: ['ORGANIZATION_ADMIN'],
          }),
          fn,
        );

      // The tender is PUBLISHED: anyone else is told NOT_CLOSED, this member is told FORBIDDEN.
      expect(await codeOf(asMember(() => w4.tenderOpen.open(tenderId)))).toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(await codeOf(asMember(() => w4.tenderOpen.proposeOpening(tenderId)))).toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(
        await codeOf(asMember(() => w4.tenderOpen.getBid(tenderId, 'BID_NONE'))),
      ).toMatchObject({ code: 'FORBIDDEN' });
      expect(await refusalOf(propose(owner, tenderId, bob))).toContain('NOT_CLOSED');
    });

    it('is not needed where the setting is off (development and test only)', async () => {
      const { owner, tenderId } = await closedTender();
      expect((await open(owner, tenderId)).status).toBe('EVALUATING');
    });
  });

  describe('the migration’s rollback', () => {
    it('refuses while a proposal is pending, and while an opening is recorded, and touches nothing', async () => {
      const text = readFileSync(
        join(
          __dirname,
          '..',
          'prisma',
          'migrations',
          '20261002100000_tender_open_bids',
          'down.sql',
        ),
        'utf8',
      );
      const lock = /^LOCK TABLE [^;]+;/m.exec(text)?.[0];
      const check = new RegExp('DO \\$preflight_opening\\$[\\s\\S]*?\\$preflight_opening\\$;').exec(
        text,
      )?.[0];
      expect(lock).toContain('ACCESS EXCLUSIVE');
      expect(check).toBeDefined();
      expect(text.indexOf(lock!)).toBeLessThan(text.indexOf(check!));
      expect(text.indexOf(check!)).toBeLessThan(text.indexOf('DROP COLUMN'));
      const runAfterLock = () =>
        w.prisma.client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(lock!.replace(/;$/, ''));
          await tx.$executeRawUnsafe(check!.replace(/;$/, ''));
        });

      // A proposal and nothing else: the columns would be dropped with it.
      const { owner, tenderId } = await closedTender();
      await sql(
        'the suite records a proposal, as the proposal command does',
        `UPDATE "tender" SET "opening_proposed_at" = now(), "opening_proposed_by" = 'USR_ROLLBACK'
          WHERE "id" = '${tenderId}'`,
      );
      await expect(runAfterLock()).rejects.toThrow(
        /down refused: \d+ tender\(s\) hold a pending proposal/,
      );
      expect(await rowOf(tenderId)).toMatchObject({ openingProposedBy: 'USR_ROLLBACK' });

      // The opening is recorded too: refused (by whichever of the two reads it first).
      await open(owner, tenderId);
      await expect(runAfterLock()).rejects.toThrow(/down refused/);
      expect(await rowOf(tenderId)).toMatchObject({ status: 'EVALUATING' });
    });
  });
});
