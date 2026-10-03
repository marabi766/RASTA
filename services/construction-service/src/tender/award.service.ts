import { Inject, Injectable, Logger } from '@nestjs/common';
import { RastaError, compareActors, currentActor, getContext } from '@rasta/nest-common';
import { ERROR_CODES } from '@rasta/contracts';
import { withFinancialSpan } from '@rasta/observability';
import type { TenderAward } from '../generated/prisma';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { ProjectAccess } from '../access/access';
import { SERVICE_NAME, type ConstructionEnv } from '../config/env';
import type { BidAccessPurpose } from '../events/events';
import {
  awardRefusalsTotal,
  tenderTransitionsTotal,
  versionConflictsTotal,
} from '../observability/metrics';
import { transactionNow } from '../shared/clock';
import { ENV } from '../tokens';
import { BidAccessAudit, refusalCodeOf } from './bid-access-audit';
import { BidContentReader } from './bid-content-reader';
import { BidRepository } from './bid.repository';
import { TenderClock } from './tender-clock';
import { TenderOpenRepository } from './tender-open.repository';
import {
  EvaluationRepository,
  type BidSummary,
  type TenderForEvaluation,
} from './evaluation.repository';
import { OwnerIdentity, type LivePrincipal, type Principal } from './owner-identity';
import { StandingAuthority } from './standing-authority';
import { AwardRepository } from './award.repository';
import { TenderApprovalGate, type GateCaller } from './tender-approval.gate';
import { TenderApprovalRepository } from './tender-approval.repository';
import { approvalStale } from './tender-approval.errors';
import { toRequestView, type Gated, type TenderApprovalRequestView } from './tender-approval.dto';
import { buildMatrix, matrixDigest } from './evaluation-matrix';
import { readMatrixInput } from './matrix-input';
import { storedActor, storedIdentityOf } from '../shared/stable-actor';
import type { AwardTenderDto, TenderAwardView } from './award.dto';

/**
 * The closed reasons an award is refused for (ADR-067 § 3, § 4): the metric's label, the access
 * log's `refusal_code`, and the code in the answer's message.
 */
export const AWARD_REFUSALS = [
  'CONFLICT_OF_INTEREST',
  'AWARDER_IS_EVALUATOR',
  'ACTOR_IDENTITY_UNKNOWN',
  'NOT_EVALUATED',
  'BID_NOT_QUALIFIED',
  'JUSTIFICATION_REQUIRED',
  'WINNER_NOT_ELIGIBLE',
  'ALREADY_AWARDED',
  'APPROVAL_POLICY_REQUIRED',
] as const;
export type AwardRefusal = (typeof AWARD_REFUSALS)[number];

/** What an award command came to: the award made, a repeat of it, or the request that is being decided. */
type Outcome =
  | { kind: 'AWARDED'; view: TenderAwardView }
  | { kind: 'REPLAY'; view: TenderAwardView }
  | { kind: 'PENDING'; request: TenderApprovalRequestView };

const WORKFLOW = 'tender.award' as const;

/** What a tender and its bids come to once the command has judged them. */
type Judged =
  | { replay: TenderAwardView }
  | {
      replay: null;
      bid: BidSummary;
      rank: number;
      tied: boolean;
      digest: string;
      justification: string | null;
    };

/**
 * Awarding an EVALUATED tender to one of its ranked bids (ADR-067 § 3): EVALUATED → AWARDED.
 *
 * ## A person decides
 *
 * The system ranks and shows (ADR-067 § 2); the owner's person names the bid. Choosing anything but
 * the single first rank of the frozen matrix — another rank, or a member of a tie — needs the reason
 * in words (`JUSTIFICATION_REQUIRED`), kept with the award and the digest of the matrix it was made
 * against. **There is no automatic fallback** (Q-93): a winner who is refused at the award — not
 * eligible any more, or supplier-service cannot say — leaves the tender EVALUATED and every bid as it
 * was; the person decides again, and may name another QUALIFIED bid.
 *
 * ## One lock, one clock
 *
 * The decision takes the tender row `FOR UPDATE` — the lock every owner command takes — and reads its
 * instant from the database **after** it. It writes, in that one transaction: the award, the tender
 * (compare-and-set on status and version), the winning bid, every other qualified bid (NOT_AWARDED),
 * `TENDER_AWARDED`, one `BID_NOT_AWARDED` per bid that lost, and the access log row (`BID_ACCESSED`)
 * of the read of the winner's price. The database says the same: the award is accepted only for an
 * EVALUATED tender and a QUALIFIED bid of it (a trigger that takes the tender `FOR SHARE`), the
 * tender and the bids move only with it, and a row cannot commit without all of them — so two
 * awards at once are one award and a 409, and an evaluation write that arrives late finds the matrix
 * frozen, for any writer. The same award asked again answers itself (`alreadyAwarded`) and writes
 * nothing; a different bid on an awarded tender is 409.
 *
 * ## The winner's standing, as it is now (Q-85)
 *
 * Eligibility was asked once when the bid was made and once when it was qualified. A contractor can
 * be suspended in between, so the award asks supplier-service again — **authoritative, fail closed**:
 * not eligible is 422 `WINNER_NOT_ELIGIBLE`, unreachable is 503/504, and nothing is awarded. The
 * question is asked before the lock is taken (a network call under the tender's lock would hold every
 * other command behind a slow supplier-service) and the instant it was answered is stored
 * (`standing_as_of`). Residual: a suspension that lands between that answer and the commit is not
 * stopped. The control is **durable and out of the request**: the award's own transaction writes a
 * pending standing check (window start = that instant), the database refuses to commit an award
 * without it, and `AwardStandingCheckSweeper` makes it afterwards, exactly once (a conflict ⇒ alert
 * and `TENDER_AWARD_STANDING_CONFLICT_DETECTED`; unreachable ⇒ retried, and alerted if still pending
 * past an age). The answer to `award` waits for none of it. A repeat of an award already made does not
 * ask, and writes no second check.
 *
 * ## Who
 *
 * The configured roles (`CONSTRUCTION_TENDER_AWARD_ROLES`, by default the owner's role set) with the
 * same exclusions as opening and evaluating, the caller judged on identity-service as of now, and a
 * member of any bidding organization refused 403 `CONFLICT_OF_INTEREST` before anything is said about
 * the tender. With `CONSTRUCTION_COI_RULES` naming `AWARDER_NOT_EVALUATOR` the awarder is none of the
 * people who took part in the evaluation (decided on a bid, scored one, stood down from one, or
 * completed it): 403 `AWARDER_IS_EVALUATOR`, or 422 `ACTOR_IDENTITY_UNKNOWN` when the records cannot
 * show that they are two people — people are compared on their stable identity (`compareActors`, #188). Every refusal is audited.
 *
 * ## The approval gate (Q-84, CON-002 PR 11) — fail closed
 *
 * `award` refuses `APPROVAL_POLICY_REQUIRED` with no active `tender.award` policy. With one it opens the
 * round (`TenderApprovalGate`) bound to the tender, its version, the bid, the justification, the matrix
 * digest and the standing read, and answers the request; the same command awards only when the request is
 * APPROVED — using it up in the award's own transaction under the tender's lock, after asking
 * supplier-service for the winner's standing again — and refuses a stale one (409). The award route
 * is open since #188 part B: the approver is compared on stable identity, like everyone else here.
 */
@Injectable()
export class AwardService {
  private readonly logger = new Logger(AwardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: EvaluationRepository,
    private readonly awards: AwardRepository,
    private readonly bids: BidRepository,
    private readonly opens: TenderOpenRepository,
    private readonly audit: BidAccessAudit,
    private readonly events: EventPublisher,
    private readonly access: ProjectAccess,
    private readonly identity: OwnerIdentity,
    private readonly standing: StandingAuthority,
    private readonly reader: BidContentReader,
    private readonly clock: TenderClock,
    @Inject(ENV) private readonly env: ConstructionEnv,
    private readonly gate: TenderApprovalGate,
    private readonly approvalRequests: TenderApprovalRepository,
  ) {}

  /**
   * POST /award — behind the approval gate (Q-84, CON-002 PR 11). With no `tender.award` policy in force:
   * 422 `APPROVAL_POLICY_REQUIRED`. With one, a command that could succeed opens (or finds) the approval
   * request bound to this tender and its version, the bid, its rank, the justification, the matrix digest
   * and the standing read it was decided on, and the answer is the request (`executed: false`, 202); once
   * every step is granted the same command awards and uses the approval up in the same transaction, under
   * the tender's lock, **and asks supplier-service for the winner's standing now** — an approval never
   * replaces that. What changed since the approval is 409 `APPROVAL_STALE`: nothing is awarded.
   */
  async award(tenderId: string, dto: AwardTenderDto): Promise<Gated<TenderAwardView>> {
    const caller = await this.authorize(tenderId, dto.bidId);
    const outcome = await this.guarded(caller, tenderId, dto.bidId, async (): Promise<Outcome> => {
      const principal = await this.identity.live(caller, 'AWARD_TENDER');
      await this.assertNotConflicted(principal, tenderId);
      const gateCaller: GateCaller = {
        userId: principal.actor,
        organizationId: principal.organizationId,
        identity: storedIdentityOf(currentActor()),
      };

      // Fail closed, first (Q-84): no policy in force is no approval path, whatever else is true of the tender.
      const confirmedPolicyId = await this.gate.confirmPolicy(principal.organizationId, WORKFLOW);
      if (confirmedPolicyId === null) throw this.rule('APPROVAL_POLICY_REQUIRED');

      // A first look decides everything it can without asking anyone: the tender, the bid, the
      // conflict rules, the justification, a repeat. Advisory — it is all judged again under the lock.
      const first = await this.prisma.transaction(async (tx) => {
        const tender = await this.repo.lockSharedForRead(tx, principal.organizationId, tenderId);
        if (!tender) throw RastaError.notFound('Tender', tenderId);
        const bids = await this.repo.listBidSummaries(tx, tenderId);
        return this.judge(tx, principal, tender, bids, dto);
      });
      if (first.replay) return { kind: 'REPLAY', view: first.replay };

      // Outside any lock or transaction: supplier-service's word on the winner now (fail closed) — for
      // the request, which is shown it, and for the execution, which an approval never replaces.
      const { verdict, asOf } = await this.standing.decisionFor(first.bid.bidderOrganizationId);
      if (verdict !== 'ELIGIBLE') throw this.rule('WINNER_NOT_ELIGIBLE', { verdict });
      // The receipt chain as audit-service holds it, to read the winner's price against: only an
      // approved request is executed, so only then is it worth asking.
      const ready = await this.gate.hasApproved(principal.organizationId, tenderId, WORKFLOW);
      const evidence = ready
        ? await this.reader.readEvidence(principal.organizationId, tenderId)
        : null;

      const committed = await withFinancialSpan(
        'construction.tender.award',
        () =>
          this.prisma.transaction(async (tx): Promise<Outcome | { kind: 'STALE' }> => {
            const tender = await this.repo.lockForEvaluation(
              tx,
              principal.organizationId,
              tenderId,
            );
            if (!tender) throw RastaError.notFound('Tender', tenderId);
            const bids = await this.repo.listBidSummaries(tx, tenderId);
            const judged = await this.judge(tx, principal, tender, bids, dto);
            if (judged.replay) return { kind: 'REPLAY', view: judged.replay };

            const at = await this.clock.decisionInstant(tx);
            const winner = judged.bid;
            const gateTender = {
              organizationId: principal.organizationId,
              id: tenderId,
              projectId: tender.projectId,
              version: tender.version,
            };

            const resolution = await this.gate.resolve(tx, {
              tender: gateTender,
              binding: {
                workflowKey: WORKFLOW,
                bidId: winner.id,
                bidderOrganizationId: winner.bidderOrganizationId,
                rank: judged.rank,
                tied: judged.tied,
                justification: judged.justification,
                matrixDigest: judged.digest,
                standingAsOf: asOf,
              },
              confirmedPolicyId,
              caller: gateCaller,
              at,
            });
            // Ended in this transaction (committed with it): the command answers 409 once it is.
            if (resolution.kind === 'STALE') return { kind: 'STALE' };
            if (resolution.kind === 'REQUESTED') {
              return {
                kind: 'PENDING',
                request: toRequestView(
                  resolution.request,
                  await this.approvalRequests.steps(tx, resolution.request),
                ),
              };
            }
            // Approved between the first look and now: no price was read for it. Ask again.
            if (!evidence) {
              throw RastaError.optimisticLockFailed('TenderApprovalRequest', resolution.request.id);
            }

            // The winner's price: read from its sealed content against audit-service's receipts.
            const key = await this.bids.findWrappedKey(tx, tenderId);
            const sealed = await this.bids.findBidOf(tx, tenderId, winner.bidderOrganizationId);
            if (!sealed || sealed.id !== winner.id) throw RastaError.notFound('Bid', winner.id);
            let amountMinor: bigint | undefined;
            this.reader.withPrivateKey(key, tenderId, (privateKey, keyId) => {
              const content = this.reader.openOne(
                privateKey,
                keyId,
                tenderId,
                sealed,
                evidence.receipts,
              );
              amountMinor = BigInt(content.priceMinor);
            });
            if (amountMinor === undefined) throw RastaError.internal('A bid was not opened');

            const identity = storedIdentityOf(currentActor());
            const id = newId(ID_PREFIX.award);
            await this.awards.insertAward(tx, {
              id,
              organizationId: principal.organizationId,
              tenderId,
              bidId: winner.id,
              bidderOrganizationId: winner.bidderOrganizationId,
              amountMinor,
              rank: judged.rank,
              tied: judged.tied,
              matrixDigest: judged.digest,
              justification: judged.justification,
              standingAsOf: asOf,
              actor: principal.actor,
              actorIssuer: identity.issuer,
              actorSubject: identity.subject,
              at,
            });
            // The standing check that follows (ADR-067 § 3, residual) is written here, in this commit:
            // the database refuses an award without it, a sweeper makes it, and this response waits for nothing.
            await this.awards.insertStandingCheck(tx, {
              id: newId(ID_PREFIX.standingCheck),
              organizationId: principal.organizationId,
              tenderId,
              projectId: tender.projectId,
              bidId: winner.id,
              winnerOrganizationId: winner.bidderOrganizationId,
              awardedBy: principal.actor,
              awardedAt: at,
              windowStart: asOf,
              at,
            });
            const matched = await this.awards.markTenderAwarded(tx, {
              tenderId,
              expectedVersion: tender.version,
              actor: principal.actor,
              at,
            });
            if (matched === 0) throw this.conflict('Tender', tenderId);
            const won = await this.awards.markBidAwarded(tx, {
              bidId: winner.id,
              actor: principal.actor,
              at,
            });
            if (won === 0) throw this.conflict('Bid', winner.id);
            const losers = await this.awards.markOthersNotAwarded(tx, {
              tenderId,
              winnerBidId: winner.id,
              actor: principal.actor,
              at,
            });
            // The approval is used up here, once, in the transaction that awards (the database refuses an
            // award without it, and a second use of it).
            await this.gate.consume(tx, resolution.request, gateTender, gateCaller, at);

            await this.events.enqueue(tx, {
              eventName: 'TENDER_AWARDED',
              aggregateId: tenderId,
              organizationId: principal.organizationId,
              payload: {
                tenderId,
                projectId: tender.projectId,
                organizationId: principal.organizationId,
                winningBidId: winner.id,
                winnerOrganizationId: winner.bidderOrganizationId,
                hasJustification: judged.justification !== null,
                matrixDigest: judged.digest,
                approvalRequestId: resolution.request.id,
                awardedBy: principal.actor,
                awardedAt: at.toISOString(),
              },
              occurredAt: at,
            });
            for (const loser of losers) {
              await this.events.enqueue(tx, {
                eventName: 'BID_NOT_AWARDED',
                aggregateId: tenderId,
                organizationId: principal.organizationId,
                payload: {
                  bidId: loser.id,
                  tenderId,
                  organizationId: principal.organizationId,
                  bidderOrganizationId: loser.bidderOrganizationId,
                  decidedAt: at.toISOString(),
                },
                occurredAt: at,
              });
            }
            await this.record(tx, principal, tenderId, winner.id, at);

            return {
              kind: 'AWARDED',
              view: {
                tenderId,
                status: 'AWARDED',
                bidId: winner.id,
                bidderOrganizationId: winner.bidderOrganizationId,
                amountMinor: amountMinor.toString(),
                rank: judged.rank,
                tied: judged.tied,
                justification: judged.justification,
                matrixDigest: judged.digest,
                standingAsOf: asOf.toISOString(),
                awardedAt: at.toISOString(),
                awardedBy: principal.actor,
                alreadyAwarded: false,
              },
            };
          }),
        { 'rasta.tender.command': 'award' },
      );
      // Inside the envelope, so that a stale approval is audited like every other refusal.
      if (committed.kind === 'STALE') throw approvalStale(WORKFLOW);
      return committed;
    });
    if (outcome.kind === 'PENDING') return { executed: false, request: outcome.request };
    if (outcome.kind === 'AWARDED') {
      tenderTransitionsTotal.inc({ service: SERVICE_NAME, command: 'award' });
    }
    return { executed: true, result: outcome.view };
  }

  // -- reading the award -----------------------------------------------------------------

  /**
   * The stored award, with the winner's price: the owner's authorised person, or contract-service
   * (CON-003) with a token signed for the owner's organization. The price is a bid's content, so it
   * is read through the same door as any other (ownership first and a 404 that is never a 403; the
   * roles and conflict rules for a person; the audit row `READ_AWARD`, granted or refused, in the
   * owner's log) and it is no longer on the shared topic (round 1 of #199).
   */
  async getAward(tenderId: string): Promise<TenderAwardView> {
    const context = getContext();
    const caller =
      context.authType === 'SERVICE'
        ? await this.authorizeService(tenderId)
        : await this.authorize(tenderId, '', 'READ_AWARD');
    return this.guarded(
      caller,
      tenderId,
      '',
      async () => {
        const principal =
          context.authType === 'SERVICE'
            ? caller
            : await this.identity.live(caller, 'AWARD_TENDER');
        if (context.authType !== 'SERVICE') await this.assertNotConflicted(principal, tenderId);
        return this.prisma.transaction(async (tx) => {
          const tender = await this.repo.lockSharedForRead(tx, principal.organizationId, tenderId);
          if (!tender) throw RastaError.notFound('Tender', tenderId);
          if (context.authType !== 'SERVICE') {
            const bids = await this.repo.listBidSummaries(tx, tenderId);
            this.assertNoBidderMembership(
              principal,
              bids.map((bid) => bid.bidderOrganizationId),
            );
          }
          const row = await this.awards.findAward(tx, tenderId);
          if (!row) throw RastaError.notFound('TenderAward', tenderId);
          const at = await transactionNow(tx);
          await this.audit.record(tx, {
            owner: principal.organizationId,
            tenderId,
            bidId: row.bidId,
            accessorOrganizationId: principal.organizationId,
            accessorUserId: principal.actor,
            purpose: 'READ_AWARD',
            outcome: 'GRANTED',
            at,
          });
          return awardView(row, true);
        });
      },
      'READ_AWARD',
    );
  }

  /**
   * A service caller (contract-service; the guard has admitted only the services `@AllowService`
   * names) acts for the organization its signed token names: the tender's owner, or the tender is
   * a 404. It has no user, so it is recorded under its service name.
   */
  private async authorizeService(tenderId: string): Promise<Principal> {
    const context = getContext();
    const found = await this.opens.findOwnership(tenderId);
    if (
      !found ||
      !context.organizationId ||
      found.organizationId !== context.organizationId ||
      !context.callerService
    ) {
      throw RastaError.notFound('Tender', tenderId);
    }
    return {
      organizationId: context.organizationId,
      actor: `service:${context.callerService}`,
      organizationIds: [],
    };
  }

  // -- the judgement ---------------------------------------------------------------------

  /**
   * Everything the command is judged on, in the caller's transaction, with the tender locked (shared
   * for the first look, exclusive for the decision), in this order — so that nobody learns anything
   * about a tender they may not act on: the conflict of interest; the awarder against the evaluators;
   * an award already made (the same one again answers itself, another is 409); the tender EVALUATED;
   * the bid one of its QUALIFIED ones; and the justification the rank asks for.
   */
  private async judge(
    tx: ExtendedPrismaClient,
    principal: LivePrincipal,
    tender: TenderForEvaluation,
    bids: readonly BidSummary[],
    dto: AwardTenderDto,
  ): Promise<Judged> {
    this.assertNoBidderMembership(
      principal,
      bids.map((bid) => bid.bidderOrganizationId),
    );
    const input = await readMatrixInput(this.repo, tx, tender, bids, {
      minEvaluators: this.env.CONSTRUCTION_EVALUATION_MIN_EVALUATORS,
      maxEvaluators: this.env.CONSTRUCTION_EVALUATION_MAX_EVALUATORS,
    });
    if (this.env.CONSTRUCTION_COI_RULES.includes('AWARDER_NOT_EVALUATOR')) {
      await this.assertAwarderIsNotEvaluator(tx, tender);
    }

    const recorded = await this.awards.findAward(tx, tender.id);
    if (recorded) {
      if (recorded.bidId !== dto.bidId) {
        awardRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'already_awarded' });
        throw new RastaError(ERROR_CODES.ALREADY_EXISTS, 'Tender already awarded', {
          internalContext: { resourceType: 'TenderAward', refusals: ['ALREADY_AWARDED'] },
        });
      }
      return { replay: awardView(recorded, true) };
    }

    if (tender.status !== 'EVALUATED' || tender.evaluatedAt === null) {
      throw this.rule('NOT_EVALUATED');
    }
    const bid = bids.find((candidate) => candidate.id === dto.bidId);
    if (!bid) throw RastaError.notFound('Bid', dto.bidId);
    if (bid.status !== 'QUALIFIED') throw this.rule('BID_NOT_QUALIFIED');

    const ranked = buildMatrix(input).bids.find((entry) => entry.bidId === bid.id);
    if (!ranked || ranked.rank === null) throw this.rule('BID_NOT_QUALIFIED');
    const justification = dto.justification ?? null;
    // Only the single first rank is the matrix's own choice; any other is a person's, and says why.
    if ((ranked.rank !== 1 || ranked.tied) && justification === null) {
      throw this.rule('JUSTIFICATION_REQUIRED', { rank: ranked.rank, tied: ranked.tied });
    }
    return {
      replay: null,
      bid,
      rank: ranked.rank,
      tied: ranked.tied,
      digest: matrixDigest(input),
      justification,
    };
  }

  /**
   * `AWARDER_NOT_EVALUATOR` (Q-90, Q-93; on by default and strict): the awarder is none of the people
   * who took part in the evaluation — who decided on a bid, scored one, stood down from one, or
   * completed the evaluation. People are compared on the token's issuer and subject
   * (`compareActors`, #188), not on user ids, with the identity each row recorded when it was written.
   * The same person is 403; a person who cannot be told from them is 422 (fail closed): a row that
   * names no stable identity (older than the record, or another issuer) cannot show that two user ids
   * are two people.
   */
  private async assertAwarderIsNotEvaluator(
    tx: ExtendedPrismaClient,
    tender: TenderForEvaluation,
  ): Promise<void> {
    const participants = await this.awards.listParticipants(tx, tender.id);
    if (tender.evaluatedBy) {
      participants.push(
        storedActor(tender.evaluatedBy, tender.evaluatedByIssuer, tender.evaluatedBySubject),
      );
    }
    const awarder = currentActor();
    let unknown = false;
    for (const person of participants) {
      const comparison = compareActors(awarder, person);
      if (comparison === 'SAME') {
        throw this.forbid(
          'AWARDER_IS_EVALUATOR',
          'The person who awards a tender is none of those who evaluated its bids',
        );
      }
      if (comparison === 'UNKNOWN') unknown = true;
    }
    if (unknown) throw this.rule('ACTOR_IDENTITY_UNKNOWN');
  }

  /** A member of any organization that bid (withdrawn bids included) does not award the tender (ADR-067 § 4). */
  private assertNoBidderMembership(
    principal: Principal,
    bidderOrganizationIds: readonly string[],
  ): void {
    const bidders = new Set(bidderOrganizationIds);
    if (principal.organizationIds.some((organization) => bidders.has(organization))) {
      throw this.forbid(
        'CONFLICT_OF_INTEREST',
        'A member of an organization that bid on this tender does not award it',
      );
    }
  }

  /** The conflict check before anything else is asked of anyone, so that a conflicted caller learns nothing. */
  private async assertNotConflicted(principal: Principal, tenderId: string): Promise<void> {
    const bidders = await this.prisma.transaction((tx) =>
      this.opens.listBidderOrganizationIds(tx, tenderId),
    );
    this.assertNoBidderMembership(principal, bidders);
  }

  // -- the envelope ------------------------------------------------------------------------

  /**
   * The single, fail-closed decision of who may touch the award route, as for evaluation
   * (`EvaluationService.authorize`): **ownership first** — a tender that does not exist, is another
   * organization's, or is asked for with no organization to act for is 404 and **not logged** — then
   * the roles (`assertCanAward`), whose refusal on the caller's own tender is audited.
   */
  private async authorize(
    tenderId: string,
    bidId: string,
    purpose: BidAccessPurpose = 'AWARD_TENDER',
  ): Promise<Principal> {
    const context = getContext();
    const found = await this.opens.findOwnership(tenderId);
    if (!found || !context.organizationId || found.organizationId !== context.organizationId) {
      throw RastaError.notFound('Tender', tenderId);
    }
    try {
      return this.access.assertCanAward();
    } catch (error) {
      // Nobody to attribute it to when the token names no actor: no row can name one that is not there.
      if (error instanceof RastaError && context.authType !== 'SERVICE' && context.userId) {
        await this.recordRefusal(
          found.organizationId,
          tenderId,
          bidId,
          {
            organizationId: context.organizationId,
            actor: context.userId,
            organizationIds: context.organizationIds ?? [],
          },
          error,
          purpose,
        );
      }
      throw error;
    }
  }

  /** Runs `work` for a caller `authorize` has shown to act for the owner; a refusal is committed as a REFUSED row before it is answered. */
  private async guarded<T>(
    principal: Principal,
    tenderId: string,
    bidId: string,
    work: () => Promise<T>,
    purpose: BidAccessPurpose = 'AWARD_TENDER',
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof RastaError) {
        await this.recordRefusal(
          principal.organizationId,
          tenderId,
          bidId,
          principal,
          error,
          purpose,
        );
      }
      throw error;
    }
  }

  /**
   * The refusal, in a transaction of its own (the one that refused has rolled back), against the bid
   * the caller named when it is one of this tender's. Best effort: it never replaces the answer.
   */
  private async recordRefusal(
    owner: string,
    tenderId: string,
    bidId: string,
    principal: Principal,
    error: RastaError,
    purpose: BidAccessPurpose = 'AWARD_TENDER',
  ): Promise<void> {
    try {
      await this.prisma.transaction(async (tx) => {
        const named = await this.repo.findBidSummary(tx, tenderId, bidId);
        await this.audit.record(tx, {
          owner,
          tenderId,
          bidId: named?.id ?? null,
          accessorOrganizationId: principal.organizationId,
          accessorUserId: principal.actor,
          purpose,
          outcome: 'REFUSED',
          refusalCode: refusalCodeOf(error),
          at: await transactionNow(tx),
        });
      });
    } catch (cause) {
      this.logger.error(
        `could not record a refused award: ${cause instanceof Error ? cause.name : 'unknown'}`,
      );
    }
  }

  /** The granted row and `BID_ACCESSED` of the read of the winner's price, in the award's transaction. */
  private async record(
    tx: ExtendedPrismaClient,
    principal: Principal,
    tenderId: string,
    bidId: string,
    at: Date,
  ): Promise<void> {
    await this.audit.record(tx, {
      owner: principal.organizationId,
      tenderId,
      bidId,
      accessorOrganizationId: principal.organizationId,
      accessorUserId: principal.actor,
      purpose: 'AWARD_TENDER',
      outcome: 'GRANTED',
      at,
    });
  }

  // -- errors ------------------------------------------------------------------------------

  private forbid(reason: AwardRefusal, message: string): RastaError {
    awardRefusalsTotal.inc({ service: SERVICE_NAME, reason: reason.toLowerCase() });
    return new RastaError(ERROR_CODES.FORBIDDEN, `Award refused: ${reason}. ${message}`, {
      internalContext: { refusals: [reason] },
    });
  }

  private rule(reason: AwardRefusal, context: Record<string, unknown> = {}): RastaError {
    awardRefusalsTotal.inc({ service: SERVICE_NAME, reason: reason.toLowerCase() });
    return RastaError.businessRule(`Award refused: ${reason}`, { ...context, refusals: [reason] });
  }

  private conflict(aggregate: 'Bid' | 'Tender', id: string): RastaError {
    versionConflictsTotal.inc({ service: SERVICE_NAME, aggregate });
    return RastaError.optimisticLockFailed(aggregate, id);
  }
}

function awardView(row: TenderAward, alreadyAwarded: boolean): TenderAwardView {
  return {
    tenderId: row.tenderId,
    status: 'AWARDED',
    bidId: row.bidId,
    bidderOrganizationId: row.bidderOrganizationId,
    amountMinor: row.amountMinor.toString(),
    rank: row.rank,
    tied: row.tied,
    justification: row.justification,
    matrixDigest: row.matrixDigest,
    standingAsOf: row.standingAsOf.toISOString(),
    awardedAt: row.awardedAt.toISOString(),
    awardedBy: row.awardedBy,
    alreadyAwarded,
  };
}
