import { RastaError } from '@rasta/nest-common';

/**
 * The suspension lifecycle, as data (AGENTS.md A-11).
 *
 * ```
 *              SuspendSupplier
 *   ACTIVE ─────────────────────► SUSPENDED
 *      ▲                              │
 *      └──────────────────────────────┘
 *            ReinstateSupplier
 * ```
 *
 * Two states and two commands, and unlike qualification this cycle is
 * **repeatable**: a supplier may be suspended, reinstated and suspended again,
 * and each episode is its own row in `suspension`. `Supplier.status` answers
 * "now"; the table answers "when, why, and who decided" — which is the question
 * an audit asks, and the reason a suspension is never modelled as a boolean.
 *
 * ## What is absent
 *
 *   automatic suspension    Nothing here suspends a supplier on a score, a
 *                           dispute count or a threshold. That would need a
 *                           policy that says which number and how many, and
 *                           none exists (Q-12 is open). Suspension is a human
 *                           decision, like qualification.
 *   timed suspension        There is no `until`. "Suspended for 30 days" would
 *                           need a rule about who sets the period and what
 *                           happens at the end; instead a suspension runs until
 *                           somebody explicitly reinstates. The
 *                           SUPPLIER_SUSPENDED event still carries `until`,
 *                           because the platform catalogue names the field and
 *                           a consumer must be able to tell "no end date" from
 *                           a date — it is `null`, and `null` means exactly
 *                           that.
 *   self-service lifting    A supplier cannot reinstate itself. That is an
 *                           authorization rule and lives in `access.ts`, not
 *                           here, because it is about who is asking rather than
 *                           about what state the row is in.
 */

export const SUPPLIER_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;

export type SupplierStatusName = (typeof SUPPLIER_STATUSES)[number];

export const SUSPENSION_TRANSITIONS: Readonly<
  Record<SupplierStatusName, readonly SupplierStatusName[]>
> = {
  ACTIVE: ['SUSPENDED'],
  SUSPENDED: ['ACTIVE'],
} as const;

export function canTransitionSupplier(from: SupplierStatusName, to: SupplierStatusName): boolean {
  return SUSPENSION_TRANSITIONS[from].includes(to);
}

/**
 * Refuses suspending a supplier that is already suspended.
 *
 * Not idempotent-by-silence, and that is deliberate. Accepting the second
 * suspension quietly would either overwrite the first episode's reason and
 * actor — losing the record of who actually suspended them — or open a second
 * episode, which `ux_suspension_open` refuses at the database anyway. Refusing
 * here makes the answer a diagnosable `422` rather than a constraint violation.
 */
export function assertSuspendable(supplier: { id: string; status: SupplierStatusName }): void {
  if (canTransitionSupplier(supplier.status, 'SUSPENDED')) return;

  throw RastaError.businessRule(`Supplier ${supplier.id} is already suspended`, {
    supplierId: supplier.id,
    status: supplier.status,
  });
}

/**
 * Refuses reinstating a supplier that is not suspended.
 *
 * Same reasoning in the other direction: a reinstatement with no episode to
 * close would write an actor and a timestamp onto nothing, and the audit trail
 * would show a lifting that lifted no suspension.
 */
export function assertReinstatable(supplier: { id: string; status: SupplierStatusName }): void {
  if (canTransitionSupplier(supplier.status, 'ACTIVE')) return;

  throw RastaError.businessRule(`Supplier ${supplier.id} is not suspended`, {
    supplierId: supplier.id,
    status: supplier.status,
  });
}

/** An episode is open exactly while it has no reinstatement stamp. */
export function isOpenEpisode(episode: { reinstatedAt: Date | null }): boolean {
  return episode.reinstatedAt === null;
}

/**
 * The status the supplier row must hold, derived from its episodes.
 *
 * Used by the integration suite to assert that the denormalised
 * `Supplier.status` and the `suspension` history never disagree. PostgreSQL
 * cannot express that as a CHECK — it spans two tables — so the invariant is
 * held by writing both inside one transaction and proven by asserting this
 * against real rows.
 */
export function statusFromEpisodes(
  episodes: readonly { reinstatedAt: Date | null }[],
): SupplierStatusName {
  return episodes.some(isOpenEpisode) ? 'SUSPENDED' : 'ACTIVE';
}
