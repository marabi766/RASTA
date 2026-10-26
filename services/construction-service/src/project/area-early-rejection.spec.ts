import type { z } from 'zod';
import { resolveZodPath, unwrapZodSchema, zodDef } from '@rasta/contracts';
import { RastaError, zodPipe } from '@rasta/nest-common';
import { polygonInput } from './dto';

/**
 * Early rejection on the operating area's nested bounds (GHSA-mrhx-c7xc-m3w5):
 * a position must have exactly two coordinates, a ring at most
 * `MAX_RING_POSITIONS` positions, an area at most `MAX_RINGS` rings — and an
 * array over its bound is refused before any of its elements is parsed. A spy
 * on each element schema's own parse proves it: an oversized array of invalid
 * elements answers its one length issue, and none of its elements is parsed.
 *
 * The pipe parses a refused input twice (`legacyParse`, D-078: stock zod
 * decides, then zod 3's order words the refusal), and each pass refuses an
 * oversized array the same way: a count of elements that are parsed is
 * {@link PASSES} times one pass's.
 */

/** Parses of a refused input: stock zod's, then the zod 3-ordered one for its wording. */
const PASSES = 2;

/** The element schema of the array at `path` in the area. */
function elementAt(...path: (string | number)[]): z.ZodType {
  const [array] = resolveZodPath(polygonInput, path).nodes.flatMap(unwrapZodSchema);
  return zodDef(array as z.ZodType).element as z.ZodType;
}

function details(input: unknown): unknown {
  try {
    zodPipe(polygonInput).transform(input, { type: 'body' });
  } catch (error) {
    if (error instanceof RastaError) return error.details;
    throw error;
  }
  throw new Error('the pipe accepted the area');
}

const spyOnParses = (element: z.ZodType) =>
  jest.spyOn((element as unknown as { _zod: { run: () => unknown } })._zod, 'run');

const closed = [
  [51.3, 35.6],
  [51.4, 35.6],
  [51.4, 35.7],
  [51.3, 35.6],
];
const junk = (count: number) => Array.from({ length: count }, () => 'not a number');

afterEach(() => jest.restoreAllMocks());

describe('the operating area refuses an oversized array before parsing its elements', () => {
  it('a position of 100,000 invalid coordinates: one issue, no coordinate parsed', () => {
    const coordinates = spyOnParses(elementAt('coordinates', 0, 0));

    expect(
      details({ type: 'Polygon', coordinates: [[junk(100_000), ...closed.slice(1)]] }),
    ).toEqual([
      {
        path: 'coordinates[0][0]',
        code: 'too_big',
        message: 'Array must contain exactly 2 element(s)',
      },
    ]);
    // The three valid positions' coordinates, and not one of the 100,000, in each pass.
    expect(coordinates).toHaveBeenCalledTimes(PASSES * 6);
  });

  it('a ring of 100,000 invalid positions: one issue, no position parsed', () => {
    const positions = spyOnParses(elementAt('coordinates', 0));

    expect(details({ type: 'Polygon', coordinates: [junk(100_000)] })).toEqual([
      {
        path: 'coordinates[0]',
        code: 'too_big',
        message: 'Array must contain at most 1000 element(s)',
      },
    ]);
    expect(positions).not.toHaveBeenCalled();
  });

  it('100,000 invalid rings: one issue, no ring parsed', () => {
    const rings = spyOnParses(elementAt('coordinates'));

    expect(details({ type: 'Polygon', coordinates: junk(100_000) })).toEqual([
      { path: 'coordinates', code: 'too_big', message: 'Array must contain at most 20 element(s)' },
    ]);
    expect(rings).not.toHaveBeenCalled();
  });
});
