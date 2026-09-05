/**
 * The bounded capability vocabulary.
 *
 * ## Where these three came from
 *
 * `docs/04` § 4.10 states this service's mission as a directory of
 * "تأمین‌کنندگان، تعمیرگاه‌ها و پیمانکاران" — goods suppliers, workshops and
 * contractors. `docs/09` § 9.3 gives a Supplier Org exactly three roles, one
 * per kind: `SUPPLIER`, `WORKSHOP`, `CONTRACTOR`. The vocabulary is those three
 * and stops there.
 *
 * It is deliberately **not** a taxonomy of what a supplier sells. "Tyres",
 * "asphalt" and "crane hire" are catalogue facts owned by marketplace-service
 * and procurement-service; a second copy of them here would be a second
 * authority for the same fact, and the first disagreement between the two would
 * be silent.
 *
 * ## Why a closed set rather than free text
 *
 * `ListQualifiedFor` is a question another service asks: "who may I refer a
 * repair to?" Free text would make the answer depend on both sides spelling the
 * same word the same way, which is not a contract. The enum is mirrored in
 * PostgreSQL, so an unknown value cannot reach the table even through a write
 * path that skipped the DTO.
 *
 * ## Adding one later
 *
 * Adding a member is a non-breaking event change (`docs/07` § 7.8: consumers
 * must tolerate an unknown enum value) plus a migration on the PostgreSQL enum.
 * It is not a code change anywhere but here.
 */

export const SUPPLIER_CAPABILITIES = [
  /** Supplies goods — the `SUPPLIER` role's counterparty kind. */
  'GOODS_SUPPLY',
  /** Repairs and services machinery — the `WORKSHOP` role's counterparty kind. */
  'WORKSHOP_SERVICE',
  /** Executes civil works under contract — the `CONTRACTOR` role's kind. */
  'CONTRACTING',
] as const;

export type SupplierCapability = (typeof SUPPLIER_CAPABILITIES)[number];

export function isSupplierCapability(value: unknown): value is SupplierCapability {
  return typeof value === 'string' && (SUPPLIER_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * The role that naturally corresponds to each capability, for documentation.
 *
 * Read by the OpenAPI description and by nothing that makes a decision. It is
 * **not** an authorization rule: holding the `WORKSHOP` role does not restrict
 * an organization to declaring `WORKSHOP_SERVICE`, because `docs/09` gives
 * `ORGANIZATION_ADMIN` everything within its own organization and an
 * organization may legitimately be all three at once. Wiring this map into a
 * guard would invent a restriction no document states.
 */
export const CAPABILITY_ROLE_HINT: Readonly<Record<SupplierCapability, string>> = {
  GOODS_SUPPLY: 'SUPPLIER',
  WORKSHOP_SERVICE: 'WORKSHOP',
  CONTRACTING: 'CONTRACTOR',
} as const;
