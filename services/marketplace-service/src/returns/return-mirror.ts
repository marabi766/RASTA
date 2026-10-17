import {
  DLQ_REASONS,
  INVENTORY_RETURN_EVENTS,
  INVENTORY_RETURN_EVENT_SCHEMAS,
  type EventEnvelope,
  type InventoryReturnEventName,
  type ReturnShipmentDispatchedPayload,
  type ReturnShipmentInspectedPayload,
  type ReturnShipmentReceivedPayload,
  type ReturnShipmentResolvedPayload,
} from '@rasta/contracts';
import { UnprocessableEventError } from '@rasta/nest-common';
import type { PhysicalReturnStatus, ReturnStatus } from './state-machine';

/**
 * The pure half of the return mirror (RUN-005 PR 3): what an inventory-service return event says,
 * and whether it may move the request it names. No database, no clock — `return-mirror.consumer.ts`
 * locks the request and calls these; the unit tests call them directly.
 *
 * Every refusal is an {@link UnprocessableEventError}: a verdict about the event, dead-lettered at
 * once. Its message names identifiers and fields only, never a payload value (S-09).
 */

/** The only event version this consumer reads; another is refused, never guessed at. */
export const MIRRORED_EVENT_VERSION = 1;

/**
 * A step of the shipment's stream and what it makes of the request: `seq` is
 * `returnShipmentVersion` (1 DISPATCHED … 4 RESOLVED), and the request reaches version `2 + seq`.
 */
export type MirrorStep =
  | {
      readonly eventName: 'RETURN_SHIPMENT_DISPATCHED';
      readonly seq: 1;
      readonly to: 'IN_TRANSIT';
      readonly payload: ReturnShipmentDispatchedPayload;
    }
  | {
      readonly eventName: 'RETURN_SHIPMENT_RECEIVED';
      readonly seq: 2;
      readonly to: 'RECEIVED';
      readonly payload: ReturnShipmentReceivedPayload;
    }
  | {
      readonly eventName: 'RETURN_SHIPMENT_INSPECTED';
      readonly seq: 3;
      readonly to: 'INSPECTED';
      readonly payload: ReturnShipmentInspectedPayload;
    }
  | {
      readonly eventName: 'RETURN_SHIPMENT_RESOLVED';
      readonly seq: 4;
      readonly to: 'RESOLVED';
      readonly payload: ReturnShipmentResolvedPayload;
    };

const STEP_OF: Record<InventoryReturnEventName, { seq: 1 | 2 | 3 | 4; to: PhysicalReturnStatus }> =
  {
    RETURN_SHIPMENT_DISPATCHED: { seq: 1, to: 'IN_TRANSIT' },
    RETURN_SHIPMENT_RECEIVED: { seq: 2, to: 'RECEIVED' },
    RETURN_SHIPMENT_INSPECTED: { seq: 3, to: 'INSPECTED' },
    RETURN_SHIPMENT_RESOLVED: { seq: 4, to: 'RESOLVED' },
  };

function isReturnEvent(name: string): name is InventoryReturnEventName {
  return Object.prototype.hasOwnProperty.call(INVENTORY_RETURN_EVENTS, name);
}

function refuse(
  reason: (typeof DLQ_REASONS)[keyof typeof DLQ_REASONS],
  envelope: EventEnvelope,
  why: string,
): UnprocessableEventError {
  return new UnprocessableEventError(reason, `${envelope.eventName} ${envelope.eventId}: ${why}`);
}

/**
 * What one event of `rasta.inventory.v1` is to the mirror: `null` for every event that is not a
 * return shipment's (stock, forward shipments) — skipped, never marked — or the step it states.
 *
 * Checked in this order, each a dead-letter verdict: the version this consumer reads; the payload
 * against the contract inventory validated it with; ADR-061 § 5 — the envelope's tenant is the
 * payload's organization (the destination warehouse's owner, the order's supplier); and, when the
 * envelope carries one, its `streamSeq` is the payload's position.
 */
export function mirrorStepOf(envelope: EventEnvelope): MirrorStep | null {
  if (!isReturnEvent(envelope.eventName)) return null;

  if (envelope.eventVersion !== MIRRORED_EVENT_VERSION) {
    throw refuse(
      DLQ_REASONS.SCHEMA_VERSION_UNSUPPORTED,
      envelope,
      `eventVersion ${String(envelope.eventVersion)} is not ${MIRRORED_EVENT_VERSION}`,
    );
  }
  const parsed = INVENTORY_RETURN_EVENT_SCHEMAS[envelope.eventName].safeParse(envelope.payload);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)')),
    ];
    throw refuse(
      DLQ_REASONS.VALIDATION_FAILED,
      envelope,
      `payload does not match its contract at ${fields.slice(0, 5).join(', ')}`,
    );
  }
  const payload = parsed.data;
  if (!envelope.tenantId || envelope.tenantId !== payload.organizationId) {
    throw refuse(
      DLQ_REASONS.SOURCE_UNCONFIRMED,
      envelope,
      'the envelope tenant is not the payload organizationId (ADR-061 § 5)',
    );
  }
  const step = STEP_OF[envelope.eventName];
  if (payload.returnShipmentVersion !== step.seq) {
    // The schema's literal makes this unreachable; kept so a contract change cannot skew the map.
    throw refuse(
      DLQ_REASONS.VALIDATION_FAILED,
      envelope,
      'returnShipmentVersion is not the event’s',
    );
  }
  if (envelope.streamSeq !== undefined && envelope.streamSeq !== step.seq) {
    throw refuse(
      DLQ_REASONS.VALIDATION_FAILED,
      envelope,
      `streamSeq ${envelope.streamSeq} is not returnShipmentVersion ${step.seq}`,
    );
  }
  return { eventName: envelope.eventName, ...step, payload } as MirrorStep;
}

/** The request as locked for the mirror: its parties, where it is, and its lines. */
export interface MirroredRequest {
  readonly id: string;
  /** The buyer — the tenant that owns the request. */
  readonly organizationId: string;
  readonly supplierOrganizationId: string;
  readonly orderId: string;
  readonly status: ReturnStatus;
  readonly version: number;
  readonly returnShipmentId: string | null;
  readonly lines: readonly { orderLineId: string; productId: string; quantity: number }[];
}

/** What the mirror's configuration decides (`MarketplaceEnv`, Q-133 (8)). */
export interface MirrorRules {
  /** `MARKETPLACE_RETURN_PARTIAL_DISPATCH_ALLOWED`: a shipment may name a subset. */
  readonly partialDispatchAllowed: boolean;
}

/**
 * - `APPLY`: the next step of this request's shipment — write it.
 * - `STALE`: a step at or below the one the request already reached, of the same shipment — a
 *   duplicate or a late redelivery; no effect (the contract's ordering rule).
 * - `AHEAD`: a later step before the one it follows — not applied out of order; the consumer
 *   retries it and, if its predecessor still has not arrived, dead-letters it for replay.
 */
export type MirrorDecision = 'APPLY' | 'STALE' | 'AHEAD';

/** How far the request's shipment has got: 0 while AUTHORIZED, then its step. */
function stepReached(request: MirroredRequest): number {
  return request.status === 'AUTHORIZED' ? 0 : request.version - 2;
}

const PHYSICAL: readonly ReturnStatus[] = ['IN_TRANSIT', 'RECEIVED', 'INSPECTED', 'RESOLVED'];

/**
 * Checks a step against the request it names (Q-133 (2)): it exists, its parties are the
 * event's, it was authorized and not withdrawn, the shipment is the one already on it, and —
 * for the step that applies — the lines are the request's. Refusals throw; the rest decide.
 *
 * Order matters for the tenant rule: the parties are compared before anything about the request
 * is told apart, so an event naming another buyer's request learns nothing more than "not
 * confirmed", and nothing is ever written for it.
 */
export function decideMirror(
  envelope: EventEnvelope,
  step: MirrorStep,
  request: MirroredRequest | null,
  rules: MirrorRules,
): MirrorDecision {
  const payload = step.payload;
  if (!request) {
    throw refuse(
      DLQ_REASONS.BUSINESS_RULE_VIOLATION,
      envelope,
      `return request ${payload.returnRequestId} does not exist here`,
    );
  }
  if (
    request.supplierOrganizationId !== envelope.tenantId ||
    request.organizationId !== payload.buyerOrganizationId ||
    request.orderId !== payload.orderId
  ) {
    throw refuse(
      DLQ_REASONS.SOURCE_UNCONFIRMED,
      envelope,
      `return request ${request.id} is not between the event's organizations or of its order`,
    );
  }
  if (request.status !== 'AUTHORIZED' && !PHYSICAL.includes(request.status)) {
    throw refuse(
      DLQ_REASONS.BUSINESS_RULE_VIOLATION,
      envelope,
      `return request ${request.id} is ${request.status}: goods move only for an AUTHORIZED one`,
    );
  }
  if (request.returnShipmentId !== null && request.returnShipmentId !== payload.returnShipmentId) {
    throw refuse(
      DLQ_REASONS.BUSINESS_RULE_VIOLATION,
      envelope,
      `return request ${request.id} already has another return shipment`,
    );
  }

  const reached = stepReached(request);
  if (step.seq <= reached) return 'STALE';
  if (step.seq > reached + 1) return 'AHEAD';

  assertLinesOfRequest(envelope, step, request, rules);
  return 'APPLY';
}

function assertLinesOfRequest(
  envelope: EventEnvelope,
  step: MirrorStep,
  request: MirroredRequest,
  rules: MirrorRules,
): void {
  const requested = new Map(request.lines.map((line) => [line.orderLineId, line]));
  const notOfRequest = (orderLineId: string) =>
    refuse(
      DLQ_REASONS.BUSINESS_RULE_VIOLATION,
      envelope,
      `order line ${orderLineId} is not returned by return request ${request.id}`,
    );
  const exceeds = (orderLineId: string, field: string) =>
    refuse(
      DLQ_REASONS.BUSINESS_RULE_VIOLATION,
      envelope,
      `${field} of order line ${orderLineId} exceeds what return request ${request.id} authorized`,
    );

  switch (step.eventName) {
    case 'RETURN_SHIPMENT_DISPATCHED':
    case 'RETURN_SHIPMENT_RECEIVED': {
      for (const line of step.payload.lines) {
        const own = requested.get(line.orderLineId);
        if (!own || own.productId !== line.productId) throw notOfRequest(line.orderLineId);
        if (line.expectedQuantity > own.quantity) {
          throw exceeds(line.orderLineId, 'expectedQuantity');
        }
        if (
          step.eventName === 'RETURN_SHIPMENT_DISPATCHED' &&
          !rules.partialDispatchAllowed &&
          line.expectedQuantity !== own.quantity
        ) {
          throw refuse(
            DLQ_REASONS.BUSINESS_RULE_VIOLATION,
            envelope,
            `order line ${line.orderLineId} is dispatched for other than what return request ` +
              `${request.id} authorized, and partial dispatch is not allowed (Q-133 (8))`,
          );
        }
      }
      if (step.eventName === 'RETURN_SHIPMENT_DISPATCHED' && !rules.partialDispatchAllowed) {
        const shipped = new Set(step.payload.lines.map((line) => line.orderLineId));
        const missing = request.lines.find((line) => !shipped.has(line.orderLineId));
        if (missing) {
          throw refuse(
            DLQ_REASONS.BUSINESS_RULE_VIOLATION,
            envelope,
            `order line ${missing.orderLineId} of return request ${request.id} is not on the ` +
              'shipment, and partial dispatch is not allowed (Q-133 (8))',
          );
        }
      }
      return;
    }
    case 'RETURN_SHIPMENT_INSPECTED':
      return;
    case 'RETURN_SHIPMENT_RESOLVED': {
      const units = new Map<string, number>();
      for (const row of step.payload.dispositions) {
        if (!requested.has(row.orderLineId)) throw notOfRequest(row.orderLineId);
        units.set(row.orderLineId, (units.get(row.orderLineId) ?? 0) + row.quantity);
      }
      for (const [orderLineId, quantity] of units) {
        if (quantity > requested.get(orderLineId)!.quantity) {
          throw exceeds(orderLineId, 'disposition quantity');
        }
      }
      return;
    }
  }
}
