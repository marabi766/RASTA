import * as contracts from '@rasta/contracts';
import { INVENTORY_EVENT_SCHEMAS } from './events/events';
import { reserveStockSchema } from './reservation/dto';
import { createReturnShipmentSchema, resolveReturnShipmentSchema } from './return-shipment/dto';
import { adjustStockSchema } from './stock/dto';

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
  'INVENTORY_EVENT_SCHEMAS.STOCK_ADJUSTED m0 zero quantityDelta + itemVersion=0.5': [
    ['itemVersion', 'invalid_type', 'Expected integer, received float'],
    ['itemVersion', 'too_small', 'Number must be greater than or equal to 1'],
    ['quantityDelta', 'custom', 'quantityDelta is never zero'],
    ['sourceReference', 'invalid_string', 'Invalid'],
  ],
  'INVENTORY_EVENT_SCHEMAS.STOCK_ADJUSTED m0 zero quantityDelta + itemVersion=Infinity': [
    ['itemVersion', 'invalid_type', 'Expected integer, received float'],
    ['quantityDelta', 'custom', 'quantityDelta is never zero'],
    ['sourceReference', 'invalid_string', 'Invalid'],
  ],
  'reserveStockSchema m0 dup lines + lines.0.quantity=0.5': [
    ['lines.0.stockItemId', 'invalid_string', 'Invalid'],
    ['lines.0.quantity', 'invalid_type', 'Expected integer, received float'],
    ['lines.0.quantity', 'too_small', 'Number must be greater than or equal to 1'],
    ['lines.1.stockItemId', 'invalid_string', 'Invalid'],
    ['lines', 'custom', 'Each stock item appears once'],
  ],
  'reserveStockSchema m0 dup lines + lines.0.quantity=Infinity': [
    ['lines.0.stockItemId', 'invalid_string', 'Invalid'],
    ['lines.0.quantity', 'invalid_type', 'Expected integer, received float'],
    ['lines.0.quantity', 'too_big', 'Number must be less than or equal to 2147483647'],
    ['lines.1.stockItemId', 'invalid_string', 'Invalid'],
    ['lines', 'custom', 'Each stock item appears once'],
  ],
  'createReturnShipmentSchema m0 dup lines + lines.0.quantity=0.5': [
    ['returnRequestId', 'invalid_string', 'Invalid'],
    ['orderId', 'invalid_string', 'Invalid'],
    ['destinationWarehouseId', 'invalid_string', 'Invalid'],
    ['lines.0.orderLineId', 'invalid_string', 'Invalid'],
    ['lines.0.productId', 'invalid_string', 'Invalid'],
    ['lines.0.quantity', 'invalid_type', 'Expected integer, received float'],
    ['lines.0.quantity', 'too_small', 'Number must be greater than or equal to 1'],
    ['lines.1.orderLineId', 'invalid_string', 'Invalid'],
    ['lines.1.productId', 'invalid_string', 'Invalid'],
    ['lines.1.orderLineId', 'custom', 'An order line may appear once in a return shipment'],
  ],
  'createReturnShipmentSchema m0 dup lines + lines.0.quantity=Infinity': [
    ['returnRequestId', 'invalid_string', 'Invalid'],
    ['orderId', 'invalid_string', 'Invalid'],
    ['destinationWarehouseId', 'invalid_string', 'Invalid'],
    ['lines.0.orderLineId', 'invalid_string', 'Invalid'],
    ['lines.0.productId', 'invalid_string', 'Invalid'],
    ['lines.0.quantity', 'invalid_type', 'Expected integer, received float'],
    ['lines.0.quantity', 'too_big', 'Number must be less than or equal to 2147483647'],
    ['lines.1.orderLineId', 'invalid_string', 'Invalid'],
    ['lines.1.productId', 'invalid_string', 'Invalid'],
    ['lines.1.orderLineId', 'custom', 'An order line may appear once in a return shipment'],
  ],
  'resolveReturnShipmentSchema m1 expectedVersion=0.5': [
    ['expectedVersion', 'invalid_type', 'Expected integer, received float'],
    ['expectedVersion', 'too_small', 'Number must be greater than or equal to 1'],
    ['dispositions.0.orderLineId', 'invalid_string', 'Invalid'],
    ['dispositions.1.orderLineId', 'invalid_string', 'Invalid'],
    ['dispositions.1.disposition', 'custom', 'A line has one row per disposition'],
  ],
  'resolveReturnShipmentSchema m1 expectedVersion=Infinity': [
    ['expectedVersion', 'invalid_type', 'Expected integer, received float'],
    ['dispositions.0.orderLineId', 'invalid_string', 'Invalid'],
    ['dispositions.1.orderLineId', 'invalid_string', 'Invalid'],
    ['dispositions.1.disposition', 'custom', 'A line has one row per disposition'],
  ],
  'adjustStockSchema m0 quantityDelta=0.5 (no refinement can fail with it)': [
    ['stockItemId', 'invalid_string', 'Invalid'],
    ['quantityDelta', 'invalid_type', 'Expected integer, received float'],
  ],
};

const CASES: [string, { safeParse(input: unknown): unknown }, unknown][] = [
  [
    'INVENTORY_EVENT_SCHEMAS.STOCK_ADJUSTED m0 zero quantityDelta + itemVersion=0.5',
    INVENTORY_EVENT_SCHEMAS.STOCK_ADJUSTED,
    {
      stockItemId: 'ORG-SAMPLE',
      warehouseId: 'ORG-SAMPLE',
      productId: 'ORG-SAMPLE',
      organizationId: 'ORG-SAMPLE',
      movementId: 'ORG-SAMPLE',
      itemVersion: 0.5,
      onHandAfter: 1,
      reservedAfter: 1,
      quantityDelta: 0,
      sourceReference: 'x',
      adjustedBy: 'Sample',
      adjustedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  [
    'INVENTORY_EVENT_SCHEMAS.STOCK_ADJUSTED m0 zero quantityDelta + itemVersion=Infinity',
    INVENTORY_EVENT_SCHEMAS.STOCK_ADJUSTED,
    {
      stockItemId: 'ORG-SAMPLE',
      warehouseId: 'ORG-SAMPLE',
      productId: 'ORG-SAMPLE',
      organizationId: 'ORG-SAMPLE',
      movementId: 'ORG-SAMPLE',
      itemVersion: Number.POSITIVE_INFINITY,
      onHandAfter: 1,
      reservedAfter: 1,
      quantityDelta: 0,
      sourceReference: 'x',
      adjustedBy: 'Sample',
      adjustedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  [
    'reserveStockSchema m0 dup lines + lines.0.quantity=0.5',
    reserveStockSchema,
    {
      lines: [
        { stockItemId: 'x', quantity: 0.5 },
        { stockItemId: 'x', quantity: 1 },
      ],
    },
  ],
  [
    'reserveStockSchema m0 dup lines + lines.0.quantity=Infinity',
    reserveStockSchema,
    {
      lines: [
        { stockItemId: 'x', quantity: Number.POSITIVE_INFINITY },
        { stockItemId: 'x', quantity: 1 },
      ],
    },
  ],
  [
    'createReturnShipmentSchema m0 dup lines + lines.0.quantity=0.5',
    createReturnShipmentSchema,
    {
      returnRequestId: 'x',
      orderId: 'x',
      buyerOrganizationId: 'ORG-SAMPLE',
      destinationWarehouseId: 'x',
      lines: [
        { orderLineId: 'x', productId: 'x', quantity: 0.5 },
        { orderLineId: 'x', productId: 'x', quantity: 1 },
      ],
    },
  ],
  [
    'createReturnShipmentSchema m0 dup lines + lines.0.quantity=Infinity',
    createReturnShipmentSchema,
    {
      returnRequestId: 'x',
      orderId: 'x',
      buyerOrganizationId: 'ORG-SAMPLE',
      destinationWarehouseId: 'x',
      lines: [
        { orderLineId: 'x', productId: 'x', quantity: Number.POSITIVE_INFINITY },
        { orderLineId: 'x', productId: 'x', quantity: 1 },
      ],
    },
  ],
  [
    'resolveReturnShipmentSchema m1 expectedVersion=0.5',
    resolveReturnShipmentSchema,
    {
      expectedVersion: 0.5,
      dispositions: [
        { orderLineId: 'x', disposition: 'REPAIR', quantity: 1 },
        { orderLineId: 'x', disposition: 'REPAIR', quantity: 1 },
      ],
    },
  ],
  [
    'resolveReturnShipmentSchema m1 expectedVersion=Infinity',
    resolveReturnShipmentSchema,
    {
      expectedVersion: Number.POSITIVE_INFINITY,
      dispositions: [
        { orderLineId: 'x', disposition: 'REPAIR', quantity: 1 },
        { orderLineId: 'x', disposition: 'REPAIR', quantity: 1 },
      ],
    },
  ],
  [
    'adjustStockSchema m0 quantityDelta=0.5 (no refinement can fail with it)',
    adjustStockSchema,
    { stockItemId: 'x', quantityDelta: 0.5 },
  ],
];

describe('zod 3 diagnostics: an integer refusal with its enclosing refinements (PR #444 r3)', () => {
  it.each(CASES)('%s', (name, schema, input) => {
    const observed = outcome(schema, input);
    expect(observed).toEqual(ZOD3[name]);
  });
});
