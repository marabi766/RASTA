import { RastaError } from '@rasta/nest-common';
import { INVALID_CURSOR_MESSAGE, after, invalidCursor, resolveCursor } from './cursor';

/**
 * The cursor contract every list in this service keeps (shared/cursor.ts).
 *
 * What these pin down is that the refusal carries nothing of the request: the
 * three ways a cursor can fall outside a list — unknown, foreign, other view —
 * reach `invalidCursor()` through the same `null`, and the error they produce
 * is fixed text. `test/scoped-cursor.int-spec.ts` proves the same over HTTP
 * against PostgreSQL.
 */
describe('resolveCursor', () => {
  const AT = new Date('2026-10-13T08:00:00.123Z');

  it('reads nothing when there is no cursor — the first page', async () => {
    const find = jest.fn();
    await expect(resolveCursor(undefined, find)).resolves.toBeUndefined();
    await expect(resolveCursor('', find)).resolves.toBeUndefined();
    expect(find).not.toHaveBeenCalled();
  });

  it('returns the boundary of a row the scoped lookup found', async () => {
    const find = jest.fn().mockResolvedValue({ at: AT, id: 'SET_A' });
    await expect(resolveCursor('SET_A', find)).resolves.toEqual({ at: AT, id: 'SET_A' });
    expect(find).toHaveBeenCalledWith('SET_A');
  });

  it('refuses a cursor the scoped lookup did not find, without echoing it', async () => {
    const find = jest.fn().mockResolvedValue(null);
    const probe = 'SET_FOREIGN_PROBE_VALUE';

    const error = await resolveCursor(probe, find).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RastaError);
    const refused = error as RastaError;
    expect(refused.code).toBe('VALIDATION_FAILED');
    expect(refused.status).toBe(400);
    expect(refused.details).toEqual([{ path: 'cursor', message: INVALID_CURSOR_MESSAGE }]);
    expect(JSON.stringify({ message: refused.message, details: refused.details })).not.toContain(
      probe,
    );
    expect(refused.internalContext).toBeUndefined();
  });

  it('produces the same refusal every time', () => {
    const first = invalidCursor();
    const second = invalidCursor();
    expect([second.code, second.message, second.details]).toEqual([
      first.code,
      first.message,
      first.details,
    ]);
  });
});

describe('after', () => {
  it('is strictly older, with the id breaking a tie in the same millisecond', () => {
    const at = new Date('2026-10-13T08:00:00.123Z');
    expect(after('settledAt', { at, id: 'SET_B' })).toEqual({
      OR: [{ settledAt: { lt: at } }, { settledAt: at, id: { lt: 'SET_B' } }],
    });
  });
});
