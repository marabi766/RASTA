import { brokersOf, corsOrigins, DEFAULT_PORT, loadSupplierEnv, SERVICE_NAME } from './env';

/**
 * Configuration parsing, and the fallbacks a deployment actually relies on.
 *
 * The port and database fallbacks are the interesting ones. The repo-root
 * `.env` names every service's settings separately — `PORT_SUPPLIER`,
 * `DATABASE_URL_SUPPLIER` — so one file can describe the whole platform without
 * any service being able to open another's database by accident (ADR-005). A
 * container, by contrast, sets `PORT` and `DATABASE_URL` alone. Both shapes
 * have to work, and the precedence between them has to be the same one every
 * other service uses or a deployment will connect somewhere surprising.
 */

/** Everything the schema demands, and nothing optional decided. */
const BASE: NodeJS.ProcessEnv = {
  KAFKA_BROKERS: 'localhost:9092',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
  OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
  OIDC_AUDIENCE: 'rasta-api',
  INTERNAL_TOKEN_SECRET: 'a-throwaway-value-used-only-by-this-spec-32',
  DATABASE_URL_SUPPLIER: 'postgresql://u:p@localhost:5433/rasta_supplier?schema=public',
};

function load(overrides: NodeJS.ProcessEnv = {}) {
  return loadSupplierEnv({ ...BASE, ...overrides });
}

describe('service identity', () => {
  it('names itself supplier-service without being told', () => {
    expect(load().SERVICE_NAME).toBe(SERVICE_NAME);
  });

  it('lets an explicit SERVICE_NAME win, so a sidecar can label itself', () => {
    expect(load({ SERVICE_NAME: 'supplier-service-relay' }).SERVICE_NAME).toBe(
      'supplier-service-relay',
    );
  });
});

describe('port resolution', () => {
  it('falls back to 3108 — the port the gateway and .env.example both name', () => {
    expect(load().PORT).toBe(Number(DEFAULT_PORT));
  });

  it('prefers PORT_SUPPLIER over the built-in default', () => {
    expect(load({ PORT_SUPPLIER: '3999' }).PORT).toBe(3999);
  });

  it('prefers an explicit PORT over PORT_SUPPLIER', () => {
    // A container sets exactly one port for its one process. If the repo-root
    // `.env` leaked into that container, the per-service variable must not win
    // over the one the orchestrator set deliberately.
    expect(load({ PORT: '3001', PORT_SUPPLIER: '3999' }).PORT).toBe(3001);
  });

  it('refuses a port outside the valid range rather than clamping it', () => {
    expect(() => load({ PORT: '70000' })).toThrow(/PORT/);
  });
});

describe('database resolution', () => {
  it('uses DATABASE_URL_SUPPLIER when no explicit DATABASE_URL is set', () => {
    expect(load().DATABASE_URL).toContain('rasta_supplier');
  });

  it('prefers an explicit DATABASE_URL', () => {
    const env = load({ DATABASE_URL: 'postgresql://u:p@db:5432/other?schema=public' });

    expect(env.DATABASE_URL).toContain('/other');
  });

  it('refuses to start with no database at all rather than defaulting to one', () => {
    // There is no sensible default. A service that silently connected to some
    // other database would break A-01 quietly; failing at boot is loud.
    const { DATABASE_URL_SUPPLIER: _omitted, ...withoutDatabase } = BASE;

    expect(() => loadSupplierEnv(withoutDatabase)).toThrow(/DATABASE_URL/);
  });

  it('refuses a connection string that is not PostgreSQL', () => {
    expect(() => load({ DATABASE_URL: 'mysql://u:p@localhost:3306/rasta_supplier' })).toThrow(
      /Database connection string/,
    );
  });
});

describe('kafka identity', () => {
  it('defaults the client id to the service name', () => {
    expect(load().KAFKA_CLIENT_ID).toBe(SERVICE_NAME);
  });

  it('defaults the consumer group to the platform naming convention', () => {
    // No consumer is registered in this phase. The name is defined anyway so
    // the first real one inherits the convention instead of inventing a name.
    expect(load().KAFKA_CONSUMER_GROUP).toBe('supplier-service.main');
  });

  it('splits a broker list and drops the whitespace around it', () => {
    expect(brokersOf(load({ KAFKA_BROKERS: 'a:9092, b:9092 ,' }))).toEqual(['a:9092', 'b:9092']);
  });
});

describe('outbox defaults (ADR-050)', () => {
  it('takes the platform lease, backoff and shutdown-grace defaults', () => {
    const env = load();

    expect(env.OUTBOX_CLAIM_LEASE_SECONDS).toBe(60);
    expect(env.OUTBOX_CLAIM_BACKOFF_SECONDS).toBe(5);
    expect(env.OUTBOX_CLAIM_BACKOFF_MAX_SECONDS).toBe(3600);
    expect(env.OUTBOX_SHUTDOWN_GRACE_SECONDS).toBe(30);
  });

  it('refuses a lease below the floor renewal timing depends on', () => {
    // The renewal interval is lease/4, so three renewals are attempted before
    // expiry. Below 20 seconds the last attempt lands on the expiry instant
    // itself — zero tolerance for a lost renewal (ADR-050 § Heartbeat timing).
    expect(() => load({ OUTBOX_CLAIM_LEASE_SECONDS: '10' })).toThrow(/OUTBOX_CLAIM_LEASE_SECONDS/);
  });
});

describe('CORS', () => {
  it('is empty by default, so no browser origin is trusted implicitly', () => {
    expect(corsOrigins(load())).toEqual([]);
  });

  it('falls back to the gateway origin list', () => {
    expect(corsOrigins(load({ GATEWAY_CORS_ORIGINS: 'http://a, http://b' }))).toEqual([
      'http://a',
      'http://b',
    ]);
  });
});

describe('what is deliberately not configurable', () => {
  it('has no performance-score weighting key', () => {
    // Q-12 is open. A key with a default is a decision: whatever ships becomes
    // the policy every deployment runs, and "equal weights" is a placeholder in
    // an open question rather than an approved policy (AGENTS.md § 9).
    const keys = Object.keys(load());

    expect(keys.filter((key) => /SCORE|WEIGHT|RATING|PERFORMANCE/i.test(key))).toEqual([]);
  });

  it('has no qualification validity or expiry key', () => {
    // No accepted document states a validity period, so there is nothing here
    // to make configurable and nothing to invent.
    const keys = Object.keys(load());

    expect(keys.filter((key) => /EXPIR|VALIDITY|RENEW/i.test(key))).toEqual([]);
  });
});
