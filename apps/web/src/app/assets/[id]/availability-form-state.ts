import type {
  DeclareAvailabilityField,
  DeclareAvailabilityFormValues,
} from '@/lib/fleet-availability-fields';

import type { RecordFormState } from './record-form-state';

/**
 * What the two availability forms — declare, revoke — know after an attempt.
 *
 * The same family as the record forms (`RecordFormState`): a baseline that names
 * the machine (and, for a revoke, the window), a bound submission id, and the
 * same refusals, so a form renders the same banners wherever it sits. A revoke
 * has no fields: its `INVALID` carries only the service's sentence.
 *
 * A module of its own because `availability-actions.ts` is a `'use server'`
 * file and may export only async functions. Success has no state to render: the
 * action redirects to a fresh read (a signed `?flash=`).
 */
export type DeclareFormState = RecordFormState<
  DeclareAvailabilityFormValues,
  DeclareAvailabilityField
>;

export type RevokeFormState = RecordFormState<Record<string, never>, never>;

export const IDLE_AVAILABILITY_FORM = { kind: 'IDLE' } as const;
