import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { runUnscoped } from '@rasta/nest-common';
import { ID_PREFIX, newId } from '../src/events/publisher';
import {
  genesisReceipt,
  nextReceipt,
  sealBid,
  verifyReceipts,
  type ReceiptLink,
  type SealedBid,
} from '../src/tender/sealing/sealing';
import type { TenderChain } from '../src/tender/tender-evidence.client';
import { EVIDENCE_MAX_CHAIN_LINKS } from '../src/tender/evidence-limits';
import {
  asAdmin,
  bidContent,
  cleanup,
  newOrganizationId,
  newUserId,
  publishedForBids,
  testEnv,
  wire,
  type Wiring,
} from './helpers';

/**
 * Opening the largest tenders the caps permit (Codex r1 on #250, R2; Codex r2, R2-open).
 *
 * The opening verifies the chain, decrypts every standing bid and writes an access row and event
 * for each, in one transaction under the tender's lock; the owner's read of every opened bid
 * repeats that work. Two caps bound it: `CONSTRUCTION_TENDER_MAX_STANDING_BIDS` (the bids
 * decrypted) and `CONSTRUCTION_TENDER_MAX_RECEIPTS` (the chain walked and compared, and the bid
 * rows listed — a withdrawn bid is not decrypted, but its receipts stay). The receipt cap alone let
 * 10,000 organizations bid once each, ~33 s of decryption; so each shape the caps allow is opened
 * here, at the caps the suite runs with, and must finish — with half the timeout to spare — within
 * `CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS`, or the caps are wrong:
 *
 *   1. the most standing bids, each revised as far as the receipt cap lets them all (by default
 *      200 × 50 = 10,000 receipts): the longest chain under the most decryptions;
 *   2. the most standing bids, once each (200 receipts): decryption alone;
 *   3. the most standing bids, once each, and the rest of the receipt cap filled with withdrawn
 *      bids of other organizations (by default 9,800): the most bid rows a tender can hold.
 *
 * The caps are read from the environment, so the same spec measures a deployment's own values
 * (`TENDER_MAX_STANDING_BIDS_CEILING` was measured this way).
 *
 * The bids and receipts are written directly, as a full submission history would have left them
 * (10,000 submissions through the service would take minutes and prove nothing more here; the
 * submission path and its caps are `bids.int-spec.ts`). Only each standing bid's newest revision is
 * sealed bytes: earlier revisions survive only as links in the chain, exactly as after real
 * revisions. The evidence is that chain as audit-service would serve it. The opening and the read
 * are the service's own.
 */

const env = testEnv();
const MAX_BIDS = env.CONSTRUCTION_TENDER_MAX_STANDING_BIDS;
const MAX_RECEIPTS = env.CONSTRUCTION_TENDER_MAX_RECEIPTS;
/** As many revisions as every standing bid can have at once within the receipt cap. */
const MAX_SHARED_REVISIONS = Math.min(
  env.CONSTRUCTION_BID_MAX_REVISIONS,
  Math.floor(MAX_RECEIPTS / MAX_BIDS),
);
const TIMEOUT_MS = env.CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS;

jest.setTimeout(900_000);

const hex = (): string => createHash('sha256').update(randomBytes(32)).digest('hex');
const report = (line: string): void => {
  process.stdout.write(`[tender-open-scale] ${line}\n`);
};

interface Shape {
  label: string;
  standing: number;
  revisions: number;
  withdrawn: number;
}

describe('opening at the caps (Codex r1 on #250, R2; Codex r2, R2-open)', () => {
  let w: Wiring;
  const organizations: string[] = [];

  beforeAll(() => {
    w = wire(env);
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  it('runs at the default caps unless told otherwise, which fill the receipt cap exactly', () => {
    if (process.env.CONSTRUCTION_TENDER_MAX_STANDING_BIDS !== undefined) return;
    expect(MAX_BIDS).toBe(200);
    expect(MAX_RECEIPTS).toBe(EVIDENCE_MAX_CHAIN_LINKS);
    expect(MAX_BIDS * MAX_SHARED_REVISIONS).toBe(MAX_RECEIPTS);
  });

  /** Seeds a closed tender of this shape, opens it with four eyes and reads every opened bid. */
  const openAtScale = async (shape: Shape): Promise<void> => {
    const owner = newOrganizationId();
    organizations.push(owner);
    const { tenderId, keyId } = await publishedForBids(w, owner);
    const key = await runUnscoped('the suite reads the tender key', () =>
      w.prisma.client.tenderKey.findFirstOrThrow({ where: { tenderId } }),
    );
    const seal = (bidId: string, bidderOrganizationId: string, revision: number, price: string) =>
      sealBid({
        publicKeyPem: key.publicKeyPem,
        binding: { tenderId, bidId, bidderOrganizationId, revision, keyId },
        content: bidContent(price),
      });

    // Each standing bidder's newest revision, sealed; its price is its index, to be read back.
    const seededAt = performance.now();
    const base = Date.now() - 30 * 60_000;
    const standing = Array.from({ length: shape.standing }, (_, i) => {
      const bidderOrganizationId = newOrganizationId();
      const bidId = newId(ID_PREFIX.bid);
      const price = String(1_000_000 + i);
      return {
        bidId,
        bidderOrganizationId,
        sealed: seal(bidId, bidderOrganizationId, shape.revisions, price),
        price,
      };
    });
    // Withdrawn bids are never decrypted: one sealed body serves as every one's stored bytes.
    const withdrawnSeal = seal(newId(ID_PREFIX.bid), newOrganizationId(), 1, '1');
    const withdrawn = Array.from({ length: shape.withdrawn }, () => ({
      bidId: newId(ID_PREFIX.bid),
      bidderOrganizationId: newOrganizationId(),
    }));

    // The chain: the withdrawn bids first, then revision by revision every standing bidder in
    // turn, so each standing bid's newest receipt is late.
    type Link = ReceiptLink & { seq: number; previousReceipt: string; receipt: string };
    const links: Link[] = [];
    let previous = genesisReceipt(tenderId);
    const append = (link: Omit<ReceiptLink, 'receivedAt'>) => {
      const full: ReceiptLink = { ...link, receivedAt: new Date(base + links.length) };
      const receipt = nextReceipt(tenderId, previous, full);
      links.push({ ...full, seq: links.length + 1, previousReceipt: previous, receipt });
      previous = receipt;
    };
    for (const bid of withdrawn) {
      append({
        bidId: bid.bidId,
        revision: 1,
        ciphertextSha256: withdrawnSeal.ciphertextSha256,
        contentCommitment: withdrawnSeal.contentCommitment,
      });
    }
    for (let revision = 1; revision <= shape.revisions; revision += 1) {
      for (const bid of standing) {
        const newest = revision === shape.revisions;
        append({
          bidId: bid.bidId,
          revision,
          ciphertextSha256: newest ? bid.sealed.ciphertextSha256 : hex(),
          contentCommitment: newest ? bid.sealed.contentCommitment : hex(),
        });
      }
    }
    expect(links).toHaveLength(shape.standing * shape.revisions + shape.withdrawn);
    expect(links.length).toBeLessThanOrEqual(MAX_RECEIPTS);
    const firstOf = new Map<string, Date>();
    const newestOf = new Map<string, Date>();
    for (const link of links) {
      if (!firstOf.has(link.bidId)) firstOf.set(link.bidId, link.receivedAt);
      newestOf.set(link.bidId, link.receivedAt);
    }

    const actor = newUserId();
    const row = (
      bid: { bidId: string; bidderOrganizationId: string },
      sealed: SealedBid,
      revision: number,
      status: 'SUBMITTED' | 'WITHDRAWN',
    ) => ({
      id: bid.bidId,
      organizationId: owner,
      tenderId,
      bidderOrganizationId: bid.bidderOrganizationId,
      status,
      revision,
      sealVersion: sealed.version,
      keyId: sealed.keyId,
      nonce: new Uint8Array(sealed.nonce),
      ciphertext: new Uint8Array(sealed.ciphertext),
      tag: new Uint8Array(sealed.tag),
      wrappedContentKey: new Uint8Array(sealed.wrappedContentKey),
      contentCommitment: sealed.contentCommitment,
      ciphertextSha256: sealed.ciphertextSha256,
      submittedAt: firstOf.get(bid.bidId)!,
      receivedAt: newestOf.get(bid.bidId)!,
      submittedBy: actor,
      updatedAt: newestOf.get(bid.bidId)!,
      updatedBy: actor,
      ...(status === 'WITHDRAWN' ? { withdrawnAt: newestOf.get(bid.bidId)! } : {}),
    });
    const rows = [
      ...standing.map((bid) => row(bid, bid.sealed, shape.revisions, 'SUBMITTED')),
      ...withdrawn.map((bid) => row(bid, withdrawnSeal, 1, 'WITHDRAWN')),
    ];
    await runUnscoped('the suite writes the history a full tender would have', async () => {
      for (let from = 0; from < rows.length; from += 1_000) {
        await w.prisma.client.bid.createMany({ data: rows.slice(from, from + 1_000) });
      }
      for (let from = 0; from < links.length; from += 1_000) {
        await w.prisma.client.bidReceipt.createMany({
          data: links.slice(from, from + 1_000).map((link) => ({
            tenderId,
            organizationId: owner,
            seq: link.seq,
            bidId: link.bidId,
            revision: link.revision,
            receivedAt: link.receivedAt,
            ciphertextSha256: link.ciphertextSha256,
            contentCommitment: link.contentCommitment,
            previousReceipt: link.previousReceipt,
            receipt: link.receipt,
            eligibleAsOf: link.receivedAt,
          })),
        });
      }
    });
    // What audit-service holds for it.
    const evidence: TenderChain = {
      tenderId,
      genesis: genesisReceipt(tenderId),
      head: previous,
      links: links.map((link) => ({
        seq: link.seq,
        bidId: link.bidId,
        revision: link.revision,
        receivedAt: link.receivedAt.toISOString(),
        ciphertextSha256: link.ciphertextSha256,
        contentCommitment: link.contentCommitment,
        previousReceipt: link.previousReceipt,
        receipt: link.receipt,
      })),
    };
    w.evidence.served.set(tenderId, evidence);

    await runUnscoped('the suite lets the deadline pass', () =>
      w.prisma.client.$executeRawUnsafe(
        `UPDATE "tender" SET "bid_opening_at" = now() - interval '2 hours',
           "bid_closing_at" = now() - interval '1 minute' WHERE "id" = '${tenderId}'`,
      ),
    );
    await w.tenderClose.close({ organizationId: owner, tenderId });
    report(
      `${shape.label}: seeded ${rows.length} bids / ${links.length} receipts in ` +
        `${Math.round(performance.now() - seededAt)} ms`,
    );

    // What one walk of the chain costs here: once per bid was the defect of round 1.
    const walkStarted = performance.now();
    verifyReceipts(tenderId, { links, head: previous });
    const walkMs = performance.now() - walkStarted;

    // Four eyes, as configured by default: one proposes, another approves (and opens).
    const [proposer, approver] = [newUserId(), newUserId()];
    await asAdmin(owner, () => w.tenderOpen.proposeOpening(tenderId), proposer);
    const openStarted = performance.now();
    const opened = await asAdmin(owner, () => w.tenderOpen.open(tenderId), approver);
    const openMs = performance.now() - openStarted;

    expect(opened).toMatchObject({
      status: 'EVALUATING',
      bidCount: shape.standing,
      alreadyOpened: false,
    });
    const statuses = await runUnscoped('the suite reads the bids it opened', () =>
      w.prisma.client.bid.groupBy({ by: ['status'], where: { tenderId }, _count: true }),
    );
    expect(Object.fromEntries(statuses.map((group) => [group.status, group._count]))).toEqual({
      OPENED: shape.standing,
      ...(shape.withdrawn > 0 ? { WITHDRAWN: shape.withdrawn } : {}),
    });
    const openRows = await runUnscoped('the suite counts the access rows', () =>
      w.prisma.client.bidAccessLog.count({ where: { tenderId, purpose: 'OPEN_BIDS' } }),
    );
    expect(openRows).toBe(shape.standing);

    // The owner's read of every opened bid repeats the opening's work, under the same bound.
    const readStarted = performance.now();
    const read = await asAdmin(owner, () => w.tenderOpen.listBids(tenderId));
    const readMs = performance.now() - readStarted;
    expect(read.bids).toHaveLength(shape.standing);
    const prices = new Map(read.bids.map((bid) => [bid.bidId, bid.content.priceMinor]));
    for (const bid of standing) expect(prices.get(bid.bidId)).toBe(bid.price);

    report(
      `${shape.label}: one chain walk ${Math.round(walkMs)} ms; open ${Math.round(openMs)} ms; ` +
        `list ${Math.round(readMs)} ms; timeout ${TIMEOUT_MS} ms`,
    );
    // The whole call — evidence read and verification included, which run outside the
    // transaction — fits in the transaction's own bound, with at least half of it to spare.
    expect(openMs).toBeLessThan(TIMEOUT_MS / 2);
    expect(readMs).toBeLessThan(TIMEOUT_MS / 2);
  };

  it(`opens ${MAX_BIDS} standing bids of ${MAX_SHARED_REVISIONS} revisions each — the longest chain under the most decryptions — within CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS`, async () => {
    await openAtScale({
      label: `${MAX_BIDS} bids x ${MAX_SHARED_REVISIONS} revisions`,
      standing: MAX_BIDS,
      revisions: MAX_SHARED_REVISIONS,
      withdrawn: 0,
    });
  });

  it(`opens ${MAX_BIDS} standing bids of one revision each within CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS`, async () => {
    await openAtScale({
      label: `${MAX_BIDS} bids x 1 revision`,
      standing: MAX_BIDS,
      revisions: 1,
      withdrawn: 0,
    });
  });

  it(`opens ${MAX_BIDS} standing bids beside ${MAX_RECEIPTS - MAX_BIDS} withdrawn ones — the most organizations the receipt cap admits — within CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS`, async () => {
    await openAtScale({
      label: `${MAX_BIDS} bids x 1 revision + ${MAX_RECEIPTS - MAX_BIDS} withdrawn`,
      standing: MAX_BIDS,
      revisions: 1,
      withdrawn: MAX_RECEIPTS - MAX_BIDS,
    });
  });
});
