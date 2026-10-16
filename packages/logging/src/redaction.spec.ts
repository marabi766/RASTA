import { Writable } from 'node:stream';
import pino from 'pino';
import {
  buildRedactionPaths,
  scrubMessage,
  REDACTED,
  SCRUB_MESSAGE_MAX,
  SENSITIVE_KEYS,
  TRUNCATED_MESSAGE,
} from './redaction';

describe('buildRedactionPaths', () => {
  it('covers every sensitive key at the root and one level down', () => {
    const paths = buildRedactionPaths();
    for (const key of SENSITIVE_KEYS) {
      expect(paths).toContain(key);
      expect(paths).toContain(`*.${key}`);
    }
  });

  it('covers the authorization header in both casings', () => {
    const paths = buildRedactionPaths();
    expect(paths).toContain('req.headers.authorization');
    expect(paths).toContain('req.headers.Authorization');
  });

  it('covers the sealed bid fields', () => {
    // Bid content before the deadline is the most sensitive data the platform
    // holds — it must not be visible even to the platform operator.
    const paths = buildRedactionPaths();
    expect(paths).toContain('bidAmount');
    expect(paths).toContain('sealedPayload');
  });

  it('censors an Idempotency-Key in a request header and in a logged object (S-09)', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString('utf8'));
        done();
      },
    });
    const logger = pino({ redact: { paths: buildRedactionPaths(), censor: REDACTED } }, sink);

    logger.info(
      {
        req: { headers: { 'idempotency-key': 'create-project-0042' } },
        internalContext: { idempotencyKey: 'create-project-0042' },
      },
      'request',
    );

    const written = lines.join('');
    expect(written).not.toContain('create-project-0042');
    expect(written).toContain(REDACTED);
  });

  it('produces no duplicates', () => {
    const paths = buildRedactionPaths();
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('scrubMessage', () => {
  it('strips the password from a connection string', () => {
    // The classic leak: a driver error echoing the DSN it failed to open.
    const message =
      'Failed to connect: postgresql://rasta_economic:s3cr3tP4ss@db:5432/rasta_economic';

    const result = scrubMessage(message);

    expect(result).not.toContain('s3cr3tP4ss');
    expect(result).toContain(REDACTED);
    expect(result).toContain('rasta_economic'); // username stays — it aids diagnosis
  });

  it('strips a bearer token', () => {
    const result = scrubMessage('Rejected header Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9');

    expect(result).not.toContain('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(result).toBe(`Rejected header Bearer ${REDACTED}`);
  });

  it('strips basic auth', () => {
    const result = scrubMessage('Basic cmFzdGE6c2VjcmV0');
    expect(result).not.toContain('cmFzdGE6c2VjcmV0');
  });

  it('handles multiple credentials in one message', () => {
    const result = scrubMessage('redis://user:pw1@cache:6379 and postgresql://u2:pw2@db:5432/x');
    expect(result).not.toContain('pw1');
    expect(result).not.toContain('pw2');
  });

  it('leaves clean messages untouched', () => {
    const message = 'Order ORD_01JBQ8Z4K7M2N5P8R1T3V6X9Y2 completed in 42ms';
    expect(scrubMessage(message)).toBe(message);
  });
});

/** The regular expressions `scrubMessage` was before it was made linear: the reference for normal inputs. */
function referenceScrub(message: string): string {
  return message
    .replace(/(\w+:\/\/)([^:@/\s]+):([^@/\s]+)@/g, `$1$2:${REDACTED}@`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${REDACTED}`);
}

describe('scrubMessage matches the reference on inputs within the cap', () => {
  const pieces = [
    'postgresql://',
    'redis://',
    '://',
    'a',
    'user',
    'pw',
    ':',
    '@',
    '/',
    ' ',
    '\n',
    '\u00a0',
    'Bearer',
    'bearer',
    'BASIC',
    'Basic',
    'xBearer',
    '_',
    '-',
    '.',
    '=',
    '==',
    '+',
    '~',
    '!',
    'é',
  ];

  it('agrees on 20000 random piece-strings', () => {
    let seed = 12345;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 20000; i++) {
      let text = '';
      for (let n = next(14); n > 0; n--) text += pieces[next(pieces.length)];
      expect(scrubMessage(text)).toBe(referenceScrub(text));
    }
  });

  it.each([
    'a://u:p@h b://v:q@i',
    'x://u:p:q@h',
    'x://u@h:5432',
    'x://u:p/rest@h',
    'x:// u:p@h',
    '://u:p@h',
    'Bearer   abc==  Bearer def',
    'Bearer\tabc.def-ghi_jkl',
    'Bearer ',
    'Bearer !',
    'xBearer abc',
    'Basic Basic Basic',
    'proxy://a:b@c://d:e@f',
  ])('agrees on %j', (text) => {
    expect(scrubMessage(text)).toBe(referenceScrub(text));
  });
});

describe('scrubMessage is bounded and linear on adversarial input', () => {
  const OVER = 16 * 1024;
  const adversarial: Record<string, string> = {
    'one long word': 'a'.repeat(OVER),
    'a long word before a scheme separator': `${'a'.repeat(OVER)}://u:p@h`,
    'many equals signs': '='.repeat(OVER),
    'many quotes': '"'.repeat(OVER),
    'many scheme separators': '://'.repeat(Math.floor(OVER / 3)),
    'many userinfo colons': `x://${':'.repeat(OVER)}`,
    'many Bearer words': 'Bearer '.repeat(Math.floor(OVER / 7)),
    'long whitespace after Bearer': `Bearer${' '.repeat(OVER)}!`,
    'no secrets': 'Order ORD_01JBQ8Z4K7M2N5P8R1T3V6X9Y2 completed in 42ms. '.repeat(OVER / 50),
  };

  /** Fastest of a few runs, so one descheduled run cannot fail the bound. */
  function best(text: string): number {
    let fastest = Infinity;
    for (let run = 0; run < 5; run++) {
      const start = process.hrtime.bigint();
      scrubMessage(text);
      fastest = Math.min(fastest, Number(process.hrtime.bigint() - start) / 1e6);
    }
    return fastest;
  }

  it.each(Object.entries(adversarial))('cuts %s to the cap before scrubbing', (_name, text) => {
    const result = scrubMessage(text);
    expect(result.endsWith(TRUNCATED_MESSAGE)).toBe(true);
    // A redaction can be longer than what it replaces, never more than a few times.
    expect(result.length).toBeLessThanOrEqual(2 * SCRUB_MESSAGE_MAX + TRUNCATED_MESSAGE.length);
    // Only the first SCRUB_MESSAGE_MAX characters are ever read: more input changes nothing.
    expect(scrubMessage(text + text)).toBe(result);
  });

  it.each(Object.entries(adversarial))('scrubs %s far faster than quadratic', (_name, text) => {
    // The regular expressions took 24-28 ms at 4k and 436-443 ms at 16k on a
    // long word. Linear under a 4k cap is well under a millisecond; 50 ms on
    // the best of five runs fails a regression, not a slow runner.
    expect(best(text)).toBeLessThan(50);
  });

  it('drops a password cut off at the cap, with the rest of its word', () => {
    const head = `${'a '.repeat((SCRUB_MESSAGE_MAX - 30) / 2)}db://user:s3cr3tpassword`;
    const result = scrubMessage(head + 'x'.repeat(OVER));
    expect(result).not.toContain('s3cr3t');
    expect(result).toBe(`${'a '.repeat((SCRUB_MESSAGE_MAX - 30) / 2)}${TRUNCATED_MESSAGE}`);
  });

  it('keeps nothing of a text with no whitespace before the cap', () => {
    expect(scrubMessage('x'.repeat(OVER))).toBe(TRUNCATED_MESSAGE);
  });

  it('does not split a surrogate pair at the cap', () => {
    const text = `${' '.repeat(SCRUB_MESSAGE_MAX - 1)}😀${'b'.repeat(10)}`;
    expect(scrubMessage(text)).toBe(`${' '.repeat(SCRUB_MESSAGE_MAX - 1)}${TRUNCATED_MESSAGE}`);
  });

  it('leaves a message of exactly the cap untouched', () => {
    const text = 'a'.repeat(SCRUB_MESSAGE_MAX);
    expect(scrubMessage(text)).toBe(text);
  });
});
