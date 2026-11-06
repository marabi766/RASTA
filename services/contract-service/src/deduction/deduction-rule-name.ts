/**
 * The one form of a deduction rule's name (CON-003-1 review, docs/24 Q-125). A statement names a rule
 * by id and a person reads it by name, so two names a person cannot tell apart would be two rules
 * both cutting the same pay.
 *
 * `isCanonicalDeductionRuleName` is `deduction_rule_name_is_canonical` of migration
 * 20261104100000, and that function is what the database refuses by. It names what is allowed, so
 * nothing unlisted gets in: `test/deduction-rule-change.int-spec.ts` runs both over every code point.
 * Two names that differ only by a half-space are still one name: the database compares
 * `deduction_rule_name_key`.
 */
const LETTERS =
  '\\u0621-\\u063A\\u0641\\u0642\\u0644-\\u0648\\u067E\\u0686\\u0698\\u06A9\\u06AF\\u06CC';
const ONLY_ALLOWED = new RegExp(
  `^[\\u0654\\u0020-\\u007E\\u00AB\\u00BB\\u060C\\u061B\\u061F\\u066A${LETTERS}\\u200C]+$`,
  'u',
);
const BLANK_OUT_OF_PLACE = /^[\u0020\u200c]|[\u0020\u200c]$|[\u0020\u200c]{2}/u;
const MARK_OUT_OF_PLACE = /(^|[^\u0647])\u0654/u;
const HALF_SPACE_OUT_OF_PLACE = new RegExp(
  `(^|[^\\u0654${LETTERS}])\\u200C|\\u200C($|[^${LETTERS}])`,
  'u',
);
const MAX_CODE_POINTS = 200;

export function isCanonicalDeductionRuleName(candidate: string): boolean {
  return (
    ONLY_ALLOWED.test(candidate) &&
    [...candidate].length <= MAX_CODE_POINTS &&
    !BLANK_OUT_OF_PLACE.test(candidate) &&
    !MARK_OUT_OF_PLACE.test(candidate) &&
    !HALF_SPACE_OUT_OF_PLACE.test(candidate)
  );
}

/**
 * The name in its one form, or `null` if it has none. What keyboards vary without anyone meaning a
 * difference is folded, as `canonicalIdentifier` of asset-service does; anything else invisible is
 * refused rather than removed, since the person never saw what would be dropped.
 */
export function canonicalDeductionRuleName(raw: string): string | null {
  const name = raw
    // Presentation forms and compatibility characters, other blanks, and composed letters.
    .normalize('NFKC')
    .replace(/[\u064a\u0649]/g, '\u06cc')
    .replace(/\u0643/g, '\u06a9')
    .replace(/\u06c0/g, '\u0647\u0654')
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\u0640/g, '')
    .replace(/[\t\n\v\f\r ]+/g, ' ')
    .replace(/^ | $/g, '');
  return isCanonicalDeductionRuleName(name) ? name : null;
}
