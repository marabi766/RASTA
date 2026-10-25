/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadWebServerEnv } from './env';
import { PROJECT_CREATE_MAX_REPLAY_WINDOW_SECONDS } from '@rasta/contracts';
import {
  MAX_BOOTABLE_CONSTRUCTION_RETENTION_HOURS,
  MAX_REPLAY_MARGIN_SECONDS,
  MIN_REPLAY_MARGIN_MS,
  projectCreateWindowFits,
  replayMarginCoversClockBudget,
} from './unresolved-request-policy';

/**
 * What the portal refuses to start without, and why each refusal is the
 * kinder option (ADR-059).
 */

const REQUIRED = {
  API_GATEWAY_URL: 'http://localhost:3000',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
};

/** The required set without one key, which is what every refusal test needs. */
function omitting(key: keyof typeof REQUIRED): Record<string, string> {
  const rest: Record<string, string> = { ...REQUIRED };
  delete rest[key];
  return rest;
}

describe('the portal refuses to start without a session key', () => {
  it('needs the key at all', () => {
    expect(() => loadWebServerEnv(omitting('WEB_SESSION_SECRET'))).toThrow(/WEB_SESSION_SECRET/);
  });

  it('refuses a short key', () => {
    // A key that is really a password somebody typed. The failure this
    // prevents is silent: the cookie is still "encrypted", just not by much.
    expect(() => loadWebServerEnv({ ...REQUIRED, WEB_SESSION_SECRET: 'short' })).toThrow();
  });

  it('never puts the key in the message it throws', () => {
    // The message reaches a log and a terminal. Names only.
    try {
      loadWebServerEnv({ ...REQUIRED, WEB_SESSION_SECRET: 'short-secret-value' });
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as Error).message).not.toContain('short-secret-value');
      expect((error as Error).message).toContain('WEB_SESSION_SECRET');
    }
  });
});

describe('the rest of the configuration', () => {
  it.each(['API_GATEWAY_URL', 'OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'WEB_PUBLIC_ORIGIN'] as const)(
    'requires %s',
    (key) => {
      expect(() => loadWebServerEnv(omitting(key))).toThrow(new RegExp(key));
    },
  );

  it('refuses a gateway address that is not a url', () => {
    expect(() => loadWebServerEnv({ ...REQUIRED, API_GATEWAY_URL: 'gateway:3000' })).toThrow();
  });

  // `fetch` refuses a URL with credentials on every call, repeating it whole
  // into the log; refused at boot instead, by name only (#385 r5).
  it.each(['API_GATEWAY_URL', 'OIDC_ISSUER_URL', 'WEB_PUBLIC_ORIGIN'] as const)(
    'refuses %s with a username or password, naming neither',
    (key) => {
      // Built from the two sentinels, not written as one literal URL.
      const [user, password] = ['private-sentinel-79', 'JZ97-another-secret'];
      for (const value of [
        `http://${user}:${password}@gateway:3000`,
        `http://${user}@gateway:3000`,
        `http://:${password}@gateway:3000`,
      ]) {
        let message = '';
        try {
          loadWebServerEnv({ ...REQUIRED, [key]: value });
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toContain(key);
        expect(message).not.toMatch(/sentinel|jz97|another-secret/i);
      }
    },
  );

  it('bounds the session lifetime rather than trusting the number', () => {
    expect(() => loadWebServerEnv({ ...REQUIRED, WEB_SESSION_MAX_AGE_SECONDS: '10' })).toThrow();
    expect(() =>
      loadWebServerEnv({ ...REQUIRED, WEB_SESSION_MAX_AGE_SECONDS: '99999999' }),
    ).toThrow();
    expect(loadWebServerEnv(REQUIRED).WEB_SESSION_MAX_AGE_SECONDS).toBe(12 * 60 * 60);
  });

  it('defaults the cookie to Secure', () => {
    // The unsafe direction has to be asked for, and the only reason it exists
    // is local development over plain HTTP.
    expect(loadWebServerEnv(REQUIRED).WEB_COOKIE_SECURE).toBe(true);
    expect(loadWebServerEnv({ ...REQUIRED, WEB_COOKIE_SECURE: 'false' }).WEB_COOKIE_SECURE).toBe(
      false,
    );
  });
});

describe('who is shown the Projects link', () => {
  it("defaults to construction-service's own defaults: ORGANIZATION_ADMIN writes, nobody else reads", () => {
    const env = loadWebServerEnv(REQUIRED);
    expect(env.WEB_PROJECT_ROLES).toEqual(['ORGANIZATION_ADMIN']);
    expect(env.WEB_PROJECT_READER_ROLES).toEqual([]);
  });

  it('reads comma lists, trimmed, with empty elements dropped', () => {
    const env = loadWebServerEnv({
      ...REQUIRED,
      WEB_PROJECT_ROLES: ' ORGANIZATION_ADMIN , FLEET_MANAGER,, ',
      WEB_PROJECT_READER_ROLES: 'DRIVER',
    });
    expect(env.WEB_PROJECT_ROLES).toEqual(['ORGANIZATION_ADMIN', 'FLEET_MANAGER']);
    expect(env.WEB_PROJECT_READER_ROLES).toEqual(['DRIVER']);
  });

  it.each(['WEB_PROJECT_ROLES', 'WEB_PROJECT_READER_ROLES'])(
    'refuses to start when %s names AUDITOR, as the service does',
    (key) => {
      expect(() => loadWebServerEnv({ ...REQUIRED, [key]: 'ORGANIZATION_ADMIN,AUDITOR' })).toThrow(
        new RegExp(key),
      );
    },
  );
});

describe('who is shown the Inventory link', () => {
  it("defaults to inventory-service's own defaults: ORGANIZATION_ADMIN operates and reads", () => {
    const env = loadWebServerEnv(REQUIRED);
    expect(env.WEB_INVENTORY_ROLES).toEqual(['ORGANIZATION_ADMIN']);
    expect(env.WEB_INVENTORY_READER_ROLES).toEqual(['ORGANIZATION_ADMIN']);
  });

  it('reads comma lists, trimmed, with empty elements dropped', () => {
    const env = loadWebServerEnv({
      ...REQUIRED,
      WEB_INVENTORY_ROLES: ' ORGANIZATION_ADMIN , FLEET_MANAGER,, ',
      WEB_INVENTORY_READER_ROLES: 'DRIVER',
    });
    expect(env.WEB_INVENTORY_ROLES).toEqual(['ORGANIZATION_ADMIN', 'FLEET_MANAGER']);
    expect(env.WEB_INVENTORY_READER_ROLES).toEqual(['DRIVER']);
  });

  it.each(['WEB_INVENTORY_ROLES', 'WEB_INVENTORY_READER_ROLES'])(
    'refuses to start when %s names AUDITOR or SYSTEM_ADMIN, as the service does',
    (key) => {
      for (const refused of ['AUDITOR', 'SYSTEM_ADMIN']) {
        expect(() =>
          loadWebServerEnv({ ...REQUIRED, [key]: `ORGANIZATION_ADMIN,${refused}` }),
        ).toThrow(new RegExp(key));
      }
    },
  );
});

describe('who is shown the Contracts link', () => {
  it("defaults to contract-service's own default: ORGANIZATION_ADMIN reads", () => {
    const env = loadWebServerEnv(REQUIRED);
    expect(env.WEB_CONTRACT_READER_ROLES).toEqual(['ORGANIZATION_ADMIN']);
  });

  it('reads comma lists, trimmed, with empty elements dropped', () => {
    const env = loadWebServerEnv({
      ...REQUIRED,
      WEB_CONTRACT_READER_ROLES: ' ORGANIZATION_ADMIN , FLEET_MANAGER,, ',
    });
    expect(env.WEB_CONTRACT_READER_ROLES).toEqual(['ORGANIZATION_ADMIN', 'FLEET_MANAGER']);
  });

  it('refuses to start when it names AUDITOR, as the service does', () => {
    expect(() =>
      loadWebServerEnv({ ...REQUIRED, WEB_CONTRACT_READER_ROLES: 'ORGANIZATION_ADMIN,AUDITOR' }),
    ).toThrow(/WEB_CONTRACT_READER_ROLES/);
  });
});

describe('the return replay deadline (EXP-003 returns)', () => {
  it('defaults to marketplace-service’s floor, not its default, less ten minutes', () => {
    const env = loadWebServerEnv(REQUIRED);
    expect(env.WEB_MARKETPLACE_IDEMPOTENCY_TTL_HOURS).toBe(1);
    expect(env.WEB_RETURN_REPLAY_MARGIN_SECONDS).toBe(600);
  });

  it('mirrors the service’s bounds for the retention (1..168 hours)', () => {
    for (const value of ['0', '169', 'soon']) {
      expect(() =>
        loadWebServerEnv({ ...REQUIRED, WEB_MARKETPLACE_IDEMPOTENCY_TTL_HOURS: value }),
      ).toThrow('WEB_MARKETPLACE_IDEMPOTENCY_TTL_HOURS');
    }
    expect(
      loadWebServerEnv({ ...REQUIRED, WEB_MARKETPLACE_IDEMPOTENCY_TTL_HOURS: '24' })
        .WEB_MARKETPLACE_IDEMPOTENCY_TTL_HOURS,
    ).toBe(24);
  });

  it('bounds the margin so the window is never shorter than half an hour', () => {
    for (const value of ['59', '1801']) {
      expect(() =>
        loadWebServerEnv({ ...REQUIRED, WEB_RETURN_REPLAY_MARGIN_SECONDS: value }),
      ).toThrow('WEB_RETURN_REPLAY_MARGIN_SECONDS');
    }
  });
});

describe('who is drawn the contract command forms, and with which reasons', () => {
  it("defaults to contract-service's own defaults", () => {
    const env = loadWebServerEnv(REQUIRED);
    expect(env.WEB_CONTRACT_CANCEL_ROLES).toEqual(['ORGANIZATION_ADMIN']);
    expect(env.WEB_CONTRACT_AMENDMENT_ROLES).toEqual(['ORGANIZATION_ADMIN']);
    expect(env.WEB_CONTRACT_MILESTONE_ROLES).toEqual(['ORGANIZATION_ADMIN']);
    expect(env.WEB_CONTRACT_CANCEL_AFTER_SIGNATURE).toBe(false);
    expect(env.WEB_CONTRACT_CANCEL_REASON_CODES).toEqual([
      'TERMS_NOT_AGREED',
      'CONTRACTOR_WITHDREW',
      'AWARD_ERROR',
      'OTHER',
    ]);
    expect(env.WEB_CONTRACT_AMENDMENT_REASON_CODES).toEqual([
      'SCOPE_CHANGE',
      'PRICE_ADJUSTMENT',
      'SCHEDULE_CHANGE',
      'OTHER',
    ]);
  });

  it('an empty role list means nobody, as there; AUDITOR refuses to start', () => {
    expect(
      loadWebServerEnv({ ...REQUIRED, WEB_CONTRACT_CANCEL_ROLES: '' }).WEB_CONTRACT_CANCEL_ROLES,
    ).toEqual([]);
    expect(() =>
      loadWebServerEnv({ ...REQUIRED, WEB_CONTRACT_MILESTONE_ROLES: 'AUDITOR' }),
    ).toThrow(/WEB_CONTRACT_MILESTONE_ROLES/);
  });

  it('a reason list is closed codes, at least one, none twice', () => {
    expect(
      loadWebServerEnv({ ...REQUIRED, WEB_CONTRACT_CANCEL_REASON_CODES: ' OTHER , CLIENT_CODE ' })
        .WEB_CONTRACT_CANCEL_REASON_CODES,
    ).toEqual(['OTHER', 'CLIENT_CODE']);
    for (const refused of ['', 'lower_case', 'OTHER,OTHER']) {
      expect(() =>
        loadWebServerEnv({ ...REQUIRED, WEB_CONTRACT_AMENDMENT_REASON_CODES: refused }),
      ).toThrow(/WEB_CONTRACT_AMENDMENT_REASON_CODES/);
    }
  });
});

describe('the dispute replay deadline (PR 319 review 2, finding 2)', () => {
  it('defaults to economic-service’s floor, not its default, less ten minutes', () => {
    const env = loadWebServerEnv(REQUIRED);
    expect(env.WEB_ECONOMIC_IDEMPOTENCY_TTL_HOURS).toBe(1);
    expect(env.WEB_DISPUTE_REPLAY_MARGIN_SECONDS).toBe(600);
  });

  it('mirrors the service’s bounds for the retention (1..168 hours)', () => {
    for (const value of ['0', '169', 'soon']) {
      expect(() =>
        loadWebServerEnv({ ...REQUIRED, WEB_ECONOMIC_IDEMPOTENCY_TTL_HOURS: value }),
      ).toThrow('WEB_ECONOMIC_IDEMPOTENCY_TTL_HOURS');
    }
    expect(
      loadWebServerEnv({ ...REQUIRED, WEB_ECONOMIC_IDEMPOTENCY_TTL_HOURS: '24' })
        .WEB_ECONOMIC_IDEMPOTENCY_TTL_HOURS,
    ).toBe(24);
  });

  it('bounds the margin so the window is never shorter than half an hour', () => {
    for (const value of ['59', '1801']) {
      expect(() =>
        loadWebServerEnv({ ...REQUIRED, WEB_DISPUTE_REPLAY_MARGIN_SECONDS: value }),
      ).toThrow('WEB_DISPUTE_REPLAY_MARGIN_SECONDS');
    }
  });
});

describe('refresh coordination in production (ADR-059 addendum)', () => {
  it('refuses to start in production without WEB_REDIS_URL', () => {
    // Two replicas are the documented topology; without shared coordination
    // they race for every refresh token.
    expect(() => loadWebServerEnv({ ...REQUIRED, NODE_ENV: 'production' })).toThrow(
      /WEB_REDIS_URL/,
    );
  });

  it('names every missing key at once, WEB_REDIS_URL among them', () => {
    expect(() =>
      loadWebServerEnv({ ...omitting('OIDC_CLIENT_ID'), NODE_ENV: 'production' }),
    ).toThrow(/OIDC_CLIENT_ID, WEB_REDIS_URL/);
  });

  it('starts in production with it', () => {
    const env = loadWebServerEnv({
      ...REQUIRED,
      NODE_ENV: 'production',
      WEB_REDIS_URL: 'redis://redis:6379',
    });
    expect(env.WEB_REDIS_URL).toBe('redis://redis:6379');
  });

  it.each(['development', 'test', undefined])('leaves it optional when NODE_ENV is %s', (mode) => {
    expect(() =>
      loadWebServerEnv({ ...REQUIRED, ...(mode ? { NODE_ENV: mode } : {}) }),
    ).not.toThrow();
  });

  it('refuses a Redis address that is not a redis URL', () => {
    expect(() => loadWebServerEnv({ ...REQUIRED, WEB_REDIS_URL: 'http://redis:6379' })).toThrow(
      /WEB_REDIS_URL/,
    );
  });
});

describe('nothing secret reaches the browser bundle', () => {
  it('declares no NEXT_PUBLIC_ variable', () => {
    // Next.js decides what ships to the browser by exactly that prefix, and
    // `docs/16 § ۱۶٫۱۱` forbids a secret behind it. Asserted against the file
    // rather than the parsed object, because the risk is somebody *adding* one.
    const source = readFileSync(join(__dirname, 'env.ts'), 'utf8');
    // A declaration or a read, not the prose above them — the comment in
    // `env.ts` names the prefix precisely so a reader knows why it is absent.
    expect(source).not.toMatch(/^\s*NEXT_PUBLIC_[A-Z0-9_]+\s*:/m);
    expect(source).not.toMatch(/process\.env\.NEXT_PUBLIC_/);
  });

  it('keeps every key out of anything a page could serialise', () => {
    const env = loadWebServerEnv(REQUIRED);
    for (const key of Object.keys(env)) {
      expect(key).not.toMatch(/^NEXT_PUBLIC_/);
    }
  });
});

describe('the statement replay deadline', () => {
  it('defaults to contract-service’s floor, not its default, less ten minutes', () => {
    const env = loadWebServerEnv(REQUIRED);
    expect(env.WEB_CONTRACT_IDEMPOTENCY_TTL_HOURS).toBe(1);
    expect(env.WEB_CONTRACT_REPLAY_MARGIN_SECONDS).toBe(600);
  });

  it('mirrors the service’s bounds for the retention (1..168 hours)', () => {
    for (const value of ['0', '169', 'soon']) {
      expect(() =>
        loadWebServerEnv({ ...REQUIRED, WEB_CONTRACT_IDEMPOTENCY_TTL_HOURS: value }),
      ).toThrow('WEB_CONTRACT_IDEMPOTENCY_TTL_HOURS');
    }
    expect(
      loadWebServerEnv({ ...REQUIRED, WEB_CONTRACT_IDEMPOTENCY_TTL_HOURS: '24' })
        .WEB_CONTRACT_IDEMPOTENCY_TTL_HOURS,
    ).toBe(24);
  });

  it('bounds the margin so the window is never shorter than half an hour', () => {
    for (const value of ['59', '1801']) {
      expect(() =>
        loadWebServerEnv({ ...REQUIRED, WEB_CONTRACT_REPLAY_MARGIN_SECONDS: value }),
      ).toThrow('WEB_CONTRACT_REPLAY_MARGIN_SECONDS');
    }
  });
});

describe('the bid replay deadline', () => {
  it('defaults to construction-service’s floor, not its default, less ten minutes', () => {
    const env = loadWebServerEnv(REQUIRED);
    expect(env.WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS).toBe(1);
    expect(env.WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS).toBe(600);
  });

  it('bounds the retention by what can boot (1 hour: derived from the 3 300 s limit) and bounds the margin', () => {
    expect(MAX_BOOTABLE_CONSTRUCTION_RETENTION_HOURS).toBe(1);
    // No margin the schema allows lets 2 hours boot: 7 200 − 1 800 + 30 > 3 300. The schema says so itself.
    for (const value of ['0', '2', '168', '169', 'soon']) {
      expect(() =>
        loadWebServerEnv({ ...REQUIRED, WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS: value }),
      ).toThrow('WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS');
    }
    for (const value of ['59', '1801']) {
      expect(() =>
        loadWebServerEnv({ ...REQUIRED, WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS: value }),
      ).toThrow('WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS');
    }
  });

  // The window must fit what construction-service accepts (D-067): window + 30 s portal skew allowance
  // ≤ PROJECT_CREATE_MAX_REPLAY_WINDOW_SECONDS (3 300 s). With a 1 h retention the margin is ≥ 330 s.
  it('refuses to start when the project-create window exceeds the shared maximum (boundary: = passes, +1 s refuses)', () => {
    const at = (ttl: string, margin: string) =>
      loadWebServerEnv({
        ...REQUIRED,
        WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS: ttl,
        WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS: margin,
      });
    // 3600 − 330 = 3270; + 30 s = 3300 = K.
    expect(at('1', '330').WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS).toBe(330);
    expect(() => at('1', '329')).toThrow('WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS');
    // Beyond the schema's derived maximum: refused by the schema, and projectCreateWindowFits agrees
    // for every margin the schema allows.
    expect(() => at('168', '1800')).toThrow('WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS');
    expect(() => at('2', '1800')).toThrow('WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS');
    for (let margin = 60; margin <= MAX_REPLAY_MARGIN_SECONDS; margin += 1) {
      expect(projectCreateWindowFits(MAX_BOOTABLE_CONSTRUCTION_RETENTION_HOURS + 1, margin)).toBe(
        false,
      );
    }
    expect(projectCreateWindowFits(MAX_BOOTABLE_CONSTRUCTION_RETENTION_HOURS, 330)).toBe(true);
    // The defaults fit with room: 3 000 s window + 30 s = 3 030 s, slack 270 s.
    const defaults = loadWebServerEnv(REQUIRED);
    const window =
      defaults.WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS * 3600 -
      defaults.WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS;
    expect(window).toBe(3000);
    expect(PROJECT_CREATE_MAX_REPLAY_WINDOW_SECONDS - (window + 30)).toBe(270);
  });

  it('the shared maximum is the number the service tests against (one constant, packages/contracts)', () => {
    expect(PROJECT_CREATE_MAX_REPLAY_WINDOW_SECONDS).toBe(3300);
    expect(projectCreateWindowFits(1, 330)).toBe(true);
    expect(projectCreateWindowFits(1, 329)).toBe(false);
  });

  // The clock budget (unresolved-request-policy.ts): margin ≥ 2 × skew + one request,
  // i.e. 2 × 30 s + 15 s = 75 s. Below it the portal does not start (fail closed).
  it('refuses to start when the margin does not cover two clock skews and a request', () => {
    expect(MIN_REPLAY_MARGIN_MS).toBe(75_000);
    for (const value of ['60', '74']) {
      expect(() =>
        loadWebServerEnv({ ...REQUIRED, WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS: value }),
      ).toThrow('WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS');
    }
    // 75 s covers the clock budget, but with the 1 h retention the window would exceed the shared
    // maximum (margin ≥ 330 s, D-067): it is the other check that refuses it.
    expect(replayMarginCoversClockBudget(75)).toBe(true);
    expect(() =>
      loadWebServerEnv({ ...REQUIRED, WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS: '75' }),
    ).toThrow('WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS');
    for (const value of ['330', '600']) {
      expect(
        loadWebServerEnv({ ...REQUIRED, WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS: value })
          .WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS,
      ).toBe(Number(value));
    }
  });
});

describe('the tender opening roles', () => {
  it('default to none — the owner’s own role set — and refuse what never opens a bid', () => {
    expect(loadWebServerEnv(REQUIRED).WEB_TENDER_OPEN_ROLES).toEqual([]);
    expect(
      loadWebServerEnv({ ...REQUIRED, WEB_TENDER_OPEN_ROLES: 'FLEET_MANAGER, ORGANIZATION_ADMIN' })
        .WEB_TENDER_OPEN_ROLES,
    ).toEqual(['FLEET_MANAGER', 'ORGANIZATION_ADMIN']);
    for (const value of ['SYSTEM_ADMIN', 'CONTRACTOR', 'AUDITOR']) {
      expect(() => loadWebServerEnv({ ...REQUIRED, WEB_TENDER_OPEN_ROLES: value })).toThrow(
        'WEB_TENDER_OPEN_ROLES',
      );
    }
  });
});

describe('the evaluation and award roles, and the conflict rules', () => {
  it('evaluating and awarding default to the owner’s own role set, and refuse what never reads a bid', () => {
    for (const name of ['WEB_TENDER_EVALUATE_ROLES', 'WEB_TENDER_AWARD_ROLES'] as const) {
      expect(loadWebServerEnv(REQUIRED)[name]).toEqual([]);
      expect(loadWebServerEnv({ ...REQUIRED, [name]: 'FLEET_MANAGER' })[name]).toEqual([
        'FLEET_MANAGER',
      ]);
      for (const value of ['SYSTEM_ADMIN', 'CONTRACTOR', 'AUDITOR']) {
        expect(() => loadWebServerEnv({ ...REQUIRED, [name]: value })).toThrow(name);
      }
    }
  });

  it('the conflict rules default to AWARDER_NOT_EVALUATOR, switch off when empty, and stop the portal on an unknown one', () => {
    expect(loadWebServerEnv(REQUIRED).WEB_TENDER_COI_RULES).toEqual(['AWARDER_NOT_EVALUATOR']);
    expect(
      loadWebServerEnv({ ...REQUIRED, WEB_TENDER_COI_RULES: '' }).WEB_TENDER_COI_RULES,
    ).toEqual([]);
    expect(
      loadWebServerEnv({
        ...REQUIRED,
        WEB_TENDER_COI_RULES: 'AWARDER_NOT_EVALUATOR, EVALUATOR_NOT_TENDER_AUTHOR',
      }).WEB_TENDER_COI_RULES,
    ).toEqual(['AWARDER_NOT_EVALUATOR', 'EVALUATOR_NOT_TENDER_AUTHOR']);
    expect(() => loadWebServerEnv({ ...REQUIRED, WEB_TENDER_COI_RULES: 'MADE_UP' })).toThrow();
  });
});
