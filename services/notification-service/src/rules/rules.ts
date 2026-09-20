import { z } from 'zod';
import { bandFor, EXPIRY_BANDS_DAYS } from './dedupe';
import type { ContextData } from './context-sanitiser';
import type { InAppTemplate } from './render';

/**
 * The rule catalogue — event → notification, as data (ADR-054 § 13).
 *
 * `docs/04` § 4.15: "the event→template mapping is a configuration table", so a
 * rule is a row here and never a branch in the consumer. NTF-001 ships the
 * three rules the story names; rules 4 and 5 of the eight-rule cut
 * (`BREAKDOWN_REPORTED`, `INSPECTION_FAILED`) are one entry each when their
 * story lands, and rules 9–30 are the same shape.
 *
 * ## What a rule decides, and what it does not
 *
 * A rule decides *how* to tell somebody: the subject, the recipients, the
 * severity, the dedupe bucket, the template. It never decides *whether* the
 * event matters — the producing service already did, by publishing it
 * (`docs/04` § 4.15, ADR § 14).
 *
 * ## Payload schemas are copied, not imported
 *
 * `services/asset-service/src/asset/events.ts` and
 * `services/maintenance-service/src/maintenance/events.ts` define these
 * payloads, and AGENTS.md A-02 forbids importing across services. The schemas
 * below are the **fields this service reads**, `.passthrough()` so a producer
 * adding a field is not a poison event here — the contract test in
 * `rules.spec.ts` pins them against the catalogue's documented keys.
 */

export const SOURCE_TOPICS = {
  insurance: 'rasta.insurance.v1',
  maintenance: 'rasta.maintenance.v1',
} as const;

/** Every topic the dispatcher group subscribes to. */
export const SUBSCRIBED_TOPICS: readonly string[] = [
  SOURCE_TOPICS.insurance,
  SOURCE_TOPICS.maintenance,
];

export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';
export type Classification = 'ROUTINE' | 'MANDATORY';

/**
 * The bucket a person turns off when they mean "this kind of thing"
 * (NTF-003, ADR-054 § 5, layer 3 of the ladder).
 *
 * Coarser than a `ruleKey` on purpose. Somebody who does not want expiry
 * reminders should not have to find and disable `insurance.expiring` and
 * `inspection.expiring` separately, and should not start receiving them again
 * the day a third expiry rule ships.
 *
 * A closed set rather than a free string: it is the `scope_key` of a stored
 * preference, so a typo would create a row the ladder never looks for — present
 * in the table, invisible in effect, and impossible to explain to the person
 * who set it.
 */
export const NOTIFICATION_CATEGORIES = ['EXPIRY', 'MAINTENANCE'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export interface NotificationRule<TPayload = unknown> {
  readonly ruleKey: string;
  readonly eventName: string;
  readonly topic: string;
  /** Validates the fields this rule reads. Failure is a poison event. */
  readonly payloadSchema: z.ZodType<TPayload>;
  readonly subjectType: string;
  subjectId(payload: TPayload): string;
  /**
   * The coarse time bucket the dedupe key closes over (ADR § 3). Two events
   * with the same subject and the same bucket are one notification.
   */
  dedupeBucket(payload: TPayload): string;
  /** The only payload keys that may enter `contextData` (ADR § 10). */
  readonly contextAllowlist: readonly string[];
  readonly severity: Severity;
  readonly classification: Classification;
  /** Layer 3 of the preference ladder. See `NotificationCategory`. */
  readonly category: NotificationCategory;
  /**
   * Channels a `MANDATORY` rule delivers on whatever the person prefers.
   *
   * Per rule rather than one constant, because Q-38 is a product question and
   * its recorded answer promises it can change "بدون Migration، بدون تغییر
   * دامنه". Empty on a `ROUTINE` rule, where the ladder never consults it.
   */
  readonly mandatoryChannels: readonly 'IN_APP'[];
  /**
   * Which memberships in the event's organization are recipients, resolved
   * through identity-service. A user holding several listed roles is one
   * recipient, credited to the first role that matched.
   */
  readonly recipientRoles: readonly string[];
  readonly template: InAppTemplate;
}

// ---------------------------------------------------------------------------
// Payload shapes — the fields read, with the producer's own types
// ---------------------------------------------------------------------------

const insuranceExpiringPayload = z
  .object({
    assetId: z.string().min(1),
    organizationId: z.string().min(1),
    policyId: z.string().min(1),
    insurerName: z.string(),
    validTo: z.string(),
    daysRemaining: z.number().int(),
  })
  .passthrough();

const inspectionExpiringPayload = z
  .object({
    assetId: z.string().min(1),
    organizationId: z.string().min(1),
    inspectionId: z.string().min(1),
    validTo: z.string(),
    daysRemaining: z.number().int(),
  })
  .passthrough();

const maintenanceDuePayload = z
  .object({
    scheduleId: z.string().min(1),
    assetId: z.string().min(1),
    organizationId: z.string().min(1),
    title: z.string(),
    basis: z.string(),
    /** `DUE_SOON` or `OVERDUE`; carried as the producer wrote it. */
    state: z.string().min(1),
    dueBy: z.string().nullable(),
    dueAtMeter: z.string().nullable(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/**
 * Who an asset-level operational warning goes to.
 *
 * `docs/09` § 9.3 gives `FLEET_MANAGER` `asset:*`, `fleet:*` and
 * `maintenance:*`; an `ORGANIZATION_ADMIN` administers the tenant those
 * assets belong to. Both are organization-scoped memberships, so a
 * cross-tenant `UNION_ADMIN` is deliberately not on the list — the
 * membership query is per organization and a union administrator's
 * memberships are elsewhere.
 */
const ASSET_WARNING_RECIPIENTS = ['FLEET_MANAGER', 'ORGANIZATION_ADMIN'] as const;

// ---------------------------------------------------------------------------
// Templates — fa-IR, plain text, Latin digits (rendering is not presentation)
// ---------------------------------------------------------------------------

/** Bumped whenever any template's text changes, so a delivery can name what it rendered. */
export const TEMPLATE_CATALOGUE_VERSION = 1;

const insuranceExpiringTemplate: InAppTemplate = {
  key: 'insurance.expiring.in-app',
  version: TEMPLATE_CATALOGUE_VERSION,
  title: 'بیمه‌نامه دستگاه در حال انقضا است',
  body: 'بیمه‌نامه {{insurerName}} برای دستگاه {{assetId}} تا {{daysRemaining}} روز دیگر ({{validTo}}) منقضی می‌شود.',
  requiredVariables: ['assetId', 'insurerName', 'validTo', 'daysRemaining'],
  actionPath: '/assets/{{assetId}}',
};

const inspectionExpiringTemplate: InAppTemplate = {
  key: 'inspection.expiring.in-app',
  version: TEMPLATE_CATALOGUE_VERSION,
  title: 'معاینه فنی دستگاه در حال انقضا است',
  body: 'اعتبار معاینه فنی دستگاه {{assetId}} تا {{daysRemaining}} روز دیگر ({{validTo}}) به پایان می‌رسد.',
  requiredVariables: ['assetId', 'validTo', 'daysRemaining'],
  actionPath: '/assets/{{assetId}}',
};

const maintenanceDueTemplate: InAppTemplate = {
  key: 'maintenance.due.in-app',
  version: TEMPLATE_CATALOGUE_VERSION,
  title: 'سررسید سرویس دستگاه',
  body: 'سرویس «{{title}}» دستگاه {{assetId}} بر اساس {{basis}} در وضعیت {{state}} است.',
  requiredVariables: ['assetId', 'title', 'basis', 'state'],
  actionPath: '/assets/{{assetId}}',
};

// ---------------------------------------------------------------------------
// The three NTF-001 rules
// ---------------------------------------------------------------------------

export const INSURANCE_EXPIRING_RULE: NotificationRule<z.infer<typeof insuranceExpiringPayload>> = {
  ruleKey: 'insurance.expiring',
  eventName: 'INSURANCE_EXPIRING',
  topic: SOURCE_TOPICS.insurance,
  payloadSchema: insuranceExpiringPayload,
  subjectType: 'InsurancePolicy',
  subjectId: (payload) => payload.policyId,
  // Banded on `daysRemaining`, which the producer already puts on the payload
  // so nobody recomputes a date. 120 sweeps → at most five buckets.
  dedupeBucket: (payload) => `band:${bandFor(payload.daysRemaining, EXPIRY_BANDS_DAYS)}`,
  contextAllowlist: ['assetId', 'policyId', 'insurerName', 'validTo', 'daysRemaining'],
  severity: 'WARNING',
  classification: 'ROUTINE',
  category: 'EXPIRY',
  mandatoryChannels: [],
  recipientRoles: ASSET_WARNING_RECIPIENTS,
  template: insuranceExpiringTemplate,
};

export const INSPECTION_EXPIRING_RULE: NotificationRule<z.infer<typeof inspectionExpiringPayload>> =
  {
    ruleKey: 'inspection.expiring',
    eventName: 'INSPECTION_EXPIRING',
    topic: SOURCE_TOPICS.insurance,
    payloadSchema: inspectionExpiringPayload,
    subjectType: 'TechnicalInspection',
    subjectId: (payload) => payload.inspectionId,
    dedupeBucket: (payload) => `band:${bandFor(payload.daysRemaining, EXPIRY_BANDS_DAYS)}`,
    contextAllowlist: ['assetId', 'inspectionId', 'validTo', 'daysRemaining'],
    severity: 'WARNING',
    classification: 'ROUTINE',
    category: 'EXPIRY',
    mandatoryChannels: [],
    recipientRoles: ASSET_WARNING_RECIPIENTS,
    template: inspectionExpiringTemplate,
  };

export const MAINTENANCE_DUE_RULE: NotificationRule<z.infer<typeof maintenanceDuePayload>> = {
  ruleKey: 'maintenance.due',
  eventName: 'MAINTENANCE_DUE',
  topic: SOURCE_TOPICS.maintenance,
  payloadSchema: maintenanceDuePayload,
  subjectType: 'MaintenanceSchedule',
  subjectId: (payload) => payload.scheduleId,
  // The producer already guards re-announcement (`due_announced_at IS NULL`),
  // so the bucket is the state: a DUE_SOON and a later OVERDUE are two
  // different things to say, a second DUE_SOON is not.
  dedupeBucket: (payload) => `state:${payload.state}`,
  contextAllowlist: ['scheduleId', 'assetId', 'title', 'basis', 'state', 'dueBy', 'dueAtMeter'],
  severity: 'WARNING',
  classification: 'ROUTINE',
  category: 'MAINTENANCE',
  mandatoryChannels: [],
  recipientRoles: ASSET_WARNING_RECIPIENTS,
  template: maintenanceDueTemplate,
};

/** Every rule NTF-001 consumes, keyed by event name. */
export const RULES_BY_EVENT: ReadonlyMap<string, NotificationRule> = new Map<
  string,
  NotificationRule
>([
  [INSURANCE_EXPIRING_RULE.eventName, INSURANCE_EXPIRING_RULE as NotificationRule],
  [INSPECTION_EXPIRING_RULE.eventName, INSPECTION_EXPIRING_RULE as NotificationRule],
  [MAINTENANCE_DUE_RULE.eventName, MAINTENANCE_DUE_RULE as NotificationRule],
]);

export const RULES_BY_KEY: ReadonlyMap<string, NotificationRule> = new Map(
  [...RULES_BY_EVENT.values()].map((rule) => [rule.ruleKey, rule]),
);

export function ruleForEvent(eventName: string): NotificationRule | undefined {
  return RULES_BY_EVENT.get(eventName);
}

export function ruleForKey(ruleKey: string): NotificationRule | undefined {
  return RULES_BY_KEY.get(ruleKey);
}

/** Type helper for tests: the context a rule's template needs. */
export type RuleContext = ContextData;
