import type { Prisma } from '../generated/prisma';
import type { ParticipationBreakdown } from './participation';
import { toRuleView } from './participation.service';
import type { ParticipationRuleApiView, ParticipationView } from './dto';

type ParticipationRuleRow = Prisma.ParticipationRuleGetPayload<Record<string, never>>;

export function toParticipationRuleApiView(row: ParticipationRuleRow): ParticipationRuleApiView {
  const rule = toRuleView(row);
  return {
    id: rule.id,
    version: rule.version,
    windowDays: rule.windowDays,
    contributions: rule.contributions.map((contribution) => ({ ...contribution })),
    label: rule.label,
    createdAt: rule.createdAt.toISOString(),
    createdBy: row.createdBy,
  };
}

export function toParticipationView(result: {
  organizationId: string;
  userId: string;
  breakdown: ParticipationBreakdown;
}): ParticipationView {
  const { organizationId, userId, breakdown } = result;
  if (breakdown.status === 'NO_RULE') {
    return {
      organizationId,
      userId,
      spendable: false,
      status: 'NO_RULE',
      asOf: breakdown.asOf.toISOString(),
      score: null,
      rule: null,
      window: null,
      breakdown: [],
      recentFacts: [],
    };
  }
  const { rule } = breakdown;
  return {
    organizationId,
    userId,
    spendable: false,
    status: 'SCORED',
    asOf: breakdown.asOf.toISOString(),
    score: breakdown.score,
    rule: {
      id: rule.id,
      version: rule.version,
      windowDays: rule.windowDays,
      contributions: rule.contributions.map((contribution) => ({ ...contribution })),
      label: rule.label,
      createdAt: rule.createdAt.toISOString(),
    },
    window: {
      from: breakdown.window.from.toISOString(),
      to: breakdown.window.to.toISOString(),
    },
    breakdown: breakdown.lines.map((line) => ({ ...line })),
    recentFacts: breakdown.recentFacts.map((fact) => ({
      triggerEvent: fact.triggerEvent,
      sourceReference: fact.sourceReference,
      occurredAt: fact.occurredAt.toISOString(),
      counted: fact.counted,
      effect: fact.effect,
    })),
  };
}
