import { z } from 'zod';
import { booleanEnv } from './env';

/**
 * The boolean environment parser.
 *
 * This exists because `z.coerce.boolean()` applies JavaScript's `Boolean()`,
 * under which every non-empty string is true — so `FLAG=false` parses as
 * `true`. A flag that cannot be turned off is worse than no flag at all: the
 * operator sets it, reads their own configuration back, and believes the
 * feature is disabled.
 *
 * document-service found it the direct way: a test that set
 * `DOCUMENT_ALLOW_UNSCANNED_DOWNLOAD=false` and expected a download to be
 * refused watched it succeed.
 */

const schema = z.object({ FLAG: booleanEnv(true) });
const strict = z.object({ FLAG: booleanEnv(false) });

describe('the trap this replaces', () => {
  it('is real — z.coerce.boolean reads "false" as true', () => {
    // Kept as an executable demonstration rather than a comment, so nobody
    // "simplifies" `booleanEnv` back to the coercion.
    const coerced = z.object({ FLAG: z.coerce.boolean().default(true) });
    expect(coerced.parse({ FLAG: 'false' }).FLAG).toBe(true);
    expect(booleanEnv(true).parse('false')).toBe(false);
  });
});

describe('values that mean false', () => {
  it.each(['false', 'FALSE', 'False', '0', 'no', 'NO', 'off', ' false '])('%s', (value) => {
    expect(schema.parse({ FLAG: value }).FLAG).toBe(false);
  });

  it('treats an empty value as false rather than as unset', () => {
    // `FLAG=` in a .env file is an operator writing something deliberate. It
    // must not fall through to a `true` default.
    expect(schema.parse({ FLAG: '' }).FLAG).toBe(false);
  });
});

describe('values that mean true', () => {
  it.each(['true', 'TRUE', '1', 'yes', 'on', ' true '])('%s', (value) => {
    expect(strict.parse({ FLAG: value }).FLAG).toBe(true);
  });
});

describe('the default', () => {
  it('applies when the variable is absent', () => {
    expect(schema.parse({}).FLAG).toBe(true);
    expect(strict.parse({}).FLAG).toBe(false);
  });
});

describe('anything else', () => {
  it('is refused rather than guessed at', () => {
    // A typo in a security switch should stop the service at boot, not pick a
    // default and carry on. `maybe` silently becoming `true` is exactly the
    // failure mode this parser exists to remove.
    for (const value of ['maybe', 'y', 'enabled', '2', 'null']) {
      expect(() => schema.parse({ FLAG: value })).toThrow();
    }
  });

  it('accepts a real boolean, for a caller passing objects rather than env', () => {
    expect(schema.parse({ FLAG: false }).FLAG).toBe(false);
    expect(schema.parse({ FLAG: true }).FLAG).toBe(true);
  });
});
