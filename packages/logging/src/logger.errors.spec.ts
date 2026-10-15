import { Writable } from 'node:stream';
import { clearLogContextProvider, createLogger, setLogContextProvider } from './logger';
import { MAX_AGGREGATE_ERRORS, MAX_ERROR_CAUSE_DEPTH } from './error-serializer';
import { REDACTED, SCRUB_MESSAGE_MAX, TRUNCATED_MESSAGE } from './redaction';

const DSN = 'postgresql://u:LEAK@host';
const SECRET_TEXT = `${DSN} Bearer LEAK`;

function capture() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString('utf8'));
      done();
    },
  });
  const logger = createLogger({
    serviceName: 'test',
    level: 'debug',
    environment: 'test',
    pretty: false,
    destination,
  });
  return {
    logger,
    raw: () => lines.join(''),
    last: () => JSON.parse(lines[lines.length - 1]!) as Record<string, any>,
  };
}

describe('createLogger — structured errors are scrubbed and capped', () => {
  it('scrubs message and stack of { err } and keeps the field names', () => {
    const { logger, raw, last } = capture();

    logger.error({ err: new Error(SECRET_TEXT) }, 'failed');

    expect(raw()).not.toContain('LEAK');
    const line = last();
    expect(line.msg).toBe('failed');
    expect(line.err.type).toBe('Error');
    expect(line.err.message).toBe(`postgresql://u:${REDACTED}@host Bearer ${REDACTED}`);
    expect(line.err.stack).toContain(REDACTED);
    expect(line.err.stack).toMatch(/\n\s+at /);
  });

  it('scrubs the `error` key the same way', () => {
    const { logger, raw } = capture();

    logger.warn({ error: new Error(SECRET_TEXT) }, 'failed');

    expect(raw()).not.toContain('LEAK');
  });

  it('scrubs an Error passed as the first argument, including the generated msg', () => {
    const { logger, raw, last } = capture();

    logger.error(new Error(SECRET_TEXT));

    expect(raw()).not.toContain('LEAK');
    expect(last().msg).toBe(`postgresql://u:${REDACTED}@host Bearer ${REDACTED}`);
    expect(last().err.message).toBe(last().msg);
  });

  it('keeps an explicit message when the Error is the first argument', () => {
    const { logger, raw, last } = capture();

    logger.error(new Error(SECRET_TEXT), 'relay failed');

    expect(raw()).not.toContain('LEAK');
    expect(last().msg).toBe('relay failed');
  });

  it('scrubs a secret in a nested cause, and bounds the chain', () => {
    const { logger, raw, last } = capture();
    let error: Error = new Error('deepest');
    for (let level = 0; level < MAX_ERROR_CAUSE_DEPTH + 3; level++) {
      error = new Error(`level ${level} ${SECRET_TEXT}`, { cause: error });
    }

    logger.error({ err: error }, 'failed');

    expect(raw()).not.toContain('LEAK');
    let depth = 0;
    for (let cause = last().err.cause; cause; cause = cause.cause) depth++;
    expect(depth).toBe(MAX_ERROR_CAUSE_DEPTH);
    expect(raw()).not.toContain('deepest');
  });

  it('scrubs the members of an AggregateError, and bounds them', () => {
    const { logger, raw, last } = capture();
    const members = Array.from(
      { length: MAX_AGGREGATE_ERRORS + 5 },
      (_, index) => new Error(`member ${index} ${SECRET_TEXT}`),
    );

    logger.error({ err: new AggregateError(members, SECRET_TEXT) }, 'failed');

    expect(raw()).not.toContain('LEAK');
    expect(last().err.aggregateErrors).toHaveLength(MAX_AGGREGATE_ERRORS);
  });

  it('caps a 16k message in message, stack and the generated msg', () => {
    const { logger, raw, last } = capture();
    const long = `${'x'.repeat(16_000)} ${SECRET_TEXT}`;

    logger.error({ err: new Error(long) }, 'failed');
    logger.error(new Error(long));

    // Uncapped, one line carries the 16k message three times (>48k).
    expect(raw().length).toBeLessThan(2 * 16_000);
    expect(raw()).not.toContain('LEAK');
    const line = last();
    expect(line.err.message.length).toBeLessThanOrEqual(
      SCRUB_MESSAGE_MAX + TRUNCATED_MESSAGE.length,
    );
    expect(line.err.message.endsWith(TRUNCATED_MESSAGE)).toBe(true);
    expect(line.msg.length).toBeLessThanOrEqual(SCRUB_MESSAGE_MAX + TRUNCATED_MESSAGE.length);
    expect(line.err.stack.length).toBeLessThan(3 * SCRUB_MESSAGE_MAX);
  });

  it('scrubs a quoted secret shaped like a stack frame in the message', () => {
    const { logger, raw } = capture();

    logger.error({ err: new Error('bad body\n at Bearer LEAK" is not valid') }, 'failed');

    expect(raw()).not.toContain('LEAK');
  });

  it('keeps allowlisted properties and drops every other one', () => {
    const { logger, raw, last } = capture();
    const error = Object.assign(new Error('boom'), {
      code: 'ECONNREFUSED',
      statusCode: 502,
      meta: { target: SECRET_TEXT },
      request: { headers: { authorization: 'Bearer LEAK' } },
      password: 'LEAK',
    });

    logger.error({ err: error }, 'failed');

    expect(raw()).not.toContain('LEAK');
    const line = last();
    expect(line.err.code).toBe('ECONNREFUSED');
    expect(line.err.statusCode).toBe(502);
    expect(line.err.meta).toBeUndefined();
    expect(line.err.request).toBeUndefined();
    expect(line.err.password).toBeUndefined();
  });

  it('scrubs a string thrown in place of an error', () => {
    const { logger, raw, last } = capture();

    logger.error({ err: SECRET_TEXT }, 'failed');

    expect(raw()).not.toContain('LEAK');
    expect(last().err).toBe(`postgresql://u:${REDACTED}@host Bearer ${REDACTED}`);
  });

  it('handles non-Error thrown values without leaking or throwing', () => {
    const { logger, raw, last } = capture();

    logger.error({ err: { message: SECRET_TEXT, token: 'LEAK', nested: { a: 'LEAK' } } }, 'obj');
    expect(last().err.message).toContain(REDACTED);
    logger.error({ err: { token: 'LEAK', nested: { a: 'LEAK' } } }, 'plain object');
    logger.error({ err: 42 }, 'number');
    expect(last().err).toBe(42);
    logger.error({ err: null }, 'null');
    logger.error({ err: undefined }, 'undefined');
    logger.error({ err: Symbol('LEAKED_SYMBOL_NOT_LOGGED') }, 'symbol');

    expect(raw()).not.toContain('LEAK"');
    expect(raw()).not.toMatch(/token|nested/);
  });

  it('survives a throwing getter and a cyclic cause', () => {
    const { logger, raw } = capture();
    const error = new Error(SECRET_TEXT);
    Object.defineProperty(error, 'code', {
      get() {
        throw new Error('getter');
      },
      enumerable: true,
    });
    (error as { cause?: unknown }).cause = error;

    expect(() => logger.error({ err: error }, 'failed')).not.toThrow();
    expect(raw()).not.toContain('LEAK');
  });
});

describe('createLogger — the final msg is scrubbed and capped for every call shape', () => {
  const SCRUBBED = `postgresql://u:${REDACTED}@host Bearer ${REDACTED}`;

  it('omitted message: { err } gets a scrubbed msg', () => {
    const { logger, raw, last } = capture();

    logger.error({ err: new Error(SECRET_TEXT) });

    expect(raw()).not.toContain('LEAK');
    expect(last().msg).toBe(SCRUBBED);
  });

  it('omitted message: { error } leaks nothing (pino derives no msg from `error`)', () => {
    const { logger, raw, last } = capture();

    logger.error({ error: new Error(SECRET_TEXT) });

    expect(raw()).not.toContain('LEAK');
    expect(last().error.message).toBe(SCRUBBED);
  });

  it('omitted message with a 16k error message is capped in msg too', () => {
    const { logger, last } = capture();

    logger.error({ err: new Error(`${SECRET_TEXT} ${'x'.repeat(16_000)}`) });

    // Redaction markers may lengthen the capped text; scrubMessage's bound is 2x.
    expect(last().msg.length).toBeLessThanOrEqual(2 * SCRUB_MESSAGE_MAX + TRUNCATED_MESSAGE.length);
    expect(last().msg).toContain(TRUNCATED_MESSAGE);
  });

  it('a 16k explicit message is capped', () => {
    const { logger, last } = capture();

    logger.info({ requestId: 'r' }, 'y'.repeat(16_000));

    expect(last().msg.length).toBeLessThanOrEqual(SCRUB_MESSAGE_MAX + TRUNCATED_MESSAGE.length);
  });

  it('interpolation: a secret argument is scrubbed (%s, %o, %j)', () => {
    const { logger, raw, last } = capture();

    logger.error('failed %s', SECRET_TEXT);
    expect(last().msg).toBe(`failed ${SCRUBBED}`);
    logger.error({ a: 1 }, 'failed %o', { dsn: DSN });
    logger.error('failed %j', { dsn: DSN });
    logger.error('failed %s', new Error(SECRET_TEXT));

    expect(raw()).not.toContain('LEAK');
  });

  it('interpolation with a 16k argument is capped', () => {
    const { logger, last } = capture();

    logger.warn('payload %s', 'z'.repeat(16_000));

    expect(last().msg.length).toBeLessThanOrEqual(SCRUB_MESSAGE_MAX + TRUNCATED_MESSAGE.length);
  });

  it('a raw `msg` field is scrubbed', () => {
    const { logger, raw } = capture();

    logger.info({ msg: SECRET_TEXT });

    expect(raw()).not.toContain('LEAK');
  });

  it('child loggers: omitted-message, interpolation and explicit shapes', () => {
    const { logger, raw, last } = capture();
    const child = logger.child({ component: 'c' }).child({ more: 1 });

    child.error({ err: new Error(SECRET_TEXT) });
    expect(last().msg).toBe(SCRUBBED);
    expect(last().component).toBe('c');
    child.error(new Error(SECRET_TEXT));
    child.error('failed %s', SECRET_TEXT);
    child.error({ error: new Error(SECRET_TEXT) }, `explicit ${SECRET_TEXT}`);

    expect(raw()).not.toContain('LEAK');
  });

  it('pino child bindings carrying an error are serialised through the scrubbing serializer', () => {
    const { logger, raw, last } = capture();
    const child = logger.child({ err: new Error(SECRET_TEXT) });

    child.info('hello');

    expect(last().msg).toBe('hello');
    expect(raw()).not.toContain('LEAK');
  });

  it('keeps pino’s redacting interpolation: %j, %o and a dropped trailing object', () => {
    const { logger, raw } = capture();

    logger.info('value %j', { password: 'LEAK' });
    logger.info('value %o', { password: 'LEAK' });
    (logger.info as (...args: unknown[]) => void)('value %s', 'ok', { password: 'LEAK' });

    expect(raw()).not.toContain('LEAK');
    expect(raw()).toContain(REDACTED);
  });

  it('never throws for %j with a bigint', () => {
    const { logger, last } = capture();

    expect(() => logger.info('value %j', { amount: 1n })).not.toThrow();
    expect(last().msg).toContain('value');
  });

  it('scrubs a null/undefined-leading call', () => {
    const { logger, raw } = capture();

    logger.info(null, 'Bearer LEAK');
    logger.info(undefined, 'Bearer LEAK');

    expect(raw()).not.toContain('LEAK');
  });

  it('scrubs a plain error-like object’s message', () => {
    const { logger, raw, last } = capture();

    logger.error({ err: { message: 'Bearer LEAK' } });

    expect(raw()).not.toContain('LEAK');
    expect(last().msg).toBe(`Bearer ${REDACTED}`);
  });

  it('scrubs messages added after the call: child msg binding, msgPrefix, mixin', () => {
    const { logger, raw, last } = capture();

    logger.child({ msg: 'Bearer LEAK' }).info({ requestId: 'r' });
    logger.child({}, { msgPrefix: 'Bearer LEAK ' }).info('hello');
    expect(last().msg).toBe(`Bearer ${REDACTED} hello`);
    setLogContextProvider(() => ({ msg: 'Bearer LEAK' }) as never);
    try {
      logger.info('hello');
    } finally {
      clearLogContextProvider();
    }

    expect(raw()).not.toContain('LEAK');
  });

  it('caps a long message added by a child binding', () => {
    const { logger, last } = capture();

    logger.child({ msg: 'w'.repeat(16_000) }).info({ requestId: 'r' });

    expect(last().msg.length).toBeLessThanOrEqual(SCRUB_MESSAGE_MAX + TRUNCATED_MESSAGE.length);
  });

  it('does not mutate the caller’s fields object', () => {
    const { logger } = capture();
    const fields = { msg: SECRET_TEXT, err: new Error(SECRET_TEXT) };

    logger.info(fields, 'explicit');

    expect(fields.msg).toBe(SECRET_TEXT);
  });
});
