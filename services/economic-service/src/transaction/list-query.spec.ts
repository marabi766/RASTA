import { RastaError, zodPipe } from '@rasta/nest-common';
import { listTransactionsQuerySchema } from './dto';

/**
 * `includeIncoming` at the boundary the HTTP request actually crosses.
 *
 * This flag decides whether the read stays inside the tenant guard or crosses
 * it. `false` is the payer view — "what I owe" — served under the guard.
 * `true` is the payee view, which crosses the guard deliberately, narrowed to
 * the caller's own id on the counterparty column.
 *
 * It used `z.coerce.boolean()`, so `?includeIncoming=false` parsed as `true`
 * and opted the caller into the guard-crossing branch. The crossing has always
 * been narrowed to the caller's own id, so no other tenant's rows were ever
 * reachable — but a read that widens scope has to happen because someone asked
 * for it, not because the parser could not read the word "false".
 *
 * Every `false` assertion here fails against that coercion.
 */
const pipe = zodPipe(listTransactionsQuerySchema);
const parse = (query: Record<string, string> = {}) => pipe.transform(query, { type: 'query' });

describe('includeIncoming', () => {
  it('is false when omitted — the payer view', () => {
    expect(parse().includeIncoming).toBe(false);
  });

  it('reads "false" as false — the same decision as omitting it', () => {
    expect(parse({ includeIncoming: 'false' }).includeIncoming).toBe(false);
    expect(parse({ includeIncoming: 'false' }).includeIncoming).toBe(parse().includeIncoming);
  });

  it('reads "true" as true — the caller opts into the payee view', () => {
    expect(parse({ includeIncoming: 'true' }).includeIncoming).toBe(true);
  });

  it.each(['FALSE', '0', 'no', 'off'])('reads %p as false', (value) => {
    expect(parse({ includeIncoming: value }).includeIncoming).toBe(false);
  });

  it.each(['TRUE', '1', 'yes', 'on'])('reads %p as true', (value) => {
    expect(parse({ includeIncoming: value }).includeIncoming).toBe(true);
  });

  it.each(['maybe', 'incoming', '2'])('refuses %p with a validation error', (value) => {
    expect(() => parse({ includeIncoming: value })).toThrow(RastaError);
  });

  it('names the offending field', () => {
    try {
      parse({ includeIncoming: 'maybe' });
      throw new Error('expected a validation error');
    } catch (error) {
      expect((error as RastaError).details?.[0]?.path).toBe('includeIncoming');
    }
  });

  it('leaves pagination and the other filters alone', () => {
    const query = parse({ includeIncoming: 'false', limit: '10' });
    expect(query.limit).toBe(10);
    expect(parse().limit).toBe(25);
  });
});
