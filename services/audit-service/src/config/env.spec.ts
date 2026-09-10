import { corsOrigins, brokersOf, DEFAULT_PORT, loadAuditEnv, SERVICE_NAME } from './env';
import { DEFAULT_MAX_QUERY_WINDOW_DAYS } from '../audit/audit.query.dto';

const RUNTIME_URL = 'postgresql://rasta_audit:pw@localhost:5433/rasta_audit?schema=audit';
const MIGRATOR_URL = 'postgresql://rasta_audit_migrator:pw@localhost:5433/rasta_audit?schema=audit';

/**
 * The identity settings every service needs, and this one needs as of AUD-002.
 *
 * Generated rather than written down: a 32-character literal assigned to
 * something called a secret is indistinguishable from a real one to a scanner,
 * and a scanner taught to ignore this file has been taught to ignore the next
 * one (AGENTS.md S-01).
 */
const AUTH = {
  OIDC_ISSUER_URL: 'http://auth.invalid/realms/rasta',
  OIDC_JWKS_URI: 'http://auth.invalid/realms/rasta/protocol/openid-connect/certs',
  OIDC_AUDIENCE: 'rasta-api',
  INTERNAL_TOKEN_SECRET: 'x'.repeat(48),
} as const;

function base(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL_AUDIT: RUNTIME_URL,
    KAFKA_BROKERS: 'localhost:9092',
    ...AUTH,
    ...overrides,
  };
}

describe('audit-service configuration', () => {
  it('falls back to the documented port when neither PORT nor PORT_AUDIT is set', () => {
    // 3115 is what `.env.example` (`PORT_AUDIT`), `AUDIT_SERVICE_URL` and the
    // service map in CLAUDE.md all name. Pinned so a future edit cannot
    // quietly move the service to a port the gateway does not route to.
    const env = loadAuditEnv(base());

    expect(env.PORT).toBe(Number(DEFAULT_PORT));
    expect(DEFAULT_PORT).toBe('3115');
    expect(env.SERVICE_NAME).toBe(SERVICE_NAME);
  });

  it('prefers PORT over PORT_AUDIT, because a container sets only PORT', () => {
    expect(loadAuditEnv(base({ PORT: '4000', PORT_AUDIT: '3115' })).PORT).toBe(4000);
    expect(loadAuditEnv(base({ PORT_AUDIT: '3115' })).PORT).toBe(3115);
  });

  describe('the runtime database url, which is the append-only design in one line', () => {
    it('resolves DATABASE_URL from DATABASE_URL_AUDIT', () => {
      expect(loadAuditEnv(base()).DATABASE_URL).toBe(RUNTIME_URL);
    });

    it('never falls back to the migrator url, even when it is the only one set', () => {
      // The test this file exists for. The migrator role owns schema `audit`
      // and can drop it; the runtime role holds only SELECT and INSERT. A
      // fallback "so it works in development" would hand the service exactly
      // the powers ADR-053 § 6 withholds — and would fail open, silently, in
      // the environment nobody watches.
      // Everything else valid, so the only thing this can be failing on is the
      // database url. A bare object would also throw, for four other reasons.
      expect(() =>
        loadAuditEnv({
          KAFKA_BROKERS: 'localhost:9092',
          ...AUTH,
          DATABASE_URL_AUDIT_MIGRATOR: MIGRATOR_URL,
        }),
      ).toThrow();
    });

    it('does not silently accept the migrator url alongside the runtime one', () => {
      const env = loadAuditEnv(base({ DATABASE_URL_AUDIT_MIGRATOR: MIGRATOR_URL }));

      expect(env.DATABASE_URL).toBe(RUNTIME_URL);
      expect(env.DATABASE_URL).not.toContain('rasta_audit_migrator');
    });

    it('refuses to start with no database url at all', () => {
      // AUD-001 opens a client and writes on every message. Starting without a
      // database would mean answering health checks while recording nothing.
      expect(() => loadAuditEnv({ KAFKA_BROKERS: 'localhost:9092', ...AUTH })).toThrow();
    });
  });

  it('requires a broker list, because the projector is the whole service', () => {
    expect(() => loadAuditEnv({ DATABASE_URL_AUDIT: RUNTIME_URL, ...AUTH })).toThrow();
  });

  it('defaults the consumer group to the one ADR-053 names', () => {
    expect(loadAuditEnv(base()).KAFKA_CONSUMER_GROUP).toBe('audit-service.domain-projector');
  });

  it('reads the broker list as a trimmed, empty-free list', () => {
    expect(brokersOf(loadAuditEnv(base({ KAFKA_BROKERS: 'a:9092, b:9092 ,' })))).toEqual([
      'a:9092',
      'b:9092',
    ]);
  });

  it('rejects an out-of-range port instead of coercing it', () => {
    expect(() => loadAuditEnv(base({ PORT: '70000' }))).toThrow();
    expect(() => loadAuditEnv(base({ PORT: 'not-a-port' }))).toThrow();
  });

  it('reads cors origins as a trimmed, empty-free list', () => {
    expect(corsOrigins(loadAuditEnv(base({ CORS_ORIGINS: '' })))).toEqual([]);
    expect(
      corsOrigins(loadAuditEnv(base({ CORS_ORIGINS: 'https://a.test, https://b.test ,' }))),
    ).toEqual(['https://a.test', 'https://b.test']);
  });

  it('falls back to the gateway origin list when the service has none of its own', () => {
    expect(
      corsOrigins(loadAuditEnv(base({ GATEWAY_CORS_ORIGINS: 'https://portal.test' }))),
    ).toEqual(['https://portal.test']);
  });

  describe('identity, which AUD-002 made mandatory', () => {
    // AUD-001 deliberately omitted `authEnvSchema`: the only routes were two
    // `@Public` probes, so there was no token to verify. AUD-002 adds two
    // private read endpoints behind global guards, and a service that could
    // start without a JWKS endpoint would be a service whose guard fails at the
    // first request rather than at boot.
    it.each([['OIDC_ISSUER_URL'], ['OIDC_JWKS_URI'], ['OIDC_AUDIENCE'], ['INTERNAL_TOKEN_SECRET']])(
      'refuses to start without %s',
      (missing) => {
        const env = base();
        delete env[missing];
        expect(() => loadAuditEnv(env)).toThrow();
      },
    );

    it('refuses an internal token secret too short to be meaningful', () => {
      expect(() => loadAuditEnv(base({ INTERNAL_TOKEN_SECRET: 'short' }))).toThrow();
    });
  });

  describe('the mandatory query window ceiling', () => {
    it('defaults to the documented ninety days', () => {
      // ADR-053 § 10 names 90 and `.env.example` publishes it. Pinned against
      // the constant the schema builder also uses, so the default cannot drift
      // between the configuration and the message a 400 quotes.
      expect(loadAuditEnv(base()).AUDIT_MAX_QUERY_WINDOW_DAYS).toBe(DEFAULT_MAX_QUERY_WINDOW_DAYS);
      expect(DEFAULT_MAX_QUERY_WINDOW_DAYS).toBe(90);
    });

    it('accepts an operator-chosen ceiling', () => {
      const env = loadAuditEnv(base({ AUDIT_MAX_QUERY_WINDOW_DAYS: '7' }));

      expect(env.AUDIT_MAX_QUERY_WINDOW_DAYS).toBe(7);
    });

    it.each([['0'], ['-1'], ['367'], ['30.5'], ['unbounded']])(
      'refuses %s rather than disabling the control',
      (value) => {
        // Below one day no investigation is possible; above a year the widest
        // permitted query stops pruning to a useful set of partitions. A
        // misconfiguration must not be able to turn the ceiling off.
        expect(() => loadAuditEnv(base({ AUDIT_MAX_QUERY_WINDOW_DAYS: value }))).toThrow();
      },
    );
  });
});
