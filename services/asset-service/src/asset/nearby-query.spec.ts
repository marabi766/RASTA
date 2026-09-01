import { RastaError } from '@rasta/nest-common';
import { zodPipe } from '@rasta/nest-common';
import { nearbyQuerySchema } from './dto';

/**
 * `availableOnly` at the boundary the HTTP request actually crosses.
 *
 * The pipe is the real one the controller uses, so what is asserted here is
 * what a request gets: the parsed value the service will branch on, or the
 * validation error the exception filter turns into a 400.
 *
 * The parameter used `z.coerce.boolean()`, which applies JavaScript's
 * `Boolean()` — every non-empty string is true. `?availableOnly=false` was
 * therefore read as `true` and the search was narrowed to dispatchable assets:
 * the opposite of the request, and silent, because a shorter list of real
 * assets looks like an answer rather than a fault.
 *
 * Every assertion about `false` here fails against that coercion.
 */
const pipe = zodPipe(nearbyQuerySchema);
const AT = { latitude: '31.85', longitude: '54.29' };

const parse = (query: Record<string, string>) =>
  pipe.transform({ ...AT, ...query }, { type: 'query' });

describe('availableOnly', () => {
  it('is false when omitted — the unfiltered nearby view', () => {
    expect(parse({}).availableOnly).toBe(false);
  });

  it('reads "false" as false — the same decision as omitting it', () => {
    // The defect in one assertion. Under the coercion this was `true`, so a
    // caller who spelled out the default got the filtered list instead.
    expect(parse({ availableOnly: 'false' }).availableOnly).toBe(false);
    expect(parse({ availableOnly: 'false' }).availableOnly).toBe(parse({}).availableOnly);
  });

  it('reads "true" as true', () => {
    expect(parse({ availableOnly: 'true' }).availableOnly).toBe(true);
  });

  it.each(['FALSE', 'False', '0', 'no', 'off'])('reads %p as false', (value) => {
    expect(parse({ availableOnly: value }).availableOnly).toBe(false);
  });

  it.each(['TRUE', '1', 'yes', 'on'])('reads %p as true', (value) => {
    expect(parse({ availableOnly: value }).availableOnly).toBe(true);
  });

  it.each(['maybe', 'available', '2', 'y'])('refuses %p with a validation error', (value) => {
    // `RastaError.validation` is what the exception filter renders as 400.
    // Guessing here would mean a typo silently choosing one of two result sets.
    expect(() => parse({ availableOnly: value })).toThrow(RastaError);
  });

  it('names the offending field so a client can point at it', () => {
    try {
      parse({ availableOnly: 'maybe' });
      throw new Error('expected a validation error');
    } catch (error) {
      expect((error as RastaError).details?.[0]?.path).toBe('availableOnly');
    }
  });

  it('leaves the other filters alone', () => {
    // Guards the blast radius: this change touches one field's parser and
    // nothing about radius, type, limit or the coordinate bounds.
    const query = parse({ availableOnly: 'false', radiusMeters: '1200', limit: '10' });
    expect(query.radiusMeters).toBe(1200);
    expect(query.limit).toBe(10);
    expect(parse({}).radiusMeters).toBe(50_000);
    expect(parse({}).limit).toBe(25);
  });
});
