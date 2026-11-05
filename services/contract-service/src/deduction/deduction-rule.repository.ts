import { Injectable } from '@nestjs/common';
import {
  RastaError,
  actorIdentityUnknown,
  assertDistinctActors,
  compareActors,
  runUnscoped,
  type ActorIdentity,
} from '@rasta/nest-common';
import { ulid } from 'ulid';
import type { DeductionRule, DeductionRuleChange } from '../generated/prisma';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { isUniqueViolation } from '../shared/prisma-errors';
import { storedActor } from '../shared/stable-actor';
import {
  assertDeductionChangeTransition,
  type DeductionChangeState,
} from './deduction-rule-change.state-machine';
import { canonicalDeductionRuleName } from './deduction-rule-name';

/**
 * Proposed changes to an employer's deduction rules, and their effect on the rules in force
 * (CON-003-1, docs/24 Q-125, D-115).
 *
 * Every method runs in the caller's transaction, so the outbox event of the same move (CON-003-2)
 * commits with it. A refusal throws, which rolls that transaction back.
 *
 * ## Where the tenant guard is crossed
 *
 * The employer proposes and a platform administrator with no selected organization decides (D-115),
 * so these queries cross the guard under `runUnscoped`, and **every one names the organization in
 * its own predicate**. Who may act is the route's check (CON-003-2), made first. This layer holds
 * what is true for anyone: the person who decides is provably not the one who proposed, and the
 * database refuses the rest whatever this code does.
 */
const UNSCOPED_REASON =
  'deduction rule changes are proposed by the employer and decided by the platform (Q-125, D-115); each query names the organization';

/** Who a stale form or a lost race is told about: the state it saw is no longer the state. */
const CHANGE_RESOURCE = 'DeductionRuleChange';

export interface ProposeCreateInput {
  readonly organizationId: string;
  readonly name: string;
  readonly rateBp: number;
  readonly base: 'GROSS';
  readonly proposer: ActorIdentity;
  readonly at: Date;
}

export interface ProposeRetireInput {
  readonly organizationId: string;
  readonly deductionRuleId: string;
  readonly reason: string;
  readonly proposer: ActorIdentity;
  readonly at: Date;
}

/** One person acting on one change, as of the version they saw. */
export interface ChangeActInput {
  readonly organizationId: string;
  readonly changeId: string;
  readonly expectedVersion: number;
  readonly actor: ActorIdentity;
  readonly at: Date;
}

export interface ApprovedChange {
  readonly change: DeductionRuleChange;
  /** The rule this approval put in force, or took out of it. */
  readonly rule: DeductionRule;
}

@Injectable()
export class DeductionRuleRepository {
  async findChange(
    client: ExtendedPrismaClient,
    organizationId: string,
    changeId: string,
  ): Promise<DeductionRuleChange | null> {
    assertOrganizationNamed(organizationId);
    return runUnscoped(UNSCOPED_REASON, () =>
      client.deductionRuleChange.findFirst({ where: { organizationId, id: changeId } }),
    );
  }

  /**
   * Stores the name in its one form (`deduction-rule-name.ts`). `400` if it has none; `409` if a
   * CREATE of this name is already pending for this organization.
   */
  async proposeCreate(
    tx: ExtendedPrismaClient,
    input: ProposeCreateInput,
  ): Promise<DeductionRuleChange> {
    const name = canonicalDeductionRuleName(input.name);
    if (name === null) {
      throw RastaError.validation([
        {
          path: 'name',
          code: 'not_canonical',
          message:
            'A deduction rule name is 1 to 200 Persian or printable ASCII characters, with no invisible characters',
        },
      ]);
    }
    return this.insertProposal(tx, input.proposer, name, {
      organizationId: input.organizationId,
      kind: 'CREATE',
      name,
      rateBp: input.rateBp,
      base: input.base,
      proposedAt: input.at,
    });
  }

  /**
   * `404` if the rule is not this organization's or is no longer in force, the same answer for
   * either, so another employer's rule cannot be told from one that does not exist. `409` if a
   * RETIRE of it is already pending.
   */
  async proposeRetire(
    tx: ExtendedPrismaClient,
    input: ProposeRetireInput,
  ): Promise<DeductionRuleChange> {
    return this.insertProposal(tx, input.proposer, input.deductionRuleId, {
      organizationId: input.organizationId,
      kind: 'RETIRE',
      deductionRuleId: input.deductionRuleId,
      reason: input.reason,
      proposedAt: input.at,
    });
  }

  /**
   * Decides the change and applies it, in the caller's transaction: CREATE inserts the one rule it
   * says, RETIRE retires its rule. Of two approvals racing, the row lock lets one through and the
   * other finds the version moved: `409`, and no second effect.
   */
  async approve(tx: ExtendedPrismaClient, input: ChangeActInput): Promise<ApprovedChange> {
    const change = await this.decide(tx, input, 'APPROVED', { by: 'ANOTHER_PERSON' });
    const rule =
      change.kind === 'CREATE'
        ? await this.insertRule(tx, change, input.at)
        : await this.retireRule(tx, change, input.at);
    return { change, rule };
  }

  /** Only someone other than the proposer rejects a change: a proposer changing their mind withdraws. */
  reject(
    tx: ExtendedPrismaClient,
    input: ChangeActInput & { readonly reason: string },
  ): Promise<DeductionRuleChange> {
    return this.decide(tx, input, 'REJECTED', {
      by: 'ANOTHER_PERSON',
      decisionReason: input.reason,
    });
  }

  /** Only the proposer withdraws: anyone else ending a proposal rejects it, and says why. */
  withdraw(tx: ExtendedPrismaClient, input: ChangeActInput): Promise<DeductionRuleChange> {
    return this.decide(tx, input, 'WITHDRAWN', { by: 'THE_PROPOSER' });
  }

  private async insertProposal(
    tx: ExtendedPrismaClient,
    proposer: ActorIdentity,
    pendingOn: string,
    data: {
      organizationId: string;
      kind: 'CREATE' | 'RETIRE';
      name?: string;
      rateBp?: number;
      base?: string;
      deductionRuleId?: string;
      reason?: string;
      proposedAt: Date;
    },
  ): Promise<DeductionRuleChange> {
    assertOrganizationNamed(data.organizationId);
    const person = provenPerson(proposer, 'the proposer of a deduction rule change is recorded');
    try {
      return await runUnscoped(UNSCOPED_REASON, () =>
        tx.deductionRuleChange.create({
          data: {
            ...data,
            id: `DRC_${ulid()}`,
            proposedBy: person.userId,
            proposedByIssuer: person.issuer,
            proposedBySubject: person.subject,
          },
        }),
      );
    } catch (error) {
      // The trigger's answer, including for a rule retired by an approval it waited for.
      if (messageNames(error, 'ck_deduction_rule_change_rule_in_force')) {
        throw RastaError.notFound('DeductionRule', pendingOn);
      }
      if (isUniqueViolation(error)) throw RastaError.alreadyExists(CHANGE_RESOURCE, pendingOn);
      throw error;
    }
  }

  /** One legal move, as of the version the actor saw. Nothing is written if any check refuses. */
  private async decide(
    tx: ExtendedPrismaClient,
    input: ChangeActInput,
    to: DeductionChangeState,
    rule: { by: 'ANOTHER_PERSON' | 'THE_PROPOSER'; decisionReason?: string },
  ): Promise<DeductionRuleChange> {
    const { organizationId, changeId, expectedVersion, at } = input;
    const change = await this.findChange(tx, organizationId, changeId);
    if (change === null) throw RastaError.notFound(CHANGE_RESOURCE, changeId);
    assertDeductionChangeTransition(changeId, change.status, to);

    const person = provenPerson(input.actor, 'who decides a deduction rule change is recorded');
    const proposer = storedActor(
      change.proposedBy,
      change.proposedByIssuer,
      change.proposedBySubject,
    );
    if (rule.by === 'ANOTHER_PERSON') {
      assertDistinctActors(
        proposer,
        person,
        'the person who decides a deduction rule change is not the one who proposed it',
      );
    } else if (compareActors(proposer, person) !== 'SAME') {
      throw RastaError.forbidden(
        'Only the person who proposed a deduction rule change withdraws it',
      );
    }

    const moved = await runUnscoped(UNSCOPED_REASON, () =>
      tx.deductionRuleChange.updateManyAndReturn({
        where: {
          organizationId,
          id: changeId,
          status: 'PENDING_APPROVAL',
          version: expectedVersion,
        },
        data: {
          status: to,
          decidedAt: at,
          decidedBy: person.userId,
          decidedByIssuer: person.issuer,
          decidedBySubject: person.subject,
          decisionReason: rule.decisionReason ?? null,
          version: { increment: 1 },
        },
      }),
    );
    const [decided] = moved;
    if (decided === undefined) throw RastaError.optimisticLockFailed(CHANGE_RESOURCE, changeId);
    return decided;
  }

  private async insertRule(
    tx: ExtendedPrismaClient,
    change: DeductionRuleChange,
    at: Date,
  ): Promise<DeductionRule> {
    const { organizationId, name, rateBp, base } = change;
    if (name === null || rateBp === null || base === null) {
      // `ck_deduction_rule_change_kind` makes this unreachable; refused rather than assumed.
      throw RastaError.internal('A CREATE change without what it creates');
    }
    try {
      return await runUnscoped(UNSCOPED_REASON, () =>
        tx.deductionRule.create({
          data: {
            id: `DDR_${ulid()}`,
            organizationId,
            name,
            rateBp,
            base,
            createdAt: at,
            createdBy: change.proposedBy,
            approvedChangeId: change.id,
          },
        }),
      );
    } catch (error) {
      // `ux_deduction_rule_name_active`: retire the rule of this name first.
      if (isUniqueViolation(error)) throw RastaError.alreadyExists('DeductionRule', name);
      throw error;
    }
  }

  private async retireRule(
    tx: ExtendedPrismaClient,
    change: DeductionRuleChange,
    at: Date,
  ): Promise<DeductionRule> {
    const { organizationId, deductionRuleId } = change;
    if (deductionRuleId === null) {
      // `ck_deduction_rule_change_kind` makes this unreachable; refused rather than assumed.
      throw RastaError.internal('A RETIRE change without its rule');
    }
    const [retired] = await runUnscoped(UNSCOPED_REASON, () =>
      tx.deductionRule.updateManyAndReturn({
        where: { organizationId, id: deductionRuleId, retiredAt: null },
        data: { retiredAt: at },
      }),
    );
    if (retired === undefined)
      throw RastaError.optimisticLockFailed('DeductionRule', deductionRuleId);
    return retired;
  }
}

/**
 * Under `runUnscoped` the tenant guard is lifted and Prisma drops an undefined predicate, so a
 * platform administrator with no selected organization reaching here unnamed would read across
 * tenants. The type says this cannot happen; the type is not what protects the data.
 */
function assertOrganizationNamed(organizationId: string): void {
  if (typeof organizationId !== 'string' || organizationId.trim() === '') {
    throw RastaError.internal('A deduction rule query without its organization');
  }
}

function messageNames(error: unknown, constraint: string): boolean {
  return error instanceof Error && error.message.includes(constraint);
}

/**
 * A person this table can compare later: the database requires all three, and blank by the same
 * `trim` `compareActors` reads as absent.
 */
function provenPerson(
  actor: ActorIdentity,
  what: string,
): { userId: string; issuer: string; subject: string } {
  const { userId, issuer, subject } = actor;
  if (
    issuer === null ||
    subject === null ||
    [userId, issuer, subject].some((v) => v.trim() === '')
  ) {
    throw actorIdentityUnknown(what);
  }
  return { userId, issuer, subject };
}
