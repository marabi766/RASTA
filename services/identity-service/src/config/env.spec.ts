import { EnvValidationError } from '@rasta/config';
import { loadIdentityEnv } from './env';

/**
 * `KEYCLOAK_SYNC_ENABLED` — whether account provisioning reaches the identity
 * provider or is recorded locally only.
 *
 * It used `z.coerce.boolean()`, so `KEYCLOAK_SYNC_ENABLED=false` parsed as
 * `true` and the service still called Keycloak. The flag exists so unit and
 * API tests can run without an identity provider; a test environment that set
 * it to `false` got connection failures instead, and the configuration looked
 * correct while doing the opposite of what it said (D-020).
 */
const BASE: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/rasta_identity?schema=public',
  KAFKA_BROKERS: 'localhost:9092',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
  OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
  OIDC_AUDIENCE: 'rasta-api',
  INTERNAL_TOKEN_SECRET: 'a_secret_that_is_at_least_thirty_two_chars',
  KEYCLOAK_URL: 'http://localhost:8080',
  KEYCLOAK_REALM: 'rasta',
  KEYCLOAK_BACKEND_CLIENT_ID: 'rasta-backend',
  KEYCLOAK_BACKEND_CLIENT_SECRET: 'a-backend-client-secret',
};

const load = (value?: string) =>
  loadIdentityEnv({
    ...BASE,
    ...(value === undefined ? {} : { KEYCLOAK_SYNC_ENABLED: value }),
  });

describe('KEYCLOAK_SYNC_ENABLED', () => {
  it('defaults to true — a deployed environment provisions real accounts', () => {
    expect(load().KEYCLOAK_SYNC_ENABLED).toBe(true);
  });

  it('reads "true" as true', () => {
    expect(load('true').KEYCLOAK_SYNC_ENABLED).toBe(true);
  });

  it('reads "false" as false — the local-only mode is reachable again', () => {
    expect(load('false').KEYCLOAK_SYNC_ENABLED).toBe(false);
  });

  it.each(['FALSE', '0', 'no', 'off', ' false '])('reads %p as false', (value) => {
    expect(load(value).KEYCLOAK_SYNC_ENABLED).toBe(false);
  });

  it.each(['true', 'TRUE', '1', 'yes', 'on'])('reads %p as true', (value) => {
    expect(load(value).KEYCLOAK_SYNC_ENABLED).toBe(true);
  });

  it.each(['maybe', 'sync', '2'])('refuses %p rather than guessing', (value) => {
    expect(() => load(value)).toThrow(EnvValidationError);
  });
});
