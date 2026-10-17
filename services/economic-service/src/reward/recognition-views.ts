import type { Prisma } from '../generated/prisma';
import type { Recognition } from './recognition';
import { toRecognitionRuleView } from './recognition.service';
import type { RecognitionRuleApiView, RecognitionView } from './dto';

type RecognitionRuleRow = Prisma.RecognitionRuleGetPayload<Record<string, never>>;

export function toRecognitionRuleApiView(row: RecognitionRuleRow): RecognitionRuleApiView {
  const rule = toRecognitionRuleView(row);
  return {
    id: rule.id,
    version: rule.version,
    basis: rule.basis,
    levels: rule.levels.map((level) => ({ ...level })),
    badges: rule.badges.map((badge) => ({ ...badge })),
    label: rule.label,
    createdAt: rule.createdAt.toISOString(),
    createdBy: row.createdBy,
  };
}

/**
 * What the caller holds, and why — and nothing else from the version: the
 * levels above, their thresholds and the badges not held stay out, so no
 * client can render "N to the next level" from this (docs/10 § 10.8).
 */
export function toRecognitionView(result: {
  organizationId: string;
  userId: string;
  recognition: Recognition;
}): RecognitionView {
  const { organizationId, userId, recognition } = result;
  if (recognition.status === 'NO_RULE') {
    return {
      organizationId,
      userId,
      status: 'NO_RULE',
      asOf: recognition.asOf.toISOString(),
      rule: null,
      basis: null,
      level: null,
      badges: [],
    };
  }
  const { rule, basis } = recognition;
  return {
    organizationId,
    userId,
    status: recognition.status,
    asOf: recognition.asOf.toISOString(),
    rule: {
      id: rule.id,
      version: rule.version,
      basis: rule.basis,
      label: rule.label,
      createdAt: rule.createdAt.toISOString(),
    },
    basis: {
      kind: basis.basis,
      value: basis.value,
      participationRuleVersion:
        basis.basis === 'PARTICIPATION_SCORE' ? basis.participationRuleVersion : null,
    },
    level:
      recognition.status === 'EVALUATED' && recognition.level ? { ...recognition.level } : null,
    badges:
      recognition.status === 'EVALUATED' ? recognition.badges.map((badge) => ({ ...badge })) : [],
  };
}
