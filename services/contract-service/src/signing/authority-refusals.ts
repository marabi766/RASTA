import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '@rasta/contracts';
import { RastaError, getContext } from '@rasta/nest-common';
import { PlatformAdministratorRefused, sideOf, type Acting } from '../access/access';
import { ContractRepository } from '../contract/contract.repository';
import type {
  AUTHORITY_REFUSED_ACTIONS,
  AUTHORITY_REFUSED_REASONS,
  AUTHORITY_REFUSED_SIDES,
} from '../events/events';
import { EventPublisher } from '../events/publisher';
import { PrismaService } from '../prisma/prisma.service';
import { transactionNow } from '../shared/clock';
import type { RefusalFence } from '../shared/idempotency';

export type AuthorityRefusedAction = (typeof AUTHORITY_REFUSED_ACTIONS)[number];
export type AuthorityRefusedReason = (typeof AUTHORITY_REFUSED_REASONS)[number];

export interface AuthorityRefusal {
  readonly action: AuthorityRefusedAction;
  /** A party, or for a decision an organization the statement's chains name (`APPROVER`). */
  readonly side: (typeof AUTHORITY_REFUSED_SIDES)[number];
  readonly contractId: string;
  /** The contract's organization — the employer's. */
  readonly organizationId: string;
  /** The amendment, milestone or statement the action named; null when it was to create one. */
  readonly subjectId: string | null;
  readonly reason: AuthorityRefusedReason;
  /** The policy that was in force and stranded; null otherwise. */
  readonly policyId?: string | null;
}

/**
 * The durable audit record of an authority-bound action a **party** was refused (S-06), for want of
 * authority or for separation of duties: signing or cancelling the contract, proposing or signing
 * an amendment, planning or editing a milestone, drafting a statement.
 * `CONTRACT_AUTHORITY_REFUSED` goes through the outbox in a transaction of its own — the command's
 * transaction rolled back (or never began), and a refusal that left no trace would be invisible to
 * the audit that must show who tried to act for a party without the authority.
 *
 * When the record cannot be written the caller is not answered with the normal refusal: it gets a
 * retryable 503, so the same request can be made again and leave its trace. The requested command had
 * no effect either way; what may already have happened is independent of it — an amendment signature
 * refused `POLICY_AUTHOR_NOT_GOVERNING` suspends the stranded policy (Q-83) before the refusal is
 * recorded, and that suspension stands.
 * A caller who is not a party never reaches this: they are told the contract does not exist. The one
 * exception is the platform administrator (`commandingCaller`), whose 503 is a narrow existence signal.
 *
 * Only these refusals are audited. A refusal of the contract's state — a contract that is no longer
 * a draft, a version that moved on, an invalid transition — is answered and leaves no record.
 */
@Injectable()
export class AuthorityRefusals {
  private readonly logger = new Logger(AuthorityRefusals.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: EventPublisher,
    private readonly contracts: ContractRepository,
  ) {}

  /**
   * The caller of a party's command, as `assertCaller` (`ContractAccess.assertCanCommand`,
   * `assertCanCommandAmendments` or `assertCanCommandStatements`) judges it. When that refuses the platform administrator acting for
   * an organization a party to the named contract, the refusal is recorded like a party's own
   * (`PLATFORM_ADMINISTRATOR`) before it is answered; for any other contract it is answered alone.
   * The answer is the same `403` either way. Every other refusal of `assertCaller` (the oversight
   * role, a service, no organization) comes before any contract is read and is not audited here.
   *
   * **The one existence signal (accepted, #243 review):** when the record cannot be written, a
   * contract the acting organization is a party to is answered with the retryable `503` while a
   * missing contract, or one it is not a party to, is still answered `403`. So the platform
   * administrator — and only while refusal audit writes fail — can tell that a contract exists with
   * that organization as a party. No other caller gets this: a non-party is told `404` before any
   * audit is attempted.
   */
  async commandingCaller(
    assertCaller: () => Acting,
    named: Pick<AuthorityRefusal, 'action' | 'contractId' | 'subjectId'>,
    fence: RefusalFence | undefined,
  ): Promise<Acting> {
    try {
      return assertCaller();
    } catch (error) {
      if (!(error instanceof PlatformAdministratorRefused)) throw error;
      const row = await this.contracts.findParty(error.organizationId, named.contractId);
      const side = row ? sideOf(row, error.organizationId) : null;
      if (!row || !side) throw error;
      return this.refuse(
        {
          ...named,
          side,
          contractId: row.id,
          organizationId: row.organizationId,
          reason: 'PLATFORM_ADMINISTRATOR',
        },
        error,
        fence,
      );
    }
  }

  /**
   * Records the refusal and throws it (or the 503 when it cannot be recorded).
   *
   * A refusal here is not terminal (docs/06 § 6.8): the request's idempotency claim is released
   * and it may be made again. With the request's `fence` the event is de-duplicated durably —
   * by tenant, user, key, request and reason, the record committed in the same transaction as the
   * event — so the same refusal repeated writes no second event, a different reason writes a new
   * one, and when the transaction rolls back neither exists: the answer is the retryable 503.
   */
  async refuse(
    refused: AuthorityRefusal,
    answer: RastaError,
    fence?: RefusalFence,
  ): Promise<never> {
    try {
      await this.record(refused, fence);
    } catch (auditError: unknown) {
      this.logger.error(
        `Could not record the refusal of ${refused.action} (${refused.reason}): ` +
          `${auditError instanceof RastaError ? auditError.code : 'INTERNAL'}`,
      );
      // "Nothing was done": the requested command had no effect. An independent policy suspension
      // made before the refusal (amendment signature, POLICY_AUTHOR_NOT_GOVERNING) stands. For the
      // platform administrator this 503, unlike the 403, says the contract exists — see
      // `commandingCaller`.
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

  private async record(refused: AuthorityRefusal, fence: RefusalFence | undefined): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      if (fence && !(await fence.firstRefusal(tx, refused.reason))) return;
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
