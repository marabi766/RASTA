import { Inject, Injectable } from '@nestjs/common';
import { RastaError, currentActor, getContext } from '@rasta/nest-common';
import { SealingError, canonicalize, type SealedEnvelope } from '@rasta/sealing';
import type { Quotation } from '../generated/prisma';
import { ProcurementAccess, type Acting } from '../access/access';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { DatabaseClock } from '../shared/clock';
import type { ClaimFence, RequestHasher } from '../shared/idempotency';
import { isGuardRefusal, isUniqueViolationOf, type UniqueIndex } from '../shared/prisma-errors';
import { ruleRefusal, type ReasonOf } from '../shared/refusal';
import { ENV, RFQ_KEY_PROVIDER, SUPPLIER_STANDING } from '../tokens';
import { QUOTATION_RECEIPT_CHAIN_LIMIT, SERVICE_NAME, type ProcurementEnv } from '../config/env';
import { rfqCommandsTotal } from '../observability/metrics';
import type { RfqKeyProvider } from '../rfq/key-provider';
import { RfqRepository, type RfqRecord } from '../rfq/rfq.repository';
import { deadlinePassed } from '../rfq/rfq.state-machine';
import { inviteeVerdictOf, type SupplierStandingSource } from '../rfq/supplier-standing.client';
import {
  MAX_AMOUNT_MINOR,
  type PutQuotationDto,
  type QuotationContent,
  type QuotationReceiptView,
  type WithdrawQuotationDto,
} from './dto';
import { QuotationRepository, type LockedRfqForQuotation } from './quotation.repository';
import { QUOTATION_SEALING } from './sealing';

type QuotationRefusal = ReasonOf<'quotation'>;

/**
 * Sealed quotations on an issued RFQ: the invited supplier submits one, revises it, withdraws it —
 * before the deadline — and is given its receipt (ADR-070 § 4; ADR-066 § 2-3; plan PR 8).
 *
 * ## Before the transaction: what can be refused without a lock
 *
 * The caller's role is judged before anything is read (an invited supplier's person,
 * `PROCUREMENT_SUPPLIER_ROLES`; never `AUDITOR`, `SYSTEM_ADMIN` or a service). Then the RFQ is
 * found through the caller organization's own invitation — none is 404, like an RFQ that does not
 * exist (ADR-070 § 10), and nothing else is asked. The content is judged against what the RFQ was
 * issued with, which never changes: one answer per criterion, and the amount `unitPriceMinor ×
 * totalQuantity` within 2^63 − 1 (`422 QUOTATION_AMOUNT_OUT_OF_RANGE`) — **before anything is
 * sealed or written** (ADR-070 § 4). Then, for a submission and a revision, the supplier's standing
 * is asked of supplier-service now, outside any transaction, fail closed (503/504 when it cannot
 * say; `eligible_as_of` is its answer's instant, kept with the receipt).
 *
 * ## One transaction, one order
 *
 * The RFQ is locked `FOR SHARE` (the close and the cancel take it `FOR UPDATE`, so a quotation and a
 * close queue behind one another and each order has one outcome), **then** the clock is read — the
 * database's, after the lock — and the half-open deadline judged on it: a quotation at
 * `quotationClosingAt` is refused, a lock wait cannot carry one past it, and an RFQ the sweeper has
 * not closed yet still refuses (the clock is trusted, not the status). The database judges again on
 * its own clock at the write (`ck_quotation_window`); a write it refuses after the service said yes
 * is the same `422 QUOTATION_WINDOW_CLOSED`, not a 500. Then the supplier's own quotation
 * `FOR UPDATE`, its revision (409) before its status (422), the seal, the receipt — the RFQ chain's
 * next link under its advisory lock — the event, and the stored idempotent response, together.
 *
 * ## What is returned and published
 *
 * The receipt and the state, never the content. `QUOTATION_SUBMITTED` / `QUOTATION_REVISED` carry
 * the receipt with its predecessor and the digests, so audit-service holds the chain outside this
 * database (plan PR 7) — never a price, an answer or a note (ADR-066 § 6). Nothing here logs the
 * content or the price either: the only messages are closed refusal codes.
 */
@Injectable()
export class QuotationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: QuotationRepository,
    private readonly rfqs: RfqRepository,
    private readonly access: ProcurementAccess,
    private readonly publisher: EventPublisher,
    private readonly clock: DatabaseClock,
    @Inject(SUPPLIER_STANDING) private readonly standing: SupplierStandingSource,
    @Inject(RFQ_KEY_PROVIDER) private readonly keys: RfqKeyProvider,
    @Inject(ENV) private readonly env: ProcurementEnv,
  ) {}

  /**
   * The idempotency store's recogniser for this caller's quotation requests — keyed, salted and
   * bound to the organization and the user (`RfqKeyProvider.requestDigest`): the request is the
   * price. The role is judged first, so a key is claimed only for an invited supplier's person.
   */
  requestHasher(): RequestHasher {
    const acting = this.access.assertQuotationSupplier();
    const requester = {
      organizationId: acting.organizationId,
      userId: currentActor({ requirePlatformUserId: true }).userId,
    };
    return {
      hash: (body) => {
        try {
          return this.keys.requestDigest(requester, canonicalize(body));
        } catch (error) {
          // No KEK: no RFQ was ever issued here, so none can be quoted on — and never a plain hash.
          if (error instanceof SealingError && error.code === 'KEY_UNAVAILABLE') {
            throw RastaError.upstreamUnavailable('rfq-key-provider');
          }
          throw error;
        }
      },
      matches: (stored, body) =>
        this.keys.matchesRequestDigest(stored, requester, canonicalize(body)),
    };
  }

  /** The first seal of the caller organization's quotation, or its next revision. */
  async put(
    rfqId: string,
    dto: PutQuotationDto,
    fence: ClaimFence<QuotationReceiptView>,
  ): Promise<QuotationReceiptView> {
    const supplier = this.access.assertQuotationSupplier();
    const actor = currentActor({ requirePlatformUserId: true }).userId;

    const seen = await this.findInvited(supplier, rfqId);
    if (seen.rfq.status !== 'PUBLISHED') throw refused(rfqId, 'QUOTATION_WINDOW_CLOSED');
    assertSealable(seen, dto.content);
    const eligibleAsOf = await this.assertEligible(rfqId, supplier.organizationId);
    const revising = dto.expectedRevision !== undefined;

    const view = await this.inWindow(rfqId, supplier, fence, async (tx, rfq, at) => {
      const own = await this.repository.lockOwnQuotation(tx, rfq, supplier.organizationId);
      let quotationId: string;
      let revision: number;
      if (dto.expectedRevision === undefined) {
        if (own) throw RastaError.alreadyExists('Quotation', rfqId);
        quotationId = newId(ID_PREFIX.quotation);
        revision = 1;
      } else {
        const current = this.assertCurrent(own, rfqId, dto.expectedRevision);
        quotationId = current.id;
        revision = current.revision + 1;
        if (revision > this.env.PROCUREMENT_QUOTATION_MAX_REVISIONS) {
          throw refused(rfqId, 'QUOTATION_REVISION_LIMIT');
        }
      }

      const sealed = this.seal(rfq, dto.content, {
        quotationId,
        supplier: supplier.organizationId,
        revision,
      });
      if (!own) {
        await this.repository.insert(tx, {
          id: quotationId,
          rfq,
          supplierOrganizationId: supplier.organizationId,
          sealed,
          actor,
          at,
        });
      } else if ((await this.repository.reseal(tx, own, { sealed, actor, at })) !== 1) {
        throw RastaError.optimisticLockFailed('Quotation', own.id);
      }

      const link = await this.appendReceipt(tx, rfq, {
        quotationId,
        revision,
        sealed,
        at,
        eligibleAsOf,
      });
      await this.publisher.enqueue(tx, {
        eventName: revision === 1 ? 'QUOTATION_SUBMITTED' : 'QUOTATION_REVISED',
        aggregateId: rfq.id,
        organizationId: rfq.organizationId,
        occurredAt: at,
        payload: {
          rfqId: rfq.id,
          quotationId,
          organizationId: rfq.organizationId,
          supplierOrganizationId: supplier.organizationId,
          revision,
          receivedAt: at.toISOString(),
          contentCommitment: sealed.contentCommitment,
          ciphertextSha256: sealed.ciphertextSha256,
          previousReceipt: link.previousReceipt,
          receipt: link.receipt,
          submittedBy: actor,
        },
      });
      return this.ownView(tx, rfq, supplier.organizationId);
    });
    rfqCommandsTotal.inc({
      service: SERVICE_NAME,
      command: revising ? 'quotation-revise' : 'quotation-submit',
    });
    return view;
  }

  /**
   * SUBMITTED → WITHDRAWN, before the deadline only, judged like a submission. The standing is not
   * asked: a supplier suspended since may still take its quotation back. Final: no second
   * quotation on the same RFQ.
   */
  async withdraw(
    rfqId: string,
    dto: WithdrawQuotationDto,
    fence: ClaimFence<QuotationReceiptView>,
  ): Promise<QuotationReceiptView> {
    const supplier = this.access.assertQuotationSupplier();
    const actor = currentActor({ requirePlatformUserId: true }).userId;
    await this.findInvited(supplier, rfqId);

    const view = await this.inWindow(rfqId, supplier, fence, async (tx, rfq, at) => {
      const own = await this.repository.lockOwnQuotation(tx, rfq, supplier.organizationId);
      const current = this.assertCurrent(own, rfqId, dto.expectedRevision);
      if ((await this.repository.withdraw(tx, current, { actor, at })) !== 1) {
        throw RastaError.optimisticLockFailed('Quotation', current.id);
      }
      await this.publisher.enqueue(tx, {
        eventName: 'QUOTATION_WITHDRAWN',
        aggregateId: rfq.id,
        organizationId: rfq.organizationId,
        occurredAt: at,
        payload: {
          rfqId: rfq.id,
          quotationId: current.id,
          organizationId: rfq.organizationId,
          supplierOrganizationId: supplier.organizationId,
          revision: current.revision,
          withdrawnBy: actor,
          withdrawnAt: at.toISOString(),
        },
      });
      return this.ownView(tx, rfq, supplier.organizationId);
    });
    rfqCommandsTotal.inc({ service: SERVICE_NAME, command: 'quotation-withdraw' });
    return view;
  }

  /**
   * Whether the caller may still see a stored quotation response before it is replayed: the rule a
   * fresh command applies now — an invited supplier's person whose organization's quotation it is.
   */
  async assertReplayVisible(stored: QuotationReceiptView): Promise<void> {
    const supplier = this.access.assertQuotationSupplier();
    const { rfq } = await this.findInvited(supplier, stored.rfqId);
    const own = await this.repository.findOwn(this.prisma.client, rfq, supplier.organizationId);
    if (own?.id !== stored.quotationId) throw RastaError.notFound('Quotation', stored.rfqId);
  }

  // -- the steps ---------------------------------------------------------------------------------

  /** The RFQ through the caller organization's own invitation, or 404 (ADR-070 § 10). */
  private async findInvited(supplier: Acting, rfqId: string): Promise<RfqRecord> {
    const record = await this.rfqs.invitedRecord(supplier.organizationId, rfqId);
    if (!record) throw RastaError.notFound('Rfq', rfqId);
    return record;
  }

  /**
   * One transaction: the claim held, the RFQ share-locked through the invitation, the clock read
   * after the lock and the half-open deadline judged on it, then `work`. A write the database
   * refuses on its own clock after that is the same 422; a second quotation that raced past
   * `lockOwnQuotation` is the 409 the first one's existence is.
   */
  private async inWindow(
    rfqId: string,
    supplier: Acting,
    fence: ClaimFence<QuotationReceiptView>,
    work: (
      tx: ExtendedPrismaClient,
      rfq: LockedRfqForQuotation,
      at: Date,
    ) => Promise<QuotationReceiptView>,
  ): Promise<QuotationReceiptView> {
    try {
      return await this.prisma.transaction(async (tx) => {
        await fence.hold(tx);
        const rfq = await this.repository.lockInvitedRfq(tx, supplier.organizationId, rfqId);
        if (!rfq) throw RastaError.notFound('Rfq', rfqId);
        const at = await this.clock.now(tx);
        if (rfq.status !== 'PUBLISHED' || deadlinePassed(rfq.quotationClosingAt, at)) {
          throw refused(rfqId, 'QUOTATION_WINDOW_CLOSED');
        }
        return fence.complete(tx, await work(tx, rfq, at));
      });
    } catch (error) {
      if (isGuardRefusal(error, 'ck_quotation_window')) {
        throw refused(rfqId, 'QUOTATION_WINDOW_CLOSED');
      }
      if (isUniqueViolationOf(error, UX_QUOTATION_RFQ_SUPPLIER)) {
        throw RastaError.alreadyExists('Quotation', rfqId);
      }
      throw error;
    }
  }

  /** The caller's own quotation as `expectedRevision` names it: none 404, moved 409, not SUBMITTED 422. */
  private assertCurrent(own: Quotation | null, rfqId: string, expectedRevision: number): Quotation {
    if (!own) throw RastaError.notFound('Quotation', rfqId);
    if (own.revision !== expectedRevision)
      throw RastaError.optimisticLockFailed('Quotation', own.id);
    if (own.status !== 'SUBMITTED') throw refused(rfqId, 'QUOTATION_NOT_SUBMITTED');
    return own;
  }

  /**
   * The supplier's standing now, from supplier-service (fail closed): an approved GOODS_SUPPLY
   * qualification and no open suspension. The instant of its answer is kept with the receipt.
   */
  private async assertEligible(rfqId: string, supplierOrganizationId: string): Promise<Date> {
    const standing = await this.standing.fetchStanding(supplierOrganizationId);
    if (inviteeVerdictOf(standing) !== 'ELIGIBLE') throw refused(rfqId, 'SUPPLIER_NOT_ELIGIBLE');
    return new Date(standing.asOf);
  }

  private seal(
    rfq: LockedRfqForQuotation,
    content: QuotationContent,
    entry: { quotationId: string; supplier: string; revision: number },
  ): SealedEnvelope {
    try {
      return QUOTATION_SEALING.seal({
        publicKeyPem: rfq.publicKeyPem,
        binding: {
          scopeId: rfq.id,
          entryId: entry.quotationId,
          submitterId: entry.supplier,
          revision: entry.revision,
          keyId: rfq.keyId,
        },
        content,
      });
    } catch (error) {
      if (error instanceof SealingError && error.code === 'INVALID_CONTENT') {
        throw refused(rfq.id, 'QUOTATION_TOO_LARGE');
      }
      // Never the error itself: what failed to seal is the content.
      throw RastaError.internal('A quotation could not be sealed');
    }
  }

  /**
   * The RFQ chain's next link, under its advisory lock: the receipt is the new head, with its
   * predecessor — the genesis for the first — and the digests (ADR-066 § 3).
   */
  private async appendReceipt(
    tx: ExtendedPrismaClient,
    rfq: LockedRfqForQuotation,
    input: {
      quotationId: string;
      revision: number;
      sealed: SealedEnvelope;
      at: Date;
      eligibleAsOf: Date;
    },
  ): Promise<{ previousReceipt: string; receipt: string }> {
    const slot = await this.repository.nextReceiptSlot(tx, rfq);
    // Past what audit-service returns, the RFQ could never be opened (construction audit F2).
    if (slot.seq > QUOTATION_RECEIPT_CHAIN_LIMIT) throw refused(rfq.id, 'QUOTATION_RECEIPT_LIMIT');
    const previousReceipt = slot.previousReceipt ?? QUOTATION_SEALING.genesisReceipt(rfq.id);
    const link = {
      entryId: input.quotationId,
      revision: input.revision,
      receivedAt: input.at,
      ciphertextSha256: input.sealed.ciphertextSha256,
      contentCommitment: input.sealed.contentCommitment,
    };
    const receipt = QUOTATION_SEALING.nextReceipt(rfq.id, previousReceipt, link);
    await this.repository.insertReceipt(tx, {
      organizationId: rfq.organizationId,
      rfqId: rfq.id,
      seq: slot.seq,
      quotationId: input.quotationId,
      revision: input.revision,
      receivedAt: input.at,
      ciphertextSha256: link.ciphertextSha256,
      contentCommitment: link.contentCommitment,
      previousReceipt,
      receipt,
      eligibleAsOf: input.eligibleAsOf,
    });
    return { previousReceipt, receipt };
  }

  /** The supplier's own quotation, read in the transaction that wrote it. */
  private async ownView(
    tx: ExtendedPrismaClient,
    rfq: LockedRfqForQuotation,
    supplierOrganizationId: string,
  ): Promise<QuotationReceiptView> {
    const own = await this.repository.findOwn(tx, rfq, supplierOrganizationId);
    if (!own) throw new Error(`quotation of ${rfq.id} vanished inside its own transaction`);
    const receipt = await this.repository.receiptOf(tx, own);
    if (!receipt) throw new Error(`quotation ${own.id} has no receipt for its revision`);
    return {
      quotationId: own.id,
      rfqId: own.rfqId,
      status: own.status as QuotationReceiptView['status'],
      revision: own.revision,
      receivedAt: own.receivedAt.toISOString(),
      contentCommitment: own.contentCommitment,
      receipt,
      withdrawnAt: own.withdrawnAt?.toISOString() ?? null,
    };
  }
}

/**
 * The content against what the RFQ was issued with — frozen, so judged once, before anything is
 * sealed: every answer names one of its criteria and each criterion is answered (Q-120), and the
 * amount the quotation states — `unitPriceMinor × totalQuantity`, exact in bigint — fits the
 * platform's `bigint` (ADR-070 § 4, § 8). The refusals name a closed code, never a value.
 */
export function assertSealable(record: RfqRecord, content: QuotationContent): void {
  const codes = new Set(record.criteria.map((criterion) => criterion.code));
  const answered = new Set(content.answers.map((answer) => answer.criterionCode));
  if ([...answered].some((code) => !codes.has(code))) {
    throw refused(record.rfq.id, 'UNKNOWN_CRITERION');
  }
  if ([...codes].some((code) => !answered.has(code))) {
    throw refused(record.rfq.id, 'CRITERION_UNANSWERED');
  }
  if (BigInt(content.unitPriceMinor) * BigInt(record.rfq.totalQuantity) > MAX_AMOUNT_MINOR) {
    throw refused(record.rfq.id, 'QUOTATION_AMOUNT_OUT_OF_RANGE');
  }
}

function refused(rfqId: string, code: QuotationRefusal): RastaError {
  return ruleRefusal(`Quotation refused: ${code}`, 'quotation', [code], {
    rfqId,
    correlationId: getContext().correlationId,
  });
}

/** One quotation per invited supplier and RFQ (migration `20261103100000_quotation`). */
const UX_QUOTATION_RFQ_SUPPLIER: UniqueIndex = {
  name: 'ux_quotation_rfq_supplier',
  model: 'Quotation',
  columns: ['organization_id', 'rfq_id', 'supplier_organization_id'],
};
