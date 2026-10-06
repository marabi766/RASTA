import { Inject, Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '@rasta/contracts';
import { RastaError, compareActors, currentActor, getContext } from '@rasta/nest-common';
import type { Contract, ContractSignature } from '../generated/prisma';
import { ContractAccess, assertPartyOf, sideOf, type ContractSideName } from '../access/access';
import type { ContractEnv } from '../config/env';
import { SERVICE_NAME } from '../config/env';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { contractCommandsTotal } from '../observability/metrics';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { ClaimFence } from '../shared/idempotency';
import { databaseClock, transactionNow } from '../shared/clock';
import { forbiddenRefusal, refusal, ruleRefusal } from '../shared/refusal';
import { OrganizationDirectory } from '../organization/organization-directory';
import { UNION_ROLE, signingRoleUnder } from '../policy/policy.access';
import { PolicyRepository } from '../policy/policy.repository';
import { PolicySuspensionService } from '../policy/policy-suspension.service';
import { SIGNATURE_WORKFLOW } from '../policy/policy.state-machine';
import { ENV } from '../tokens';
import { ContractRepository, type HierarchyEvidence } from './contract.repository';
import { transitionFor } from './contract.state-machine';
import type {
  CancelContractDto,
  ContractView,
  CursorPage,
  ListContractsQuery,
  SignContractDto,
} from './dto';
import { toContractView, type SignatureFact } from './views';

/** The person as a signature recorded them, ready for `compareActors` (#188). */
function signerOf(signature: ContractSignature) {
  return {
    userId: signature.signedBy,
    issuer: signature.signedByIssuer,
    subject: signature.signedBySubject,
  };
}

/**
 * The employer's signature was refused for want of authority: no policy in force (none was ever
 * approved, or it was suspended, retired or replaced), or the policy in force was written by a
 * union that no longer governs the employer. Thrown from inside the signing transaction — which
 * rolls back, so nothing is recorded — and turned by `sign` into the caller's refusal after two
 * things written in transactions of their own, because anything written inside the rolled-back one
 * would be lost with it: the policy's suspension (when it is stranded), and the durable refusal
 * audit record (`CONTRACT_SIGNATURE_REFUSED`, review round 3).
 */
class SigningAuthorityRefused extends Error {
  constructor(
    readonly reason: 'SIGNATURE_POLICY_REQUIRED' | 'POLICY_AUTHOR_NOT_GOVERNING',
    readonly contractId: string,
    readonly organizationId: string,
    /** The policy that was in force and stranded; null when there was none. */
    readonly policyId: string | null,
    readonly refusal: RastaError,
  ) {
    super('The signature was refused for want of authority');
  }
}

const factOf = (
  signature: ContractSignature & { review?: { id: string } | null },
): SignatureFact => ({
  side: signature.side,
  signedAt: signature.signedAt,
  reviewRequired: signature.review != null,
});

/**
 * The contract, and the two commands a party gives it (ADR-068 § 2, § 7).
 *
 * A contract is **made** by the consumer of `TENDER_AWARDED` and by nothing else; a user
 * reads it, signs it for their side, and the employer may cancel it while it is a draft.
 * Every other change — amendments, milestones, statements, completion, settlement — is a
 * later change (ADR-068 § 9).
 *
 * ## How a command is made safe
 *
 * - **Object-level authorization first.** The contract is found as the employer (through the
 *   tenant guard) or as the winning contractor (an explicit predicate on the organization the
 *   signed token names); anyone else gets the `404` a missing contract gets (S-03). Only then
 *   are the caller's roles judged — a stranger is never told which role they lacked.
 * - **One lock, then the state.** Inside one transaction the contract row is locked
 *   (`FOR UPDATE`) and read again, and only then is anything decided: the two parties' commands
 *   are ordered, so the second signature is the one that completes the contract and a
 *   cancellation never interleaves with a signature. The status change is a compare-and-set on
 *   `organization_id`, `id`, status and `version` (`ContractRepository.transition`).
 * - **The event and the audit record are in that transaction.** Each signature is a row and a
 *   `CONTRACT_SIGNATURE_RECORDED`; the second also moves the contract and publishes
 *   `CONTRACT_SIGNED`; a cancellation publishes `CONTRACT_CANCELLED`. A failure anywhere rolls
 *   all of it back.
 * - **Separation of duties on the stable identity** (`compareActors`, #188): one person cannot
 *   sign for both sides, a member of both organizations is refused whichever side they act for,
 *   and an identity that cannot be shown to be a different person is `422
 *   ACTOR_IDENTITY_UNKNOWN` — never a guess. The database refuses the provable cases too.
 *
 * Business rules live here, not in the controller (AGENTS.md A-10).
 */
@Injectable()
export class ContractService {
  private readonly logger = new Logger(ContractService.name);

  constructor(
    private readonly repository: ContractRepository,
    private readonly policies: PolicyRepository,
    private readonly directory: OrganizationDirectory,
    private readonly suspension: PolicySuspensionService,
    private readonly access: ContractAccess,
    private readonly prisma: PrismaService,
    private readonly publisher: EventPublisher,
    @Inject(ENV) private readonly env: ContractEnv,
  ) {}

  // -- reads ----------------------------------------------------------------------------

  /**
   * One contract, to a party to it. Any other caller — an organization that is neither the
   * employer nor the winning contractor, and one that is missing — gets the same `404`.
   */
  async get(id: string): Promise<ContractView> {
    const parties = this.access.assertCanRead();

    let row: Contract | null = null;
    if (parties.employer) row = await this.repository.findOwn(id);
    if (!row && parties.contractor) {
      row = await this.repository.findAsContractor(parties.organizationId, id);
    }
    if (!row) throw RastaError.notFound('Contract', id);

    // The row-level half of the guard: whatever query produced the row, it is a party's.
    assertPartyOf(row, parties);
    const facts = await this.repository.signatureFacts([row]);
    return toContractView(row, facts.get(row.id));
  }

  /** The caller's contracts, newest first: as employer, as winning contractor, or both. */
  async list(query: ListContractsQuery): Promise<CursorPage<ContractView>> {
    const parties = this.access.assertCanRead();
    const filter = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    };

    const found: Contract[] = [];
    if (parties.employer) found.push(...(await this.repository.listOwn(filter)));
    if (parties.contractor) {
      found.push(...(await this.repository.listAsContractor(parties.organizationId, filter)));
    }

    // Newest first across the two sides; one contract is never both (the employer is not its
    // own contractor — `ck_contract_parties_distinct`), so nothing is listed twice.
    found.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const hasMore = found.length > query.limit;
    const visible = hasMore ? found.slice(0, query.limit) : found;
    visible.forEach((row) => assertPartyOf(row, parties));

    const facts = await this.repository.signatureFacts(visible);
    return {
      items: visible.map((row) => toContractView(row, facts.get(row.id))),
      nextCursor: hasMore ? (visible[visible.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  /**
   * Whether the caller may still see this contract: the check a stored response must pass
   * before it is replayed (the same rule a fresh request applies now).
   */
  async assertVisible(id: string): Promise<void> {
    await this.get(id);
  }

  // -- sign -----------------------------------------------------------------------------

  /**
   * Accepts the draft for the side the caller acts for (`DRAFT → SIGNED` once both have).
   *
   * Signing is a recorded acceptance of both parties, not a legal signature (Q-95 (1)); the
   * employer's authority is the `contract.signature` approval policy in force for its own
   * organization — nobody until one is written and approved (422 `SIGNATURE_POLICY_REQUIRED`).
   * The same person signing the same side again changes nothing and answers with the contract
   * as it is; another person for a side that has signed is `409`.
   */
  async sign(
    id: string,
    dto: SignContractDto,
    fence?: ClaimFence<ContractView>,
  ): Promise<ContractView> {
    const acting = this.access.assertCanCommand();
    const row = await this.findParty(acting.organizationId, id);
    const side = sideOf(row, acting.organizationId);
    if (!side) throw RastaError.notFound('Contract', id);

    // The contractor's side is a fixed role of its own organization and is judged now. The
    // employer's is the `contract.signature` policy of its organization, which can change under
    // a concurrent approval or retirement: it is read and judged under the contract's lock, in
    // the transaction that records the signature (`signLocked`).
    const contractorRole = side === 'CONTRACTOR' ? this.access.contractorSigningRole() : undefined;
    if (this.access.isMemberOfBothParties(row)) {
      throw this.refused(
        'sign',
        forbiddenRefusal(
          'Separation of duties: one person cannot be a member of both parties to a contract',
          'signature',
          ['MEMBER_OF_BOTH_PARTIES'],
          { contractId: id },
        ),
      );
    }
    // A person, with an identity that can be compared to another's: a token without it is
    // refused (403) here, and a token whose issuer and subject are missing (below) is 422.
    const person = currentActor({ requirePlatformUserId: true });
    if (person.issuer === null || person.subject === null) {
      throw this.refused('sign', this.identityUnknown(id));
    }

    try {
      return await this.prisma.transaction(
        async (tx) => {
          if (fence) await fence.hold(tx);
          const view = await this.signLocked(tx, row, side, contractorRole, person, dto);
          return fence ? fence.complete(tx, view) : view;
        },
        // The hierarchy is asked inside it (`authorityOf`), under its own deadline.
        { timeoutMs: this.signingTransactionTimeoutMs() },
      );
    } catch (error) {
      if (!(error instanceof SigningAuthorityRefused)) throw error;
      // Not only refused: a stranded policy is suspended, with the same event and audit as the
      // sweeper's (Q-83), so it does not wait for a queued task to stop being in force. The
      // caller's refusal is the same either way, and a write that fails must not turn it into
      // another error.
      if (error.reason === 'POLICY_AUTHOR_NOT_GOVERNING' && error.policyId) {
        const policyId = error.policyId;
        await this.suspension
          .suspend(
            { id: policyId, organizationId: error.organizationId },
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
      // The refusal is an audit fact (S-06): when it cannot be recorded it is not answered as the
      // normal refusal — a retryable 503, the claim released by the caller's failure path, so the
      // same request can be made again and leave its trace. Nothing was signed either way.
      try {
        await this.recordRefusal(error);
      } catch (auditError: unknown) {
        this.logger.error(
          `Could not record the refusal of a signature (${error.reason}): ` +
            `${auditError instanceof RastaError ? auditError.code : 'INTERNAL'}`,
        );
        throw new RastaError(
          ERROR_CODES.UPSTREAM_UNAVAILABLE,
          'The refusal could not be recorded; nothing was signed. Retry shortly',
          { cause: auditError, retryAfterSeconds: 1, internalContext: { reason: error.reason } },
        );
      }
      throw error.refusal;
    }
  }

  /**
   * The durable audit record of a signature refused for want of authority: `CONTRACT_SIGNATURE_
   * REFUSED` through the outbox, committed in a transaction of its own — the signing transaction
   * rolled back, and a refusal that left no trace would be invisible to the one audit that must
   * show who tried to sign for an employer when nobody had the authority (S-06).
   */
  private async recordRefusal(refused: SigningAuthorityRefused): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      const at = await transactionNow(tx);
      await this.publisher.enqueue(tx, {
        eventName: 'CONTRACT_SIGNATURE_REFUSED',
        aggregateId: refused.contractId,
        organizationId: refused.organizationId,
        payload: {
          contractId: refused.contractId,
          organizationId: refused.organizationId,
          side: 'EMPLOYER',
          reason: refused.reason,
          policyId: refused.policyId,
          refusedBy: getContext().userId ?? 'unknown',
          refusedAt: at.toISOString(),
        },
        occurredAt: at,
      });
    });
  }

  /**
   * The authority a signature is accepted under, judged inside the signing transaction.
   *
   * The contractor's is its fixed role. The employer's is read from the `contract.signature`
   * policy **in force** for the employer's organization, under the policy slot's advisory lock
   * (after the contract's row lock — the one lock order, `PolicyRepository.lockPolicySlot`), so a
   * policy approved or retired at the same moment is either entirely before this signature or
   * entirely after it. No policy in force: `422 SIGNATURE_POLICY_REQUIRED` — the platform never
   * defaults to granting that authority. A policy that does not name a role the caller holds: 403.
   * The policy's id and version are recorded on the signature.
   */
  private async authorityOf(
    tx: ExtendedPrismaClient,
    contract: Contract,
    side: ContractSideName,
    contractorRole: string | undefined,
  ): Promise<{
    role: string;
    policy: { id: string; version: number } | null;
    evidence: HierarchyEvidence | null;
  }> {
    if (side === 'CONTRACTOR') {
      return {
        role: contractorRole ?? this.access.contractorSigningRole(),
        policy: null,
        evidence: null,
      };
    }
    await this.policies.lockPolicySlot(tx, contract.organizationId, SIGNATURE_WORKFLOW);
    const policy = await this.policies.findActivePolicyOf(
      tx,
      contract.organizationId,
      SIGNATURE_WORKFLOW,
    );
    if (!policy) {
      throw new SigningAuthorityRefused(
        'SIGNATURE_POLICY_REQUIRED',
        contract.id,
        contract.organizationId,
        null,
        this.refused(
          'sign',
          ruleRefusal(
            'No signing policy is in force for the employer: nobody may sign for it yet',
            'signature',
            ['SIGNATURE_POLICY_REQUIRED'],
            { contractId: contract.id },
          ),
        ),
      );
    }
    // The policy rests on a union governing the employer, and that is the hierarchy's to say, now
    // (Q-70 (7), Q-83): a union-written policy keeps no authority once its union has lost the
    // employer, however long ago it was approved. Asked here, under the slot's lock, so the
    // answer and the signature are one decision — a policy approved, retired or suspended at the
    // same moment is either entirely before this or entirely after it. "Could not confirm" is
    // an upstream error that rolls this back: nothing is recorded on a relation that was not
    // confirmed (fail closed). A platform administrator's policy needs no hierarchy.
    let evidence: HierarchyEvidence | null = null;
    if (policy.authorRole === UNION_ROLE) {
      // The answer carries the hierarchy version of the employer, and that version — not a clock —
      // is what a later move is ordered against (D-050). The instants are kept beside it: the
      // question's, and the latest this signature could commit at, bound which signatures a move
      // can have raced at all.
      const askedAt = await databaseClock(tx);
      const within = await this.directory.withinVersion(
        policy.authorOrganizationId,
        contract.organizationId,
      );
      if (!within) {
        throw new SigningAuthorityRefused(
          'POLICY_AUTHOR_NOT_GOVERNING',
          contract.id,
          contract.organizationId,
          policy.id,
          this.refused(
            'sign',
            forbiddenRefusal(
              'The union that wrote the signing policy in force no longer governs this employer',
              'signature',
              ['POLICY_AUTHOR_NOT_GOVERNING'],
              { contractId: contract.id },
            ),
          ),
        );
      }
      // The signing transaction's own timeout is the latest this signature can commit at
      // (`sign`), so a move landing between `askedAt` and that deadline is one it may have raced.
      evidence = {
        authorOrganizationId: policy.authorOrganizationId,
        // What orders this signature against a move: the version of the tree the answer came from.
        hierarchyVersion: within.hierarchyVersion,
        readAt: askedAt,
        commitDeadline: new Date(
          (await transactionNow(tx)).getTime() + this.signingTransactionTimeoutMs(),
        ),
      };
    }
    const roles = getContext().roles;
    const role = signingRoleUnder(policy, roles);
    if (!role) {
      throw this.refused(
        'sign',
        RastaError.insufficientRole(
          policy.steps.map((step) => step.authorityRole),
          roles,
        ),
      );
    }
    return { role, policy: { id: policy.id, version: policy.policyVersion }, evidence };
  }

  /** How long the signing transaction may run: the hierarchy question's deadline and some room. */
  private signingTransactionTimeoutMs(): number {
    return this.env.CONTRACT_ORGANIZATION_REQUEST_TIMEOUT_MS + 10_000;
  }

  private async signLocked(
    tx: ExtendedPrismaClient,
    found: Contract,
    side: ContractSideName,
    contractorRole: string | undefined,
    person: { userId: string; issuer: string | null; subject: string | null },
    dto: SignContractDto,
  ): Promise<ContractView> {
    const contract = await this.repository.lockContract(tx, found.organizationId, found.id);
    // Still a contract the caller is a party to, as it stands under the lock.
    if (!contract || sideOf(contract, getContext().organizationId ?? '') !== side) {
      throw RastaError.notFound('Contract', found.id);
    }
    const signatures = await this.repository.listSignatures(
      tx,
      contract.organizationId,
      contract.id,
    );

    // The same person on the same side again: nothing to do, whatever the state has become.
    const mine = signatures.find((signature) => signature.side === side);
    if (mine) {
      const comparison = compareActors(person, signerOf(mine));
      if (comparison === 'SAME') {
        contractCommandsTotal.inc({ service: SERVICE_NAME, command: 'sign', outcome: 'unchanged' });
        return toContractView(contract, signatures.map(factOf));
      }
      throw this.refused(
        'sign',
        comparison === 'DISTINCT'
          ? refusal(
              ERROR_CODES.ALREADY_EXISTS,
              'This side of the contract has already signed',
              'signature',
              ['SIDE_ALREADY_SIGNED'],
              { contractId: contract.id },
            )
          : this.identityUnknown(contract.id),
      );
    }

    if (contract.status !== 'DRAFT') {
      throw this.refused(
        'sign',
        ruleRefusal('Only a draft contract is signed', 'signature', ['CONTRACT_NOT_DRAFT'], {
          contractId: contract.id,
        }),
      );
    }
    this.assertVersion(contract, dto.expectedVersion);

    // Who may sign, as the contract stands: the policy in force now (employer), and its id and
    // version are what the signature records.
    const authority = await this.authorityOf(tx, contract, side, contractorRole);

    // One person is never both sides: provably two people, or the signature is refused.
    const other = signatures.find((signature) => signature.side !== side);
    if (other) {
      const comparison = compareActors(person, signerOf(other));
      if (comparison === 'SAME') {
        throw this.refused(
          'sign',
          forbiddenRefusal(
            'Separation of duties: one person cannot sign for both sides of a contract',
            'signature',
            ['SAME_PERSON_BOTH_SIDES'],
            { contractId: contract.id },
          ),
        );
      }
      if (comparison === 'UNKNOWN') throw this.refused('sign', this.identityUnknown(contract.id));
    }

    const at = await transactionNow(tx);
    const correlationId = getContext().correlationId;
    const recorded = await this.repository.insertSignature(tx, {
      id: newId(ID_PREFIX.signature),
      organizationId: contract.organizationId,
      contractId: contract.id,
      side,
      signerOrganizationId: getContext().organizationId ?? '',
      signedBy: person.userId,
      signedByIssuer: person.issuer,
      signedBySubject: person.subject,
      authorityRole: authority.role,
      policyId: authority.policy?.id ?? null,
      policyVersion: authority.policy?.version ?? null,
      hierarchyEvidence: authority.evidence,
      correlationId,
      at,
    });
    await this.publisher.enqueue(tx, {
      eventName: 'CONTRACT_SIGNATURE_RECORDED',
      aggregateId: contract.id,
      organizationId: contract.organizationId,
      occurredAt: at,
      payload: {
        contractId: contract.id,
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
      contractCommandsTotal.inc({ service: SERVICE_NAME, command: 'sign', outcome: 'recorded' });
      return toContractView(contract, all.map(factOf));
    }

    // The second signature completes the contract: DRAFT → SIGNED, in this transaction.
    const moved = await this.moveTo(tx, contract, 'sign', 'SIGNED', person.userId, at);
    // Both sides have signed: `other` is the first, `recorded` the second.
    const signedAt = (s: 'EMPLOYER' | 'CONTRACTOR') =>
      (other.side === s ? other : recorded).signedAt.toISOString();
    await this.publisher.enqueue(tx, {
      eventName: 'CONTRACT_SIGNED',
      aggregateId: contract.id,
      organizationId: contract.organizationId,
      occurredAt: at,
      payload: {
        contractId: contract.id,
        tenderId: contract.tenderId,
        projectId: contract.projectId,
        organizationId: contract.organizationId,
        contractorOrganizationId: contract.contractorOrganizationId,
        winningBidId: contract.winningBidId,
        employerSignedAt: signedAt('EMPLOYER'),
        contractorSignedAt: signedAt('CONTRACTOR'),
        signedAt: at.toISOString(),
      },
    });
    contractCommandsTotal.inc({ service: SERVICE_NAME, command: 'sign', outcome: 'signed' });
    return toContractView(moved, all.map(factOf));
  }

  // -- cancel ---------------------------------------------------------------------------

  /**
   * The employer ends a draft (`DRAFT → CANCELLED`), for a reason from the configured closed
   * list (Q-95 (4)). A contract that is not a draft is never cancelled — a signed contract is
   * ended by no route (`422`) — and, by default, neither is a draft one side has already
   * signed (`CONTRACT_CANCEL_AFTER_SIGNATURE`).
   */
  async cancel(
    id: string,
    dto: CancelContractDto,
    fence?: ClaimFence<ContractView>,
  ): Promise<ContractView> {
    const acting = this.access.assertCanCommand();
    const row = await this.findParty(acting.organizationId, id);
    const side = sideOf(row, acting.organizationId);
    if (!side) throw RastaError.notFound('Contract', id);
    this.access.assertMayCancel(side);

    if (!this.env.CONTRACT_CANCEL_REASON_CODES.includes(dto.reasonCode)) {
      throw this.refused(
        'cancel',
        ruleRefusal('This reason is not one the contract may be cancelled for', 'cancellation', [
          'CANCEL_REASON_NOT_ALLOWED',
        ]),
      );
    }
    const person = currentActor({ requirePlatformUserId: true });

    return this.prisma.transaction(async (tx) => {
      if (fence) await fence.hold(tx);
      const contract = await this.repository.lockContract(tx, row.organizationId, row.id);
      if (!contract || sideOf(contract, acting.organizationId) !== 'EMPLOYER') {
        throw RastaError.notFound('Contract', id);
      }
      if (contract.status !== 'DRAFT') {
        throw this.refused(
          'cancel',
          ruleRefusal(
            'Only a draft contract is cancelled',
            'cancellation',
            ['CONTRACT_NOT_DRAFT'],
            {
              contractId: contract.id,
            },
          ),
        );
      }
      this.assertVersion(contract, dto.expectedVersion);
      const signatures = await this.repository.listSignatures(
        tx,
        contract.organizationId,
        contract.id,
      );
      if (signatures.length > 0 && !this.env.CONTRACT_CANCEL_AFTER_SIGNATURE) {
        throw this.refused(
          'cancel',
          ruleRefusal(
            'A draft that a party has signed is not cancelled',
            'cancellation',
            ['SIGNATURE_RECORDED'],
            { contractId: contract.id },
          ),
        );
      }

      const at = await transactionNow(tx);
      const moved = await this.moveTo(tx, contract, 'cancel', 'CANCELLED', person.userId, at, {
        reasonCode: dto.reasonCode,
        note: dto.note,
      });
      await this.publisher.enqueue(tx, {
        eventName: 'CONTRACT_CANCELLED',
        aggregateId: contract.id,
        organizationId: contract.organizationId,
        occurredAt: at,
        payload: {
          contractId: contract.id,
          tenderId: contract.tenderId,
          projectId: contract.projectId,
          organizationId: contract.organizationId,
          contractorOrganizationId: contract.contractorOrganizationId,
          reasonCode: dto.reasonCode,
          cancelledAt: at.toISOString(),
        },
      });
      contractCommandsTotal.inc({ service: SERVICE_NAME, command: 'cancel', outcome: 'cancelled' });
      const view = toContractView(moved, signatures.map(factOf));
      return fence ? fence.complete(tx, view) : view;
    });
  }

  // -- shared ---------------------------------------------------------------------------

  /**
   * The contract, found as the employer (through the tenant guard) or as the winning contractor;
   * `404` for everyone else, a contract that does not exist included.
   */
  private async findParty(organizationId: string, id: string): Promise<Contract> {
    const row =
      (await this.repository.findOwn(id)) ??
      (await this.repository.findAsContractor(organizationId, id));
    if (!row || !sideOf(row, organizationId)) throw RastaError.notFound('Contract', id);
    return row;
  }

  /** `409` when the caller named a version and the contract is no longer at it. */
  private assertVersion(contract: Contract, expected: number | undefined): void {
    if (expected !== undefined && expected !== contract.version) {
      throw RastaError.optimisticLockFailed('Contract', contract.id);
    }
  }

  /**
   * The status change, from the table (`CONTRACT_TRANSITIONS`) and as a compare-and-set on the
   * version the lock just read. A command the table does not have from this state is a defect,
   * not a refusal: the caller checked the state first.
   */
  private async moveTo(
    tx: ExtendedPrismaClient,
    contract: Contract,
    command: 'sign' | 'cancel',
    to: 'SIGNED' | 'CANCELLED',
    actor: string,
    at: Date,
    cancellation?: { reasonCode: string; note?: string | undefined },
  ): Promise<Contract> {
    const entry = transitionFor(contract.status, command);
    if (!entry || entry.to !== to) {
      throw new Error(`contract ${contract.id}: no ${command} from ${contract.status}`);
    }
    const moved = await this.repository.transition(tx, {
      organizationId: contract.organizationId,
      id: contract.id,
      from: entry.from,
      to: entry.to,
      version: contract.version,
      actor,
      at,
      ...(cancellation ? { cancellation } : {}),
    });
    if (!moved) throw RastaError.optimisticLockFailed('Contract', contract.id);
    return {
      ...contract,
      status: entry.to,
      statusChangedAt: at,
      statusChangedBy: actor,
      updatedAt: at,
      version: contract.version + 1,
      ...(cancellation
        ? { cancelReasonCode: cancellation.reasonCode, cancelNote: cancellation.note ?? null }
        : {}),
    };
  }

  /** `422 ACTOR_IDENTITY_UNKNOWN`: the two people cannot be told apart (#188), so neither signs. */
  private identityUnknown(contractId: string): RastaError {
    return refusal(
      ERROR_CODES.ACTOR_IDENTITY_UNKNOWN,
      'Separation of duties cannot be proven, because a record names no stable identity: the two sides of a contract',
      'signature',
      ['ACTOR_IDENTITY_UNKNOWN'],
      { contractId },
    );
  }

  /** Counts the refusal; the error is thrown by the caller. */
  private refused(command: 'sign' | 'cancel', error: RastaError): RastaError {
    contractCommandsTotal.inc({ service: SERVICE_NAME, command, outcome: 'refused' });
    return error;
  }
}
