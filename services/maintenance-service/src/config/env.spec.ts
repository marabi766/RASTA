import { EnvValidationError, envEnumProbes } from '@rasta/config';
import { MAINTENANCE_MAX_REPLAY_WINDOW_SECONDS } from '@rasta/contracts';
import { loadMaintenanceEnv, maintenanceEnvSchema, replayWindowRoomSeconds } from './env';
import { maintenanceOperationBudgets, replayFenceBudgetMs } from './operation-budgets';

/**
 * `MAINTENANCE_DUE_SCAN_ENABLED` — whether this replica runs the in-process
 * due-date scan.
 *
 * This flag was never a `z.coerce.boolean()`; it was a hand-rolled
 * `z.string().prefault('true').transform((v) => v !== 'false')`, which is the
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
  ASSET_SERVICE_URL: 'http://localhost:3103',
};

const load = (value?: string) =>
  loadMaintenanceEnv({
    ...BASE,
    ...(value === undefined ? {} : { MAINTENANCE_DUE_SCAN_ENABLED: value }),
  });

describe('the replay fence budget (FU-171, PM decision D-133)', () => {
  const env = (overrides: NodeJS.ProcessEnv = {}) => loadMaintenanceEnv({ ...BASE, ...overrides });

  it('defaults to a 30 s skew: B = 2 · 30 s + 7 s', () => {
    expect(env().MAINTENANCE_CLOCK_SKEW_SECONDS).toBe(30);
    expect(env({ MAINTENANCE_CLOCK_SKEW_SECONDS: '05' }).MAINTENANCE_CLOCK_SKEW_SECONDS).toBe(5);
    expect(() => env({ MAINTENANCE_CLOCK_SKEW_SECONDS: '0005' })).toThrow();
    expect(replayFenceBudgetMs(30)).toBe(67_000);
  });

  it.each([['-1'], ['301'], ['1.5'], [''], [' '], ['1e2']])(
    'refuses a skew of %j at startup',
    (skew) => {
      expect(() => env({ MAINTENANCE_CLOCK_SKEW_SECONDS: skew })).toThrow(EnvValidationError);
    },
  );

  it('holds TTL − B − skew at or above MAINTENANCE_MAX_REPLAY_WINDOW_SECONDS, at the edge', () => {
    // 1 h: 3 600 − (2s + 7) − s ≥ 3 300  ⇔  s ≤ 97.
    expect(
      replayWindowRoomSeconds({
        MAINTENANCE_IDEMPOTENCY_TTL_HOURS: 1,
        MAINTENANCE_CLOCK_SKEW_SECONDS: 97,
      }),
    ).toBe(MAINTENANCE_MAX_REPLAY_WINDOW_SECONDS + 2);
    expect(
      env({ MAINTENANCE_IDEMPOTENCY_TTL_HOURS: '1', MAINTENANCE_CLOCK_SKEW_SECONDS: '97' })
        .MAINTENANCE_CLOCK_SKEW_SECONDS,
    ).toBe(97);
    expect(() =>
      env({ MAINTENANCE_IDEMPOTENCY_TTL_HOURS: '1', MAINTENANCE_CLOCK_SKEW_SECONDS: '98' }),
    ).toThrow(/MAINTENANCE_MAX_REPLAY_WINDOW_SECONDS/);
    // A longer retention leaves room for the largest skew.
    expect(
      env({ MAINTENANCE_IDEMPOTENCY_TTL_HOURS: '2', MAINTENANCE_CLOCK_SKEW_SECONDS: '300' })
        .MAINTENANCE_CLOCK_SKEW_SECONDS,
    ).toBe(300);
  });
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

/**
 * `MAINTENANCE_IDEMPOTENCY_CLAIM_LEASE_SECONDS` — how long a claim on an
 * Idempotency-Key stays in flight before a retry may take it over. A bad value
 * is a failed boot, not a claim that lasts a day or one that lapses under a
 * request that is merely slow.
 */
describe('MAINTENANCE_IDEMPOTENCY_CLAIM_LEASE_SECONDS', () => {
  const load = (value?: string) =>
    loadMaintenanceEnv({
      ...BASE,
      ...(value === undefined ? {} : { MAINTENANCE_IDEMPOTENCY_CLAIM_LEASE_SECONDS: value }),
    });

  it('defaults to two minutes, comfortably above a request timeout and far below a response’s lifetime', () => {
    const env = load();
    expect(env.MAINTENANCE_IDEMPOTENCY_CLAIM_LEASE_SECONDS).toBe(120);
    expect(env.MAINTENANCE_IDEMPOTENCY_CLAIM_LEASE_SECONDS).toBeLessThan(
      env.MAINTENANCE_IDEMPOTENCY_TTL_HOURS * 3_600,
    );
  });

  it.each(['30', '300', '3600'])('accepts %s seconds', (value) => {
    expect(load(value).MAINTENANCE_IDEMPOTENCY_CLAIM_LEASE_SECONDS).toBe(Number(value));
  });

  it.each(['0', '29', '-1', '3601', '1.5', 'soon', ''])(
    'refuses %p at boot rather than guessing',
    (value) => {
      expect(() => load(value)).toThrow(EnvValidationError);
    },
  );
});

/**
 * #268 r4: DATABASE_STATEMENT_TIMEOUT_MS is opt-in, and when set it must be
 * above every operation budget the service declares — the longest is a
 * replayed asset event's refresh, which holds the asset's locks across calls
 * of `ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS` while new work waits on them.
 */
describe('DATABASE_STATEMENT_TIMEOUT_MS against the operation budgets', () => {
  const load = (overrides: NodeJS.ProcessEnv) => () =>
    loadMaintenanceEnv({ ...BASE, ...overrides });

  it('unset, applies no statement timeout', () => {
    const env = loadMaintenanceEnv(BASE);
    expect(env.DATABASE_STATEMENT_TIMEOUT_MS).toBeUndefined();
    expect(env.DATABASE_URL).not.toContain('statement_timeout');
  });

  it('declares every budget, at the defaults', () => {
    expect(
      maintenanceOperationBudgets(loadMaintenanceEnv(BASE)).map((b) => [b.name, b.budgetMs]),
    ).toEqual([
      ['PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS', 5000],
      ['IN_FLIGHT_WAIT_MS', 7000],
      ['REFRESH_TRANSACTION_TIMEOUT_MS', 30_000],
      ['ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS', 11_000],
      ['OUTBOX_CLAIM_LEASE_SECONDS', 12_500],
      ['OUTBOX_PURGE_STATEMENT_TIMEOUT_MS', 10_000],
    ]);
  });

  it('set, must be above the largest: the replay refresh, 30 s; the bound is exact', () => {
    expect(load({ DATABASE_STATEMENT_TIMEOUT_MS: '30000' })).toThrow(
      /DATABASE_STATEMENT_TIMEOUT_MS: \(30000 ms\) is not above REFRESH_TRANSACTION_TIMEOUT_MS, 30000 ms/,
    );
    expect(load({ DATABASE_STATEMENT_TIMEOUT_MS: '30001' })).not.toThrow();
  });

  it('a configured budget raises the floor: 2 × the resolution timeout + 5 s', () => {
    const slow = { ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS: '30000' };
    expect(load({ ...slow, DATABASE_STATEMENT_TIMEOUT_MS: '65000' })).toThrow(
      /not above ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS, 65000 ms/,
    );
    expect(load({ ...slow, DATABASE_STATEMENT_TIMEOUT_MS: '65001' })).not.toThrow();
  });
});

/**
 * Refusals never carry the value written (S-09, #385 r2 F2): every enum setting, found by
 * walking the schema rather than listed, set to each of two sentinels, is refused alike, with
 * neither in the issues, the error's message or its stack (what the startup log prints).
 */
describe('enum settings are refused without the value written (#385 r2 F2)', () => {
  const SENTINELS = ['private-sentinel-79', 'JZ97-another-secret'] as const;
  const probes = envEnumProbes(
    maintenanceEnvSchema,
    (source) => loadMaintenanceEnv(source),
    BASE,
    SENTINELS,
  );

  it('are found by walking the schema, the ones the r2 review named among them', () => {
    expect(probes.map((probe) => probe.name)).toEqual(
      expect.arrayContaining(['NODE_ENV', 'LOG_LEVEL', 'KAFKA_SASL_MECHANISM']),
    );
  });

  it.each(probes.map((probe) => [probe.name, probe] as const))('%s', (name, probe) => {
    expect(probe.codes).toContain('invalid_enum_value');
    const [a, b] = probe.refusals;
    expect(a).toEqual(b);
    for (const sentinel of SENTINELS) expect(JSON.stringify(a)).not.toContain(sentinel);
    expect(a.issues.some((issue) => issue.path === name || issue.path.startsWith(`${name}.`))).toBe(
      true,
    );
  });
});

// FU-304: an explicitly empty value must not silently replace the default with zero.
describe('strict whole-number optional-zero settings', () => {
  const name = 'MAINTENANCE_DEFAULT_LEAD_DAYS';
  const loadSetting = (value?: string) => loadMaintenanceEnv({ ...BASE, [name]: value })[name];

  it('preserves the unset default and both inclusive bounds', () => {
    expect(loadSetting()).toBe(7);
    expect(loadSetting('0')).toBe(0);
    expect(loadSetting('365')).toBe(365);
  });

  it.each([
    '',
    ' ',
    '\t',
    ' 7 ',
    '+7',
    '-1',
    '7.0',
    '7e0',
    '0x7',
    '۰',
    '٠',
    '7\n',
    '366',
    '0'.repeat(3) + '7',
  ])('refuses malformed or out-of-range input %j', (value) => {
    expect(() => loadSetting(value)).toThrow(name);
  });
});
