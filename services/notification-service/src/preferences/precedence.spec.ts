import {
  PREFERENCE_LAYERS,
  isOverridable,
  resolvePreference,
  type ChannelDefaults,
  type PreferenceRow,
  type RuleFacts,
} from './precedence';

/**
 * The preference ladder of ADR-054 § 5, exercised rung by rung.
 *
 * This is the one piece of NTF-003 that decides whether a person is told
 * something, so it is a pure function and it is tested exhaustively rather than
 * through the API. A precedence bug does not throw and does not fail a request:
 * it silently delivers something somebody turned off, or silently withholds
 * something they asked for, and either way the first report of it is a user
 * saying the settings page is lying.
 */

const ROUTINE: RuleFacts = {
  ruleKey: 'insurance.expiring',
  category: 'EXPIRY',
  classification: 'ROUTINE',
  severity: 'WARNING',
  mandatoryChannels: [],
};

const MANDATORY: RuleFacts = {
  ruleKey: 'membership.revoked',
  category: 'ACCOUNT' as RuleFacts['category'],
  classification: 'MANDATORY',
  severity: 'CRITICAL',
  mandatoryChannels: ['IN_APP'],
};

/** ADR-054 § 5: `IN_APP` on; `EMAIL` on for WARNING and CRITICAL, off for INFO. */
const defaults: ChannelDefaults = (channel, severity) =>
  channel === 'IN_APP' ? true : severity !== 'INFO';

const row = (
  scope: PreferenceRow['scope'],
  scopeKey: string | null,
  enabled: boolean,
): PreferenceRow => ({ scope, scopeKey, channel: 'IN_APP', enabled });

describe('the ladder order', () => {
  it('is the order the ADR writes, narrowest first', () => {
    expect([...PREFERENCE_LAYERS]).toEqual([
      'MANDATORY_POLICY',
      'RULE',
      'CATEGORY',
      'GLOBAL',
      'CHANNEL_DEFAULT',
    ]);
  });
});

describe('with nothing stored', () => {
  it('falls to the channel default and says so', () => {
    expect(resolvePreference([], ROUTINE, 'IN_APP', defaults)).toEqual({
      enabled: true,
      layer: 'CHANNEL_DEFAULT',
      suppressionReason: null,
    });
  });

  // The default is a function of severity, not a constant, because that is what
  // the email half of the rule will need unchanged.
  it('reads the default as a function of severity', () => {
    const emailish: ChannelDefaults = (_channel, severity) => severity !== 'INFO';
    expect(
      resolvePreference([], { ...ROUTINE, severity: 'INFO' }, 'IN_APP', emailish).enabled,
    ).toBe(false);
    expect(
      resolvePreference([], { ...ROUTINE, severity: 'CRITICAL' }, 'IN_APP', emailish).enabled,
    ).toBe(true);
  });
});

describe('one rung at a time', () => {
  it('lets a GLOBAL row beat the default', () => {
    const decision = resolvePreference([row('GLOBAL', null, false)], ROUTINE, 'IN_APP', defaults);
    expect(decision).toEqual({
      enabled: false,
      layer: 'GLOBAL',
      suppressionReason: 'PREFERENCE_OPT_OUT',
    });
  });

  it('lets a CATEGORY row beat GLOBAL', () => {
    const decision = resolvePreference(
      [row('GLOBAL', null, false), row('CATEGORY', 'EXPIRY', true)],
      ROUTINE,
      'IN_APP',
      defaults,
    );
    expect(decision).toEqual({ enabled: true, layer: 'CATEGORY', suppressionReason: null });
  });

  it('lets a RULE row beat CATEGORY', () => {
    const decision = resolvePreference(
      [
        row('GLOBAL', null, true),
        row('CATEGORY', 'EXPIRY', true),
        row('RULE', 'insurance.expiring', false),
      ],
      ROUTINE,
      'IN_APP',
      defaults,
    );
    expect(decision).toEqual({
      enabled: false,
      layer: 'RULE',
      suppressionReason: 'PREFERENCE_OPT_OUT',
    });
  });

  // The narrowest rung wins in both directions. A ladder that only ever
  // narrowed towards "off" would be a mute switch, not a preference system.
  it('lets a narrow yes beat a broad no, and a narrow no beat a broad yes', () => {
    const on = resolvePreference(
      [row('GLOBAL', null, false), row('RULE', 'insurance.expiring', true)],
      ROUTINE,
      'IN_APP',
      defaults,
    );
    expect(on).toMatchObject({ enabled: true, layer: 'RULE' });

    const off = resolvePreference(
      [row('GLOBAL', null, true), row('RULE', 'insurance.expiring', false)],
      ROUTINE,
      'IN_APP',
      defaults,
    );
    expect(off).toMatchObject({ enabled: false, layer: 'RULE' });
  });
});

describe('rows that do not apply', () => {
  it('ignores a RULE row for another rule', () => {
    const decision = resolvePreference(
      [row('RULE', 'maintenance.due', false)],
      ROUTINE,
      'IN_APP',
      defaults,
    );
    expect(decision).toMatchObject({ enabled: true, layer: 'CHANNEL_DEFAULT' });
  });

  it('ignores a CATEGORY row for another category', () => {
    const decision = resolvePreference(
      [row('CATEGORY', 'MAINTENANCE', false)],
      ROUTINE,
      'IN_APP',
      defaults,
    );
    expect(decision).toMatchObject({ enabled: true, layer: 'CHANNEL_DEFAULT' });
  });

  it('ignores a row for another channel', () => {
    const otherChannel = { ...row('RULE', 'insurance.expiring', false), channel: 'EMAIL' };
    const decision = resolvePreference(
      [otherChannel as unknown as PreferenceRow],
      ROUTINE,
      'IN_APP',
      defaults,
    );
    expect(decision).toMatchObject({ enabled: true, layer: 'CHANNEL_DEFAULT' });
  });
});

describe('the mandatory policy', () => {
  // Layer 1. This is the answer to Q-38 made mechanical.
  it('delivers whatever the person stored, on the channels the policy names', () => {
    const decision = resolvePreference(
      [row('GLOBAL', null, false), row('RULE', 'membership.revoked', false)],
      MANDATORY,
      'IN_APP',
      defaults,
    );
    expect(decision).toEqual({ enabled: true, layer: 'MANDATORY_POLICY', suppressionReason: null });
  });

  // It bypasses the ladder for the named channels and no others. A mandatory
  // rule is not a licence to ignore every preference a person holds.
  it('leaves a channel the policy does not name under preference control', () => {
    const emailOnlyMandatory: RuleFacts = { ...MANDATORY, mandatoryChannels: [] };
    const decision = resolvePreference(
      [row('GLOBAL', null, false)],
      emailOnlyMandatory,
      'IN_APP',
      defaults,
    );
    expect(decision).toMatchObject({ enabled: false, layer: 'GLOBAL' });
  });

  it('does not apply to a ROUTINE rule that happens to list channels', () => {
    const odd: RuleFacts = { ...ROUTINE, mandatoryChannels: ['IN_APP'] };
    const decision = resolvePreference([row('GLOBAL', null, false)], odd, 'IN_APP', defaults);
    expect(decision).toMatchObject({ enabled: false, layer: 'GLOBAL' });
  });
});

describe('what a person is allowed to change', () => {
  // The API refuses rather than storing a row the ladder will then ignore.
  // Q-07's precedent: a control that shows "off" while the notification still
  // arrives is worse than a refusal, because the person believes they acted.
  it('refuses the channels a mandatory rule names', () => {
    expect(isOverridable(MANDATORY, 'IN_APP')).toBe(false);
  });

  it('allows everything else', () => {
    expect(isOverridable(ROUTINE, 'IN_APP')).toBe(true);
    expect(isOverridable({ ...MANDATORY, mandatoryChannels: [] }, 'IN_APP')).toBe(true);
  });
});

describe('the suppression reason', () => {
  // It is written to notification_delivery.suppression_reason, a VARCHAR(64)
  // that must never carry free text.
  it('is set exactly when the decision is no', () => {
    const yes = resolvePreference([row('GLOBAL', null, true)], ROUTINE, 'IN_APP', defaults);
    const no = resolvePreference([row('GLOBAL', null, false)], ROUTINE, 'IN_APP', defaults);
    expect(yes.suppressionReason).toBeNull();
    expect(no.suppressionReason).toBe('PREFERENCE_OPT_OUT');
  });
});
