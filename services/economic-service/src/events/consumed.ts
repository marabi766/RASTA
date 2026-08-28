import { z } from 'zod';

/**
 * Events from other services that economic-service acts on.
 *
 * ## What is consumed, and what is deliberately not (ADR-032)
 *
 * **Active, with real producers and exact contracts:**
 *
 *   `MAINTENANCE_APPROVED`   maintenance-service. The product document's
 *                            mandatory control: settlement is impossible
 *                            without it (docs/17, ADR-028). Records a
 *                            settleable obligation and moves no money.
 *   `USAGE_RECORDED`         fleet-service. A reward trigger.
 *   `MAINTENANCE_COMPLETED`  maintenance-service. A reward trigger.
 *
 * **Deferred, and named rather than stubbed:** `ORDER_CREATED`,
 * `ORDER_RECEIPT_CONFIRMED`, `ORDER_CANCELLED`, `ORDER_DISPUTED`,
 * `STATEMENT_APPROVED`, `PURCHASE_ORDER_ISSUED`, `GOODS_RECEIVED`.
 *
 * Not because their producers are missing — that alone is no obstacle, and
 * maintenance-service had a consumer waiting a long time for one. Because
 * their **contracts are sketches**: `ORDER_RECEIPT_CONFIRMED` carries no
 * amount, and `ORDER_CREATED`'s `total` has no stated shape or currency.
 * Writing those handlers today would mean this service defining
 * marketplace-service's event schema, which is inventing a fact about another
 * service (AGENTS.md § 9).
 *
 * There are **no empty handlers** for them. A handler that consumes an event
 * and does nothing writes a `processed_event` row and looks exactly like one
 * that worked.
 *
 * Everything those flows need is reachable through the API instead, which is
 * what docs/08 § 8.6 actually specifies: `OrderSagaWorkflow` calls
 * `economic.placeHold()` and `economic.releaseHold() + settle()` as
 * **Activities**, not as events.
 *
 * ## Why the schemas are loose
 *
 * `.passthrough()` with only the fields this service reads. A producer adding
 * a field must not dead-letter a financial event, and this service has no
 * business asserting the full shape of another service's payload.
 */

export const CONSUMED_EVENTS = {
  MAINTENANCE_APPROVED: 'MAINTENANCE_APPROVED',
  MAINTENANCE_COMPLETED: 'MAINTENANCE_COMPLETED',
  USAGE_RECORDED: 'USAGE_RECORDED',
} as const;

export type ConsumedEventName = (typeof CONSUMED_EVENTS)[keyof typeof CONSUMED_EVENTS];

/** Amounts arrive as strings in minor units, as they are published. */
const amountMinor = z.string().regex(/^\d{1,30}$/);

/**
 * The owner has approved a repair and its cost (ADR-028).
 *
 * The fields this service reads and why each is load-bearing:
 *
 *   `organizationId`           the payer — the machine's owner.
 *   `workshopOrganizationId`   the payee. **Nullable at the source**, and an
 *                              approval without one cannot become an
 *                              obligation: there is nobody to pay. Such an
 *                              event is skipped rather than dead-lettered,
 *                              because it is a valid thing for
 *                              maintenance-service to publish — an in-house
 *                              repair with no external workshop — and a
 *                              dead-letter would make a normal event look
 *                              like a failure.
 *   `totalCostMinor`           the figure the approver actually saw. Recorded
 *                              as the obligation and never recomputed here;
 *                              recomputing it would be this service forming an
 *                              opinion about a cost it does not own.
 *   `approvedAt`               the moment the obligation arose, and therefore
 *                              the date the commission rule is selected
 *                              against at settlement (docs/10 § 10.7).
 *   `costBreakdown`            carried for audit. Not used to compute
 *                              anything — the total is authoritative.
 */
export const maintenanceApprovedSchema = z
  .object({
    requestId: z.string().min(1),
    assetId: z.string().min(1),
    organizationId: z.string().min(1),
    approvedBy: z.string().min(1),
    approvedAt: z.string(),
    workshopOrganizationId: z.string().nullable().optional(),
    totalCostMinor: amountMinor,
    currency: z.string().min(3),
    costBreakdown: z
      .array(z.object({ category: z.string(), amountMinor, currency: z.string() }).passthrough())
      .optional(),
  })
  .passthrough();

export type MaintenanceApprovedEvent = z.infer<typeof maintenanceApprovedSchema>;

/**
 * A machine is back in service — a reward trigger.
 *
 * Reward rules may condition on `type` (a `PREVENTIVE` completion is the
 * behaviour the product document wants to encourage — "انجام سرویس در موعد")
 * or on `downtimeMinutes`. This service asserts none of that itself; the rule
 * decides, from configuration.
 */
export const maintenanceCompletedSchema = z
  .object({
    requestId: z.string().min(1),
    assetId: z.string().min(1),
    organizationId: z.string().min(1),
    type: z.string().optional(),
    scheduleId: z.string().nullable().optional(),
    completedAt: z.string().optional(),
    downtimeMinutes: z.number().nullable().optional(),
    totalCostMinor: amountMinor.optional(),
    currency: z.string().optional(),
  })
  .passthrough();

export type MaintenanceCompletedEvent = z.infer<typeof maintenanceCompletedSchema>;

/**
 * Usage was recorded — the platform's most frequent reward trigger
 * ("ثبت منظم کارکرد", docs/10 § 10.8).
 *
 * Quantities arrive as strings because they are NUMERIC at the source and a
 * JSON float would reintroduce the drift the column type prevents.
 * fleet-service requires at least one of hours or kilometres and permits both
 * meters to be absent, so every quantity here is optional — a reading with
 * only kilometres is valid input and must not be dead-lettered.
 */
export const usageRecordedSchema = z
  .object({
    usageRecordId: z.string().min(1),
    assetId: z.string().min(1),
    organizationId: z.string().min(1),
    driverId: z.string().nullable().optional(),
    periodStart: z.string().optional(),
    periodEnd: z.string().optional(),
    hours: z.string().nullable().optional(),
    kilometres: z.string().nullable().optional(),
    hourMeter: z.string().nullable().optional(),
    odometer: z.string().nullable().optional(),
  })
  .passthrough();

export type UsageRecordedEvent = z.infer<typeof usageRecordedSchema>;

/**
 * Events this service will consume once their contracts are real.
 *
 * Listed as data rather than as a comment so that the deferral is greppable
 * and so a contract test can assert that none of them has quietly acquired a
 * handler without an ADR (ADR-032).
 */
export const DEFERRED_CONSUMPTION = [
  'ORDER_CREATED',
  'ORDER_RECEIPT_CONFIRMED',
  'ORDER_CANCELLED',
  'ORDER_DISPUTED',
  'STATEMENT_APPROVED',
  'PURCHASE_ORDER_ISSUED',
  'GOODS_RECEIVED',
] as const;
