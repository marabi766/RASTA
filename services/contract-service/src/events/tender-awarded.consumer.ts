import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import {
  EventConsumer,
  UnprocessableEventError,
  createSystemContext,
  invalidPayloadError,
  kafkaConnection,
  runWithContext,
  RastaError,
  type EventHandler,
  type HandlerOutcome,
} from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import { z } from 'zod';
import { CONTRACT_DEAD_LETTER_TOPIC, SERVICE_NAME } from '../config/env';
import type { AwardSource } from '../award/award-source.client';
import {
  amountOf,
  confirmAward,
  confirmTenant,
  contradictions,
  type AwardClaim,
  type Mismatch,
} from '../award/award-confirm';
import { PrismaService } from '../prisma/prisma.service';
import { ContractRepository } from '../contract/contract.repository';
import { EventPublisher, ID_PREFIX, newId } from './publisher';
import { transactionNow } from '../shared/clock';
import { isUniqueViolation } from '../shared/prisma-errors';
import { contractDraftsTotal, sourceVerificationsTotal } from '../observability/metrics';
import type { Contract } from '../generated/prisma';

/** The consumer group: `<service>.<purpose>` (ADR-061 § 3). */
export const TENDER_AWARDED_CONSUMER = 'contract-service.tender-awarded';

/** The one topic it reads. `EventConsumer` also reads its `.retry` twin. */
export const TENDER_AWARDED_TOPICS = ['rasta.construction.v1'] as const;

export const TENDER_AWARDED = 'TENDER_AWARDED';

/** The actor recorded on a draft: the system, never a person (Q-95 (3)). */
export const DRAFTING_ACTOR = `service:${SERVICE_NAME}`;

/**
 * Only the fields this service uses. construction-service owns the full schema and this
 * service does not import it (no cross-service imports); an extra field is not this
 * consumer's business, which is why this is not `.strict()`.
 */
const identifier = z.string().min(1).max(64);
const tenderAwardedPayload = z.object({
  tenderId: identifier,
  projectId: identifier,
  organizationId: identifier,
  winningBidId: identifier,
  winnerOrganizationId: identifier,
  matrixDigest: z.string().min(1).max(128),
  awardedBy: identifier,
  awardedAt: z.string().datetime({ offset: true }),
});

/** The names the schema declares — what a dead-letter message may name of a failing payload (S-09). */
export const TENDER_AWARDED_FIELDS: readonly string[] = Object.keys(tenderAwardedPayload.shape);

export type EventConsumerFactory = (handler: EventHandler) => EventConsumer;

export interface TenderAwardedConsumerOptions {
  readonly maxRetries: number;
  readonly retryBackoffMs: number;
}

/** The shared `EventConsumer` for this stream, subscribed with its `.retry` twin (D-039). */
export function tenderAwardedConsumerFactory(
  connection: ReturnType<typeof kafkaConnection>,
  logger: Pick<Logger, 'info' | 'warn' | 'error'>,
  options: TenderAwardedConsumerOptions,
): EventConsumerFactory {
  return (handler) =>
    new EventConsumer(
      {
        ...connection,
        groupId: TENDER_AWARDED_CONSUMER,
        topics: [...TENDER_AWARDED_TOPICS],
        deadLetterTopic: CONTRACT_DEAD_LETTER_TOPIC,
        maxRetries: options.maxRetries,
        retryBackoffMs: options.retryBackoffMs,
      },
      handler,
      {
        log: (m) => logger.info(m),
        warn: (m) => logger.warn(m),
        error: (m, trace) => logger.error({ err: trace }, m),
      },
    );
}

/**
 * Drafts the contract an awarded tender calls for (CON-003 PR 1, ADR-068 § 3).
 *
 * ## The award is read from its owner, not from the event (ADR-061 § 4, A-13)
 *
 * `TENDER_AWARDED` is its publisher's claim, and it carries no amount — on purpose
 * (#199). A contract is a record of an amount somebody is owed, so before it is made the
 * award is read from construction-service over authenticated REST, with the event's
 * organization signed into the token, and compared field by field:
 *
 *   - **The owner disagrees** (no such award in that organization, or any field differs):
 *     dead-lettered at once as `SOURCE_UNCONFIRMED`, with the field that differed.
 *     Nothing is written. A retry cannot change the owner's answer.
 *   - **The owner cannot be asked** (down, slow, misconfigured): the handler throws, the
 *     consumer retries, and the event is dead-lettered as `UPSTREAM_UNAVAILABLE` once the
 *     retries run out. Nothing is written — **never a contract with a guessed amount**.
 *     A DLQ replay recovers it once construction-service is back.
 *
 * The HTTP call happens outside the database transaction, so a slow owner never holds a
 * connection or a lock.
 *
 * ## Idempotent on the tender, three times over
 *
 * One contract per awarded tender (`ux_contract_org_tender`, ADR-065, ADR-067 § 3):
 *
 *   1. a delivery whose tender already has a contract is compared with that contract
 *      **before** the owner is asked — the same award again is `SKIPPED` and costs no
 *      round trip (each read of an award is audited by its owner);
 *   2. a delivery that contradicts the contract in ANY persisted award claim (tender,
 *      project, winning bid, contractor, matrix digest, who awarded, when) is a **conflicting redelivery**: dead-lettered as `VALIDATION_FAILED`
 *      with the contract it contradicts named by identifier, never overwriting anything —
 *      the contradiction is the answer, not something to retry;
 *   3. two deliveries at once pass the probe together and meet at the unique index: the one
 *      that loses re-reads and is judged as in (1) or (2).
 *
 * ## The tenant is checked before anything else (ADR-061 § 5)
 *
 * The envelope's `tenantId` must equal the payload's organization. A mismatch, or no
 * tenant at all, is dead-lettered as `SOURCE_UNCONFIRMED` before the owner is asked, and
 * the owner is only ever asked inside that one tenant. The draft is written in that
 * tenant — the employer's — and in no other.
 */
export class TenderAwardedConsumer {
  private consumer?: EventConsumer;

  constructor(
    private readonly consumerFactory: EventConsumerFactory,
    private readonly prisma: PrismaService,
    private readonly contracts: ContractRepository,
    private readonly publisher: EventPublisher,
    private readonly awards: AwardSource,
    private readonly logger: Pick<Logger, 'info' | 'warn' | 'debug'>,
  ) {}

  async start(): Promise<void> {
    this.consumer = this.consumerFactory((envelope) => this.handle(envelope));
    await this.consumer.start();
  }

  async stop(): Promise<void> {
    await this.consumer?.stop();
  }

  /** One event. Public so a test can drive it without a broker. */
  async handle(envelope: EventEnvelope): Promise<HandlerOutcome> {
    if (envelope.eventName !== TENDER_AWARDED) return 'SKIPPED';

    // A known event whose payload fails its schema is a producer defect no retry fixes:
    // dead-lettered at once as VALIDATION_FAILED. The message names field paths and zod
    // codes only — never zod's own text, which can quote the value received (S-09).
    const parsed = tenderAwardedPayload.safeParse(envelope.payload);
    if (!parsed.success) throw invalidPayloadError(envelope, parsed.error, TENDER_AWARDED_FIELDS);
    const payload = parsed.data;

    // Before any lookup and any token: the envelope's tenant and the payload's
    // organization are one, or the event is refused (ADR-061 § 5).
    const tenancy = confirmTenant(envelope.tenantId, payload.organizationId);
    if (!tenancy.confirmed) this.refuse(payload.tenderId, tenancy.mismatch);
    const tenant = payload.organizationId;

    // A system context, because a consumer has no request. The correlation id is carried
    // from the envelope so the whole chain — the award in construction-service, this draft,
    // and what follows — shares one identifier (docs/13). The tenant is the envelope's, now
    // proved equal to the payload's; nothing re-contexts to another.
    const context = createSystemContext({
      correlationId: envelope.correlationId,
      organizationId: tenant,
      callerService: SERVICE_NAME,
    });

    return runWithContext(context, async () => {
      const claim: AwardClaim = {
        tenderId: payload.tenderId,
        projectId: payload.projectId,
        organizationId: tenant,
        winningBidId: payload.winningBidId,
        winnerOrganizationId: payload.winnerOrganizationId,
        matrixDigest: payload.matrixDigest,
        awardedBy: payload.awardedBy,
        awardedAt: payload.awardedAt,
      };

      // Checked first so a redelivery costs no round trip to the owner (and no second
      // READ_AWARD in its log). Checked again at the unique index, which is the check
      // that counts.
      const existing = await this.contracts.findByTender(tenant, payload.tenderId);
      if (existing) return this.judgeExisting(envelope, payload, existing);

      // Throws on an owner that cannot be asked: retried, never acted on.
      let fact;
      try {
        fact = await this.awards.award(tenant, payload.tenderId);
      } catch (error) {
        if (error instanceof RastaError) {
          contractDraftsTotal.inc({ service: SERVICE_NAME, outcome: 'unavailable' });
        }
        throw error;
      }
      const verdict = confirmAward(claim, fact);
      if (!verdict.confirmed || !fact) {
        this.refuse(payload.tenderId, verdict.confirmed ? 'not_found' : verdict.mismatch);
      }
      sourceVerificationsTotal.inc({
        service: SERVICE_NAME,
        consumer: 'tender_awarded',
        outcome: 'confirmed',
      });

      // Every figure from the owner's answer; `confirmAward` has just proved it equal to the
      // event's where the event states it, and a positive amount that fits the column.
      const amountMinor = amountOf(fact);
      if (amountMinor === null) return this.refuse(payload.tenderId, 'amount_invalid');

      try {
        await this.prisma.transaction(async (tx) => {
          // Re-read inside the transaction: a concurrent delivery may have committed since
          // the probe. The unique index is the backstop for the window that remains.
          const raced = await this.contracts.findByTender(tenant, payload.tenderId, tx);
          if (raced) throw new AlreadyDrafted(raced);

          const at = await transactionNow(tx);
          const row = await this.contracts.insertDraft(tx, {
            id: newId(ID_PREFIX.contract),
            organizationId: tenant,
            tenderId: payload.tenderId,
            projectId: fact.projectId,
            winningBidId: fact.bidId,
            contractorOrganizationId: fact.bidderOrganizationId,
            amountMinor,
            matrixDigest: fact.matrixDigest,
            awardedBy: fact.awardedBy,
            awardedAt: new Date(fact.awardedAt),
            sourceEventId: envelope.eventId,
            actor: DRAFTING_ACTOR,
            correlationId: envelope.correlationId,
            at,
          });
          await this.publisher.enqueue(tx, {
            eventName: 'CONTRACT_DRAFTED',
            aggregateId: row.id,
            organizationId: tenant,
            causationId: envelope.eventId,
            occurredAt: at,
            payload: {
              contractId: row.id,
              tenderId: row.tenderId,
              projectId: row.projectId,
              organizationId: row.organizationId,
              contractorOrganizationId: row.contractorOrganizationId,
              winningBidId: row.winningBidId,
              draftedAt: at.toISOString(),
            },
          });
        });
      } catch (error) {
        const winner =
          error instanceof AlreadyDrafted
            ? error.contract
            : isUniqueViolation(error)
              ? await this.contracts.findByTender(tenant, payload.tenderId)
              : null;
        if (!winner) throw error;
        return this.judgeExisting(envelope, payload, winner);
      }

      contractDraftsTotal.inc({ service: SERVICE_NAME, outcome: 'drafted' });
      this.logger.info(`Drafted a contract for awarded tender ${payload.tenderId}`);
      return undefined;
    });
  }

  /**
   * A delivery for a tender that already has a contract: the same award again is a skip; a
   * delivery that contradicts the contract is refused and overwrites nothing.
   */
  private judgeExisting(
    envelope: EventEnvelope,
    payload: z.infer<typeof tenderAwardedPayload>,
    existing: Contract,
  ): HandlerOutcome {
    // EVERY persisted award claim, never a subset: a redelivery that differs in any one of
    // them is not the same award, whatever else it shares.
    const differing = contradictions(existing, payload);
    if (differing.length === 0) {
      contractDraftsTotal.inc({ service: SERVICE_NAME, outcome: 'replayed' });
      this.logger.debug(
        `${envelope.eventName} ${envelope.eventId}: contract ${existing.id} already drafted; no second effect`,
      );
      return 'SKIPPED';
    }
    contractDraftsTotal.inc({ service: SERVICE_NAME, outcome: 'refused' });
    this.logger.warn(
      `${envelope.eventName} ${envelope.eventId} contradicts contract ${existing.id}`,
    );
    // Not a retry: a verdict on the event. A retry cannot make two different awards one.
    throw new UnprocessableEventError(
      DLQ_REASONS.VALIDATION_FAILED,
      `${envelope.eventName} ${envelope.eventId} contradicts what is recorded (contract ${existing.id}; differs in ${differing.join(', ')})`,
    );
  }

  /** Counts the refusal and dead-letters the event as `SOURCE_UNCONFIRMED`. */
  private refuse(tenderId: string, mismatch: Mismatch): never {
    sourceVerificationsTotal.inc({
      service: SERVICE_NAME,
      consumer: 'tender_awarded',
      outcome: mismatch,
    });
    contractDraftsTotal.inc({ service: SERVICE_NAME, outcome: 'refused' });
    throw new UnprocessableEventError(
      DLQ_REASONS.SOURCE_UNCONFIRMED,
      `construction-service does not confirm TENDER_AWARDED for ${tenderId}: ${mismatch}`,
    );
  }
}

/** Thrown inside the transaction when a concurrent delivery drafted first; carries the winner. */
class AlreadyDrafted extends Error {
  constructor(readonly contract: Contract) {
    super('contract already drafted');
  }
}
