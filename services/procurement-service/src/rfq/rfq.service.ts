import { Inject, Injectable } from '@nestjs/common';
import { RastaError, currentActor, getContext } from '@rasta/nest-common';
import { SealingError, generateSealingKeyPair } from '@rasta/sealing';
import type { DemandAggregation } from '../generated/prisma';
import { ProcurementAccess, assertOwnedBy, type RfqCaller } from '../access/access';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { DatabaseClock } from '../shared/clock';
import type { ClaimFence } from '../shared/idempotency';
import { isGuardRefusal, isUniqueViolation } from '../shared/prisma-errors';
import { ruleRefusal } from '../shared/refusal';
import { ENV, RFQ_KEY_PROVIDER, SUPPLIER_STANDING } from '../tokens';
import { SERVICE_NAME, type ProcurementEnv } from '../config/env';
import { rfqCommandsTotal } from '../observability/metrics';
import { DemandRepository } from '../demand/demand.repository';
import type { CursorPage } from '../demand/dto';
import {
  criteriaDigest,
  type CancelRfqDto,
  type IssueRfqDto,
  type ListRfqsQuery,
  type RfqView,
} from './dto';
import type { RfqKeyProvider, WrappedKey } from './key-provider';
import { RfqClose } from './rfq-close';
import { RfqRepository } from './rfq.repository';
import {
  CLOSED_RFQ_STATES,
  deadlinePassed,
  rfqTransition,
  type RfqStateName,
} from './rfq.state-machine';
import { inviteeVerdictOf, type SupplierStandingSource } from './supplier-standing.client';
import { toRfqView } from './views';

/** How many invitees' standings are asked of supplier-service at once. */
export const STANDING_CONCURRENCY = 10;

/**
 * RFQs: issued from a READY aggregation, closed at their deadline, cancelled (ADR-070 § 3, plan
 * PR 6).
 *
 * ## The issue: every remote read first, then one transaction
 *
 * Issuing is a human command (`docs/08` § 8.6 is overruled: nothing is issued automatically, ADR-043).
 * Before any lock and outside any transaction (ADR-070 § 7): the aggregation is read as the caller
 * saw it — missing, stale, not READY end here, before any remote call; each invited organization's
 * standing is asked of supplier-service, fail closed (503/504 when unavailable, and nothing is
 * written); the RFQ's sealing key pair is made and its private half wrapped (503 with no KEK). Then
 * one transaction: the aggregation locked, its version and status judged again (the read before the
 * lock is a first cut, not the decision), the deadline judged against the database clock read after
 * the lock, and the RFQ, its frozen criteria and invitations, the aggregation's READY → RFQ_ISSUED
 * and `RFQ_ISSUED` written together.
 *
 * ## A precondition that moved is 409, in every interleaving
 *
 * `expectedVersion` is judged before the status: a caller whose aggregation or RFQ another command
 * moved since it read it is told its view is stale (409 OPTIMISTIC_LOCK_FAILED), whichever command
 * won — not the rule the winner's state would break (the lesson of PR-348 r1 F1). A caller that
 * read the current version and still asks for a transition the lifecycle does not have is 422. The
 * aggregation's and the RFQ's row locks serialise every pair of commands; should a write ever race
 * past them, the database's own refusal of the loser is answered the same 409 ({@link isLostIssueRace}).
 */
@Injectable()
export class RfqService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: RfqRepository,
    private readonly demands: DemandRepository,
    private readonly access: ProcurementAccess,
    private readonly publisher: EventPublisher,
    private readonly clock: DatabaseClock,
    private readonly closing: RfqClose,
    @Inject(SUPPLIER_STANDING) private readonly standing: SupplierStandingSource,
    @Inject(RFQ_KEY_PROVIDER) private readonly keys: RfqKeyProvider,
    @Inject(ENV) private readonly env: ProcurementEnv,
  ) {}

  async issue(
    aggregationId: string,
    dto: IssueRfqDto,
    fence: ClaimFence<RfqView>,
  ): Promise<RfqView> {
    const acting = this.access.assertRfqIssuer();
    const actor = currentActor({ requirePlatformUserId: true });
    const correlationId = getContext().correlationId;
    const invitees = dto.invitedSupplierOrganizationIds;

    if (invitees.includes(acting.organizationId)) {
      throw ruleRefusal('The buyer is never invited to its own RFQ', 'rfqIssue', [
        'INVITEE_IS_BUYER',
      ]);
    }
    if (invitees.length > this.env.PROCUREMENT_RFQ_MAX_INVITEES) {
      throw ruleRefusal(
        'An RFQ invites at most PROCUREMENT_RFQ_MAX_INVITEES organizations',
        'rfqIssue',
        ['INVITEE_LIMIT_EXCEEDED'],
        { invitees: invitees.length, limit: this.env.PROCUREMENT_RFQ_MAX_INVITEES },
      );
    }

    // As the caller saw it: a missing, stale or unready aggregation asks nobody anything.
    const seen = await this.demands.findAggregation(aggregationId);
    if (!seen) throw RastaError.notFound('DemandAggregation', aggregationId);
    assertOwnedBy(seen, acting, 'DemandAggregation');
    assertIssuable(seen, dto.expectedVersion);

    // Outside any transaction, fail closed (ADR-070 § 7).
    await this.assertInviteesEligible(invitees);

    const rfqId = newId(ID_PREFIX.rfq);
    const keyId = newId(ID_PREFIX.rfqKey);
    const key = await this.makeKey(rfqId, keyId);
    const quotationClosingAt = new Date(dto.quotationClosingAt);
    const digest = criteriaDigest(dto.criteria);

    let view: RfqView;
    try {
      view = await this.prisma.transaction(async (tx) => {
        await fence.hold(tx);

        const window = await this.demands.lockWindow(tx, acting.organizationId, aggregationId);
        if (!window) throw RastaError.notFound('DemandAggregation', aggregationId);
        assertIssuable(window, dto.expectedVersion);

        // After the lock: a long wait for it cannot let a deadline in the past through.
        const now = await this.clock.now(tx);
        if (quotationClosingAt.getTime() <= now.getTime()) {
          throw ruleRefusal(
            'The quotation deadline must be after the moment of the issue',
            'rfqIssue',
            ['QUOTATION_CLOSING_NOT_IN_FUTURE'],
            { aggregationId },
          );
        }

        await this.repository.insertRfq(tx, {
          id: rfqId,
          organizationId: acting.organizationId,
          aggregationId,
          productId: window.productId,
          totalQuantity: Number(window.totalQuantity),
          procurementNature: dto.procurementNature,
          quotationClosingAt,
          criteria: dto.criteria,
          criteriaDigest: digest,
          invitedSupplierOrganizationIds: invitees,
          key: {
            keyId,
            publicKeyPem: key.publicKeyPem,
            kekId: key.wrapped.kekId,
            nonce: key.wrapped.nonce,
            ciphertext: key.wrapped.ciphertext,
            tag: key.wrapped.tag,
          },
          issuedAt: now,
          issuedBy: actor.userId,
          issuedCorrelationId: correlationId,
        });
        await this.demands.issueRfq(tx, window, rfqId, now);

        await this.publisher.enqueue(tx, {
          eventName: 'RFQ_ISSUED',
          aggregateId: rfqId,
          organizationId: acting.organizationId,
          occurredAt: now,
          payload: {
            rfqId,
            organizationId: acting.organizationId,
            aggregationId,
            rfqVersion: 1,
            productId: window.productId,
            totalQuantity: Number(window.totalQuantity),
            procurementNature: dto.procurementNature,
            quotationClosingAt: quotationClosingAt.toISOString(),
            invitedSupplierOrganizationIds: [...invitees],
            criteriaCount: dto.criteria.length,
            criteriaDigest: digest,
            keyId,
            issuedBy: actor.userId,
            issuedAt: now.toISOString(),
          },
        });

        const rfq = await this.repository.findRfq(rfqId, tx);
        if (!rfq) throw new Error(`rfq ${rfqId} vanished inside its own transaction`);
        return fence.complete(tx, toRfqView(await this.repository.buyerRecord(rfq, tx), 'BUYER'));
      });
    } catch (error) {
      if (isLostIssueRace(error)) {
        throw RastaError.optimisticLockFailed('DemandAggregation', aggregationId);
      }
      throw error;
    }
    rfqCommandsTotal.inc({ service: SERVICE_NAME, command: 'issue' });
    return view;
  }

  /**
   * PUBLISHED → CLOSED by a person of the buyer, at or after the deadline: the sweeper's command
   * (`RfqClose`). Idempotent: an RFQ already closed — CLOSED or any status only a close leads to —
   * answers as it is, with no second event. A cancelled one is final (422).
   */
  async close(id: string, fence: ClaimFence<RfqView>): Promise<RfqView> {
    const caller = this.access.assertRfqCaller();
    const actor = currentActor({ requirePlatformUserId: true });

    const done = { closed: false };
    const view = await this.prisma.transaction(async (tx) => {
      await fence.hold(tx);
      const rfq = await this.lockOwnRfq(tx, caller, id);

      let current = rfq;
      if (rfq.status === 'PUBLISHED') {
        // After the lock: the deadline is judged on the clock read once nothing else moves the RFQ.
        const now = await this.clock.now(tx);
        if (!deadlinePassed(rfq.quotationClosingAt, now)) {
          throw ruleRefusal(
            'An RFQ is closed only at or after its quotation deadline',
            'rfqClose',
            ['QUOTATION_DEADLINE_NOT_REACHED'],
            { rfqId: id },
          );
        }
        current = await this.closing.close(tx, rfq, now, actor.userId);
        done.closed = true;
      } else if (!CLOSED_RFQ_STATES.includes(rfq.status as RfqStateName)) {
        throw ruleRefusal('A cancelled RFQ is never closed', 'rfqClose', ['RFQ_CANCELLED'], {
          rfqId: id,
        });
      }
      return fence.complete(tx, toRfqView(await this.repository.buyerRecord(current, tx), 'BUYER'));
    });
    if (done.closed) rfqCommandsTotal.inc({ service: SERVICE_NAME, command: 'close' });
    return view;
  }

  /**
   * Any status but AWARDED → CANCELLED, with a closed code and the buyer's reason (ADR-070 § 3).
   * The aggregation stays RFQ_ISSUED (Q-121 (4)): its requesters register new demands. The reason
   * stays here; RFQ_CANCELLED carries the code.
   */
  async cancel(id: string, dto: CancelRfqDto, fence: ClaimFence<RfqView>): Promise<RfqView> {
    const caller = this.access.assertRfqCaller();
    const actor = currentActor({ requirePlatformUserId: true });

    const view = await this.prisma.transaction(async (tx) => {
      await fence.hold(tx);
      const rfq = await this.lockOwnRfq(tx, caller, id);

      if (rfq.version !== dto.expectedVersion) throw RastaError.optimisticLockFailed('Rfq', id);
      const previousStatus = rfq.status as RfqStateName;
      if (rfqTransition(previousStatus, 'cancel') === null) {
        throw ruleRefusal('An AWARDED or CANCELLED RFQ is final', 'rfqCancellation', [
          'RFQ_NOT_CANCELLABLE',
        ]);
      }

      const now = await this.clock.now(tx);
      const cancelled = await this.repository.moveRfq(tx, rfq, 'CANCELLED', {
        cancelledAt: now,
        cancelledBy: actor.userId,
        cancelReasonCode: dto.reasonCode,
        cancelReason: dto.reason,
        updatedAt: now,
      });
      await this.publisher.enqueue(tx, {
        eventName: 'RFQ_CANCELLED',
        aggregateId: rfq.id,
        organizationId: rfq.organizationId,
        occurredAt: now,
        payload: {
          rfqId: rfq.id,
          organizationId: rfq.organizationId,
          aggregationId: rfq.aggregationId,
          rfqVersion: cancelled.version,
          previousStatus,
          reasonCode: dto.reasonCode,
          cancelledBy: actor.userId,
          cancelledAt: now.toISOString(),
        },
      });
      return fence.complete(
        tx,
        toRfqView(await this.repository.buyerRecord(cancelled, tx), 'BUYER'),
      );
    });
    rfqCommandsTotal.inc({ service: SERVICE_NAME, command: 'cancel' });
    return view;
  }

  /**
   * One RFQ: its buyer's, by the buyer's read roles; or an RFQ that invites the caller's
   * organization, by its supplier roles. Anything else — an RFQ of a third organization, one that
   * does not invite the caller, one that does not exist — is the same 404.
   */
  async getRfq(id: string): Promise<RfqView> {
    const caller = this.access.assertRfqCaller();
    const own = await this.repository.findRfq(id);
    if (own) {
      assertOwnedBy(own, caller, 'Rfq');
      this.access.assertRfqBuyerRole(caller, 'read');
      return toRfqView(await this.repository.buyerRecord(own), 'BUYER');
    }
    if (this.access.mayReadAsSupplier(caller)) {
      const invited = await this.repository.invitedRecord(caller.organizationId, id);
      if (invited) return toRfqView(invited, 'SUPPLIER');
    }
    throw RastaError.notFound('Rfq', id);
  }

  async listRfqs(query: ListRfqsQuery): Promise<CursorPage<RfqView>> {
    const filter = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    };
    if (query.side === 'SUPPLIER') {
      const acting = this.access.assertRfqSupplierReader();
      const rows = await this.repository.listInvited(acting.organizationId, filter);
      const shown = rows.slice(0, query.limit);
      const criteria = await this.repository.criteriaOf(shown, true);
      return page(rows, query.limit, (rfq) =>
        toRfqView({ rfq, criteria: criteria.get(rfq.id) ?? [] }, 'SUPPLIER'),
      );
    }
    const acting = this.access.assertRfqBuyerReader();
    const rows = await this.repository.listRfqs(filter);
    const shown = rows.slice(0, query.limit);
    shown.forEach((row) => assertOwnedBy(row, acting, 'Rfq'));
    const [criteria, invitations] = await Promise.all([
      this.repository.criteriaOf(shown, false),
      this.repository.invitationsOf(shown),
    ]);
    return page(rows, query.limit, (rfq) =>
      toRfqView(
        {
          rfq,
          criteria: criteria.get(rfq.id) ?? [],
          invitations: invitations.get(rfq.id) ?? [],
        },
        'BUYER',
      ),
    );
  }

  /**
   * Whether the caller may still see what a stored issue named: the rule a fresh issue applies (the
   * issuer's roles, its own organization), checked before the stored answer is replayed.
   */
  async assertIssueVisible(rfqId: string): Promise<void> {
    const acting = this.access.assertRfqIssuer();
    const rfq = await this.repository.findRfq(rfqId);
    if (!rfq) throw RastaError.notFound('Rfq', rfqId);
    assertOwnedBy(rfq, acting, 'Rfq');
  }

  /** The same for a stored close or cancellation: the buyer's command roles, on its own RFQ. */
  async assertCommandVisible(rfqId: string): Promise<void> {
    const caller = this.access.assertRfqCaller();
    const rfq = await this.repository.findRfq(rfqId);
    if (!rfq) throw RastaError.notFound('Rfq', rfqId);
    assertOwnedBy(rfq, caller, 'Rfq');
    this.access.assertRfqBuyerRole(caller, 'command');
  }

  /**
   * The RFQ of the caller's own organization, locked; then the caller's role in it. A supplier and
   * a third organization find nothing here — the same 404 as a missing id (ADR-070 § 3); another
   * role of the buyer is 403.
   */
  private async lockOwnRfq(tx: ExtendedPrismaClient, caller: RfqCaller, id: string) {
    const rfq = await this.repository.lockRfq(tx, caller.organizationId, id);
    if (!rfq) throw RastaError.notFound('Rfq', id);
    assertOwnedBy(rfq, caller, 'Rfq');
    this.access.assertRfqBuyerRole(caller, 'command');
    return rfq;
  }

  /**
   * Every invitee's standing, asked of supplier-service now (ADR-070 § 3): an approved GOODS_SUPPLY
   * qualification and no open suspension. One that is not eligible refuses the whole issue (422);
   * one that cannot be asked refuses it as unavailable (503/504) — nobody is invited unconfirmed.
   */
  private async assertInviteesEligible(invitees: readonly string[]): Promise<void> {
    let refused = 0;
    for (let start = 0; start < invitees.length; start += STANDING_CONCURRENCY) {
      const batch = invitees.slice(start, start + STANDING_CONCURRENCY);
      const verdicts = await Promise.all(
        batch.map(async (organizationId) =>
          inviteeVerdictOf(await this.standing.fetchStanding(organizationId)),
        ),
      );
      refused += verdicts.filter((verdict) => verdict !== 'ELIGIBLE').length;
    }
    if (refused > 0) {
      throw ruleRefusal(
        'Every invited organization must hold an approved GOODS_SUPPLY qualification and no open suspension',
        'rfqIssue',
        ['INVITEE_NOT_ELIGIBLE'],
        { refusedInvitees: refused },
      );
    }
  }

  /**
   * A fresh key pair, its private half wrapped and then zeroised. Without a configured KEK this is
   * 503, and nothing is issued.
   */
  private async makeKey(
    rfqId: string,
    keyId: string,
  ): Promise<{ publicKeyPem: string; wrapped: WrappedKey }> {
    const pair = await generateSealingKeyPair();
    try {
      return {
        publicKeyPem: pair.publicKeyPem,
        wrapped: this.keys.wrap(pair.privateKeyDer, { rfqId, keyId }),
      };
    } catch (error) {
      if (error instanceof SealingError) throw RastaError.upstreamUnavailable('rfq-key-provider');
      throw error;
    } finally {
      pair.privateKeyDer.fill(0);
    }
  }
}

/**
 * The aggregation as the issue requires it, judged before the lock and again under it: the version
 * the caller read first (409 when it moved), then READY (422), then its end recorded — its digest,
 * and so its DEMAND_AGGREGATED, out (409 CONFLICT with Retry-After while the sweeper finishes it).
 */
function assertIssuable(window: DemandAggregation, expectedVersion: number): void {
  if (window.version !== expectedVersion) {
    throw RastaError.optimisticLockFailed('DemandAggregation', window.id);
  }
  if (window.status !== 'READY') {
    throw ruleRefusal('An RFQ is issued only from a READY aggregation', 'rfqIssue', [
      'AGGREGATION_NOT_READY',
    ]);
  }
  if (window.demandIdsSha256 === null) {
    throw new RastaError('CONFLICT', 'The end of this aggregation is still being recorded; retry', {
      retryAfterSeconds: 1,
    });
  }
}

/**
 * The database refusing an issue whose aggregation another command moved after this one's checks:
 * the RFQ's unique aggregation (`ux_rfq_aggregation`, P2002), an RFQ born of an aggregation no
 * longer READY (`ck_rfq_from_ready_aggregation`), or the aggregation's own transition guard. The
 * aggregation's row lock makes each unreachable for this service's writes; should one be reached,
 * it means the caller's precondition no longer holds — 409, never 500. Nothing else is: any other
 * refusal stays the 500 it is.
 */
export function isLostIssueRace(error: unknown): boolean {
  return (
    isUniqueViolation(error) ||
    isGuardRefusal(error, 'ck_rfq_from_ready_aggregation') ||
    isGuardRefusal(error, 'ck_demand_aggregation_transition')
  );
}

function page<T, V>(rows: readonly (T & { id: string })[], limit: number, view: (row: T) => V) {
  const more = rows.length > limit;
  const shown = more ? rows.slice(0, limit) : rows;
  return {
    items: shown.map(view),
    nextCursor: more ? (shown[shown.length - 1]?.id ?? null) : null,
  };
}
