import { Writable } from 'node:stream';
import pino from 'pino';
import {
  clearLogContextProvider,
  createLogger,
  MAX_LOG_ARGUMENT_LENGTH,
  setLogContextProvider,
} from './logger';
import { MAX_STACK_SCAN, scrubbedErrorSerializer } from './error-serializer';
import { REDACTED, SCRUB_MESSAGE_MAX, scrubMessage, TRUNCATED_MESSAGE } from './redaction';
import { MAX_LOG_LINE_LENGTH, MAX_LOG_STRING_LENGTH, scrubLine } from './scrubbing-destination';

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

describe('only a plain stream is a destination (Codex on #290, r5 R5-2/R5-3)', () => {
  it('refuses a multistream: its holder could add a member no listener guards', () => {
    const multi = pino.multistream([{ stream: sink() }]);

    expect(() => loggerFor(multi)).toThrow(/multistream is not supported/);
  });

  it('refuses a multistream nested in a multistream', () => {
    const nested = pino.multistream([{ stream: pino.multistream([{ stream: sink() }]) }]);

    expect(() => loggerFor(nested)).toThrow(/multistream is not supported/);
  });

  it('refuses a real two-target transport, alone and nested two multistreams deep', async () => {
    const transport = pino.transport({
      targets: [
        { target: 'pino/file', options: { destination: 1 } },
        { target: 'pino/file', options: { destination: 1 } },
      ],
    }) as pino.DestinationStream & { end(): void; once(event: string, cb: () => void): void };
    try {
      expect(() => loggerFor(transport)).toThrow(/transport \(pino.transport\) is not supported/);
      expect(() =>
        loggerFor(pino.multistream([{ stream: pino.multistream([{ stream: transport }]) }])),
      ).toThrow(/not supported/);
    } finally {
      await new Promise<void>((done) => {
        transport.once('close', done);
        transport.end();
      });
    }
  });

  it('accepts a Writable and pino.destination', () => {
    expect(() => loggerFor(sink())).not.toThrow();
    const file = pino.destination({ dest: '/dev/null', sync: true });
    try {
      expect(() => loggerFor(file)).not.toThrow();
    } finally {
      file.destroy();
    }
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

    expect(stream.lines).toHaveLength(1);
    expect(json(stream.lines[0]!)).toMatchObject({
      time: expect.any(String),
      level: expect.any(String),
      service: expect.any(String),
      msg: 'log record dropped: not serialisable',
    });
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

    expect(stream.lines).toHaveLength(1);
    expect(json(stream.lines[0]!)).toMatchObject({
      time: expect.any(String),
      level: expect.any(String),
      service: expect.any(String),
      msg: 'log record dropped: not serialisable',
    });
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

  it('every later write to a failed destination as well', async () => {
    const destination = failing();
    const logger = loggerFor(destination);

    expect(await withoutUncaught(() => logger.info('one'))).toEqual([]);
    expect(await withoutUncaught(() => logger.info('two'))).toEqual([]);
    expect(destination.listenerCount('error')).toBeGreaterThan(0);
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

  it('is refused inside anything shaped like a multistream', () => {
    const multi = { write() {}, streams: [{ stream: new ThreadStream() }] };
    expect(() => loggerFor(multi as unknown as pino.DestinationStream)).toThrow(/not supported/);
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

/**
 * CPU milliseconds `work` takes, the least of three runs: a loaded CI runner
 * stretches wall-clock time (50.6 ms against a 50 ms bound, #290 r6 CI) but
 * not the CPU a run uses, and one descheduled run cannot fail the bound.
 */
function cpuMs(work: () => void): number {
  let least = Infinity;
  for (let run = 0; run < 3; run++) {
    const started = process.cpuUsage();
    work();
    const { user, system } = process.cpuUsage(started);
    least = Math.min(least, (user + system) / 1000);
  }
  return least;
}

describe('a huge stack costs a bounded scan (Codex r4 F4)', () => {
  it('splits only the head of a 16 MB stack', () => {
    const error = Object.assign(new Error('x'), {
      stack: `Error: x\n${'    at frame (file.js:1:1)\n'.repeat(700_000)}`,
    });
    let out = { stack: '' };

    const milliseconds = cpuMs(() => {
      out = scrubbedErrorSerializer(error) as { stack: string };
    });

    expect(out.stack.length).toBeLessThan(5000);
    expect(milliseconds).toBeLessThan(50);
  });
});

describe('a cut drops the line it runs through (Codex on #290, r5 R5-1)', () => {
  /** Anything of the password kept: `ZZ` occurs nowhere else in the output. */
  const SECRET = 'ZZSECRETZZ';
  const DSN = `postgres://u:${SECRET}@db/app`;

  it('the r5 trigger: the stack scan cuts a frame-shaped line before its "@"', () => {
    const stream = sink();
    const err = new Error(`${'x'.repeat(65_492)}\n    at postgres://u:SYNTHETIC_SECRET@db/app`);
    // The offsets the review gives: the password starts at 65,520, its `@` is at 65,536.
    expect(err.stack!.indexOf('SYNTHETIC_SECRET')).toBe(65_520);
    expect(err.stack!.indexOf('@db/app')).toBe(MAX_STACK_SCAN);

    loggerFor(stream).error({ err }, 'failed');

    expect(text(stream)).not.toContain('SYNTHETIC');
    expect(json(stream.lines[0]!).err.stack).toContain(TRUNCATED_MESSAGE);
  });

  it('every cut position of a connection string across the stack scan', () => {
    // As in the trigger: a long message, then one short frame line holding the
    // connection string, so the frames are short enough for no later cap to hide it.
    for (let offset = 0; offset <= DSN.length + 1; offset++) {
      const start = MAX_STACK_SCAN - offset;
      const stack = `Error: ${'x'.repeat(start - 15)}\n    at ${DSN}\n    at g (b.js:1:1)`;
      expect(stack.indexOf(DSN)).toBe(start);

      const out = scrubbedErrorSerializer(Object.assign(new Error('m'), { stack })) as {
        stack: string;
      };

      expect(out.stack).not.toContain('ZZ');
    }
  });

  it('every cut position of a connection string or bearer token at the message cap', () => {
    for (const max of [SCRUB_MESSAGE_MAX, MAX_LOG_STRING_LENGTH, 64]) {
      for (const secret of [DSN, `Bearer ${SECRET}`]) {
        for (let offset = 0; offset <= secret.length + 1; offset++) {
          const message = `${' '.repeat(max - offset)}${secret} tail`;
          expect(message.indexOf(secret)).toBe(max - offset);

          expect(scrubMessage(message, max)).not.toContain('ZZ');
        }
      }
    }
  });
});

describe('the line cap and its cost', () => {
  it('replaces a 1 MB message with a safe short marker after bounding its arguments', () => {
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
      expect(cpuMs(() => scrubLine(shape))).toBeLessThan(250);
    }
  });

  it('a 16 MB line costs the same as a short one', () => {
    const huge = `{"msg":"${'x'.repeat(16 * 1024 * 1024)}"}\n`;
    let out = '';

    const milliseconds = cpuMs(() => {
      out = scrubLine(huge);
    });

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
    expect(stream.lines).toHaveLength(1);
    expect(json(stream.lines[0]!)).toMatchObject({
      time: expect.any(String),
      level: expect.any(String),
      service: expect.any(String),
      msg: 'log record dropped: not serialisable',
    });
  });
});

describe('T-07 arguments are bounded before pino formats them', () => {
  // Observe the actual arguments handed to pino, independently of the final
  // destination cap. Removing the argument cap must fail this test.
  function beforePino(args: unknown[]): unknown[] {
    const logger = loggerFor(sink());
    const { hooksSym } = pino.symbols as unknown as { hooksSym: symbol };
    const hook = (
      logger as unknown as Record<
        symbol,
        {
          logMethod(args: unknown[], method: (...args: unknown[]) => void, level: number): void;
        }
      >
    )[hooksSym]!;
    let captured: unknown[] = [];
    hook.logMethod.call(
      logger,
      args,
      (...values: unknown[]) => {
        captured = values;
      },
      30,
    );
    return captured;
  }

  it('caps messages, interpolated strings and direct merge-object string values without mutation', () => {
    const huge = 'safe '.repeat(MAX_LOG_ARGUMENT_LENGTH);
    const fields = Object.freeze({
      msg: huge,
      detail: huge,
      count: 42,
      amount: 9007199254740993n,
      ok: true,
    });
    const args = [fields, 'value %s', huge];
    const out = beforePino(args);
    const bounded = out[0] as typeof fields;
    for (const value of [bounded.msg, bounded.detail, out[2] as string]) {
      expect(value.length).toBeLessThanOrEqual(MAX_LOG_ARGUMENT_LENGTH + TRUNCATED_MESSAGE.length);
      expect(value.endsWith(TRUNCATED_MESSAGE)).toBe(true);
    }
    expect(bounded).toMatchObject({ count: 42, amount: 9007199254740993n, ok: true });
    expect(fields.msg).toBe(huge);
    expect(args[0]).toBe(fields);
    expect(out[1]).toBe('value %s');
    expect(beforePino([huge])[0]).toEqual(bounded.msg);
  });

  it('preserves Error instances and primitive values for the existing serializers', () => {
    const err = new Error('postgresql://u:SECRET@h');
    const fields = { err, error: err };
    const args = [err, fields, 12, 9007199254740993n, false, null, undefined];
    const out = beforePino(args);
    out.forEach((arg, index) => expect(arg).toBe(args[index]));
  });

  it('caps a string returned by an enumerable getter and preserves null-prototype objects', () => {
    const huge = 'safe '.repeat(MAX_LOG_ARGUMENT_LENGTH);
    const fields = Object.create(null) as { detail: string };
    Object.defineProperty(fields, 'detail', { enumerable: true, get: () => huge });
    const out = beforePino([fields])[0] as typeof fields;
    expect(out.detail.length).toBeLessThanOrEqual(
      MAX_LOG_ARGUMENT_LENGTH + TRUNCATED_MESSAGE.length,
    );
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(fields.detail).toBe(huge);
  });

  it('also bounds direct string fields of class instances and arrays', () => {
    class Fields {
      detail = 'safe '.repeat(MAX_LOG_ARGUMENT_LENGTH);
      amount = 9007199254740993n;
    }
    const fields = new Fields();
    const values = [fields.detail, fields.amount];
    const out = beforePino([fields, values]);
    expect(out[0]).toBeInstanceOf(Fields);
    expect((out[0] as Fields).detail.length).toBeLessThanOrEqual(
      MAX_LOG_ARGUMENT_LENGTH + TRUNCATED_MESSAGE.length,
    );
    expect((out[0] as Fields).amount).toBe(fields.amount);
    expect(Array.isArray(out[1])).toBe(true);
    expect((out[1] as unknown[])[0]).toBe((out[0] as Fields).detail);
    expect((out[1] as unknown[])[1]).toBe(fields.amount);
    expect(values[0]).toBe(fields.detail);
  });

  it('leaves a string exactly at the cap unchanged before formatting', () => {
    const exact = 'x'.repeat(MAX_LOG_ARGUMENT_LENGTH);
    expect(beforePino([exact, { detail: exact }])).toEqual([exact, { detail: exact }]);
  });

  it('drops every credential fragment crossing the argument boundary in every supported position', () => {
    const stream = sink();
    const logger = loggerFor(stream);
    for (const secret of ['postgresql://u:ZZSECRETZZ@h', 'Bearer ZZSECRETZZ']) {
      for (let offset = 0; offset <= secret.length + 1; offset++) {
        const value = `${' '.repeat(MAX_LOG_ARGUMENT_LENGTH - offset)}${secret} tail`;
        const args = beforePino([value, { detail: value }]);
        expect(args[0]).not.toContain('ZZ');
        expect((args[1] as { detail: string }).detail).not.toContain('ZZ');
        logger.info(value);
        logger.info({ detail: value });
        logger.info('value %s', value);
        logger.info({ msg: value });
      }
    }
    for (const line of stream.lines) {
      expect(line).not.toContain('ZZ');
      expect(line).toContain('TRUNCATED');
    }
  });

  it('still scrubs credentials before and after interpolation and on Error-derived msg', () => {
    const stream = sink();
    const logger = loggerFor(stream);
    const large = `postgresql://u:ZZSECRETZZ@h ${'safe '.repeat(4000)}`;
    logger.info(large);
    logger.info({ detail: large });
    logger.info('postgresql://u:%s@h %s', 'ZZSECRETZZ', large);
    const errorText = `postgresql://u:ZZSECRETZZ@h ${'safe '.repeat(4000)}`;
    logger.error({ err: new Error(errorText) });
    logger.error(new Error(errorText));
    expect(stream.lines).toHaveLength(5);
    expect(text(stream)).not.toContain('ZZSECRET');
    expect(text(stream)).toContain(REDACTED);
    expect(json(stream.lines[3]!).err.message).toContain(REDACTED);
  });

  it.each(['message', 'merge object', 'interpolation'])(
    '16 MiB %s completes far below the old 156 ms',
    (shape) => {
      const logger = loggerFor({ write() {} });
      const large = 'safe '.repeat(Math.ceil((16 * 1024 * 1024) / 5));
      const baseline = large.slice(0, 1024);
      const log = (value: string): void => {
        if (shape === 'merge object') logger.info({ detail: value });
        else if (shape === 'interpolation') logger.info('value %s', value);
        else logger.info(value);
      };
      log(baseline); // warm up; fixtures are built outside the measured call
      const smallMs = cpuMs(() => log(baseline));
      const largeMs = cpuMs(() => log(large));
      // CPU time + least of three avoid the wall-clock flake seen in #290.
      expect(largeMs).toBeLessThan(Math.max(30, smallMs * 30));
    },
  );
});

describe('T-07 drop markers carry a separate safe envelope', () => {
  afterEach(() => clearLogContextProvider());
  const tooLarge = { nested: { payload: 'DROPPED_CONTENT '.repeat(MAX_LOG_LINE_LENGTH) } };

  it('keeps time, original level, service and all IDs, without any payload or forged envelope', () => {
    const stream = sink({ metadata: true });
    setLogContextProvider(() => ({
      correlationId: 'request-1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
    }));
    loggerFor(stream).warn(
      {
        ...tooLarge,
        time: 'forged-time',
        service: 'forged-service',
        level: 'forged-level',
        password: 'SECRET',
      },
      'DROPPED_CONTENT',
    );
    const marker = json(stream.lines[0]!);
    expect(marker).toEqual({
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      level: 'warn',
      service: 'test',
      correlationId: 'request-1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      msg: 'log record dropped: line too long',
      length: expect.any(Number),
    });
    expect(Date.parse(marker.time)).toBeGreaterThan(Date.now() - 60_000);
    expect(stream.lastLevel).toBe(40);
    expect(text(stream)).not.toMatch(/DROPPED_CONTENT|SECRET|forged/);
  });

  it('takes child bindings and call IDs with the same precedence as pino', () => {
    const stream = sink();
    setLogContextProvider(() => ({ correlationId: 'context', tenantId: 'context-tenant' }));
    loggerFor(stream)
      .child({ correlationId: 'child', tenantId: 'child-tenant', organizationId: 'child-org' })
      .error({ ...tooLarge, correlationId: 'call' });
    expect(json(stream.lines[0]!)).toMatchObject({
      level: 'error',
      correlationId: 'call',
      tenantId: 'context-tenant',
      organizationId: 'child-org',
    });
  });

  it('omits absent IDs instead of borrowing another request’s envelope', () => {
    const stream = sink();
    const logger = loggerFor(stream);
    setLogContextProvider(() => ({ correlationId: 'first', tenantId: 'first-tenant' }));
    logger.info(tooLarge);
    clearLogContextProvider();
    logger.info(tooLarge);
    const marker = json(stream.lines[1]!);
    expect(marker).not.toHaveProperty('correlationId');
    expect(marker).not.toHaveProperty('tenantId');
    expect(marker).not.toHaveProperty('organizationId');
    expect(marker).toMatchObject({ level: 'info', service: 'test' });
  });

  it('omits credential-like, malformed and oversized IDs without invoking conversion', () => {
    const stream = sink();
    loggerFor(stream).info({
      ...tooLarge,
      correlationId: 'postgresql://u:SECRET@h',
      tenantId: 'Bearer SECRET',
      organizationId: 'x'.repeat(1024),
    });
    const marker = json(stream.lines[0]!);
    expect(Object.keys(marker).sort()).toEqual(['length', 'level', 'msg', 'service', 'time']);
    expect(text(stream)).not.toContain('SECRET');
  });

  it('gives a formatting failure the same envelope without exposing the thrown text', () => {
    const stream = sink();
    setLogContextProvider(() => ({ correlationId: 'request', tenantId: 'tenant' }));
    loggerFor(stream).debug('value %s', {
      toString() {
        throw new Error('SECRET');
      },
    });
    expect(json(stream.lines[0]!)).toEqual({
      time: expect.any(String),
      level: 'debug',
      service: 'test',
      correlationId: 'request',
      tenantId: 'tenant',
      msg: 'log record dropped: not serialisable',
    });
    expect(text(stream)).not.toContain('SECRET');
  });

  it('retains the envelope when scrubbing expands a record past the line cap', () => {
    const stream = sink();
    const fields = Object.fromEntries(
      Array.from({ length: 2800 }, (_, i) => [`k${i}`, 'Bearer a']),
    );
    loggerFor(stream).info({ ...fields, correlationId: 'expanded' });
    expect(json(stream.lines[0]!)).toMatchObject({
      level: 'info',
      service: 'test',
      correlationId: 'expanded',
      msg: 'log record dropped: line too long',
    });
  });

  it('restores the outer envelope after a reentrant log call', () => {
    const stream = sink();
    const logger = loggerFor(stream);
    const fields = {
      ...tooLarge,
      correlationId: 'outer',
      get reenter() {
        logger.error({ ...tooLarge, correlationId: 'inner' });
        return true;
      },
    };
    logger.warn(fields);
    expect(stream.lines.map((line) => json(line).correlationId)).toEqual(['inner', 'outer']);
    expect(stream.lines.map((line) => json(line).level)).toEqual(['error', 'warn']);
  });
});
