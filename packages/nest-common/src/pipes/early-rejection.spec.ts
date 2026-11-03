import { z } from 'zod';
import { withMaxKeys, zodDef } from '@rasta/contracts';
import { RastaError } from '../errors/rasta-error';
import { zodPipe } from './zod-validation.pipe';

/**
 * Early rejection (GHSA-mrhx-c7xc-m3w5): an array over its length cap is
 * refused **before a single element is parsed** — the whole point of the move
 * to zod 4.6.6+. zod 3 (and zod 4's legacy `zod/v3`) recorded `too_big` and
 * then parsed every element anyway, collecting one issue per invalid one, so
 * the cost of a refusal grew with what the caller sent.
 *
 * Proved with a spy on the element schema's own parse (`_zod.run`), through
 * the shared pipe every service validates with: an oversized array of
 * **invalid** elements answers the one length issue and the spy is never
 * called. zod rejects early only on a **leading** size check — the last case
 * shows a cap behind a refinement does not — which is why every cap in the
 * platform is written first in its chain (`.min()`/`.max()` before anything
 * else).
 *
 * The pipe parses a refused input twice (`legacyParse`, D-078): stock zod
 * decides, then a pass in zod 3's order words the refusal. Each pass refuses
 * an oversized array the same way, so the spy is still never called; a count
 * of elements that are parsed is {@link PASSES} times one pass's.
 */

/** Parses of a refused input: stock zod's, then the zod 3-ordered one for its wording. */
const PASSES = 2;

function refusal(schema: z.ZodType, input: unknown): RastaError {
  try {
    zodPipe(schema).transform(input, { type: 'body' });
  } catch (error) {
    if (error instanceof RastaError) return error;
    throw error;
  }
  throw new Error('the pipe accepted the input');
}

/** A spy on every parse of `element`, restored after the test. */
function spyOnParses(element: z.ZodType): jest.SpyInstance {
  return jest.spyOn((element as unknown as { _zod: { run: () => unknown } })._zod, 'run');
}

const INVALID = 42; // every element below is a string schema
const many = (count: number) => Array.from({ length: count }, () => INVALID);

afterEach(() => jest.restoreAllMocks());

describe('an array over its cap is refused before any element is parsed', () => {
  it.each([
    ['.max(3)', (element: z.ZodType) => z.array(element).max(3)],
    ['.min(1).max(3)', (element: z.ZodType) => z.array(element).min(1).max(3)],
    ['.length(3)', (element: z.ZodType) => z.array(element).length(3)],
    ['.nonempty().max(3)', (element: z.ZodType) => z.array(element).nonempty().max(3)],
  ])('%s: 100,000 invalid elements, one issue, no element parsed', (_cap, array) => {
    const element = z.string();
    const parses = spyOnParses(element);

    const error = refusal(z.object({ list: array(element) }).strict(), { list: many(100_000) });

    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).toEqual([expect.objectContaining({ path: 'list', code: 'too_big' })]);
    expect(parses).not.toHaveBeenCalled();
  });

  it('under the cap, every element is parsed and reported as before', () => {
    const element = z.string();
    const parses = spyOnParses(element);

    const error = refusal(z.object({ list: z.array(element).max(3) }).strict(), {
      list: many(3),
    });

    expect(parses).toHaveBeenCalledTimes(PASSES * 3);
    expect(error.details).toHaveLength(3);
  });

  it('a nested bound rejects at its own level: an oversized inner array is not walked', () => {
    // The shape of construction's operating area: positions of exactly two
    // numbers inside a capped ring inside a capped list of rings.
    const coordinate = z.number();
    const position = z.array(coordinate).length(2);
    const ring = z.array(position).min(4).max(10);
    const schema = z.object({ rings: z.array(ring).min(1).max(3) }).strict();
    const coordinates = spyOnParses(coordinate);
    const positions = spyOnParses(position);
    const rings = spyOnParses(ring);

    const oversizedPosition = refusal(schema, {
      rings: [[Array.from({ length: 100_000 }, () => 'x'), [1, 2], [3, 4], [1, 2]]],
    });
    expect(oversizedPosition.details).toEqual([
      expect.objectContaining({ path: 'rings[0][0]', code: 'too_big' }),
    ]);
    // The three valid positions' coordinates, and not one of the 100,000, in each pass.
    expect(coordinates).toHaveBeenCalledTimes(PASSES * 6);

    coordinates.mockClear();
    positions.mockClear();
    const oversizedRing = refusal(schema, { rings: [Array.from({ length: 100_000 }, () => 'x')] });
    expect(oversizedRing.details).toEqual([
      expect.objectContaining({ path: 'rings[0]', code: 'too_big' }),
    ]);
    expect(positions).not.toHaveBeenCalled();
    expect(coordinates).not.toHaveBeenCalled();

    rings.mockClear();
    const tooManyRings = refusal(schema, { rings: many(100_000) });
    expect(tooManyRings.details).toEqual([
      expect.objectContaining({ path: 'rings', code: 'too_big' }),
    ]);
    expect(rings).not.toHaveBeenCalled();
  });

  it('a record over withMaxKeys is refused before any entry is parsed', () => {
    const value = z.string();
    const parses = spyOnParses(value);
    const bag = Object.fromEntries(many(10_000).map((entry, index) => [`k${index}`, entry]));

    const error = refusal(
      z.object({ bag: withMaxKeys(z.record(z.string(), value), 100) }).strict(),
      { bag },
    );

    // One issue, the cap's (its text is the backstop's "Invalid input": past 200
    // input leaves the pipe does not search a message for echoes).
    expect(error.details).toEqual([expect.objectContaining({ path: 'bag', code: 'custom' })]);
    expect(parses).not.toHaveBeenCalled();
  });

  it('the control: a cap behind a refinement is not leading, and every element is parsed', () => {
    const element = z.string();
    const parses = spyOnParses(element);
    const late = z
      .array(element)
      .refine(() => true)
      .max(3);
    // zod's own test of what "leading" means: no size check before the first other check.
    expect(zodDef(late).type).toBe('array');

    refusal(z.object({ list: late }).strict(), { list: many(1_000) });

    expect(parses).toHaveBeenCalledTimes(PASSES * 1_000);
  });
});
