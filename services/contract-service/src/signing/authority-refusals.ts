import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '@rasta/contracts';
import { RastaError, getContext } from '@rasta/nest-common';
import type { AUTHORITY_REFUSED_ACTIONS, AUTHORITY_REFUSED_REASONS } from '../events/events';
import { EventPublisher } from '../events/publisher';
import { PrismaService } from '../prisma/prisma.service';
import { transactionNow } from '../shared/clock';

export type AuthorityRefusedAction = (typeof AUTHORITY_REFUSED_ACTIONS)[number];
export type AuthorityRefusedReason = (typeof AUTHORITY_REFUSED_REASONS)[number];

export interface AuthorityRefusal {
  readonly action: AuthorityRefusedAction;
  readonly side: 'EMPLOYER' | 'CONTRACTOR';
  readonly contractId: string;
  /** The contract's organization — the employer's. */
  readonly organizationId: string;
  /** The amendment or milestone the action named; null when it was to create one. */
  readonly subjectId: string | null;
  readonly reason: AuthorityRefusedReason;
  /** The policy that was in force and stranded; null otherwise. */
  readonly policyId?: string | null;
}

/**
 * The durable audit record of an authority-bound action a **party** was refused (S-06): proposing
 * or signing an amendment, planning or editing a milestone. `CONTRACT_AUTHORITY_REFUSED` goes
 * through the outbox in a transaction of its own — the command's transaction rolled back (or never
 * began), and a refusal that left no trace would be invisible to the audit that must show who tried
 * to act for an employer without the authority.
 *
 * When the record cannot be written the caller is not answered with the normal refusal: it gets a
 * retryable 503, so the same request can be made again and leave its trace. Nothing was done either way.
 * A caller who is not a party never reaches this: they are told the contract does not exist.
 */
@Injectable()
export class AuthorityRefusals {
  private readonly logger = new Logger(AuthorityRefusals.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: EventPublisher,
  ) {}

  /** Records the refusal and throws it (or the 503 when it cannot be recorded). */
  async refuse(refused: AuthorityRefusal, answer: RastaError): Promise<never> {
    try {
      await this.record(refused);
    } catch (auditError: unknown) {
      this.logger.error(
        `Could not record the refusal of ${refused.action} (${refused.reason}): ` +
          `${auditError instanceof RastaError ? auditError.code : 'INTERNAL'}`,
      );
      throw new RastaError(
        ERROR_CODES.UPSTREAM_UNAVAILABLE,
        'The refusal could not be recorded; nothing was done. Retry shortly',
        {
          cause: auditError,
          retryAfterSeconds: 1,
          internalContext: { action: refused.action, reason: refused.reason },
        },
      );
    }
    throw answer;
  }

  private async record(refused: AuthorityRefusal): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      const at = await transactionNow(tx);
      await this.publisher.enqueue(tx, {
        eventName: 'CONTRACT_AUTHORITY_REFUSED',
        aggregateId: refused.contractId,
        organizationId: refused.organizationId,
        payload: {
          contractId: refused.contractId,
          organizationId: refused.organizationId,
          action: refused.action,
          side: refused.side,
          subjectId: refused.subjectId,
          reason: refused.reason,
          policyId: refused.policyId ?? null,
          refusedBy: getContext().userId ?? 'unknown',
          refusedAt: at.toISOString(),
        },
        occurredAt: at,
      });
    });
  }
}
