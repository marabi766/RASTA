import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import { INSURANCE_EXPIRING_RULE, type NotificationRule } from '../rules/rules';
import { PreferencesService } from './preferences.service';
import type { PreferencesRepository } from './preferences.repository';

/**
 * The refusal that answers Q-38, exercised at the layer that performs it.
 *
 * `precedence.spec.ts` proves `isOverridable` says *no* for a mandatory
 * channel. That is a different claim from the one this file makes: that the
 * service turns that *no* into `422 BUSINESS_RULE_VIOLATION` **and writes
 * nothing**. A version that computed the refusal correctly and then stored the
 * row anyway would pass every test in `precedence.spec.ts`, and the person who
 * set the preference would be told it was rejected while the database said
 * otherwise.
 *
 * ## Why this is a unit test and not an integration one
 *
 * **No rule the platform ships today is `MANDATORY`** — all three are
 * `ROUTINE` — so no HTTP request against the real service can reach this
 * branch, and `preferences-api.int-spec.ts` therefore cannot cover it. Q-38's
 * recorded answer is what makes that acceptable: it says the answer must be
 * changeable "بدون Migration، بدون تغییر دامنه", which is why
 * `mandatoryChannels` is a per-rule field rather than a constant. This suite
 * stands in for the first rule that sets it — the day account suspension or
 * membership revocation ships, the code below is already proven.
 *
 * The rule fixture is a copy of a real rule with its classification changed. It
 * is a test double for a rule shape, not a claim that such a notification
 * exists: inventing one would be inventing business fact, which AGENTS.md
 * forbids and which this service has no authority to do.
 */

const MANDATORY_RULE: NotificationRule = {
  ...INSURANCE_EXPIRING_RULE,
  ruleKey: 'test.mandatory',
  classification: 'MANDATORY',
  mandatoryChannels: ['IN_APP'],
};

jest.mock('../rules/rules', () => {
  const actual = jest.requireActual('../rules/rules');
  const extra = new Map<string, unknown>();
  return {
    ...actual,
    __extraRules: extra,
    ruleForKey: (ruleKey: string) => extra.get(ruleKey) ?? actual.ruleForKey(ruleKey),
  };
});

const { __extraRules: extraRules } = jest.requireMock('../rules/rules') as {
  __extraRules: Map<string, NotificationRule>;
};

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    correlationId: 'COR',
    requestId: 'REQ',
    roles: [],
    organizationIds: ['ORG_A'],
    authType: 'USER',
    startedAt: 0,
    userId: 'USR_1',
    organizationId: 'ORG_A',
    ...overrides,
  };
}

describe('PreferencesService — the refusal that answers Q-38', () => {
  let repository: { listOwn: jest.Mock; replaceOwn: jest.Mock };
  let service: PreferencesService;

  beforeEach(() => {
    extraRules.set(MANDATORY_RULE.ruleKey, MANDATORY_RULE);
    repository = { listOwn: jest.fn().mockResolvedValue([]), replaceOwn: jest.fn() };
    service = new PreferencesService(repository as unknown as PreferencesRepository);
  });

  afterEach(() => {
    extraRules.clear();
  });

  const replace = async (preferences: Parameters<PreferencesService['replaceOwn']>[0]) =>
    runWithContext(context(), () => service.replaceOwn(preferences));

  it('refuses to turn off a mandatory channel with 422, not a silent acceptance', async () => {
    await expect(
      replace([
        { scope: 'RULE', scopeKey: MANDATORY_RULE.ruleKey, channel: 'IN_APP', enabled: false },
      ]),
    ).rejects.toBeInstanceOf(RastaError);

    try {
      await replace([
        { scope: 'RULE', scopeKey: MANDATORY_RULE.ruleKey, channel: 'IN_APP', enabled: false },
      ]);
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as RastaError).code).toBe('BUSINESS_RULE_VIOLATION');
      expect((error as RastaError).status).toBe(422);
    }
  });

  it('writes nothing at all when one entry in the body is refused', async () => {
    await expect(
      replace([
        { scope: 'GLOBAL', scopeKey: null, channel: 'IN_APP', enabled: false },
        { scope: 'RULE', scopeKey: MANDATORY_RULE.ruleKey, channel: 'IN_APP', enabled: false },
      ]),
    ).rejects.toBeInstanceOf(RastaError);

    // The valid first entry must not have landed: a half-applied `PUT` leaves a
    // settings screen that disagrees with what the person submitted.
    expect(repository.replaceOwn).not.toHaveBeenCalled();
  });

  it('allows turning a mandatory channel back on — only the opt-out is refused', async () => {
    await replace([
      { scope: 'RULE', scopeKey: MANDATORY_RULE.ruleKey, channel: 'IN_APP', enabled: true },
    ]);

    expect(repository.replaceOwn).toHaveBeenCalledTimes(1);
  });

  it('allows a broad opt-out that a mandatory rule sits under', async () => {
    // Deliberate, and documented on `assertMayDisable`: a `CATEGORY` or
    // `GLOBAL` row covers rules that do not exist yet, and the ladder already
    // lets the platform policy win over it for the individual rules that need
    // it. Refusing the broad preference would take away a reasonable choice to
    // protect a narrow case the resolver protects anyway.
    await replace([
      { scope: 'CATEGORY', scopeKey: MANDATORY_RULE.category, channel: 'IN_APP', enabled: false },
    ]);

    expect(repository.replaceOwn).toHaveBeenCalledTimes(1);
  });

  it('is a 404, not a 422, for a rule key that names nothing', async () => {
    try {
      await replace([
        { scope: 'RULE', scopeKey: 'no.such.rule', channel: 'IN_APP', enabled: false },
      ]);
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as RastaError).code).toBe('NOT_FOUND');
    }
    expect(repository.replaceOwn).not.toHaveBeenCalled();
  });
});
