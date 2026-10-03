import { brokersOf, corsOrigins, DEFAULT_PORT, loadConstructionEnv, SERVICE_NAME } from './env';

/**
 * Configuration parsing, the fallbacks a deployment relies on, and the four
 * provisional policy settings of Q-68 and Q-69.
 *
 * The policy settings are the interesting part. Each default is the narrowest
 * provisional decision recorded in `docs/24`, and each misconfiguration that
 * would widen access or invent a lifecycle edge stops the service at startup
 * rather than running with it.
 */

const BASE: NodeJS.ProcessEnv = {
  KAFKA_BROKERS: 'localhost:9092',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
  OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
  OIDC_AUDIENCE: 'rasta-api',
  INTERNAL_TOKEN_SECRET: 'a-throwaway-value-used-only-by-this-spec-32',
  DATABASE_URL_CONSTRUCTION: 'postgresql://u:p@localhost:5433/rasta_construction?schema=public',
};

function load(overrides: NodeJS.ProcessEnv = {}) {
  return loadConstructionEnv({ ...BASE, ...overrides });
}

describe('service identity and wiring', () => {
  it('names itself construction-service', () => {
    expect(load().SERVICE_NAME).toBe(SERVICE_NAME);
    expect(SERVICE_NAME).toBe('construction-service');
  });

  it('falls back to 3110 — the port the gateway and .env.example both name', () => {
    expect(load().PORT).toBe(Number(DEFAULT_PORT));
    expect(DEFAULT_PORT).toBe('3110');
  });

  it('prefers PORT_CONSTRUCTION over the default, and PORT over both', () => {
    expect(load({ PORT_CONSTRUCTION: '3999' }).PORT).toBe(3999);
    expect(load({ PORT: '3001', PORT_CONSTRUCTION: '3999' }).PORT).toBe(3001);
  });

  it('uses DATABASE_URL_CONSTRUCTION, and prefers an explicit DATABASE_URL', () => {
    expect(load().DATABASE_URL).toContain('rasta_construction');
    expect(
      load({ DATABASE_URL: 'postgresql://u:p@db:5432/other?schema=public' }).DATABASE_URL,
    ).toContain('/other');
  });

  it('refuses to start with no database rather than defaulting to one (A-01)', () => {
    const { DATABASE_URL_CONSTRUCTION: _omitted, ...withoutDatabase } = BASE;
    expect(() => loadConstructionEnv(withoutDatabase)).toThrow(/DATABASE_URL/);
  });

  it('follows the platform naming for kafka client and consumer group', () => {
    const env = load();
    expect(env.KAFKA_CLIENT_ID).toBe(SERVICE_NAME);
    expect(env.KAFKA_CONSUMER_GROUP).toBe('construction-service.main');
    expect(brokersOf(load({ KAFKA_BROKERS: 'a:9092, b:9092 ,' }))).toEqual(['a:9092', 'b:9092']);
  });

  it('trusts no browser origin by default and falls back to the gateway list', () => {
    expect(corsOrigins(load())).toEqual([]);
    expect(corsOrigins(load({ GATEWAY_CORS_ORIGINS: 'http://a, http://b' }))).toEqual([
      'http://a',
      'http://b',
    ]);
  });
});

describe('project roles (Q-69)', () => {
  it('defaults the writers to ORGANIZATION_ADMIN and the extra readers to nobody', () => {
    const env = load();
    expect(env.CONSTRUCTION_PROJECT_ROLES).toEqual(['ORGANIZATION_ADMIN']);
    expect(env.CONSTRUCTION_PROJECT_READER_ROLES).toEqual([]);
  });

  it('accepts a configured list, trimmed', () => {
    const env = load({
      CONSTRUCTION_PROJECT_ROLES: 'ORGANIZATION_ADMIN, PROCUREMENT_USER',
      CONSTRUCTION_PROJECT_READER_ROLES: 'FLEET_MANAGER',
    });
    expect(env.CONSTRUCTION_PROJECT_ROLES).toEqual(['ORGANIZATION_ADMIN', 'PROCUREMENT_USER']);
    expect(env.CONSTRUCTION_PROJECT_READER_ROLES).toEqual(['FLEET_MANAGER']);
  });

  it.each(['CONSTRUCTION_PROJECT_ROLES', 'CONSTRUCTION_PROJECT_READER_ROLES'])(
    'refuses to start when %s names the oversight role',
    (key) => {
      expect(() => load({ [key]: 'ORGANIZATION_ADMIN,AUDITOR' })).toThrow(/AUDITOR/);
    },
  );

  it('refuses an unknown role rather than ignoring it', () => {
    expect(() => load({ CONSTRUCTION_PROJECT_ROLES: 'PROJECT_MANAGER' })).toThrow(
      /Unknown role in CONSTRUCTION_PROJECT_ROLES/,
    );
  });

  describe('who opens bids (ADR-066 § 4)', () => {
    it('is empty by default, which means the owner role set', () => {
      expect(load().CONSTRUCTION_TENDER_OPEN_ROLES).toEqual([]);
    });

    it('accepts a configured list, trimmed', () => {
      expect(
        load({ CONSTRUCTION_TENDER_OPEN_ROLES: 'ORGANIZATION_ADMIN, PROCUREMENT_USER' })
          .CONSTRUCTION_TENDER_OPEN_ROLES,
      ).toEqual(['ORGANIZATION_ADMIN', 'PROCUREMENT_USER']);
    });

    it.each(['AUDITOR', 'SYSTEM_ADMIN', 'CONTRACTOR'])(
      'refuses to start when it names %s',
      (role) => {
        expect(() =>
          load({ CONSTRUCTION_TENDER_OPEN_ROLES: `ORGANIZATION_ADMIN,${role}` }),
        ).toThrow(/CONSTRUCTION_TENDER_OPEN_ROLES/);
      },
    );

    it('refuses an unknown role rather than ignoring it', () => {
      expect(() => load({ CONSTRUCTION_TENDER_OPEN_ROLES: 'COMMITTEE_CHAIR' })).toThrow(
        /Unknown role in CONSTRUCTION_TENDER_OPEN_ROLES/,
      );
    });
  });

  describe('who evaluates bids (ADR-067 § 4)', () => {
    it('is empty by default, which means the owner role set', () => {
      expect(load().CONSTRUCTION_TENDER_EVALUATE_ROLES).toEqual([]);
    });

    it('accepts a configured list, trimmed', () => {
      expect(
        load({ CONSTRUCTION_TENDER_EVALUATE_ROLES: 'ORGANIZATION_ADMIN, PROCUREMENT_USER' })
          .CONSTRUCTION_TENDER_EVALUATE_ROLES,
      ).toEqual(['ORGANIZATION_ADMIN', 'PROCUREMENT_USER']);
    });

    it.each(['AUDITOR', 'SYSTEM_ADMIN', 'CONTRACTOR'])(
      'refuses to start when it names %s',
      (role) => {
        expect(() =>
          load({ CONSTRUCTION_TENDER_EVALUATE_ROLES: `ORGANIZATION_ADMIN,${role}` }),
        ).toThrow(/CONSTRUCTION_TENDER_EVALUATE_ROLES/);
      },
    );

    it('refuses an unknown role rather than ignoring it', () => {
      expect(() => load({ CONSTRUCTION_TENDER_EVALUATE_ROLES: 'COMMITTEE_CHAIR' })).toThrow(
        /Unknown role in CONSTRUCTION_TENDER_EVALUATE_ROLES/,
      );
    });
  });

  describe('who awards a tender (ADR-067 § 3)', () => {
    it('is empty by default, which means the owner role set', () => {
      expect(load().CONSTRUCTION_TENDER_AWARD_ROLES).toEqual([]);
    });

    it('accepts a configured list, trimmed', () => {
      expect(
        load({ CONSTRUCTION_TENDER_AWARD_ROLES: 'ORGANIZATION_ADMIN, PROCUREMENT_USER' })
          .CONSTRUCTION_TENDER_AWARD_ROLES,
      ).toEqual(['ORGANIZATION_ADMIN', 'PROCUREMENT_USER']);
    });

    it.each(['AUDITOR', 'SYSTEM_ADMIN', 'CONTRACTOR'])(
      'refuses to start when it names %s',
      (role) => {
        expect(() =>
          load({ CONSTRUCTION_TENDER_AWARD_ROLES: `ORGANIZATION_ADMIN,${role}` }),
        ).toThrow(/CONSTRUCTION_TENDER_AWARD_ROLES/);
      },
    );

    it('refuses an unknown role rather than ignoring it', () => {
      expect(() => load({ CONSTRUCTION_TENDER_AWARD_ROLES: 'COMMITTEE_CHAIR' })).toThrow(
        /Unknown role in CONSTRUCTION_TENDER_AWARD_ROLES/,
      );
    });
  });

  describe('how many evaluators (Q-88, Q-92: provisional)', () => {
    it('defaults to ADR-067’s MVP: one evaluator per bid, one required', () => {
      const env = load();
      expect(env.CONSTRUCTION_EVALUATION_MIN_EVALUATORS).toBe(1);
      expect(env.CONSTRUCTION_EVALUATION_MAX_EVALUATORS).toBe(1);
    });

    it('accepts a committee', () => {
      const env = load({
        CONSTRUCTION_EVALUATION_MIN_EVALUATORS: '2',
        CONSTRUCTION_EVALUATION_MAX_EVALUATORS: '3',
      });
      expect([
        env.CONSTRUCTION_EVALUATION_MIN_EVALUATORS,
        env.CONSTRUCTION_EVALUATION_MAX_EVALUATORS,
      ]).toEqual([2, 3]);
    });

    it('refuses a minimum above the maximum: no bid could ever be complete', () => {
      expect(() =>
        load({
          CONSTRUCTION_EVALUATION_MIN_EVALUATORS: '2',
          CONSTRUCTION_EVALUATION_MAX_EVALUATORS: '1',
        }),
      ).toThrow(/CONSTRUCTION_EVALUATION_MIN_EVALUATORS/);
    });

    it.each(['0', '10', '1.5', 'many'])('refuses %s', (value) => {
      expect(() => load({ CONSTRUCTION_EVALUATION_MAX_EVALUATORS: value })).toThrow();
      expect(() => load({ CONSTRUCTION_EVALUATION_MIN_EVALUATORS: value })).toThrow();
    });
  });

  describe('the optional conflict-of-interest rules (Q-90, Q-92)', () => {
    it('are all off by default', () => {
      expect(load().CONSTRUCTION_COI_RULES).toEqual([]);
    });

    it('accepts rules from the closed set, trimmed', () => {
      expect(
        load({ CONSTRUCTION_COI_RULES: 'EVALUATOR_NOT_TENDER_AUTHOR, AWARDER_NOT_EVALUATOR' })
          .CONSTRUCTION_COI_RULES,
      ).toEqual(['EVALUATOR_NOT_TENDER_AUTHOR', 'AWARDER_NOT_EVALUATOR']);
    });

    it.each(['HIERARCHY', 'EVALUATOR_NOT_AUTHOR', 'ALL'])(
      'refuses %s: a rule the code does not implement is not silently ignored',
      (rule) => {
        expect(() =>
          load({ CONSTRUCTION_COI_RULES: `EVALUATOR_NOT_TENDER_AUTHOR,${rule}` }),
        ).toThrow(/Unknown rule in CONSTRUCTION_COI_RULES/);
      },
    );
  });

  describe('four-eyes for opening bids (Q-91)', () => {
    it('is on by default', () => {
      expect(load().CONSTRUCTION_TENDER_OPEN_FOUR_EYES).toBe(true);
      expect(load({ NODE_ENV: 'production' }).CONSTRUCTION_TENDER_OPEN_FOUR_EYES).toBe(true);
    });

    it.each(['development', 'test'])('may be switched off in %s', (NODE_ENV) => {
      expect(
        load({ NODE_ENV, CONSTRUCTION_TENDER_OPEN_FOUR_EYES: 'false' })
          .CONSTRUCTION_TENDER_OPEN_FOUR_EYES,
      ).toBe(false);
    });

    it.each(['staging', 'production'])('refuses to start switched off in %s', (NODE_ENV) => {
      expect(() => load({ NODE_ENV, CONSTRUCTION_TENDER_OPEN_FOUR_EYES: 'false' })).toThrow(
        /CONSTRUCTION_TENDER_OPEN_FOUR_EYES/,
      );
    });
  });

  it('refuses an empty writer list: nobody could create a project', () => {
    expect(() => load({ CONSTRUCTION_PROJECT_ROLES: ' , ' })).toThrow(/at least 1 role/);
  });
});

describe('cancellable states (Q-69)', () => {
  it('defaults to every state the lifecycle can cancel from', () => {
    expect(load().CONSTRUCTION_CANCELLABLE_STATES).toEqual([
      'DRAFT',
      'PENDING_APPROVAL',
      'CHANGES_REQUESTED',
      'APPROVED',
    ]);
  });

  it('may be narrowed', () => {
    expect(
      load({ CONSTRUCTION_CANCELLABLE_STATES: 'DRAFT' }).CONSTRUCTION_CANCELLABLE_STATES,
    ).toEqual(['DRAFT']);
  });

  it.each(['IN_PROGRESS', 'COMPLETED', 'CANCELLED'])(
    'refuses to start with %s, an edge the lifecycle does not have',
    (state) => {
      expect(() => load({ CONSTRUCTION_CANCELLABLE_STATES: `DRAFT,${state}` })).toThrow(
        /may only name states the lifecycle can cancel from/,
      );
    },
  );

  it('refuses an unknown state', () => {
    expect(() => load({ CONSTRUCTION_CANCELLABLE_STATES: 'ARCHIVED' })).toThrow(/Unknown state/);
  });
});

describe('operation types (Q-68)', () => {
  it('ships no list: free text by default', () => {
    expect(load().CONSTRUCTION_OPERATION_TYPES).toEqual([]);
  });

  it('accepts a configured list', () => {
    expect(load({ CONSTRUCTION_OPERATION_TYPES: 'a1, b2' }).CONSTRUCTION_OPERATION_TYPES).toEqual([
      'a1',
      'b2',
    ]);
  });

  it('refuses an entry too short to mean anything', () => {
    expect(() => load({ CONSTRUCTION_OPERATION_TYPES: 'x' })).toThrow(/2 to 100 characters/);
  });
});

describe('what is deliberately not configurable', () => {
  it('has no approval authority, threshold or legal-procedure key', () => {
    // Those are approval_policy rows (ADR-023, ADR-063), never environment.
    const keys = Object.keys(load());
    expect(
      keys.filter(
        (key) =>
          /AUTHORITY|THRESHOLD|APPROV|PROCUREMENT_NATURE/i.test(key) &&
          // The two approval *preconditions* (Q-68) say when a project may ask,
          // never who approves or above what amount.
          ![
            'CONSTRUCTION_APPROVAL_MIN_SUBMITTED_NEEDS',
            'CONSTRUCTION_APPROVAL_REQUIRES_ESTIMATE',
          ].includes(key),
      ),
    ).toEqual([]);
  });

  it('bounds the idempotency window', () => {
    expect(load().CONSTRUCTION_IDEMPOTENCY_TTL_HOURS).toBe(24);
    expect(() => load({ CONSTRUCTION_IDEMPOTENCY_TTL_HOURS: '0' })).toThrow();
  });
});

describe('PR 2 settings (Q-68, Q-70 to Q-72)', () => {
  it('defaults to the recorded provisional answers', () => {
    const env = load();
    expect(env.CONSTRUCTION_POLICY_FOUR_EYES).toBe(true);
    expect(env.ORGANIZATION_SERVICE_URL).toBe('http://localhost:3102');
    expect(env.CONSTRUCTION_ORGANIZATION_REQUEST_TIMEOUT_MS).toBe(3000);
    expect(env.CONSTRUCTION_APPROVAL_MIN_SUBMITTED_NEEDS).toBe(1);
    expect(env.CONSTRUCTION_APPROVAL_REQUIRES_ESTIMATE).toBe(true);
    expect(env.CONSTRUCTION_START_REQUIRES_CONTRACT).toBe(false);
    expect(env.CONSTRUCTION_PROGRESS_ALLOW_DECREASE).toBe(false);
  });

  it('accepts each as configuration', () => {
    const env = load({
      CONSTRUCTION_POLICY_FOUR_EYES: 'false',
      CONSTRUCTION_APPROVAL_MIN_SUBMITTED_NEEDS: '0',
      CONSTRUCTION_APPROVAL_REQUIRES_ESTIMATE: 'false',
      CONSTRUCTION_START_REQUIRES_CONTRACT: 'true',
      CONSTRUCTION_PROGRESS_ALLOW_DECREASE: 'on',
    });
    expect(env.CONSTRUCTION_POLICY_FOUR_EYES).toBe(false);
    expect(env.CONSTRUCTION_APPROVAL_MIN_SUBMITTED_NEEDS).toBe(0);
    expect(env.CONSTRUCTION_APPROVAL_REQUIRES_ESTIMATE).toBe(false);
    expect(env.CONSTRUCTION_START_REQUIRES_CONTRACT).toBe(true);
    expect(env.CONSTRUCTION_PROGRESS_ALLOW_DECREASE).toBe(true);
  });

  it('refuses an organization-service address that is not a URL, and an absurd timeout', () => {
    expect(() => load({ ORGANIZATION_SERVICE_URL: 'organization-service' })).toThrow();
    expect(() => load({ CONSTRUCTION_ORGANIZATION_REQUEST_TIMEOUT_MS: '0' })).toThrow();
  });

  it('refuses a negative need minimum', () => {
    expect(() => load({ CONSTRUCTION_APPROVAL_MIN_SUBMITTED_NEEDS: '-1' })).toThrow();
  });
});

describe('the tender key-encryption keys (ADR-066 § 2)', () => {
  const KEK = Buffer.alloc(32, 9).toString('base64');

  it('are unset by default: no tender can be published, and there is no default key', () => {
    const env = load();
    expect(env.CONSTRUCTION_TENDER_KEKS).toBeUndefined();
    expect(env.CONSTRUCTION_TENDER_KEK_CURRENT).toBeUndefined();
  });

  it('accept well-formed id:base64 pairs', () => {
    const env = load({
      CONSTRUCTION_TENDER_KEKS: `v1:${KEK}`,
      CONSTRUCTION_TENDER_KEK_CURRENT: 'v1',
    });
    expect(env.CONSTRUCTION_TENDER_KEKS).toBe(`v1:${KEK}`);
  });

  it('are judged together with the current id: a current that is not among the keys stops the boot', () => {
    // Codex review of #163: this used to pass startup and fail on the first publication.
    const secret = KEK;
    let message = '';
    try {
      load({ CONSTRUCTION_TENDER_KEKS: `v1:${secret}`, CONSTRUCTION_TENDER_KEK_CURRENT: 'v2' });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/CONSTRUCTION_TENDER_KEK_CURRENT/);
    expect(message).not.toContain(secret);

    // Keys with no current, and a current with no keys, are the same mistake.
    expect(() => load({ CONSTRUCTION_TENDER_KEKS: `v1:${KEK}` })).toThrow(
      /CONSTRUCTION_TENDER_KEK_CURRENT/,
    );
    expect(() => load({ CONSTRUCTION_TENDER_KEK_CURRENT: 'v1' })).toThrow(
      /CONSTRUCTION_TENDER_KEK_CURRENT/,
    );
    // And the good pairs still load, older ids kept for unwrapping.
    const other = Buffer.alloc(32, 4).toString('base64');
    expect(
      load({
        CONSTRUCTION_TENDER_KEKS: `v1:${KEK},v2:${other}`,
        CONSTRUCTION_TENDER_KEK_CURRENT: 'v2',
      }).CONSTRUCTION_TENDER_KEK_CURRENT,
    ).toBe('v2');
  });

  it('report a malformed entry once, at its own field, not again as a bad pair', () => {
    let message = '';
    try {
      load({ CONSTRUCTION_TENDER_KEKS: 'v1:short', CONSTRUCTION_TENDER_KEK_CURRENT: 'v1' });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/CONSTRUCTION_TENDER_KEKS/);
    expect(message).not.toMatch(/CONSTRUCTION_TENDER_KEK_CURRENT/);
  });

  it('stop the service at startup when malformed, without repeating the value', () => {
    const secret = Buffer.alloc(20, 3).toString('base64');
    let message = '';
    try {
      load({ CONSTRUCTION_TENDER_KEKS: `v1:${secret}` });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/CONSTRUCTION_TENDER_KEKS/);
    expect(message).not.toContain(secret);
    expect(() => load({ CONSTRUCTION_TENDER_KEK_CURRENT: 'V 1' })).toThrow(
      /CONSTRUCTION_TENDER_KEK_CURRENT/,
    );
  });
});

describe('the tender close sweeper (ADR-065 § 3)', () => {
  it('is bounded by default: a short interval, a small batch, a lease longer than a sweep', () => {
    const env = load();
    expect(env.CONSTRUCTION_TENDER_CLOSE_INTERVAL_MS).toBe(5000);
    expect(env.CONSTRUCTION_TENDER_CLOSE_BATCH_SIZE).toBe(20);
    expect(env.CONSTRUCTION_TENDER_CLOSE_LEASE_SECONDS).toBe(60);
    expect(env.CONSTRUCTION_TENDER_CLOSE_BACKOFF_BASE_SECONDS).toBe(10);
    expect(env.CONSTRUCTION_TENDER_CLOSE_BACKOFF_MAX_SECONDS).toBe(900);
  });

  it('may be tuned, and refuses a value that would spin or never end', () => {
    expect(
      load({ CONSTRUCTION_TENDER_CLOSE_BATCH_SIZE: '100' }).CONSTRUCTION_TENDER_CLOSE_BATCH_SIZE,
    ).toBe(100);
    expect(() => load({ CONSTRUCTION_TENDER_CLOSE_INTERVAL_MS: '10' })).toThrow();
    expect(() => load({ CONSTRUCTION_TENDER_CLOSE_BATCH_SIZE: '0' })).toThrow();
    expect(() => load({ CONSTRUCTION_TENDER_CLOSE_BATCH_SIZE: '100000' })).toThrow();
    expect(() => load({ CONSTRUCTION_TENDER_CLOSE_LEASE_SECONDS: '1' })).toThrow();
    expect(() => load({ CONSTRUCTION_TENDER_CLOSE_BACKOFF_BASE_SECONDS: '0' })).toThrow();
  });
});
