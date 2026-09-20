import type { Classification, Severity } from '../rules/rules';

/**
 * The preference ladder of ADR-054 § 5, as a pure function.
 *
 * ```
 * 1. platform mandatory policy   (highest — a user cannot override it)
 * 2. RULE-scoped preference
 * 3. CATEGORY-scoped preference
 * 4. GLOBAL preference
 * 5. channel default from configuration  (lowest)
 * ```
 *
 * Pure and synchronous on purpose. Every input is passed in — the rows, the
 * rule, the defaults — so the decision can be exercised exhaustively in a unit
 * test and so the caller, which is inside a transaction, does no I/O to make it.
 *
 * ## Why the winning layer is part of the answer
 *
 * `resolve` returns which layer decided, not only what it decided. ADR-054 § 5
 * puts that on the API: *«کاربران به سیستم ترجیحی که نتوانند بازرسی کنند باور
 * نمی‌کنند.»* A person who has turned something off and still receives it needs
 * to be able to see whether their rule-level choice lost to a platform policy or
 * whether they never had a rule-level choice at all. A boolean cannot tell them.
 *
 * ## Why a mandatory rule does not simply ignore preferences
 *
 * It bypasses layers 2–4 **for the channels the policy names**, and no others.
 * The temporary answer to Q-38, which this implements, is that `MANDATORY`
 * always produces an `IN_APP` notification — which cannot be opted out of, only
 * dismissed — while other channels stay under the person's control. That way
 * the platform can always put a required notice in front of somebody without
 * claiming the right to put mail in a box nobody asked for.
 */

export type Channel = 'IN_APP' | 'EMAIL';

/** Channels that can reach somebody who is not looking at the application. */
export const INTERRUPTING_CHANNELS: readonly Channel[] = ['EMAIL'];

/** The layers, narrowest first. The order is the contract. */
export const PREFERENCE_LAYERS = [
  'MANDATORY_POLICY',
  'RULE',
  'CATEGORY',
  'GLOBAL',
  'CHANNEL_DEFAULT',
] as const;

export type PreferenceLayer = (typeof PREFERENCE_LAYERS)[number];

/** A stored row, reduced to what the ladder reads. */
export interface PreferenceRow {
  readonly scope: 'GLOBAL' | 'CATEGORY' | 'RULE';
  /** Null exactly when the scope is `GLOBAL`. */
  readonly scopeKey: string | null;
  readonly channel: Channel;
  readonly enabled: boolean;
}

/** What the ladder needs to know about the rule that fired. */
export interface RuleFacts {
  readonly ruleKey: string;
  readonly category: string;
  readonly classification: Classification;
  readonly severity: Severity;
  /**
   * Channels a `MANDATORY` rule delivers on regardless of preference.
   *
   * Per rule rather than a constant, so the answer to Q-38 can change without a
   * migration — which is exactly what that question's "اثر پاسخ" promises.
   */
  readonly mandatoryChannels: readonly Channel[];
}

/**
 * The default for a channel when nobody has said anything.
 *
 * ADR-054 § 5: `IN_APP` on; `EMAIL` on for `WARNING` and `CRITICAL`, off for
 * `INFO`. Expressed as a function of severity rather than a constant, because
 * that is what the document describes and because the email half of it will be
 * read unchanged the day that channel exists.
 */
export type ChannelDefaults = (channel: Channel, severity: Severity) => boolean;

export interface PreferenceDecision {
  readonly enabled: boolean;
  /** Which rung decided. */
  readonly layer: PreferenceLayer;
  /**
   * Set only when the decision is `false`, and only to a bounded class — it is
   * written to `notification_delivery.suppression_reason`, which is
   * `VARCHAR(64)` and must never carry free text.
   */
  readonly suppressionReason: 'PREFERENCE_OPT_OUT' | null;
}

/**
 * Resolves whether one channel may deliver one rule to one person.
 *
 * `rows` is every preference that person holds for this tenant and this
 * channel. It is filtered rather than queried per layer so the caller makes one
 * database read for a whole dispatch rather than one per recipient per layer.
 */
export function resolvePreference(
  rows: readonly PreferenceRow[],
  rule: RuleFacts,
  channel: Channel,
  defaults: ChannelDefaults,
): PreferenceDecision {
  // 1 — the platform's own policy, which a preference cannot reach.
  if (rule.classification === 'MANDATORY' && rule.mandatoryChannels.includes(channel)) {
    return { enabled: true, layer: 'MANDATORY_POLICY', suppressionReason: null };
  }

  const forChannel = rows.filter((row) => row.channel === channel);

  // 2 — the narrowest thing the person said: this exact rule.
  const ruleRow = forChannel.find((row) => row.scope === 'RULE' && row.scopeKey === rule.ruleKey);
  if (ruleRow) return decisionFrom(ruleRow.enabled, 'RULE');

  // 3 — what they said about this kind of notification.
  const categoryRow = forChannel.find(
    (row) => row.scope === 'CATEGORY' && row.scopeKey === rule.category,
  );
  if (categoryRow) return decisionFrom(categoryRow.enabled, 'CATEGORY');

  // 4 — what they said about this channel as a whole.
  const globalRow = forChannel.find((row) => row.scope === 'GLOBAL');
  if (globalRow) return decisionFrom(globalRow.enabled, 'GLOBAL');

  // 5 — nobody said anything.
  return decisionFrom(defaults(channel, rule.severity), 'CHANNEL_DEFAULT');
}

function decisionFrom(enabled: boolean, layer: PreferenceLayer): PreferenceDecision {
  return { enabled, layer, suppressionReason: enabled ? null : 'PREFERENCE_OPT_OUT' };
}

/**
 * Whether a person is allowed to turn this channel off for this rule at all.
 *
 * The API refuses the attempt with `422 BUSINESS_RULE_VIOLATION` rather than
 * storing a row that the ladder will then ignore. ADR-054 § 5 names the
 * precedent, Q-07: *«یک قاعده که وجود دارد، `ACTIVE` است و کاری نمی‌کند، کنترلی
 * را ادعا می‌کند که ندارد.»* A preference the interface shows as "off" while the
 * notification still arrives is exactly that failure, and it is worse than a
 * refusal because the person believes they have acted.
 */
export function isOverridable(rule: RuleFacts, channel: Channel): boolean {
  return !(rule.classification === 'MANDATORY' && rule.mandatoryChannels.includes(channel));
}
