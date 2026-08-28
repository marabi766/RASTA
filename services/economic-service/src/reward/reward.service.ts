import { Inject, Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { WalletService } from '../wallet/wallet.service';
import { isUniqueViolation } from '../ledger/ledger.repository';
import {
  applicableRules,
  evaluate,
  isRefusal,
  levelFor,
  periodKeyFor,
  type RewardRuleView,
} from './rule-engine';
import { ECONOMIC_EVENTS } from '../events/events';
import { formatMinor, parseMinor } from '../shared/money';
import { rewardsGrantedTotal, rewardsSkippedTotal } from '../observability/metrics';
import { ENV } from '../tokens';
import { SERVICE_NAME, type EconomicEnv } from '../config/env';
import type { Prisma } from '../generated/prisma';
import type { CreateRewardRuleDto, UpdateRewardRuleDto } from './dto';

/**
 * Rewards (docs/10 § 10.8, ADR-033).
 *
 * ## Points always; rial only when configured
 *
 * Every rule grants points. A rule grants *money* only when
 * `creditPerPointMinor` is set, and there is no default — the share of
 * commission that funds rewards is docs/24 Q-09 and still open. A points-only
 * reward posts **no journal**: a zero-amount ledger entry would break
 * `ck_ledger_entry_amount_positive` and would assert nothing anyway.
 *
 * ## The cap is enforced under a lock, not before one
 *
 * docs/10 § 10.12 requires that `periodCap` hold "even with parallel events".
 * A count taken before the write is a read-modify-write: two concurrent
 * triggers both see room and both grant. So every grant for a subject takes a
 * row lock on that subject's `reward_balance` first, which serialises grants
 * per subject and makes the count still true when it is acted on.
 *
 * ## A reward needs a person
 *
 * `Reward.userId` is not nullable. A trigger with no user actor grants nothing
 * and is counted in `rasta_economic_rewards_skipped_total{reason="no_actor"}`,
 * because the reward model in docs/10 § 10.8 is about rewarding *behaviour* —
 * and a level nobody holds is not an incentive. The event catalogue agrees:
 * `REWARD_GRANTED` carries `userId`.
 */
@Injectable()
export class RewardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly wallets: WalletService,
    @Inject(ENV) private readonly env: EconomicEnv,
  ) {}

  // ==========================================================================
  // Granting
  // ==========================================================================

  /**
   * Evaluates every rule for a trigger and grants what they say.
   *
   * Runs in its own transaction, **never inside a settlement's**. docs/10 §
   * 10.10 is explicit: if the reward step fails, the settlement stays valid
   * and the reward is retried separately — a reward must never roll back a
   * settlement. Keeping the transactions separate is what makes that true
   * structurally rather than by convention.
   */
  async grantFor(input: {
    organizationId: string;
    userId: string | null;
    triggerEvent: string;
    sourceReference: string;
    occurredAt: Date;
    payload: Record<string, unknown>;
  }): Promise<GrantOutcome[]> {
    if (!input.userId) {
      rewardsSkippedTotal.inc({ service: SERVICE_NAME, reason: 'no_actor' });
      return [];
    }

    const rules = await this.candidateRules(input.organizationId, input.triggerEvent);
    const applicable = applicableRules(
      rules as RewardRuleView[],
      input.organizationId,
      input.triggerEvent,
      input.occurredAt,
    );

    if (applicable.length === 0) {
      rewardsSkippedTotal.inc({ service: SERVICE_NAME, reason: 'no_rule' });
      return [];
    }

    const outcomes: GrantOutcome[] = [];
    for (const rule of applicable) {
      outcomes.push(await this.grantOne({ ...input, userId: input.userId, rule }));
    }
    return outcomes;
  }

  /**
   * One rule, one triggering fact, one transaction.
   *
   * Per rule rather than all rules in one transaction, so a cap reached on one
   * campaign does not roll back a grant from another. Each grant is
   * independently idempotent on `(ruleId, sourceReference)`.
   */
  private async grantOne(input: {
    organizationId: string;
    userId: string;
    rule: RewardRuleView;
    triggerEvent: string;
    sourceReference: string;
    occurredAt: Date;
    payload: Record<string, unknown>;
  }): Promise<GrantOutcome> {
    const { rule } = input;

    if (rule.rewardType === 'CASHBACK' && !this.env.ECONOMIC_REWARD_CASHBACK_ENABLED) {
      // Refused rather than silently skipped. A rule that exists, is ACTIVE,
      // and quietly does nothing is a control claiming something it does not
      // have (docs/24 Q-07).
      rewardsSkippedTotal.inc({ service: SERVICE_NAME, reason: 'cashback_disabled' });
      return { kind: 'SKIPPED', reason: 'cashback_disabled', ruleId: rule.id };
    }

    try {
      return await this.prisma.transaction(async (tx) => {
        await this.ensureBalanceRow(tx, input.organizationId, input.userId);
        const balance = await this.lockBalance(tx, input.organizationId, input.userId);

        const periodKey = periodKeyFor(rule.periodType, input.occurredAt);
        const alreadyGranted = await this.pointsInPeriod(
          tx,
          input.organizationId,
          input.userId,
          rule.id,
          periodKey,
        );

        const decision = evaluate(rule, input.payload, input.occurredAt, alreadyGranted);
        if (isRefusal(decision)) {
          rewardsSkippedTotal.inc({ service: SERVICE_NAME, reason: decision.reason });
          return { kind: 'SKIPPED', reason: decision.reason, ruleId: rule.id } as GrantOutcome;
        }

        const rewardId = `${ID_PREFIXES.reward}_${ulid()}`;
        const grantedAt = new Date();

        // The monetised half: credit the organization's wallet against the
        // platform's reward expense account, exactly as docs/10 § 10.4's third
        // example does. A reward is a real recorded cost, not a display number.
        let journalId: string | null = null;
        if (decision.monetised) {
          const wallet = await this.wallets.resolveCounterpartyWallet(
            tx,
            input.organizationId,
            'IRR',
          );
          const credited = await this.wallets.credit(tx, {
            wallet,
            amountMinor: decision.creditAmountMinor,
            counterpartPurpose: 'REWARD_EXPENSE',
            journalType: 'REWARD_GRANT',
            description: `Reward ${rewardId} for ${input.triggerEvent}`,
            postedBy: SERVICE_NAME,
          });
          journalId = credited.journalId;
        }

        await runUnscoped('a reward is granted from an event whose tenant is on the envelope', () =>
          tx.reward.create({
            data: {
              id: rewardId,
              organizationId: input.organizationId,
              userId: input.userId,
              ruleId: rule.id,
              triggerEvent: input.triggerEvent,
              sourceReference: input.sourceReference,
              points: decision.points,
              creditAmountMinor: decision.creditAmountMinor,
              currency: 'IRR',
              monetised: decision.monetised,
              journalId,
              periodKey,
              grantedAt,
            },
          }),
        );

        const totalPoints = balance.totalPoints + decision.points;
        const levelChange = await this.applyLevel(
          tx,
          input.organizationId,
          input.userId,
          totalPoints,
          balance.levelId,
          decision.creditAmountMinor,
          grantedAt,
        );

        await this.ledger.enqueue(tx, {
          eventName: ECONOMIC_EVENTS.REWARD_GRANTED,
          aggregateId: rewardId,
          organizationId: input.organizationId,
          payload: {
            rewardId,
            organizationId: input.organizationId,
            userId: input.userId,
            ruleId: rule.id,
            triggerEvent: input.triggerEvent,
            sourceReference: input.sourceReference,
            points: decision.points,
            creditAmountMinor: formatMinor(decision.creditAmountMinor),
            currency: 'IRR',
            monetised: decision.monetised,
            journalId,
            grantedAt: grantedAt.toISOString(),
          },
        });

        rewardsGrantedTotal.inc({
          service: SERVICE_NAME,
          trigger: input.triggerEvent,
          monetised: String(decision.monetised),
        });

        return {
          kind: 'GRANTED',
          rewardId,
          ruleId: rule.id,
          points: decision.points,
          creditAmountMinor: decision.creditAmountMinor,
          monetised: decision.monetised,
          levelChangedTo: levelChange,
        } as GrantOutcome;
      });
    } catch (error) {
      // `(rule_id, source_reference)` is unique: a replayed event, or a second
      // consumer instance, cannot grant twice. That is the anti-fraud control
      // in docs/10 § 10.9 as much as it is idempotency.
      if (isUniqueViolation(error)) {
        rewardsSkippedTotal.inc({ service: SERVICE_NAME, reason: 'duplicate' });
        return { kind: 'SKIPPED', reason: 'duplicate', ruleId: rule.id };
      }
      throw error;
    }
  }

  /**
   * Creates the balance row if it is missing, without failing on a race.
   *
   * `ON CONFLICT DO NOTHING` rather than an upsert, because the only purpose is
   * to guarantee a row exists to lock: two concurrent first grants for the same
   * subject must both proceed to the lock, and exactly one of them creates it.
   */
  private ensureBalanceRow(tx: ExtendedPrismaClient, organizationId: string, userId: string) {
    return runUnscoped(
      'a reward balance is created for the event tenant, not the reader',
      () =>
        tx.$executeRaw`
        INSERT INTO reward_balance (organization_id, user_id, total_points, lifetime_credit_minor, updated_at)
        VALUES (${organizationId}, ${userId}, 0, 0, now())
        ON CONFLICT (organization_id, user_id) DO NOTHING
      `,
    );
  }

  /**
   * Locks a subject's balance row.
   *
   * **This is the cap control.** Grants for one subject serialise here, so the
   * "how many points already this period" count below is still true when the
   * grant is written — which is what makes `periodCap` hold under parallel
   * events (docs/10 § 10.12).
   */
  private async lockBalance(
    tx: ExtendedPrismaClient,
    organizationId: string,
    userId: string,
  ): Promise<{ totalPoints: number; levelId: string | null }> {
    const rows = await runUnscoped(
      'the reward cap is enforced by locking the subject balance row',
      () =>
        tx.$queryRaw<{ totalPoints: number; levelId: string | null }[]>`
          SELECT total_points AS "totalPoints", level_id AS "levelId"
            FROM reward_balance
           WHERE organization_id = ${organizationId} AND user_id = ${userId}
             FOR UPDATE
        `,
    );
    const row = rows[0];
    if (!row) throw RastaError.internal('Reward balance row vanished while locking it');
    return row;
  }

  private async pointsInPeriod(
    tx: ExtendedPrismaClient,
    organizationId: string,
    userId: string,
    ruleId: string,
    periodKey: string,
  ): Promise<number> {
    const result = await runUnscoped('the cap count runs under the balance row lock', () =>
      tx.reward.aggregate({
        where: { organizationId, userId, ruleId, periodKey },
        _sum: { points: true },
      }),
    );
    return result._sum.points ?? 0;
  }

  /**
   * Updates the running total and, if a threshold was crossed, the level.
   *
   * Publishes `REWARD_LEVEL_CHANGED` only on an actual change. A level that has
   * not moved is not news, and notification-service would turn every reward
   * into a message.
   */
  private async applyLevel(
    tx: ExtendedPrismaClient,
    organizationId: string,
    userId: string,
    totalPoints: number,
    previousLevelId: string | null,
    creditDeltaMinor: bigint,
    at: Date,
  ): Promise<string | null> {
    const levels = await runUnscoped(
      'reward levels are platform-wide or organization-specific; the OR below is the scope',
      () =>
        tx.rewardLevel.findMany({
          where: { status: 'ACTIVE', OR: [{ organizationId: null }, { organizationId }] },
        }),
    );

    const level = levelFor(levels, totalPoints);

    await runUnscoped('the reward balance belongs to the event tenant, not the reader', () =>
      tx.rewardBalance.update({
        where: { organizationId_userId: { organizationId, userId } },
        data: {
          totalPoints,
          levelId: level?.id ?? previousLevelId ?? null,
          lifetimeCreditMinor: { increment: creditDeltaMinor },
        },
      }),
    );

    if (!level || level.id === previousLevelId) return null;

    const previous = levels.find((candidate) => candidate.id === previousLevelId) ?? null;

    await this.ledger.enqueue(tx, {
      eventName: ECONOMIC_EVENTS.REWARD_LEVEL_CHANGED,
      aggregateId: `${organizationId}:${userId}`,
      organizationId,
      payload: {
        organizationId,
        userId,
        from: previous?.name ?? null,
        to: level.name,
        totalPoints,
        changedAt: at.toISOString(),
      },
    });

    return level.name;
  }

  private candidateRules(organizationId: string, triggerEvent: string) {
    return runUnscoped(
      'reward rules are platform-wide or organization-specific; the OR below is the scope',
      () =>
        this.prisma.client.rewardRule.findMany({
          where: {
            triggerEvent,
            status: 'ACTIVE',
            OR: [{ organizationId: null }, { organizationId }],
          },
        }),
    );
  }

  // ==========================================================================
  // Configuration
  // ==========================================================================

  async createRule(dto: CreateRewardRuleDto) {
    const actor = getContext().userId ?? SERVICE_NAME;

    if (dto.rewardType === 'CASHBACK' && !this.env.ECONOMIC_REWARD_CASHBACK_ENABLED) {
      throw RastaError.businessRule(
        'Cashback rewards are disabled: the product document conditions them on a regulatory ' +
          'review that has not concluded (docs/24 Q-07)',
      );
    }

    const data: Prisma.RewardRuleUncheckedCreateInput = {
      id: `RWR_${ulid()}`,
      organizationId: dto.organizationId ?? null,
      triggerEvent: dto.triggerEvent,
      rewardType: dto.rewardType ?? 'POINTS',
      condition: (dto.condition ?? null) as Prisma.InputJsonValue,
      points: dto.points,
      creditPerPointMinor: dto.creditPerPointMinor
        ? parseMinor(dto.creditPerPointMinor, 'creditPerPointMinor')
        : null,
      periodCap: dto.periodCap ?? null,
      periodType: dto.periodType ?? null,
      validFrom: dto.validFrom ? new Date(dto.validFrom) : new Date(),
      validTo: dto.validTo ? new Date(dto.validTo) : null,
      status: dto.status ?? 'ACTIVE',
      label: dto.label ?? null,
      createdBy: actor,
      updatedBy: actor,
    };

    return runUnscoped(
      'a reward rule may be platform-wide, which no tenant scope can express',
      () => this.prisma.client.rewardRule.create({ data }),
    );
  }

  async updateRule(id: string, dto: UpdateRewardRuleDto) {
    const actor = getContext().userId ?? SERVICE_NAME;

    const existing = await runUnscoped('reward rules may be platform-wide', () =>
      this.prisma.client.rewardRule.findUnique({ where: { id } }),
    );
    if (!existing) throw RastaError.notFound('RewardRule', id);

    return runUnscoped('reward rules may be platform-wide', () =>
      this.prisma.client.rewardRule.update({
        where: { id },
        data: {
          ...(dto.points !== undefined ? { points: dto.points } : {}),
          ...(dto.creditPerPointMinor !== undefined
            ? {
                creditPerPointMinor: dto.creditPerPointMinor
                  ? parseMinor(dto.creditPerPointMinor, 'creditPerPointMinor')
                  : null,
              }
            : {}),
          ...(dto.periodCap !== undefined ? { periodCap: dto.periodCap } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.validTo !== undefined
            ? { validTo: dto.validTo ? new Date(dto.validTo) : null }
            : {}),
          ...(dto.label !== undefined ? { label: dto.label } : {}),
          updatedBy: actor,
        },
      }),
    );
  }

  listRules(triggerEvent?: string) {
    const organizationId = getOrganizationId();
    return runUnscoped(
      'a tenant sees platform-wide rules and its own; the OR below is the scope',
      () =>
        this.prisma.client.rewardRule.findMany({
          where: {
            ...(triggerEvent ? { triggerEvent } : {}),
            OR: [{ organizationId: null }, { organizationId }],
          },
          orderBy: [{ triggerEvent: 'asc' }, { validFrom: 'desc' }],
        }),
    );
  }

  // ==========================================================================
  // Reads
  // ==========================================================================

  /**
   * `GET /v1/rewards/me` — the caller's own points, level and recent grants.
   *
   * Scoped to the authenticated user within the active organization. There is
   * no endpoint that reads another user's reward standing: it is behavioural
   * data about a person, and nothing in the product document asks for it to be
   * visible to anyone else.
   */
  async myRewards(limit: number) {
    const organizationId = getOrganizationId();
    const userId = getContext().userId;
    if (!userId) {
      throw RastaError.forbidden('This request has no user identity to read rewards for');
    }

    const balance = await this.prisma.client.rewardBalance.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      include: { level: true },
    });

    const rewards = await this.prisma.client.reward.findMany({
      where: { organizationId, userId },
      orderBy: [{ grantedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });

    return { balance, rewards };
  }
}

export type GrantOutcome =
  | {
      kind: 'GRANTED';
      rewardId: string;
      ruleId: string;
      points: number;
      creditAmountMinor: bigint;
      monetised: boolean;
      levelChangedTo: string | null;
    }
  | { kind: 'SKIPPED'; reason: string; ruleId: string };
