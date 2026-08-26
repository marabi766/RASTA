import { buildRedactionPaths, scrubMessage, REDACTED, SENSITIVE_KEYS } from './redaction';

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
