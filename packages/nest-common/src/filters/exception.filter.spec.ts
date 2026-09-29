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

function run(exception: unknown): {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  lines: Captured[];
} {
  const lines: Captured[] = [];
  const at = (level: string) => (payload: Captured['payload'], message: string) => {
    lines.push({ level, payload, message });
  };
  const logger = { debug: at('debug'), warn: at('warn'), error: at('error') } as unknown as Logger;
  const sent: { status: number; body: unknown; headers: Record<string, string> } = {
    status: 0,
    body: undefined,
    headers: {},
  };
  const response = {
    status: (code: number) => {
      sent.status = code;
      return response;
    },
    json: (body: unknown) => {
      sent.body = body;
    },
    setHeader: (name: string, value: string) => {
      sent.headers[name] = value;
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

describe('AllExceptionsFilter, a request the framework could not read (S-09)', () => {
  // What Nest builds from body-parser's SyntaxError: `new BadRequestException(err.message)`.
  const parserText = `Unexpected token 'S', ..."ionalId": ${SENTINEL}"... is not valid JSON`;

  it('a malformed JSON body: fixed text for the client and the log, frames kept', () => {
    const { status, body, lines } = run(new BadRequestException(parserText));

    expect(status).toBe(400);
    expect(body).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'The request body is not valid JSON',
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe('debug');
    expect(lines[0]?.payload.err).toMatchObject({
      type: 'BadRequestException',
      message: 'The request body is not valid JSON',
    });
    expect(lines[0]?.payload.err.stack).toMatch(/^\s+at /);
    expect(JSON.stringify(body)).not.toContain('SENTINEL');
    expect(JSON.stringify(lines)).not.toContain('SENTINEL');
  });

  it('a malformed URL encoding, or any other framework 400: the general fixed text', () => {
    const { body, lines } = run(new BadRequestException('URI malformed'));
    expect(body).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'The request could not be read',
    });
    expect(JSON.stringify(lines)).not.toContain('URI malformed');
  });
});

describe('AllExceptionsFilter, a RastaError of 5xx (S-09)', () => {
  it('keeps its status and code, sends the generic text, logs the original made safe', () => {
    const error = RastaError.internal(`Approval APR_01J vanished for ${SENTINEL}\nforged`);

    const { status, body, lines } = run(error);

    expect(status).toBe(500);
    expect(body).toMatchObject({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
    expect(JSON.stringify(body)).not.toContain('APR_01J');
    expect(lines[0]?.level).toBe('error');
    expect(lines[0]?.payload.internalContext?.originalMessage).toBe(
      `Approval APR_01J vanished for ${SENTINEL} forged`,
    );
  });

  it('an upstream failure: 503 and its code stay, its words do not reach the client', () => {
    const { status, body, lines } = run(RastaError.upstreamUnavailable('fleet-service'));
    expect(status).toBe(503);
    expect(body).toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'An unexpected error occurred',
    });
    // Its own context is kept for the operator, beside the original message.
    expect(lines[0]?.payload.internalContext).toMatchObject({ service: 'fleet-service' });
  });
});

describe('AllExceptionsFilter, a client-safe 5xx (explicit opt-in)', () => {
  const RETRY_SAFE =
    'The correction could not be recorded; nothing was changed and it is safe to retry';

  it('an opted-in message reaches the client; status and code stay', () => {
    const { status, body, lines } = run(RastaError.internalClientSafe(RETRY_SAFE));
    expect(status).toBe(500);
    expect(body).toMatchObject({ code: 'INTERNAL_ERROR', message: RETRY_SAFE });
    // Logged like any 5xx: error level, the original through safeLogText.
    expect(lines[0]?.level).toBe('error');
    expect(lines[0]?.payload.internalContext?.originalMessage).toBe(RETRY_SAFE);
  });

  it('is read from the flag, never from the content: the same words without it stay generic', () => {
    const { body } = run(RastaError.internal(RETRY_SAFE));
    expect(body).toMatchObject({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
  });

  it('the log still sanitises an opted-in message', () => {
    const { lines } = run(RastaError.internalClientSafe('retry is safe\nforged line'));
    expect(lines[0]?.payload.internalContext?.originalMessage).toBe('retry is safe forged line');
    expect(lines[0]?.payload.err.message).toBe('retry is safe forged line');
  });

  it('is off by default, and only the factory or the explicit option sets it', () => {
    expect(RastaError.internal('x').clientSafe).toBe(false);
    expect(new RastaError('INTERNAL_ERROR', 'x').clientSafe).toBe(false);
    expect(new RastaError('INTERNAL_ERROR', 'x', { clientSafe: true }).clientSafe).toBe(true);
    expect(RastaError.internalClientSafe('x').clientSafe).toBe(true);
  });
});

describe('AllExceptionsFilter, body-parser refusals', () => {
  /** What body-parser throws (an `http-errors` error): a status and a `type`. */
  const bodyParserError = (status: number, type: string, message: string) =>
    Object.assign(new Error(message), { status, statusCode: status, type, expose: true });

  it.each([
    [413, 'entity.too.large', 'PAYLOAD_TOO_LARGE', 'The request body is too large'],
    [
      415,
      'charset.unsupported',
      'UNSUPPORTED_MEDIA_TYPE',
      'The request body is in a charset this service does not accept',
    ],
    [
      415,
      'encoding.unsupported',
      'UNSUPPORTED_MEDIA_TYPE',
      'The request body is in a content encoding this service does not accept',
    ],
  ])('%s %s: fixed text, never body-parser’s', (status, type, code, message) => {
    const {
      status: sent,
      body,
      lines,
    } = run(bodyParserError(status, type, `unsupported "${SENTINEL}"`));
    expect(sent).toBe(status);
    expect(body).toMatchObject({ code, message });
    expect(lines[0]?.level).toBe('debug');
    expect(JSON.stringify([body, lines])).not.toContain('SENTINEL');
  });

  it('only the allowlisted types, and only at their own status', () => {
    expect(run(bodyParserError(400, 'request.aborted', 'aborted')).status).toBe(500);
    expect(run(bodyParserError(500, 'entity.too.large', 'odd')).status).toBe(500);
  });
});

describe('AllExceptionsFilter, what stays as it was', () => {
  it('a 4xx HttpException other than a 400 keeps its message for the client', () => {
    const { status, body } = run(new HttpException('Slow down', HttpStatus.TOO_MANY_REQUESTS));
    expect(status).toBe(429);
    expect(body).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED', message: 'Slow down' });
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

describe('AllExceptionsFilter, Retry-After (docs/06 § 6.8)', () => {
  const inFlight = (retryAfterSeconds?: number) =>
    new RastaError('CONFLICT', 'This request is already being processed; retry shortly', {
      internalContext: { endpoint: 'POST /v1/orders' },
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });

  it('a key in flight: 409 CONFLICT with Retry-After, the only header the error sets', () => {
    const { status, body, headers } = run(inFlight(1));
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'CONFLICT' });
    expect(headers).toEqual({ 'Retry-After': '1' });
    // The wait is a header, not a field of the body.
    expect(JSON.stringify(body)).not.toContain('retryAfter');
  });

  it('absent when the error does not set it', () => {
    expect(run(inFlight()).headers).toEqual({});
    expect(run(RastaError.idempotencyKeyReused()).headers).toEqual({});
    expect(run(RastaError.notFound('Asset', 'AST_1')).headers).toEqual({});
  });

  it('never derived from internalContext, whatever it holds', () => {
    const error = new RastaError('CONFLICT', 'x', {
      internalContext: {
        retryAfterSeconds: 5,
        'Retry-After': '5',
        headers: { 'Retry-After': '5', 'Set-Cookie': 'session=1' },
      },
    });
    const { headers, lines } = run(error);
    expect(headers).toEqual({});
    // The context still reaches the log, as it always did.
    expect(lines[0]?.payload.internalContext).toMatchObject({ retryAfterSeconds: 5 });
  });

  it('never read from a thrown value that is not a RastaError', () => {
    const lookalike = Object.assign(new HttpException('Busy', HttpStatus.CONFLICT), {
      retryAfterSeconds: 5,
    });
    expect(run(lookalike).headers).toEqual({});
    expect(run(Object.assign(new Error('x'), { retryAfterSeconds: 5 })).headers).toEqual({});
  });

  it.each([
    [1, '1'],
    [30, '30'],
    [3600, '3600'],
    [1.2, '2'],
    [0, '1'],
    [-5, '1'],
    [0.001, '1'],
    [7200, '3600'],
    [Number.MAX_SAFE_INTEGER, '3600'],
  ])('bounded to a whole number of seconds in 1..3600: %p → %p', (seconds, sent) => {
    expect(run(inFlight(seconds)).headers).toEqual({ 'Retry-After': sent });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'not sent at all for %p',
    (seconds) => {
      expect(run(inFlight(seconds)).headers).toEqual({});
    },
  );

  it('sent on a 5xx as well, beside the generic message', () => {
    const unavailable = new RastaError('UPSTREAM_UNAVAILABLE', 'fleet-service is down', {
      retryAfterSeconds: 10,
    });
    const { status, body, headers } = run(unavailable);
    expect(status).toBe(503);
    expect(body).toMatchObject({ message: 'An unexpected error occurred' });
    expect(headers).toEqual({ 'Retry-After': '10' });
  });

  it('the field is only what the constructor was given', () => {
    expect(inFlight(1).retryAfterSeconds).toBe(1);
    expect(inFlight().retryAfterSeconds).toBeUndefined();
    expect(RastaError.internal('x').retryAfterSeconds).toBeUndefined();
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
