import type { ArgumentsHost } from '@nestjs/common';
import { ERROR_CODES } from '@rasta/contracts';
import type { Logger } from '@rasta/logging';
import { AllExceptionsFilter } from '../filters/exception.filter';
import { RastaError } from './rasta-error';

/**
 * S-09: `RastaError.idempotencyKeyReused` used to carry the raw
 * Idempotency-Key in `internalContext`, which `AllExceptionsFilter` logs. It
 * now takes no key at all; these tests pin that, and drive the refusal through
 * the real filter to show what the log and the client each receive.
 */

/** Everything a line or body carries, Errors included (`JSON.stringify` drops their message and stack). */
function dump(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) =>
    field instanceof Error
      ? { ...field, name: field.name, message: field.message, stack: field.stack }
      : field,
  );
}

function capturingFilter(): { filter: AllExceptionsFilter; lines: unknown[][] } {
  const lines: unknown[][] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push([level, ...args]);
    };
  const logger = {
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
  } as unknown as Logger;
  return { filter: new AllExceptionsFilter(logger), lines };
}

function respond(
  filter: AllExceptionsFilter,
  exception: unknown,
): { status: number; body: unknown } {
  const sent: { status: number; body: unknown } = { status: 0, body: undefined };
  const response = {
    status(code: number) {
      sent.status = code;
      return response;
    },
    json(body: unknown) {
      sent.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  filter.catch(exception, host);
  return sent;
}

describe('RastaError.idempotencyKeyReused (S-09)', () => {
  it('is the documented 409 and carries no internal context', () => {
    const error = RastaError.idempotencyKeyReused();
    expect(error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_REUSED);
    expect(error.status).toBe(409);
    expect(error.internalContext).toBeUndefined();
  });

  it('takes no key, so no caller can hand it one', () => {
    // @ts-expect-error — the parameter was removed on purpose: a caller that
    // still passes the key fails to compile instead of logging it.
    const error = RastaError.idempotencyKeyReused('SENTINEL-KEY');
    expect(dump(error)).not.toContain('SENTINEL-KEY');
  });

  it('reaches neither the log line nor the response body through the exception filter', () => {
    // What a service does with a client's key: look it up, find a different
    // body under it, refuse. The key is in scope at the throw — never in it.
    const key = 'SENTINEL-7f3a-client-key';
    const refuse = (_clientKey: string) => RastaError.idempotencyKeyReused();
    const { filter, lines } = capturingFilter();

    const { status, body } = respond(filter, refuse(key));

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: ERROR_CODES.IDEMPOTENCY_KEY_REUSED });
    expect(lines).toHaveLength(1);
    const [level, payload] = lines[0] as [string, { internalContext?: unknown }];
    expect(level).toBe('debug');
    expect(payload.internalContext).toBeUndefined();
    expect(dump(lines)).not.toContain(key);
    expect(dump(body)).not.toContain(key);
  });

  it('negative control: the same filter does log an internalContext it is given', () => {
    // Proves the assertions above can fail — the filter is not silently
    // dropping context, the helper is simply not giving it any.
    const { filter, lines } = capturingFilter();
    respond(
      filter,
      new RastaError(ERROR_CODES.IDEMPOTENCY_KEY_REUSED, 'reused', {
        internalContext: { key: 'SENTINEL-7f3a-client-key' },
      }),
    );
    expect(dump(lines)).toContain('SENTINEL-7f3a-client-key');
  });
});
