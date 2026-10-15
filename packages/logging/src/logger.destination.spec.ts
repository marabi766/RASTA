import { Writable } from 'node:stream';
import pino from 'pino';
import { clearLogContextProvider, createLogger, setLogContextProvider } from './logger';
import { scrubbedErrorSerializer } from './error-serializer';
import { REDACTED, TRUNCATED_MESSAGE } from './redaction';
import {
  FALLBACK_LINE,
  MAX_LOG_LINE_LENGTH,
  MAX_LOG_STRING_LENGTH,
  scrubLine,
} from './scrubbing-destination';

const METADATA = Symbol.for('pino.metadata');

interface Sink extends Writable {
  lines: string[];
  lastMsg?: unknown;
  lastObj?: unknown;
  lastLogger?: unknown;
  lastLevel?: number;
}

/** A destination that records every line, and what pino told it about each. */
function sink(options: { metadata?: boolean } = {}): Sink {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  }) as Sink;
  stream.lines = lines;
  if (options.metadata) (stream as unknown as Record<symbol, unknown>)[METADATA] = true;
  return stream;
}

function loggerFor(destination: pino.DestinationStream) {
  return createLogger({
    serviceName: 'test',
    level: 'debug',
    environment: 'test',
    pretty: false,
    destination,
  });
}

const text = (stream: Sink) => stream.lines.join('');
const json = (line: string) => JSON.parse(line) as Record<string, any>;

describe('destination metadata (Codex r3 F1)', () => {
  it('does not hand a destination the raw message', () => {
    const stream = sink({ metadata: true });
    const logger = loggerFor(stream);

    logger.child({ component: 'child' }).info('Bearer LEAK');

    expect(stream.lastMsg).toBe(`Bearer ${REDACTED}`);
    expect(JSON.stringify(stream.lastObj ?? null)).not.toContain('LEAK');
    expect(stream.lastLogger).toBeUndefined();
    expect(text(stream)).not.toContain('LEAK');
  });

  it('does not hand a destination the raw fields of the call', () => {
    const stream = sink({ metadata: true });

    loggerFor(stream).info({ note: 'Bearer LEAK', nested: { dsn: 'postgres://u:LEAK@h' } }, 'hi');

    expect(JSON.stringify([stream.lastObj, stream.lastMsg])).not.toContain('LEAK');
  });

  it('keeps the level pino reports', () => {
    const stream = sink({ metadata: true });

    loggerFor(stream).warn('hello');

    expect(stream.lastLevel).toBe(40);
  });
});

describe('multistream destinations', () => {
  it('scrubs the line and the metadata for every member and keeps level routing', () => {
    const everything = sink({ metadata: true });
    const plain = sink();
    const errorsOnly = sink({ metadata: true });
    const logger = loggerFor(
      pino.multistream([
        { stream: everything },
        { stream: plain },
        { level: 'error', stream: errorsOnly },
      ]),
    );

    logger.child({ component: 'c' }).info('Bearer LEAK');
    logger.error({ err: new Error('postgres://u:LEAK@h') }, 'Bearer LEAK');

    expect(text(everything)).not.toContain('LEAK');
    expect(text(plain)).not.toContain('LEAK');
    expect(text(errorsOnly)).not.toContain('LEAK');
    expect(everything.lastMsg).toBe(`Bearer ${REDACTED}`);
    expect(errorsOnly.lastMsg).toBe(`Bearer ${REDACTED}`);
    expect(everything.lines).toHaveLength(2);
    expect(plain.lines).toHaveLength(2);
    expect(errorsOnly.lines).toHaveLength(1);
    expect(json(errorsOnly.lines[0]!).level).toBe('error');
  });

  it('covers a member added after the logger was created', () => {
    const first = sink();
    const late = sink();
    const multi = pino.multistream([{ stream: first }]);
    const logger = loggerFor(multi);
    multi.add({ stream: late, level: 'info' });

    logger.info('Bearer LEAK');

    expect(text(late)).not.toContain('LEAK');
    expect(late.lines).toHaveLength(1);
  });
});

describe('every field of the final line is scrubbed (Codex r3 F2)', () => {
  it('object- and array-valued messages', () => {
    const stream = sink();
    const logger = loggerFor(stream);

    logger.info({ msg: { detail: 'Bearer LEAK' } });
    logger.info({ msg: ['Bearer LEAK'] });
    logger.child({ msg: { text: 'postgres://u:LEAK@h' } }).info('x');

    expect(text(stream)).not.toContain('LEAK');
    expect(text(stream)).toContain(REDACTED);
  });

  it('arbitrary fields, nested values, keys and bindings', () => {
    const stream = sink();
    const logger = loggerFor(stream);

    logger.info({ a: { b: [{ c: 'Bearer LEAK' }] }, 'Bearer LEAK': 1, d: 'postgres://u:LEAK@h' });
    logger.child({ ctx: { dsn: 'postgres://u:LEAK@h' } }).info('x');

    expect(text(stream)).not.toContain('LEAK');
  });

  it('a credential hidden behind a JSON escape', () => {
    const stream = sink();
    const logger = loggerFor(stream);

    logger.info('line\nBearer\nLEAK');
    logger.info('Bearer\tLEAK');
    logger.info('Bearer\u00a0LEAK');
    logger.info('Bearer\u2028LEAK');
    logger.info({ v: 'a "quoted" Bearer LEAK \\ postgres://u:LEAK@h' });

    expect(text(stream)).not.toContain('LEAK');
    // Every line is still valid JSON.
    for (const line of stream.lines) expect(() => json(line)).not.toThrow();
  });

  it('caps a long string inside an object', () => {
    const stream = sink();

    loggerFor(stream).info({ blob: { text: 'q'.repeat(40_000) } });

    const line = json(stream.lines[0]!);
    expect(line.blob.text.length).toBeLessThanOrEqual(MAX_LOG_STRING_LENGTH + 20);
    expect(line.blob.text).toContain('TRUNCATED');
  });

  it('leaves clean lines byte-identical to what pino wrote', () => {
    const raw = sink();
    const scrubbed = sink();
    const options = {
      timestamp: () => ',"time":0',
      base: null,
      formatters: { level: (label: string) => ({ level: label }) },
    };
    const fields = { a: 1, b: 'two "q" \n', c: 'ünï\u2028' };

    pino(options, raw).info(fields, 'hello');
    pino(options, {
      write: (line: string) => scrubbed.write(scrubLine(line)),
    }).info(fields, 'hello');

    expect(scrubbed.lines).toEqual(raw.lines);
  });
});

describe('large numbers are not touched (Codex r3 F4)', () => {
  it('writes bigint fields exactly, top level and in bindings', () => {
    const stream = sink();
    const logger = loggerFor(stream);

    logger.info({ amount: 9007199254740993n }, 'amount');
    logger.info({ huge: 10n ** 400n }, 'huge');
    logger.child({ amount: 9007199254740993n }).info('child');

    expect(stream.lines[0]).toContain('"amount":9007199254740993');
    expect(stream.lines[1]).toContain(`"huge":1${'0'.repeat(400)}`);
    expect(stream.lines[2]).toContain('"amount":9007199254740993');
  });
});

describe('logging never throws (Codex r3 F3)', () => {
  const hostile = {
    toString() {
      throw new Error('conversion');
    },
  };

  it('a throwing toString in interpolation writes the fallback line', () => {
    const stream = sink();

    expect(() => loggerFor(stream).info('value %s', hostile)).not.toThrow();

    expect(stream.lines).toEqual([FALLBACK_LINE]);
  });

  it('a throwing `constructor` getter on err', () => {
    const stream = sink();
    const err = {
      get constructor(): never {
        throw new Error('getter');
      },
    };

    expect(() => loggerFor(stream).error({ err }, 'failed')).not.toThrow();

    expect(text(stream)).not.toContain('getter');
    expect(stream.lines).toHaveLength(1);
  });

  it('a throwing message getter with the message omitted', () => {
    const stream = sink();
    const err = Object.create(Error.prototype, {
      message: {
        get(): never {
          throw new Error('getter');
        },
      },
    }) as Error;

    expect(() => loggerFor(stream).error({ err })).not.toThrow();

    expect(stream.lines).toHaveLength(1);
  });

  it('a throwing toJSON field', () => {
    const stream = sink();

    expect(() =>
      loggerFor(stream).info({
        field: {
          toJSON() {
            throw new Error('json');
          },
        },
      }),
    ).not.toThrow();

    // Pino itself degrades this one to a placeholder; either way one safe line.
    expect(stream.lines).toHaveLength(1);
    expect(() => json(stream.lines[0]!)).not.toThrow();
  });

  it('a throwing field getter, in a child logger too', () => {
    const stream = sink();
    const fields = {
      get boom(): never {
        throw new Error('getter');
      },
    };
    const logger = loggerFor(stream);

    expect(() => logger.child({ component: 'c' }).info(fields, 'x')).not.toThrow();

    expect(stream.lines).toEqual([FALLBACK_LINE]);
  });

  it('a throwing context provider costs the context, not the line', () => {
    const stream = sink();
    setLogContextProvider(() => {
      throw new Error('provider');
    });
    try {
      expect(() => loggerFor(stream).info('hello')).not.toThrow();
    } finally {
      clearLogContextProvider();
    }

    expect(json(stream.lines[0]!).msg).toBe('hello');
  });

  it('a destination that throws', () => {
    const logger = loggerFor({
      write() {
        throw new Error('disk');
      },
    });

    expect(() => logger.info('hello')).not.toThrow();
  });

  it('a revoked proxy as an error', () => {
    const stream = sink();
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(() => loggerFor(stream).error({ err: proxy }, 'failed')).not.toThrow();

    expect(stream.lines).toHaveLength(1);
  });
});

describe('asynchronous destination failures are contained (Codex r4 F2)', () => {
  /** A Writable whose every write fails after `write` has returned. */
  function failing(): Writable {
    return new Writable({
      write(_chunk, _encoding, done) {
        done(new Error('synthetic disk failure'));
      },
    });
  }

  const settle = () => new Promise<void>((done) => setTimeout(done, 20));

  /** Fails the test if the process sees an uncaught exception meanwhile. */
  async function withoutUncaught(run: () => void): Promise<unknown[]> {
    const uncaught: unknown[] = [];
    const listeners = process.listeners('uncaughtException');
    process.removeAllListeners('uncaughtException');
    process.on('uncaughtException', (error) => uncaught.push(error));
    try {
      run();
      await settle();
    } finally {
      process.removeAllListeners('uncaughtException');
      for (const listener of listeners) process.on('uncaughtException', listener);
    }
    return uncaught;
  }

  it('a destination that fails after write returned', async () => {
    const logger = loggerFor(failing());

    expect(await withoutUncaught(() => logger.info('hello'))).toEqual([]);
  });

  it('every member of a multistream, and one added later', async () => {
    const members = [failing(), failing()];
    const late = failing();
    const multi = pino.multistream([{ stream: members[0]! }, { stream: members[1]! }]);
    const logger = loggerFor(multi);
    (logger as unknown as { [k: symbol]: pino.MultiStreamRes })[
      Object.getOwnPropertySymbols(logger).find((s) => s.toString() === 'Symbol(pino.stream)')!
    ]!.add({ stream: late });

    expect(await withoutUncaught(() => logger.info('hello'))).toEqual([]);
    for (const stream of [...members, late]) {
      expect(stream.listenerCount('error')).toBeGreaterThan(0);
    }
  });

  it('keeps logging to the stream that is left', async () => {
    const good = sink();
    const logger = loggerFor(pino.multistream([{ stream: failing() }, { stream: good }]));

    await withoutUncaught(() => logger.info('one'));
    await withoutUncaught(() => logger.info('two'));

    expect(text(good)).toContain('two');
  });
});

describe('transports as destinations (Codex r4 F5)', () => {
  class ThreadStream {
    write(): void {}
  }

  it('is refused, at creation, with a clear error', () => {
    expect(() => loggerFor(new ThreadStream() as unknown as pino.DestinationStream)).toThrow(
      /pino transport.*not supported/,
    );
  });

  it('is refused as a multistream member too', () => {
    const multi = { write() {}, streams: [{ stream: new ThreadStream() }] };
    expect(() => loggerFor(multi as unknown as pino.DestinationStream)).toThrow(/transport/);
  });
});

describe('the cap holds after scrubbing (Codex r4 F3)', () => {
  it('a string that grows when its credentials are replaced stays within the budget', () => {
    const stream = sink();

    loggerFor(stream).info('Bearer a '.repeat(1800));

    const { msg } = json(stream.lines[0]!);
    expect(msg.length).toBeLessThanOrEqual(MAX_LOG_STRING_LENGTH + TRUNCATED_MESSAGE.length);
    expect(msg.endsWith(TRUNCATED_MESSAGE)).toBe(true);
  });

  it('a record whose fields grow past the line limit is replaced, not written', () => {
    const fields = Array.from({ length: 2800 }, (_, i) => `"k${i}":"Bearer a"`).join(',');
    const line = `{${fields}}\n`;

    expect(line.length).toBeLessThanOrEqual(MAX_LOG_LINE_LENGTH);
    const out = scrubLine(line);
    expect(out.length).toBeLessThan(200);
    expect(out).toMatch(/line too long/);
  });

  it('escaping that grows a line is counted too', () => {
    const line = `{"msg":"${'é\\u0000'.repeat(9000)}Bearer x"}\n`;
    expect(scrubLine(line).length).toBeLessThanOrEqual(MAX_LOG_LINE_LENGTH);
  });
});

describe('a huge stack costs a bounded scan (Codex r4 F4)', () => {
  it('splits only the head of a 16 MB stack', () => {
    const stack = `Error: x\n${'    at frame (file.js:1:1)\n'.repeat(700_000)}`;
    const started = process.hrtime.bigint();
    const out = scrubbedErrorSerializer(Object.assign(new Error('x'), { stack })) as {
      stack: string;
    };
    const milliseconds = Number(process.hrtime.bigint() - started) / 1e6;

    expect(out.stack.length).toBeLessThan(5000);
    expect(milliseconds).toBeLessThan(50);
  });
});

describe('the line cap and its cost', () => {
  it('replaces a 1 MB message with a fixed short line', () => {
    const stream = sink();

    loggerFor(stream).info('x'.repeat(1024 * 1024));

    expect(stream.lines).toHaveLength(1);
    expect(stream.lines[0]!.length).toBeLessThan(200);
    expect(json(stream.lines[0]!).msg).toMatch(/line too long/);
  });

  it('a 1 MB line holding a credential never reaches the destination', () => {
    const stream = sink();

    loggerFor(stream).info(`${'x'.repeat(1024 * 1024)} Bearer LEAK`);

    expect(text(stream)).not.toContain('LEAK');
  });

  it('a line at the cap is still scrubbed', () => {
    const body = 'y'.repeat(MAX_LOG_LINE_LENGTH - 200);
    const line = `{"msg":"${body} Bearer LEAK"}\n`;

    expect(line.length).toBeLessThanOrEqual(MAX_LOG_LINE_LENGTH);
    expect(scrubLine(line)).not.toContain('LEAK');
  });

  it('is linear: adversarial lines at the cap take a bounded time', () => {
    const shapes = [
      `{"msg":"${'Bearer '.repeat(9000)}"}`,
      `{"msg":"${'a://b:'.repeat(10_000)}"}`,
      `{"msg":"${'\\n'.repeat(30_000)}"}`,
      `{"msg":"${'Bearer\\n'.repeat(8000)}x"}`,
      `{${'"k":"v",'.repeat(7000)}"z":1}`,
    ];
    for (const shape of shapes) {
      expect(shape.length).toBeLessThanOrEqual(MAX_LOG_LINE_LENGTH);
      const started = process.hrtime.bigint();
      scrubLine(shape);
      const milliseconds = Number(process.hrtime.bigint() - started) / 1e6;
      expect(milliseconds).toBeLessThan(250);
    }
  });

  it('a 16 MB line costs the same as a short one', () => {
    const huge = `{"msg":"${'x'.repeat(16 * 1024 * 1024)}"}\n`;
    const started = process.hrtime.bigint();
    const out = scrubLine(huge);
    const milliseconds = Number(process.hrtime.bigint() - started) / 1e6;

    expect(out.length).toBeLessThan(200);
    expect(milliseconds).toBeLessThan(20);
  });

  it('a line that is not well-formed throws from scrubLine and is replaced by the stream', () => {
    expect(() => scrubLine('{"msg":"open')).toThrow();
    expect(() => scrubLine('{"msg":"bad \\x"}')).toThrow();

    const stream = sink();
    const destination = pino.destination as unknown;
    void destination;
    const logger = loggerFor(stream);
    // A raw write through the logger's own stream: pino never produces this.
    (logger as unknown as { [k: symbol]: { write(s: string): void } })[
      Object.getOwnPropertySymbols(logger).find((s) => s.toString() === 'Symbol(pino.stream)')!
    ]!.write('{"msg":"Bearer LEAK');
    expect(stream.lines).toEqual([FALLBACK_LINE]);
  });
});
