import { Inject, Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES, MAX_AMOUNT_MINOR } from '@rasta/contracts';
import { RastaError, compareActors, currentActor, getContext } from '@rasta/nest-common';
import type { Amendment, AmendmentSignature, Contract } from '../generated/prisma';
import { ContractAccess, assertPartyOf, sideOf, type ContractSideName } from '../access/access';
import { SERVICE_NAME, type ContractEnv } from '../config/env';
import { ENV } from '../tokens';
import { ContractRepository } from '../contract/contract.repository';
import type { CursorPage } from '../contract/dto';
import type { SignatureFact } from '../contract/views';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { contractCommandsTotal } from '../observability/metrics';
import { PolicySuspensionService } from '../policy/policy-suspension.service';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { transactionNow } from '../shared/clock';
import type { ClaimFence } from '../shared/idempotency';
import { forbiddenRefusal, refusal, ruleRefusal } from '../shared/refusal';
import { AuthorityRefusals, type AuthorityRefusal } from '../signing/authority-refusals';
import {
  SigningAuthority,
  SigningAuthorityDenied,
  type SigningAuthorityResult,
} from '../signing/signing-authority';
import { AmendmentRepository } from './amendment.repository';
import type {
  AmendmentView,
  ListAmendmentsQuery,
  ProposeAmendmentDto,
  SignAmendmentDto,
} from './dto';
import { amendmentTransitionFor } from './amendment.state-machine';
import { toAmendmentView } from './views';

type AmendmentCommand = 'propose_amendment' | 'sign_amendment';

/** The person as a signature recorded them, ready for `compareActors` (#188). */
function signerOf(signature: AmendmentSignature) {
  return {
    userId: signature.signedBy,
    issuer: signature.signedByIssuer,
    subject: signature.signedBySubject,
  };
}

const factOf = (
  signature: AmendmentSignature & { review?: { id: string } | null },
): SignatureFact => ({
  side: signature.side,
  signedAt: signature.signedAt,
  reviewRequired: signature.review != null,
});

/**
 * The caller has no authority to sign an amendment for the employer, as the policies stand. Thrown
 * from inside the signing transaction — which rolls back, so nothing is recorded — and turned by
 * `sign` into the caller's refusal after two things written in transactions of their own, because
 * anything written inside the rolled-back one would be lost with it: the stranded policy's
 * suspension and the durable refusal audit record (`CONTRACT_AUTHORITY_REFUSED`).
 */
class AmendmentAuthorityRefused extends Error {
  constructor(
    readonly refused: AuthorityRefusal,
    readonly answer: RastaError,
  ) {
    super('The amendment signature was refused for want of authority');
  }
}

/**
 * A contract's amendments (ADR-068 § 9; CON-003 PR 3): the employer proposes one, both parties sign
 * it, and the second signature makes it effective and adds its delta to the contract's
 * `amendments_total_minor`.
 *
 * ## The same machinery as the contract's own signature
 *
 * - **Object-level authorization first.** The contract is found as the employer or as the winning
 *   contractor (`ContractRepository.findParty`); anyone else gets the `404` a missing contract
 *   gets, and nothing is audited about them (S-03). Only then are the caller's roles judged.
 * - **One lock, then the state.** Inside one transaction the contract's row lock is taken (and the
 *   amendment's, for a signature) and only then is anything decided, so two signatures are ordered,
 *   the second is the one that completes the amendment, and the total moves exactly once.
 * - **Authority is `SigningAuthority`'s**: the same code the contract's own signature asks — the
 *   `contract.signature` policy in force for the employer, the hierarchy question with its version
 *   (D-050), `CONTRACTOR` for the contractor — so the two cannot disagree. A move that races an
 *   employer signature flags it for review (`flagRacedSignatures`); nothing is revoked.
 * - **Separation of duties on the stable identity** (`compareActors`, #188), as for the contract.
 * - **The event and the audit record are in the transaction.** Every state change has an event;
 *   every refusal of an authority-bound action by a party is `CONTRACT_AUTHORITY_REFUSED`, written
 *   in a transaction of its own.
 * - **Arithmetic is exact**: bigint throughout, and an amendment that would take the price plus
 *   its amendments past the largest amount a bigint stores is refused (`AMENDMENT_EXCEEDS_LIMIT`)
 *   before anything is written; the database's CHECK is the backstop, not the check.
 *
 * Business rules live here, not in the controller (AGENTS.md A-10).
 */
@Injectable()
export class AmendmentService {
  private readonly logger = new Logger(AmendmentService.name);

  constructor(
    private readonly repository: AmendmentRepository,
    private readonly contracts: ContractRepository,
    private readonly authority: SigningAuthority,
    private readonly refusals: AuthorityRefusals,
    private readonly suspension: PolicySuspensionService,
    private readonly access: ContractAccess,
    private readonly prisma: PrismaService,
    private readonly publisher: EventPublisher,
    @Inject(ENV) private readonly env: ContractEnv,
  ) {}

  // -- reads ----------------------------------------------------------------------------

  /** One amendment, to a party to its contract; any other caller gets the `404` a missing one gets. */
  async get(contractId: string, amendmentId: string): Promise<AmendmentView> {
    const contract = await this.readableContract(contractId);
    const row = await this.repository.findOne(contract.organizationId, contract.id, amendmentId);
    if (!row) throw RastaError.notFound('Amendment', amendmentId);
    const facts = await this.repository.signatureFacts(contract.organizationId, contract.id, [
      row.id,
    ]);
    return toAmendmentView(row, facts.get(row.id));
  }

  /** The contract's amendments, oldest first. */
  async list(contractId: string, query: ListAmendmentsQuery): Promise<CursorPage<AmendmentView>> {
    const contract = await this.readableContract(contractId);
    const rows = await this.repository.list(
      contract.organizationId,
      contract.id,
      query.cursor === undefined ? undefined : Number(query.cursor),
      query.limit,
    );
    const hasMore = rows.length > query.limit;
    const visible = hasMore ? rows.slice(0, query.limit) : rows;
    const facts = await this.repository.signatureFacts(
      contract.organizationId,
      contract.id,
      visible.map((row) => row.id),
    );
    return {
      items: visible.map((row) => toAmendmentView(row, facts.get(row.id))),
      nextCursor: hasMore ? String(visible[visible.length - 1]?.amendmentNumber ?? '') : null,
      hasMore,
    };
  }

  /** Whether the caller may still see this amendment: the check a stored response must pass. */
  async assertVisible(contractId: string, amendmentId: string): Promise<void> {
    await this.get(contractId, amendmentId);
  }

  /** Whether the caller may still see this contract's amendments (replay of a proposal). */
  async assertContractVisible(contractId: string): Promise<void> {
    await this.readableContract(contractId);
  }

  private async readableContract(contractId: string): Promise<Contract> {
    const parties = this.access.assertCanRead();
    const row = await this.contracts.findReadable(parties, contractId);
    if (!row) throw RastaError.notFound('Contract', contractId);
    assertPartyOf(row, parties);
    return row;
  }

  // -- propose --------------------------------------------------------------------------

  /**
   * The employer proposes a change to the price of a SIGNED contract. Only the employer's people
   * who hold a role `CONTRACT_AMENDMENT_ROLES` names; a contractor or another role is refused —
   * and audited, being a party. `deltaMinor` must be positive: no document allows a reduction
   * (Q-100).
   */
  async propose(
    contractId: string,
    dto: ProposeAmendmentDto,
    fence?: ClaimFence<AmendmentView>,
  ): Promise<AmendmentView> {
    const acting = this.access.assertCanCommandAmendments();
    const row = await this.contracts.findParty(acting.organizationId, contractId);
    const side = row ? sideOf(row, acting.organizationId) : null;
    if (!row || !side) throw RastaError.notFound('Contract', contractId);

    const base = {
      action: 'PROPOSE_AMENDMENT',
      side,
      contractId: row.id,
      organizationId: row.organizationId,
      subjectId: null,
    } as const;
    if (side !== 'EMPLOYER') {
      return this.refusals.refuse(
        { ...base, reason: 'NOT_EMPLOYER' },
        this.refused(
          'propose_amendment',
          forbiddenRefusal('Only the employer proposes an amendment', 'amendment', [
            'PROPOSER_NOT_EMPLOYER',
          ]),
        ),
      );
    }
    if (!this.access.mayProposeAmendment()) {
      return this.refusals.refuse(
        { ...base, reason: 'ROLE_NOT_PERMITTED' },
        this.refused(
          'propose_amendment',
          RastaError.insufficientRole(this.access.amendmentRoles(), getContext().roles),
        ),
      );
    }
    if (!this.env.CONTRACT_AMENDMENT_REASON_CODES.includes(dto.reasonCode)) {
      throw this.refused(
        'propose_amendment',
        ruleRefusal('This reason is not one an amendment may be proposed for', 'amendment', [
          'AMENDMENT_REASON_NOT_ALLOWED',
        ]),
      );
    }
    const delta = BigInt(dto.deltaMinor);
    if (delta <= 0n) {
      throw this.refused(
        'propose_amendment',
        ruleRefusal(
          'An amendment adds to the price: a zero or negative change is refused',
          'amendment',
          ['AMENDMENT_DELTA_NOT_POSITIVE'],
        ),
      );
    }
    const person = currentActor({ requirePlatformUserId: true });

    return this.prisma.transaction(async (tx) => {
      if (fence) await fence.hold(tx);
      const contract = await this.contracts.lockContract(tx, row.organizationId, row.id);
      if (!contract || sideOf(contract, acting.organizationId) !== 'EMPLOYER') {
        throw RastaError.notFound('Contract', contractId);
      }
      this.assertSigned(contract, 'propose_amendment');
      if (dto.expectedVersion !== undefined && dto.expectedVersion !== contract.version) {
        throw RastaError.optimisticLockFailed('Contract', contract.id);
      }
      this.assertWithinLimit(contract, delta, 'propose_amendment');

      const at = await transactionNow(tx);
      const number = await this.repository.nextNumber(tx, contract.organizationId, contract.id);
      const amendment = await this.repository.insert(tx, {
        id: newId(ID_PREFIX.amendment),
        organizationId: contract.organizationId,
        contractId: contract.id,
        amendmentNumber: number,
        deltaMinor: delta,
        reasonCode: dto.reasonCode,
        reasonText: dto.reasonText,
        proposedBy: person.userId,
        correlationId: getContext().correlationId,
        at,
      });
      await this.publisher.enqueue(tx, {
        eventName: 'CONTRACT_AMENDMENT_PROPOSED',
        aggregateId: contract.id,
        organizationId: contract.organizationId,
        occurredAt: at,
        payload: {
          contractId: contract.id,
          amendmentId: amendment.id,
          amendmentNumber: amendment.amendmentNumber,
          organizationId: contract.organizationId,
          contractorOrganizationId: contract.contractorOrganizationId,
          reasonCode: amendment.reasonCode,
          proposedBy: person.userId,
          proposedAt: at.toISOString(),
        },
      });
      contractCommandsTotal.inc({
        service: SERVICE_NAME,
        command: 'propose_amendment',
        outcome: 'proposed',
      });
      const view = toAmendmentView(amendment);
      return fence ? fence.complete(tx, view) : view;
    });
  }

  // -- sign -----------------------------------------------------------------------------

  /**
   * Signs the amendment for the side the caller acts for (`PROPOSED → EFFECTIVE` once both have).
   * The same person signing the same side again changes nothing and answers with the amendment as
   * it is; another person for a side that has signed is `409`.
   */
  async sign(
    contractId: string,
    amendmentId: string,
    dto: SignAmendmentDto,
    fence?: ClaimFence<AmendmentView>,
  ): Promise<AmendmentView> {
    const acting = this.access.assertCanCommandAmendments();
    const row = await this.contracts.findParty(acting.organizationId, contractId);
    const side = row ? sideOf(row, acting.organizationId) : null;
    if (!row || !side) throw RastaError.notFound('Contract', contractId);

    const base = {
      action: 'SIGN_AMENDMENT',
      side,
      contractId: row.id,
      organizationId: row.organizationId,
      subjectId: amendmentId,
    } as const;

    let contractorRole: string | undefined;
    if (side === 'CONTRACTOR') {
      try {
        contractorRole = this.access.contractorSigningRole();
      } catch (error) {
        if (!(error instanceof RastaError)) throw error;
        return this.refusals.refuse(
          { ...base, reason: 'ROLE_NOT_PERMITTED' },
          this.refused('sign_amendment', error),
        );
      }
    }
    if (this.access.isMemberOfBothParties(row)) {
      throw this.refused(
        'sign_amendment',
        forbiddenRefusal(
          'Separation of duties: one person cannot be a member of both parties to a contract',
          'amendment',
          ['MEMBER_OF_BOTH_PARTIES'],
          { contractId: row.id },
        ),
      );
    }
    // A person, with an identity that can be compared to another's.
    const person = currentActor({ requirePlatformUserId: true });
    if (person.issuer === null || person.subject === null) {
      throw this.refused('sign_amendment', this.identityUnknown(row.id));
    }

    try {
      return await this.prisma.transaction(
        async (tx) => {
          if (fence) await fence.hold(tx);
          const view = await this.signLocked(
            tx,
            row,
            amendmentId,
            side,
            contractorRole,
            person,
            dto,
          );
          return fence ? fence.complete(tx, view) : view;
        },
        // The hierarchy is asked inside it, under its own deadline.
        { timeoutMs: this.authority.transactionTimeoutMs() },
      );
    } catch (error) {
      if (!(error instanceof AmendmentAuthorityRefused)) throw error;
      // Not only refused: a stranded policy is suspended, with the same event and audit as the
      // sweeper's (Q-83), so it does not wait for a queued task to stop being in force. The
      // caller's refusal is the same either way, and a write that fails must not turn it into
      // another error.
      const policyId = error.refused.policyId;
      if (error.refused.reason === 'POLICY_AUTHOR_NOT_GOVERNING' && policyId) {
        await this.suspension
          .suspend(
            { id: policyId, organizationId: error.refused.organizationId },
            {
              reason: 'SIGNING_RECHECK',
              correlationId: getContext().correlationId,
              callerService: SERVICE_NAME,
            },
          )
          .catch((suspendError: unknown) => {
            this.logger.warn(
              `Could not suspend stranded signing policy ${policyId}: ` +
                `${suspendError instanceof RastaError ? suspendError.code : 'INTERNAL'}`,
            );
          });
      }
      return this.refusals.refuse(error.refused, error.answer);
    }
  }

  private async signLocked(
    tx: ExtendedPrismaClient,
    found: Contract,
    amendmentId: string,
    side: ContractSideName,
    contractorRole: string | undefined,
    person: { userId: string; issuer: string | null; subject: string | null },
    dto: SignAmendmentDto,
  ): Promise<AmendmentView> {
    const contract = await this.contracts.lockContract(tx, found.organizationId, found.id);
    // Still a contract the caller is a party to, as it stands under the lock.
    if (!contract || sideOf(contract, getContext().organizationId ?? '') !== side) {
      throw RastaError.notFound('Contract', found.id);
    }
    const amendment = await this.repository.lock(
      tx,
      contract.organizationId,
      contract.id,
      amendmentId,
    );
    if (!amendment) throw RastaError.notFound('Amendment', amendmentId);
    const signatures = await this.repository.listSignatures(
      tx,
      contract.organizationId,
      amendment.id,
    );

    // The same person on the same side again: nothing to do, whatever the state has become.
    const mine = signatures.find((signature) => signature.side === side);
    if (mine) {
      const comparison = compareActors(person, signerOf(mine));
      if (comparison === 'SAME') {
        contractCommandsTotal.inc({
          service: SERVICE_NAME,
          command: 'sign_amendment',
          outcome: 'unchanged',
        });
        return toAmendmentView(amendment, signatures.map(factOf));
      }
      throw this.refused(
        'sign_amendment',
        comparison === 'DISTINCT'
          ? refusal(
              ERROR_CODES.ALREADY_EXISTS,
              'This side of the amendment has already signed',
              'amendment',
              ['SIDE_ALREADY_SIGNED'],
              { contractId: contract.id, amendmentId },
            )
          : this.identityUnknown(contract.id),
      );
    }

    if (amendment.status !== 'PROPOSED') {
      throw this.refused(
        'sign_amendment',
        ruleRefusal(
          'Only a proposed amendment is signed',
          'amendment',
          ['AMENDMENT_NOT_PROPOSED'],
          {
            contractId: contract.id,
            amendmentId,
          },
        ),
      );
    }
    this.assertSigned(contract, 'sign_amendment');
    if (dto.expectedVersion !== undefined && dto.expectedVersion !== amendment.version) {
      throw RastaError.optimisticLockFailed('Amendment', amendment.id);
    }
    // Exact arithmetic, as it stands under the lock: another amendment may have become effective
    // since this one was proposed.
    this.assertWithinLimit(contract, amendment.deltaMinor, 'sign_amendment');

    const authority = await this.authorityOf(tx, contract, amendment, side, contractorRole);

    // One person is never both sides: provably two people, or the signature is refused.
    const other = signatures.find((signature) => signature.side !== side);
    if (other) {
      const comparison = compareActors(person, signerOf(other));
      if (comparison === 'SAME') {
        throw this.refused(
          'sign_amendment',
          forbiddenRefusal(
            'Separation of duties: one person cannot sign for both sides of an amendment',
            'amendment',
            ['SAME_PERSON_BOTH_SIDES'],
            { contractId: contract.id, amendmentId },
          ),
        );
      }
      if (comparison === 'UNKNOWN') {
        throw this.refused('sign_amendment', this.identityUnknown(contract.id));
      }
    }

    const at = await transactionNow(tx);
    const recorded = await this.repository.insertSignature(tx, {
      id: newId(ID_PREFIX.amendmentSignature),
      organizationId: contract.organizationId,
      contractId: contract.id,
      amendmentId: amendment.id,
      side,
      signerOrganizationId: getContext().organizationId ?? '',
      signedBy: person.userId,
      signedByIssuer: person.issuer,
      signedBySubject: person.subject,
      authorityRole: authority.role,
      policyId: authority.policy?.id ?? null,
      policyVersion: authority.policy?.version ?? null,
      hierarchyEvidence: authority.evidence,
      correlationId: getContext().correlationId,
      at,
    });
    await this.publisher.enqueue(tx, {
      eventName: 'CONTRACT_AMENDMENT_SIGNATURE_RECORDED',
      aggregateId: contract.id,
      organizationId: contract.organizationId,
      occurredAt: at,
      payload: {
        contractId: contract.id,
        amendmentId: amendment.id,
        organizationId: contract.organizationId,
        side,
        signerOrganizationId: recorded.signerOrganizationId,
        signedBy: recorded.signedBy,
        authorityRole: recorded.authorityRole,
        policyId: recorded.policyId,
        policyVersion: recorded.policyVersion,
        signedAt: at.toISOString(),
      },
    });

    const all = [...signatures, recorded];
    if (!other) {
      contractCommandsTotal.inc({
        service: SERVICE_NAME,
        command: 'sign_amendment',
        outcome: 'recorded',
      });
      return toAmendmentView(amendment, all.map(factOf));
    }

    // The second signature completes the amendment: PROPOSED → EFFECTIVE, then the contract's
    // total, in this transaction. The amendment goes first: the database accepts the new total
    // only as the exact sum of the effective deltas.
    const entry = amendmentTransitionFor(amendment.status, 'sign');
    if (!entry) throw new Error(`amendment ${amendment.id}: no sign from ${amendment.status}`);
    if (
      !(await this.repository.makeEffective(tx, {
        organizationId: contract.organizationId,
        id: amendment.id,
        version: amendment.version,
        at,
      }))
    ) {
      throw RastaError.optimisticLockFailed('Amendment', amendment.id);
    }
    if (
      !(await this.repository.addToContractTotal(tx, {
        organizationId: contract.organizationId,
        contractId: contract.id,
        version: contract.version,
        delta: amendment.deltaMinor,
        at,
      }))
    ) {
      throw RastaError.optimisticLockFailed('Contract', contract.id);
    }
    const signedAt = (s: 'EMPLOYER' | 'CONTRACTOR') =>
      (other.side === s ? other : recorded).signedAt.toISOString();
    await this.publisher.enqueue(tx, {
      eventName: 'CONTRACT_AMENDED',
      aggregateId: contract.id,
      organizationId: contract.organizationId,
      occurredAt: at,
      payload: {
        contractId: contract.id,
        amendmentId: amendment.id,
        amendmentNumber: amendment.amendmentNumber,
        organizationId: contract.organizationId,
        contractorOrganizationId: contract.contractorOrganizationId,
        reasonCode: amendment.reasonCode,
        employerSignedAt: signedAt('EMPLOYER'),
        contractorSignedAt: signedAt('CONTRACTOR'),
        effectiveAt: at.toISOString(),
      },
    });
    contractCommandsTotal.inc({
      service: SERVICE_NAME,
      command: 'sign_amendment',
      outcome: 'effective',
    });
    const effective: Amendment = {
      ...amendment,
      status: entry.to,
      effectiveAt: at,
      updatedAt: at,
      version: amendment.version + 1,
    };
    return toAmendmentView(effective, all.map(factOf));
  }

  // -- shared ---------------------------------------------------------------------------

  /**
   * The authority the amendment is signed under (`SigningAuthority`, the contract signature's own),
   * each way it is denied turned into this command's refusal and audit record.
   */
  private async authorityOf(
    tx: ExtendedPrismaClient,
    contract: Contract,
    amendment: Amendment,
    side: ContractSideName,
    contractorRole: string | undefined,
  ): Promise<SigningAuthorityResult> {
    try {
      return await this.authority.resolve(tx, contract, side, contractorRole);
    } catch (error) {
      if (!(error instanceof SigningAuthorityDenied)) throw error;
      const refused = {
        action: 'SIGN_AMENDMENT',
        side,
        contractId: contract.id,
        organizationId: contract.organizationId,
        subjectId: amendment.id,
        reason: error.reason,
        policyId: error.reason === 'SIGNATURE_POLICY_REQUIRED' ? null : error.policyId,
      } as const;
      const context = { contractId: contract.id, amendmentId: amendment.id };
      if (error.reason === 'SIGNATURE_POLICY_REQUIRED') {
        throw new AmendmentAuthorityRefused(
          refused,
          this.refused(
            'sign_amendment',
            ruleRefusal(
              'No signing policy is in force for the employer: nobody may sign for it yet',
              'amendment',
              ['SIGNATURE_POLICY_REQUIRED'],
              context,
            ),
          ),
        );
      }
      if (error.reason === 'POLICY_AUTHOR_NOT_GOVERNING') {
        throw new AmendmentAuthorityRefused(
          refused,
          this.refused(
            'sign_amendment',
            forbiddenRefusal(
              'The union that wrote the signing policy in force no longer governs this employer',
              'amendment',
              ['POLICY_AUTHOR_NOT_GOVERNING'],
              context,
            ),
          ),
        );
      }
      throw new AmendmentAuthorityRefused(
        refused,
        this.refused(
          'sign_amendment',
          RastaError.insufficientRole(error.requiredRoles, getContext().roles),
        ),
      );
    }
  }

  /** Only a SIGNED contract is amended (ADR-068 § 2 gives no later window). */
  private assertSigned(contract: Contract, command: AmendmentCommand): void {
    if (contract.status !== 'SIGNED') {
      throw this.refused(
        command,
        ruleRefusal('Only a signed contract is amended', 'amendment', ['CONTRACT_NOT_SIGNED'], {
          contractId: contract.id,
        }),
      );
    }
  }

  /**
   * `amount + amendments total + delta` must be storable: the cap `approved <= amount + amendments`
   * (ADR-068 § 5) is judged against it, and a bigint that overflows would otherwise surface as a
   * database error. Exact bigint arithmetic, never a number.
   */
  private assertWithinLimit(contract: Contract, delta: bigint, command: AmendmentCommand): void {
    if (contract.amountMinor + contract.amendmentsTotalMinor + delta > MAX_AMOUNT_MINOR) {
      throw this.refused(
        command,
        ruleRefusal(
          'The contract price with its amendments would exceed the largest amount stored',
          'amendment',
          ['AMENDMENT_EXCEEDS_LIMIT'],
          { contractId: contract.id },
        ),
      );
    }
  }

  /** `422 ACTOR_IDENTITY_UNKNOWN`: the two people cannot be told apart (#188), so neither signs. */
  private identityUnknown(contractId: string): RastaError {
    return refusal(
      ERROR_CODES.ACTOR_IDENTITY_UNKNOWN,
      'Separation of duties cannot be proven, because a record names no stable identity: the two sides of an amendment',
      'amendment',
      ['ACTOR_IDENTITY_UNKNOWN'],
      { contractId },
    );
  }

  /** Counts the refusal; the error is thrown by the caller. */
  private refused(command: AmendmentCommand, error: RastaError): RastaError {
    contractCommandsTotal.inc({ service: SERVICE_NAME, command, outcome: 'refused' });
    return error;
  }
}
