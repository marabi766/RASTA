import { Inject, Injectable } from '@nestjs/common';
import { RastaError } from '@rasta/nest-common';
import { withFinancialSpan } from '@rasta/observability';
import type { CursorPage } from '@rasta/contracts';
import type { TenderInvitation } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { ProjectAccess, assertOwnTender } from '../access/access';
import { decisionInstant, transactionNow } from '../shared/clock';
import { isUniqueViolation } from '../shared/prisma-errors';
import { ENV, TENDER_KEY_PROVIDER } from '../tokens';
import { SERVICE_NAME, type ConstructionEnv } from '../config/env';
import { tenderTransitionsTotal, versionConflictsTotal } from '../observability/metrics';
import { CriteriaRepository } from './criteria.repository';
import { TenderRepository, type LockedTender } from './tender.repository';
import { PublicationRepository } from './publication.repository';
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
 * ## Not here yet
 *
 * The `tender.publication` approval gate (fail closed without an active policy,
 * Q-84) is a later step; until then publishing checks the role and the state.
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
  ) {}

  async publish(tenderId: string, dto: PublishTenderDto): Promise<TenderView> {
    const { organizationId, actor } = this.access.assertCanWrite();

    // A cheap, unlocked look at the version and the state, so a stale or
    // repeated request does not cost a key pair. Advisory only: everything is
    // decided again under the lock, and the deadline is never judged here (that
    // would be the application clock).
    const first = await this.tenders.findTender(tenderId);
    if (!first) throw RastaError.notFound('Tender', tenderId);
    assertOwnTender(first, organizationId);
    if (first.version !== dto.expectedVersion) throw this.conflict(tenderId);
    assertTenderTransition(tenderId, first.status, 'PUBLISHED');

    const keyId = newId(ID_PREFIX.tenderKey);
    const { publicKeyPem, wrapped } = await this.makeKey(tenderId, keyId);

    // The answer is read inside the transaction, with the tender still locked
    // (the defect Codex found in #162): what the caller is told is the state
    // their own publication produced.
    const view = await withFinancialSpan(
      'construction.tender.publish',
      () =>
        this.prisma.transaction(async (tx) => {
          const at = await transactionNow(tx);
          const locked = await this.lockOrNotFound(tx, organizationId, tenderId);
          if (locked.version !== dto.expectedVersion) throw this.conflict(tenderId);
          assertTenderTransition(tenderId, locked.status, 'PUBLISHED');

          // The deadline is judged on the instant of the decision, after the lock.
          const now = await decisionInstant(tx);
          const row = await this.tenders.findTender(tenderId, tx);
          if (!row) throw RastaError.notFound('Tender', tenderId);
          const criteria = await this.criteria.listCriteria(tenderId, tx);
          const refusals = publicationRefusals({
            procurementNature: row.procurementNature,
            visibility: row.visibility,
            bidOpeningAt: row.bidOpeningAt,
            bidClosingAt: row.bidClosingAt,
            now,
            minBiddingPeriodSeconds: this.env.CONSTRUCTION_TENDER_MIN_BIDDING_PERIOD_SECONDS,
            criteriaCount: criteria.length,
            totalWeightBp: criteria.reduce((sum, criterion) => sum + criterion.weightBp, 0),
            invitationCount: await this.publications.countInvitations(tx, tenderId),
          });
          if (refusals.length > 0) {
            throw RastaError.businessRule(
              `Tender ${tenderId} cannot be published: ${refusals.join(', ')}`,
              { tenderId, refusals },
            );
          }

          const matched = await this.tenders.publishTender(tx, {
            tenderId,
            expectedVersion: dto.expectedVersion,
            actor,
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

          // `row` was read before the update; the window and visibility it holds
          // are what was judged and what is now published.
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
              publishedBy: actor,
              publishedAt: at.toISOString(),
            },
            occurredAt: at,
          });
          return this.view(organizationId, tenderId, tx);
        }),
      { 'rasta.tender.command': 'publish' },
    );
    tenderTransitionsTotal.inc({ service: SERVICE_NAME, command: 'publish' });

    return view;
  }

  // -- invitations ------------------------------------------------------------

  /**
   * Invites an organization to a RESTRICTED tender, while it is a DRAFT or
   * PUBLISHED. The owner cannot invite itself; the same organization twice is
   * `409`. An invitation is not a version change of the tender.
   */
  async invite(tenderId: string, dto: InviteBidderDto): Promise<InvitationView> {
    const { organizationId, actor } = this.access.assertCanWrite();

    const invitationId = newId(ID_PREFIX.invitation);
    try {
      await this.prisma.transaction(async (tx) => {
        const at = await transactionNow(tx);
        const locked = await this.lockOrNotFound(tx, organizationId, tenderId);
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
