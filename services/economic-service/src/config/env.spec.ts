import { EnvValidationError } from '@rasta/config';
import { corsOrigins, loadEconomicEnv } from './env';

/**
 * The configuration this service refuses to start without — and the values it
 * deliberately does **not** offer a default for.
 *
 * The absent defaults are the point. There is no commission rate here, no
 * reward conversion rate and no approval threshold: those are governance
 * decisions that live in database tables where they can be versioned and
 * audited (ADR-023). An environment variable holding a commission rate would
 * be a hard-coded rate with extra steps.
 */
/** Everything the schema demands, with nothing optional decided. */
const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/rasta_economic?schema=public',
  KAFKA_BROKERS: 'localhost:9092',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
  OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
  OIDC_AUDIENCE: 'rasta-api',
  INTERNAL_TOKEN_SECRET: 'a_secret_that_is_at_least_thirty_two_chars',
} as NodeJS.ProcessEnv;

describe('loadEconomicEnv', () => {
  it('fills in this service’s own identity and port', () => {
    const env = loadEconomicEnv(base);

    expect(env.SERVICE_NAME).toBe('economic-service');
    expect(env.PORT).toBe(3112);
    expect(env.KAFKA_CLIENT_ID).toBe('economic-service');
  });

  it('takes the database and port from the per-service variables the root .env names', () => {
    // The repository-root `.env` names every database explicitly, so one file
    // can describe the whole platform without any service being able to open
    // another's by accident (ADR-005).
    const env = loadEconomicEnv({
      ...base,
      DATABASE_URL: undefined,
      DATABASE_URL_ECONOMIC: 'postgresql://u:p@localhost:5432/rasta_economic',
      PORT_ECONOMIC: '4112',
    } as NodeJS.ProcessEnv);

    expect(env.DATABASE_URL).toBe('postgresql://u:p@localhost:5432/rasta_economic');
    expect(env.PORT).toBe(4112);
  });

  it('defaults the platform operator organization rather than naming one', () => {
    // Which organization operates the platform is a deployment fact. Encoding
    // "the union" here would be exactly the structural assumption AGENTS.md
    // A-05 forbids.
    expect(loadEconomicEnv(base).ECONOMIC_PLATFORM_ORGANIZATION_ID).toBe('ORG-PLATFORM');
    expect(
      loadEconomicEnv({ ...base, ECONOMIC_PLATFORM_ORGANIZATION_ID: 'ORG-OPERATOR' })
        .ECONOMIC_PLATFORM_ORGANIZATION_ID,
    ).toBe('ORG-OPERATOR');
  });

  it('refuses a payment provider it does not have, rather than falling back to the simulation', () => {
    // A silent fallback to a simulated provider in an environment that
    // expected a real one is the worst failure available here (ADR-024).
    expect(loadEconomicEnv(base).ECONOMIC_PAYMENT_PROVIDER).toBe('mock');
    expect(() => loadEconomicEnv({ ...base, ECONOMIC_PAYMENT_PROVIDER: 'zarinpal' })).toThrow(
      EnvValidationError,
    );
  });

  it('keeps cashback off until the regulatory review answers', () => {
    // docs/24 Q-07: the product document conditions cashback on a review, so
    // the flag defaults off and only a deliberate value opens it.
    //
    // This once asserted that "yes" left it off — an artefact of the
    // hand-rolled `value === 'true'` transform, not a product rule. Q-07
    // governs the default, not the spelling. Under `booleanEnv` an operator
    // who writes "yes" has deliberately opened it, and — the part that
    // actually protects the review — a value that is *not* a boolean no
    // longer reads as a quiet `false`: it stops the service (D-020).
    expect(loadEconomicEnv(base).ECONOMIC_REWARD_CASHBACK_ENABLED).toBe(false);
    expect(() => loadEconomicEnv({ ...base, ECONOMIC_REWARD_CASHBACK_ENABLED: 'ture' })).toThrow(
      EnvValidationError,
    );
    expect(
      loadEconomicEnv({ ...base, ECONOMIC_REWARD_CASHBACK_ENABLED: 'true' })
        .ECONOMIC_REWARD_CASHBACK_ENABLED,
    ).toBe(true);
  });

  it('keeps the reconciliation on unless it is switched off explicitly', () => {
    // Opt-out rather than opt-in: a deployment that forgot the variable should
    // still be checking its wallets against its ledger.
    expect(loadEconomicEnv(base).ECONOMIC_BALANCE_AUDIT_ENABLED).toBe(true);
    expect(
      loadEconomicEnv({ ...base, ECONOMIC_BALANCE_AUDIT_ENABLED: 'false' })
        .ECONOMIC_BALANCE_AUDIT_ENABLED,
    ).toBe(false);
  });

  it('refuses a reconciliation interval or idempotency window outside its bounds', () => {
    expect(() =>
      loadEconomicEnv({ ...base, ECONOMIC_BALANCE_AUDIT_INTERVAL_SECONDS: '5' }),
    ).toThrow(EnvValidationError);
    // A stored key honoured for longer than a week stops being a retry window
    // and starts being a cache of financial responses (docs/06 § 6.8).
    expect(() => loadEconomicEnv({ ...base, ECONOMIC_IDEMPOTENCY_TTL_HOURS: '999' })).toThrow(
      EnvValidationError,
    );
  });

  it('refuses to start without the identity provider or the internal secret', () => {
    // Validated once, at startup, and loudly: a service that boots without
    // these discovers it on the first request, which turns a deployment error
    // into a production incident.
    expect(() => loadEconomicEnv({ ...base, OIDC_ISSUER_URL: undefined })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEconomicEnv({ ...base, INTERNAL_TOKEN_SECRET: 'too-short' })).toThrow(
      EnvValidationError,
    );
  });

  it('refuses a database URL that is not one', () => {
    // `z.string().url()` accepts `localhost:5432` — the WHATWG parser reads
    // `localhost:` as a scheme — so a typo would pass validation and fail at
    // connection time instead.
    expect(() => loadEconomicEnv({ ...base, DATABASE_URL: 'localhost:5432' })).toThrow(
      EnvValidationError,
    );
  });
});

describe('corsOrigins', () => {
  const env = (value: string) => ({ CORS_ORIGINS: value }) as ReturnType<typeof loadEconomicEnv>;

  it('splits, trims and drops the empties', () => {
    expect(corsOrigins(env('http://a.test, http://b.test ,'))).toEqual([
      'http://a.test',
      'http://b.test',
    ]);
  });

  it('returns nothing for an unset value, which leaves CORS closed', () => {
    expect(corsOrigins(env(''))).toEqual([]);
  });
});

/**
 * The two boolean flags this service owns (D-020).
 *
 * Neither was a `z.coerce.boolean()`. They were hand-rolled transforms —
 * `value === 'true'` and `value !== 'false'` — which is the same defect at one
 * remove: each accepted exactly one spelling and silently guessed at
 * everything else. `ECONOMIC_BALANCE_AUDIT_ENABLED=0` left the reconciliation
 * running; `ECONOMIC_REWARD_CASHBACK_ENABLED=1` left cashback refused. A typo
 * in either was never an error, just a quiet decision nobody made.
 *
 * Both now read through `booleanEnv`, the platform's single boolean
 * environment parser, so the accepted spellings are the same everywhere and
 * anything else stops the service at boot.
 */
describe('ECONOMIC_REWARD_CASHBACK_ENABLED', () => {
  const load = (value?: string) =>
    loadEconomicEnv({
      ...base,
      ...(value === undefined ? {} : { ECONOMIC_REWARD_CASHBACK_ENABLED: value }),
    } as NodeJS.ProcessEnv);

  it('defaults to false — cashback stays behind its regulatory review', () => {
    // ADR-033 and docs/24 Q-07: the product document conditions cashback on a
    // regulatory review, so the default is off and creating a CASHBACK rule is
    // refused rather than silently ignored.
    expect(load().ECONOMIC_REWARD_CASHBACK_ENABLED).toBe(false);
  });

  it('reads "false" as false', () => {
    expect(load('false').ECONOMIC_REWARD_CASHBACK_ENABLED).toBe(false);
  });

  it('reads "true" as true', () => {
    expect(load('true').ECONOMIC_REWARD_CASHBACK_ENABLED).toBe(true);
  });

  it.each(['TRUE', 'True', '1', 'yes', 'on', ' true '])(
    'reads %p as true — the old `value === "true"` read every one of these as false',
    (value) => {
      expect(load(value).ECONOMIC_REWARD_CASHBACK_ENABLED).toBe(true);
    },
  );

  it.each(['maybe', 'cashback', '2'])('refuses %p rather than guessing', (value) => {
    expect(() => load(value)).toThrow(EnvValidationError);
  });
});

describe('ECONOMIC_BALANCE_AUDIT_ENABLED', () => {
  const load = (value?: string) =>
    loadEconomicEnv({
      ...base,
      ...(value === undefined ? {} : { ECONOMIC_BALANCE_AUDIT_ENABLED: value }),
    } as NodeJS.ProcessEnv);

  it('defaults to true — the ledger/wallet reconciliation runs unless told not to', () => {
    expect(load().ECONOMIC_BALANCE_AUDIT_ENABLED).toBe(true);
  });

  it('reads "true" as true', () => {
    expect(load('true').ECONOMIC_BALANCE_AUDIT_ENABLED).toBe(true);
  });

  it('reads "false" as false', () => {
    expect(load('false').ECONOMIC_BALANCE_AUDIT_ENABLED).toBe(false);
  });

  it.each(['FALSE', 'False', '0', 'no', 'off', ' false '])(
    'reads %p as false — the old `value !== "false"` read every one of these as true',
    (value) => {
      expect(load(value).ECONOMIC_BALANCE_AUDIT_ENABLED).toBe(false);
    },
  );

  it.each(['maybe', 'audit', '2'])('refuses %p rather than guessing', (value) => {
    expect(() => load(value)).toThrow(EnvValidationError);
  });
});
