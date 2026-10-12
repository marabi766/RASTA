import { corsOrigins, loadContractEnv } from './env';

const base: NodeJS.ProcessEnv = {
  KAFKA_BROKERS: 'localhost:9092',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
  OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
  OIDC_AUDIENCE: 'rasta-api',
  INTERNAL_TOKEN_SECRET: 'a-throwaway-value-used-only-by-this-spec-32',
  DATABASE_URL: 'postgresql://u:p@localhost:5433/rasta_contract?schema=public',
};

const load = (overrides: NodeJS.ProcessEnv = {}) => loadContractEnv({ ...base, ...overrides });

describe('the provisional defaults (Q-95)', () => {
  const env = load();

  it('reads for the employer as ORGANIZATION_ADMIN only', () => {
    expect(env.CONTRACT_READER_ROLES).toEqual(['ORGANIZATION_ADMIN']);
  });

  it('asks construction-service on its port, within five seconds, and retries five times', () => {
    expect(env.CONSTRUCTION_SERVICE_URL).toBe('http://localhost:3110');
    expect(env.CONTRACT_AWARD_REQUEST_TIMEOUT_MS).toBe(5000);
    expect(env.CONTRACT_CONSUMER_MAX_RETRIES).toBe(5);
    expect(env.CONTRACT_CONSUMER_RETRY_BACKOFF_MS).toBe(1000);
  });

  it('has no signer setting at all: the employer’s signature is a policy, not an environment value (Q-95 (1))', () => {
    expect(Object.keys(env).filter((name) => /SIGNER/.test(name))).toEqual([]);
    // Even if one is supplied, it is not read: an environment value cannot grant authority.
    expect(load({ CONTRACT_OWNER_SIGNER_ROLES: 'ORGANIZATION_ADMIN' })).not.toHaveProperty(
      'CONTRACT_OWNER_SIGNER_ROLES',
    );
  });

  it('asks organization-service on its port within three seconds, and keeps four eyes on', () => {
    expect(env.ORGANIZATION_SERVICE_URL).toBe('http://localhost:3102');
    expect(env.CONTRACT_ORGANIZATION_REQUEST_TIMEOUT_MS).toBe(3000);
    expect(env.CONTRACT_POLICY_FOUR_EYES).toBe(true);
  });

  it('lets the reader role cancel a draft, for a reason from a closed list (Q-95 (4))', () => {
    expect(env.CONTRACT_CANCEL_ROLES).toEqual(['ORGANIZATION_ADMIN']);
    expect(env.CONTRACT_CANCEL_REASON_CODES).toEqual([
      'TERMS_NOT_AGREED',
      'CONTRACTOR_WITHDREW',
      'AWARD_ERROR',
      'OTHER',
    ]);
  });

  it('replays a command’s response for a day and leases an in-flight key for two minutes', () => {
    expect(env.CONTRACT_IDEMPOTENCY_TTL_HOURS).toBe(24);
    expect(env.CONTRACT_IDEMPOTENCY_CLAIM_LEASE_SECONDS).toBe(120);
  });

  it('names itself, and listens on 3111', () => {
    expect(env.SERVICE_NAME).toBe('contract-service');
    expect(env.PORT).toBe(3111);
    expect(env.KAFKA_CLIENT_ID).toBe('contract-service');
  });
});

describe('overrides', () => {
  it('takes the port from PORT_CONTRACT and the database from DATABASE_URL_CONTRACT', () => {
    const env = loadContractEnv({
      ...base,
      DATABASE_URL: undefined,
      DATABASE_URL_CONTRACT: 'postgresql://u:p@db:5433/rasta_contract?schema=public',
      PORT_CONTRACT: '4111',
    });
    expect(env.PORT).toBe(4111);
    expect(env.DATABASE_URL).toContain('@db:5433/rasta_contract');
  });

  it('does not fall back to another service’s database variable', () => {
    expect(() =>
      loadContractEnv({
        ...base,
        DATABASE_URL: undefined,
        DATABASE_URL_CONSTRUCTION: 'postgresql://u:p@db:5433/rasta_construction',
      }),
    ).toThrow();
  });

  it('accepts a configured reader list', () => {
    expect(
      load({ CONTRACT_READER_ROLES: ' ORGANIZATION_ADMIN , PROCUREMENT_USER ' })
        .CONTRACT_READER_ROLES,
    ).toEqual(['ORGANIZATION_ADMIN', 'PROCUREMENT_USER']);
  });

  it('accepts an empty cancel list (nobody) and four eyes switched off', () => {
    const env = load({ CONTRACT_CANCEL_ROLES: '', CONTRACT_POLICY_FOUR_EYES: 'false' });
    expect(env.CONTRACT_CANCEL_ROLES).toEqual([]);
    expect(env.CONTRACT_POLICY_FOUR_EYES).toBe(false);
  });

  it.each([
    ['AUDITOR among the readers', { CONTRACT_READER_ROLES: 'AUDITOR' }],
    ['SYSTEM_ADMIN among the cancellers', { CONTRACT_CANCEL_ROLES: 'SYSTEM_ADMIN' }],
    ['an organization URL that is not a URL', { ORGANIZATION_SERVICE_URL: 'organization' }],
    ['an organization timeout under 100 ms', { CONTRACT_ORGANIZATION_REQUEST_TIMEOUT_MS: '10' }],
    ['SYSTEM_ADMIN among the amenders', { CONTRACT_AMENDMENT_ROLES: 'SYSTEM_ADMIN' }],
    ['AUDITOR among the milestone planners', { CONTRACT_MILESTONE_ROLES: 'AUDITOR' }],
    ['no amendment reason', { CONTRACT_AMENDMENT_REASON_CODES: '' }],
    ['an amendment reason that is not a code', { CONTRACT_AMENDMENT_REASON_CODES: 'lower case' }],
    ['an amendment reason twice', { CONTRACT_AMENDMENT_REASON_CODES: 'OTHER,OTHER' }],
    ['a zero milestone limit', { CONTRACT_MILESTONE_LIMIT: '0' }],
    ['an unbounded milestone limit', { CONTRACT_MILESTONE_LIMIT: '1001' }],
    ['no cancel reason', { CONTRACT_CANCEL_REASON_CODES: '' }],
    ['a reason that is not a code', { CONTRACT_CANCEL_REASON_CODES: 'lower case' }],
    ['a reason twice', { CONTRACT_CANCEL_REASON_CODES: 'OTHER,OTHER' }],
    ['a zero idempotency lifetime', { CONTRACT_IDEMPOTENCY_TTL_HOURS: '0' }],
    ['a lease under ten seconds', { CONTRACT_IDEMPOTENCY_CLAIM_LEASE_SECONDS: '5' }],
    ['an empty reader list', { CONTRACT_READER_ROLES: '' }],
    ['an unknown role', { CONTRACT_READER_ROLES: 'WIZARD' }],
    ['a timeout under 100 ms', { CONTRACT_AWARD_REQUEST_TIMEOUT_MS: '10' }],
    ['a timeout over a minute', { CONTRACT_AWARD_REQUEST_TIMEOUT_MS: '60001' }],
    ['no retries', { CONTRACT_CONSUMER_MAX_RETRIES: '0' }],
    ['an endless retry count', { CONTRACT_CONSUMER_MAX_RETRIES: '21' }],
    ['a backoff under 10 ms', { CONTRACT_CONSUMER_RETRY_BACKOFF_MS: '1' }],
    ['a construction URL that is not a URL', { CONSTRUCTION_SERVICE_URL: 'construction' }],
  ])('refuses %s at startup', (_label, change) => {
    expect(() => load(change)).toThrow();
  });
});

describe('amendments and milestones (CON-003 PR 3, Q-100)', () => {
  it('default to the owner’s role set, a closed reason list and a bounded plan', () => {
    const env = load();
    expect(env.CONTRACT_AMENDMENT_ROLES).toEqual(['ORGANIZATION_ADMIN']);
    expect(env.CONTRACT_MILESTONE_ROLES).toEqual(['ORGANIZATION_ADMIN']);
    expect(env.CONTRACT_AMENDMENT_REASON_CODES).toEqual([
      'SCOPE_CHANGE',
      'PRICE_ADJUSTMENT',
      'SCHEDULE_CHANGE',
      'OTHER',
    ]);
    expect(env.CONTRACT_MILESTONE_LIMIT).toBe(100);
  });

  it('allow an empty role list, which means nobody — never everybody', () => {
    const env = load({ CONTRACT_AMENDMENT_ROLES: '', CONTRACT_MILESTONE_ROLES: '' });
    expect(env.CONTRACT_AMENDMENT_ROLES).toEqual([]);
    expect(env.CONTRACT_MILESTONE_ROLES).toEqual([]);
  });
});

describe('the clock-skew margin of the D-050 window', () => {
  it('defaults to 300 seconds and accepts 0 and a decimal', () => {
    expect(load().CONTRACT_HIERARCHY_CLOCK_SKEW_MARGIN_SECONDS).toBe(300);
    expect(
      load({ CONTRACT_HIERARCHY_CLOCK_SKEW_MARGIN_SECONDS: '0' })
        .CONTRACT_HIERARCHY_CLOCK_SKEW_MARGIN_SECONDS,
    ).toBe(0);
    expect(
      load({ CONTRACT_HIERARCHY_CLOCK_SKEW_MARGIN_SECONDS: '12.5' })
        .CONTRACT_HIERARCHY_CLOCK_SKEW_MARGIN_SECONDS,
    ).toBe(12.5);
  });

  it.each(['-1', 'abc', '', ' ', 'NaN', 'Infinity', '1e3', '999999999'])(
    'refuses to start with %j (fail closed)',
    (bad) => {
      expect(() => load({ CONTRACT_HIERARCHY_CLOCK_SKEW_MARGIN_SECONDS: bad })).toThrow();
    },
  );
});

describe('corsOrigins', () => {
  it('splits, trims and drops empties', () => {
    expect(corsOrigins(load({ CORS_ORIGINS: ' https://a.test , ,https://b.test ' }))).toEqual([
      'https://a.test',
      'https://b.test',
    ]);
  });

  it('is empty by default, and falls back to the gateway’s list', () => {
    expect(corsOrigins(load())).toEqual([]);
    expect(corsOrigins(load({ GATEWAY_CORS_ORIGINS: 'https://gw.test' }))).toEqual([
      'https://gw.test',
    ]);
  });
});
