import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { eventEnvelopeSchema } from '@rasta/contracts';
import { PrismaClient } from '../src/generated/prisma';
import {
  genesisReceipt,
  nextReceipt,
  openBid,
  privateKeyFromDer,
  sealBid,
  verifyReceiptChain,
  type SealedBid,
} from '../src/tender/sealing/sealing';
import {
  asAdmin,
  asBidder,
  bidContent,
  cleanup,
  forgetBootstrap,
  loadStanding,
  newOrganizationId,
  outboxFor,
  ownerDatabaseUrl,
  publishedForBids,
  qualify,
  untilASessionWaitsOnALock,
  wire,
  type Wiring,
} from './helpers';

/**
 * Submitting, replacing and withdrawing a bid, and reading one's own receipt, against
 * PostgreSQL (ADR-065 § 1-2, ADR-066): the window judged on the database clock after
 * the lock, eligibility at submit time (fail closed), visibility, the receipt chain
 * and its externally held head, and the audit of every read.
 */

const payloadOf = (row: { payload: unknown }) => eventEnvelopeSchema.parse(row.payload).payload;
const eventsOf = async (w: Wiring, owner: string, name: string) =>
  (await outboxFor(w.prisma, owner)).filter((row) => row.eventName === name);

describe('bids', () => {
  let w: Wiring;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  /** A tender of a fresh owner, plus a qualified contractor for it. */
  const setup = async (options: Parameters<typeof publishedForBids>[2] = {}) => {
    const owner = org();
    const bidder = org();
    await qualify(w, bidder);
    const { tenderId, keyId } = await publishedForBids(w, owner, {
      ...options,
      invited: options.visibility === 'RESTRICTED' ? [bidder, ...(options.invited ?? [])] : [],
    });
    return { owner, bidder, tenderId, keyId };
  };

  const submit = (bidder: string, tenderId: string, content = bidContent()) =>
    asBidder(bidder, () => w.bids.submit(tenderId, { content }));

  const refusalsOf = async (call: Promise<unknown>): Promise<string> => {
    const error = (await call.then(
      () => undefined,
      (e: unknown) => e,
    )) as { code?: string; message?: string } | undefined;
    expect(error?.code).toBe('BUSINESS_RULE_VIOLATION');
    return error?.message ?? '';
  };

  /** The tender's stored receipt links, in chain order. */
  const linksOf = (tenderId: string) =>
    runUnscoped('the suite reads the chain it wrote', () =>
      w.prisma.client.bidReceipt.findMany({ where: { tenderId }, orderBy: { seq: 'asc' } }),
    );

  beforeAll(async () => {
    w = wire();
    // Until the standing is loaded nobody is eligible (ADR-061 § 4); the suite that
    // shows that state forgets the marker itself and loads it again.
    await loadStanding(w);
  });

  afterEach(() => {
    w.clock.fixed = undefined;
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  describe('submitting', () => {
    it('answers with the receipt, never the content, and seals what it stores', async () => {
      const { owner, bidder, tenderId } = await setup();

      const view = await submit(bidder, tenderId);

      expect(view).toMatchObject({
        tenderId,
        status: 'SUBMITTED',
        revision: 1,
        withdrawnAt: null,
        bidId: expect.stringMatching(/^BID_/),
        receipt: expect.stringMatching(/^[0-9a-f]{64}$/),
        contentCommitment: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(JSON.stringify(view)).not.toMatch(/1250000000|Mobilisation|Licence 1234/);

      // Nothing readable is stored: the price, the note and the answers exist only sealed.
      const row = await runUnscoped('the suite reads the row it wrote', () =>
        w.prisma.client.bid.findFirstOrThrow({ where: { id: view.bidId } }),
      );
      expect(row).toMatchObject({ organizationId: owner, bidderOrganizationId: bidder });
      const stored = JSON.stringify({
        ...row,
        nonce: Buffer.from(row.nonce).toString('latin1'),
        ciphertext: Buffer.from(row.ciphertext).toString('latin1'),
      });
      expect(stored).not.toMatch(/1250000000|Mobilisation|Licence 1234/);

      // The event carries digests and the new head, no content.
      const [event] = await eventsOf(w, owner, 'BID_SUBMITTED');
      expect(event).toMatchObject({ aggregateType: 'Tender', partitionKey: tenderId });
      expect(payloadOf(event!)).toEqual({
        bidId: view.bidId,
        tenderId,
        organizationId: owner,
        bidderOrganizationId: bidder,
        revision: 1,
        receivedAt: view.receivedAt,
        contentCommitment: view.contentCommitment,
        ciphertextSha256: row.ciphertextSha256,
        previousReceipt: genesisReceipt(tenderId),
        receipt: view.receipt,
        submittedBy: expect.any(String),
      });
      expect(JSON.stringify(event!.payload)).not.toMatch(/1250000000|Mobilisation|Licence 1234/);
    });

    it('stamps the row, the receipt and the event with one instant', async () => {
      const { owner, bidder, tenderId } = await setup();
      const view = await submit(bidder, tenderId);

      const [link] = await linksOf(tenderId);
      const [event] = await eventsOf(w, owner, 'BID_SUBMITTED');
      expect(link!.receivedAt.toISOString()).toBe(view.receivedAt);
      expect(eventEnvelopeSchema.parse(event!.payload).occurredAt).toBe(view.receivedAt);
    });

    it('lets an organization hold one bid on a tender', async () => {
      const { bidder, tenderId } = await setup();
      await submit(bidder, tenderId);

      await expect(submit(bidder, tenderId)).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    });

    it('lets exactly one of two simultaneous submissions of one organization through', async () => {
      const { bidder, tenderId } = await setup();

      const results = await Promise.allSettled([
        submit(bidder, tenderId),
        submit(bidder, tenderId),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
      ).toMatchObject({ code: 'ALREADY_EXISTS' });
      expect(await linksOf(tenderId)).toHaveLength(1);
    });

    it('refuses an answer to a criterion the tender does not have, naming only the code', async () => {
      const { bidder, tenderId } = await setup();
      const content = {
        ...bidContent(),
        answers: [{ criterionCode: 'SECRET-CODE', response: 'Hidden response text' }],
      };

      const message = await refusalsOf(submit(bidder, tenderId, content));

      expect(message).toContain('UNKNOWN_CRITERION');
      expect(message).not.toContain('Hidden response text');
    });

    it('is open to the contractor role alone', async () => {
      const { owner, tenderId } = await setup();

      await expect(
        asAdmin(owner, () => w.bids.submit(tenderId, { content: bidContent() })),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
      // The owner's own contractor role is refused too: it cannot bid on its own tender.
      expect(await refusalsOf(submit(owner, tenderId))).toContain('OWN_TENDER');
    });
  });

  describe('the deadline is judged on the database clock, after the lock', () => {
    it('refuses before the window opens, accepts just inside it, and refuses at the closing instant', async () => {
      const { bidder, tenderId } = await setup();
      const row = await runUnscoped('the suite reads the window', () =>
        w.prisma.client.tender.findFirstOrThrow({ where: { id: tenderId } }),
      );
      const opening = row.bidOpeningAt!;
      const closing = row.bidClosingAt!;

      w.clock.fixed = new Date(opening.getTime() - 1);
      expect(await refusalsOf(submit(bidder, tenderId))).toContain('BID_WINDOW_NOT_OPEN');

      w.clock.fixed = closing;
      expect(await refusalsOf(submit(bidder, tenderId))).toContain('BID_WINDOW_CLOSED');
      w.clock.fixed = new Date(closing.getTime() + 1);
      expect(await refusalsOf(submit(bidder, tenderId))).toContain('BID_WINDOW_CLOSED');

      // Half-open: one millisecond before the closing instant is in.
      w.clock.fixed = new Date(closing.getTime() - 1);
      const view = await submit(bidder, tenderId);
      expect(view.revision).toBe(1);
      expect(view.receivedAt).toBe(new Date(closing.getTime() - 1).toISOString());
    });

    it('refuses on the real clock once the window has passed, though the tender is still PUBLISHED', async () => {
      const { bidder, tenderId } = await setup();
      await runUnscoped('the suite moves the deadline into the past', () =>
        w.prisma.client.$executeRawUnsafe(
          `UPDATE "tender" SET "bid_opening_at" = now() - interval '2 hours',
             "bid_closing_at" = now() - interval '1 second' WHERE "id" = '${tenderId}'`,
        ),
      );

      expect(await refusalsOf(submit(bidder, tenderId))).toContain('BID_WINDOW_CLOSED');
      expect(await linksOf(tenderId)).toEqual([]);
    });

    it('judges a submission that waited for the tender lock on the instant after the wait', async () => {
      // A transaction that began before the deadline and waited for the lock past it
      // must not be judged on the instant it started (ADR-065 § 2).
      const { bidder, tenderId } = await setup();
      let release!: () => void;
      let holding!: () => void;
      const mayRelease = new Promise<void>((resolve) => (release = resolve));
      const held = new Promise<void>((resolve) => (holding = resolve));
      const holder = runUnscoped('the suite holds the tender row and moves its deadline', () =>
        w.prisma.client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE "tender" SET "bid_opening_at" = now() - interval '2 hours',
               "bid_closing_at" = now() + interval '1 second' WHERE "id" = '${tenderId}'`,
          );
          holding();
          await mayRelease;
        }),
      );
      await held;

      const pending = submit(bidder, tenderId);
      const outcome = refusalsOf(pending);
      await untilASessionWaitsOnALock(w.prisma);
      // Let the (one-second) window run out while the bid waits, then free the row.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      release();
      await holder;

      expect(await outcome).toContain('BID_WINDOW_CLOSED');
    });

    it('is also kept by the database: a bid outside the window is refused whatever the code did', async () => {
      const { owner, bidder, tenderId } = await setup();
      const view = await submit(bidder, tenderId);
      await runUnscoped('the suite closes the window', () =>
        w.prisma.client.$executeRawUnsafe(
          `UPDATE "tender" SET "bid_opening_at" = now() - interval '2 hours',
             "bid_closing_at" = now() - interval '1 second' WHERE "id" = '${tenderId}'`,
        ),
      );

      // A replacement of the seal, or a withdrawal, straight in SQL: refused by the trigger.
      await expect(
        runUnscoped('the suite attacks the table', () =>
          w.prisma.client.$executeRawUnsafe(
            `UPDATE "bid" SET "status" = 'WITHDRAWN', "withdrawn_at" = now() WHERE "id" = '${view.bidId}'`,
          ),
        ),
      ).rejects.toThrow(/ck_bid_window/);
      await expect(
        runUnscoped('the suite attacks the table', () =>
          w.prisma.client.$executeRawUnsafe(
            `INSERT INTO "bid" ("id", "organization_id", "tender_id", "bidder_organization_id", "revision",
               "seal_version", "key_id", "nonce", "ciphertext", "tag", "wrapped_content_key",
               "content_commitment", "ciphertext_sha256", "submitted_at", "received_at", "submitted_by",
               "updated_at", "updated_by")
             VALUES ('BID_LATE', '${owner}', '${tenderId}', 'ORG_LATE', 1, 1, 'K', '\\x000000000000000000000000',
               '\\x01', '\\x00000000000000000000000000000000', '\\x01', '${'a'.repeat(64)}', '${'b'.repeat(64)}',
               now(), now(), 'U', now(), 'U')`,
          ),
        ),
      ).rejects.toThrow(/ck_bid_window/);
    });
  });

  describe('eligibility, at submit time, fails closed', () => {
    it('refuses an organization this service has never heard of, and one only qualified for another capability', async () => {
      const owner = org();
      const stranger = org();
      const { tenderId } = await publishedForBids(w, owner);

      expect(await refusalsOf(submit(stranger, tenderId))).toContain('BIDDER_NOT_ELIGIBLE');

      const other = org();
      await w.supplierEvents.handle(
        supplierEvent('SUPPLIER_QUALIFIED', other, {
          qualifiedFor: ['EQUIPMENT_RENTAL'],
          decidedAt: new Date().toISOString(),
        }),
      );
      expect(await refusalsOf(submit(other, tenderId))).toContain('BIDDER_NOT_ELIGIBLE');
      expect(await linksOf(tenderId)).toEqual([]);
    });

    it('refuses everybody, with its own reason, until the standing has been loaded from supplier-service', async () => {
      const { bidder, tenderId } = await setup();
      await forgetBootstrap();
      try {
        const message = await refusalsOf(submit(bidder, tenderId));
        expect(message).toContain('STANDING_NOT_LOADED');
        expect(message).not.toContain('BIDDER_NOT_ELIGIBLE');
        expect(await linksOf(tenderId)).toEqual([]);
      } finally {
        await loadStanding(w);
      }
      expect((await submit(bidder, tenderId)).revision).toBe(1);
    });

    it('follows a suspension and its reinstatement, and judges them when the bid is made', async () => {
      const { bidder, tenderId } = await setup();
      const suspensionId = `SUS_${bidder}`;

      await w.supplierEvents.handle(
        supplierEvent('SUPPLIER_SUSPENDED', bidder, {
          suspensionId,
          suspendedAt: new Date().toISOString(),
        }),
      );
      expect(await refusalsOf(submit(bidder, tenderId))).toContain('BIDDER_NOT_ELIGIBLE');

      await w.supplierEvents.handle(
        supplierEvent('SUPPLIER_REINSTATED', bidder, {
          suspensionId,
          reinstatedAt: new Date(Date.now() + 1000).toISOString(),
        }),
      );
      expect((await submit(bidder, tenderId)).revision).toBe(1);
    });

    it('lets a contractor suspended since take its bid back, but not replace it', async () => {
      const { bidder, tenderId } = await setup();
      const view = await submit(bidder, tenderId);
      await w.supplierEvents.handle(
        supplierEvent('SUPPLIER_SUSPENDED', bidder, {
          suspensionId: `SUS2_${bidder}`,
          suspendedAt: new Date().toISOString(),
        }),
      );

      expect(
        await refusalsOf(
          asBidder(bidder, () =>
            w.bids.revise(tenderId, view.bidId, { expectedRevision: 1, content: bidContent('9') }),
          ),
        ),
      ).toContain('BIDDER_NOT_ELIGIBLE');
      const withdrawn = await asBidder(bidder, () =>
        w.bids.withdraw(tenderId, view.bidId, { expectedRevision: 1 }),
      );
      expect(withdrawn.status).toBe('WITHDRAWN');
    });
  });

  describe('who may bid on what', () => {
    it('shows a restricted tender only to an invited organization, and a draft to nobody', async () => {
      const { owner, bidder, tenderId } = await setup({ visibility: 'RESTRICTED' });
      const outsider = org();
      await qualify(w, outsider);

      await expect(submit(outsider, tenderId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(asBidder(outsider, () => w.bids.getOpenTender(tenderId))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect((await submit(bidder, tenderId)).revision).toBe(1);
      expect((await asBidder(bidder, () => w.bids.getOpenTender(tenderId))).id).toBe(tenderId);
      expect(owner).toBeDefined();

      await expect(submit(bidder, 'TND_DOES_NOT_EXIST')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('lists the public tenders and the invited ones, never the caller’s own or another’s restricted tender', async () => {
      const pub = await setup();
      const restricted = await setup({ visibility: 'RESTRICTED' });
      const reader = restricted.bidder;

      const mine = await asBidder(reader, () => w.bids.listOpenTenders({ limit: 100 }));
      const ids = mine.items.map((item) => item.id);
      expect(ids).toContain(restricted.tenderId);
      expect(ids).toContain(pub.tenderId);

      const outsider = org();
      const theirs = await asBidder(outsider, () => w.bids.listOpenTenders({ limit: 100 }));
      expect(theirs.items.map((item) => item.id)).toContain(pub.tenderId);
      expect(theirs.items.map((item) => item.id)).not.toContain(restricted.tenderId);

      // The owner, acting as a contractor, does not see its own tender among those it may bid on.
      const own = await asBidder(pub.owner, () => w.bids.listOpenTenders({ limit: 100 }));
      expect(own.items.map((item) => item.id)).not.toContain(pub.tenderId);

      const view = await asBidder(reader, () => w.bids.getOpenTender(restricted.tenderId));
      expect(view.criteria.map((c) => c.code)).toEqual(['PRICE', 'LICENCE']);
      expect(JSON.stringify(view)).not.toMatch(/createdBy|organizationId/);
    });
  });

  describe('tenant isolation: bids belong to the tender’s owner', () => {
    it('shows an owner its own tenders’ bids, receipts and reads, and every other organization none', async () => {
      const a = await setup();
      const b = await setup();
      await submit(a.bidder, a.tenderId);
      await asBidder(a.bidder, () => w.bids.getMine(a.tenderId));

      // Through the ordinary tenant guard, as an owner's own staff would read them.
      const readAs = (owner: string) =>
        asAdmin(owner, async () => ({
          bids: await w.prisma.client.bid.findMany(),
          receipts: await w.prisma.client.bidReceipt.findMany(),
          reads: await w.prisma.client.bidAccessLog.findMany(),
        }));
      const seenByA = await readAs(a.owner);
      expect([seenByA.bids.length, seenByA.receipts.length, seenByA.reads.length]).toEqual([
        1, 1, 1,
      ]);
      const seenByB = await readAs(b.owner);
      expect([seenByB.bids.length, seenByB.receipts.length, seenByB.reads.length]).toEqual([
        0, 0, 0,
      ]);
      // The bidder, another tenant, is not the owner: the guard shows it none of them either.
      const seenByBidder = await readAs(a.bidder);
      expect([seenByBidder.bids.length, seenByBidder.receipts.length]).toEqual([0, 0]);
    });

    it('lets a bidder read only its own bid: a third organization’s read of a bid is refused and logged', async () => {
      const { owner, bidder, tenderId } = await setup();
      await submit(bidder, tenderId);
      const third = org();
      await qualify(w, third);

      await expect(asBidder(third, () => w.bids.getMine(tenderId))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });

      const rows = await runUnscoped('the suite reads the log', () =>
        w.prisma.client.bidAccessLog.findMany({
          where: { organizationId: owner, tenderId, accessorOrganizationId: third },
        }),
      );
      expect(rows.map((row) => [row.bidId, row.outcome])).toEqual([[null, 'REFUSED']]);
    });
  });

  describe('replacing and withdrawing', () => {
    it('replaces the bid with the next revision, extends the chain and publishes the new head', async () => {
      const { owner, bidder, tenderId } = await setup();
      const first = await submit(bidder, tenderId);

      const second = await asBidder(bidder, () =>
        w.bids.revise(tenderId, first.bidId, {
          expectedRevision: 1,
          content: bidContent('900000000'),
        }),
      );

      expect(second).toMatchObject({ bidId: first.bidId, revision: 2, status: 'SUBMITTED' });
      expect(second.receipt).not.toBe(first.receipt);
      expect(second.contentCommitment).not.toBe(first.contentCommitment);
      const links = await linksOf(tenderId);
      expect(links.map((link) => [link.seq, link.revision])).toEqual([
        [1, 1],
        [2, 2],
      ]);
      expect(links[1]!.previousReceipt).toBe(first.receipt);
      const [event] = await eventsOf(w, owner, 'BID_REVISED');
      expect(payloadOf(event!)).toMatchObject({
        revision: 2,
        previousReceipt: first.receipt,
        receipt: second.receipt,
      });
    });

    it('refuses a stale revision, another organization’s bid, and a replacement after a withdrawal', async () => {
      const { bidder, tenderId } = await setup();
      const first = await submit(bidder, tenderId);
      const other = org();
      await qualify(w, other);

      await expect(
        asBidder(bidder, () =>
          w.bids.revise(tenderId, first.bidId, { expectedRevision: 5, content: bidContent() }),
        ),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      await expect(
        asBidder(other, () =>
          w.bids.revise(tenderId, first.bidId, { expectedRevision: 1, content: bidContent() }),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        asBidder(other, () => w.bids.withdraw(tenderId, first.bidId, { expectedRevision: 1 })),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      await asBidder(bidder, () => w.bids.withdraw(tenderId, first.bidId, { expectedRevision: 1 }));
      expect(
        await refusalsOf(
          asBidder(bidder, () =>
            w.bids.revise(tenderId, first.bidId, { expectedRevision: 1, content: bidContent() }),
          ),
        ),
      ).toContain('BID_NOT_SUBMITTED');
      // No return from a withdrawal: not even a new bid (one bid per organization).
      await expect(submit(bidder, tenderId)).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    });

    it('withdraws before the deadline, publishes BID_WITHDRAWN, and refuses it afterwards', async () => {
      const { owner, bidder, tenderId } = await setup();
      const view = await submit(bidder, tenderId);

      const withdrawn = await asBidder(bidder, () =>
        w.bids.withdraw(tenderId, view.bidId, { expectedRevision: 1 }),
      );

      expect(withdrawn).toMatchObject({ status: 'WITHDRAWN', withdrawnAt: expect.any(String) });
      const [event] = await eventsOf(w, owner, 'BID_WITHDRAWN');
      expect(payloadOf(event!)).toMatchObject({ bidId: view.bidId, revision: 1 });

      const late = await setup();
      const lateBid = await submit(late.bidder, late.tenderId);
      const row = await runUnscoped('the suite reads the window', () =>
        w.prisma.client.tender.findFirstOrThrow({ where: { id: late.tenderId } }),
      );
      w.clock.fixed = row.bidClosingAt!;
      expect(
        await refusalsOf(
          asBidder(late.bidder, () =>
            w.bids.withdraw(late.tenderId, lateBid.bidId, { expectedRevision: 1 }),
          ),
        ),
      ).toContain('BID_WINDOW_CLOSED');
    });
  });

  describe('the receipt chain and its externally held head', () => {
    /** The head an audit-service would hold: the newest receipt announced on BID_SUBMITTED / BID_REVISED. */
    const announcedHead = async (owner: string, tenderId: string): Promise<string> => {
      const announced = (await outboxFor(w.prisma, owner))
        .filter((row) => ['BID_SUBMITTED', 'BID_REVISED'].includes(row.eventName))
        .map((row) => payloadOf(row) as { tenderId: string; receipt: string })
        .filter((payload) => payload.tenderId === tenderId);
      return announced[announced.length - 1]!.receipt;
    };

    it('gives concurrent submissions distinct places in one verifying chain, ending at the announced head', async () => {
      const { owner, tenderId } = await setup();
      const bidders = [org(), org(), org(), org(), org(), org()];
      for (const bidder of bidders) await qualify(w, bidder);

      await Promise.all(bidders.map((bidder) => submit(bidder, tenderId)));

      const links = await linksOf(tenderId);
      expect(links.map((link) => link.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(new Set(links.map((link) => link.receipt)).size).toBe(6);
      links.forEach((link, index) => {
        expect(link.previousReceipt).toBe(
          index === 0 ? genesisReceipt(tenderId) : links[index - 1]!.receipt,
        );
      });
      expect(verifyReceiptChain(tenderId, links, await announcedHead(owner, tenderId))).toEqual({
        ok: true,
      });
    });

    it('is not rescued by a rewritten chain: a consistent local forgery fails the head held elsewhere, and opening refuses it', async () => {
      const { owner, tenderId, keyId } = await setup();
      const bidders = [org(), org(), org()];
      for (const bidder of bidders) await qualify(w, bidder);
      for (const bidder of bidders) await submit(bidder, tenderId, bidContent('1000'));
      const externalHead = await announcedHead(owner, tenderId);
      const original = await linksOf(tenderId);
      expect(verifyReceiptChain(tenderId, original, externalHead)).toEqual({ ok: true });

      // The operator with full database access replaces bidder 2's bid with another
      // price sealed to the same public key, and rewrites every later receipt so the
      // local chain is internally perfect — through the owner connection, which may
      // lift the append-only triggers.
      const target = original[1]!;
      const key = await runUnscoped('the suite reads the tender key', () =>
        w.prisma.client.tenderKey.findFirstOrThrow({ where: { tenderId } }),
      );
      const forged = sealBid({
        publicKeyPem: key.publicKeyPem,
        binding: {
          tenderId,
          bidId: target.bidId,
          bidderOrganizationId: bidders[1]!,
          revision: 1,
          keyId,
        },
        content: { priceMinor: '1' },
      });
      const rewritten = await rewriteChain(tenderId, target.seq, forged);

      // Against its own (rewritten) head the forged chain verifies: that is exactly why a
      // head read from the same database proves nothing.
      expect(
        verifyReceiptChain(tenderId, rewritten, rewritten[rewritten.length - 1]!.receipt),
      ).toEqual({ ok: true });
      // Against the head announced when the bids were made, it does not.
      expect(verifyReceiptChain(tenderId, rewritten, externalHead)).toEqual({
        ok: false,
        reason: 'HEAD_MISMATCH',
      });

      // Opening takes the head from outside: the substituted bid is refused before any decryption.
      const der = w.keys.unwrap(
        {
          kekId: key.kekId,
          nonce: Buffer.from(key.wrapNonce),
          ciphertext: Buffer.from(key.wrappedPrivateKey),
          tag: Buffer.from(key.wrapTag),
        },
        { tenderId, keyId },
      );
      try {
        expect(() =>
          openBid({
            privateKey: privateKeyFromDer(der),
            binding: {
              tenderId,
              bidId: target.bidId,
              bidderOrganizationId: bidders[1]!,
              revision: 1,
              keyId,
            },
            sealed: forged,
            receipts: { links: rewritten, head: externalHead },
          }),
        ).toThrow(expect.objectContaining({ code: 'RECEIPT_CHAIN_BROKEN' }));
      } finally {
        der.fill(0);
      }
    });

    /** Rewrites the stored chain from `fromSeq` on, as a database owner could: bid, digests, every later receipt. */
    async function rewriteChain(tenderId: string, fromSeq: number, forged: SealedBid) {
      const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
      try {
        await owner.$transaction(async (tx) => {
          for (const [table, trigger] of [
            ['bid', 'tg_bid_guard'],
            ['bid_receipt', 'tg_bid_receipt_append_only'],
          ] as const) {
            await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
          }
          const links = await tx.bidReceipt.findMany({
            where: { tenderId },
            orderBy: { seq: 'asc' },
          });
          let previous = genesisReceipt(tenderId);
          for (const link of links) {
            const replaced = link.seq === fromSeq;
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
            if (replaced) {
              await tx.bid.update({
                where: { id: link.bidId },
                data: {
                  nonce: new Uint8Array(forged.nonce),
                  ciphertext: new Uint8Array(forged.ciphertext),
                  tag: new Uint8Array(forged.tag),
                  wrappedContentKey: new Uint8Array(forged.wrappedContentKey),
                  ...next,
                },
              });
            }
            previous = receipt;
          }
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
      return linksOf(tenderId);
    }
  });

  describe('every read of a bid is audited', () => {
    it('logs a granted read in the same transaction, with a BID_ACCESSED event and no content', async () => {
      const { owner, bidder, tenderId } = await setup();
      const view = await submit(bidder, tenderId);

      const read = await asBidder(bidder, () => w.bids.getMine(tenderId));

      expect(read).toEqual(view);
      const rows = await runUnscoped('the suite reads the log', () =>
        w.prisma.client.bidAccessLog.findMany({ where: { tenderId } }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        organizationId: owner,
        bidId: view.bidId,
        accessorOrganizationId: bidder,
        purpose: 'OWN_BID_RECEIPT',
        outcome: 'GRANTED',
      });
      const [event] = await eventsOf(w, owner, 'BID_ACCESSED');
      expect(payloadOf(event!)).toEqual({
        bidId: view.bidId,
        tenderId,
        organizationId: owner,
        accessorOrganizationId: bidder,
        accessedBy: expect.any(String),
        purpose: 'OWN_BID_RECEIPT',
        outcome: 'GRANTED',
        accessedAt: rows[0]!.accessedAt.toISOString(),
      });
      expect(JSON.stringify(rows) + JSON.stringify(event!.payload)).not.toMatch(
        /1250000000|Mobilisation|Licence 1234/,
      );
    });

    it('logs a refused read, commits the row, and then answers 404', async () => {
      const { owner, tenderId } = await setup();
      const nobody = org();
      await qualify(w, nobody);

      await expect(asBidder(nobody, () => w.bids.getMine(tenderId))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });

      const rows = await runUnscoped('the suite reads the log', () =>
        w.prisma.client.bidAccessLog.findMany({ where: { tenderId } }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        organizationId: owner,
        bidId: null,
        accessorOrganizationId: nobody,
        outcome: 'REFUSED',
      });
      const [event] = await eventsOf(w, owner, 'BID_ACCESSED');
      expect(payloadOf(event!)).toMatchObject({ outcome: 'REFUSED', bidId: null });
    });

    it('fails the read when the log cannot be written (fail closed), leaving no event behind', async () => {
      const { owner, bidder, tenderId } = await setup();
      await submit(bidder, tenderId);
      const spy = jest
        .spyOn(w.bidRepository, 'insertAccess')
        .mockRejectedValueOnce(new Error('the log is unavailable'));
      try {
        await expect(asBidder(bidder, () => w.bids.getMine(tenderId))).rejects.toThrow(
          'the log is unavailable',
        );
      } finally {
        spy.mockRestore();
      }
      expect(await eventsOf(w, owner, 'BID_ACCESSED')).toEqual([]);
    });

    it('cannot be rewritten or erased: the log and the receipts are append-only', async () => {
      const { bidder, tenderId } = await setup();
      await submit(bidder, tenderId);
      await asBidder(bidder, () => w.bids.getMine(tenderId));

      for (const sql of [
        `UPDATE "bid_access_log" SET "outcome" = 'GRANTED' WHERE "tender_id" = '${tenderId}'`,
        `DELETE FROM "bid_access_log" WHERE "tender_id" = '${tenderId}'`,
        'TRUNCATE "bid_access_log"',
        `UPDATE "bid_receipt" SET "receipt" = '${'0'.repeat(64)}' WHERE "tender_id" = '${tenderId}'`,
        `DELETE FROM "bid_receipt" WHERE "tender_id" = '${tenderId}'`,
        'TRUNCATE "bid_receipt"',
      ]) {
        await expect(
          runUnscoped('the suite attacks the table', () => w.prisma.client.$executeRawUnsafe(sql)),
        ).rejects.toThrow(/ck_bid_append_only/);
      }
      expect(await linksOf(tenderId)).toHaveLength(1);
    });

    it('keeps a bid from being deleted, edited in place, or taken through an unwritten edge', async () => {
      const { bidder, tenderId } = await setup();
      const view = await submit(bidder, tenderId);
      const attack = (sql: string) =>
        runUnscoped('the suite attacks the table', () => w.prisma.client.$executeRawUnsafe(sql));

      await expect(attack(`DELETE FROM "bid" WHERE "id" = '${view.bidId}'`)).rejects.toThrow(
        /ck_bid_immutable/,
      );
      await expect(
        attack(`UPDATE "bid" SET "ciphertext" = '\\x01' WHERE "id" = '${view.bidId}'`),
      ).rejects.toThrow(/ck_bid_immutable/);
      await expect(
        attack(`UPDATE "bid" SET "status" = 'QUALIFIED' WHERE "id" = '${view.bidId}'`),
      ).rejects.toThrow(/ck_bid_status_transition/);
      await expect(
        attack(`UPDATE "bid" SET "revision" = 7 WHERE "id" = '${view.bidId}'`),
      ).rejects.toThrow(/ck_bid_revision_step/);
    });
  });
});

/** A supplier-service event as the consumer receives it (PR 5), for the eligibility suite. */
function supplierEvent(eventName: string, organizationId: string, payload: object) {
  return eventEnvelopeSchemaParse({
    eventId: ulid(),
    eventName,
    occurredAt: new Date().toISOString(),
    producer: 'supplier-service',
    aggregateType: 'Supplier',
    aggregateId: 'SUP_1',
    tenantId: organizationId,
    correlationId: '01J0000000000000000000000B',
    payload: { organizationId, ...payload },
  });
}

function eventEnvelopeSchemaParse(value: unknown) {
  return eventEnvelopeSchema.parse(value) as Parameters<Wiring['supplierEvents']['handle']>[0];
}
