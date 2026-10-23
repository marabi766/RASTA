import {
  ANALYTICS_DEAD_LETTER_TOPIC,
  brokerConnectionIsAuthenticated,
  corsOrigins,
  loadAnalyticsEnv,
} from './env';

const base: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  KAFKA_BROKERS: 'localhost:9092',
  KAFKA_ALLOW_PLAINTEXT: 'true',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
  OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
  OIDC_AUDIENCE: 'rasta-api',
  INTERNAL_TOKEN_SECRET: 'a-throwaway-value-used-only-by-this-spec-32',
  DATABASE_URL: 'postgresql://u:p@localhost:5433/rasta_analytics?schema=public',
};

const load = (overrides: NodeJS.ProcessEnv = {}) => loadAnalyticsEnv({ ...base, ...overrides });

/** A connection the broker authenticates: this service's own SASL identity, over TLS. */
const authenticated: NodeJS.ProcessEnv = {
  KAFKA_ALLOW_PLAINTEXT: 'false',
  KAFKA_SSL: 'true',
  KAFKA_SASL_USERNAME: 'analytics-service',
  KAFKA_SASL_PASSWORD: 'a-throwaway-sasl-password-for-this-spec',
};

describe('the provisional defaults', () => {
  const env = load();

  it('names itself and its port, and dead-letters to its own topic only', () => {
    expect(env.SERVICE_NAME).toBe('analytics-service');
    expect(env.PORT).toBe(3116);
    expect(ANALYTICS_DEAD_LETTER_TOPIC).toBe('rasta.analytics.v1.dlq');
  });

  it('lets the organization admin and the fleet manager read the fleet dashboard (docs/16 § 16.7)', () => {
    expect(env.ANALYTICS_FLEET_DASHBOARD_ROLES).toEqual(['ORGANIZATION_ADMIN', 'FLEET_MANAGER']);
  });

  it('keeps the projection off unless a deployment turns it on', () => {
    expect(env.ANALYTICS_MAINTENANCE_FACTS_CONSUMER_ENABLED).toBe(false);
  });

  it('configures no threshold, baseline or KPI: those are Q-141 and Q-142, not environment values', () => {
    expect(Object.keys(env).filter((name) => /THRESHOLD|BASELINE|MIN_|KPI/.test(name))).toEqual([]);
  });

  it('falls back to the platform names for its port and database', () => {
    const fallback = loadAnalyticsEnv({
      ...base,
      DATABASE_URL: undefined,
      DATABASE_URL_ANALYTICS: 'postgresql://u:p@localhost:5433/rasta_analytics?schema=public',
      PORT_ANALYTICS: '4116',
    });
    expect(fallback.PORT).toBe(4116);
    expect(fallback.DATABASE_URL).toContain('rasta_analytics');
  });
});

describe('the fleet dashboard readers', () => {
  it('accepts another configured list', () => {
    expect(
      load({ ANALYTICS_FLEET_DASHBOARD_ROLES: ' FLEET_MANAGER ' }).ANALYTICS_FLEET_DASHBOARD_ROLES,
    ).toEqual(['FLEET_MANAGER']);
  });

  it('refuses to start with the oversight role named (docs/09 § 9.3)', () => {
    expect(() => load({ ANALYTICS_FLEET_DASHBOARD_ROLES: 'FLEET_MANAGER,AUDITOR' })).toThrow(
      /may not name AUDITOR/,
    );
  });

  it('refuses an empty list rather than reading it as everybody', () => {
    expect(() => load({ ANALYTICS_FLEET_DASHBOARD_ROLES: ' , ' })).toThrow(/at least 1 role/);
  });

  it('refuses something that is not a role name at all', () => {
    expect(() => load({ ANALYTICS_FLEET_DASHBOARD_ROLES: 'fleet manager' })).toThrow(
      /Not a role name/,
    );
  });
  // A well-formed name the platform does not have is refused at boot by DashboardAccess
  // (access.spec.ts): this file loads before telemetry and may not reach @rasta/nest-common.
});

describe('what this file may load before telemetry', () => {
  it('reaches neither @rasta/nest-common nor kafkajs (scripts/service-telemetry-order.test.mjs)', () => {
    const { readFileSync } = jest.requireActual<typeof import('node:fs')>('node:fs');
    for (const file of ['env.ts', 'operation-budgets.ts']) {
      const source = readFileSync(`${__dirname}/${file}`, 'utf8');
      expect([file, /from '(@rasta\/nest-common|kafkajs)'/.test(source)]).toEqual([file, false]);
    }
  });
});

describe('the projection gate (ADR-061 § 3, ADR-071 § 1)', () => {
  it('refuses to start the projection over a connection the broker does not authenticate', () => {
    expect(() => load({ ANALYTICS_MAINTENANCE_FACTS_CONSUMER_ENABLED: 'true' })).toThrow(
      /ANALYTICS_MAINTENANCE_FACTS_CONSUMER_ENABLED=true is refused/,
    );
  });

  it('starts it when the client authenticates as this service over TLS', () => {
    const env = load({ ...authenticated, ANALYTICS_MAINTENANCE_FACTS_CONSUMER_ENABLED: 'true' });
    expect(env.ANALYTICS_MAINTENANCE_FACTS_CONSUMER_ENABLED).toBe(true);
    expect(brokerConnectionIsAuthenticated(env)).toBe(true);
  });

  it.each([
    ['no TLS', { KAFKA_SSL: 'false' }],
    ['another principal', { KAFKA_SASL_USERNAME: 'maintenance-service' }],
    ['the PLAINTEXT opt-out', { KAFKA_ALLOW_PLAINTEXT: 'true' }],
  ])('does not count %s as authenticated', (_label, change) => {
    const env = load({ ...authenticated, ...change });
    expect(brokerConnectionIsAuthenticated(env)).toBe(false);
  });
});

describe('corsOrigins', () => {
  it('splits, trims and drops empty entries', () => {
    expect(corsOrigins(load({ CORS_ORIGINS: ' https://a.example , ,https://b.example' }))).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });
});
