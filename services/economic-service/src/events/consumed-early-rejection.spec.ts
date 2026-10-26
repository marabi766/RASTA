import type { z } from 'zod';
import { resolveZodPath, unwrapZodSchema, zodDef } from '@rasta/contracts';
import { MAX_COST_BREAKDOWN_ROWS, maintenanceApprovedSchema } from './consumed';

/**
 * Early rejection on a consumed event's array (GHSA-mrhx-c7xc-m3w5): a
 * `MAINTENANCE_APPROVED` whose cost breakdown is over MAX_COST_BREAKDOWN_ROWS
 * is refused for its length before a single row is parsed — a spy on the row
 * schema's own parse proves it. A Kafka message is bounded only by the topic's
 * size limit, not by an HTTP body limit.
 */
afterEach(() => jest.restoreAllMocks());

it('refuses a cost breakdown of 100,000 invalid rows with one issue, parsing none', () => {
  const [breakdown] = resolveZodPath(maintenanceApprovedSchema, ['costBreakdown']).nodes.flatMap(
    unwrapZodSchema,
  );
  const row = zodDef(breakdown as z.ZodType).element as z.ZodType;
  const parses = jest.spyOn((row as unknown as { _zod: { run: () => unknown } })._zod, 'run');

  const result = maintenanceApprovedSchema.safeParse({
    requestId: 'MNT_1',
    assetId: 'AST_1',
    organizationId: 'ORG_1',
    approvedBy: 'USR_1',
    approvedAt: '2026-10-03T09:00:00.000Z',
    totalCostMinor: '1000',
    currency: 'IRR',
    costBreakdown: Array.from({ length: 100_000 }, () => 'not a row'),
  });

  expect(result.success).toBe(false);
  expect(result.error?.issues.filter((issue) => issue.path[0] === 'costBreakdown')).toEqual([
    expect.objectContaining({ code: 'too_big', maximum: MAX_COST_BREAKDOWN_ROWS }),
  ]);
  expect(parses).not.toHaveBeenCalled();
});
