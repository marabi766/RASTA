import { EnvValidationError } from '@rasta/config';
import { loadMarketplaceEnv } from './env';

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
