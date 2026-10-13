import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getContext } from '@rasta/nest-common';
import { withFinancialSpan } from '@rasta/observability';
import type { CursorPage } from '@rasta/contracts';
import type { Bid, Tender, TenderCriterion } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { ProjectAccess } from '../access/access';
import { SERVICE_NAME, type ConstructionEnv } from '../config/env';
import { tenderTransitionsTotal, versionConflictsTotal } from '../observability/metrics';
import { transactionNow } from '../shared/clock';
import {
  IdempotencyStore,
  canonicalise,
  requiredIdempotencyKey,
  targeted,
  type RecordCompletion,
  type RequestHasher,
} from '../shared/idempotency';
import { isUniqueViolation } from '../shared/prisma-errors';
import { ENV, TENDER_KEY_PROVIDER } from '../tokens';
import type { RequestDigestContext, TenderKeyProvider } from './sealing/key-provider';
import { StandingAuthority } from './standing-authority';
import { BidRepository, type LockedTenderForBid } from './bid.repository';
import { TenderClock, insideWindow } from './tender-clock';
import { SealingError } from './sealing/errors';
import {
  genesisReceipt,
  nextReceipt,
  sealBid,
  type BidBinding,
  type SealedBid,
} from './sealing/sealing';
import type {
  BidContent,
  BidReceiptView,
  OpenTenderView,
  ReviseBidDto,
  SubmitBidDto,
  WithdrawBidDto,
} from './bid.dto';
import { ruleRefusal } from '../shared/refusal';

/** The closed codes a refused bid names in its 422 message (never any content). */
export const BID_REFUSALS = [
  'BID_WINDOW_NOT_OPEN',
  'BID_WINDOW_CLOSED',
  'BIDDER_NOT_ELIGIBLE',
  'OWN_TENDER',
  'UNKNOWN_CRITERION',
  'BID_TOO_LARGE',
  'BID_NOT_SUBMITTED',
  'BID_REVISION_LIMIT',
  'TENDER_RECEIPT_LIMIT',
] as const;
export type BidRefusal = (typeof BID_REFUSALS)[number];

const OWN_BID_RECEIPT = 'OWN_BID_RECEIPT';

/** The endpoint template a bid submission's `Idempotency-Key` is stored under (docs/06 § 6.8). */
export const SUBMIT_BID_ENDPOINT = 'POST /v1/tenders/:id/bids';

/**
 * Submitting, replacing and withdrawing a bid, and reading one's own receipt
 * (ADR-065 § 1-2, ADR-066).
 *
 * ## One transaction, one order
 *
 * The tender row is locked `FOR SHARE` first (bids share it; `close` and
 * `open-bids` take it `FOR UPDATE`, so a bid and a closing queue behind one
 * another). **Then** the decision instant is read from the tender clock — the
 * database's `clock_timestamp()` — and the window `[bid_opening_at,
 * bid_closing_at)` is judged on it. A bid arriving at the closing instant is
 * refused, a long wait for the lock cannot slip a bid past the deadline, and a
 * tender the sweeper has not yet closed still refuses (the status is not what is
 * trusted, the clock is). The database's own `bid_guard` trigger judges again.
 *
 * Eligibility (qualified for CONTRACTING, not suspended) is an **authoritative
 * decision**: asked of supplier-service for this one contractor at submit and
 * replace time (`StandingAuthority`), never taken from this service's read model,
 * which is advisory. It is asked **before** the transaction, so a slow
 * supplier-service holds no tender lock, and it fails closed: unreachable is a
 * 503/504, an organization nobody knows is not eligible.
 *
 * A bid the database refuses for the window after the application judged it inside
 * (the deadline crossing between the decision and the write) is the same refusal,
 * `422 BID_WINDOW_CLOSED`, not a 500: `bid_guard` is the second check, and what it
 * refuses is a late bid.
 *
 * ## What is returned and published
 *
 * The bidder is given the receipt and the state, never the content. The receipt is
 * the new **head** of the tender's chain; `BID_SUBMITTED` / `BID_REVISED` carry it
 * with its predecessor and the digests, so audit-service holds the head outside this
 * service's database (ADR-066 § 2-3). Opening (PR 8) takes the head from there.
 */
@Injectable()
export class BidService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bids: BidRepository,
    private readonly standing: StandingAuthority,
    private readonly events: EventPublisher,
    private readonly access: ProjectAccess,
    private readonly clock: TenderClock,
    private readonly idempotency: IdempotencyStore,
    @Inject(TENDER_KEY_PROVIDER) private readonly keys: TenderKeyProvider,
    @Inject(ENV) private readonly env: ConstructionEnv,
  ) {}

  /**
   * The bid's request, recognised under a keyed, salted digest bound to the bidder organization and
   * user who made it (see `submit`). No KEK means no tender could have been published, so no bid can
   * arrive; it is an error, never an unkeyed fallback.
   */
  private requestHasherOf(requester: RequestDigestContext): RequestHasher {
    return {
      hash: (body) =>
        this.digestOrFail(() => this.keys.requestDigest(requester, canonicalise(body))),
      matches: (stored, body) =>
        this.keys.matchesRequestDigest(stored, requester, canonicalise(body)),
    };
  }

  private digestOrFail(digest: () => string): string {
    try {
      return digest();
    } catch (error) {
      if (error instanceof SealingError) {
        throw RastaError.internal('No key is configured to recognise a bid request');
      }
      throw error;
    }
  }

  // -- what a bidder may bid on -------------------------------------------------

  async listOpenTenders(query: {
    cursor?: string;
    limit: number;
  }): Promise<CursorPage<OpenTenderView>> {
    const { organizationId } = this.access.assertCanBid();
    const rows = await this.bids.listOpenTenders(organizationId, query);
    const hasMore = rows.length > query.limit;
    const visible = hasMore ? rows.slice(0, query.limit) : rows;
    const items = await Promise.all(
      visible.map(async (row) => toOpenTenderView(row, await this.bids.listCriteriaOf(row.id))),
    );
    return {
      items,
      nextCursor: hasMore ? (visible[visible.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  async getOpenTender(tenderId: string): Promise<OpenTenderView> {
    const { organizationId } = this.access.assertCanBid();
    const row = await this.bids.findOpenTender(tenderId, organizationId);
    if (!row) throw RastaError.notFound('Tender', tenderId);
    return toOpenTenderView(row, await this.bids.listCriteriaOf(row.id));
  }

  // -- submit -------------------------------------------------------------------

  /**
   * Submits the caller's organization's one bid. The `Idempotency-Key` is **mandatory** (docs/06
   * § 6.8, «ثبت پیشنهاد»; construction audit F4), judged here so a direct call is held to it too:
   * the key belongs to the bidder's organization (the store keys on the acting organization), the
   * request is the tender id and the body, and the receipt is stored with the bid, its receipt and
   * its outbox row in one transaction. A retry with the same key and body answers that receipt and
   * writes nothing; any failure — a refusal, an unreachable supplier-service, a 5xx — releases the
   * key so the request can be made again. The role is checked before the key is looked at: a replay
   * is for a bidder only.
   *
   * The stored request hash is **keyed** (`TenderKeyProvider.requestDigest`), not the plain SHA-256
   * the other construction commands store: the body is the price, and an unkeyed hash of a
   * low-entropy price would let a reader of a backup guess it (ADR-066 § 1). It is also salted per
   * claim and bound to the bidder organization **and** user (Codex r1 on #250, R1): the claim is
   * committed before eligibility, uniqueness and the window are judged, so a digest comparable
   * across claims would let anyone with read access to the database and a contractor account
   * confirm a competitor's guessed price by submitting candidates. A replay is recognised with the
   * stored salt; the same key from another user of the organization is a different request
   * (`409 IDEMPOTENCY_KEY_REUSED`), as with a score's evaluator.
   */
  async submit(
    tenderId: string,
    dto: SubmitBidDto,
    idempotencyKey: string | undefined,
  ): Promise<BidReceiptView> {
    const { organizationId: bidder, actor } = this.access.assertCanBid();
    const key = requiredIdempotencyKey(idempotencyKey);
    return this.idempotency.run(
      SUBMIT_BID_ENDPOINT,
      key,
      targeted(tenderId, dto),
      201,
      (record) => this.submitOnce(tenderId, dto, bidder, actor, record),
      this.requestHasherOf({ organizationId: bidder, userId: actor }),
    );
  }

  private async submitOnce(
    tenderId: string,
    dto: SubmitBidDto,
    bidder: string,
    actor: string,
    record: RecordCompletion<BidReceiptView>,
  ): Promise<BidReceiptView> {
    const bidId = newId(ID_PREFIX.bid);
    const eligibleAsOf = await this.assertEligible(tenderId, bidder);

    try {
      const view = await withFinancialSpan(
        'construction.bid.submit',
        () =>
          this.prisma.transaction(async (tx) => {
            const { tender, at, criteria } = await this.decide(tx, tenderId, bidder);

            if (await this.bids.findBidOf(tx, tenderId, bidder)) {
              throw RastaError.alreadyExists('Bid', tenderId);
            }
            this.assertAnswersKnown(dto.content, criteria);
            const key = await this.bids.findKey(tx, tenderId);
            if (!key)
              throw RastaError.internal('A published tender has no key; no bid can be sealed');

            const sealed = this.seal(key.publicKeyPem, content(dto), {
              tenderId,
              bidId,
              bidderOrganizationId: bidder,
              revision: 1,
              keyId: key.keyId,
            });

            await this.bids.insertBid(tx, {
              id: bidId,
              organizationId: tender.organizationId,
              tenderId,
              bidderOrganizationId: bidder,
              sealed,
              actor,
              at,
            });
            const receipt = await this.appendAndAnnounce(tx, {
              eventName: 'BID_SUBMITTED',
              owner: tender.organizationId,
              tenderId,
              bidId,
              bidder,
              revision: 1,
              sealed,
              actor,
              at,
              eligibleAsOf,
            });
            // The receipt and the key's completion commit with the bid, or none of them does.
            await record(tx, bidId, receipt);
            return receipt;
          }),
        { 'rasta.tender.command': 'bid-submit' },
      );
      tenderTransitionsTotal.inc({ service: SERVICE_NAME, command: 'bid-submit' });
      return view;
    } catch (error) {
      if (isUniqueViolation(error)) throw RastaError.alreadyExists('Bid', tenderId);
      throw this.lateWrite(error, tenderId);
    }
  }

  // -- revise -------------------------------------------------------------------

  async revise(tenderId: string, bidId: string, dto: ReviseBidDto): Promise<BidReceiptView> {
    const { organizationId: bidder, actor } = this.access.assertCanBid();
    const eligibleAsOf = await this.assertEligible(tenderId, bidder);

    const view = await withFinancialSpan(
      'construction.bid.revise',
      () =>
        this.prisma
          .transaction(async (tx) => {
            const { tender, at, criteria } = await this.decide(tx, tenderId, bidder);
            const locked = await this.lockOwnBid(tx, tenderId, bidId, bidder);
            this.assertRevision(locked, dto.expectedRevision);
            const revision = dto.expectedRevision + 1;
            // Under the bid's lock: a bid has at most so many revisions (F2), so that no one
            // bidder can fill the tender's chain.
            if (revision > this.env.CONSTRUCTION_BID_MAX_REVISIONS) {
              throw this.refused(bidId, ['BID_REVISION_LIMIT']);
            }
            this.assertAnswersKnown(dto.content, criteria);
            const key = await this.bids.findKey(tx, tenderId);
            if (!key)
              throw RastaError.internal('A published tender has no key; no bid can be sealed');

            const sealed = this.seal(key.publicKeyPem, content(dto), {
              tenderId,
              bidId,
              bidderOrganizationId: bidder,
              revision,
              keyId: key.keyId,
            });
            const matched = await this.bids.replaceSeal(tx, {
              bidId,
              bidderOrganizationId: bidder,
              expectedRevision: dto.expectedRevision,
              sealed,
              actor,
              at,
            });
            if (matched === 0) throw this.conflict(bidId);

            return this.appendAndAnnounce(tx, {
              eventName: 'BID_REVISED',
              owner: tender.organizationId,
              tenderId,
              bidId,
              bidder,
              revision,
              sealed,
              actor,
              at,
              eligibleAsOf,
            });
          })
          .catch((error: unknown) => {
            throw this.lateWrite(error, tenderId);
          }),
      { 'rasta.tender.command': 'bid-revise' },
    );
    tenderTransitionsTotal.inc({ service: SERVICE_NAME, command: 'bid-revise' });
    return view;
  }

  // -- withdraw -----------------------------------------------------------------

  async withdraw(tenderId: string, bidId: string, dto: WithdrawBidDto): Promise<BidReceiptView> {
    const { organizationId: bidder, actor } = this.access.assertCanBid();

    const view = await withFinancialSpan(
      'construction.bid.withdraw',
      () =>
        this.prisma
          .transaction(async (tx) => {
            // Withdrawing is judged like a submission: before the deadline only.
            // Eligibility is not asked again: a contractor suspended since may still
            // take its bid back.
            const { tender, at } = await this.decide(tx, tenderId, bidder);
            const locked = await this.lockOwnBid(tx, tenderId, bidId, bidder);
            this.assertRevision(locked, dto.expectedRevision);

            const matched = await this.bids.withdraw(tx, {
              bidId,
              bidderOrganizationId: bidder,
              expectedRevision: dto.expectedRevision,
              actor,
              at,
            });
            if (matched === 0) throw this.conflict(bidId);

            await this.events.enqueue(tx, {
              eventName: 'BID_WITHDRAWN',
              aggregateId: tenderId,
              organizationId: tender.organizationId,
              payload: {
                bidId,
                tenderId,
                organizationId: tender.organizationId,
                bidderOrganizationId: bidder,
                revision: dto.expectedRevision,
                withdrawnAt: at.toISOString(),
                withdrawnBy: actor,
              },
              occurredAt: at,
            });
            return this.ownView(tx, tenderId, bidder, bidId);
          })
          .catch((error: unknown) => {
            throw this.lateWrite(error, tenderId);
          }),
      { 'rasta.tender.command': 'bid-withdraw' },
    );
    tenderTransitionsTotal.inc({ service: SERVICE_NAME, command: 'bid-withdraw' });
    return view;
  }

  // -- read one's own bid (audited) ---------------------------------------------

  /**
   * The caller's own receipt, revision and state on a tender; **no content**
   * (ADR-066 § 4: before the opening nobody reads it). Every call is audited in
   * the same transaction (ADR-066 § 5): a `bid_access_log` row and a `BID_ACCESSED`
   * event, granted or refused — a refused read commits its row and then answers
   * 404. A failed write of the log fails the read (fail closed).
   */
  async getMine(tenderId: string): Promise<BidReceiptView> {
    const { organizationId: bidder, actor } = this.access.assertCanBid();

    const found = await this.prisma.transaction(async (tx) => {
      const tender = await this.bids.findTenderRow(tx, tenderId);
      // A tender that does not exist has no owner whose log could hold the attempt.
      if (!tender) return null;
      const at = await transactionNow(tx);
      const bid = await this.bids.findBidOf(tx, tenderId, bidder);
      await this.logRead(tx, {
        owner: tender.organizationId,
        tenderId,
        bidId: bid?.id ?? null,
        bidder,
        actor,
        outcome: bid ? 'GRANTED' : 'REFUSED',
        at,
      });
      return bid ? toReceiptView(bid, await this.lastReceipt(tx, tenderId, bid)) : undefined;
    });
    if (!found) throw RastaError.notFound('Bid', tenderId);
    return found;
  }

  // -- helpers ------------------------------------------------------------------

  /**
   * Locks the tender (shared), judges visibility and the window on the decision
   * instant read after the lock, and returns what the command needs.
   */
  private async decide(
    tx: ExtendedPrismaClient,
    tenderId: string,
    bidder: string,
  ): Promise<{ tender: LockedTenderForBid; at: Date; criteria: TenderCriterion[] }> {
    const tender = await this.bids.lockTenderShared(tx, tenderId);
    // Not visible is not found: a draft, another's restricted tender, a stranger's —
    // the bidder learns nothing (ADR-065 § 4).
    if (!tender || tender.status === 'DRAFT') throw RastaError.notFound('Tender', tenderId);
    if (tender.organizationId === bidder) {
      throw this.refused(tenderId, ['OWN_TENDER']);
    }
    if (
      tender.visibility !== 'PUBLIC' &&
      !(await this.bids.isInvited(tx, tender.organizationId, tenderId, bidder))
    ) {
      throw RastaError.notFound('Tender', tenderId);
    }

    // After the lock, from the tender clock: never the application's clock and never
    // the transaction's start (ADR-065 § 2).
    const at = await this.clock.decisionInstant(tx);
    const refusals: BidRefusal[] = [];
    if (tender.status !== 'PUBLISHED' || !tender.bidOpeningAt || !tender.bidClosingAt) {
      refusals.push('BID_WINDOW_CLOSED');
    } else if (at.getTime() < tender.bidOpeningAt.getTime()) {
      refusals.push('BID_WINDOW_NOT_OPEN');
    } else if (!insideWindow(at, tender.bidOpeningAt, tender.bidClosingAt)) {
      refusals.push('BID_WINDOW_CLOSED');
    }
    if (refusals.length > 0) throw this.refused(tenderId, refusals);

    return { tender, at, criteria: await this.bids.listCriteria(tx, tenderId) };
  }

  /**
   * Is the contractor eligible right now? Asked of supplier-service, **outside** any
   * transaction (see the class header). A tender the caller may not see is not
   * judged here at all: the refusal order must not tell a stranger more than the
   * 404 does, so an ineligible contractor on a tender it can see is refused, and
   * the visibility rules still answer 404 inside the transaction.
   */
  private async assertEligible(tenderId: string, bidder: string): Promise<Date> {
    const { verdict, asOf } = await this.standing.decisionFor(bidder);
    if (verdict !== 'ELIGIBLE') throw this.refused(tenderId, ['BIDDER_NOT_ELIGIBLE']);
    return asOf;
  }

  /**
   * The database refused a write for the window after the application judged it
   * inside — the deadline crossed between the decision and the write. That is a late
   * bid: `422 BID_WINDOW_CLOSED`, with nothing committed, not a 500.
   */
  private lateWrite(error: unknown, subject: string): unknown {
    const message = (error as { message?: string } | null)?.message ?? '';
    return message.includes('ck_bid_window') ? this.refused(subject, ['BID_WINDOW_CLOSED']) : error;
  }

  private async lockOwnBid(
    tx: ExtendedPrismaClient,
    tenderId: string,
    bidId: string,
    bidder: string,
  ) {
    const locked = await this.bids.lockBid(tx, tenderId, bidId, bidder);
    // Another bidder's bid, or none: 404 either way.
    if (!locked) throw RastaError.notFound('Bid', bidId);
    return locked;
  }

  private assertRevision(
    locked: { id: string; status: string; revision: number },
    expected: number,
  ) {
    if (locked.revision !== expected) throw this.conflict(locked.id);
    if (locked.status !== 'SUBMITTED') throw this.refused(locked.id, ['BID_NOT_SUBMITTED']);
  }

  private assertAnswersKnown(contentValue: BidContent, criteria: readonly TenderCriterion[]): void {
    const known = new Set(criteria.map((criterion) => criterion.code));
    if (contentValue.answers.some((answer) => !known.has(answer.criterionCode))) {
      throw this.refused('bid', ['UNKNOWN_CRITERION']);
    }
  }

  private seal(publicKeyPem: string, contentValue: BidContent, binding: BidBinding): SealedBid {
    try {
      return sealBid({ publicKeyPem, binding, content: contentValue });
    } catch (error) {
      if (error instanceof SealingError) {
        if (error.code === 'INVALID_CONTENT') throw this.refused(binding.bidId, ['BID_TOO_LARGE']);
        throw RastaError.internal('A bid could not be sealed');
      }
      throw error;
    }
  }

  /**
   * Appends the bid's link to the tender's chain (serialised by the advisory lock)
   * and publishes it: the receipt is the new head, with its predecessor and the
   * digests, so a holder outside this database can verify it (ADR-066 § 3).
   */
  private async appendAndAnnounce(
    tx: ExtendedPrismaClient,
    input: {
      eventName: 'BID_SUBMITTED' | 'BID_REVISED';
      owner: string;
      tenderId: string;
      bidId: string;
      bidder: string;
      revision: number;
      sealed: SealedBid;
      actor: string;
      at: Date;
      /** When supplier-service read the contractor's standing for this revision. */
      eligibleAsOf: Date;
    },
  ): Promise<BidReceiptView> {
    const slot = await this.bids.nextReceiptSlot(tx, input.tenderId);
    // Under the chain's advisory lock, in the bid's transaction: a receipt past what
    // audit-service returns would leave a tender that can never be opened (F2). The refusal
    // rolls the bid back with it.
    if (slot.seq > this.env.CONSTRUCTION_TENDER_MAX_RECEIPTS) {
      throw this.refused(input.tenderId, ['TENDER_RECEIPT_LIMIT']);
    }
    const previous = slot.previousReceipt ?? genesisReceipt(input.tenderId);
    const link = {
      bidId: input.bidId,
      revision: input.revision,
      receivedAt: input.at,
      ciphertextSha256: input.sealed.ciphertextSha256,
      contentCommitment: input.sealed.contentCommitment,
    };
    const receipt = nextReceipt(input.tenderId, previous, link);
    await this.bids.insertReceipt(tx, {
      tenderId: input.tenderId,
      organizationId: input.owner,
      seq: slot.seq,
      ...link,
      previousReceipt: previous,
      receipt,
      eligibleAsOf: input.eligibleAsOf,
    });

    await this.events.enqueue(tx, {
      eventName: input.eventName,
      aggregateId: input.tenderId,
      organizationId: input.owner,
      payload: {
        bidId: input.bidId,
        tenderId: input.tenderId,
        organizationId: input.owner,
        bidderOrganizationId: input.bidder,
        revision: input.revision,
        receivedAt: input.at.toISOString(),
        contentCommitment: input.sealed.contentCommitment,
        ciphertextSha256: input.sealed.ciphertextSha256,
        previousReceipt: previous,
        receipt,
        submittedBy: input.actor,
      },
      occurredAt: input.at,
    });
    return this.ownView(tx, input.tenderId, input.bidder, input.bidId);
  }

  /** The bidder's own bid, read inside the transaction that wrote it. */
  private async ownView(
    tx: ExtendedPrismaClient,
    tenderId: string,
    bidder: string,
    bidId: string,
  ): Promise<BidReceiptView> {
    const bid = await this.bids.findBidOf(tx, tenderId, bidder);
    if (!bid || bid.id !== bidId) throw RastaError.notFound('Bid', bidId);
    return toReceiptView(bid, await this.lastReceipt(tx, tenderId, bid));
  }

  private async lastReceipt(tx: ExtendedPrismaClient, tenderId: string, bid: Bid): Promise<string> {
    const receipt = await this.bids.receiptOf(tx, tenderId, bid.id, bid.revision);
    return receipt ?? '';
  }

  private async logRead(
    tx: ExtendedPrismaClient,
    input: {
      owner: string;
      tenderId: string;
      bidId: string | null;
      bidder: string;
      actor: string;
      outcome: 'GRANTED' | 'REFUSED';
      at: Date;
    },
  ): Promise<void> {
    await this.bids.insertAccess(tx, {
      id: newId(ID_PREFIX.bidAccess),
      organizationId: input.owner,
      tenderId: input.tenderId,
      bidId: input.bidId,
      accessorOrganizationId: input.bidder,
      accessorUserId: input.actor,
      purpose: OWN_BID_RECEIPT,
      outcome: input.outcome,
      refusalCode: input.outcome === 'REFUSED' ? 'NOT_FOUND' : null,
      at: input.at,
    });
    await this.events.enqueue(tx, {
      eventName: 'BID_ACCESSED',
      aggregateId: input.tenderId,
      organizationId: input.owner,
      payload: {
        bidId: input.bidId,
        tenderId: input.tenderId,
        organizationId: input.owner,
        accessorOrganizationId: input.bidder,
        accessedBy: input.actor,
        purpose: OWN_BID_RECEIPT,
        outcome: input.outcome,
        refusalCode: input.outcome === 'REFUSED' ? 'NOT_FOUND' : null,
        accessedAt: input.at.toISOString(),
      },
      occurredAt: input.at,
    });
  }

  private refused(subject: string, refusals: readonly BidRefusal[]): RastaError {
    return ruleRefusal(`Bid refused: ${refusals.join(', ')}`, 'bid', refusals, {
      subject,
      correlationId: getContext().correlationId,
    });
  }

  private conflict(bidId: string): RastaError {
    versionConflictsTotal.inc({ service: SERVICE_NAME, aggregate: 'Bid' });
    return RastaError.optimisticLockFailed('Bid', bidId);
  }
}

const content = (dto: { content: BidContent }): BidContent => dto.content;

function toReceiptView(bid: Bid, receipt: string): BidReceiptView {
  return {
    bidId: bid.id,
    tenderId: bid.tenderId,
    status: bid.status,
    revision: bid.revision,
    receivedAt: bid.receivedAt.toISOString(),
    contentCommitment: bid.contentCommitment,
    receipt,
    withdrawnAt: bid.withdrawnAt?.toISOString() ?? null,
  };
}

function toOpenTenderView(row: Tender, criteria: readonly TenderCriterion[]): OpenTenderView {
  return {
    id: row.id,
    title: row.title,
    scopeOfWork: row.scopeOfWork,
    procurementNature: row.procurementNature,
    visibility: row.visibility ?? 'PUBLIC',
    bidOpeningAt: row.bidOpeningAt?.toISOString() ?? '',
    bidClosingAt: row.bidClosingAt?.toISOString() ?? '',
    criteria: criteria.map((criterion) => ({
      code: criterion.code,
      label: criterion.label,
      weightBp: criterion.weightBp,
      scoringMethod: criterion.scoringMethod,
      maxScore: criterion.maxScore,
    })),
  };
}
