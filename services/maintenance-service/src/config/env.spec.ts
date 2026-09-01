import { EnvValidationError } from '@rasta/config';
import { loadMaintenanceEnv } from './env';

/**
 * `MAINTENANCE_DUE_SCAN_ENABLED` — whether this replica runs the in-process
 * due-date scan.
 *
 * This flag was never a `z.coerce.boolean()`; it was a hand-rolled
 * `z.string().default('true').transform((v) => v !== 'false')`, which is the
 * same defect wearing a different coat. `false` worked, but `FALSE`, `0`,
 * `no` and `off` all came back `true`, and `MAINTENANCE_DUE_SCAN_ENABLD=x`
 * — a typo — silently enabled the scan instead of failing the boot.
 *
 * ADR-027 § Open notes that in a multi-replica deployment this must be on for
 * exactly one replica. A flag that only turns off for one spelling out of five
 * is not a way to arrange that, so it now reads through `booleanEnv` like
 * every other boolean environment flag on the platform (D-020).
 */
const BASE: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/rasta_maintenance?schema=public',
  KAFKA_BROKERS: 'localhost:9092',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
  OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
  OIDC_AUDIENCE: 'rasta-api',
  INTERNAL_TOKEN_SECRET: 'a_secret_that_is_at_least_thirty_two_chars',
};

const load = (value?: string) =>
  loadMaintenanceEnv({
    ...BASE,
    ...(value === undefined ? {} : { MAINTENANCE_DUE_SCAN_ENABLED: value }),
  });

describe('MAINTENANCE_DUE_SCAN_ENABLED', () => {
  it('defaults to true — the documented default is unchanged', () => {
    expect(load().MAINTENANCE_DUE_SCAN_ENABLED).toBe(true);
  });

  it('reads "true" as true', () => {
    expect(load('true').MAINTENANCE_DUE_SCAN_ENABLED).toBe(true);
  });

  it('reads "false" as false', () => {
    expect(load('false').MAINTENANCE_DUE_SCAN_ENABLED).toBe(false);
  });

  it.each(['FALSE', 'False', '0', 'no', 'off', ' false '])(
    'reads %p as false — the old transform read every one of these as true',
    (value) => {
      expect(load(value).MAINTENANCE_DUE_SCAN_ENABLED).toBe(false);
    },
  );

  it.each(['true', 'TRUE', '1', 'yes', 'on'])('reads %p as true', (value) => {
    expect(load(value).MAINTENANCE_DUE_SCAN_ENABLED).toBe(true);
  });

  it.each(['maybe', 'scan', '2'])('refuses %p rather than guessing', (value) => {
    expect(() => load(value)).toThrow(EnvValidationError);
  });
});
