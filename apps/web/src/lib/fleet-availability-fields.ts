/**
 * The shape of the availability forms on `/assets/[id]` (EXP-002, slice 7):
 * the declare form's fields, its closed choice and a blank set of values.
 *
 * Separate from `server/fleet-availability.ts` for the reason
 * `asset-record-fields.ts` gives: that module reaches `node:crypto` and this one
 * is imported by client components.
 *
 * Neither form names its asset or its window in a field: the asset is the
 * page's own, and the window a revoke names is bound by the form and signed
 * into the baseline beside it.
 */

export const DECLARE_AVAILABILITY_FIELDS = ['available', 'reason', 'fromAt', 'toAt'] as const;
export type DeclareAvailabilityField = (typeof DECLARE_AVAILABILITY_FIELDS)[number];
export type DeclareAvailabilityFormValues = Record<DeclareAvailabilityField, string>;

/** What a declaration says about the machine — the form's `available` select. */
export const AVAILABILITY_CHOICES = ['false', 'true'] as const;

export const EMPTY_DECLARE_AVAILABILITY_FORM: DeclareAvailabilityFormValues = {
  available: '',
  reason: '',
  fromAt: '',
  toAt: '',
};

/** What a declaration's confirmation banner can say, signed into the redirect (`server/flash.ts`). */
export const AVAILABILITY_NOTICES = ['availabilityDeclared', 'availabilityRevoked'] as const;
export type AvailabilityNotice = (typeof AVAILABILITY_NOTICES)[number];

/**
 * Where a declaration stands against **now**, as the server judged it when it
 * drew the page (`windowStateOf`): withdrawn, finished, not begun, or in force.
 * Never computed in a client component, whose clock is the visitor's.
 */
export type WindowState = 'REVOKED' | 'ENDED' | 'SCHEDULED' | 'IN_FORCE';
