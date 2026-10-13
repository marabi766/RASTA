import { createHash } from 'node:crypto';
import { RastaError } from '@rasta/nest-common';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import type { ClaimFence } from './idempotency';
import {
  isCheckViolation,
  isLockTimeout,
  isTransactionUnavailable,
  isUniqueViolation,
  violatedConstraint,
} from './prisma-errors';
import { refusal } from './refusal';

/** `Retry-After` on a command that met a stock item another command held too long. */
const CONTENDED_RETRY_AFTER_SECONDS = 1;

/**
 * What a command carries from its controller into its transaction: the claim on its
 * Idempotency-Key (docs/06 § 6.8), and the key's hash for the database backstop.
 */
export interface Command<T> {
  readonly fence: ClaimFence<T>;
  /** {@link commandKeyHash} of the route and the key. */
  readonly keyHash: string;
}

/**
 * SHA-256 of a command's route and Idempotency-Key, stored on every movement and reservation the
 * command writes under `UNIQUE (organization_id, command_key_hash, stock_item_id)` — deviation 1
 * of the plan: one command writes several movements, so the key cannot be the unique column
 * itself, and the raw key never enters a domain table (S-09). Never logged or returned.
 */
export function commandKeyHash(endpoint: string, key: string): string {
  return createHash('sha256').update(`${endpoint}\n${key}`).digest('hex');
}

/**
 * The backstop hash of the movement that expires a reservation: the service's own act, so it has
 * no key, and one per reservation — a reservation expires once.
 */
export function expiryKeyHash(reservationId: string): string {
  return createHash('sha256').update(`expiry\n${reservationId}`).digest('hex');
}

/**
 * Bounds every lock wait of the transaction (ADR-056 § 3): a command that queues behind a stock
 * item longer than INVENTORY_LOCK_TIMEOUT_MS is refused, retryably, rather than left hanging.
 * `set_config(…, true)` is `SET LOCAL`: it ends with the transaction.
 */
export async function boundLockWaits(
  tx: ExtendedPrismaClient,
  lockTimeoutMs: number,
): Promise<void> {
  await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`;
}

/** The balance CHECKs (ADR-056 § 3): the database refusing what the code's pre-check missed. */
const BALANCE_CHECKS = new Set([
  'ck_stock_item_on_hand_nonneg',
  'ck_stock_item_reserved_nonneg',
  'ck_stock_item_reserved_within_on_hand',
]);

/** The backstop of the Idempotency-Key in the domain tables. */
const COMMAND_KEYS = new Set(['ux_stock_movement_command', 'ux_stock_reservation_command']);

/** The columns both backstop indexes are on, as PostgreSQL's DETAIL names them. */
const COMMAND_KEY_COLUMNS = '(organization_id, command_key_hash, stock_item_id)';

/**
 * Whether a unique violation is the Idempotency-Key backstop. A raw query's failure carries the
 * violated key's DETAIL (`Key (organization_id, command_key_hash, stock_item_id)=…`) rather than
 * the constraint's name, so both are recognised.
 */
function isCommandKey(error: unknown, constraint: string | undefined): boolean {
  if (constraint !== undefined && COMMAND_KEYS.has(constraint)) return true;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.includes(COMMAND_KEY_COLUMNS);
}

/**
 * Turns what the database refused into what the caller is told, and lets everything else through:
 *
 *   - a lock wait past INVENTORY_LOCK_TIMEOUT_MS → `409 CONFLICT` with `Retry-After: 1`;
 *   - a key that already applied this command to a stock item (its record in `idempotency_key`
 *     has expired, the domain backstop has not) → `409 IDEMPOTENCY_KEY_REUSED`;
 *   - a balance CHECK → the command's own closed 422: an oversell is a write the database
 *     refuses, whatever the code checked before (ADR-056 § 3).
 *
 * A trigger's refusal (`ck_stock_movement_chain`, …) is a defect, not a request error, and stays
 * a 500 — as does a balance CHECK met by a command that writes no balance (`overdrawn` `null`).
 */
export function translateCommandError(
  error: unknown,
  overdrawn: (() => RastaError) | null,
): unknown {
  if (error instanceof RastaError) return error;
  // The transaction could not start in time (the pool is exhausted) or outlived its budget
  // waiting on locks — the same contention, answered the same way.
  if (isLockTimeout(error) || isTransactionUnavailable(error)) {
    return new RastaError(
      'CONFLICT',
      'The stock is being changed by another request; retry shortly',
      { retryAfterSeconds: CONTENDED_RETRY_AFTER_SECONDS },
    );
  }
  const constraint = violatedConstraint(error);
  if (isUniqueViolation(error) && isCommandKey(error, constraint)) {
    return RastaError.idempotencyKeyReused();
  }
  if (
    overdrawn !== null &&
    isCheckViolation(error) &&
    constraint !== undefined &&
    BALANCE_CHECKS.has(constraint)
  ) {
    return overdrawn();
  }
  return error;
}

/** The refusal a balance CHECK becomes on a command that only adds to on hand or adjusts it. */
export const stockOverdrawn = (): RastaError =>
  refusal('stock', 'ON_HAND_WOULD_BE_NEGATIVE', 'On hand would fall below what is reserved');

/** The refusal a balance CHECK becomes on a reservation. */
export const reservationOverdrawn = (): RastaError =>
  refusal(
    'reservation',
    'INSUFFICIENT_AVAILABLE_STOCK',
    'Not enough stock is available to reserve',
  );
