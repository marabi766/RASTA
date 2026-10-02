import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RastaError, getContext } from '@rasta/nest-common';
import { ERROR_CODES } from '@rasta/contracts';
import { withFinancialSpan } from '@rasta/observability';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import type { BidAccessPurpose } from '../events/events';
import { ProjectAccess } from '../access/access';
import { SERVICE_NAME, type ConstructionEnv } from '../config/env';
import { evaluationRefusalsTotal, tenderTransitionsTotal } from '../observability/metrics';
import { versionConflictsTotal } from '../observability/metrics';
import { transactionNow } from '../shared/clock';
import { ENV } from '../tokens';
import { BidAccessAudit, refusalCodeOf } from './bid-access-audit';
import { TenderClock } from './tender-clock';
import { TenderOpenRepository } from './tender-open.repository';
import {
  EvaluationRepository,
  type BidSummary,
  type TenderForEvaluation,
} from './evaluation.repository';
import { OwnerIdentity, type LivePrincipal, type Principal } from './owner-identity';
import { StandingAuthority } from './standing-authority';
import { assertTenderTransition } from './tender.state-machine';
import { buildMatrix, matrixDigest, type MatrixInput } from './evaluation-matrix';
import type {
  EvaluatedView,
  MatrixView,
  QualificationView,
  QualifyBidDto,
  RecusalView,
  RecuseDto,
  ScoreBidDto,
  ScoreRecordedView,
} from './evaluation.dto';

/**
 * The closed reasons an evaluation command or read is refused for (ADR-067 § 4): the metric's
 * label, the access log's `refusal_code`, and the code in the answer's message.
 */
export const EVALUATION_REFUSALS = [
  'CONFLICT_OF_INTEREST',
  'EVALUATOR_IS_TENDER_AUTHOR',
  'RECUSED',
  'NOT_OPENED',
  'NOT_EVALUATING',
  'BID_NOT_OPENED',
  'BID_NOT_QUALIFIED',
  'BID_ALREADY_DECIDED',
  'BID_NOT_EVALUABLE',
  'BIDDER_NOT_ELIGIBLE',
  'UNKNOWN_CRITERION',
  'SCORE_OUT_OF_RANGE',
  'EVALUATOR_LIMIT',
  'NO_QUALIFIED_BID',
  'EVALUATION_INCOMPLETE',
] as const;
export type EvaluationRefusal = (typeof EVALUATION_REFUSALS)[number];

/** What the transaction of an evaluation command works with, once the tender is locked and judged. */
interface Locked {
  tx: ExtendedPrismaClient;
  principal: LivePrincipal;
  tender: TenderForEvaluation;
  bids: BidSummary[];
  /** The decision instant: the database clock, read after the lock. */
  at: Date;
}

const sha256 = (lines: readonly string[]): string =>
  createHash('sha256')
    .update([...lines].sort().join('\n'))
    .digest('hex');

/**
 * Evaluating the opened bids of a tender (ADR-067 § 2, § 4): the owner's evaluators decide on
 * each bid, score the qualified ones against the tender's frozen criteria, may stand down from
 * a bid, and one of them completes the evaluation (EVALUATING → EVALUATED).
 *
 * ## One lock, one clock
 *
 * Every write takes the tender row `FOR UPDATE` first — the lock `close`, `open-bids` and every
 * owner command take — and reads the decision instant from the tender clock **after** it, so a
 * decision, a score and the completion of the evaluation queue behind one another and each order
 * has one outcome: a score that loses to `evaluate` finds the tender EVALUATED and is refused.
 * The database says the same (a trigger: nothing is recorded unless the tender is EVALUATING,
 * and every table is append-only), so a forgotten path cannot reopen a frozen matrix.
 *
 * ## Who, as they are now
 *
 * The configured roles (`CONSTRUCTION_TENDER_EVALUATE_ROLES`, by default the owner's own role
 * set) with the **same** exclusions as opening bids — `SYSTEM_ADMIN`, `AUDITOR`, `CONTRACTOR`
 * and a service token, each refused whenever present, from the one list in `ProjectAccess`. The
 * caller is judged on identity-service as of now (`OwnerIdentity`, fail closed: it cannot be
 * reached, 502/504, nothing is shown), on every route: a member of **any** organization that bid
 * (withdrawn bids included) is refused 403 `CONFLICT_OF_INTEREST` before anything is said about
 * the tender's state. The configurable rules (`CONSTRUCTION_COI_RULES`, off by default) refuse
 * with their own code: `EVALUATOR_NOT_TENDER_AUTHOR` — the user who created or published the
 * tender. **Every refusal is audited**: a REFUSED `bid_access_log` row (with its closed code) and
 * `BID_ACCESSED`, committed before the answer.
 *
 * Residual, as for opening (ADR-066 § 4): no lock spans identity-service and this service, so a
 * membership created after the identity read of a command and before it commits is not stopped;
 * every later command reads identity afresh, and the access log names who did what, when.
 *
 * ## Recusal
 *
 * An evaluator stands down from one bid with a closed reason (final, append-only): their scores
 * for it leave the matrix, they may not score or decide on it again, and their place is free for
 * another evaluator. A decision they already made stays on the record — a bid's decision is
 * one-way (OPENED → QUALIFIED | DISQUALIFIED) — and the stand-down is on record beside it.
 *
 * ## What is not decided here
 *
 * The system ranks and shows; it **chooses nothing** (ADR-067 § 3): ties share a rank and make no
 * winner, and `award` is CON-002 PR 10. A tender with no qualified bid is not completed: it can
 * only be cancelled with `NO_QUALIFIED_BID` (the cancel gate is PR 11). Evaluator count, the
 * aggregation of several evaluators, the closed reason lists and the optional conflict rules are
 * provisional, configurable answers (Q-88, Q-90, Q-92).
 */
@Injectable()
export class EvaluationService {
  private readonly logger = new Logger(EvaluationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: EvaluationRepository,
    private readonly opens: TenderOpenRepository,
    private readonly audit: BidAccessAudit,
    private readonly events: EventPublisher,
    private readonly access: ProjectAccess,
    private readonly identity: OwnerIdentity,
    private readonly standing: StandingAuthority,
    private readonly clock: TenderClock,
    @Inject(ENV) private readonly env: ConstructionEnv,
  ) {}

  // -- decide on a bid -------------------------------------------------------------------

  async qualify(tenderId: string, bidId: string, dto: QualifyBidDto): Promise<QualificationView> {
    const caller = await this.authorize(tenderId, 'QUALIFY_BID');
    return this.guarded(caller, tenderId, 'QUALIFY_BID', async () => {
      const principal = await this.identity.live(caller, 'EVALUATE_BIDS');
      await this.assertNotConflicted(principal, tenderId);
      // Eligibility is a decision for supplier-service (Q-85): asked outside any lock, fail closed,
      // only for a qualification (a bid may always be disqualified) and only before a NEW decision:
      // a decision already on record is answered as it stands (below, under the lock), so an
      // idempotent repeat never fails on a supplier-service that is down or has since suspended.
      const recorded = await this.prisma.transaction((tx) =>
        this.repo.findQualification(tx, tenderId, bidId),
      );
      const standingAsOf =
        dto.decision === 'QUALIFIED' && !recorded ? await this.standingOf(tenderId, bidId) : null;
      return withFinancialSpan(
        'construction.bid.qualify',
        () =>
          this.prisma.transaction(async (tx) => {
            const locked = await this.enter(tx, principal, tenderId);
            const bid = this.bidOf(locked, bidId);
            const existing = await this.repo.findQualification(tx, tenderId, bidId);
            if (existing) {
              // The same decision again is the same answer, written once; another one is refused.
              if (existing.decision !== dto.decision) throw this.rule('BID_ALREADY_DECIDED');
              return {
                bidId,
                tenderId,
                decision: existing.decision,
                reasonCode: toDisqualification(existing.reasonCode),
                decidedAt: existing.decidedAt.toISOString(),
                decidedBy: existing.decidedBy,
                alreadyDecided: true,
              };
            }
            if (bid.status !== 'OPENED') throw this.rule('BID_NOT_OPENED');
            await this.assertNotRecused(tx, tenderId, bidId, principal.actor);

            const { at } = locked;
            const reasonCode = dto.decision === 'DISQUALIFIED' ? (dto.reasonCode ?? null) : null;
            await this.repo.insertQualification(tx, {
              id: newId(ID_PREFIX.qualification),
              organizationId: principal.organizationId,
              tenderId,
              bidId,
              decision: dto.decision,
              reasonCode,
              reasonText: dto.decision === 'DISQUALIFIED' ? (dto.reasonText ?? null) : null,
              standingAsOf,
              actor: principal.actor,
              at,
            });
            const matched = await this.repo.decideBid(tx, {
              bidId,
              decision: dto.decision,
              actor: principal.actor,
              at,
            });
            if (matched === 0) throw this.conflict('Bid', bidId);

            const base = {
              bidId,
              tenderId,
              organizationId: principal.organizationId,
              decidedBy: principal.actor,
              decidedAt: at.toISOString(),
            };
            if (dto.decision === 'QUALIFIED') {
              await this.events.enqueue(tx, {
                eventName: 'BID_QUALIFIED',
                aggregateId: tenderId,
                organizationId: principal.organizationId,
                payload: base,
                occurredAt: at,
              });
            } else if (reasonCode) {
              await this.events.enqueue(tx, {
                eventName: 'BID_DISQUALIFIED',
                aggregateId: tenderId,
                organizationId: principal.organizationId,
                payload: { ...base, reasonCode },
                occurredAt: at,
              });
            }
            await this.record(tx, principal, tenderId, bidId, 'QUALIFY_BID', at);
            return {
              bidId,
              tenderId,
              decision: dto.decision,
              reasonCode,
              decidedAt: at.toISOString(),
              decidedBy: principal.actor,
              alreadyDecided: false,
            };
          }),
        { 'rasta.tender.command': 'qualify-bid' },
      );
    });
  }

  // -- standing down ---------------------------------------------------------------------

  async recuse(tenderId: string, bidId: string, dto: RecuseDto): Promise<RecusalView> {
    const caller = await this.authorize(tenderId, 'RECUSE');
    return this.guarded(caller, tenderId, 'RECUSE', async () => {
      const principal = await this.identity.live(caller, 'EVALUATE_BIDS');
      await this.assertNotConflicted(principal, tenderId);
      return this.prisma.transaction(async (tx) => {
        const locked = await this.enter(tx, principal, tenderId);
        const bid = this.bidOf(locked, bidId);
        const existing = await this.repo.findRecusal(tx, tenderId, bidId, principal.actor);
        if (existing) {
          return {
            bidId,
            tenderId,
            evaluatorId: existing.evaluatorId,
            reasonCode: toRecusal(existing.reasonCode),
            recusedAt: existing.recusedAt.toISOString(),
            alreadyRecused: true,
          };
        }
        if (bid.status !== 'OPENED' && bid.status !== 'QUALIFIED') {
          throw this.rule('BID_NOT_EVALUABLE');
        }
        const { at } = locked;
        await this.repo.insertRecusal(tx, {
          id: newId(ID_PREFIX.recusal),
          organizationId: principal.organizationId,
          tenderId,
          bidId,
          evaluatorId: principal.actor,
          reasonCode: dto.reasonCode,
          at,
        });
        await this.events.enqueue(tx, {
          eventName: 'BID_EVALUATOR_RECUSED',
          aggregateId: tenderId,
          organizationId: principal.organizationId,
          payload: {
            bidId,
            tenderId,
            organizationId: principal.organizationId,
            evaluatorId: principal.actor,
            reasonCode: dto.reasonCode,
            recusedAt: at.toISOString(),
          },
          occurredAt: at,
        });
        await this.record(tx, principal, tenderId, bidId, 'RECUSE', at);
        return {
          bidId,
          tenderId,
          evaluatorId: principal.actor,
          reasonCode: dto.reasonCode,
          recusedAt: at.toISOString(),
          alreadyRecused: false,
        };
      });
    });
  }

  // -- score a bid -----------------------------------------------------------------------

  async score(tenderId: string, bidId: string, dto: ScoreBidDto): Promise<ScoreRecordedView> {
    const caller = await this.authorize(tenderId, 'SCORE_BID');
    return this.guarded(caller, tenderId, 'SCORE_BID', async () => {
      const principal = await this.identity.live(caller, 'EVALUATE_BIDS');
      await this.assertNotConflicted(principal, tenderId);
      return withFinancialSpan(
        'construction.bid.score',
        () =>
          this.prisma.transaction(async (tx) => {
            const locked = await this.enter(tx, principal, tenderId);
            const bid = this.bidOf(locked, bidId);
            await this.assertNotRecused(tx, tenderId, bidId, principal.actor);
            if (bid.status !== 'QUALIFIED') throw this.rule('BID_NOT_QUALIFIED');

            const criteria = await this.repo.listCriteria(tx, tenderId);
            const byCode = new Map(criteria.map((criterion) => [criterion.code, criterion]));
            for (const { criterionCode, scoreScaled } of dto.scores) {
              const criterion = byCode.get(criterionCode);
              if (!criterion) throw this.rule('UNKNOWN_CRITERION');
              const top = criterion.maxScore * 100;
              if (
                scoreScaled < 0 ||
                scoreScaled > top ||
                (criterion.scoringMethod === 'PASS_FAIL' &&
                  scoreScaled !== 0 &&
                  scoreScaled !== top)
              ) {
                throw this.rule('SCORE_OUT_OF_RANGE');
              }
            }

            const { at } = locked;
            let evaluation = await this.repo.findEvaluation(tx, tenderId, bidId, principal.actor);
            if (!evaluation) {
              const active = await this.repo.countActiveEvaluators(tx, tenderId, bidId);
              if (active >= this.env.CONSTRUCTION_EVALUATION_MAX_EVALUATORS) {
                throw this.rule('EVALUATOR_LIMIT');
              }
              const id = newId(ID_PREFIX.evaluation);
              await this.repo.insertEvaluation(tx, {
                id,
                organizationId: principal.organizationId,
                tenderId,
                bidId,
                evaluatorId: principal.actor,
                at,
              });
              evaluation = {
                id,
                organizationId: principal.organizationId,
                tenderId,
                bidId,
                evaluatorId: principal.actor,
                createdAt: at,
              };
            }

            const latest = new Map<string, { revision: number; scoreScaled: number }>();
            for (const row of await this.repo.listScoresOf(tx, evaluation.id)) {
              const current = latest.get(row.criterionCode);
              if (!current || current.revision < row.revision) {
                latest.set(row.criterionCode, {
                  revision: row.revision,
                  scoreScaled: row.scoreScaled,
                });
              }
            }
            const recorded: { criterionCode: string; revision: number; scoreScaled: number }[] = [];
            const unchanged: string[] = [];
            for (const { criterionCode, scoreScaled } of dto.scores) {
              const current = latest.get(criterionCode);
              // A revision is a change: the score already standing is not appended again.
              if (current && current.scoreScaled === scoreScaled) {
                unchanged.push(criterionCode);
                continue;
              }
              const revision = (current?.revision ?? 0) + 1;
              await this.repo.insertScore(tx, {
                id: newId(ID_PREFIX.score),
                organizationId: principal.organizationId,
                tenderId,
                bidId,
                evaluationId: evaluation.id,
                evaluatorId: principal.actor,
                criterionCode,
                revision,
                scoreScaled,
                at,
              });
              latest.set(criterionCode, { revision, scoreScaled });
              recorded.push({ criterionCode, revision, scoreScaled });
            }

            if (recorded.length > 0) {
              await this.events.enqueue(tx, {
                eventName: 'BID_SCORED',
                aggregateId: tenderId,
                organizationId: principal.organizationId,
                payload: {
                  bidId,
                  tenderId,
                  organizationId: principal.organizationId,
                  evaluationId: evaluation.id,
                  evaluatorId: principal.actor,
                  recordedCount: recorded.length,
                  scoresDigest: sha256(
                    recorded.map((r) => `${r.criterionCode}|${r.revision}|${r.scoreScaled}`),
                  ),
                  scoredAt: at.toISOString(),
                },
                occurredAt: at,
              });
              await this.record(tx, principal, tenderId, bidId, 'SCORE_BID', at);
            }
            return {
              bidId,
              tenderId,
              evaluationId: evaluation.id,
              evaluatorId: principal.actor,
              recorded,
              unchanged,
              complete: criteria.every((criterion) => latest.has(criterion.code)),
            };
          }),
        { 'rasta.tender.command': 'score-bid' },
      );
    });
  }

  // -- complete the evaluation -----------------------------------------------------------

  async evaluate(tenderId: string): Promise<EvaluatedView> {
    const caller = await this.authorize(tenderId, 'EVALUATE_BIDS');
    const { view, completed } = await this.guarded(caller, tenderId, 'EVALUATE_BIDS', async () => {
      const principal = await this.identity.live(caller, 'EVALUATE_BIDS');
      await this.assertNotConflicted(principal, tenderId);
      return withFinancialSpan(
        'construction.tender.evaluate',
        () =>
          this.prisma.transaction(
            async (tx): Promise<{ view: EvaluatedView; completed: boolean }> => {
              const tender = await this.repo.lockForEvaluation(
                tx,
                principal.organizationId,
                tenderId,
              );
              if (!tender) throw RastaError.notFound('Tender', tenderId);
              const bids = await this.repo.listBidSummaries(tx, tenderId);
              this.assertEvaluatorMayAct(principal, tender, bids);
              const input = await this.matrixInput(tx, tender, bids);

              if (tender.evaluatedAt !== null && tender.evaluatedBy !== null) {
                // Completed before: the same answer, written once.
                return {
                  view: evaluatedView(tender, input, tender.evaluatedAt, tender.evaluatedBy, true),
                  completed: false,
                };
              }
              if (tender.status !== 'EVALUATING') throw this.rule('NOT_EVALUATING');
              assertTenderTransition(tenderId, tender.status, 'EVALUATED');
              const at = await this.clock.decisionInstant(tx);

              const matrix = buildMatrix(input);
              if (!bids.some((bid) => bid.status === 'QUALIFIED')) {
                // Cancelling with this reason is the owner's (CON-002 PR 11), not a completion.
                throw this.rule('NO_QUALIFIED_BID');
              }
              if (!matrix.ready) {
                throw this.rule('EVALUATION_INCOMPLETE', {
                  blockers: matrix.blockers,
                  undecidedBidCount: matrix.undecidedBidCount,
                });
              }
              const matched = await this.repo.completeEvaluation(tx, {
                tenderId,
                expectedVersion: tender.version,
                actor: principal.actor,
                at,
              });
              if (matched === 0) throw this.conflict('Tender', tenderId);

              const qualifiedBidCount = input.qualifications.filter(
                (q) => q.decision === 'QUALIFIED',
              ).length;
              await this.events.enqueue(tx, {
                eventName: 'BIDS_EVALUATED',
                aggregateId: tenderId,
                organizationId: principal.organizationId,
                payload: {
                  tenderId,
                  projectId: tender.projectId,
                  organizationId: principal.organizationId,
                  evaluatedBidCount: qualifiedBidCount,
                  matrixDigest: matrixDigest(input),
                  evaluatedBy: principal.actor,
                  evaluatedAt: at.toISOString(),
                },
                occurredAt: at,
              });
              await this.record(tx, principal, tenderId, null, 'EVALUATE_BIDS', at);
              return {
                view: evaluatedView(
                  { ...tender, status: 'EVALUATED' },
                  input,
                  at,
                  principal.actor,
                  false,
                ),
                completed: true,
              };
            },
          ),
        { 'rasta.tender.command': 'evaluate' },
      );
    });
    if (completed) tenderTransitionsTotal.inc({ service: SERVICE_NAME, command: 'evaluate' });
    return view;
  }

  // -- read the matrix -------------------------------------------------------------------

  /**
   * The matrix and the ranking, as the owner's evaluators see them. Each read is audited like a
   * read of the bids it names (a row and `BID_ACCESSED` per bid, `READ_EVALUATION`).
   */
  async getMatrix(tenderId: string): Promise<MatrixView> {
    const caller = await this.authorize(tenderId, 'READ_EVALUATION');
    return this.guarded(caller, tenderId, 'READ_EVALUATION', async () => {
      const principal = await this.identity.live(caller, 'EVALUATE_BIDS');
      await this.assertNotConflicted(principal, tenderId);
      return this.prisma.transaction(async (tx) => {
        const tender = await this.repo.lockSharedForRead(tx, principal.organizationId, tenderId);
        if (!tender) throw RastaError.notFound('Tender', tenderId);
        const bids = await this.repo.listBidSummaries(tx, tenderId);
        this.assertEvaluatorMayAct(principal, tender, bids);
        if (tender.openedAt === null) throw this.rule('NOT_OPENED');
        const at = await transactionNow(tx);
        const matrix = buildMatrix(await this.matrixInput(tx, tender, bids));
        for (const bidId of bids.length > 0 ? bids.map((bid) => bid.id) : [null]) {
          await this.record(tx, principal, tenderId, bidId, 'READ_EVALUATION', at);
        }
        return matrix;
      });
    });
  }

  // -- the envelope and its checks --------------------------------------------------------

  /**
   * The roles check of an evaluation route. A refusal of a caller who acts for the tender's **own**
   * organization is audited (a REFUSED row with the closed code, before the answer); a tender the
   * caller cannot see answers what a missing one does and is **not** logged: nothing is disclosed
   * about it and nobody's log learns of a stranger's probing by role (ADR-066 § 5, ADR-067 § 4).
   */
  private async authorize(tenderId: string, purpose: BidAccessPurpose): Promise<Principal> {
    try {
      return this.access.assertCanEvaluate();
    } catch (error) {
      if (error instanceof RastaError) await this.recordOwnRefusal(tenderId, purpose, error);
      throw error;
    }
  }

  private async recordOwnRefusal(
    tenderId: string,
    purpose: BidAccessPurpose,
    error: RastaError,
  ): Promise<void> {
    const context = getContext();
    // Nobody to attribute it to: no log row can name an actor that is not there.
    if (context.authType === 'SERVICE' || !context.organizationId || !context.userId) return;
    let found;
    try {
      found = await this.opens.findOwnership(tenderId);
    } catch {
      return;
    }
    if (!found || found.organizationId !== context.organizationId) return;
    await this.recordRefusal(
      found.organizationId,
      tenderId,
      {
        organizationId: context.organizationId,
        actor: context.userId,
        organizationIds: context.organizationIds ?? [],
      },
      purpose,
      error,
    );
  }

  /**
   * Finds the tender, tells another organization's from a missing one without telling the
   * caller, runs `work`, and — when it refuses — commits a REFUSED row (with the closed code)
   * for the attempt before the error is answered (ADR-066 § 5, ADR-067 § 4).
   */
  private async guarded<T>(
    principal: Principal,
    tenderId: string,
    purpose: BidAccessPurpose,
    work: () => Promise<T>,
  ): Promise<T> {
    const found = await this.opens.findOwnership(tenderId);
    if (!found) throw RastaError.notFound('Tender', tenderId);
    if (found.organizationId !== principal.organizationId) {
      // Not theirs: they are told what a missing tender is told, and the owner is told who asked.
      const error = RastaError.notFound('Tender', tenderId);
      await this.recordRefusal(found.organizationId, tenderId, principal, purpose, error);
      throw error;
    }
    try {
      return await work();
    } catch (error) {
      // The bid the caller named is not stored: it is not looked up for a refusal.
      if (error instanceof RastaError) {
        await this.recordRefusal(found.organizationId, tenderId, principal, purpose, error);
      }
      throw error;
    }
  }

  /** The refusal, in a transaction of its own (the one that refused has rolled back). Best effort: it never replaces the answer. */
  private async recordRefusal(
    owner: string,
    tenderId: string,
    principal: Principal,
    purpose: BidAccessPurpose,
    error: RastaError,
  ): Promise<void> {
    try {
      await this.prisma.transaction(async (tx) => {
        await this.audit.record(tx, {
          owner,
          tenderId,
          bidId: null,
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
        `could not record a refused evaluation request: ${cause instanceof Error ? cause.name : 'unknown'}`,
      );
    }
  }

  /** The granted row and `BID_ACCESSED` of a command or read, in its transaction. */
  private async record(
    tx: ExtendedPrismaClient,
    principal: Principal,
    tenderId: string,
    bidId: string | null,
    purpose: BidAccessPurpose,
    at: Date,
  ): Promise<void> {
    await this.audit.record(tx, {
      owner: principal.organizationId,
      tenderId,
      bidId,
      accessorOrganizationId: principal.organizationId,
      accessorUserId: principal.actor,
      purpose,
      outcome: 'GRANTED',
      at,
    });
  }

  /**
   * Locks the tender, judges the caller against it **before anything is said about its state**
   * (a conflicted evaluator learns nothing), then that it is EVALUATING, and reads the decision
   * instant from the clock after the lock.
   */
  private async enter(
    tx: ExtendedPrismaClient,
    principal: LivePrincipal,
    tenderId: string,
  ): Promise<Locked> {
    const tender = await this.repo.lockForEvaluation(tx, principal.organizationId, tenderId);
    if (!tender) throw RastaError.notFound('Tender', tenderId);
    const bids = await this.repo.listBidSummaries(tx, tenderId);
    this.assertEvaluatorMayAct(principal, tender, bids);
    if (tender.status !== 'EVALUATING') throw this.rule('NOT_EVALUATING');
    return { tx, principal, tender, bids, at: await this.clock.decisionInstant(tx) };
  }

  /** The conflict check before the transaction, so that nothing else is asked of anyone for a conflicted caller. */
  private async assertNotConflicted(principal: Principal, tenderId: string): Promise<void> {
    const bidders = await this.prisma.transaction((tx) =>
      this.opens.listBidderOrganizationIds(tx, tenderId),
    );
    this.assertNoBidderMembership(principal, bidders);
  }

  /** The conflict-of-interest rules, in the transaction, against the bids as they stand under the lock. */
  private assertEvaluatorMayAct(
    principal: Principal,
    tender: TenderForEvaluation,
    bids: readonly BidSummary[],
  ): void {
    this.assertNoBidderMembership(
      principal,
      bids.map((bid) => bid.bidderOrganizationId),
    );
    if (
      this.env.CONSTRUCTION_COI_RULES.includes('EVALUATOR_NOT_TENDER_AUTHOR') &&
      (tender.createdBy === principal.actor || tender.publishedBy === principal.actor)
    ) {
      throw this.forbid(
        'EVALUATOR_IS_TENDER_AUTHOR',
        'The user who created or published a tender does not evaluate its bids',
      );
    }
  }

  /** A member of any organization that bid (withdrawn bids included) does not evaluate the tender (ADR-067 § 4). */
  private assertNoBidderMembership(
    principal: Principal,
    bidderOrganizationIds: readonly string[],
  ): void {
    const bidders = new Set(bidderOrganizationIds);
    if (principal.organizationIds.some((organization) => bidders.has(organization))) {
      throw this.forbid(
        'CONFLICT_OF_INTEREST',
        'A member of an organization that bid on this tender does not evaluate its bids',
      );
    }
  }

  private async assertNotRecused(
    tx: ExtendedPrismaClient,
    tenderId: string,
    bidId: string,
    evaluatorId: string,
  ): Promise<void> {
    if (await this.repo.findRecusal(tx, tenderId, bidId, evaluatorId)) {
      throw this.forbid('RECUSED', 'This evaluator stood down from this bid');
    }
  }

  /** Supplier-service's word on the contractor's standing now, asked outside any lock (fail closed). */
  private async standingOf(tenderId: string, bidId: string): Promise<Date | null> {
    const bid = await this.prisma.transaction((tx) =>
      this.repo.findBidSummary(tx, tenderId, bidId),
    );
    // No such bid: the transaction refuses it as 404, after the conflict checks.
    if (!bid) return null;
    const { verdict, asOf } = await this.standing.decisionFor(bid.bidderOrganizationId);
    if (verdict !== 'ELIGIBLE') throw this.rule('BIDDER_NOT_ELIGIBLE');
    return asOf;
  }

  private bidOf(locked: Locked, bidId: string): BidSummary {
    const bid = locked.bids.find((candidate) => candidate.id === bidId);
    if (!bid) throw RastaError.notFound('Bid', bidId);
    return bid;
  }

  /** Everything the matrix is made of, read in the caller's transaction. */
  private async matrixInput(
    tx: ExtendedPrismaClient,
    tender: TenderForEvaluation,
    bids: readonly BidSummary[],
  ): Promise<MatrixInput> {
    const [criteria, qualifications, evaluations, recusals, scores] = await Promise.all([
      this.repo.listCriteria(tx, tender.id),
      this.repo.listQualifications(tx, tender.id),
      this.repo.listEvaluations(tx, tender.id),
      this.repo.listRecusals(tx, tender.id),
      this.repo.listScores(tx, tender.id),
    ]);
    return {
      tenderId: tender.id,
      status: tender.status,
      frozen: tender.evaluatedAt !== null,
      criteria,
      bids,
      qualifications: qualifications.map((row) => ({
        bidId: row.bidId,
        decision: row.decision,
        reasonCode: row.reasonCode,
        reasonText: row.reasonText,
        decidedBy: row.decidedBy,
        decidedAt: row.decidedAt,
      })),
      evaluations,
      recusals,
      scores,
      minEvaluators: this.env.CONSTRUCTION_EVALUATION_MIN_EVALUATORS,
      maxEvaluators: this.env.CONSTRUCTION_EVALUATION_MAX_EVALUATORS,
    };
  }

  // -- errors ------------------------------------------------------------------------------

  private forbid(reason: EvaluationRefusal, message: string): RastaError {
    evaluationRefusalsTotal.inc({ service: SERVICE_NAME, reason: reason.toLowerCase() });
    return new RastaError(ERROR_CODES.FORBIDDEN, `Evaluation refused: ${reason}. ${message}`, {
      internalContext: { refusals: [reason] },
    });
  }

  private rule(reason: EvaluationRefusal, context: Record<string, unknown> = {}): RastaError {
    evaluationRefusalsTotal.inc({ service: SERVICE_NAME, reason: reason.toLowerCase() });
    return RastaError.businessRule(`Evaluation refused: ${reason}`, {
      ...context,
      refusals: [reason],
    });
  }

  private conflict(aggregate: 'Bid' | 'Tender', id: string): RastaError {
    versionConflictsTotal.inc({ service: SERVICE_NAME, aggregate });
    return RastaError.optimisticLockFailed(aggregate, id);
  }
}

function toDisqualification(code: string | null): QualificationView['reasonCode'] {
  return code as QualificationView['reasonCode'];
}

function toRecusal(code: string): RecusalView['reasonCode'] {
  return code as RecusalView['reasonCode'];
}

function evaluatedView(
  tender: Pick<TenderForEvaluation, 'id' | 'status'>,
  input: MatrixInput,
  at: Date,
  by: string,
  alreadyEvaluated: boolean,
): EvaluatedView {
  return {
    tenderId: tender.id,
    status: tender.status,
    evaluatedAt: at.toISOString(),
    evaluatedBy: by,
    // From the decisions, not the bids' status: an award moves a QUALIFIED bid on.
    qualifiedBidCount: input.qualifications.filter((q) => q.decision === 'QUALIFIED').length,
    matrixDigest: matrixDigest(input),
    alreadyEvaluated,
  };
}
