import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  RastaError,
  actorIdentityUnknown,
  compareActors,
  currentActor,
  getContext,
  type ActorComparison,
  type ActorIdentity,
} from '@rasta/nest-common';
import { ulid } from 'ulid';
import type { ContractEnv } from '../config/env';
import type { Prisma } from '../generated/prisma';
import { EventPublisher, ID_PREFIX } from '../events/publisher';
import { OrganizationDirectory } from '../organization/organization-directory';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { CursorPage } from '../contract/dto';
import type { ClaimFence } from '../shared/idempotency';
import { transactionNow } from '../shared/clock';
import { isUniqueViolation } from '../shared/prisma-errors';
import { ruleRefusal } from '../shared/refusal';
import { storedActor, storedIdentityOf } from '../shared/stable-actor';
import { ENV } from '../tokens';
import { SUPER_ROLE } from '../access/access';
import { PolicyAccess, UNION_ROLE, type PolicyAuthorRole } from './policy.access';
import { PolicyRepository, type PolicyWithSteps } from './policy.repository';
import {
  assertPolicyTransition,
  type PolicyStateName,
  type WorkflowKey,
} from './policy.state-machine';
import { toPolicyView } from './views';
import type {
  CreatePolicyDto,
  ListPoliciesQuery,
  PolicyRejectionDto,
  PolicyTransitionDto,
  PolicyView,
} from './dto';

export const POLICY_ID_PREFIX = ID_PREFIX.policy;
export const POLICY_STEP_ID_PREFIX = ID_PREFIX.policyStep;

/** The route template the idempotency store keys on: a closed set, never an id. */
export const CREATE_POLICY_ENDPOINT = 'POST /v1/approval-policies';

/**
 * Approval policies: who writes them, who puts them in force (ADR-023, ADR-063, ADR-068 § 5,
 * Q-70 (7) decided 2026-09-26) — construction-service's mechanism, for the policy that says which
 * roles of an employer's organization accept a contract for it (`contract.signature`).
 *
 * ```
 *   create        submit                           approve (SYSTEM_ADMIN)
 *   ────► DRAFT ─────────► PENDING_PLATFORM_APPROVAL ──────────────────► ACTIVE ──retire──► RETIRED
 *                                   └──reject(reason)──► REJECTED
 * ```
 *
 * - **Writers.** A `UNION_ADMIN` writes for its own organization or one beneath it;
 *   organization-service confirms which, at create and again at submit and approval, and "could
 *   not confirm" refuses the write. A `SYSTEM_ADMIN` may write for any organization
 *   organization-service knows. An `ORGANIZATION_ADMIN` never writes its own policy (conflict of
 *   interest).
 * - **Platform approval.** Only a `SYSTEM_ADMIN` approves or rejects, and never one who wrote or
 *   submitted the policy (four eyes). Only a `SYSTEM_ADMIN`'s own policy may be self-approved, and
 *   only with `CONTRACT_POLICY_FOUR_EYES` off — a provisional, pending-owner flag. Approval puts
 *   the policy in force and retires the one it replaces, in one transaction.
 * - **Governing.** Only an ACTIVE policy governs; a DRAFT, PENDING, REJECTED or SUSPENDED one never
 *   does. The system suspends a union's ACTIVE or PENDING policy when an `ORGANIZATION_MOVED` takes
 *   its organization out of the union (`PolicySuspensionService`, Q-83); nobody revives it.
 *
 * Nothing here decides whether an authority a policy names is legitimate: the union wrote it and
 * the platform approved it; this service stores it. Every transition writes its event in the same
 * transaction.
 */
@Injectable()
export class PolicyService implements OnModuleInit {
  private readonly logger = new Logger(PolicyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: PolicyRepository,
    private readonly events: EventPublisher,
    private readonly access: PolicyAccess,
    private readonly directory: OrganizationDirectory,
    @Inject(ENV) private readonly env: ContractEnv,
  ) {}

  /**
   * Switching four eyes off is a provisional, pending-owner choice (Q-70); say so loudly every
   * time the service starts that way.
   */
  onModuleInit(): void {
    if (!this.env.CONTRACT_POLICY_FOUR_EYES) {
      this.logger.warn(
        'CONTRACT_POLICY_FOUR_EYES is off: a SYSTEM_ADMIN may approve an approval policy it ' +
          'wrote itself. Provisional, pending the owner (Q-70); union-written policies are still ' +
          'never self-approved.',
      );
    }
  }

  /**
   * Writes a DRAFT policy version. Called inside the idempotency claim of the route
   * (`fence`): the policy, its event and the stored response commit together.
   */
  async create(dto: CreatePolicyDto, fence?: ClaimFence<PolicyView>): Promise<PolicyView> {
    const author = this.access.assertPolicyAuthor();
    await this.assertMayGovern(author.role, author.organizationId, dto.organizationId);

    // For `contract.signature` the authority is a role of the governed organization itself: the
    // employer decides which of its own roles accept a contract for it, and no other
    // organization's role can (the database refuses the same, when a signature is recorded).
    const foreign = dto.steps.filter((step) => step.authorityOrganizationId !== dto.organizationId);
    if (foreign.length > 0) {
      throw ruleRefusal(
        'A signing policy names roles of the organization it governs, and no other',
        'policy',
        ['AUTHORITY_NOT_GOVERNED_ORGANIZATION'],
        { organizationId: dto.organizationId },
      );
    }

    const policyId = `${POLICY_ID_PREFIX}_${ulid()}`;
    try {
      return await this.prisma.transaction(async (tx) => {
        if (fence) await fence.hold(tx);
        const at = await transactionNow(tx);
        const policyVersion = await this.repository.nextPolicyVersion(
          tx,
          dto.organizationId,
          dto.workflowKey,
        );

        await this.repository.createPolicy(
          tx,
          {
            id: policyId,
            organizationId: dto.organizationId,
            authorOrganizationId: author.organizationId,
            authorRole: author.role,
            workflowKey: dto.workflowKey,
            policyVersion,
            label: dto.label,
            rationale: dto.rationale,
            isSample: dto.isSample,
            actor: author.actor,
            actorIdentity: storedIdentityOf(currentActor()),
            correlationId: getContext().correlationId,
            at,
          },
          dto.steps.map((step, index) => ({
            id: `${POLICY_STEP_ID_PREFIX}_${ulid()}`,
            stepOrder: index + 1,
            authorityOrganizationId: step.authorityOrganizationId,
            authorityRole: step.authorityRole,
            authorityLabel: step.authorityLabel,
          })),
        );

        await this.events.enqueue(tx, {
          eventName: 'APPROVAL_POLICY_CREATED',
          aggregateId: policyId,
          organizationId: dto.organizationId,
          payload: {
            policyId,
            organizationId: dto.organizationId,
            authorOrganizationId: author.organizationId,
            authorRole: author.role,
            workflowKey: dto.workflowKey,
            policyVersion,
            stepCount: dto.steps.length,
            isSample: dto.isSample,
            createdBy: author.actor,
            createdAt: at.toISOString(),
          },
          occurredAt: at,
        });

        // The policy and its key's completion commit together.
        const created = toPolicyView(await this.policyOrNotFound(tx, policyId));
        return fence ? fence.complete(tx, created) : created;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Two policies of one workflow created at the same instant drew the same version number.
        // Nothing was written; the caller retries.
        throw new RastaError(
          'CONFLICT',
          'Another policy version was created at the same time; retry',
          {
            internalContext: { workflowKey: dto.workflowKey },
          },
        );
      }
      throw error;
    }
  }

  /** DRAFT → PENDING_PLATFORM_APPROVAL, by the organization that wrote it. */
  async submit(policyId: string, dto: PolicyTransitionDto): Promise<PolicyView> {
    const found = await this.policyOrNotFound(this.prisma.client, policyId);
    const { actor, role } = this.access.assertCanSubmitPolicy(found);
    const submitter = storedIdentityOf(currentActor());
    // The hierarchy may have changed since the policy was written.
    await this.assertMayGovern(role, found.authorOrganizationId, found.organizationId);

    await this.prisma.transaction(async (tx) => {
      const at = await transactionNow(tx);
      const policy = await this.policyOrNotFound(tx, policyId);
      this.assertVersion(policy.id, policy.version, dto.expectedVersion);
      assertPolicyTransition(
        policyId,
        policy.status as PolicyStateName,
        'PENDING_PLATFORM_APPROVAL',
      );

      const matched = await this.repository.transitionPolicy(tx, {
        organizationId: policy.organizationId,
        policyId,
        from: 'DRAFT',
        expectedVersion: dto.expectedVersion,
        data: {
          status: 'PENDING_PLATFORM_APPROVAL',
          submittedAt: at,
          submittedBy: actor,
          submittedByIssuer: submitter.issuer,
          submittedBySubject: submitter.subject,
        },
      });
      if (matched === 0) throw this.conflict(policyId);

      await this.events.enqueue(tx, {
        eventName: 'APPROVAL_POLICY_SUBMITTED',
        aggregateId: policyId,
        organizationId: policy.organizationId,
        payload: {
          policyId,
          organizationId: policy.organizationId,
          workflowKey: policy.workflowKey,
          policyVersion: policy.policyVersion,
          submittedBy: actor,
          submittedAt: at.toISOString(),
        },
        occurredAt: at,
      });
    });

    return this.view(policyId);
  }

  /**
   * The platform approval: PENDING_PLATFORM_APPROVAL → ACTIVE, retiring the policy it replaces in
   * the same transaction. A signature already recorded keeps the policy it was made under.
   */
  async approve(policyId: string, dto: PolicyTransitionDto): Promise<PolicyView> {
    const { actor } = this.access.assertPlatformAdministrator();
    const approver = currentActor();
    const found = await this.policyOrNotFound(this.prisma.client, policyId);
    this.assertFourEyes(found, approver);
    await this.assertMayGovern(
      found.authorRole as PolicyAuthorRole,
      found.authorOrganizationId,
      found.organizationId,
    );

    await this.prisma
      .transaction(async (tx) => {
        const at = await transactionNow(tx);
        // Serialise with every signature being recorded on this workflow, and with any other
        // approval or retirement of it (no contract lock is held here, so the one lock order
        // holds). Organization and workflow key never change, so `found` names the slot;
        // everything else is re-read under the lock.
        await this.repository.lockPolicySlot(
          tx,
          found.organizationId,
          found.workflowKey as WorkflowKey,
        );
        const policy = await this.policyOrNotFound(tx, policyId);
        this.assertVersion(policy.id, policy.version, dto.expectedVersion);
        assertPolicyTransition(policyId, policy.status as PolicyStateName, 'ACTIVE');
        this.assertFourEyes(policy, approver);

        const workflowKey = policy.workflowKey as WorkflowKey;
        const current = await this.repository.findActivePolicyOf(
          tx,
          policy.organizationId,
          workflowKey,
        );
        if (current) {
          const retired = await this.repository.transitionPolicy(tx, {
            organizationId: policy.organizationId,
            policyId: current.id,
            from: 'ACTIVE',
            data: { status: 'RETIRED', retiredAt: at, retiredBy: actor },
          });
          if (retired === 0) throw this.conflict(current.id);
        }

        const matched = await this.repository.transitionPolicy(tx, {
          organizationId: policy.organizationId,
          policyId,
          from: 'PENDING_PLATFORM_APPROVAL',
          expectedVersion: dto.expectedVersion,
          data: { status: 'ACTIVE', activatedAt: at, activatedBy: actor },
        });
        if (matched === 0) throw this.conflict(policyId);

        if (current) await this.announceRetired(tx, current, actor, at);
        await this.events.enqueue(tx, {
          eventName: 'APPROVAL_POLICY_ACTIVATED',
          aggregateId: policyId,
          organizationId: policy.organizationId,
          payload: {
            policyId,
            organizationId: policy.organizationId,
            workflowKey,
            policyVersion: policy.policyVersion,
            retiredPolicyId: current?.id ?? null,
            activatedBy: actor,
            activatedAt: at.toISOString(),
          },
          occurredAt: at,
        });
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw this.conflict(policyId);
        throw error;
      });

    return this.view(policyId);
  }

  /** The platform refusal: PENDING_PLATFORM_APPROVAL → REJECTED, with a reason. */
  async reject(policyId: string, dto: PolicyRejectionDto): Promise<PolicyView> {
    const { actor } = this.access.assertPlatformAdministrator();

    await this.prisma.transaction(async (tx) => {
      const at = await transactionNow(tx);
      const policy = await this.policyOrNotFound(tx, policyId);
      this.assertVersion(policy.id, policy.version, dto.expectedVersion);
      assertPolicyTransition(policyId, policy.status as PolicyStateName, 'REJECTED');

      const matched = await this.repository.transitionPolicy(tx, {
        organizationId: policy.organizationId,
        policyId,
        from: 'PENDING_PLATFORM_APPROVAL',
        expectedVersion: dto.expectedVersion,
        data: {
          status: 'REJECTED',
          rejectedAt: at,
          rejectedBy: actor,
          rejectionReason: dto.reason,
        },
      });
      if (matched === 0) throw this.conflict(policyId);

      await this.events.enqueue(tx, {
        eventName: 'APPROVAL_POLICY_REJECTED',
        aggregateId: policyId,
        organizationId: policy.organizationId,
        payload: {
          policyId,
          organizationId: policy.organizationId,
          workflowKey: policy.workflowKey,
          policyVersion: policy.policyVersion,
          rejectedBy: actor,
          rejectedAt: at.toISOString(),
        },
        occurredAt: at,
      });
    });

    return this.view(policyId);
  }

  /**
   * Takes an ACTIVE policy out of force with no replacement. From then on a signature for that
   * employer is refused — no policy never means "anyone may sign" (Q-95 (1)).
   */
  async retire(policyId: string, dto: PolicyTransitionDto): Promise<PolicyView> {
    const found = await this.policyOrNotFound(this.prisma.client, policyId);
    const { actor } = this.access.assertCanRetirePolicy(found);

    await this.prisma.transaction(async (tx) => {
      const at = await transactionNow(tx);
      // Taking a policy out of force is serialised with signatures being recorded under it
      // (PolicyRepository.lockPolicySlot); re-read under the lock.
      await this.repository.lockPolicySlot(
        tx,
        found.organizationId,
        found.workflowKey as WorkflowKey,
      );
      const policy = await this.policyOrNotFound(tx, policyId);
      this.assertVersion(policy.id, policy.version, dto.expectedVersion);
      assertPolicyTransition(policyId, policy.status as PolicyStateName, 'RETIRED');

      const matched = await this.repository.transitionPolicy(tx, {
        organizationId: policy.organizationId,
        policyId,
        from: 'ACTIVE',
        expectedVersion: dto.expectedVersion,
        data: { status: 'RETIRED', retiredAt: at, retiredBy: actor },
      });
      if (matched === 0) throw this.conflict(policyId);
      await this.announceRetired(tx, policy, actor, at);
    });

    return this.view(policyId);
  }

  async get(policyId: string): Promise<PolicyView> {
    const policy = await this.policyOrNotFound(this.prisma.client, policyId);
    this.access.assertCanSeePolicy(policy);
    return toPolicyView(policy);
  }

  /**
   * Whether a stored response naming this policy may still be replayed to the caller: the same
   * rule a fresh read applies now.
   */
  async assertVisible(policyId: string): Promise<void> {
    await this.get(policyId);
  }

  /** Policies the caller's organization is governed by or wrote. */
  async list(query: ListPoliciesQuery): Promise<CursorPage<PolicyView>> {
    const { organizationId } = this.access.assertCanListPolicies();
    // The same rule a read of one policy applies, in the query (review #231 r2): a caller who
    // would be told 404 for a policy is not shown it in a list.
    return this.page(organizationId, this.access.listVisibility(), query);
  }

  /** The platform administrator's queue: every organization's pending policies. */
  async platformQueue(query: ListPoliciesQuery): Promise<CursorPage<PolicyView>> {
    this.access.assertPlatformAdministrator();
    return this.page(null, null, { ...query, status: 'PENDING_PLATFORM_APPROVAL' });
  }

  // -------------------------------------------------------------------------

  /**
   * Whether `author` may make a policy govern `target` (Q-70 (7)): a union for itself or an
   * organization beneath it, the platform for any organization that exists — both answered by
   * organization-service. A refusal names no hierarchy; an unconfirmable answer is an upstream
   * error and refuses too (fail closed).
   */
  private async assertMayGovern(
    role: PolicyAuthorRole,
    authorOrganizationId: string,
    target: string,
  ): Promise<void> {
    const confirmed =
      role === SUPER_ROLE
        ? await this.directory.isWithin(target, target)
        : await this.directory.isWithin(authorOrganizationId, target);
    if (!confirmed) {
      throw RastaError.forbidden(
        role === UNION_ROLE
          ? 'A union writes approval policies only for its own organization or one beneath it'
          : 'Approval policies can be written only for an organization that exists',
      );
    }
  }

  /**
   * Four eyes (Q-70 (7)): the platform administrator who approves is neither the policy's author
   * nor its submitter.
   *
   * `CONTRACT_POLICY_FOUR_EYES` (default on) is **provisional, pending the owner**. Even switched
   * off, it relaxes only one case — a `SYSTEM_ADMIN` approving the policy it wrote itself. A
   * policy a `UNION_ADMIN` wrote is never approved by the person who wrote or submitted it,
   * whatever the flag says: the platform approval exists to check the union, and nobody checks
   * themselves.
   *
   * "Different" is proven on the token's issuer and subject (`compareActors`, #188), not on user
   * ids, which one person can hold two of. An author or submitter whose identity was not recorded
   * cannot be told apart from the approver: where the rule applies, that is `422
   * ACTOR_IDENTITY_UNKNOWN`, never a pass.
   */
  private assertFourEyes(policy: PolicyWithSteps, approver: ActorIdentity): void {
    const people: ActorComparison[] = [
      compareActors(
        storedActor(policy.createdBy, policy.createdByIssuer, policy.createdBySubject),
        approver,
      ),
    ];
    if (policy.submittedBy !== null) {
      people.push(
        compareActors(
          storedActor(policy.submittedBy, policy.submittedByIssuer, policy.submittedBySubject),
          approver,
        ),
      );
    }
    if (people.every((comparison) => comparison === 'DISTINCT')) return;
    const applies = policy.authorRole === UNION_ROLE || this.env.CONTRACT_POLICY_FOUR_EYES;
    if (!applies) return;
    if (!people.includes('SAME')) {
      throw actorIdentityUnknown(
        'the approver of a policy is neither its author nor its submitter',
      );
    }
    if (policy.authorRole === UNION_ROLE) {
      throw RastaError.forbidden(
        'A policy written by a union is approved by a different person, always',
      );
    }
    throw RastaError.forbidden(
      'A different platform administrator must approve this policy (CONTRACT_POLICY_FOUR_EYES)',
    );
  }

  private async announceRetired(
    tx: ExtendedPrismaClient,
    policy: PolicyWithSteps,
    actor: string,
    at: Date,
  ): Promise<void> {
    await this.events.enqueue(tx, {
      eventName: 'APPROVAL_POLICY_RETIRED',
      aggregateId: policy.id,
      organizationId: policy.organizationId,
      payload: {
        policyId: policy.id,
        organizationId: policy.organizationId,
        workflowKey: policy.workflowKey,
        policyVersion: policy.policyVersion,
        retiredBy: actor,
        retiredAt: at.toISOString(),
      },
      occurredAt: at,
    });
  }

  private async page(
    organizationId: string | null,
    visibleTo: Prisma.ApprovalPolicyWhereInput | null,
    query: ListPoliciesQuery,
  ): Promise<CursorPage<PolicyView>> {
    const rows = await this.repository.listPolicies({
      organizationId,
      visibleTo,
      ...(query.workflowKey ? { workflowKey: query.workflowKey } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
    const hasMore = rows.length > query.limit;
    const visible = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items: visible.map(toPolicyView),
      nextCursor: hasMore ? (visible[visible.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  private async policyOrNotFound(
    client: ExtendedPrismaClient,
    policyId: string,
  ): Promise<PolicyWithSteps> {
    const policy = await this.repository.findPolicy(client, policyId);
    if (!policy) throw RastaError.notFound('ApprovalPolicy', policyId);
    return policy;
  }

  private async view(policyId: string): Promise<PolicyView> {
    return toPolicyView(await this.policyOrNotFound(this.prisma.client, policyId));
  }

  private assertVersion(policyId: string, actual: number, expected: number): void {
    if (actual !== expected) throw this.conflict(policyId);
  }

  private conflict(policyId: string): RastaError {
    return RastaError.optimisticLockFailed('ApprovalPolicy', policyId);
  }
}
