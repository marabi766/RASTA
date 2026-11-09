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
  NODE_ENV: 'test',
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
 * `GATEWAY_REVOCATION_LIST` (ADR-060, gateway revocation list addendum). Omitting it must never
 * choose for the operator outside development and test, and the token lifetime it compares with
 * is the realm's, never a number written into the code.
 */
describe('the revocation list settings', () => {
  const repoRoot = join(__dirname, '..', '..', '..', '..');
  const withMode = (overrides: NodeJS.ProcessEnv) => {
    const env: NodeJS.ProcessEnv = { ...BASE, ...overrides };
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
    return loadGatewayEnv(env);
  };

  it.each(['development', 'test'])('is off when omitted with NODE_ENV=%s', (nodeEnv) => {
    expect(withMode({ NODE_ENV: nodeEnv }).GATEWAY_REVOCATION_LIST).toBe('off');
  });

  it.each(['staging', 'production', undefined])(
    'refuses to start when omitted with NODE_ENV=%p — an unset NODE_ENV says nothing',
    (nodeEnv) => {
      expect(() => withMode({ NODE_ENV: nodeEnv })).toThrow(EnvValidationError);
    },
  );

  it('takes an explicit off in production', () => {
    expect(
      withMode({
        NODE_ENV: 'production',
        GATEWAY_REVOCATION_LIST: 'off',
        KEYCLOAK_ATTRIBUTE_PROPAGATION_SECONDS: '10',
      }).GATEWAY_REVOCATION_LIST,
    ).toBe('off');
  });

  it.each(['on', 'true', 'ENFORCE', ''])('refuses %p rather than guessing', (value) => {
    expect(() => withMode({ GATEWAY_REVOCATION_LIST: value })).toThrow(EnvValidationError);
  });

  it('refuses enforce without the supported token lifetime', () => {
    expect(() => withMode({ GATEWAY_REVOCATION_LIST: 'enforce' })).toThrow(
      /GATEWAY_REVOCATION_MAX_TOKEN_LIFETIME_SECONDS/,
    );
  });

  it('refuses enforce while the identity-topic reader is not in the build', () => {
    expect(() =>
      withMode({
        GATEWAY_REVOCATION_LIST: 'enforce',
        GATEWAY_REVOCATION_MAX_TOKEN_LIFETIME_SECONDS: '900',
      }),
    ).toThrow(/identity-topic reader/);
  });

  it('reads the clock tolerance the verifier is given, 5 seconds unless set', () => {
    expect(withMode({}).GATEWAY_OIDC_CLOCK_TOLERANCE_SECONDS).toBe(5);
    expect(
      withMode({ GATEWAY_OIDC_CLOCK_TOLERANCE_SECONDS: '2' }).GATEWAY_OIDC_CLOCK_TOLERANCE_SECONDS,
    ).toBe(2);
  });

  describe('KEYCLOAK_ATTRIBUTE_PROPAGATION_SECONDS (D-064)', () => {
    it.each(['development', 'test'])('is 10 when omitted with NODE_ENV=%s', (nodeEnv) => {
      expect(withMode({ NODE_ENV: nodeEnv }).KEYCLOAK_ATTRIBUTE_PROPAGATION_SECONDS).toBe(10);
    });

    it.each(['staging', 'production', undefined])(
      'refuses to start when omitted with NODE_ENV=%p — a stated bound, never a guess',
      (nodeEnv) => {
        expect(() => withMode({ NODE_ENV: nodeEnv, GATEWAY_REVOCATION_LIST: 'off' })).toThrow(
          /KEYCLOAK_ATTRIBUTE_PROPAGATION_SECONDS/,
        );
      },
    );

    it.each([
      ['0', 0],
      ['10', 10],
      ['60', 60],
    ])('takes %p as stated, in production too', (value, expected) => {
      expect(
        withMode({
          NODE_ENV: 'production',
          GATEWAY_REVOCATION_LIST: 'off',
          KEYCLOAK_ATTRIBUTE_PROPAGATION_SECONDS: value,
        }).KEYCLOAK_ATTRIBUTE_PROPAGATION_SECONDS,
      ).toBe(expected);
    });

    it.each(['61', '-1', '1.5', '', ' 10', '10s', '1e1', '0x0a', '100'])(
      'refuses %p: whole seconds from 0 to 60 only',
      (value) => {
        expect(() => withMode({ KEYCLOAK_ATTRIBUTE_PROPAGATION_SECONDS: value })).toThrow(
          EnvValidationError,
        );
      },
    );

    it('.env.example states the default the brief decided: 10', () => {
      const example = readFileSync(join(repoRoot, '.env.example'), 'utf8');
      expect(/^KEYCLOAK_ATTRIBUTE_PROPAGATION_SECONDS=(\d+)$/m.exec(example)?.[1]).toBe('10');
    });
  });

  it('.env.example states the realm’s access-token lifetime, not another number', () => {
    const example = readFileSync(join(repoRoot, '.env.example'), 'utf8');
    const realm = JSON.parse(
      readFileSync(join(repoRoot, 'infrastructure/docker/keycloak/rasta-realm.json'), 'utf8'),
    ) as { accessTokenLifespan: number };
    const stated = /^GATEWAY_REVOCATION_MAX_TOKEN_LIFETIME_SECONDS=(\d+)$/m.exec(example)?.[1];
    expect(Number(stated)).toBe(realm.accessTokenLifespan);
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

/** FU-276: every numeric gateway input, including the shared startup/auth helpers. */
describe('strict decimal integer environment settings', () => {
  const settings: Array<[string, number, number]> = [
    ['PORT', 1, 65535],
    ['SHUTDOWN_TIMEOUT_MS', 1000, 120000],
    ['INTERNAL_TOKEN_TTL_SECONDS', 30, 900],
    ['GATEWAY_RATE_LIMIT_MAX', 1, Number.MAX_SAFE_INTEGER],
    ['GATEWAY_RATE_LIMIT_WINDOW_MS', 1000, 2147483647],
    ['GATEWAY_TENANT_RATE_LIMIT_MAX', 1, Number.MAX_SAFE_INTEGER],
    ['GATEWAY_ANON_RATE_LIMIT_MAX', 1, Number.MAX_SAFE_INTEGER],
    ['GATEWAY_UPSTREAM_TIMEOUT_MS', 100, 2147483647],
    ['GATEWAY_TENDER_OPEN_TIMEOUT_MS', 5000, 180000],
    ['GATEWAY_CIRCUIT_FAILURE_THRESHOLD', 1, Number.MAX_SAFE_INTEGER],
    ['GATEWAY_CIRCUIT_RESET_MS', 1000, 2147483647],
    ['GATEWAY_CIRCUIT_ORGANIZATIONS_TO_OPEN', 2, 100],
    ['GATEWAY_REVOCATION_MAX_TOKEN_LIFETIME_SECONDS', 60, 86400],
    ['GATEWAY_OIDC_CLOCK_TOLERANCE_SECONDS', 0, 60],
    ['GATEWAY_REVOCATION_MAX_STALENESS_SECONDS', 5, 300],
    ['GATEWAY_REVOCATION_MAX_ENTRIES', 1000, 10000000],
  ];
  const numericLoad = (name: string, value: string) =>
    loadGatewayEnv({
      ...BASE,
      GATEWAY_TENDER_OPEN_TIMEOUT_MS: '180000',
      [name]: value,
    });

  it.each(settings)('%s accepts both bounds and refuses out-of-range values', (name, min, max) => {
    for (const value of name === 'GATEWAY_UPSTREAM_TIMEOUT_MS' ? [min] : [min, max])
      expect(
        numericLoad(name, String(value))[name as keyof ReturnType<typeof loadGatewayEnv>],
      ).toBe(value);
    for (const value of [min - 1, max + 1])
      expect(envRefusalOf(() => numericLoad(name, String(value)))?.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: name })]),
      );
  });

  it('UPSTREAM has its own timer cap, independent of the tender refinement', () => {
    const field = gatewayEnvSchema.shape.GATEWAY_UPSTREAM_TIMEOUT_MS;
    expect(field.safeParse('2147483647').success).toBe(true);
    expect(field.safeParse('2147483648').success).toBe(false);
  });

  it.each(settings)('%s refuses coercion at startup without echoing the input', (name, min) => {
    for (const value of [
      '',
      ' ',
      ` ${min}`,
      `${min} `,
      `${min}\n`,
      `0x${min.toString(16)}`,
      `0b${min.toString(2)}`,
      `0o${min.toString(8)}`,
      `${min}e0`,
      `${min}.0`,
      `+${min}`,
      '-0',
      'NaN',
      'Infinity',
      '1_000',
      '60s',
      '۶۰',
      'private-sentinel-79',
      '9007199254740993',
    ]) {
      const refusal = envRefusalOf(() => numericLoad(name, value));
      expect(refusal?.issues.some((issue) => issue.path === name)).toBe(true);
      expect(JSON.stringify(refusal)).not.toContain('private-sentinel-79');
    }
  });
});
