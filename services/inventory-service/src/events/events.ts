import { z } from 'zod';
import {
  INVENTORY_RETURN_DISPATCH_EVENT_SCHEMAS,
  INVENTORY_RETURN_DISPATCH_EVENTS,
  INVENTORY_RETURN_EVENT_SCHEMAS,
  INVENTORY_RETURN_EVENTS,
  INVENTORY_SHIPMENT_EVENT_SCHEMAS,
  INVENTORY_SHIPMENT_EVENTS,
  isoDateTime,
} from '@rasta/contracts';

/**
 * Events published by inventory-service, on `rasta.inventory.v1` (ADR-056 § 6).
 *
 * PR 1 publishes the stock stream — `STOCK_RECEIVED`, `STOCK_RESERVED`, `STOCK_RELEASED` and
 * `STOCK_ISSUED`, the catalogue's (`docs/04` § 4.11), and `STOCK_ADJUSTED` — and the warehouse's
 * `WAREHOUSE_CREATED`. The last two are not in the catalogue: every state change goes through the
 * outbox (A-08) and so reaches audit-service (S-06); the project manager approved both
 * (COM-006 PR 1). `LOW_STOCK_DETECTED` waits for its threshold (Q-106).
 *
 * PR 2 adds the shipment stream — `SHIPMENT_CREATED`, `SHIPMENT_DISPATCHED`, `SHIPMENT_DELIVERED`.
 * Their names and payload schemas are cross-service contracts in `@rasta/contracts`
 * (`events/inventory-shipments.ts`; `docs/events/README.md` § adding an event), composed into
 * the one table below so every event this service publishes is validated the same way.
 *
 * The catalogue's `sku` is `productId` here: the opaque marketplace product reference the stock
 * item is keyed by (ADR-056 § 1), approved with this PR.
 *
 * The payloads are defined here because this service owns them (ADR-032); nothing consumes
 * them yet but audit-service, which stores every declared topic whole.
 *
 * ## What these payloads never carry
 *
 * **Identifiers, integer quantities and instants only** — no warehouse name or location, no free
 * text, no personal data. The topic is read by every service that declares a subscription, and
 * by audit-service in full (`docs/07` § 7.3). People are named by user id, as everywhere.
 */

export const INVENTORY_EVENTS = {
  WAREHOUSE_CREATED: 'WAREHOUSE_CREATED',
  STOCK_RECEIVED: 'STOCK_RECEIVED',
  STOCK_ADJUSTED: 'STOCK_ADJUSTED',
  STOCK_RESERVED: 'STOCK_RESERVED',
  STOCK_RELEASED: 'STOCK_RELEASED',
  STOCK_ISSUED: 'STOCK_ISSUED',
  ...INVENTORY_SHIPMENT_EVENTS,
  ...INVENTORY_RETURN_EVENTS,
  ...INVENTORY_RETURN_DISPATCH_EVENTS,
} as const;

export type InventoryEventName = keyof typeof INVENTORY_EVENTS;

const id = z.string().min(1).max(128);
/** ISO 8601 in UTC, the form every event of the platform carries a time in. */
const instant = z.string().check(isoDateTime({ offset: false }));
const quantity = z.number().int().min(1);
const balance = z.number().int().min(0);
const reference = z
  .string()
  .regex(/^(ORD|PO|ADJ)_[0-9A-HJKMNP-TV-Z]{26}$/)
  .nullable();

/** What every stock event says about the item it moved: which, where, and its balance after. */
const stockItemFacts = {
  stockItemId: id,
  warehouseId: id,
  productId: id,
  /** The warehouse owner — the tenant. */
  organizationId: id,
  /** The movement this event announces, in the item's ledger. */
  movementId: id,
  /** The item's ledger position after the movement: consecutive per item, from 1. */
  itemVersion: z.number().int().min(1),
  onHandAfter: balance,
  reservedAfter: balance,
};

/** What every reservation event says about the reservation. */
const reservationFacts = {
  reservationId: id,
  holderOrganizationId: id,
  orderReference: reference,
  quantity,
};

/** A warehouse was created, ACTIVE, for its owner. Keyed by `warehouseId`. No name or location. */
export const warehouseCreatedPayload = z
  .object({
    warehouseId: id,
    organizationId: id,
    createdBy: id,
    createdAt: instant,
  })
  .strict();

/** Stock arrived: on hand grew by `quantity` (ADR-056 § 3, `ReceiveStock`). */
export const stockReceivedPayload = z
  .object({
    ...stockItemFacts,
    quantity,
    sourceReference: reference,
    receivedBy: id,
    receivedAt: instant,
  })
  .strict();

/**
 * On hand was corrected by a signed `quantityDelta` — a count, a loss, or ADR-056's direct issue
 * without a reservation. Never below what is reserved.
 */
export const stockAdjustedPayload = z
  .object({
    ...stockItemFacts,
    quantityDelta: z
      .number()
      .int()
      .refine((value) => value !== 0, 'quantityDelta is never zero'),
    sourceReference: reference,
    adjustedBy: id,
    adjustedAt: instant,
  })
  .strict();

/** A quantity was reserved for a holder: reserved grew, on hand did not. One per line. */
export const stockReservedPayload = z
  .object({
    ...stockItemFacts,
    ...reservationFacts,
    expiresAt: instant.nullable(),
    reservedBy: id,
    reservedAt: instant,
  })
  .strict();

/**
 * A reservation ended without the stock leaving: released by a person (`RELEASED`) or past its
 * `expiresAt` (`EXPIRED`, `releasedBy` null — the service ended it).
 */
export const stockReleasedPayload = z
  .object({
    ...stockItemFacts,
    ...reservationFacts,
    reason: z.enum(['RELEASED', 'EXPIRED']),
    releasedBy: id.nullable(),
    releasedAt: instant,
  })
  .strict();

/** A reservation was consumed: the stock left, on hand and reserved both fell by `quantity`. */
export const stockIssuedPayload = z
  .object({
    ...stockItemFacts,
    ...reservationFacts,
    issuedBy: id,
    issuedAt: instant,
  })
  .strict();

export const INVENTORY_EVENT_SCHEMAS = {
  WAREHOUSE_CREATED: warehouseCreatedPayload,
  STOCK_RECEIVED: stockReceivedPayload,
  STOCK_ADJUSTED: stockAdjustedPayload,
  STOCK_RESERVED: stockReservedPayload,
  STOCK_RELEASED: stockReleasedPayload,
  STOCK_ISSUED: stockIssuedPayload,
  ...INVENTORY_SHIPMENT_EVENT_SCHEMAS,
  ...INVENTORY_RETURN_EVENT_SCHEMAS,
  ...INVENTORY_RETURN_DISPATCH_EVENT_SCHEMAS,
} as const satisfies Record<InventoryEventName, z.ZodTypeAny>;

export type InventoryEventPayload<N extends InventoryEventName> = z.infer<
  (typeof INVENTORY_EVENT_SCHEMAS)[N]
>;

/**
 * Validates a payload against its published contract **before** it reaches the outbox, so a
 * malformed event can never be committed. Throwing here rolls back the caller's transaction: a
 * state change nobody can be told about is not made.
 */
export function validateInventoryPayload<N extends InventoryEventName>(
  eventName: N,
  payload: unknown,
): InventoryEventPayload<N> {
  const parsed = INVENTORY_EVENT_SCHEMAS[eventName].safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `${eventName} payload does not match its published contract: ${parsed.error.message}`,
    );
  }
  return parsed.data as InventoryEventPayload<N>;
}
