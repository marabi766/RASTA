import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  SamplingDecision,
  SimpleSpanProcessor,
  type SpanLimits,
} from '@opentelemetry/sdk-trace-node';
import {
  isWhitespace,
  REDACT_TEXT_MAX,
  RedactingSampler,
  RedactingSpanProcessor,
  redactJsonSource,
  redactQueries,
  redactText,
  TRUNCATED_TEXT,
  urlWithoutQuery,
} from './url-redaction';

describe('urlWithoutQuery', () => {
  it.each([
    ['https://idp.example/cb?code=abc&state=x', 'https://idp.example/cb'],
    ['/v1/x?cursor=abc', '/v1/x'],
    ['/v1/x#abc', '/v1/x'],
    ['/v1/x?', '/v1/x'],
    ['/v1/x', '/v1/x'],
  ])('%s → %s', (url, expected) => {
    expect(urlWithoutQuery(url)).toBe(expected);
  });
});

describe('redactText', () => {
  it.each([
    // V8's JSON.parse message, short and long, quoting the body.
    [
      `Unexpected token '/', "/?code=abc" is not valid JSON`,
      `Unexpected token '/', "[REDACTED]" is not valid JSON`,
    ],
    [
      `Unexpected token 'c', "code=abc" is not valid JSON`,
      `Unexpected token 'c', "[REDACTED]" is not valid JSON`,
    ],
    [
      `Unexpected token 'x', ..."a": 1, "abc"... is not valid JSON`,
      `Unexpected token 'x', "[REDACTED]" is not valid JSON`,
    ],
    // A body that repeats the phrase is still taken whole.
    [
      `Unexpected token 'a', "a" is not valid JSON abc" is not valid JSON`,
      `Unexpected token 'a', "[REDACTED]" is not valid JSON`,
    ],
    // The same line opening a stack trace; the frames stay.
    [
      `SyntaxError: Unexpected token 'c', "code=abc" is not valid JSON\n    at JSON.parse (<anonymous>)`,
      `SyntaxError: Unexpected token 'c', "[REDACTED]" is not valid JSON\n    at JSON.parse (<anonymous>)`,
    ],
    // A body over several lines, by any line terminator (Codex on #261, r2 F1).
    ...['\n', '\r\n', '\r', '\u2028', '\u2029'].map((eol): [string, string] => [
      `SyntaxError: Unexpected token 'c', "code=abc${eol}rest${eol}" is not valid JSON\n    at JSON.parse (<anonymous>)`,
      `SyntaxError: Unexpected token 'c', "[REDACTED]" is not valid JSON\n    at JSON.parse (<anonymous>)`,
    ]),
    [
      `Unexpected token 'x', ..."a": 1,\n"abc"... is not valid JSON`,
      `Unexpected token 'x', "[REDACTED]" is not valid JSON`,
    ],
    // A URL in an error message, with a query of pairs or a bare token.
    [
      'GET https://idp.example/cb?code=abc&state=x failed',
      'GET https://idp.example/cb?[REDACTED] failed',
    ],
    ['request to /v1/x?abc failed', 'request to /v1/x?[REDACTED] failed'],
    // From the first `?` or `#` to whitespace or the end, whatever it holds:
    // nothing inside a query ends it early (Codex on #261, r3 F1).
    [`"/v1/x?cursor=abc"`, `"/v1/x?[REDACTED]`],
    ['at h (/app/x.js?v=abc:1:2)', 'at h (/app/x.js?[REDACTED]'],
    [
      "GET https://idp.example/cb?state=can't&access_token=abc failed",
      'GET https://idp.example/cb?[REDACTED] failed',
    ],
    [
      'GET https://idp.example/cb#access_token=abc failed',
      'GET https://idp.example/cb#[REDACTED] failed',
    ],
    ['GET https://idp.example/cb#x?access_token=abc', 'GET https://idp.example/cb#[REDACTED]'],
    [
      'GET https://idp.example/cb?q="abc"&r=[abc]&s=<abc>&t={abc}&u=`abc` failed',
      'GET https://idp.example/cb?[REDACTED] failed',
    ],
    [
      'GET https://idp.example/cb?q=مسیر&r=café‽abc failed',
      'GET https://idp.example/cb?[REDACTED] failed',
    ],
    // A URL that ends the text.
    ['POST https://idp.example/token?code=abc', 'POST https://idp.example/token?[REDACTED]'],
    ["redirect to /cb?state=can't&code=abc", 'redirect to /cb?[REDACTED]'],
    // A query with no path before it.
    ['bad query ?code=abc', 'bad query ?[REDACTED]'],
    ['callback cb?abc refused', 'callback cb?[REDACTED] refused'],
    // Not a query, left alone: a `?` with whitespace or the end after it.
    ['Is the connection open?', 'Is the connection open?'],
    ['is it ready?', 'is it ready?'],
    ['Is it open? No', 'Is it open? No'],
    ['and/or? yes', 'and/or? yes'],
    ['issue #12, C# and this.#x', 'issue #12, C# and this.#x'],
    // Glued to what follows it after a word, a `?` is taken for a query:
    // redaction may take more than the query, never less.
    ['is it ready?!', 'is it ready?[REDACTED]'],
    ['WHERE a = ? AND b IN (?, ?)', 'WHERE a = ? AND b IN (?, ?)'],
    ['connect ECONNREFUSED 127.0.0.1:5432', 'connect ECONNREFUSED 127.0.0.1:5432'],
  ])('%j → %j', (text, expected) => {
    expect(redactText(text)).toBe(expected);
  });
});

/**
 * Round 4's two rules as regular expressions, kept as the oracle: the linear
 * scanners must redact exactly what these did (r5 ruling: same semantics). Only
 * ever run on short texts — on long ones they are the quadratic patterns Codex
 * measured (r4 F1).
 */
const R4_QUERY_IN_TEXT = /(?<=\/[^\s?#]*)[?#]\S+|(?<=[\p{L}\p{N}_.~%-])\?\S+|\?(?=\S*[=&])\S+/gu;
const R4_JSON_SOURCE_IN_TEXT = /(?:\.\.\.)?"[\s\S]*"(?:\.\.\.)? is not valid JSON/g;
const r4RedactJsonSource = (text: string): string =>
  text.replace(R4_JSON_SOURCE_IN_TEXT, `"[REDACTED]" is not valid JSON`);
const r4RedactQueries = (text: string): string =>
  text.replace(R4_QUERY_IN_TEXT, (suffix) => `${suffix.charAt(0)}[REDACTED]`);

/** mulberry32: a seeded generator, so a failing text can be reproduced. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What the random texts are made of: every character, and phrase, the rules turn on. */
const PIECES = [
  ...['/', '//', '?', '#', '=', '&', '"', '...', '"...', ' is not valid JSON', '"... is not'],
  ...[' ', '\n', '\t', "'", '!', ',', ':', '(', ')', 'a', 'Z', '0', '_', '.', '~', '%', '-'],
  ...['é', 'م', '𝐀', '‽', 'https://h.example/cb', 'code=abc'],
  // Whitespace past ASCII, and lone surrogate halves.
  ...[0xa0, 0x1680, 0x2009, 0x2028, 0x2029, 0x202f, 0x3000, 0xfeff, 0xd835, 0xdc00].map((code) =>
    String.fromCharCode(code),
  ),
];

describe('the linear rules redact exactly what round 4 did (r4 F1)', () => {
  it('isWhitespace is \\s, for every UTF-16 code unit', () => {
    const differ: number[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      if (isWhitespace(code) !== /^\s$/u.test(String.fromCharCode(code))) differ.push(code);
    }
    expect(differ).toEqual([]);
  });

  it('a `?` after each UTF-16 code unit, and after each astral letter or digit', () => {
    const differ: string[] = [];
    const before = [
      ...Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code)),
      '𝐀',
      '𝟘',
      '😀',
    ];
    for (const text of before.map((c) => `x ${c}?q`)) {
      if (redactQueries(text) !== r4RedactQueries(text)) differ.push(text);
    }
    expect(differ).toEqual([]);
  });

  it('on 30,000 random texts of the characters the rules turn on', () => {
    const next = seeded(261);
    const differ: { rule: string; text: string }[] = [];
    for (let i = 0; i < 30_000; i++) {
      let text = '';
      for (let length = Math.floor(next() * 16); length > 0; length--) {
        text += PIECES[Math.floor(next() * PIECES.length)];
      }
      if (redactJsonSource(text) !== r4RedactJsonSource(text)) differ.push({ rule: 'json', text });
      if (redactQueries(text) !== r4RedactQueries(text)) differ.push({ rule: 'query', text });
      if (redactText(text) !== r4RedactQueries(r4RedactJsonSource(text))) {
        differ.push({ rule: 'both', text });
      }
    }
    expect(differ.slice(0, 5)).toEqual([]);
  });
});

describe('redactText cuts a text to REDACT_TEXT_MAX first, and fails closed at the cut (r4 F1)', () => {
  const LONG = 16_000;
  it.each([
    ['no URL', 'a'.repeat(LONG), `${'a'.repeat(REDACT_TEXT_MAX)}${TRUNCATED_TEXT}`],
    [
      'a query running past the cut',
      `GET https://h.example/cb?${'x'.repeat(LONG)}`,
      `GET https://h.example/cb?[REDACTED]${TRUNCATED_TEXT}`,
    ],
    [
      'a path-less query whose `=` is past the cut',
      `bad query ?${'x'.repeat(LONG)}=abc`,
      `bad query ?[REDACTED]${TRUNCATED_TEXT}`,
    ],
    [
      'a parser source whose closing phrase is past the cut',
      `Unexpected token 'c', "${'x'.repeat(LONG)}" is not valid JSON`,
      `Unexpected token 'c', "[REDACTED]${TRUNCATED_TEXT}`,
    ],
    [
      'a closing phrase before the cut, and a later one past it',
      `Unexpected token 'a', "a" is not valid JSON ${'x'.repeat(LONG)}" is not valid JSON`,
      `Unexpected token 'a', "[REDACTED]${TRUNCATED_TEXT}`,
    ],
  ])('%s', (_, text, expected) => {
    expect(redactText(text)).toBe(expected);
  });

  it('a text of exactly REDACT_TEXT_MAX is whole', () => {
    const text = `${'a'.repeat(REDACT_TEXT_MAX - 13)} /cb?code=abc`;
    expect(redactText(text)).toBe(`${'a'.repeat(REDACT_TEXT_MAX - 13)} /cb?[REDACTED]`);
  });

  it('never between the halves of a surrogate pair', () => {
    const text = `${'a'.repeat(REDACT_TEXT_MAX - 1)}${'𝐀'.repeat(10)}`;
    expect(redactText(text)).toBe(`${'a'.repeat(REDACT_TEXT_MAX - 1)}${TRUNCATED_TEXT}`);
  });
});

/** Texts against each rule's worst case (Codex on #261, r4 F1), `length` long. */
const ADVERSARIAL: [string, (length: number) => string][] = [
  ['no URL', (length) => 'a'.repeat(length)],
  ['quotes only', (length) => '"'.repeat(length)],
  ["'?' only", (length) => '?'.repeat(length)],
  ["'?' after a word", (length) => 'a?'.repeat(length / 2)],
  ["'#' only", (length) => '#'.repeat(length)],
  ["'/' only", (length) => '/'.repeat(length)],
  ["'/' then '?' glued to whitespace", (length) => '/?\t'.repeat(length / 3)],
  ["'=' only", (length) => '='.repeat(length)],
  ['closing phrases without a quote', (length) => `"${'x is not valid JSON'.repeat(length / 19)}`],
  ['quote, then closing phrases', (length) => '" is not valid JSON'.repeat(length / 19)],
];

/** Header-long: Node's 16 KiB limit. */
const ADVERSARIAL_LENGTH = 16_384;
/** Loose enough for a loaded CI runner; round 4 took ~566 ms on 15,000 characters. */
const TIME_BOUND_MS = 50;

const elapsedMs = (run: () => unknown): number => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

/**
 * CPU time `run` takes, in milliseconds. Not wall time: on a runner busy with
 * other jobs the process is preempted, and a longer sample is preempted more
 * often — CI measured a linear 16k/4k ratio of 23 by the wall clock.
 */
const cpuMs = (run: () => unknown): number => {
  const start = process.cpuUsage();
  run();
  const { user, system } = process.cpuUsage(start);
  return (user + system) / 1000;
};

/**
 * How much more `long` costs than `short`: the least CPU time of `samples`
 * runs of `calls` back-to-back calls each, the two sampled in turn.
 */
function costRatio(
  short: () => unknown,
  long: () => unknown,
  { samples, calls } = { samples: 15, calls: 10 },
): number {
  const repeated = (run: () => unknown) => () => {
    for (let call = 0; call < calls; call++) run();
  };
  let leastShort = Infinity;
  let leastLong = Infinity;
  for (let sample = 0; sample < samples; sample++) {
    leastShort = Math.min(leastShort, cpuMs(repeated(short)));
    leastLong = Math.min(leastLong, cpuMs(repeated(long)));
  }
  return leastLong / leastShort;
}

/**
 * How many code units `run` reads through `charCodeAt` and `codePointAt` —
 * every read the scanners make outside `indexOf` and `lastIndexOf`, which are
 * single linear searches.
 */
function codeUnitReads(run: () => unknown): number {
  const { charCodeAt, codePointAt } = String.prototype;
  let reads = 0;
  String.prototype.charCodeAt = function (this: string, index: number) {
    reads++;
    return charCodeAt.call(this, index);
  };
  String.prototype.codePointAt = function (this: string, index: number) {
    reads++;
    return codePointAt.call(this, index);
  };
  try {
    run();
  } finally {
    String.prototype.charCodeAt = charCodeAt;
    String.prototype.codePointAt = codePointAt;
  }
  return reads;
}

/** Both rules over the whole text, no cut. */
const uncapped = (text: string): string => redactQueries(redactJsonSource(text));

describe('redaction is linear in the text, and bounded (r4 F1)', () => {
  it.each(ADVERSARIAL)('%s: 16,384 characters through redactText', (_, make) => {
    const text = make(ADVERSARIAL_LENGTH);
    let redacted = '';
    expect(elapsedMs(() => (redacted = redactText(text)))).toBeLessThan(TIME_BOUND_MS);
    expect(redacted.endsWith(TRUNCATED_TEXT)).toBe(true);
  });

  it.each(ADVERSARIAL)('%s: 16,384 characters through both rules, uncut', (_, make) => {
    const text = make(ADVERSARIAL_LENGTH);
    expect(elapsedMs(() => uncapped(text))).toBeLessThan(TIME_BOUND_MS);
  });

  it.each(ADVERSARIAL)(
    '%s: four times the text costs about four times as much, not sixteen',
    (_, make) => {
      const short = make(ADVERSARIAL_LENGTH / 4);
      const long = make(ADVERSARIAL_LENGTH);
      for (let warm = 0; warm < 3; warm++) {
        uncapped(short);
        uncapped(long);
      }
      // Work that is quadratic takes long enough to time in one call — and too
      // long to time in 150.
      const slow = elapsedMs(() => uncapped(long)) >= TIME_BOUND_MS;
      const ratio = costRatio(
        () => uncapped(short),
        () => uncapped(long),
        slow ? { samples: 3, calls: 1 } : undefined,
      );
      expect(ratio).toBeLessThan(8);
    },
  );

  it.each(ADVERSARIAL)('%s: each character is read a bounded number of times', (_, make) => {
    for (const length of [ADVERSARIAL_LENGTH / 4, ADVERSARIAL_LENGTH]) {
      const text = make(length);
      expect(codeUnitReads(() => uncapped(text))).toBeLessThanOrEqual(4 * text.length + 4);
    }
  });

  it('a span started with header-long attributes, not sampled: the sampler still sanitizes, quickly', () => {
    const sampler = new RedactingSampler(new AlwaysOffSampler());
    const slow: { name: string; ms: number }[] = [];
    for (const [name, make] of ADVERSARIAL) {
      const value = make(ADVERSARIAL_LENGTH);
      const attributes = {
        'user_agent.original': value,
        'server.address': value,
        'client.address': value,
        'url.path': value,
      };
      const ms = elapsedMs(() =>
        sampler.shouldSample(ROOT_CONTEXT, 'trace', 'GET', SpanKind.SERVER, attributes, []),
      );
      if (ms >= TIME_BOUND_MS) slow.push({ name, ms });
      expect(attributes).not.toHaveProperty(['user_agent.original']);
      for (const key of ['server.address', 'client.address', 'url.path'] as const) {
        expect(attributes[key].endsWith(TRUNCATED_TEXT)).toBe(true);
        expect(attributes[key].length).toBeLessThanOrEqual(
          REDACT_TEXT_MAX + '[REDACTED]'.length + TRUNCATED_TEXT.length,
        );
      }
    }
    expect(slow).toEqual([]);
  });
});

/** A provider redacting as `initTelemetry`'s does: the sampler, then the processor. */
const redactingProvider = (
  exporter: InMemorySpanExporter,
  spanLimits?: SpanLimits,
): BasicTracerProvider =>
  new BasicTracerProvider({
    sampler: new RedactingSampler(new AlwaysOnSampler()),
    spanLimits,
    spanProcessors: [new RedactingSpanProcessor(), new SimpleSpanProcessor(exporter)],
  });

describe('RedactingSampler and RedactingSpanProcessor', () => {
  it('rewrites URL attributes set at start and later, drops url.query, keeps the rest', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = redactingProvider(exporter);
    const span = provider.getTracer('test').startSpan('GET /v1/x/:id', {
      attributes: {
        'url.full': 'https://h.example/v1/x/1?cursor=abc#f',
        'url.query': 'cursor=abc',
      },
    });
    span.setAttributes({
      'http.url': 'http://h.example/v1/x/1?q=abc',
      'http.target': '/v1/x/1?q=abc',
      'url.path': '/v1/x/1',
      'http.route': '/v1/x/:id',
    });
    span.end();
    await provider.forceFlush();

    const [exported] = exporter.getFinishedSpans();
    expect(exported?.name).toBe('GET /v1/x/:id');
    expect(exported?.attributes).toEqual({
      'url.full': 'https://h.example/v1/x/1',
      'http.url': 'http://h.example/v1/x/1',
      'http.target': '/v1/x/1',
      'url.path': '/v1/x/1',
      'http.route': '/v1/x/:id',
    });
  });

  it('sanitizes recorded exceptions, the status message, other attributes, events and links', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = redactingProvider(exporter);
    const tracer = provider.getTracer('test');
    const linked = tracer.startSpan('linked');
    linked.end();
    const span = tracer.startSpan('middleware - jsonParser', {
      links: [{ context: linked.spanContext(), attributes: { 'peer.url': '/cb?code=abc' } }],
    });
    const error = new SyntaxError(`Unexpected token '/', "/?code=abc" is not valid JSON`);
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.addEvent('retry', { 'http.request.target': ['/v1/x?cursor=abc', '/v1/y'], attempt: 2 });
    span.setAttributes({
      'error.detail': 'GET /v1/x?cursor=abc',
      'http.response.status_code': 400,
    });
    span.end();
    await provider.forceFlush();

    const exported = exporter.getFinishedSpans().find((s) => s.name === 'middleware - jsonParser');
    const { attributes, events, links, status } = exported ?? {};
    expect(JSON.stringify({ attributes, events, links, status })).not.toContain('abc');
    const redacted = `Unexpected token '/', "[REDACTED]" is not valid JSON`;
    expect(exported?.status).toEqual({ code: SpanStatusCode.ERROR, message: redacted });
    const [exception, retry] = exported?.events ?? [];
    expect(exception?.attributes).toMatchObject({
      'exception.type': 'SyntaxError',
      'exception.message': redacted,
    });
    expect(exception?.attributes?.['exception.stacktrace']).toMatch(
      new RegExp(`^SyntaxError: ${redacted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n\\s+at `),
    );
    expect(retry?.attributes).toEqual({
      'http.request.target': ['/v1/x?[REDACTED]', '/v1/y'],
      attempt: 2,
    });
    expect(exported?.attributes).toEqual({
      'error.detail': 'GET /v1/x?[REDACTED]',
      'http.response.status_code': 400,
    });
    expect(exported?.links[0]?.attributes).toEqual({ 'peer.url': '/cb?[REDACTED]' });
  });

  it('leaves an OK or unset status as it is', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = redactingProvider(exporter);
    const ok = provider.getTracer('test').startSpan('ok');
    ok.setStatus({ code: SpanStatusCode.OK });
    ok.end();
    provider.getTracer('test').startSpan('unset').end();
    await provider.forceFlush();

    expect(exporter.getFinishedSpans().map((s) => s.status)).toEqual([
      { code: SpanStatusCode.OK },
      { code: SpanStatusCode.UNSET },
    ]);
  });

  it('sanitizes each value whole, before attributeValueLengthLimit cuts it (r2 F1)', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = redactingProvider(exporter, { attributeValueLengthLimit: 40 });
    const tracer = provider.getTracer('test');
    const linked = tracer.startSpan('linked');
    linked.end();
    const span = tracer.startSpan('middleware - jsonParser');
    // Cut to 40 characters, this message loses its closing `" is not valid
    // JSON` and keeps the body: `Unexpected token 'c', "code=abc` + newline.
    const error = new SyntaxError(`Unexpected token 'c', "code=abc\nrest" is not valid JSON`);
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.setAttribute('error.detail', `Unexpected token 'c', "code=abc" is not valid JSON`);
    span.addEvent('retry', {
      'error.detail': `Unexpected token 'c', "code=abc" is not valid JSON`,
    });
    span.addLink({
      context: linked.spanContext(),
      attributes: { 'error.detail': `Unexpected token 'c', "code=abc" is not valid JSON` },
    });
    span.end();
    await provider.forceFlush();

    const exported = exporter.getFinishedSpans().find((s) => s.name === 'middleware - jsonParser');
    const { attributes, events, links, status } = exported ?? {};
    expect(JSON.stringify({ attributes, events, links, status })).not.toContain('abc');
    const redacted = `Unexpected token 'c', "[REDACTED]" is not valid JSON`;
    const cut = redacted.slice(0, 40);
    expect(cut).toBe(`Unexpected token 'c', "[REDACTED]" is no`);
    // The SDK does not cut a status message.
    expect(exported?.status).toEqual({ code: SpanStatusCode.ERROR, message: redacted });
    const [exception, retry] = exported?.events ?? [];
    expect(exception?.attributes).toEqual({
      'exception.type': 'SyntaxError',
      'exception.message': cut,
      'exception.stacktrace': `SyntaxError: ${redacted}`.slice(0, 40),
    });
    expect(retry?.attributes).toEqual({ 'error.detail': cut });
    expect(exported?.attributes).toEqual({ 'error.detail': cut });
    expect(exported?.links[0]?.attributes).toEqual({ 'error.detail': cut });
  });

  it('sanitizes the attributes and links a span starts with whole, before attributeValueLengthLimit cuts them (r3 F2)', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = redactingProvider(exporter, { attributeValueLengthLimit: 40 });
    const tracer = provider.getTracer('test');
    const linked = tracer.startSpan('linked');
    linked.end();
    // Cut to 40 characters first, each of these would keep "abc" and lose what marks it.
    const parserShaped = `Unexpected token 'c', "code=abc" is not valid JSON`;
    tracer
      .startSpan('GET', {
        attributes: {
          'user_agent.original': parserShaped,
          'client.address': parserShaped,
          'server.address': `h.example/a-long-path-segment?code=abc`,
          'url.full': 'https://h.example/v1/a-long-path-segment?code=abc',
          'url.query': 'code=abc',
          'http.request.method': 'GET',
        },
        links: [{ context: linked.spanContext(), attributes: { 'error.detail': parserShaped } }],
      })
      .end();
    await provider.forceFlush();

    const exported = exporter.getFinishedSpans().find((s) => s.name === 'GET');
    expect(JSON.stringify({ ...exported?.attributes, links: exported?.links })).not.toContain(
      'abc',
    );
    const cut = `Unexpected token 'c', "[REDACTED]" is no`;
    expect(exported?.attributes).toEqual({
      'client.address': cut,
      'server.address': 'h.example/a-long-path-segment?[REDACTED]',
      'url.full': 'https://h.example/v1/a-long-path-segment',
      'http.request.method': 'GET',
    });
    expect(exported?.links[0]?.attributes).toEqual({ 'error.detail': cut });
  });

  it('holds attributes a delegate sampler adds to the same rules, and leaves its decision alone', () => {
    const delegate = {
      shouldSample: () => ({
        decision: SamplingDecision.RECORD,
        attributes: { 'url.query': 'code=abc', 'error.detail': 'GET /cb?code=abc' },
      }),
    };
    const result = new RedactingSampler(delegate).shouldSample(
      ROOT_CONTEXT,
      'trace',
      'span',
      SpanKind.INTERNAL,
      {},
      [],
    );
    expect(result).toEqual({
      decision: SamplingDecision.RECORD,
      attributes: { 'error.detail': 'GET /cb?[REDACTED]' },
    });
  });
});

interface ExportedSpan {
  name: string;
  kind: SpanKind;
  scope: string;
  attributes: Record<string, unknown>;
  events: { name: string; attributes?: Record<string, unknown> }[];
  status: { code: SpanStatusCode; message?: string };
}

const PACKAGE_DIR = resolve(__dirname, '..');
const FIXTURE = resolve(__dirname, '__tests__/url-query-spans.fixture.ts');
const SWC_OPTIONS = resolve(PACKAGE_DIR, '../../jest.swc.cjs');
const CHILD_TIMEOUT_MS = 60_000;

/** Compiles `.ts` with the jest SWC options, then runs the fixture. */
const RUN_FIXTURE = `
const { readFileSync } = require('node:fs');
const swc = require('@swc/core');
const options = require(${JSON.stringify(SWC_OPTIONS)});
require.extensions['.ts'] = (module, filename) => {
  const { code } = swc.transformSync(readFileSync(filename, 'utf8'), { ...options, filename, swcrc: false });
  module._compile(code, filename);
};
require(${JSON.stringify(FIXTURE)});
`;

interface FixtureResult {
  origin: string;
  refused: string;
  spans: ExportedSpan[];
}

/** Runs the fixture with no `OTEL_*` variable from this process, plus `env`. */
async function runFixture(env: Record<string, string> = {}): Promise<FixtureResult> {
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', RUN_FIXTURE], {
    cwd: PACKAGE_DIR,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('OTEL_')),
      ),
      ...env,
    },
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout) as FixtureResult;
}

/** The middleware spans of the bodies the JSON parser refused, in the order sent. */
const parserSpans = (spans: ExportedSpan[]): ExportedSpan[] =>
  spans.filter(
    (span) =>
      span.scope === '@opentelemetry/instrumentation-express' &&
      span.name === 'middleware - jsonParser' &&
      span.status.code === SpanStatusCode.ERROR,
  );

/** What the parser errors read once redacted, in the order the bodies were sent. */
const REDACTED_PARSER_ERRORS = ['/', 'c', 'c', 'c', 'c', 'c', 'c'].map(
  (token) => `Unexpected token '${token}', "[REDACTED]" is not valid JSON`,
);

const exceptionMessages = (span: ExportedSpan | undefined): unknown[] =>
  (span?.events ?? [])
    .filter((event) => event.name === 'exception')
    .map((event) => event.attributes?.['exception.message']);

describe('initTelemetry — spans from the real instrumentations carry no URL query', () => {
  let origin: string;
  let refused: string;
  let spans: ExportedSpan[];

  const find = (scope: string, kind: SpanKind, path: string): ExportedSpan[] =>
    spans.filter(
      (span) =>
        span.scope === scope &&
        span.kind === kind &&
        [span.attributes['url.path'], span.attributes['url.full']].some(
          (url) => url === path || url === `${origin}${path}`,
        ),
    );

  beforeAll(async () => {
    ({ origin, refused, spans } = await runFixture());
  }, CHILD_TIMEOUT_MS + 5_000);

  it('no exported span holds "abc" — name, attribute, event or status', () => {
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.filter((span) => JSON.stringify(span).includes('abc'))).toEqual([]);
  });

  it('incoming GET /v1/x?secret=abc: the server span keeps path and name, without url.query', () => {
    const [server] = find('@opentelemetry/instrumentation-http', SpanKind.SERVER, '/v1/x');
    expect(server?.name).toBe('GET /v1/x');
    expect(server?.attributes).toMatchObject({ 'url.path': '/v1/x', 'http.route': '/v1/x' });
    expect(server?.attributes).not.toHaveProperty(['url.query']);
  });

  it('the NestJS handler span keeps its route template, url.full is the bare path', () => {
    const [handler] = find(
      '@opentelemetry/instrumentation-nestjs-core',
      SpanKind.INTERNAL,
      '/v1/x',
    );
    expect(handler?.name).toBe('XController.x');
    expect(handler?.attributes).toMatchObject({ 'url.full': '/v1/x', 'http.route': '/v1/x' });
  });

  it('outgoing fetch and node:http keep the URL up to the path', () => {
    const [fetchSpan] = find('@opentelemetry/instrumentation-undici', SpanKind.CLIENT, '/v1/x');
    expect(fetchSpan?.name).toBe('GET');
    expect(fetchSpan?.attributes).toMatchObject({
      'url.full': `${origin}/v1/x`,
      'url.path': '/v1/x',
    });
    expect(fetchSpan?.attributes).not.toHaveProperty(['url.query']);

    const [httpClient] = find('@opentelemetry/instrumentation-http', SpanKind.CLIENT, '/v1/x');
    expect(httpClient?.name).toBe('GET');
    expect(httpClient?.attributes).toMatchObject({ 'url.full': `${origin}/v1/x` });
  });

  it("Nest's 404 for an unknown route: the server span has the path only", () => {
    const [server] = find('@opentelemetry/instrumentation-http', SpanKind.SERVER, '/v1/missing');
    expect(server?.attributes).toMatchObject({
      'url.path': '/v1/missing',
      'http.response.status_code': 404,
    });
    expect(server?.attributes).not.toHaveProperty(['url.query']);
  });

  it('a JSON body the parser refuses, on one line or several: the exception and status stay, the quoted body does not', () => {
    const parsers = parserSpans(spans);
    expect(parsers.map((span) => span.status.message)).toEqual(REDACTED_PARSER_ERRORS);
    expect(parsers.map((span) => exceptionMessages(span))).toEqual(
      REDACTED_PARSER_ERRORS.map((m) => [m]),
    );
    for (const span of parsers) {
      const [exception] = span.events;
      expect(exception?.attributes?.['exception.stacktrace']).toMatch(
        /^SyntaxError: Unexpected token '.', "\[REDACTED\]" is not valid JSON\n\s+at JSON\.parse/,
      );
    }
  });

  it('a handler error naming a URL: its exception and status keep the URL up to the path', () => {
    const [handler] = find(
      '@opentelemetry/instrumentation-nestjs-core',
      SpanKind.INTERNAL,
      '/v1/fail',
    );
    const message = 'GET https://idp.example/cb?[REDACTED] failed';
    expect(handler?.name).toBe('XController.fail');
    expect(handler?.status).toEqual({ code: SpanStatusCode.ERROR, message });
    expect(exceptionMessages(handler)).toEqual([message]);
  });

  it('caller-controlled headers in the server span start attributes are sanitized, the user agent dropped (r3 F2, r4 L1)', () => {
    const [server] = find('@opentelemetry/instrumentation-http', SpanKind.SERVER, '/v1/headers');
    expect(server?.attributes).toMatchObject({
      'server.address': `Unexpected token 'c', "[REDACTED]" is not valid JSON`,
      'client.address': '[/cb?[REDACTED]',
    });
    expect(server?.attributes).not.toHaveProperty(['user_agent.original']);
  });

  it('headers and a path as long as a request makes them: cut to REDACT_TEXT_MAX, then redacted (r4 F1)', () => {
    const server = (path: string): ExportedSpan | undefined =>
      find('@opentelemetry/instrumentation-http', SpanKind.SERVER, path)[0];
    expect(server('/v1/headers/user-agent')?.attributes).not.toHaveProperty([
      'user_agent.original',
    ]);
    expect(server('/v1/headers/quotes')?.attributes['server.address']).toBe(
      `"[REDACTED]${TRUNCATED_TEXT}`,
    );
    expect(server('/v1/headers/questions')?.attributes['client.address']).toBe(
      `[a?[REDACTED]${TRUNCATED_TEXT}`,
    );
    expect(server('/v1/headers/slashes')?.attributes['server.address']).toBe(
      `${'/'.repeat(REDACT_TEXT_MAX)}${TRUNCATED_TEXT}`,
    );
    const [longPath] = spans.filter(
      (span) =>
        span.kind === SpanKind.SERVER &&
        String(span.attributes['url.path']).startsWith('/v1/long/'),
    );
    expect(longPath?.attributes['url.path']).toBe(
      `/v1/long/${'a'.repeat(REDACT_TEXT_MAX - '/v1/long/'.length)}${TRUNCATED_TEXT}`,
    );
  });

  it('a failed outgoing fetch: the error is recorded, url.full has no query', () => {
    const [failed] = spans.filter(
      (span) =>
        span.scope === '@opentelemetry/instrumentation-undici' &&
        span.attributes['url.full'] === `${refused}/v1/x`,
    );
    expect(failed?.status.code).toBe(SpanStatusCode.ERROR);
    expect(exceptionMessages(failed)).toEqual([expect.stringContaining('ECONNREFUSED')]);
    expect(failed?.attributes).not.toHaveProperty(['url.query']);
  });
});

describe('initTelemetry under OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT=40 — a cut value carries nothing either (r2 F1)', () => {
  const LIMIT = 40;
  let spans: ExportedSpan[];

  beforeAll(async () => {
    ({ spans } = await runFixture({ OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT: String(LIMIT) }));
  }, CHILD_TIMEOUT_MS + 5_000);

  it('the limit is in force', () => {
    const lengths = spans.flatMap((span) => [
      ...Object.values(span.attributes),
      ...span.events.flatMap((event) => Object.values(event.attributes ?? {})),
    ]);
    expect(lengths.filter((value) => typeof value === 'string' && value.length > LIMIT)).toEqual(
      [],
    );
  });

  it('no exported span holds "abc"', () => {
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.filter((span) => JSON.stringify(span).includes('abc'))).toEqual([]);
  });

  it('the server span start attributes from headers: sanitized whole, then cut (r3 F2)', () => {
    const [server] = spans.filter(
      (span) =>
        span.scope === '@opentelemetry/instrumentation-http' &&
        span.kind === SpanKind.SERVER &&
        span.attributes['url.path'] === '/v1/headers',
    );
    expect(server?.attributes).toMatchObject({
      'server.address': `Unexpected token 'c', "[REDACTED]" is no`,
      'client.address': '[/cb?[REDACTED]',
    });
    expect(server?.attributes).not.toHaveProperty(['user_agent.original']);
  });

  it('the parser errors are recorded, redacted whole and then cut', () => {
    const parsers = parserSpans(spans);
    expect(parsers.map((span) => span.status.message)).toEqual(REDACTED_PARSER_ERRORS);
    expect(parsers.map((span) => exceptionMessages(span))).toEqual(
      REDACTED_PARSER_ERRORS.map((m) => [m.slice(0, LIMIT)]),
    );
  });
});
