import {
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
  type ArgumentsHost,
} from '@nestjs/common';
import type { Logger } from '@rasta/logging';
import { runWithContext, type RequestContext } from '../context/request-context';
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

function run(
  exception: unknown,
  request?: { method?: string; originalUrl?: string; url?: string },
): {
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
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
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

  // Codex on #261, r5 F1: the cap cut a connection string's `@` away, so its
  // password reached the log. A secret the cap cuts through leaves no part of
  // itself — in the message, the stack or a cause — and the frames stay (r5 L1).
  it.each([
    ['a connection string', (secret: string) => `connect postgresql://user:${secret}@db/app`],
    ['a bearer token', (secret: string) => `upstream said: Authorization: Bearer ${secret}`],
    ['a password= pair', (secret: string) => `POST https://idp.example/token?password=${secret}`],
    ['a token= pair', (secret: string) => `refused ?token=${secret}`],
    [
      'a quoted body',
      (secret: string) => `Unexpected token 'p', "password=${secret}" is not valid JSON`,
    ],
  ])('%s cut at the cap: nothing of it in the log, and the frames kept', (_, make) => {
    const message = make(`SECRET_${'S'.repeat(5_000)}`);
    const error = new Error(message, { cause: new Error(message) });

    const { lines } = run(error);

    const err = lines[0]?.payload.err;
    expect(JSON.stringify(lines)).not.toMatch(/SECRET|SS/);
    expect(err?.message.endsWith('[REDACTED]…[TRUNCATED]')).toBe(true);
    expect(err?.cause?.message).toBe(err?.message);
    expect(err?.stack).toMatch(/^\s+at /);
    expect(err?.cause?.stack).toMatch(/^\s+at /);
  });

  it('a message cut at the cap after a quote keeps its frames (r5 L1)', () => {
    const error = new Error(`Invalid value: "${'x'.repeat(5_000)}" for "where"`);

    const err = run(error).lines[0]?.payload.err;

    expect(err?.message).toBe('Invalid value: "[REDACTED]…[TRUNCATED]');
    expect(err?.stack?.split('\n').every((line) => /^\s+at /.test(line))).toBe(true);
    expect(err?.stack).toBe(error.stack?.split('\n').slice(1).join('\n'));
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

  it('a URL named in the message or a cause keeps its path, not its query (#261 r2 F2)', () => {
    const error = RastaError.internal(
      `Token exchange failed: POST https://idp.example/token?code=${SENTINEL}&state=x`,
      new Error(`GET https://idp.example/cb?access_token=${SENTINEL} refused`),
    );

    const { lines } = run(error);

    const payload = lines[0]?.payload;
    expect(payload?.internalContext?.originalMessage).toBe(
      'Token exchange failed: POST https://idp.example/token?[REDACTED]',
    );
    expect(payload?.err.message).toBe(payload?.internalContext?.originalMessage);
    expect(payload?.err.cause?.message).toBe('GET https://idp.example/cb?[REDACTED] refused');
    expect(JSON.stringify(lines)).not.toContain('SENTINEL');
  });

  it('a body JSON.parse quotes over several lines reaches neither the message nor the frames', () => {
    // V8 quotes a short source whole: here over two lines, the second of which
    // reads as a frame in the stack.
    let error: unknown;
    try {
      JSON.parse('c\n    at LEAK');
    } catch (thrown) {
      error = thrown;
    }
    expect((error as Error).stack?.split('\n')[1]).toBe('    at LEAK" is not valid JSON');

    const { lines } = run(error);

    const err = lines[0]?.payload.err;
    expect(err?.message).toBe(`Unexpected token 'c', "[REDACTED]" is not valid JSON`);
    expect(err?.stack).toMatch(/^\s+at JSON\.parse/);
    expect(JSON.stringify(lines)).not.toContain('LEAK');
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

describe('AllExceptionsFilter, the request is reported by its path alone (S-09)', () => {
  const context = (path: string, method: string): RequestContext => ({
    correlationId: 'corr-path-spec',
    requestId: 'req-path-spec',
    roles: [],
    organizationIds: [],
    authType: 'ANONYMOUS',
    method,
    path,
    startedAt: 0,
  });
  /** The request as Express hands it over, and its context as the middleware records it. */
  const within = (target: string, exception: unknown, method = 'GET') =>
    runWithContext(context(target, method), () =>
      run(exception, { method, originalUrl: target, url: target }),
    );

  it.each([
    ['a 4xx', RastaError.notFound('Asset', 'AST_1'), 'debug'],
    ['a 403', RastaError.forbidden('No'), 'warn'],
    ['a 5xx', new Error('boom'), 'error'],
  ])('%s: `path` in the body and in the log line carries no query', (_, exception, level) => {
    const { body, lines } = within('/v1/x?secret=abc', exception);

    expect(body).toMatchObject({ path: '/v1/x' });
    expect(JSON.stringify(body)).not.toContain('abc');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe(level);
    expect(lines[0]?.payload).toMatchObject({ method: 'GET', path: '/v1/x' });
    expect(JSON.stringify(lines)).not.toContain('abc');
  });

  it('nor a fragment', () => {
    const { body, lines } = within('/v1/x#secret=abc', RastaError.notFound('Asset'));
    expect(body).toMatchObject({ path: '/v1/x' });
    expect(JSON.stringify([body, lines])).not.toContain('abc');
  });

  it('Nest’s route-not-found text keeps its path and loses the query', () => {
    // What Nest's RoutesResolver throws: `Cannot ${method} ${originalUrl}`.
    const { status, body, lines } = within(
      '/v1/nowhere?secret=abc',
      new NotFoundException('Cannot GET /v1/nowhere?secret=abc'),
    );

    expect(status).toBe(404);
    expect(body).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Cannot GET /v1/nowhere',
      path: '/v1/nowhere',
    });
    expect(lines[0]?.payload.err).toMatchObject({
      type: 'NotFoundException',
      message: 'Cannot GET /v1/nowhere',
    });
    expect(lines[0]?.payload.err.stack).toMatch(/^\s+at /);
    expect(JSON.stringify([body, lines])).not.toContain('abc');
  });

  it.each([
    ['M-SEARCH', '/nowhere?access_token=secret123'],
    ['GET', '/nowhere/?access_token=secret123#frag'],
    ['PROPFIND', '/nowhere?a=1&access_token=secret123'],
  ])(
    'Nest’s text for %s %s is written again from the request: no query, however it is spelt',
    (method, target) => {
      const { body, lines } = within(
        target,
        new NotFoundException(`Cannot ${method} ${target}`),
        method,
      );

      const path = target.slice(0, target.search(/[?#]/));
      expect(body).toMatchObject({ code: 'NOT_FOUND', message: `Cannot ${method} ${path}`, path });
      expect(lines[0]?.payload.err).toMatchObject({ message: `Cannot ${method} ${path}` });
      expect(JSON.stringify([body, lines])).not.toContain('secret123');
    },
  );

  it('the route text names only the request’s own method and path, never Nest’s words', () => {
    // A route-not-found text whose target is not the request's: nothing of it is kept.
    const { body } = within(
      '/v1/x',
      new NotFoundException('Cannot GET /elsewhere?token=t0k'),
      'GET',
    );
    expect(body).toMatchObject({ message: 'Cannot GET /v1/x' });
    expect(JSON.stringify(body)).not.toContain('t0k');
  });

  it('with no request to read, a fixed route text', () => {
    const { body } = run(new NotFoundException('Cannot GET /x?token=t0k'));
    expect(body).toMatchObject({ code: 'NOT_FOUND', message: 'No route matches the request' });
    expect(JSON.stringify(body)).not.toContain('t0k');
  });

  it('any other 404 text stays as it was', () => {
    const { body } = within('/v1/x', new NotFoundException('Asset not found'));
    expect(body).toMatchObject({ message: 'Asset not found' });
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
