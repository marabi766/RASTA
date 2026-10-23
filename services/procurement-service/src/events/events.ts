import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PROCUREMENT_RFQ_EVENTS, PROCUREMENT_RFQ_EVENT_SCHEMAS } from '@rasta/contracts';

/**
 * Events published by procurement-service, on `rasta.procurement.v1` (ADR-070 § 9).
 *
 * COM-007 PR 1 publishes the demand's two (`DEMAND_SUBMITTED`, `DEMAND_WITHDRAWN`) and the four of
 * a window's end — `DEMAND_AGGREGATED` (OPEN → READY), `AGGREGATION_WINDOW_EXTENDED`,
 * `AGGREGATION_REFERRED` and `AGGREGATION_LAPSED` — because a demand that arrives after
 * `closes_at` ends the window itself, in its own transaction (ADR-070 § 2). The sweeper of plan
 * PR 2 ends windows with the same four, and PR 2 adds `AGGREGATION_CANCELLED` (READY →
 * CANCELLED). Every state change has its event, and so its audit record. The names marked new in
 * ADR-070 § 9 are the project manager's to confirm.
 *
 * Plan PR 6 adds the RFQ's — `RFQ_ISSUED` (with the aggregation's READY → RFQ_ISSUED), `RFQ_CLOSED`
 * and `RFQ_CANCELLED`. Their names and payload schemas are cross-service contracts in
 * `@rasta/contracts` (`events/procurement-rfq.ts`: audit-service's RFQ evidence consumer, plan PR 7,
 * reads them), composed into the one table below so every event this service publishes is
 * validated the same way.
 *
 * The payloads are defined here because this service owns them (ADR-032); the only cross-service
 * contract in `packages/contracts` is the audit trail.
 *
 * ## What these payloads never carry
 *
 * **Identifiers, quantities, closed codes and instants only — no amount, no free text, no
 * personal data** (ADR-070 § 9). The topic is read by every service that declares a subscription,
 * and by audit-service in full (`docs/07` § 7.3). A demand's note and a withdrawal's reason are
 * the buyer's free text and stay in this service's database, read through the API.
 */

export const PROCUREMENT_EVENTS = {
  DEMAND_SUBMITTED: 'DEMAND_SUBMITTED',
  DEMAND_WITHDRAWN: 'DEMAND_WITHDRAWN',
  DEMAND_AGGREGATED: 'DEMAND_AGGREGATED',
  AGGREGATION_WINDOW_EXTENDED: 'AGGREGATION_WINDOW_EXTENDED',
  AGGREGATION_REFERRED: 'AGGREGATION_REFERRED',
  AGGREGATION_LAPSED: 'AGGREGATION_LAPSED',
  AGGREGATION_CANCELLED: 'AGGREGATION_CANCELLED',
  AGGREGATION_SETTING_CHANGED: 'AGGREGATION_SETTING_CHANGED',
  ...PROCUREMENT_RFQ_EVENTS,
} as const;

export type ProcurementEventName = keyof typeof PROCUREMENT_EVENTS;

const id = z.string().min(1).max(128);
const productId = z.string().regex(/^PRD_[0-9A-HJKMNP-TV-Z]{26}$/);
/** MAX_QUANTITY (ADR-070 § 2): a demand's quantity and a window's total alike. */
const quantity = z.number().int().min(1).max(2_147_483_647);
const totalQuantity = z.number().int().min(0).max(2_147_483_647);
/** How many live demands a window held when it ended. */
const demandCount = z.number().int().min(0).max(2_147_483_647);
/** `demandIdsDigest` of the same demands: lowercase hex SHA-256. */
const demandIdsSha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** ISO 8601 in UTC, the form every event of the platform carries a time in. */
const instant = z.string().datetime({ offset: false });

const windowFacts = {
  aggregationId: id,
  /** The buyer — the tenant of the aggregation and of every demand in it. */
  organizationId: id,
  productId,
  totalQuantity,
};

/**
 * A demand was registered and joined `aggregationId` (ADR-070 § 2). `aggregationOpened` says
 * whether this demand opened that window (its first demand) — the window's own creation has no
 * event of its own, so it is audited here, with the window's end. Keyed by `aggregationId`.
 */
export const demandSubmittedPayload = z
  .object({
    demandId: id,
    aggregationId: id,
    organizationId: id,
    productId,
    quantity,
    aggregationOpened: z.boolean(),
    closesAt: instant,
    submittedBy: id,
    submittedAt: instant,
  })
  .strict();

/** A demand was withdrawn while its window was open (SUBMITTED → WITHDRAWN). No reason text. */
export const demandWithdrawnPayload = z
  .object({
    demandId: id,
    aggregationId: id,
    organizationId: id,
    productId,
    quantity,
    withdrawnBy: id,
    withdrawnAt: instant,
  })
  .strict();

/**
 * The digest a window-end event names its demands by: SHA-256 (lowercase hex) of their ids, sorted
 * and joined with `\n`. The ids themselves are not listed — a window's demands have no bound
 * (extension after extension), and an unbounded list would one day make a message larger than
 * the broker takes, a poison message on the partition (ADR-070 § 9). Each demand already names its
 * window on `DEMAND_SUBMITTED`, so a reader rebuilds the set and checks it against this.
 */
export function demandIdsDigest(ids: readonly string[]): string {
  return createHash('sha256')
    .update([...ids].sort().join('\n'), 'utf8')
    .digest('hex');
}

/**
 * The window ended with at least one demand and its total at or past the snapshot's threshold
 * (OPEN → READY). `settingVersion` is null when the window opened on the environment defaults.
 */
export const demandAggregatedPayload = z
  .object({
    ...windowFacts,
    demandCount: demandCount.min(1),
    demandIdsSha256,
    settingVersion: z.number().int().min(1).nullable(),
    closedAt: instant,
  })
  .strict();

/**
 * The window ended short of its threshold under EXTEND (OPEN → OPEN): it moved on by its own
 * length, `windows` times — once per length elapsed since it should have ended — and its demands
 * stay. `extensionCount` is the aggregation's count after this extension.
 */
export const aggregationWindowExtendedPayload = z
  .object({
    ...windowFacts,
    previousClosesAt: instant,
    closesAt: instant,
    windows: z.number().int().min(1),
    extensionCount: z.number().int().min(1),
  })
  .strict();

/**
 * The window ended short under REFER (OPEN → REFERRED); its demands are REFERRED with it. A fact
 * only: marketplace is never called (ADR-070 § 2).
 */
export const aggregationReferredPayload = z
  .object({ ...windowFacts, demandCount: demandCount.min(1), demandIdsSha256, closedAt: instant })
  .strict();

/**
 * The window ended with no live demand, or short under CLOSE (OPEN → LAPSED); its demands, if any,
 * are LAPSED with it.
 */
export const aggregationLapsedPayload = z
  .object({
    ...windowFacts,
    demandCount,
    demandIdsSha256,
    reasonCode: z.enum(['NO_LIVE_DEMAND', 'SHORTFALL_CLOSED']),
    closedAt: instant,
  })
  .strict();

/**
 * A READY aggregation was cancelled with a reason by a role of the RFQ issuer (READY → CANCELLED,
 * ADR-070 § 2; Q-119 (4): the way out for its requesters). Its demands are the ones it ended READY
 * with, by count and digest; they stay as they are, final with it. The reason is free text and stays
 * in this service's database, read through the API.
 */
export const aggregationCancelledPayload = z
  .object({
    ...windowFacts,
    demandCount: demandCount.min(1),
    demandIdsSha256,
    cancelledBy: id,
    cancelledAt: instant,
  })
  .strict();

/**
 * A new version of an organization's aggregation settings (plan PR 3, Q-119 (2)): its audit record
 * (AGENTS.md S-06). The three values, the version it replaces (null: the environment defaults
 * were in force), who recorded it and when. Windows opened afterwards take it; open ones keep
 * their snapshot.
 */
export const aggregationSettingChangedPayload = z
  .object({
    organizationId: id,
    settingVersion: z.number().int().min(1),
    previousVersion: z.number().int().min(1).nullable(),
    windowHours: z.number().int().min(1).max(8760),
    minQuantity: z.number().int().min(0).max(2_147_483_647),
    shortfallPolicy: z.enum(['EXTEND', 'REFER', 'CLOSE']),
    recordedBy: id,
    recordedAt: instant,
  })
  .strict()
  .refine((p) => p.previousVersion === (p.settingVersion === 1 ? null : p.settingVersion - 1), {
    message: 'previousVersion is the version before settingVersion, null before the first',
  });

export const PROCUREMENT_EVENT_SCHEMAS = {
  DEMAND_SUBMITTED: demandSubmittedPayload,
  DEMAND_WITHDRAWN: demandWithdrawnPayload,
  DEMAND_AGGREGATED: demandAggregatedPayload,
  AGGREGATION_WINDOW_EXTENDED: aggregationWindowExtendedPayload,
  AGGREGATION_REFERRED: aggregationReferredPayload,
  AGGREGATION_LAPSED: aggregationLapsedPayload,
  AGGREGATION_CANCELLED: aggregationCancelledPayload,
  AGGREGATION_SETTING_CHANGED: aggregationSettingChangedPayload,
  ...PROCUREMENT_RFQ_EVENT_SCHEMAS,
} as const satisfies Record<ProcurementEventName, z.ZodTypeAny>;

export type ProcurementEventPayload<N extends ProcurementEventName> = z.infer<
  (typeof PROCUREMENT_EVENT_SCHEMAS)[N]
>;

/**
 * Validates a payload against its published contract **before** it reaches the outbox, so a
 * malformed event can never be committed. Throwing here rolls back the caller's transaction: a
 * state change nobody can be told about is not made.
 */
export function validateProcurementPayload<N extends ProcurementEventName>(
  eventName: N,
  payload: unknown,
): ProcurementEventPayload<N> {
  const schema = PROCUREMENT_EVENT_SCHEMAS[eventName];
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `${eventName} payload does not match its published contract: ${parsed.error.message}`,
    );
  }
  return parsed.data as ProcurementEventPayload<N>;
}
