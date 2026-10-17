import { RETURN_SHIPMENT_AGGREGATE, SHIPMENT_AGGREGATE } from '@rasta/contracts';
import type { InventoryEventName, InventoryEventPayload } from './events';

/**
 * Where each inventory event goes on the wire, and what it shares a stream with (ADR-056 § 6).
 *
 * `docs/07` § 7.7 and ADR-051 § C-7 keep two questions apart: `aggregateType`/`aggregateId` say
 * what an event is **about**; `partitionKey` says which stream it belongs to. Here they agree:
 *
 * | stream (`topic + partitionKey`)      | class      | why                                         |
 * | ------------------------------------ | ---------- | ------------------------------------------- |
 * | `rasta.inventory.v1` + `stockItemId` | **STRICT** | RESERVED before ISSUED: an inversion is     |
 * |                                      |            | stock leaving that was never reserved       |
 * | `rasta.inventory.v1` + `shipmentId`  | **STRICT** | DISPATCHED before DELIVERED: an inversion   |
 * |                                      |            | is a shipment delivered before it left      |
 * | `rasta.inventory.v1` + `warehouseId` | —          | one event per warehouse                     |
 *
 * Co-partitioning, not ordering: several relay replicas may publish separate rows of one key
 * concurrently — D-027, open; a consumer reads order from the envelope's `streamSeq` and the
 * payload's `itemVersion` / `shipmentVersion`, never from arrival.
 */

export const AGGREGATE_OF = {
  WAREHOUSE_CREATED: 'Warehouse',
  STOCK_RECEIVED: 'StockItem',
  STOCK_ADJUSTED: 'StockItem',
  STOCK_RESERVED: 'StockItem',
  STOCK_RELEASED: 'StockItem',
  STOCK_ISSUED: 'StockItem',
  SHIPMENT_CREATED: SHIPMENT_AGGREGATE,
  SHIPMENT_DISPATCHED: SHIPMENT_AGGREGATE,
  SHIPMENT_DELIVERED: SHIPMENT_AGGREGATE,
  RETURN_SHIPMENT_DISPATCHED: RETURN_SHIPMENT_AGGREGATE,
  RETURN_SHIPMENT_RECEIVED: RETURN_SHIPMENT_AGGREGATE,
  RETURN_SHIPMENT_INSPECTED: RETURN_SHIPMENT_AGGREGATE,
  RETURN_SHIPMENT_RESOLVED: RETURN_SHIPMENT_AGGREGATE,
} as const satisfies Record<InventoryEventName, string>;

export const PARTITION_SCOPES = {
  STOCK_ITEM: 'STOCK_ITEM',
  SHIPMENT: 'SHIPMENT',
  RETURN_SHIPMENT: 'RETURN_SHIPMENT',
  WAREHOUSE: 'WAREHOUSE',
} as const;

export type PartitionScope = (typeof PARTITION_SCOPES)[keyof typeof PARTITION_SCOPES];

export interface PartitionDecision {
  readonly scope: PartitionScope;
  readonly key: string;
}

type PartitionRule<N extends InventoryEventName> = (
  payload: InventoryEventPayload<N>,
) => PartitionDecision;

/**
 * The one place an inventory event's Kafka key is decided — a mapped type over the event union,
 * as marketplace-service's, so a new event name without a decision fails `pnpm typecheck`
 * rather than quietly inheriting the aggregate id.
 */
export const PARTITION_KEY_POLICY: { [N in InventoryEventName]: PartitionRule<N> } = {
  WAREHOUSE_CREATED: (payload) => ({ scope: 'WAREHOUSE', key: payload.warehouseId }),
  // ---- the stock stream: one partition per stock item, STRICT -------------
  STOCK_RECEIVED: (payload) => ({ scope: 'STOCK_ITEM', key: payload.stockItemId }),
  STOCK_ADJUSTED: (payload) => ({ scope: 'STOCK_ITEM', key: payload.stockItemId }),
  STOCK_RESERVED: (payload) => ({ scope: 'STOCK_ITEM', key: payload.stockItemId }),
  STOCK_RELEASED: (payload) => ({ scope: 'STOCK_ITEM', key: payload.stockItemId }),
  STOCK_ISSUED: (payload) => ({ scope: 'STOCK_ITEM', key: payload.stockItemId }),
  // ---- the shipment stream: one partition per shipment, STRICT -----------
  SHIPMENT_CREATED: (payload) => ({ scope: 'SHIPMENT', key: payload.shipmentId }),
  SHIPMENT_DISPATCHED: (payload) => ({ scope: 'SHIPMENT', key: payload.shipmentId }),
  SHIPMENT_DELIVERED: (payload) => ({ scope: 'SHIPMENT', key: payload.shipmentId }),
  // ---- the return-shipment stream: one partition per return shipment, STRICT ----
  RETURN_SHIPMENT_DISPATCHED: (payload) => ({
    scope: 'RETURN_SHIPMENT',
    key: payload.returnShipmentId,
  }),
  RETURN_SHIPMENT_RECEIVED: (payload) => ({
    scope: 'RETURN_SHIPMENT',
    key: payload.returnShipmentId,
  }),
  RETURN_SHIPMENT_INSPECTED: (payload) => ({
    scope: 'RETURN_SHIPMENT',
    key: payload.returnShipmentId,
  }),
  RETURN_SHIPMENT_RESOLVED: (payload) => ({
    scope: 'RETURN_SHIPMENT',
    key: payload.returnShipmentId,
  }),
};

/**
 * Decides the partition key for one already-validated payload. Refuses an empty key rather than
 * passing it on: Kafka round-robins a message with no key, which is exactly the loss of
 * ordering this policy exists to prevent.
 */
export function resolvePartitionKey<N extends InventoryEventName>(
  eventName: N,
  payload: InventoryEventPayload<N>,
): PartitionDecision {
  const rule = PARTITION_KEY_POLICY[eventName] as PartitionRule<N>;
  const decision = rule(payload);
  if (!decision.key) {
    throw new Error(
      `${eventName} resolved an empty ${decision.scope} partition key; ` +
        'publishing it would let Kafka round-robin the message and lose ordering',
    );
  }
  return decision;
}
