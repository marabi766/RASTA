import { Writable } from 'node:stream';
import { createLogger } from './logger';
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
