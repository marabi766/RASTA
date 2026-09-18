import { SENSITIVE_KEYS } from '@rasta/logging';
import { REDACTED_ADDRESS, scrubAddresses, withAddressScrubbing } from './scrub';

describe('address scrubbing (ADR-054 § 10, R-5)', () => {
  it('is needed: the shared redactor does not know the key `email`', () => {
    // The premise of this file. If the platform list ever gains `email`, this
    // service-local control becomes belt-and-braces rather than the only belt,
    // and this test should be updated to say so.
    expect(SENSITIVE_KEYS).not.toContain('email');
    expect(SENSITIVE_KEYS).toContain('personalEmail');
  });

  it('replaces every address-shaped token in a message', () => {
    expect(scrubAddresses('resolved fleet.manager+x@example.test and admin@sub.domain.ir')).toBe(
      `resolved ${REDACTED_ADDRESS} and ${REDACTED_ADDRESS}`,
    );
  });

  it('leaves identifiers, paths and plain text untouched', () => {
    const line =
      'Intent NTI_01J for INSURANCE_EXPIRING 01J (insurance.expiring) is pending; path /assets/AST_1';
    expect(scrubAddresses(line)).toBe(line);
  });

  it('wraps every level of a logger', () => {
    const seen: string[] = [];
    const logger = withAddressScrubbing({
      info: (m) => void seen.push(`info:${m}`),
      warn: (m) => void seen.push(`warn:${m}`),
      error: (m) => void seen.push(`error:${m}`),
      debug: (m) => void seen.push(`debug:${m}`),
    });

    logger.info('a@b.io');
    logger.warn('c@d.io');
    logger.error('e@f.io');
    logger.debug('g@h.io');

    expect(seen).toEqual([
      `info:${REDACTED_ADDRESS}`,
      `warn:${REDACTED_ADDRESS}`,
      `error:${REDACTED_ADDRESS}`,
      `debug:${REDACTED_ADDRESS}`,
    ]);
  });

  it('tolerates a logger without a debug level', () => {
    const seen: string[] = [];
    const logger = withAddressScrubbing({
      info: (m) => void seen.push(m),
      warn: (m) => void seen.push(m),
      error: (m) => void seen.push(m),
    });
    expect(() => logger.debug('x@y.io')).not.toThrow();
    expect(seen).toEqual([]);
  });
});
