import type { z } from 'zod';
import { resolveZodPath, unwrapZodSchema, zodDef } from '@rasta/contracts';
import { assetTransferredSchema } from './events';

/**
 * Early rejection on a consumed event's array (GHSA-mrhx-c7xc-m3w5): an
 * `ASSET_TRANSFERRED` whose retainedCoverages is over 50 is refused for its
 * length before a single entry is parsed — a spy on the entry schema's own
 * parse proves it.
 */
afterEach(() => jest.restoreAllMocks());

it('refuses retainedCoverages of 100,000 invalid entries with one issue, parsing none', () => {
  const [list] = resolveZodPath(assetTransferredSchema, ['retainedCoverages']).nodes.flatMap(
    unwrapZodSchema,
  );
  const entry = zodDef(list as z.ZodType).element as z.ZodType;
  const parses = jest.spyOn((entry as unknown as { _zod: { run: () => unknown } })._zod, 'run');

  const result = assetTransferredSchema.safeParse({
    retainedCoverages: Array.from({ length: 100_000 }, () => 42),
  });

  expect(result.success).toBe(false);
  expect(result.error?.issues.filter((issue) => issue.path[0] === 'retainedCoverages')).toEqual([
    expect.objectContaining({ code: 'too_big', maximum: 50 }),
  ]);
  expect(parses).not.toHaveBeenCalled();
});
