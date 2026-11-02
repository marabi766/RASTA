import type { z } from 'zod';
import { resolveZodPath, unwrapZodSchema, zodDef } from '@rasta/contracts';
import { qualifiedPayload } from './supplier-standing.consumer';

/**
 * Early rejection on a consumed event's array (GHSA-mrhx-c7xc-m3w5): a
 * `SUPPLIER_QUALIFIED` whose qualifiedFor is over 50 is refused for its length
 * before a single entry is parsed — a spy on the entry schema's own parse
 * proves it.
 */
afterEach(() => jest.restoreAllMocks());

it('refuses qualifiedFor of 100,000 invalid entries with one issue, parsing none', () => {
  const [list] = resolveZodPath(qualifiedPayload, ['qualifiedFor']).nodes.flatMap(unwrapZodSchema);
  const entry = zodDef(list as z.ZodType).element as z.ZodType;
  const parses = jest.spyOn((entry as unknown as { _zod: { run: () => unknown } })._zod, 'run');

  const result = qualifiedPayload.safeParse({
    organizationId: 'ORG_01J0000000000000000000000A',
    qualifiedFor: Array.from({ length: 100_000 }, () => 42),
    decidedAt: '2026-09-29T08:00:00.000Z',
  });

  expect(result.success).toBe(false);
  expect(result.error?.issues).toEqual([
    expect.objectContaining({ code: 'too_big', maximum: 50, path: ['qualifiedFor'] }),
  ]);
  expect(parses).not.toHaveBeenCalled();
});
