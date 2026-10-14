import { RastaError } from '@rasta/nest-common';
import {
  commandKeyHash,
  expiryKeyHash,
  reservationOverdrawn,
  stockOverdrawn,
  translateCommandError,
} from './command';

/** What Prisma throws when a raw query fails: P2010, the SQLSTATE in `meta.code`. */
const raw = (code: string, message: string) => ({
  code: 'P2010',
  meta: { code, message },
  message: `Raw query failed. Code: \`${code}\`. Message: \`${message}\``,
});

const codeOf = (error: unknown) => (error instanceof RastaError ? error.code : 'NOT_TRANSLATED');

describe('the key hash of the domain backstop (deviation 1)', () => {
  it('is a SHA-256 of the route and the key, never the key itself', () => {
    const hash = commandKeyHash('POST /v1/stock/reservations', 'key-12345678');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('key-12345678');
    expect(commandKeyHash('POST /v1/stock/receipts', 'key-12345678')).not.toBe(hash);
  });

  it('gives each reservation’s expiry its own hash, apart from any command’s', () => {
    expect(expiryKeyHash('SRV_1')).not.toBe(expiryKeyHash('SRV_2'));
    expect(expiryKeyHash('SRV_1')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('translateCommandError', () => {
  it('passes a platform error through untouched', () => {
    const error = RastaError.notFound('StockItem');
    expect(translateCommandError(error, stockOverdrawn)).toBe(error);
  });

  it('answers a lock wait past the timeout, or a transaction that could not run, with a retryable CONFLICT', () => {
    for (const error of [
      raw('55P03', 'canceling statement due to lock timeout'),
      { code: 'P2028', message: 'Transaction API error: Unable to start a transaction' },
      { code: 'P2024', message: 'Timed out fetching a new connection from the connection pool' },
    ]) {
      const answered = translateCommandError(error, stockOverdrawn) as RastaError;
      expect(answered.code).toBe('CONFLICT');
      expect(answered.retryAfterSeconds).toBe(1);
    }
  });

  it('answers the backstop of the key with IDEMPOTENCY_KEY_REUSED, by constraint or by key detail', () => {
    expect(
      codeOf(
        translateCommandError(
          raw(
            '23505',
            'duplicate key value violates unique constraint "ux_stock_movement_command"',
          ),
          stockOverdrawn,
        ),
      ),
    ).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(
      codeOf(
        translateCommandError(
          raw(
            '23505',
            'Key (organization_id, command_key_hash, stock_item_id)=(…) already exists.',
          ),
          stockOverdrawn,
        ),
      ),
    ).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('leaves any other unique violation alone', () => {
    const other = raw('23505', 'duplicate key value violates unique constraint "stock_item_pkey"');
    expect(translateCommandError(other, stockOverdrawn)).toBe(other);
  });

  it('answers a balance CHECK with the command’s own closed refusal', () => {
    const oversell = raw(
      '23514',
      'new row for relation "stock_item" violates check constraint "ck_stock_item_reserved_within_on_hand"',
    );
    const reservation = translateCommandError(oversell, reservationOverdrawn) as RastaError;
    expect(reservation.code).toBe('BUSINESS_RULE_VIOLATION');
    expect(reservation.details).toEqual([
      expect.objectContaining({ code: 'INSUFFICIENT_AVAILABLE_STOCK' }),
    ]);
    const stock = translateCommandError(oversell, stockOverdrawn) as RastaError;
    expect(stock.details).toEqual([expect.objectContaining({ code: 'ON_HAND_WOULD_BE_NEGATIVE' })]);
  });

  it('translates a command that writes no balance alike, but leaves a balance CHECK it met a defect', () => {
    const unavailable = { code: 'P2028', message: 'Transaction API error: Unable to start' };
    expect(translateCommandError(unavailable, null)).toMatchObject({
      code: 'CONFLICT',
      retryAfterSeconds: 1,
    });
    const oversell = raw(
      '23514',
      'new row for relation "stock_item" violates check constraint "ck_stock_item_on_hand_nonneg"',
    );
    expect(translateCommandError(oversell, null)).toBe(oversell);
  });

  it('leaves a trigger’s refusal a defect: it is never dressed up as a request error', () => {
    const chain = raw('23514', 'ck_stock_movement_chain: a movement continues the previous one');
    expect(translateCommandError(chain, stockOverdrawn)).toBe(chain);
    const deadlock = raw('40P01', 'deadlock detected');
    expect(translateCommandError(deadlock, stockOverdrawn)).toBe(deadlock);
  });
});
