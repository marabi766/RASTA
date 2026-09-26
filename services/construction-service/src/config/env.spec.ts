import { brokersOf, corsOrigins, DEFAULT_PORT, loadConstructionEnv, SERVICE_NAME } from './env';

/**
 * Configuration parsing, the fallbacks a deployment relies on, and the four
 * provisional policy settings of Q-68 and Q-69.
 *
 * The policy settings are the interesting part. Each default is the narrowest
 * provisional decision recorded in `docs/24`, and each misconfiguration that
 * would widen access or invent a lifecycle edge stops the service at startup
 * rather than running with it.
 */

const BASE: NodeJS.ProcessEnv = {
  KAFKA_BROKERS: 'localhost:9092',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
  OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
  OIDC_AUDIENCE: 'rasta-api',
  INTERNAL_TOKEN_SECRET: 'a-throwaway-value-used-only-by-this-spec-32',
  DATABASE_URL_CONSTRUCTION: 'postgresql://u:p@localhost:5433/rasta_construction?schema=public',
};

function load(overrides: NodeJS.ProcessEnv = {}) {
  return loadConstructionEnv({ ...BASE, ...overrides });
}

describe('service identity and wiring', () => {
  it('names itself construction-service', () => {
    expect(load().SERVICE_NAME).toBe(SERVICE_NAME);
    expect(SERVICE_NAME).toBe('construction-service');
  });

  it('falls back to 3110 — the port the gateway and .env.example both name', () => {
    expect(load().PORT).toBe(Number(DEFAULT_PORT));
    expect(DEFAULT_PORT).toBe('3110');
  });

  it('prefers PORT_CONSTRUCTION over the default, and PORT over both', () => {
    expect(load({ PORT_CONSTRUCTION: '3999' }).PORT).toBe(3999);
    expect(load({ PORT: '3001', PORT_CONSTRUCTION: '3999' }).PORT).toBe(3001);
  });

  it('uses DATABASE_URL_CONSTRUCTION, and prefers an explicit DATABASE_URL', () => {
    expect(load().DATABASE_URL).toContain('rasta_construction');
    expect(
      load({ DATABASE_URL: 'postgresql://u:p@db:5432/other?schema=public' }).DATABASE_URL,
    ).toContain('/other');
  });

  it('refuses to start with no database rather than defaulting to one (A-01)', () => {
    const { DATABASE_URL_CONSTRUCTION: _omitted, ...withoutDatabase } = BASE;
    expect(() => loadConstructionEnv(withoutDatabase)).toThrow(/DATABASE_URL/);
  });

  it('follows the platform naming for kafka client and consumer group', () => {
    const env = load();
    expect(env.KAFKA_CLIENT_ID).toBe(SERVICE_NAME);
    expect(env.KAFKA_CONSUMER_GROUP).toBe('construction-service.main');
    expect(brokersOf(load({ KAFKA_BROKERS: 'a:9092, b:9092 ,' }))).toEqual(['a:9092', 'b:9092']);
  });

  it('trusts no browser origin by default and falls back to the gateway list', () => {
    expect(corsOrigins(load())).toEqual([]);
    expect(corsOrigins(load({ GATEWAY_CORS_ORIGINS: 'http://a, http://b' }))).toEqual([
      'http://a',
      'http://b',
    ]);
  });
});

describe('project roles (Q-69)', () => {
  it('defaults the writers to ORGANIZATION_ADMIN and the extra readers to nobody', () => {
    const env = load();
    expect(env.CONSTRUCTION_PROJECT_ROLES).toEqual(['ORGANIZATION_ADMIN']);
    expect(env.CONSTRUCTION_PROJECT_READER_ROLES).toEqual([]);
  });

  it('accepts a configured list, trimmed', () => {
    const env = load({
      CONSTRUCTION_PROJECT_ROLES: 'ORGANIZATION_ADMIN, PROCUREMENT_USER',
      CONSTRUCTION_PROJECT_READER_ROLES: 'FLEET_MANAGER',
    });
    expect(env.CONSTRUCTION_PROJECT_ROLES).toEqual(['ORGANIZATION_ADMIN', 'PROCUREMENT_USER']);
    expect(env.CONSTRUCTION_PROJECT_READER_ROLES).toEqual(['FLEET_MANAGER']);
  });

  it.each(['CONSTRUCTION_PROJECT_ROLES', 'CONSTRUCTION_PROJECT_READER_ROLES'])(
    'refuses to start when %s names the oversight role',
    (key) => {
      expect(() => load({ [key]: 'ORGANIZATION_ADMIN,AUDITOR' })).toThrow(/AUDITOR/);
    },
  );

  it('refuses an unknown role rather than ignoring it', () => {
    expect(() => load({ CONSTRUCTION_PROJECT_ROLES: 'PROJECT_MANAGER' })).toThrow(
      /Unknown role in CONSTRUCTION_PROJECT_ROLES/,
    );
  });

  it('refuses an empty writer list: nobody could create a project', () => {
    expect(() => load({ CONSTRUCTION_PROJECT_ROLES: ' , ' })).toThrow(/at least 1 role/);
  });
});

describe('cancellable states (Q-69)', () => {
  it('defaults to every state the lifecycle can cancel from', () => {
    expect(load().CONSTRUCTION_CANCELLABLE_STATES).toEqual([
      'DRAFT',
      'PENDING_APPROVAL',
      'CHANGES_REQUESTED',
      'APPROVED',
    ]);
  });

  it('may be narrowed', () => {
    expect(
      load({ CONSTRUCTION_CANCELLABLE_STATES: 'DRAFT' }).CONSTRUCTION_CANCELLABLE_STATES,
    ).toEqual(['DRAFT']);
  });

  it.each(['IN_PROGRESS', 'COMPLETED', 'CANCELLED'])(
    'refuses to start with %s, an edge the lifecycle does not have',
    (state) => {
      expect(() => load({ CONSTRUCTION_CANCELLABLE_STATES: `DRAFT,${state}` })).toThrow(
        /may only name states the lifecycle can cancel from/,
      );
    },
  );

  it('refuses an unknown state', () => {
    expect(() => load({ CONSTRUCTION_CANCELLABLE_STATES: 'ARCHIVED' })).toThrow(/Unknown state/);
  });
});

describe('operation types (Q-68)', () => {
  it('ships no list: free text by default', () => {
    expect(load().CONSTRUCTION_OPERATION_TYPES).toEqual([]);
  });

  it('accepts a configured list', () => {
    expect(load({ CONSTRUCTION_OPERATION_TYPES: 'a1, b2' }).CONSTRUCTION_OPERATION_TYPES).toEqual([
      'a1',
      'b2',
    ]);
  });

  it('refuses an entry too short to mean anything', () => {
    expect(() => load({ CONSTRUCTION_OPERATION_TYPES: 'x' })).toThrow(/2 to 100 characters/);
  });
});

describe('what is deliberately not configurable', () => {
  it('has no approval authority, threshold or legal-procedure key', () => {
    // Those are approval_policy rows (ADR-023, ADR-063), never environment.
    const keys = Object.keys(load());
    expect(
      keys.filter((key) => /AUTHORITY|THRESHOLD|APPROV|PROCUREMENT_NATURE/i.test(key)),
    ).toEqual([]);
  });

  it('bounds the idempotency window', () => {
    expect(load().CONSTRUCTION_IDEMPOTENCY_TTL_HOURS).toBe(24);
    expect(() => load({ CONSTRUCTION_IDEMPOTENCY_TTL_HOURS: '0' })).toThrow();
  });
});
