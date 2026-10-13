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
 * Opening the largest tender the default caps permit (Codex r1 on #250, R2).
 *
 * `CONSTRUCTION_TENDER_MAX_RECEIPTS` (10,000) and `CONSTRUCTION_BID_MAX_REVISIONS` (50) let 200
 * bidders revise to the limit: 10,000 receipts and 200 standing bids. The opening verifies the
 * chain, decrypts every standing bid and writes an access row and event for each, in one
 * transaction under the tender's lock. Verified once per bid, the chain alone took ~30 s at this
 * size; verified once per opening, the whole opening must fit — with room — in the default
 * `CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS`, or the defaults are wrong.
 *
 * The bids and receipts are written directly, as a full submission history would have left them
 * (10,000 submissions through the service would take minutes and prove nothing more here; the
 * submission path and its caps are `bids.int-spec.ts`). Only each bid's newest revision is sealed
 * bytes: earlier revisions survive only as links in the chain, exactly as after real revisions.
 * The evidence is that chain as audit-service would serve it. The opening and the read are the
 * service's own, with the default configuration.
 */

const BIDDERS = 200;
const env = testEnv();
const REVISIONS = env.CONSTRUCTION_BID_MAX_REVISIONS;
const TIMEOUT_MS = env.CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS;

jest.setTimeout(600_000);

const hex = (): string => createHash('sha256').update(randomBytes(32)).digest('hex');
const report = (line: string): void => {
  process.stdout.write(`[tender-open-scale] ${line}\n`);
};

describe('opening at the default caps (Codex r1 on #250, R2)', () => {
  let w: Wiring;
  const organizations: string[] = [];

  beforeAll(() => {
    w = wire(env);
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  it(`opens ${BIDDERS} bids of ${REVISIONS} revisions each — the full receipt cap — within CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS`, async () => {
    expect(BIDDERS * REVISIONS).toBe(env.CONSTRUCTION_TENDER_MAX_RECEIPTS);
    expect(env.CONSTRUCTION_TENDER_MAX_RECEIPTS).toBe(EVIDENCE_MAX_CHAIN_LINKS);

    const owner = newOrganizationId();
    organizations.push(owner);
    const { tenderId, keyId } = await publishedForBids(w, owner);
    const key = await runUnscoped('the suite reads the tender key', () =>
      w.prisma.client.tenderKey.findFirstOrThrow({ where: { tenderId } }),
    );

    // Each bidder's newest revision, sealed; its price is its index, to be read back.
    const seededAt = performance.now();
    const base = Date.now() - 30 * 60_000;
    const bids = Array.from({ length: BIDDERS }, (_, i) => {
      const bidderOrganizationId = newOrganizationId();
      organizations.push(bidderOrganizationId);
      const bidId = newId(ID_PREFIX.bid);
      const sealed = sealBid({
        publicKeyPem: key.publicKeyPem,
        binding: { tenderId, bidId, bidderOrganizationId, revision: REVISIONS, keyId },
        content: bidContent(String(1_000_000 + i)),
      });
      return { bidId, bidderOrganizationId, sealed, price: String(1_000_000 + i) };
    });

    // The chain: revision by revision, every bidder in turn, so each bid's newest receipt is late.
    type Link = ReceiptLink & { seq: number; previousReceipt: string; receipt: string };
    const links: Link[] = [];
    let previous = genesisReceipt(tenderId);
    for (let revision = 1; revision <= REVISIONS; revision += 1) {
      for (const bid of bids) {
        const newest = revision === REVISIONS;
        const link: ReceiptLink = {
          bidId: bid.bidId,
          revision,
          receivedAt: new Date(base + links.length),
          ciphertextSha256: newest ? bid.sealed.ciphertextSha256 : hex(),
          contentCommitment: newest ? bid.sealed.contentCommitment : hex(),
        };
        const receipt = nextReceipt(tenderId, previous, link);
        links.push({ ...link, seq: links.length + 1, previousReceipt: previous, receipt });
        previous = receipt;
      }
    }
    const firstOf = new Map<string, Date>();
    const newestOf = new Map<string, Date>();
    for (const link of links) {
      if (!firstOf.has(link.bidId)) firstOf.set(link.bidId, link.receivedAt);
      newestOf.set(link.bidId, link.receivedAt);
    }

    const actor = newUserId();
    await runUnscoped('the suite writes the history a full tender would have', async () => {
      await w.prisma.client.bid.createMany({
        data: bids.map((bid) => ({
          id: bid.bidId,
          organizationId: owner,
          tenderId,
          bidderOrganizationId: bid.bidderOrganizationId,
          status: 'SUBMITTED' as const,
          revision: REVISIONS,
          sealVersion: bid.sealed.version,
          keyId: bid.sealed.keyId,
          nonce: new Uint8Array(bid.sealed.nonce),
          ciphertext: new Uint8Array(bid.sealed.ciphertext),
          tag: new Uint8Array(bid.sealed.tag),
          wrappedContentKey: new Uint8Array(bid.sealed.wrappedContentKey),
          contentCommitment: bid.sealed.contentCommitment,
          ciphertextSha256: bid.sealed.ciphertextSha256,
          submittedAt: firstOf.get(bid.bidId)!,
          receivedAt: newestOf.get(bid.bidId)!,
          submittedBy: actor,
          updatedAt: newestOf.get(bid.bidId)!,
          updatedBy: actor,
        })),
      });
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
      `seeded ${BIDDERS} bids / ${links.length} receipts in ${Math.round(performance.now() - seededAt)} ms`,
    );

    // What one walk of the chain costs here: once per bid was the defect.
    const walkStarted = performance.now();
    verifyReceipts(tenderId, { links, head: previous });
    const walkMs = performance.now() - walkStarted;

    // Four eyes, as configured by default: one proposes, another approves (and opens).
    const [proposer, approver] = [newUserId(), newUserId()];
    await asAdmin(owner, () => w.tenderOpen.proposeOpening(tenderId), proposer);
    const openStarted = performance.now();
    const opened = await asAdmin(owner, () => w.tenderOpen.open(tenderId), approver);
    const openMs = performance.now() - openStarted;

    expect(opened).toMatchObject({ status: 'EVALUATING', bidCount: BIDDERS, alreadyOpened: false });
    const statuses = await runUnscoped('the suite reads the bids it opened', () =>
      w.prisma.client.bid.groupBy({ by: ['status'], where: { tenderId }, _count: true }),
    );
    expect(statuses).toEqual([{ status: 'OPENED', _count: BIDDERS }]);
    const openRows = await runUnscoped('the suite counts the access rows', () =>
      w.prisma.client.bidAccessLog.count({ where: { tenderId, purpose: 'OPEN_BIDS' } }),
    );
    expect(openRows).toBe(BIDDERS);

    // The owner's read of every opened bid repeats the opening's work, under the same bound.
    const readStarted = performance.now();
    const read = await asAdmin(owner, () => w.tenderOpen.listBids(tenderId));
    const readMs = performance.now() - readStarted;
    expect(read.bids).toHaveLength(BIDDERS);
    const prices = new Map(read.bids.map((bid) => [bid.bidId, bid.content.priceMinor]));
    for (const bid of bids) expect(prices.get(bid.bidId)).toBe(bid.price);

    report(
      `one chain walk ${Math.round(walkMs)} ms (x${BIDDERS} per-bid walks ≈ ${Math.round(walkMs * BIDDERS)} ms); ` +
        `open ${Math.round(openMs)} ms; list ${Math.round(readMs)} ms; timeout ${TIMEOUT_MS} ms`,
    );
    // The whole call — evidence read and verification included, which run outside the
    // transaction — fits in the transaction's own bound, with at least half of it to spare.
    expect(openMs).toBeLessThan(TIMEOUT_MS / 2);
    expect(readMs).toBeLessThan(TIMEOUT_MS / 2);
  });
});
