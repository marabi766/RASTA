import { RastaError } from '@rasta/nest-common';

/**
 * The driver lifecycle, as an explicit transition table.
 *
 * A table rather than a chain of `if`s, for the same reason asset-service uses
 * one: the legal moves are then a thing you can read, test and point at in a
 * review, instead of behaviour you have to reconstruct from branches
 * (AGENTS.md A-11).
 *
 *      ACTIVE ⇄ SUSPENDED
 *         │        │
 *         └────────┴──► DEACTIVATED   (terminal)
 *
 * `DEACTIVATED` is terminal on purpose. Assignment and usage history reference
 * the driver row, so it is never deleted; reinstating someone who left is
 * creating a new driver record, which is also what the paperwork does.
 */

export const DRIVER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;
export type DriverStatus = (typeof DRIVER_STATUSES)[number];

const TRANSITIONS: Record<DriverStatus, readonly DriverStatus[]> = {
  ACTIVE: ['SUSPENDED', 'DEACTIVATED'],
  SUSPENDED: ['ACTIVE', 'DEACTIVATED'],
  DEACTIVATED: [],
};

/** Statuses in which a driver may hold a new assignment. */
export const ASSIGNABLE_STATUSES: readonly DriverStatus[] = ['ACTIVE'];

export function canTransition(from: DriverStatus, to: DriverStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertDriverTransition(from: string, to: string): void {
  const source = from as DriverStatus;
  const target = to as DriverStatus;

  if (source === target) {
    throw RastaError.invalidStateTransition('Driver', from, to, `The driver is already ${from}`);
  }

  if (canTransition(source, target)) return;

  throw RastaError.invalidStateTransition(
    'Driver',
    from,
    to,
    source === 'DEACTIVATED'
      ? 'A deactivated driver is terminal; register a new driver record instead'
      : `A driver cannot move from ${from} to ${to}`,
  );
}

export function isAssignable(status: string): boolean {
  return ASSIGNABLE_STATUSES.includes(status as DriverStatus);
}
