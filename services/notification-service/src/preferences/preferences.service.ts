import { Injectable } from '@nestjs/common';
import { RastaError } from '@rasta/nest-common';
import { resolveActor } from '../access/access';
import { ruleForKey } from '../rules/rules';
import { CHANNEL_DEFAULTS } from './defaults';
import { isOverridable, resolvePreference, type Channel } from './precedence';
import { PreferencesRepository } from './preferences.repository';
import {
  clockToMinutes,
  minutesToClock,
  type EffectiveQuery,
  type PreferenceInput,
  type QuietHoursDto,
} from './preferences.dto';

/**
 * The preference API (ADR-054 § 5, NTF-003).
 *
 * Self-only, like the rest of this service's HTTP surface: the actor comes from
 * the verified token and no endpoint here can name a user or a tenant.
 *
 * ## The refusal is the interesting part
 *
 * Trying to turn off a channel that a `MANDATORY` rule delivers on is answered
 * `422 BUSINESS_RULE_VIOLATION`, not stored and quietly ignored. ADR-054 § 5
 * names the precedent, Q-07: *«یک قاعده که وجود دارد، `ACTIVE` است و کاری
 * نمی‌کند، کنترلی را ادعا می‌کند که ندارد.»* A settings screen showing "off"
 * while the notification still arrives is exactly that, and it is worse than a
 * refusal because the person believes they have acted.
 *
 * ## Why `effective` returns the winning layer
 *
 * Because a preference system nobody can inspect is a preference system nobody
 * believes. Somebody who turned something off and still receives it has to be
 * able to see whether their rule-level choice lost to a platform policy or
 * whether they never had one.
 */
export interface EffectivePreferenceView {
  readonly ruleKey: string;
  readonly channel: Channel;
  readonly enabled: boolean;
  /** Which rung decided: `MANDATORY_POLICY`, `RULE`, `CATEGORY`, `GLOBAL` or `CHANNEL_DEFAULT`. */
  readonly decidedBy: string;
  /** Whether the caller is allowed to change this at all. */
  readonly overridable: boolean;
}

export interface QuietHoursView {
  readonly quietHours: QuietHoursDto | null;
}

export interface PreferenceView {
  readonly scope: string;
  readonly scopeKey: string | null;
  readonly channel: Channel;
  readonly enabled: boolean;
}

@Injectable()
export class PreferencesService {
  constructor(private readonly repository: PreferencesRepository) {}

  /**
   * The caller's quiet window (NTF-004).
   *
   * Returned as `HH:MM` in the zone it was set in, which is how it was given.
   * Converting to the reader's zone would answer a question nobody asked and
   * make "the window I set" and "the window I see" two different strings.
   */
  async quietHours(): Promise<QuietHoursView> {
    const row = await this.repository.quietHours(resolveActor());
    return {
      quietHours: row
        ? {
            start: minutesToClock(row.startMinute),
            end: minutesToClock(row.endMinute),
            timezone: row.timezone,
          }
        : null,
    };
  }

  /**
   * Sets or clears it.
   *
   * No refusal here of the kind `replaceOwn` has, and that asymmetry is
   * deliberate: a quiet window never silences anything. It defers, and a
   * `CRITICAL` notification ignores it altogether, so there is no mandatory
   * policy for it to collide with.
   */
  async replaceQuietHours(window: QuietHoursDto | null): Promise<QuietHoursView> {
    const actor = resolveActor();
    await this.repository.replaceQuietHours(
      actor,
      window
        ? {
            startMinute: clockToMinutes(window.start),
            endMinute: clockToMinutes(window.end),
            timezone: window.timezone,
          }
        : null,
    );
    return { quietHours: window };
  }

  async listOwn(): Promise<{ preferences: PreferenceView[] }> {
    const actor = resolveActor();
    const rows = await this.repository.listOwn(actor);
    return {
      preferences: rows.map((row) => ({
        scope: row.scope,
        scopeKey: row.scopeKey,
        channel: row.channel,
        enabled: row.enabled,
      })),
    };
  }

  /**
   * Replaces the caller's preferences, after refusing any the platform does
   * not allow.
   *
   * Every row is checked **before** anything is written, so a body with one bad
   * entry changes nothing. A partial application would leave the person with a
   * settings screen that disagrees with what they submitted and no way to tell
   * which half took.
   */
  async replaceOwn(
    preferences: readonly PreferenceInput[],
  ): Promise<{ preferences: PreferenceView[] }> {
    const actor = resolveActor();

    for (const preference of preferences) {
      if (preference.enabled) continue;
      this.assertMayDisable(preference);
    }

    await this.repository.replaceOwn(actor, preferences);
    return this.listOwn();
  }

  async effective(query: EffectiveQuery): Promise<EffectivePreferenceView> {
    const actor = resolveActor();
    const rule = ruleForKey(query.ruleKey);
    if (!rule) throw RastaError.notFound('NotificationRule', query.ruleKey);

    const facts = {
      ruleKey: rule.ruleKey,
      category: rule.category,
      classification: rule.classification,
      severity: rule.severity,
      mandatoryChannels: rule.mandatoryChannels,
    };

    const rows = await this.repository.listOwn(actor);
    const decision = resolvePreference(rows, facts, query.channel, CHANNEL_DEFAULTS);

    return {
      ruleKey: rule.ruleKey,
      channel: query.channel,
      enabled: decision.enabled,
      decidedBy: decision.layer,
      overridable: isOverridable(facts, query.channel),
    };
  }

  /**
   * Refuses to store an opt-out the ladder would ignore.
   *
   * A `RULE`-scoped row names one rule, so the answer is exact. A `CATEGORY` or
   * `GLOBAL` row covers rules that do not exist yet, so it is refused only when
   * a rule it covers *today* is mandatory on that channel — a broad preference
   * is a reasonable thing to express, and the ladder already lets the platform
   * policy win over it for the individual rules that need it.
   */
  private assertMayDisable(preference: PreferenceInput): void {
    if (preference.scope !== 'RULE') return;

    const rule = ruleForKey(preference.scopeKey as string);
    if (!rule) throw RastaError.notFound('NotificationRule', preference.scopeKey as string);

    const facts = {
      ruleKey: rule.ruleKey,
      category: rule.category,
      classification: rule.classification,
      severity: rule.severity,
      mandatoryChannels: rule.mandatoryChannels,
    };

    if (!isOverridable(facts, preference.channel)) {
      throw RastaError.businessRule(
        `${rule.ruleKey} is a mandatory notification and cannot be turned off on ${preference.channel}`,
        { rule: 'MANDATORY_NOTIFICATION', ruleKey: rule.ruleKey, channel: preference.channel },
      );
    }
  }
}
