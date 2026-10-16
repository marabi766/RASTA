import { EnvValidationError } from '@rasta/config';
import { brokerConnectionIsAuthenticated, loadMarketplaceEnv } from './env';
import { marketplaceOperationBudgets } from './operation-budgets';

/**
 * `MARKETPLACE_TEMPORAL_ENABLED` — whether the order-saga worker starts with
 * the service.
 *
 * ADR-039 § Consequences says setting it to `false` makes "orders are created
 * and then do not advance" an **explicit** state rather than a silent failure.
 * Under `z.coerce.boolean()` that was not true: `false` parsed as `true`, the
 * worker started anyway, and a developer running the API without Temporal got
 * connection errors from a component they had switched off (D-020).
 */
const BASE: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/rasta_marketplace?schema=public',
  KAFKA_BROKERS: 'localhost:9092',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
  OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
  OIDC_AUDIENCE: 'rasta-api',
  INTERNAL_TOKEN_SECRET: 'a_secret_that_is_at_least_thirty_two_chars',
};

const load = (value?: string) =>
  loadMarketplaceEnv({
    ...BASE,
    ...(value === undefined ? {} : { MARKETPLACE_TEMPORAL_ENABLED: value }),
  });

describe('MARKETPLACE_TEMPORAL_ENABLED', () => {
  it('defaults to true — the saga runs unless a deployment says otherwise', () => {
    expect(load().MARKETPLACE_TEMPORAL_ENABLED).toBe(true);
  });

  it('reads "true" as true', () => {
    expect(load('true').MARKETPLACE_TEMPORAL_ENABLED).toBe(true);
  });

  it('reads "false" as false — ADR-039’s explicit no-Temporal mode works', () => {
    expect(load('false').MARKETPLACE_TEMPORAL_ENABLED).toBe(false);
  });

  it.each(['FALSE', '0', 'no', 'off', ' false '])('reads %p as false', (value) => {
    expect(load(value).MARKETPLACE_TEMPORAL_ENABLED).toBe(false);
  });

  it.each(['true', 'TRUE', '1', 'yes', 'on'])('reads %p as true', (value) => {
    expect(load(value).MARKETPLACE_TEMPORAL_ENABLED).toBe(true);
  });

  it.each(['maybe', 'temporal', '2'])('refuses %p rather than guessing', (value) => {
    expect(() => load(value)).toThrow(EnvValidationError);
  });
});

/**
 * `MARKETPLACE_IDEMPOTENCY_CLAIM_LEASE_SECONDS` — how long a claim in flight
 * blocks identical retries before one may take it over (#253). Fail closed: a
 * value the store cannot honour refuses to start rather than being clamped.
 */
describe('MARKETPLACE_IDEMPOTENCY_CLAIM_LEASE_SECONDS', () => {
  const withIdempotency = (values: NodeJS.ProcessEnv) => loadMarketplaceEnv({ ...BASE, ...values });

  it('defaults to 60 seconds, well short of the 24-hour retention', () => {
    const env = withIdempotency({});
    expect(env.MARKETPLACE_IDEMPOTENCY_CLAIM_LEASE_SECONDS).toBe(60);
    expect(env.MARKETPLACE_IDEMPOTENCY_TTL_HOURS).toBe(24);
  });

  it.each(['30', '120', '3599'])('accepts %p', (value) => {
    expect(
      withIdempotency({ MARKETPLACE_IDEMPOTENCY_CLAIM_LEASE_SECONDS: value })
        .MARKETPLACE_IDEMPOTENCY_CLAIM_LEASE_SECONDS,
    ).toBe(Number(value));
  });

  it.each(['0', '-1', '29', '3601', '60.5', 'sixty', ''])('refuses %p at startup', (value) => {
    expect(() => withIdempotency({ MARKETPLACE_IDEMPOTENCY_CLAIM_LEASE_SECONDS: value })).toThrow(
      EnvValidationError,
    );
  });

  it('refuses a lease that is not shorter than the retention', () => {
    // One hour of retention, one hour of lease: a stuck claim would block for
    // as long as a completed response is kept.
    expect(() =>
      withIdempotency({
        MARKETPLACE_IDEMPOTENCY_TTL_HOURS: '1',
        MARKETPLACE_IDEMPOTENCY_CLAIM_LEASE_SECONDS: '3600',
      }),
    ).toThrow(/MARKETPLACE_IDEMPOTENCY_CLAIM_LEASE_SECONDS/);
    expect(
      withIdempotency({
        MARKETPLACE_IDEMPOTENCY_TTL_HOURS: '1',
        MARKETPLACE_IDEMPOTENCY_CLAIM_LEASE_SECONDS: '3599',
      }).MARKETPLACE_IDEMPOTENCY_CLAIM_LEASE_SECONDS,
    ).toBe(3599);
  });
});

/**
 * #268 r4: DATABASE_STATEMENT_TIMEOUT_MS is opt-in, and when set it must be
 * above every operation budget — so an idempotency claim's lock wait always
 * ends as its retryable 409, never as a 500 from a statement timeout.
 */
describe('DATABASE_STATEMENT_TIMEOUT_MS against the operation budgets', () => {
  const at = (statementTimeoutMs: string) => () =>
    loadMarketplaceEnv({ ...BASE, DATABASE_STATEMENT_TIMEOUT_MS: statementTimeoutMs });

  it('unset, applies no statement timeout', () => {
    const env = loadMarketplaceEnv(BASE);
    expect(env.DATABASE_STATEMENT_TIMEOUT_MS).toBeUndefined();
    expect(env.DATABASE_URL).not.toContain('statement_timeout');
  });

  it('declares every budget, at the defaults', () => {
    expect(
      marketplaceOperationBudgets(loadMarketplaceEnv(BASE)).map((b) => [b.name, b.budgetMs]),
    ).toEqual([
      ['PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS', 5000],
      ['CLAIM_WAIT_MS', 7000],
      ['OUTBOX_CLAIM_LEASE_SECONDS', 12_500],
    ]);
  });

  it('refuses one under the claim wait, which would turn its 409 into a 500', () => {
    expect(at('5000')).toThrow(/not above CLAIM_WAIT_MS, 7000 ms/);
  });

  it('set, must be above the largest: the outbox renewal; the bound is exact', () => {
    expect(at('12500')).toThrow(
      /DATABASE_STATEMENT_TIMEOUT_MS: \(12500 ms\) is not above OUTBOX_CLAIM_LEASE_SECONDS, 12500 ms/,
    );
    expect(at('12501')).not.toThrow();
  });
});

/**
 * RUN-005 PR 3 — the return mirror moves a buyer's request on an event published in the
 * supplier's name, so it is off by default and refuses to start where the broker does not
 * authenticate the publisher (ADR-061 § 3), as supplier-service's performance consumer does.
 */
describe('the return mirror is off by default and fails closed', () => {
  const env = (extra: NodeJS.ProcessEnv) => loadMarketplaceEnv({ ...BASE, ...extra });
  const AUTHENTICATED: NodeJS.ProcessEnv = {
    KAFKA_SASL_PASSWORD_MARKETPLACE: 'a-marketplace-broker-password',
    KAFKA_SSL: 'true',
  };
  const ENABLED: NodeJS.ProcessEnv = { MARKETPLACE_RETURN_MIRROR_CONSUMER_ENABLED: 'true' };
  const REFUSED = /MARKETPLACE_RETURN_MIRROR_CONSUMER_ENABLED=true is refused.*RUN-006/s;

  it('is off unless asked for — even where it may run', () => {
    expect(env({}).MARKETPLACE_RETURN_MIRROR_CONSUMER_ENABLED).toBe(false);
    expect(env(AUTHENTICATED).MARKETPLACE_RETURN_MIRROR_CONSUMER_ENABLED).toBe(false);
  });

  it('starts over this service’s own SASL credential and TLS', () => {
    const loaded = env({ ...AUTHENTICATED, ...ENABLED });
    expect(loaded.MARKETPLACE_RETURN_MIRROR_CONSUMER_ENABLED).toBe(true);
    expect(brokerConnectionIsAuthenticated(loaded)).toBe(true);
  });

  it('refuses the PLAINTEXT opt-out, SASL without TLS, TLS without SASL and another principal', () => {
    expect(() =>
      env({ NODE_ENV: 'test', KAFKA_ALLOW_PLAINTEXT: 'true', ...AUTHENTICATED, ...ENABLED }),
    ).toThrow(REFUSED);
    expect(() =>
      env({ KAFKA_SASL_PASSWORD_MARKETPLACE: 'p', KAFKA_SSL: 'false', ...ENABLED }),
    ).toThrow(REFUSED);
    expect(() => env({ KAFKA_SSL: 'true', ...ENABLED })).toThrow(REFUSED);
    expect(() =>
      env({
        KAFKA_SASL_USERNAME: 'inventory-service',
        KAFKA_SASL_PASSWORD: 'p',
        KAFKA_SSL: 'true',
        ...ENABLED,
      }),
    ).toThrow(REFUSED);
    expect(() => env(ENABLED)).toThrow(REFUSED);
  });
});

describe('MARKETPLACE_RETURN_PARTIAL_DISPATCH_ALLOWED (Q-133 (8))', () => {
  it('is false unless a deployment decides otherwise — a shipment names what was authorized', () => {
    expect(loadMarketplaceEnv(BASE).MARKETPLACE_RETURN_PARTIAL_DISPATCH_ALLOWED).toBe(false);
    expect(
      loadMarketplaceEnv({ ...BASE, MARKETPLACE_RETURN_PARTIAL_DISPATCH_ALLOWED: 'true' })
        .MARKETPLACE_RETURN_PARTIAL_DISPATCH_ALLOWED,
    ).toBe(true);
    expect(() =>
      loadMarketplaceEnv({ ...BASE, MARKETPLACE_RETURN_PARTIAL_DISPATCH_ALLOWED: 'some' }),
    ).toThrow(EnvValidationError);
  });
});
