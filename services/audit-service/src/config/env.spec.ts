import { corsOrigins, brokersOf, DEFAULT_PORT, loadAuditEnv, SERVICE_NAME } from './env';

const RUNTIME_URL = 'postgresql://rasta_audit:pw@localhost:5433/rasta_audit?schema=audit';
const MIGRATOR_URL = 'postgresql://rasta_audit_migrator:pw@localhost:5433/rasta_audit?schema=audit';

function base(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL_AUDIT: RUNTIME_URL,
    KAFKA_BROKERS: 'localhost:9092',
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
      expect(() =>
        loadAuditEnv({
          KAFKA_BROKERS: 'localhost:9092',
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
      expect(() => loadAuditEnv({ KAFKA_BROKERS: 'localhost:9092' })).toThrow();
    });
  });

  it('requires a broker list, because the projector is the whole service', () => {
    expect(() => loadAuditEnv({ DATABASE_URL_AUDIT: RUNTIME_URL })).toThrow();
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
});
