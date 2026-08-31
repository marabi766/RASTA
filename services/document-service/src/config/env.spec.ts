import { clamdAddress, loadDocumentEnv } from './env';

/**
 * The scanner configuration, and the two things it refuses.
 *
 * The interesting assertions here are the refusals. `documentEnvSchema` is
 * where AGENTS.md S-08 is enforced for this service: the clamd protocol
 * authenticates nobody, so a TCP listener's only protection would be "nothing
 * else is on this network", and a production deployment that reached that
 * state would run, scan and look entirely healthy while trusting an
 * unauthenticated network endpoint. It is refused at startup instead — the
 * process exits, because a warning in a boot log is not a control (ADR-049).
 */

/** Everything the schema demands, with nothing scanner-related decided. */
const BASE: NodeJS.ProcessEnv = {
  SERVICE_NAME: 'document-service',
  PORT: '3114',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/rasta_document?schema=public',
  KAFKA_BROKERS: 'localhost:9092',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
  OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
  OIDC_AUDIENCE: 'rasta-api',
  INTERNAL_TOKEN_SECRET: 'a-throwaway-value-used-only-by-this-spec-32',
  S3_ACCESS_KEY: 'test-access-key',
  S3_SECRET_KEY: 'test-secret-key',
};

const SOCKET = { DOCUMENT_CLAMAV_SOCKET_PATH: '/run/clamav/clamd.sock' };
const TCP = { DOCUMENT_CLAMAV_HOST: '127.0.0.1', DOCUMENT_CLAMAV_PORT: '3310' };

function load(overrides: NodeJS.ProcessEnv) {
  return loadDocumentEnv({ ...BASE, ...overrides });
}

describe('choosing a scanner', () => {
  it('defaults to ClamAV rather than to the stub', () => {
    // ADR-049 makes ClamAV the platform answer. A default of `disabled` would
    // mean a deployment that configured nothing silently inspected nothing.
    expect(load(SOCKET).DOCUMENT_SCANNER_DRIVER).toBe('clamav');
  });

  it('refuses the ClamAV driver with no address at all', () => {
    expect(() => load({})).toThrow(/DOCUMENT_CLAMAV_SOCKET_PATH|address/);
  });

  it('accepts the stub with no address, for local work without a scanner', () => {
    const env = load({ DOCUMENT_SCANNER_DRIVER: 'disabled' });

    expect(env.DOCUMENT_SCANNER_DRIVER).toBe('disabled');
  });
});

describe('the production transport (AGENTS.md S-08)', () => {
  it('refuses an unauthenticated TCP scanner', () => {
    expect(() => load({ ...TCP, NODE_ENV: 'production' })).toThrow(/DOCUMENT_CLAMAV_HOST/);
  });

  it('refuses TCP even when a socket is also configured', () => {
    // A leftover host from a development `.env` must not be tolerated just
    // because the safer transport happens to be present too. The variable
    // being set at all in production is the problem.
    expect(() => load({ ...SOCKET, ...TCP, NODE_ENV: 'production' })).toThrow(
      /DOCUMENT_CLAMAV_HOST/,
    );
  });

  it('refuses production with no socket', () => {
    expect(() => load({ NODE_ENV: 'production' })).toThrow(/socket|SOCKET_PATH/i);
  });

  it('accepts a Unix socket in production', () => {
    const env = load({ ...SOCKET, NODE_ENV: 'production' });

    expect(clamdAddress(env)).toEqual({
      transport: 'unix',
      socketPath: '/run/clamav/clamd.sock',
    });
  });

  it('allows TCP outside production, which is what CI and a laptop use', () => {
    const env = load({ ...TCP, NODE_ENV: 'test' });

    expect(clamdAddress(env)).toEqual({ transport: 'tcp', host: '127.0.0.1', port: 3310 });
  });

  it('refuses the no-op stub in production', () => {
    // Not a security bypass — NOT_SCANNED is never downloadable — but a
    // deployment configured this way accepts uploads and can hand back none of
    // them, and discovering that from a support ticket is worse than
    // discovering it from a failed boot.
    expect(() =>
      load({ ...SOCKET, DOCUMENT_SCANNER_DRIVER: 'disabled', NODE_ENV: 'production' }),
    ).toThrow(/DOCUMENT_SCANNER_DRIVER|inspects nothing/);
  });

  it('prefers the socket when both are set outside production', () => {
    // The safer transport should never lose a coin toss to whichever branch
    // the code happens to check first.
    const env = load({ ...SOCKET, ...TCP, NODE_ENV: 'development' });

    expect(clamdAddress(env).transport).toBe('unix');
  });
});

describe('the scan bounds', () => {
  it('carries safe defaults without any of them being set', () => {
    const env = load(SOCKET);

    expect(env.DOCUMENT_SCAN_TIMEOUT_MS).toBe(60_000);
    expect(env.DOCUMENT_SCAN_CHUNK_BYTES).toBe(65_536);
    expect(env.DOCUMENT_SCAN_MAX_BYTES).toBe(32 * 1024 * 1024);
    expect(env.DOCUMENT_SCAN_SIGNATURE_MAX_AGE_HOURS).toBe(48);
    expect(env.DOCUMENT_SCAN_MAX_ATTEMPTS).toBe(5);
    expect(env.DOCUMENT_SCAN_WORKER_ENABLED).toBe(true);
  });

  it('reads DOCUMENT_SCAN_WORKER_ENABLED=false as false', () => {
    // `z.coerce.boolean()` reads every non-empty string as true, so a flag
    // explicitly disabled would have stayed on. `booleanEnv` is the parser
    // that reads it as written.
    expect(
      load({ ...SOCKET, DOCUMENT_SCAN_WORKER_ENABLED: 'false' }).DOCUMENT_SCAN_WORKER_ENABLED,
    ).toBe(false);
  });

  it.each([
    ['a timeout of zero', { DOCUMENT_SCAN_TIMEOUT_MS: '0' }],
    ['an unbounded scan size', { DOCUMENT_SCAN_MAX_BYTES: '999999999999' }],
    ['a freshness window switched off', { DOCUMENT_SCAN_SIGNATURE_MAX_AGE_HOURS: '999999' }],
    ['a retry budget of zero', { DOCUMENT_SCAN_MAX_ATTEMPTS: '0' }],
    ['a chunk larger than the frame policy allows', { DOCUMENT_SCAN_CHUNK_BYTES: '99999999' }],
  ])('refuses %s', (_label, override) => {
    // Every one of these is bounded rather than merely defaulted: a limit a
    // deployment can set to a number that disables it is not a limit.
    expect(() => load({ ...SOCKET, ...override })).toThrow();
  });

  it('refuses a lease that expires while a scan could still be running', () => {
    // A lease shorter than the scan deadline gets the document picked up
    // twice. Nothing contradictory is stored — the write-back is conditional —
    // but the work is repeated, and on a busy queue that compounds.
    expect(() =>
      load({ ...SOCKET, DOCUMENT_SCAN_TIMEOUT_MS: '60000', DOCUMENT_SCAN_LEASE_SECONDS: '30' }),
    ).toThrow(/DOCUMENT_SCAN_LEASE_SECONDS/);
  });

  it('accepts a lease comfortably longer than the deadline', () => {
    const env = load({
      ...SOCKET,
      DOCUMENT_SCAN_TIMEOUT_MS: '60000',
      DOCUMENT_SCAN_LEASE_SECONDS: '300',
    });

    expect(env.DOCUMENT_SCAN_LEASE_SECONDS).toBe(300);
  });
});

describe('what the schema still does not have', () => {
  it('has no setting that makes an unscanned document downloadable', () => {
    // `DOCUMENT_ALLOW_UNSCANNED_DOWNLOAD` existed, defaulted to true, and made
    // the platform's out-of-the-box posture the permissive one. It was removed
    // rather than re-defaulted, and nothing added for ADR-049 reintroduces it.
    const env = load(SOCKET) as unknown as Record<string, unknown>;

    const bypasses = Object.keys(env).filter((key) =>
      /ALLOW_UNSCANNED|SKIP_SCAN|BYPASS|UNSAFE_DOWNLOAD/i.test(key),
    );
    expect(bypasses).toEqual([]);
  });
});
