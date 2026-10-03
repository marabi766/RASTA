import { Inject, Injectable } from '@nestjs/common';
import { RastaError, currentActor } from '@rasta/nest-common';
import { withFinancialSpan } from '@rasta/observability';
import type { CursorPage } from '@rasta/contracts';
import type { TenderInvitation } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { storedIdentityOf } from '../shared/stable-actor';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { ProjectAccess, assertOwnTender } from '../access/access';
import { decisionInstant } from '../shared/clock';
import { OrganizationDirectory } from '../organization/organization-directory';
import { isUniqueViolation } from '../shared/prisma-errors';
import { ENV, TENDER_KEY_PROVIDER } from '../tokens';
import { SERVICE_NAME, type ConstructionEnv } from '../config/env';
import { tenderTransitionsTotal, versionConflictsTotal } from '../observability/metrics';
import { CriteriaRepository } from './criteria.repository';
import { TenderRepository, type LockedTender } from './tender.repository';
import { PublicationRepository } from './publication.repository';
import { TenderApprovalGate, type GateCaller } from './tender-approval.gate';
import { TenderApprovalRepository } from './tender-approval.repository';
import { approvalStale } from './tender-approval.errors';
import { toRequestView, type Gated, type TenderApprovalRequestView } from './tender-approval.dto';
import { publicationRefusals } from './publication';
import { assertTenderTransition } from './tender.state-machine';
import { SealingError } from './sealing/errors';
import { generateTenderKeyPair } from './sealing/sealing';
import type { TenderKeyProvider, WrappedKey } from './sealing/key-provider';
import { toTenderView } from './views';
import type { TenderView } from './dto';
import type {
  InvitationView,
  InviteBidderDto,
  ListInvitationsQuery,
  PublishTenderDto,
} from './publication.dto';

const WORKFLOW = 'tender.publication' as const;

/**
 * PublishTender and the invitations to a restricted tender (ADR-065, ADR-066).
 *
 * ## Publishing
 *
 * One transaction under the tender's row lock: the version, the transition
 * `DRAFT → PUBLISHED`, every condition of {@link publicationRefusals} judged
 * against the **database's** clock read after the lock, the state change, the
 * tender's key pair, and `TENDER_PUBLISHED`. The criteria are frozen by the
 * database from the moment the status leaves `DRAFT`, so what was checked is
 * what is now fixed.
 *
 * The key pair is made **before** the transaction (RSA generation is far too slow
 * to hold a row lock across) and wrapped by the key provider; the plaintext
 * private key is zeroised as soon as it is wrapped, and never stored, logged or
 * returned. If two publications race, the loser's key pair is discarded with its
 * refused transaction. If no key-encryption key is configured nothing is
 * published (`503`): a tender whose bids cannot be sealed must not open.
 *
 * ## The approval gate (Q-84, CON-002 PR 11) — fail closed
 *
 * `publish` refuses `APPROVAL_POLICY_REQUIRED` with no active `tender.publication` policy. With
 * one it opens the round (`TenderApprovalGate`) bound to the tender and its version and answers the
 * request; the same command publishes only when the request is APPROVED, using it up in the
 * publication's own transaction under the tender's lock, and refuses a stale one (409) — what the
 * authority approved is exactly what is published.
 */
@Injectable()
export class PublicationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenders: TenderRepository,
    private readonly criteria: CriteriaRepository,
    private readonly publications: PublicationRepository,
    private readonly events: EventPublisher,
    private readonly access: ProjectAccess,
    @Inject(ENV) private readonly env: ConstructionEnv,
    @Inject(TENDER_KEY_PROVIDER) private readonly keys: TenderKeyProvider,
    private readonly directory: OrganizationDirectory,
    private readonly gate: TenderApprovalGate,
    private readonly requests: TenderApprovalRepository,
  ) {}

  /**
   * POST /publish — the command behind the approval gate (Q-84, CON-002 PR 11). With no `tender.publication`
   * policy in force: 422 naming `APPROVAL_POLICY_REQUIRED` (with every other reason). With one: a publication
   * that could succeed opens (or finds) an approval request bound to this tender and its version, and the
   * answer is the request (`executed: false`, 202); once every step is granted the same command — on the same
   * version — publishes and uses the approval up in the same transaction (`executed: true`). A tender that
   * changed since the approval is 409 `APPROVAL_STALE`: nothing is published.
   */
  async publish(tenderId: string, dto: PublishTenderDto): Promise<Gated<TenderView>> {
    const { organizationId, actor } = this.access.assertCanWrite();
    const caller: GateCaller = {
      userId: actor,
      organizationId,
      identity: storedIdentityOf(currentActor()),
    };

    // A cheap, unlocked look at the version and the state, so a stale or repeated request does not cost a key
    // pair. Advisory only: everything is decided again under the lock, and the deadline is never judged here
    // (that would be the application clock).
    const first = await this.tenders.findTender(tenderId);
    if (!first) throw RastaError.notFound('Tender', tenderId);
    assertOwnTender(first, organizationId);

    const own = { organizationId, id: tenderId, projectId: first.projectId };
    return this.gate.guarded(own, WORKFLOW, caller, () => this.publishGated(tenderId, dto, caller));
  }

  private async publishGated(
    tenderId: string,
    dto: PublishTenderDto,
    caller: GateCaller,
  ): Promise<Gated<TenderView>> {
    const { organizationId, userId: actor } = caller;
    // Asked before any transaction: no row lock is held across a network call.
    const confirmedPolicyId = await this.gate.confirmPolicy(organizationId, WORKFLOW);
    const ready =
      confirmedPolicyId !== null &&
      (await this.gate.hasApproved(organizationId, tenderId, WORKFLOW));
    if (!ready) return this.askForApproval(tenderId, dto, caller, confirmedPolicyId);

    const keyId = newId(ID_PREFIX.tenderKey);
    const { publicKeyPem, wrapped } = await this.makeKey(tenderId, keyId);

    // The answer is read inside the transaction, with the tender still locked (the defect Codex found in
    // #162): what the caller is told is the state their own publication produced.
    const outcome = await withFinancialSpan(
      'construction.tender.publish',
      () =>
        this.prisma.transaction(async (tx): Promise<Gated<TenderView> | 'STALE'> => {
          const locked = await this.lockOrNotFound(tx, organizationId, tenderId);
          if (locked.version !== dto.expectedVersion) {
            const stale = await this.gate.endIfBehind(
              tx,
              {
                organizationId,
                id: tenderId,
                projectId: locked.projectId,
                version: locked.version,
              },
              WORKFLOW,
              caller,
              await decisionInstant(tx),
            );
            if (stale) return 'STALE';
            throw this.conflict(tenderId);
          }
          assertTenderTransition(tenderId, locked.status, 'PUBLISHED');

          // One instant, read **after** the lock: the deadline is judged on it, and the row, the key and the
          // event are all stamped with it. The transaction's start (`now()`) can precede a long wait for the
          // lock by seconds, which would date a publication before the decision that made it.
          const { row, criteria, refusals, at } = await this.judge(tx, tenderId, true);
          if (refusals.length > 0) throw this.refused(tenderId, refusals);

          const resolution = await this.gate.resolve(tx, {
            tender: {
              organizationId,
              id: tenderId,
              projectId: locked.projectId,
              version: locked.version,
            },
            binding: { workflowKey: WORKFLOW },
            confirmedPolicyId: confirmedPolicyId as string,
            caller,
            at,
          });
          // Ended in this transaction (committed with it): the command answers 409 once it is.
          if (resolution.kind === 'STALE') return 'STALE';
          // Not approved (any more): no key was made for a request that is only now being asked.
          if (resolution.kind === 'REQUESTED') {
            return {
              executed: false,
              request: toRequestView(
                resolution.request,
                await this.requests.steps(tx, resolution.request),
              ),
            };
          }

          const matched = await this.tenders.publishTender(tx, {
            tenderId,
            expectedVersion: dto.expectedVersion,
            actor,
            actorIdentity: caller.identity,
            at,
          });
          if (matched === 0) throw this.conflict(tenderId);

          await this.publications.createKey(tx, {
            organizationId,
            tenderId,
            keyId,
            publicKeyPem,
            wrapped,
            actor,
            at,
          });
          // The approval is used up here, once, in the transaction that publishes (the database refuses a
          // publication without it, and a second use of it).
          await this.gate.consume(
            tx,
            resolution.request,
            { organizationId, id: tenderId, projectId: locked.projectId, version: locked.version },
            caller,
            at,
          );

          // `row` was read before the update; the window and visibility it holds are what was judged and
          // what is now published.
          await this.events.enqueue(tx, {
            eventName: 'TENDER_PUBLISHED',
            aggregateId: tenderId,
            organizationId,
            payload: {
              tenderId,
              projectId: row.projectId,
              organizationId,
              visibility: row.visibility,
              bidOpeningAt: row.bidOpeningAt?.toISOString(),
              bidClosingAt: row.bidClosingAt?.toISOString(),
              criteriaCount: criteria.length,
              keyId,
              approvalRequestId: resolution.request.id,
              publishedBy: actor,
              publishedAt: at.toISOString(),
            },
            occurredAt: at,
          });
          return { executed: true, result: await this.view(organizationId, tenderId, tx) };
        }),
      { 'rasta.tender.command': 'publish' },
    );
    if (outcome === 'STALE') throw approvalStale(WORKFLOW);
    if (outcome.executed) tenderTransitionsTotal.inc({ service: SERVICE_NAME, command: 'publish' });
    return outcome;
  }

  /**
   * Nothing is ready to be used: judge everything under the lock so the answer names every reason at once,
   * then open (or find) the request. No key pair is made for a request that cannot be executed yet (RSA
   * generation is slow). A request that finds itself approved in the meantime is a retry (409), not a
   * publication without its key.
   */
  private async askForApproval(
    tenderId: string,
    dto: PublishTenderDto,
    caller: GateCaller,
    confirmedPolicyId: string | null,
  ): Promise<Gated<TenderView>> {
    const { organizationId } = caller;
    const outcome = await this.prisma.transaction(
      async (tx): Promise<TenderApprovalRequestView | 'STALE'> => {
        const locked = await this.lockOrNotFound(tx, organizationId, tenderId);
        if (locked.version !== dto.expectedVersion) {
          const stale = await this.gate.endIfBehind(
            tx,
            { organizationId, id: tenderId, projectId: locked.projectId, version: locked.version },
            WORKFLOW,
            caller,
            await decisionInstant(tx),
          );
          if (stale) return 'STALE';
          throw this.conflict(tenderId);
        }
        assertTenderTransition(tenderId, locked.status, 'PUBLISHED');
        const { refusals, at } = await this.judge(tx, tenderId, confirmedPolicyId !== null);
        if (refusals.length > 0 || confirmedPolicyId === null) {
          throw this.refused(tenderId, refusals);
        }
        const resolution = await this.gate.resolve(tx, {
          tender: {
            organizationId,
            id: tenderId,
            projectId: locked.projectId,
            version: locked.version,
          },
          binding: { workflowKey: WORKFLOW },
          confirmedPolicyId,
          caller,
          at,
        });
        if (resolution.kind === 'STALE') return 'STALE';
        if (resolution.kind === 'APPROVED') {
          throw RastaError.optimisticLockFailed('TenderApprovalRequest', resolution.request.id);
        }
        return toRequestView(resolution.request, await this.requests.steps(tx, resolution.request));
      },
    );
    if (outcome === 'STALE') throw approvalStale(WORKFLOW);
    return { executed: false, request: outcome };
  }

  // -- invitations ------------------------------------------------------------

  /**
   * Invites an organization to a RESTRICTED tender, while it is a DRAFT or
   * PUBLISHED. The owner cannot invite itself; the same organization twice is
   * `409`. An invitation is not a version change of the tender.
   */
  async invite(tenderId: string, dto: InviteBidderDto): Promise<InvitationView> {
    const { organizationId, actor } = this.access.assertCanWrite();

    // Does the invited organization exist? Asked of organization-service before the
    // transaction (a network call is never made under a row lock), and only after
    // the tender is shown to be the caller's, so a stranger learns nothing about
    // either. Fail closed: if it cannot be confirmed (503/504) nothing is invited.
    // Whether the invitee is *eligible* to bid (qualified, not suspended) is not
    // judged here: that is checked at bid time against the standing read model.
    const first = await this.tenders.findTender(tenderId);
    if (!first) throw RastaError.notFound('Tender', tenderId);
    assertOwnTender(first, organizationId);
    if (
      dto.organizationId !== organizationId &&
      !(await this.directory.exists(dto.organizationId))
    ) {
      throw RastaError.businessRule(
        `Organization ${dto.organizationId} does not exist; it cannot be invited`,
        { tenderId, refusals: ['INVITED_ORGANIZATION_NOT_FOUND'] },
      );
    }

    const invitationId = newId(ID_PREFIX.invitation);
    try {
      await this.prisma.transaction(async (tx) => {
        const locked = await this.lockOrNotFound(tx, organizationId, tenderId);
        // After the lock, like a publication: the invitation is dated by the
        // moment it was decided, not by when the transaction began waiting.
        const at = await decisionInstant(tx);
        if (locked.status !== 'DRAFT' && locked.status !== 'PUBLISHED') {
          throw RastaError.businessRule(
            `Tender ${tenderId} is ${locked.status}; invitations are made while it is a DRAFT or PUBLISHED`,
            { tenderId, status: locked.status },
          );
        }
        const row = await this.tenders.findTender(tenderId, tx);
        if (row?.visibility !== 'RESTRICTED') {
          throw RastaError.businessRule(
            `Tender ${tenderId} is not RESTRICTED; only a restricted tender takes invitations`,
            { tenderId },
          );
        }
        if (dto.organizationId === organizationId) {
          throw RastaError.businessRule('An organization cannot be invited to its own tender', {
            tenderId,
          });
        }

        await this.publications.createInvitation(tx, {
          id: invitationId,
          organizationId,
          tenderId,
          invitedOrganizationId: dto.organizationId,
          actor,
          at,
        });
        await this.events.enqueue(tx, {
          eventName: 'TENDER_BIDDER_INVITED',
          aggregateId: tenderId,
          organizationId,
          payload: {
            tenderId,
            projectId: locked.projectId,
            organizationId,
            invitedOrganizationId: dto.organizationId,
            invitedBy: actor,
            invitedAt: at.toISOString(),
          },
          occurredAt: at,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw RastaError.alreadyExists('TenderInvitation', dto.organizationId);
      }
      throw error;
    }
    tenderTransitionsTotal.inc({ service: SERVICE_NAME, command: 'invite' });

    const created = await this.publications.findInvitation(tenderId, invitationId);
    if (!created) throw RastaError.notFound('TenderInvitation', invitationId);
    return toInvitationView(created);
  }

  async listInvitations(
    tenderId: string,
    query: ListInvitationsQuery,
  ): Promise<CursorPage<InvitationView>> {
    const { organizationId } = this.access.assertCanRead();
    const tender = await this.tenders.findTender(tenderId);
    if (!tender) throw RastaError.notFound('Tender', tenderId);
    assertOwnTender(tender, organizationId);

    const rows = await this.publications.listInvitations(tenderId, {
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
    const hasMore = rows.length > query.limit;
    const visible = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items: visible.map(toInvitationView),
      nextCursor: hasMore ? (visible[visible.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  // -- helpers ----------------------------------------------------------------

  /**
   * Reads what publishing is judged on, under the tender's lock, and judges it.
   * `at` is the database's instant read after the lock (`clock_timestamp()`).
   */
  private async judge(tx: ExtendedPrismaClient, tenderId: string, policyInForce: boolean) {
    const at = await decisionInstant(tx);
    const row = await this.tenders.findTender(tenderId, tx);
    if (!row) throw RastaError.notFound('Tender', tenderId);
    const criteria = await this.criteria.listCriteria(tenderId, tx);
    const refusals = publicationRefusals({
      procurementNature: row.procurementNature,
      visibility: row.visibility,
      bidOpeningAt: row.bidOpeningAt,
      bidClosingAt: row.bidClosingAt,
      now: at,
      minBiddingPeriodSeconds: this.env.CONSTRUCTION_TENDER_MIN_BIDDING_PERIOD_SECONDS,
      criteriaCount: criteria.length,
      totalWeightBp: criteria.reduce((sum, criterion) => sum + criterion.weightBp, 0),
      invitationCount: await this.publications.countInvitations(tx, tenderId),
      approval: policyInForce ? 'POLICY_IN_FORCE' : 'NO_POLICY',
    });
    return { row, criteria, refusals, at };
  }

  private refused(tenderId: string, refusals: readonly string[]): RastaError {
    return RastaError.businessRule(
      `Tender ${tenderId} cannot be published: ${refusals.join(', ')}`,
      { tenderId, refusals },
    );
  }

  /**
   * A fresh key pair, its private half wrapped and then zeroised. Without a
   * configured key-encryption key this is `503`, and nothing is published.
   */
  private async makeKey(
    tenderId: string,
    keyId: string,
  ): Promise<{ publicKeyPem: string; wrapped: WrappedKey }> {
    const pair = await generateTenderKeyPair();
    try {
      return {
        publicKeyPem: pair.publicKeyPem,
        wrapped: this.keys.wrap(pair.privateKeyDer, { tenderId, keyId }),
      };
    } catch (error) {
      if (error instanceof SealingError)
        throw RastaError.upstreamUnavailable('tender-key-provider');
      throw error;
    } finally {
      pair.privateKeyDer.fill(0);
    }
  }

  private async view(
    organizationId: string,
    tenderId: string,
    client: ExtendedPrismaClient,
  ): Promise<TenderView> {
    const row = await this.tenders.findTender(tenderId, client);
    if (!row) throw RastaError.notFound('Tender', tenderId);
    assertOwnTender(row, organizationId);
    return toTenderView(row);
  }

  private async lockOrNotFound(
    tx: ExtendedPrismaClient,
    organizationId: string,
    tenderId: string,
  ): Promise<LockedTender> {
    const locked = await this.tenders.lockTender(tx, organizationId, tenderId);
    if (!locked) throw RastaError.notFound('Tender', tenderId);
    assertOwnTender(locked, organizationId);
    return locked;
  }

  private conflict(tenderId: string): RastaError {
    versionConflictsTotal.inc({ service: SERVICE_NAME, aggregate: 'Tender' });
    return RastaError.optimisticLockFailed('Tender', tenderId);
  }
}

function toInvitationView(row: TenderInvitation): InvitationView {
  return {
    id: row.id,
    tenderId: row.tenderId,
    invitedOrganizationId: row.invitedOrganizationId,
    invitedAt: row.invitedAt.toISOString(),
    invitedBy: row.invitedBy,
  };
}
