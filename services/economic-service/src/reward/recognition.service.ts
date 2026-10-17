import { Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { ECONOMIC_EVENTS } from '../events/events';
import { SERVICE_NAME } from '../config/env';
import type { Prisma } from '../generated/prisma';
import { ParticipationService, databaseNow } from './participation.service';
import {
  parseRecognitionTerms,
  recognise,
  type Recognition,
  type RecognitionBasisValue,
  type RecognitionRuleView,
} from './recognition';
import type { CreateRecognitionRuleDto } from './dto';

/**
 * Levels and badges: their versions and what the caller holds (COM-012
 * criterion 2, ADR-047 § 1). The arithmetic is `recognition.ts`; this class
 * reads the version in force and the caller's basis value, and records new
 * versions.
 *
 * ## One configuration, platform-wide, the latest version
 *
 * As the participation rule (docs/24 Q-139): the version in force is the
 * highest, created never edited, in force from the instant it is created for
 * every organization. A person's standing is that version read on their
 * current basis value in the active organization; nothing per person is
 * stored, so a new version re-reads everyone at once and says which version
 * it is.
 *
 * ## Who sees it
 *
 * The person, and nobody else (docs/24 Q-30's temporary decision: no public
 * ranking, no other person's detail). There is no route naming a user, and no
 * list of who holds what. Administrators see the versions — the thresholds and
 * names — not people.
 */
@Injectable()
export class RecognitionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly participation: ParticipationService,
  ) {}

  /**
   * `GET /v1/rewards/me/recognition` — the level and badges the caller holds
   * in the active organization, the basis value that decides them, and the
   * version they were read under.
   */
  async myRecognition(): Promise<{
    organizationId: string;
    userId: string;
    recognition: Recognition;
  }> {
    const organizationId = getOrganizationId();
    const userId = getContext().userId;
    if (!userId) {
      throw RastaError.forbidden('This request has no user identity to read a level for');
    }

    // One snapshot: the version and the value it is read on are of one instant.
    const recognition = await this.prisma.client.$transaction(
      async (client) => {
        const tx = client as ExtendedPrismaClient;
        const asOf = await databaseNow(tx);
        const rule = await this.ruleInForce(tx);
        if (!rule) return recognise({ rule, asOf, basis: null });
        const basis = await this.basisValue(tx, rule, organizationId, userId, asOf);
        return recognise({ rule, asOf, basis });
      },
      { isolationLevel: 'RepeatableRead' },
    );

    return { organizationId, userId, recognition };
  }

  /**
   * A new version, in force from now, recorded with who created it
   * (`RECOGNITION_RULE_CHANGED`, in the same transaction). Numbered under a
   * transaction-scoped advisory lock, so two at once get consecutive numbers
   * and each event's `before` is the version it actually replaced.
   */
  async createRule(dto: CreateRecognitionRuleDto) {
    const actor = getContext().userId ?? SERVICE_NAME;

    return this.prisma.transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RECOGNITION_RULE_LOCK_KEY})`;
      const previous = await this.ruleInForce(tx);

      const created = await tx.recognitionRule.create({
        data: {
          id: `RCR_${ulid()}`,
          version: (previous?.version ?? 0) + 1,
          basis: dto.basis,
          levels: dto.levels.map((level, index) => ({
            rank: index + 1,
            name: level.name,
            threshold: level.threshold,
          })) as Prisma.InputJsonValue,
          badges: dto.badges.map((badge) => ({
            code: badge.code,
            name: badge.name,
            threshold: badge.threshold,
          })) as Prisma.InputJsonValue,
          label: dto.label ?? null,
          createdBy: actor,
        },
      });

      await this.ledger.enqueue(tx, {
        eventName: ECONOMIC_EVENTS.RECOGNITION_RULE_CHANGED,
        aggregateId: created.id,
        // Platform-wide: the envelope names the organization the
        // administrator acted from, as for the participation rule.
        organizationId: getOrganizationId(),
        payload: {
          ruleId: created.id,
          change: 'CREATED',
          changedBy: actor,
          changedAt: created.createdAt.toISOString(),
          before: previous ? ruleTerms(previous) : null,
          after: ruleTerms(toRecognitionRuleView(created)),
        },
      });

      return created;
    });
  }

  /** Every version, newest first. Platform-wide, so the same for every tenant. */
  async listRules() {
    return this.prisma.client.recognitionRule.findMany({ orderBy: { version: 'desc' } });
  }

  private async ruleInForce(tx: ExtendedPrismaClient): Promise<RecognitionRuleView | null> {
    const row = await tx.recognitionRule.findFirst({ orderBy: { version: 'desc' } });
    return row ? toRecognitionRuleView(row) : null;
  }

  /** The caller's value on the basis the version names, never on another. */
  private async basisValue(
    tx: ExtendedPrismaClient,
    rule: RecognitionRuleView,
    organizationId: string,
    userId: string,
    asOf: Date,
  ): Promise<RecognitionBasisValue> {
    if (rule.basis === 'REWARD_POINTS_CUMULATIVE') {
      const balance = await tx.rewardBalance.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
        select: { totalPoints: true },
      });
      // No balance row is no points granted yet: zero is the fact, not a guess.
      return { basis: rule.basis, value: balance?.totalPoints ?? 0 };
    }
    const breakdown = await this.participation.breakdownIn(tx, organizationId, userId, asOf, 0);
    return breakdown.status === 'NO_RULE'
      ? { basis: rule.basis, value: null, participationRuleVersion: null }
      : {
          basis: rule.basis,
          value: breakdown.score,
          participationRuleVersion: breakdown.rule.version,
        };
  }
}

/**
 * The key the version numbering serialises on: `recognit` in ASCII, so it is
 * recognisable in `pg_locks` and apart from the participation rule's.
 */
export const RECOGNITION_RULE_LOCK_KEY = BigInt('0x7265636f676e6974');

type RecognitionRuleRow = Prisma.RecognitionRuleGetPayload<Record<string, never>>;

export function toRecognitionRuleView(row: RecognitionRuleRow): RecognitionRuleView {
  return {
    id: row.id,
    version: row.version,
    ...parseRecognitionTerms(row),
    label: row.label,
    createdAt: row.createdAt,
  };
}

function ruleTerms(rule: RecognitionRuleView) {
  return {
    version: rule.version,
    basis: rule.basis,
    levels: rule.levels.map((level) => ({ ...level })),
    badges: rule.badges.map((badge) => ({ ...badge })),
    label: rule.label,
  };
}
