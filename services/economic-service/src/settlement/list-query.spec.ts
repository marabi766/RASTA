import { RastaError, zodPipe } from '@rasta/nest-common';
import { listSettlementsQuerySchema } from './dto';

/**
 * `incoming` at the boundary the HTTP request actually crosses.
 *
 * The two branches answer different questions. `false` is "what did I pay" —
 * `settlement.organization_id` is the payer, so the tenant guard alone serves
 * it. `true` is "what was I paid", which has to cross the guard because the
 * payer column is the scoped one; the crossing is narrowed to the caller's own
 * id on the payee column, so it can only ever return settlements the caller
 * was party to.
 *
 * Under `z.coerce.boolean()`, `?incoming=false` parsed as `true` and served
 * the payee view — a different answer to the question asked, chosen by the
 * parser rather than by the request. Every `false` assertion here fails
 * against that coercion.
 */
const pipe = zodPipe(listSettlementsQuerySchema);
const parse = (query: Record<string, string> = {}) => pipe.transform(query, { type: 'query' });

describe('incoming', () => {
  it('is false when omitted — the payer view', () => {
    expect(parse().incoming).toBe(false);
  });

  it('reads "false" as false — the same decision as omitting it', () => {
    expect(parse({ incoming: 'false' }).incoming).toBe(false);
    expect(parse({ incoming: 'false' }).incoming).toBe(parse().incoming);
  });

  it('reads "true" as true — the caller opts into the payee view', () => {
    expect(parse({ incoming: 'true' }).incoming).toBe(true);
  });

  it.each(['FALSE', '0', 'no', 'off'])('reads %p as false', (value) => {
    expect(parse({ incoming: value }).incoming).toBe(false);
  });

  it.each(['TRUE', '1', 'yes', 'on'])('reads %p as true', (value) => {
    expect(parse({ incoming: value }).incoming).toBe(true);
  });

  it.each(['maybe', 'payee', '2'])('refuses %p with a validation error', (value) => {
    expect(() => parse({ incoming: value })).toThrow(RastaError);
  });

  it('names the offending field', () => {
    try {
      parse({ incoming: 'maybe' });
      throw new Error('expected a validation error');
    } catch (error) {
      expect((error as RastaError).details?.[0]?.path).toBe('incoming');
    }
  });

  it('leaves pagination alone', () => {
    expect(parse({ incoming: 'false', limit: '10' }).limit).toBe(10);
    expect(parse().limit).toBe(25);
  });
});
