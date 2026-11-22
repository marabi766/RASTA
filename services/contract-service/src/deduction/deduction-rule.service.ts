import { canonicalDeductionRuleName } from './deduction-rule-name';
import { Injectable } from '@nestjs/common';
import { RastaError, type ActorIdentity } from '@rasta/nest-common';
import { PrismaService } from '../prisma/prisma.service';
import { EventPublisher } from '../events/publisher';
import { IdempotencyStore, requiredIdempotencyKey } from '../shared/idempotency';
import { databaseClock } from '../shared/clock';
import { DeductionRuleRepository } from './deduction-rule.repository';
import { DeductionRuleAccess } from './deduction-rule.access';
import {
  deductionReceiptSchema,
  storageText,
  type DeductionReceipt,
  type ProposeDeductionDto,
} from './dto';

export const PROPOSE_DEDUCTION_ENDPOINT = 'POST /v1/deduction-rules/changes';
const INVALID_RECEIPT = 'Invalid deduction proposal receipt';

@Injectable()
export class DeductionRuleService {
  constructor(
    private readonly access: DeductionRuleAccess,
    private readonly prisma: PrismaService,
    private readonly repository: DeductionRuleRepository,
    private readonly publisher: EventPublisher,
    private readonly idempotency: IdempotencyStore,
  ) {}

  async propose(dto: ProposeDeductionDto, header?: string): Promise<DeductionReceipt> {
    // Current authority precedes even a claim or cached response lookup.
    const { organizationId, actor } = this.access.assertWriter();
    const key = requiredIdempotencyKey(header);
    if (!storageText(key))
      throw RastaError.validation([
        { path: 'Idempotency-Key', code: 'invalid', message: 'Invalid Idempotency-Key' },
      ]);
    const proposal = this.canonical(dto);
    const { result } = await this.idempotency.execute<DeductionReceipt>(
      PROPOSE_DEDUCTION_ENDPOINT,
      key,
      { dto: proposal, actor },
      201,
      (fence) =>
        this.prisma.transaction(async (tx) => {
          await fence.hold(tx);
          const at = await databaseClock(tx);
          const common = { organizationId, proposer: actor, at };
          const change =
            proposal.kind === 'CREATE'
              ? await this.repository.proposeCreate(tx, { ...common, ...proposal })
              : await this.repository.proposeRetire(tx, { ...common, ...proposal });
          const receipt = this.receipt({
            id: change.id,
            organizationId,
            kind: change.kind,
            status: 'PENDING_APPROVAL',
            version: 1,
            proposedAt: change.proposedAt.toISOString(),
          });
          await this.publisher.enqueue(tx, {
            eventName: 'DEDUCTION_RULE_CHANGE_PROPOSED',
            aggregateId: change.id,
            organizationId,
            occurredAt: change.proposedAt,
            payload: {
              changeId: change.id,
              organizationId: change.organizationId,
              kind: change.kind,
              proposedAt: change.proposedAt.toISOString(),
              proposedBy: change.proposedBy,
              version: change.version,
            },
          });
          return fence.complete(tx, receipt);
        }),
      (stored) => this.assertReplay(stored, organizationId, actor),
    );
    return result;
  }

  private canonical(dto: ProposeDeductionDto): ProposeDeductionDto {
    if (dto.kind === 'RETIRE') return dto;
    const name = canonicalDeductionRuleName(dto.name);
    if (name === null)
      throw RastaError.validation([
        { path: 'name', code: 'not_canonical', message: 'Invalid deduction rule name' },
      ]);
    return { ...dto, name };
  }

  private receipt(value: unknown): DeductionReceipt {
    const parsed = deductionReceiptSchema.safeParse(value);
    if (!parsed.success) throw RastaError.internal(INVALID_RECEIPT);
    return parsed.data;
  }

  private async assertReplay(
    value: unknown,
    organizationId: string,
    actor: ActorIdentity,
  ): Promise<void> {
    this.access.assertWriter();
    const receipt = this.receipt(value);
    if (receipt.organizationId !== organizationId) throw RastaError.internal(INVALID_RECEIPT);
    const change = await this.repository.findChange(this.prisma.client, organizationId, receipt.id);
    if (
      !change ||
      change.kind !== receipt.kind ||
      change.proposedAt.toISOString() !== receipt.proposedAt ||
      change.proposedBy !== actor.userId ||
      change.proposedByIssuer !== actor.issuer ||
      change.proposedBySubject !== actor.subject
    )
      throw RastaError.internal(INVALID_RECEIPT);
    // The original receipt remains pending/version 1 even after a later independent decision.
  }
}
