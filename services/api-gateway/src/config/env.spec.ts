import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EnvValidationError, envEnumProbes, envRefusalOf } from '@rasta/config';
import {
  gatewayEnvSchema,
  loadGatewayEnv,
  TENDER_OPEN_DEADLINE_DEFAULT_MS,
  TENDER_OPEN_DEADLINE_MAX_MS,
  TENDER_OPEN_DEADLINE_MIN_MS,
} from './env';

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

describe('GATEWAY_TENDER_OPEN_TIMEOUT_MS (Codex r2 on #250, G1)', () => {
  const loadWith = (overrides: NodeJS.ProcessEnv) => loadGatewayEnv({ ...BASE, ...overrides });

  it('defaults to 60 s, and leaves every other route on GATEWAY_UPSTREAM_TIMEOUT_MS', () => {
    const env = loadWith({});
    expect(env.GATEWAY_TENDER_OPEN_TIMEOUT_MS).toBe(TENDER_OPEN_DEADLINE_DEFAULT_MS);
    expect(TENDER_OPEN_DEADLINE_DEFAULT_MS).toBe(60_000);
    expect(env.GATEWAY_UPSTREAM_TIMEOUT_MS).toBe(3_000);
    expect(
      loadWith({ GATEWAY_TENDER_OPEN_TIMEOUT_MS: '90000' }).GATEWAY_TENDER_OPEN_TIMEOUT_MS,
    ).toBe(90_000);
  });

  it.each([
    String(TENDER_OPEN_DEADLINE_MIN_MS - 1),
    String(TENDER_OPEN_DEADLINE_MAX_MS + 1),
    '0',
    '-1',
    '60000.5',
    'forever',
    '',
  ])('refuses %j at startup rather than falling back', (value) => {
    expect(() => loadWith({ GATEWAY_TENDER_OPEN_TIMEOUT_MS: value })).toThrow(
      /GATEWAY_TENDER_OPEN_TIMEOUT_MS/,
    );
  });

  it('is never shorter than the deadline every other route gets', () => {
    expect(() =>
      loadWith({ GATEWAY_UPSTREAM_TIMEOUT_MS: '20000', GATEWAY_TENDER_OPEN_TIMEOUT_MS: '10000' }),
    ).toThrow(/GATEWAY_TENDER_OPEN_TIMEOUT_MS: must be at least GATEWAY_UPSTREAM_TIMEOUT_MS/);
    expect(
      loadWith({ GATEWAY_UPSTREAM_TIMEOUT_MS: '10000', GATEWAY_TENDER_OPEN_TIMEOUT_MS: '10000' })
        .GATEWAY_TENDER_OPEN_TIMEOUT_MS,
    ).toBe(10_000);
  });

  /**
   * construction-service's opening: its transaction's timeout and, around it, two identity reads
   * and the evidence read before and two identity reads after the commit. Read from its source and
   * from `.env.example` as text — no cross-service import — so the two services cannot drift apart.
   */
  describe('stays above what construction-service may take to open', () => {
    const root = join(__dirname, '../../../..');
    const constructionEnv = readFileSync(
      join(root, 'services/construction-service/src/config/env.ts'),
      'utf8',
    );
    const asNumber = (text: string | undefined): number => Number(text?.replaceAll('_', ''));
    const constant = (name: string): number =>
      asNumber(new RegExp(`export const ${name} = ([\\d_]+);`).exec(constructionEnv)?.[1]);
    const zodDefault = (name: string): number =>
      asNumber(
        new RegExp(`${name}: z\\.coerce[^;]*?\\.prefault\\(([\\d_]+)\\)`).exec(
          constructionEnv,
        )?.[1],
      );
    const CALLS_AROUND_THE_TRANSACTION = 5;

    it('by default: construction’s default timeout plus its calls fit in the gateway’s default', () => {
      const transaction = constant('TENDER_OPEN_TIMEOUT_DEFAULT_MS');
      const call = Math.max(
        zodDefault('CONSTRUCTION_IDENTITY_REQUEST_TIMEOUT_MS'),
        zodDefault('CONSTRUCTION_AUDIT_REQUEST_TIMEOUT_MS'),
      );
      expect(transaction).toBe(30_000);
      expect(call).toBe(5_000);
      expect(TENDER_OPEN_DEADLINE_DEFAULT_MS).toBeGreaterThanOrEqual(
        transaction + CALLS_AROUND_THE_TRANSACTION * call,
      );
    });

    it('can be set above construction’s longest permitted transaction', () => {
      expect(TENDER_OPEN_DEADLINE_MAX_MS).toBeGreaterThan(constant('TENDER_OPEN_TIMEOUT_MAX_MS'));
    });

    it('in .env.example too', () => {
      const example = readFileSync(join(root, '.env.example'), 'utf8');
      const value = (name: string): number =>
        asNumber(new RegExp(`^${name}=(\\d+)$`, 'm').exec(example)?.[1]);
      expect(value('GATEWAY_TENDER_OPEN_TIMEOUT_MS')).toBeGreaterThanOrEqual(
        value('CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS') +
          CALLS_AROUND_THE_TRANSACTION * value('CONSTRUCTION_IDENTITY_REQUEST_TIMEOUT_MS'),
      );
    });
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
    gatewayEnvSchema,
    (source) => loadGatewayEnv(source),
    BASE,
    SENTINELS,
  );

  it('are found by walking the schema, the ones the r2 review named among them', () => {
    expect(probes.map((probe) => probe.name)).toEqual(
      expect.arrayContaining(['NODE_ENV', 'LOG_LEVEL']),
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

describe('GATEWAY_TRUSTED_PROXIES refuses without the entry written (#385 r1/r2, S-09)', () => {
  const SENTINELS = ['private-sentinel-79', 'JZ97-another-secret'] as const;

  it('the same fixed text whatever the entry', () => {
    const [a, b] = SENTINELS.map((value) =>
      envRefusalOf(() =>
        loadGatewayEnv({ ...BASE, GATEWAY_TRUSTED_PROXIES: `10.0.0.0/8,${value}` }),
      ),
    );
    expect(a).toEqual(b);
    expect(a?.issues).toEqual([
      {
        path: 'GATEWAY_TRUSTED_PROXIES',
        message: expect.stringMatching(/^names an entry that is not an IP address, a CIDR range/),
      },
    ]);
    for (const sentinel of SENTINELS) expect(JSON.stringify(a)).not.toContain(sentinel);
  });
});
