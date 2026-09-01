import { EnvValidationError } from '@rasta/config';
import { loadGatewayEnv } from './env';

/**
 * `GATEWAY_RATE_LIMIT_FAIL_OPEN` — the flag that decides what happens to
 * every request when Redis is unreachable.
 *
 * It used `z.coerce.boolean()`, which applies JavaScript's `Boolean()`: every
 * non-empty string is `true`. An operator on a deployment where abuse risk
 * outweighs availability sets `GATEWAY_RATE_LIMIT_FAIL_OPEN=false`, reads
 * their own configuration back, and believes the gateway now fails closed.
 * It did not. A Redis outage still admitted every request unrate-limited,
 * and the boot log said nothing, because as far as the schema was concerned
 * the operator had asked for fail-open.
 *
 * This is the security-relevant half of D-020, so it is asserted here at the
 * owning configuration boundary and again at the behavioural one in
 * `../proxy/rate-limiter.spec.ts`.
 */
const SERVICE_URLS: NodeJS.ProcessEnv = Object.fromEntries(
  [
    'IDENTITY',
    'ORGANIZATION',
    'ASSET',
    'FLEET',
    'MAINTENANCE',
    'MARKETPLACE',
    'PROCUREMENT',
    'SUPPLIER',
    'INVENTORY',
    'CONSTRUCTION',
    'CONTRACT',
    'ECONOMIC',
    'NOTIFICATION',
    'DOCUMENT',
    'AUDIT',
    'ANALYTICS',
  ].map((name) => [`${name}_SERVICE_URL`, `http://${name.toLowerCase()}:3000`]),
);

const BASE: NodeJS.ProcessEnv = {
  ...SERVICE_URLS,
  REDIS_URL: 'redis://localhost:6379',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
  OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
  OIDC_AUDIENCE: 'rasta-api',
  INTERNAL_TOKEN_SECRET: 'a_secret_that_is_at_least_thirty_two_chars',
};

const load = (value?: string) =>
  loadGatewayEnv({
    ...BASE,
    ...(value === undefined ? {} : { GATEWAY_RATE_LIMIT_FAIL_OPEN: value }),
  });

describe('GATEWAY_RATE_LIMIT_FAIL_OPEN', () => {
  it('defaults to true — a cache outage should degrade the platform, not close it', () => {
    // The documented default (docs/23 § S-06). Rate limiting protects against
    // overload; it is not the authorization boundary, and refusing everything
    // because Redis blinked converts a degradation into an outage.
    expect(load().GATEWAY_RATE_LIMIT_FAIL_OPEN).toBe(true);
  });

  it('reads "true" as true', () => {
    expect(load('true').GATEWAY_RATE_LIMIT_FAIL_OPEN).toBe(true);
  });

  it('reads "false" as false — the operator can now actually fail closed', () => {
    // The whole defect in one assertion. Under `z.coerce.boolean()` this was
    // `true`: a deployment that asked to fail closed failed open instead.
    expect(load('false').GATEWAY_RATE_LIMIT_FAIL_OPEN).toBe(false);
  });

  it.each(['FALSE', 'False', '0', 'no', 'off', ' false '])('reads %p as false', (value) => {
    expect(load(value).GATEWAY_RATE_LIMIT_FAIL_OPEN).toBe(false);
  });

  it.each(['true', 'TRUE', '1', 'yes', 'on'])('reads %p as true', (value) => {
    expect(load(value).GATEWAY_RATE_LIMIT_FAIL_OPEN).toBe(true);
  });

  it.each(['maybe', 'closed', 'y', '2'])('refuses %p at startup rather than guessing', (value) => {
    // A typo in a security switch stops the gateway at boot. Picking a default
    // and carrying on is how `GATEWAY_RATE_LIMIT_FAIL_OPEN=flase` becomes a
    // silently fail-open deployment.
    expect(() => load(value)).toThrow(EnvValidationError);
  });
});
