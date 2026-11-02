import * as contracts from './index';
import { auditTrailPayloadSchemaV1 } from './events/audit-trail';
import { eventEnvelopeSchema } from './events/envelope';
import {
  INVENTORY_RETURN_EVENT_SCHEMAS,
  receivedReturnShipmentLineSchema,
} from './events/inventory-returns';
import { replayExecutedPayloadSchemaV1 } from './events/ops-replay';
import { PROCUREMENT_RFQ_EVENT_SCHEMAS } from './events/procurement-rfq';
import { RETURN_REQUEST_EVENT_SCHEMAS } from './events/return-requests';

/**
 * The PR #444 r3 differential corpus (Codex PR-444 r2 F1) for this workspace's
 * schema roots. Each case fails an integer check (a fraction, or ±Infinity
 * where text becomes a number) together with an enclosing refinement, or is a
 * reviewer's or a sibling class's reproduction; zod 3 reported both, zod 4
 * stopped at the integer. The roots are the exported schemas with an
 * integer under a refinement (`~/worker6/session/039/corpus`: `sweep.cjs`
 * inventory, `mkgolden.cjs`).
 *
 * Each `ZOD3` value was recorded by running this file unchanged on main
 * `5c88ae21` (zod 3.25.76), where `legacyParse` does not exist and
 * `outcome` reads zod 3's own issues (`~/worker2/session/t109/scripts/record.sh`);
 * never written by a test run here.
 */

type Issue = { path: readonly PropertyKey[]; code: string; message: string };
type LegacyParse = (schema: unknown, input: unknown) => { refusal?: { issues: readonly Issue[] } };

/** `[path, code, message]` per issue, in order, or `accepted`. */
function outcome(schema: { safeParse(input: unknown): unknown }, input: unknown): unknown {
  const legacyParse = (contracts as unknown as { legacyParse?: LegacyParse }).legacyParse;
  const issues = legacyParse
    ? legacyParse(schema, input).refusal?.issues
    : (schema.safeParse(input) as { error?: { issues: readonly Issue[] } }).error?.issues;
  if (issues === undefined) return 'accepted';
  return issues.map((issue) => [issue.path.map(String).join('.'), issue.code, issue.message]);
}

/** Recorded under zod 3 on main 5c88ae21; never written by a test run. */
const ZOD3: Record<string, unknown> = {
  'auditTrailPayloadSchemaV1 m1 occurrenceCount=0.5': [
    ['action', 'invalid_string', 'action must be a dotted verb, e.g. "asset.decommission"'],
    ['occurrenceCount', 'invalid_type', 'Expected integer, received float'],
    ['action', 'custom', 'correctionOf requires action === "audit.correction"'],
    ['outcome', 'custom', 'correctionOf requires outcome === "SUCCESS"'],
    ['actor.type', 'custom', 'correctionOf requires a human USER actor, never SERVICE or SYSTEM'],
  ],
  'auditTrailPayloadSchemaV1 m1 occurrenceCount=Infinity': [
    ['action', 'invalid_string', 'action must be a dotted verb, e.g. "asset.decommission"'],
    ['occurrenceCount', 'invalid_type', 'Expected integer, received float'],
    ['action', 'custom', 'correctionOf requires action === "audit.correction"'],
    ['outcome', 'custom', 'correctionOf requires outcome === "SUCCESS"'],
    ['actor.type', 'custom', 'correctionOf requires a human USER actor, never SERVICE or SYSTEM'],
  ],
  'INVENTORY_RETURN_EVENT_SCHEMAS.RETURN_SHIPMENT_DISPATCHED m0 same buyerOrganizationId + lines.0.expectedQuantity=0.5':
    [
      ['returnShipmentId', 'invalid_string', 'Invalid'],
      ['returnRequestId', 'invalid_string', 'Invalid'],
      ['orderId', 'invalid_string', 'Invalid'],
      ['buyerOrganizationId', 'custom', 'Expected an identifier of the form ORG_<ULID>'],
      ['destinationWarehouseId', 'invalid_string', 'Invalid'],
      ['trackingEventId', 'invalid_string', 'Invalid'],
      ['lines.0.expectedQuantity', 'invalid_type', 'Expected integer, received float'],
      ['lines.0.expectedQuantity', 'too_small', 'Number must be greater than or equal to 1'],
    ],
  'INVENTORY_RETURN_EVENT_SCHEMAS.RETURN_SHIPMENT_DISPATCHED m0 same buyerOrganizationId + lines.0.expectedQuantity=Infinity':
    [
      ['returnShipmentId', 'invalid_string', 'Invalid'],
      ['returnRequestId', 'invalid_string', 'Invalid'],
      ['orderId', 'invalid_string', 'Invalid'],
      ['buyerOrganizationId', 'custom', 'Expected an identifier of the form ORG_<ULID>'],
      ['destinationWarehouseId', 'invalid_string', 'Invalid'],
      ['trackingEventId', 'invalid_string', 'Invalid'],
      ['lines.0.expectedQuantity', 'invalid_type', 'Expected integer, received float'],
    ],
  'INVENTORY_RETURN_EVENT_SCHEMAS.RETURN_SHIPMENT_RECEIVED m0 lines.0.expectedQuantity=0.5': [
    ['returnShipmentId', 'invalid_string', 'Invalid'],
    ['returnRequestId', 'invalid_string', 'Invalid'],
    ['orderId', 'invalid_string', 'Invalid'],
    ['destinationWarehouseId', 'invalid_string', 'Invalid'],
    ['trackingEventId', 'invalid_string', 'Invalid'],
    ['lines.0.expectedQuantity', 'invalid_type', 'Expected integer, received float'],
    ['lines.0.expectedQuantity', 'too_small', 'Number must be greater than or equal to 1'],
    ['lines.0.receivedQuantity', 'custom', 'receivedQuantity exceeds expectedQuantity'],
  ],
  'INVENTORY_RETURN_EVENT_SCHEMAS.RETURN_SHIPMENT_RECEIVED m0 lines.0.expectedQuantity=Infinity': [
    ['returnShipmentId', 'invalid_string', 'Invalid'],
    ['returnRequestId', 'invalid_string', 'Invalid'],
    ['orderId', 'invalid_string', 'Invalid'],
    ['destinationWarehouseId', 'invalid_string', 'Invalid'],
    ['trackingEventId', 'invalid_string', 'Invalid'],
    ['lines.0.expectedQuantity', 'invalid_type', 'Expected integer, received float'],
  ],
  'INVENTORY_RETURN_EVENT_SCHEMAS.RETURN_SHIPMENT_RESOLVED m0 same buyerOrganizationId + dispositions.0.quantity=0.5':
    [
      ['returnShipmentId', 'invalid_string', 'Invalid'],
      ['returnRequestId', 'invalid_string', 'Invalid'],
      ['orderId', 'invalid_string', 'Invalid'],
      ['buyerOrganizationId', 'custom', 'Expected an identifier of the form ORG_<ULID>'],
      ['destinationWarehouseId', 'invalid_string', 'Invalid'],
      ['trackingEventId', 'invalid_string', 'Invalid'],
      ['dispositions.0.quantity', 'invalid_type', 'Expected integer, received float'],
      ['dispositions.0.quantity', 'too_small', 'Number must be greater than or equal to 1'],
    ],
  'INVENTORY_RETURN_EVENT_SCHEMAS.RETURN_SHIPMENT_RESOLVED m0 same buyerOrganizationId + dispositions.0.quantity=Infinity':
    [
      ['returnShipmentId', 'invalid_string', 'Invalid'],
      ['returnRequestId', 'invalid_string', 'Invalid'],
      ['orderId', 'invalid_string', 'Invalid'],
      ['buyerOrganizationId', 'custom', 'Expected an identifier of the form ORG_<ULID>'],
      ['destinationWarehouseId', 'invalid_string', 'Invalid'],
      ['trackingEventId', 'invalid_string', 'Invalid'],
      ['dispositions.0.quantity', 'invalid_type', 'Expected integer, received float'],
    ],
  'receivedReturnShipmentLineSchema m0 expectedQuantity=0.5': [
    ['expectedQuantity', 'invalid_type', 'Expected integer, received float'],
    ['expectedQuantity', 'too_small', 'Number must be greater than or equal to 1'],
    ['receivedQuantity', 'custom', 'receivedQuantity exceeds expectedQuantity'],
  ],
  'receivedReturnShipmentLineSchema m0 expectedQuantity=Infinity': [
    ['expectedQuantity', 'invalid_type', 'Expected integer, received float'],
  ],
  'replayExecutedPayloadSchemaV1 m0 dlq.partition=0.5': [
    ['reportId', 'invalid_string', 'Invalid'],
    ['dlq.topic', 'invalid_string', 'Invalid'],
    ['dlq.partition', 'invalid_type', 'Expected integer, received float'],
    ['target.topic', 'invalid_string', 'Invalid'],
    ['dlq.topic', 'custom', 'a replay reads a dead-letter topic'],
    ['target.topic', 'custom', 'a replay writes a .retry topic'],
  ],
  'replayExecutedPayloadSchemaV1 m0 dlq.partition=Infinity': [
    ['reportId', 'invalid_string', 'Invalid'],
    ['dlq.topic', 'invalid_string', 'Invalid'],
    ['dlq.partition', 'invalid_type', 'Expected integer, received float'],
    ['dlq.partition', 'too_big', 'Number must be less than or equal to 1000000'],
    ['target.topic', 'invalid_string', 'Invalid'],
    ['dlq.topic', 'custom', 'a replay reads a dead-letter topic'],
    ['target.topic', 'custom', 'a replay writes a .retry topic'],
  ],
  'PROCUREMENT_RFQ_EVENT_SCHEMAS.RFQ_CLOSED m0 rfqVersion=0.5': [
    ['rfqId', 'invalid_string', 'Invalid'],
    ['aggregationId', 'invalid_string', 'Invalid'],
    ['rfqVersion', 'invalid_type', 'Expected integer, received float'],
    ['rfqVersion', 'too_small', 'Number must be greater than or equal to 1'],
    ['', 'custom', 'A person closes MANUAL; the sweeper closes with no person'],
  ],
  'PROCUREMENT_RFQ_EVENT_SCHEMAS.RFQ_CLOSED m0 rfqVersion=Infinity': [
    ['rfqId', 'invalid_string', 'Invalid'],
    ['aggregationId', 'invalid_string', 'Invalid'],
    ['rfqVersion', 'invalid_type', 'Expected integer, received float'],
    ['', 'custom', 'A person closes MANUAL; the sweeper closes with no person'],
  ],
  'RETURN_REQUEST_EVENT_SCHEMAS.RETURN_CANCELLED m0 same buyerOrganizationId + lines.0.quantity=0.5':
    [
      ['returnRequestId', 'invalid_string', 'Invalid'],
      ['orderId', 'invalid_string', 'Invalid'],
      ['buyerOrganizationId', 'custom', 'Expected an identifier of the form ORG_<ULID>'],
      ['lines.0.quantity', 'invalid_type', 'Expected integer, received float'],
      ['lines.0.quantity', 'too_small', 'Number must be greater than or equal to 1'],
    ],
  'RETURN_REQUEST_EVENT_SCHEMAS.RETURN_CANCELLED m0 same buyerOrganizationId + lines.0.quantity=Infinity':
    [
      ['returnRequestId', 'invalid_string', 'Invalid'],
      ['orderId', 'invalid_string', 'Invalid'],
      ['buyerOrganizationId', 'custom', 'Expected an identifier of the form ORG_<ULID>'],
      ['lines.0.quantity', 'invalid_type', 'Expected integer, received float'],
    ],
  'RETURN_REQUEST_EVENT_SCHEMAS.RETURN_RECEIVED m0 same buyerOrganizationId + lines.0.quantity=0.5':
    [
      ['returnRequestId', 'invalid_string', 'Invalid'],
      ['orderId', 'invalid_string', 'Invalid'],
      ['buyerOrganizationId', 'custom', 'Expected an identifier of the form ORG_<ULID>'],
      ['lines.0.quantity', 'invalid_type', 'Expected integer, received float'],
      ['lines.0.quantity', 'too_small', 'Number must be greater than or equal to 1'],
      ['returnShipmentId', 'invalid_string', 'Invalid'],
    ],
  'RETURN_REQUEST_EVENT_SCHEMAS.RETURN_RECEIVED m0 same buyerOrganizationId + lines.0.quantity=Infinity':
    [
      ['returnRequestId', 'invalid_string', 'Invalid'],
      ['orderId', 'invalid_string', 'Invalid'],
      ['buyerOrganizationId', 'custom', 'Expected an identifier of the form ORG_<ULID>'],
      ['lines.0.quantity', 'invalid_type', 'Expected integer, received float'],
      ['returnShipmentId', 'invalid_string', 'Invalid'],
    ],
  'RETURN_REQUEST_EVENT_SCHEMAS.RETURN_RESOLVED m0 same buyerOrganizationId + lines.0.quantity=0.5':
    [
      ['returnRequestId', 'invalid_string', 'Invalid'],
      ['orderId', 'invalid_string', 'Invalid'],
      ['buyerOrganizationId', 'custom', 'Expected an identifier of the form ORG_<ULID>'],
      ['lines.0.quantity', 'invalid_type', 'Expected integer, received float'],
      ['lines.0.quantity', 'too_small', 'Number must be greater than or equal to 1'],
      ['returnShipmentId', 'invalid_string', 'Invalid'],
    ],
  'RETURN_REQUEST_EVENT_SCHEMAS.RETURN_RESOLVED m0 same buyerOrganizationId + lines.0.quantity=Infinity':
    [
      ['returnRequestId', 'invalid_string', 'Invalid'],
      ['orderId', 'invalid_string', 'Invalid'],
      ['buyerOrganizationId', 'custom', 'Expected an identifier of the form ORG_<ULID>'],
      ['lines.0.quantity', 'invalid_type', 'Expected integer, received float'],
      ['returnShipmentId', 'invalid_string', 'Invalid'],
    ],
  'eventEnvelopeSchema sibling: zod 3’s .safe() after .int()': [
    ['streamSeq', 'invalid_type', 'Expected integer, received float'],
  ],
  'eventEnvelopeSchema sibling: zod 3’s .safe() after .int(), ±Infinity': [
    ['streamSeq', 'invalid_type', 'Expected integer, received float'],
    ['streamSeq', 'too_big', 'Number must be less than or equal to 9007199254740991'],
  ],
};

const CASES: [string, { safeParse(input: unknown): unknown }, unknown][] = [
  [
    'auditTrailPayloadSchemaV1 m1 occurrenceCount=0.5',
    auditTrailPayloadSchemaV1,
    {
      actor: { type: 'SERVICE', id: 'ORG-SAMPLE', roles: ['Sample', 'Sample'] },
      organizationId: 'ORG-SAMPLE',
      action: 'x',
      resourceType: 'Sample',
      resourceId: 'ORG-SAMPLE',
      outcome: 'FAILURE',
      errorCode: 'MALFORMED_REQUEST',
      reason: 'Sample',
      changes: [
        { field: 'Sample', from: { redacted: true }, to: { redacted: true } },
        { field: 'Sample', from: { redacted: true }, to: { redacted: true } },
      ],
      occurrenceCount: 0.5,
      source: { ip: 'Sample', userAgent: 'Sample' },
      correctionOf: 'Sample',
    },
  ],
  [
    'auditTrailPayloadSchemaV1 m1 occurrenceCount=Infinity',
    auditTrailPayloadSchemaV1,
    {
      actor: { type: 'SERVICE', id: 'ORG-SAMPLE', roles: ['Sample', 'Sample'] },
      organizationId: 'ORG-SAMPLE',
      action: 'x',
      resourceType: 'Sample',
      resourceId: 'ORG-SAMPLE',
      outcome: 'FAILURE',
      errorCode: 'MALFORMED_REQUEST',
      reason: 'Sample',
      changes: [
        { field: 'Sample', from: { redacted: true }, to: { redacted: true } },
        { field: 'Sample', from: { redacted: true }, to: { redacted: true } },
      ],
      occurrenceCount: Number.POSITIVE_INFINITY,
      source: { ip: 'Sample', userAgent: 'Sample' },
      correctionOf: 'Sample',
    },
  ],
  [
    'INVENTORY_RETURN_EVENT_SCHEMAS.RETURN_SHIPMENT_DISPATCHED m0 same buyerOrganizationId + lines.0.expectedQuantity=0.5',
    INVENTORY_RETURN_EVENT_SCHEMAS.RETURN_SHIPMENT_DISPATCHED,
    {
      returnShipmentId: 'x',
      organizationId: 'ORG-SAMPLE',
      returnRequestId: 'x',
      orderId: 'x',
      buyerOrganizationId: 'Sample',
      destinationWarehouseId: 'x',
      trackingEventId: 'x',
      returnShipmentVersion: 1,
      lines: [{ orderLineId: 'ORG-SAMPLE', productId: 'ORG-SAMPLE', expectedQuantity: 0.5 }],
      dispatchedBy: 'Sample',
      dispatchedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  [
    'INVENTORY_RETURN_EVENT_SCHEMAS.RETURN_SHIPMENT_DISPATCHED m0 same buyerOrganizationId + lines.0.expectedQuantity=Infinity',
    INVENTORY_RETURN_EVENT_SCHEMAS.RETURN_SHIPMENT_DISPATCHED,
    {
      returnShipmentId: 'x',
      organizationId: 'ORG-SAMPLE',
      returnRequestId: 'x',
      orderId: 'x',
      buyerOrganizationId: 'Sample',
      destinationWarehouseId: 'x',
      trackingEventId: 'x',
      returnShipmentVersion: 1,
      lines: [
        {
          orderLineId: 'ORG-SAMPLE',
          productId: 'ORG-SAMPLE',
          expectedQuantity: Number.POSITIVE_INFINITY,
        },
      ],
      dispatchedBy: 'Sample',
      dispatchedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  [
    'INVENTORY_RETURN_EVENT_SCHEMAS.RETURN_SHIPMENT_RECEIVED m0 lines.0.expectedQuantity=0.5',
    INVENTORY_RETURN_EVENT_SCHEMAS.RETURN_SHIPMENT_RECEIVED,
    {
      returnShipmentId: 'x',
      organizationId: 'ORG-SAMPLE',
      returnRequestId: 'x',
      orderId: 'x',
      buyerOrganizationId: 'ORG_01JB9V5Q6K8M2N4P7R3S5T7V9X',
      destinationWarehouseId: 'x',
      trackingEventId: 'x',
      returnShipmentVersion: 2,
      lines: [
        {
          orderLineId: 'ORG-SAMPLE',
          productId: 'ORG-SAMPLE',
          expectedQuantity: 0.5,
          receivedQuantity: 1,
        },
      ],
      receivedBy: 'Sample',
      receivedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  [
    'INVENTORY_RETURN_EVENT_SCHEMAS.RETURN_SHIPMENT_RECEIVED m0 lines.0.expectedQuantity=Infinity',
    INVENTORY_RETURN_EVENT_SCHEMAS.RETURN_SHIPMENT_RECEIVED,
    {
      returnShipmentId: 'x',
      organizationId: 'ORG-SAMPLE',
      returnRequestId: 'x',
      orderId: 'x',
      buyerOrganizationId: 'ORG_01JB9V5Q6K8M2N4P7R3S5T7V9X',
      destinationWarehouseId: 'x',
      trackingEventId: 'x',
      returnShipmentVersion: 2,
      lines: [
        {
          orderLineId: 'ORG-SAMPLE',
          productId: 'ORG-SAMPLE',
          expectedQuantity: Number.POSITIVE_INFINITY,
          receivedQuantity: 1,
        },
      ],
      receivedBy: 'Sample',
      receivedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  [
    'INVENTORY_RETURN_EVENT_SCHEMAS.RETURN_SHIPMENT_RESOLVED m0 same buyerOrganizationId + dispositions.0.quantity=0.5',
    INVENTORY_RETURN_EVENT_SCHEMAS.RETURN_SHIPMENT_RESOLVED,
    {
      returnShipmentId: 'x',
      organizationId: 'ORG-SAMPLE',
      returnRequestId: 'x',
      orderId: 'x',
      buyerOrganizationId: 'Sample',
      destinationWarehouseId: 'x',
      trackingEventId: 'x',
      returnShipmentVersion: 4,
      dispositions: [{ orderLineId: 'ORG-SAMPLE', disposition: 'RESTOCK', quantity: 0.5 }],
      resolvedBy: 'Sample',
      resolvedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  [
    'INVENTORY_RETURN_EVENT_SCHEMAS.RETURN_SHIPMENT_RESOLVED m0 same buyerOrganizationId + dispositions.0.quantity=Infinity',
    INVENTORY_RETURN_EVENT_SCHEMAS.RETURN_SHIPMENT_RESOLVED,
    {
      returnShipmentId: 'x',
      organizationId: 'ORG-SAMPLE',
      returnRequestId: 'x',
      orderId: 'x',
      buyerOrganizationId: 'Sample',
      destinationWarehouseId: 'x',
      trackingEventId: 'x',
      returnShipmentVersion: 4,
      dispositions: [
        { orderLineId: 'ORG-SAMPLE', disposition: 'RESTOCK', quantity: Number.POSITIVE_INFINITY },
      ],
      resolvedBy: 'Sample',
      resolvedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  [
    'receivedReturnShipmentLineSchema m0 expectedQuantity=0.5',
    receivedReturnShipmentLineSchema,
    {
      orderLineId: 'ORG-SAMPLE',
      productId: 'ORG-SAMPLE',
      expectedQuantity: 0.5,
      receivedQuantity: 1,
    },
  ],
  [
    'receivedReturnShipmentLineSchema m0 expectedQuantity=Infinity',
    receivedReturnShipmentLineSchema,
    {
      orderLineId: 'ORG-SAMPLE',
      productId: 'ORG-SAMPLE',
      expectedQuantity: Number.POSITIVE_INFINITY,
      receivedQuantity: 1,
    },
  ],
  [
    'replayExecutedPayloadSchemaV1 m0 dlq.partition=0.5',
    replayExecutedPayloadSchemaV1,
    {
      reportId: 'x',
      operator: 'Sample',
      replayedEvent: { eventId: 'ORG-SAMPLE', eventName: 'CRIT' },
      dlq: { topic: 'x', partition: 0.5, offset: '1000' },
      target: { topic: 'x', partition: 1, offset: '1000' },
      stale: false,
    },
  ],
  [
    'replayExecutedPayloadSchemaV1 m0 dlq.partition=Infinity',
    replayExecutedPayloadSchemaV1,
    {
      reportId: 'x',
      operator: 'Sample',
      replayedEvent: { eventId: 'ORG-SAMPLE', eventName: 'CRIT' },
      dlq: { topic: 'x', partition: Number.POSITIVE_INFINITY, offset: '1000' },
      target: { topic: 'x', partition: 1, offset: '1000' },
      stale: false,
    },
  ],
  [
    'PROCUREMENT_RFQ_EVENT_SCHEMAS.RFQ_CLOSED m0 rfqVersion=0.5',
    PROCUREMENT_RFQ_EVENT_SCHEMAS.RFQ_CLOSED,
    {
      rfqId: 'x',
      organizationId: 'ORG-SAMPLE',
      aggregationId: 'x',
      rfqVersion: 0.5,
      quotationClosingAt: '2026-10-01T00:00:00.000Z',
      trigger: 'SWEEPER',
      closedBy: 'Sample',
      closedAt: '2026-10-01T00:00:00.000Z',
      quotationCount: 1,
    },
  ],
  [
    'PROCUREMENT_RFQ_EVENT_SCHEMAS.RFQ_CLOSED m0 rfqVersion=Infinity',
    PROCUREMENT_RFQ_EVENT_SCHEMAS.RFQ_CLOSED,
    {
      rfqId: 'x',
      organizationId: 'ORG-SAMPLE',
      aggregationId: 'x',
      rfqVersion: Number.POSITIVE_INFINITY,
      quotationClosingAt: '2026-10-01T00:00:00.000Z',
      trigger: 'SWEEPER',
      closedBy: 'Sample',
      closedAt: '2026-10-01T00:00:00.000Z',
      quotationCount: 1,
    },
  ],
  [
    'RETURN_REQUEST_EVENT_SCHEMAS.RETURN_CANCELLED m0 same buyerOrganizationId + lines.0.quantity=0.5',
    RETURN_REQUEST_EVENT_SCHEMAS.RETURN_CANCELLED,
    {
      returnRequestId: 'x',
      orderId: 'x',
      buyerOrganizationId: 'Sample',
      supplierOrganizationId: 'ORG_01JB9V5Q6K8M2N4P7R3S5T7V9X',
      lines: [{ orderLineId: 'ORG-SAMPLE', productId: 'ORG-SAMPLE', quantity: 0.5 }],
      returnVersion: 2,
      cancelledFrom: 'REQUESTED',
      cancelledBy: 'Sample',
      cancelledAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  [
    'RETURN_REQUEST_EVENT_SCHEMAS.RETURN_CANCELLED m0 same buyerOrganizationId + lines.0.quantity=Infinity',
    RETURN_REQUEST_EVENT_SCHEMAS.RETURN_CANCELLED,
    {
      returnRequestId: 'x',
      orderId: 'x',
      buyerOrganizationId: 'Sample',
      supplierOrganizationId: 'ORG_01JB9V5Q6K8M2N4P7R3S5T7V9X',
      lines: [
        { orderLineId: 'ORG-SAMPLE', productId: 'ORG-SAMPLE', quantity: Number.POSITIVE_INFINITY },
      ],
      returnVersion: 2,
      cancelledFrom: 'REQUESTED',
      cancelledBy: 'Sample',
      cancelledAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  [
    'RETURN_REQUEST_EVENT_SCHEMAS.RETURN_RECEIVED m0 same buyerOrganizationId + lines.0.quantity=0.5',
    RETURN_REQUEST_EVENT_SCHEMAS.RETURN_RECEIVED,
    {
      returnRequestId: 'x',
      orderId: 'x',
      buyerOrganizationId: 'Sample',
      supplierOrganizationId: 'ORG_01JB9V5Q6K8M2N4P7R3S5T7V9X',
      lines: [{ orderLineId: 'ORG-SAMPLE', productId: 'ORG-SAMPLE', quantity: 0.5 }],
      returnVersion: 4,
      returnShipmentId: 'x',
      receivedLines: [{ orderLineId: 'ORG-SAMPLE', receivedQuantity: 1 }],
      receivedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  [
    'RETURN_REQUEST_EVENT_SCHEMAS.RETURN_RECEIVED m0 same buyerOrganizationId + lines.0.quantity=Infinity',
    RETURN_REQUEST_EVENT_SCHEMAS.RETURN_RECEIVED,
    {
      returnRequestId: 'x',
      orderId: 'x',
      buyerOrganizationId: 'Sample',
      supplierOrganizationId: 'ORG_01JB9V5Q6K8M2N4P7R3S5T7V9X',
      lines: [
        { orderLineId: 'ORG-SAMPLE', productId: 'ORG-SAMPLE', quantity: Number.POSITIVE_INFINITY },
      ],
      returnVersion: 4,
      returnShipmentId: 'x',
      receivedLines: [{ orderLineId: 'ORG-SAMPLE', receivedQuantity: 1 }],
      receivedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  [
    'RETURN_REQUEST_EVENT_SCHEMAS.RETURN_RESOLVED m0 same buyerOrganizationId + lines.0.quantity=0.5',
    RETURN_REQUEST_EVENT_SCHEMAS.RETURN_RESOLVED,
    {
      returnRequestId: 'x',
      orderId: 'x',
      buyerOrganizationId: 'Sample',
      supplierOrganizationId: 'ORG_01JB9V5Q6K8M2N4P7R3S5T7V9X',
      lines: [{ orderLineId: 'ORG-SAMPLE', productId: 'ORG-SAMPLE', quantity: 0.5 }],
      returnVersion: 6,
      returnShipmentId: 'x',
      outcomes: [{ orderLineId: 'ORG-SAMPLE', disposition: 'RESTOCK', quantity: 1 }],
      resolvedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  [
    'RETURN_REQUEST_EVENT_SCHEMAS.RETURN_RESOLVED m0 same buyerOrganizationId + lines.0.quantity=Infinity',
    RETURN_REQUEST_EVENT_SCHEMAS.RETURN_RESOLVED,
    {
      returnRequestId: 'x',
      orderId: 'x',
      buyerOrganizationId: 'Sample',
      supplierOrganizationId: 'ORG_01JB9V5Q6K8M2N4P7R3S5T7V9X',
      lines: [
        { orderLineId: 'ORG-SAMPLE', productId: 'ORG-SAMPLE', quantity: Number.POSITIVE_INFINITY },
      ],
      returnVersion: 6,
      returnShipmentId: 'x',
      outcomes: [{ orderLineId: 'ORG-SAMPLE', disposition: 'RESTOCK', quantity: 1 }],
      resolvedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  [
    'eventEnvelopeSchema sibling: zod 3’s .safe() after .int()',
    eventEnvelopeSchema,
    {
      eventId: 'ORG-SAMPLE',
      eventName: 'CRIT',
      occurredAt: '2026-10-01T00:00:00.000Z',
      producer: 'foo',
      aggregateType: 'Sample',
      aggregateId: 'ORG-SAMPLE',
      correlationId: 'ORG-SAMPLE',
      streamSeq: 0.5,
    },
  ],
  [
    'eventEnvelopeSchema sibling: zod 3’s .safe() after .int(), ±Infinity',
    eventEnvelopeSchema,
    {
      eventId: 'ORG-SAMPLE',
      eventName: 'CRIT',
      occurredAt: '2026-10-01T00:00:00.000Z',
      producer: 'foo',
      aggregateType: 'Sample',
      aggregateId: 'ORG-SAMPLE',
      correlationId: 'ORG-SAMPLE',
      streamSeq: Number.POSITIVE_INFINITY,
    },
  ],
];

describe('zod 3 diagnostics: an integer refusal with its enclosing refinements (PR #444 r3)', () => {
  it.each(CASES)('%s', (name, schema, input) => {
    const observed = outcome(schema, input);
    expect(observed).toEqual(ZOD3[name]);
  });
});
