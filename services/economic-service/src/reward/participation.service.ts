import { Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { ECONOMIC_EVENTS } from '../events/events';
import { SERVICE_NAME } from '../config/env';
import type { Prisma } from '../generated/prisma';
import type { IdempotentAnswer } from '../shared/idempotency';
import {
  parseContributions,
  participationWindow,
  scoreParticipation,
  type ParticipationBreakdown,
  type ParticipationFactRow,
  type ParticipationRuleView,
} from './participation';
import type { CreateParticipationRuleDto } from './dto';

/**
 * The participation score: its rule versions and the caller's breakdown
 * (ADR-047 § 1, COM-012). The arithmetic is `participation.ts`; this class
 * reads the facts and the rule and records new versions.
 *
 * ## Whose facts
 *
 * The reward consumer's evaluation rows, which say whose behaviour each
 * confirmed fact was (`subject_user_id`, from the owner's `recordedBy` or
 * `completedBy`, never the envelope) and when it happened. A fact the owner
 * did not confirm never has a row, so it cannot count (ADR-061 § 4).
 *
 * ## One rule, platform-wide, the latest version
 *
 * The rule in force is the highest version. Versions are created, never
 * edited, and each is in force from the instant it is created: no backdating,
 * no scheduling ahead. A score is the current version applied to the current
 * window, so changing the rule changes how the window is read and says so —
 * the breakdown names the version.
 */
@Injectable()
export class ParticipationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * `GET /v1/rewards/me/participation` — the caller's own score and its
   * explanation, in the active organization.
   *
   * There is no way to name another person: the subject is the token's user,
   * and the organization is the request's. A user who belongs to two
   * organizations has two scores, each counting only that organization's
   * facts.
   */
  async myParticipation(limit: number): Promise<{
    organizationId: string;
    userId: string;
    breakdown: ParticipationBreakdown;
  }> {
    const organizationId = getOrganizationId();
    const userId = getContext().userId;
    if (!userId) {
      throw RastaError.forbidden('This request has no user identity to read participation for');
    }

    // One snapshot, so the counts and the recent facts describe the same
    // window under the same rule.
    const breakdown = await this.prisma.client.$transaction(
      async (client) => {
        const tx = client as ExtendedPrismaClient;
        const asOf = await databaseNow(tx);
        const rule = await this.ruleInForce(tx);
        if (!rule)
          return scoreParticipation({ rule, asOf, factCounts: new Map(), recentFacts: [] });

        const { from, to } = participationWindow(rule, asOf);
        const events = rule.contributions.map((contribution) => contribution.triggerEvent);

        const counts = await tx.$queryRaw<{ triggerEvent: string; facts: number }[]>`
          SELECT trigger_event AS "triggerEvent", count(*)::int AS "facts"
            FROM reward_source_evaluation
           WHERE organization_id = ${organizationId}
             AND subject_user_id = ${userId}
             AND occurred_at > ${from} AND occurred_at <= ${to}
             AND trigger_event = ANY(${events}::text[])
           GROUP BY trigger_event
        `;

        // Each fact's place among its kind in the window decides whether it
        // counted, so the ordinal is taken over the whole window before the
        // most recent few are kept.
        const recentFacts = await tx.$queryRaw<ParticipationFactRow[]>`
          SELECT "triggerEvent", "sourceReference", "occurredAt", "ordinal"::int AS "ordinal"
            FROM (
              SELECT trigger_event AS "triggerEvent", source_reference AS "sourceReference",
                     occurred_at AS "occurredAt",
                     row_number() OVER (PARTITION BY trigger_event
                                        ORDER BY occurred_at, source_reference) AS "ordinal"
                FROM reward_source_evaluation
               WHERE organization_id = ${organizationId}
                 AND subject_user_id = ${userId}
                 AND occurred_at > ${from} AND occurred_at <= ${to}
                 AND trigger_event = ANY(${events}::text[])
            ) AS window_facts
           ORDER BY "occurredAt" DESC, "sourceReference" DESC
           LIMIT ${limit}
        `;

        return scoreParticipation({
          rule,
          asOf,
          factCounts: new Map(counts.map((row) => [row.triggerEvent, row.facts])),
          recentFacts,
        });
      },
      { isolationLevel: 'RepeatableRead' },
    );

    return { organizationId, userId, breakdown };
  }

  /**
   * A new rule version, in force from now, recorded with who created it
   * (`PARTICIPATION_RULE_CHANGED`) and answered for its `Idempotency-Key`
   * (`answer`), all in one transaction.
   *
   * Versions are numbered under a transaction-scoped advisory lock, so two
   * administrators creating one at once never collide on a number, and the
   * event's `before` is the version actually replaced. The lock serialises;
   * it does not decide. What decides is `expectedCurrentVersion`, read under
   * the lock: a request made against a version that is no longer the latest is
   * refused, so of two administrators who both saw version N only the first
   * replaces it (review of #328, r1).
   */
  async createRule(
    dto: CreateParticipationRuleDto,
    answer: IdempotentAnswer<ParticipationRuleRow>,
  ): Promise<ParticipationRuleRow> {
    const actor = getContext().userId ?? SERVICE_NAME;

    return this.prisma.transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PARTICIPATION_RULE_LOCK_KEY})`;
      const previous = await this.ruleInForce(tx);
      assertReplacing(previous?.version ?? 0, dto.expectedCurrentVersion);

      const created = await tx.participationRule.create({
        data: {
          id: `PRL_${ulid()}`,
          version: (previous?.version ?? 0) + 1,
          windowDays: dto.windowDays,
          contributions: dto.contributions.map((contribution) => ({
            triggerEvent: contribution.triggerEvent,
            weight: contribution.weight,
            maxPerWindow: contribution.maxPerWindow ?? null,
          })) as Prisma.InputJsonValue,
          label: dto.label ?? null,
          createdBy: actor,
        },
      });

      await this.ledger.enqueue(tx, {
        eventName: ECONOMIC_EVENTS.PARTICIPATION_RULE_CHANGED,
        aggregateId: created.id,
        // A platform-wide rule has no tenant of its own: the envelope names
        // the organization the administrator acted from, as for a
        // platform-wide reward rule.
        organizationId: getOrganizationId(),
        payload: {
          ruleId: created.id,
          change: 'CREATED',
          changedBy: actor,
          changedAt: created.createdAt.toISOString(),
          before: previous ? ruleTerms(previous) : null,
          after: ruleTerms(toRuleView(created)),
        },
      });

      // With the version and its event: a retry whose first response was lost
      // replays this version, never creates another.
      await answer.respond(tx, created);
      return created;
    });
  }

  /** Every version, newest first. Platform-wide, so the same for every tenant. */
  async listRules() {
    return this.prisma.client.participationRule.findMany({ orderBy: { version: 'desc' } });
  }

  private async ruleInForce(tx: ExtendedPrismaClient): Promise<ParticipationRuleView | null> {
    const row = await tx.participationRule.findFirst({ orderBy: { version: 'desc' } });
    return row ? toRuleView(row) : null;
  }
}

/**
 * The key the version numbering serialises on. Any fixed bigint will do; this
 * one is `participation_rule` in ASCII, so it is recognisable in `pg_locks`.
 */
export const PARTICIPATION_RULE_LOCK_KEY = BigInt('0x7061727469636970');

type ParticipationRuleRow = Prisma.ParticipationRuleGetPayload<Record<string, never>>;

/**
 * Refuses a new version decided against one that is no longer in force — the
 * platform's stale-precondition answer, `409 OPTIMISTIC_LOCK_FAILED`, with
 * nothing written. Exported for the recognition rule, which is versioned the
 * same way.
 */
export function assertReplacing(current: number, expected: number): void {
  if (current !== expected) {
    throw new RastaError(
      'OPTIMISTIC_LOCK_FAILED',
      'Another version was created since; read the versions again and decide against the latest',
      { internalContext: { current, expected } },
    );
  }
}

export function toRuleView(row: ParticipationRuleRow): ParticipationRuleView {
  return {
    id: row.id,
    version: row.version,
    windowDays: row.windowDays,
    contributions: parseContributions(row.contributions),
    label: row.label,
    createdAt: row.createdAt,
  };
}

function ruleTerms(rule: ParticipationRuleView) {
  return {
    version: rule.version,
    windowDays: rule.windowDays,
    contributions: rule.contributions.map((contribution) => ({ ...contribution })),
    label: rule.label,
  };
}

/** The instant a score is taken at: the database's, as every other window here. */
async function databaseNow(tx: ExtendedPrismaClient): Promise<Date> {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  if (!row) throw RastaError.internal('The database returned no clock reading');
  return row.now;
}
