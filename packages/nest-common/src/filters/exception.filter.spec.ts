import { BadRequestException, HttpException, HttpStatus, type ArgumentsHost } from '@nestjs/common';
import type { Logger } from '@rasta/logging';
import { RastaError } from '../errors/rasta-error';
import { LOG_TEXT_MAX } from '../errors/safe-log-text';
import { AllExceptionsFilter, loggableError, type LoggedError } from './exception.filter';

/**
 * S-09 on the HTTP error path: a message this service did not write never
 * reaches the client, and reaches the log only sanitised and bounded — the
 * rule `EventConsumer` applies to handler text.
 */

const SENTINEL = 'SENTINEL-51f0-customer-address';
// A driver-style message: a useful head, a forged second line, a DSN with a
// password, and the sentinel past the 200-character bound.
const HOSTILE =
  'connect ETIMEDOUT db:5432\nlevel=info msg="all good" ' +
  'postgresql://rasta:hunter2-db-password@db:5432/rasta ' +
  'x'.repeat(LOG_TEXT_MAX) +
  SENTINEL;

interface Captured {
  level: string;
  payload: { err: LoggedError; internalContext?: { originalMessage?: string } };
  message: string;
}

function run(exception: unknown): { status: number; body: unknown; lines: Captured[] } {
  const lines: Captured[] = [];
  const at = (level: string) => (payload: Captured['payload'], message: string) => {
    lines.push({ level, payload, message });
  };
  const logger = { debug: at('debug'), warn: at('warn'), error: at('error') } as unknown as Logger;
  const sent: { status: number; body: unknown } = { status: 0, body: undefined };
  const response = {
    status: (code: number) => {
      sent.status = code;
      return response;
    },
    json: (body: unknown) => {
      sent.body = body;
    },
  };
  new AllExceptionsFilter(logger).catch(exception, {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost);
  return { ...sent, lines };
}

const hasControl = (value: string): boolean =>
  Array.from(value).some((char) => (char.codePointAt(0) ?? 0) < 0x20);

describe('AllExceptionsFilter, 5xx (S-09)', () => {
  it('an unrecognised error: generic to the client, sanitised and bounded in the log', () => {
    const driverError = Object.assign(new Error(HOSTILE), { meta: { target: SENTINEL } });

    const { status, body, lines } = run(driverError);

    expect(status).toBe(500);
    expect(body).toMatchObject({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
    expect(JSON.stringify(body)).not.toContain('ETIMEDOUT');

    expect(lines).toHaveLength(1);
    const [{ level, payload }] = lines as [Captured];
    expect(level).toBe('error');
    const original = payload.internalContext?.originalMessage ?? '';
    // Still useful to an operator …
    expect(original.startsWith('connect ETIMEDOUT db:5432 level=info msg="all good"')).toBe(true);
    // … and safe: no forged line, no password, bounded, nothing past the bound.
    expect(hasControl(original)).toBe(false);
    expect(original).not.toContain('hunter2');
    expect(Array.from(original)).toHaveLength(LOG_TEXT_MAX);
    expect(original.endsWith('…')).toBe(true);
    expect(payload.err.message).toBe(original);

    const logged = JSON.stringify(lines);
    expect(logged).not.toContain('SENTINEL');
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain('\\nlevel=info');
  });

  it('keeps the stack frames and the cause chain — each made safe the same way', () => {
    const cause = new Error(`pool exhausted for ${'y'.repeat(LOG_TEXT_MAX)}${SENTINEL}`);
    const error = new Error('write failed\nforged', { cause });

    const { lines } = run(error);

    const err = lines[0]?.payload.err;
    expect(err?.type).toBe('Error');
    expect(err?.message).toBe('write failed forged');
    expect(err?.stack).toMatch(/^\s+at /);
    expect(err?.stack).not.toContain('write failed');
    expect(err?.cause?.message.startsWith('pool exhausted for y')).toBe(true);
    expect(JSON.stringify(lines)).not.toContain('SENTINEL');
  });

  it('a Nest HttpException of 5xx: its text is the server’s, so the client gets the generic one', () => {
    const { status, body, lines } = run(
      new HttpException(`upstream said ${SENTINEL}`, HttpStatus.BAD_GATEWAY),
    );

    expect(status).toBe(502);
    expect(body).toMatchObject({ message: 'An unexpected error occurred' });
    expect(JSON.stringify(body)).not.toContain('SENTINEL');
    expect(lines[0]?.level).toBe('error');
    expect(lines[0]?.payload.internalContext?.originalMessage).toBe(`upstream said ${SENTINEL}`);
  });

  it('a thrown non-Error is described the same way', () => {
    const { body, lines } = run(`raw\u0000string ${SENTINEL}`);
    expect(JSON.stringify(body)).not.toContain('SENTINEL');
    expect(lines[0]?.payload.err).toEqual({ type: 'string', message: `raw string ${SENTINEL}` });
  });
});

describe('AllExceptionsFilter, what stays as it was', () => {
  it('a 4xx HttpException keeps its message for the client', () => {
    const { status, body } = run(new BadRequestException('page must be a positive integer'));
    expect(status).toBe(400);
    expect(body).toMatchObject({ message: 'page must be a positive integer' });
  });

  it('a RastaError keeps its message and code, and the log keeps its internal context', () => {
    const { status, body, lines } = run(
      RastaError.notFound('Asset', 'AST_01JFILTERSPEC0000000001'),
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ code: 'NOT_FOUND', message: 'Asset not found' });
    expect(lines[0]?.level).toBe('debug');
    expect(lines[0]?.payload.err).toMatchObject({ type: 'RastaError', code: 'NOT_FOUND' });
    expect(lines[0]?.payload.internalContext).toEqual({
      resourceType: 'Asset',
      id: 'AST_01JFILTERSPEC0000000001',
    });
  });
});

describe('loggableError', () => {
  it('follows at most three causes', () => {
    let error = new Error('level 0');
    for (let i = 1; i <= 5; i += 1) error = new Error(`level ${i}`, { cause: error });
    let depth = 0;
    for (let node: LoggedError | undefined = loggableError(error); node?.cause; node = node.cause) {
      depth += 1;
    }
    expect(depth).toBe(3);
  });
});
