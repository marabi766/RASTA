import { z } from 'zod';

import {
  INVENTORY_COMMANDS,
  SCOPE_COMMANDS,
  type InventoryCommand,
  type InventoryScope,
} from '@/lib/inventory-commands';
import type { InventorySubmission, ReplayStamp } from '@/lib/unresolved-inventory';

import { webServerEnv, type WebServerEnv } from './env';
import { signPayload, verifyPayload } from './signed-payload';
import type { WebSession } from './session';
import { mintSubmissionId } from './submission';

/**
 * Until when an inventory command may be sent again under its original key,
 * and **what** it is — decided by this server, from a stamp it signed when the
 * page drew the form (`server/return-replay.ts` and
 * `server/contract-command-replay.ts` are the originals; same construction,
 * same reasons).
 *
 * ## Until when
 *
 * inventory-service answers the same key with its stored response only while
 * its idempotency record lives (`INVENTORY_IDEMPOTENCY_TTL_HOURS`); past that
 * the same request runs **as new** — a receipt or an adjustment run again moves
 * stock a second time, and a shipment run again is a second shipment. The
 * stamp's signed expiry is that retention
 * (`WEB_INVENTORY_IDEMPOTENCY_TTL_HOURS`, mirroring it) less a margin
 * (`WEB_INVENTORY_REPLAY_MARGIN_SECONDS`), counted from when the page drew the
 * form — before the first send could leave. It is accepted only while that and
 * issuance plus the window **as configured now** both hold.
 *
 * ## What
 *
 * A stamp binds **the slot** (the warehouse list, one warehouse, one
 * shipment), the command, the submission id and, for a dispatch or a delivery,
 * the shipment's `version` the page showed. A move's whole body is that
 * `expectedVersion`, so the action builds it from the verified stamp — never
 * from the posted form — and the first send and every retry under the key are
 * the same request; a form drawn before the shipment moved is refused by the
 * service (`409 OPTIMISTIC_LOCK_FAILED`) instead of acting on a state its
 * author never saw. What a person types is not in the stamp; the unconfirmed
 * view re-sends the body it kept (`lib/unresolved-inventory.ts`).
 *
 * Bound to this login (`signed-payload.ts`); readable, not secret, not a
 * credential for anything.
 */

const PURPOSE = 'inventory-replay';

const replaySchema = z.object({
  scope: z.enum(['WAREHOUSES', 'WAREHOUSE', 'SHIPMENT']),
  /** The warehouse or the shipment; null for the warehouse list. */
  targetId: z.string().min(1).max(200).nullable(),
  submissionId: z.string().min(1).max(200),
  command: z.enum(INVENTORY_COMMANDS),
  /** When the page signed it, milliseconds since the epoch, server clock. */
  issuedAt: z.number().int().nonnegative(),
  /** The signed expiry again, in milliseconds, for the browser to draw the right controls. */
  until: z.number().int(),
  /** The shipment's `version` as the page showed it; null for every other command. */
  expectedVersion: z.number().int().min(1).nullable(),
});

/** What a stamp is for: one command in one slot. */
export interface InventoryTarget {
  readonly command: InventoryCommand;
  readonly scope: InventoryScope;
  /** A dispatch's or a delivery's shipment version; null otherwise. */
  readonly expectedVersion: number | null;
}

type ReplayEnv = Pick<
  WebServerEnv,
  'WEB_INVENTORY_IDEMPOTENCY_TTL_HOURS' | 'WEB_INVENTORY_REPLAY_MARGIN_SECONDS'
>;

/** Seconds from the page being drawn until the same request may no longer be sent. */
export function inventoryReplayWindowSeconds(env: ReplayEnv = webServerEnv()): number {
  return (
    env.WEB_INVENTORY_IDEMPOTENCY_TTL_HOURS * 60 * 60 - env.WEB_INVENTORY_REPLAY_MARGIN_SECONDS
  );
}

function bindingOf(scope: InventoryScope): {
  scope: InventoryScope['kind'];
  targetId: string | null;
} {
  switch (scope.kind) {
    case 'WAREHOUSES':
      return { scope: 'WAREHOUSES', targetId: null };
    case 'WAREHOUSE':
      return { scope: 'WAREHOUSE', targetId: scope.warehouseId };
    case 'SHIPMENT':
      return { scope: 'SHIPMENT', targetId: scope.shipmentId };
  }
}

/** The stamp for `submissionId` on `target`, from `now`. */
export function mintInventoryStamp(
  session: WebSession,
  target: InventoryTarget,
  submissionId: string,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
): ReplayStamp {
  const window = inventoryReplayWindowSeconds(env);
  const until = (Math.floor(now / 1000) + window) * 1000;
  return {
    token: signPayload(
      session,
      PURPOSE,
      {
        ...bindingOf(target.scope),
        command: target.command,
        submissionId,
        issuedAt: now,
        until,
        expectedVersion: target.expectedVersion,
      },
      window,
      now,
    ),
    until,
  };
}

/** A fresh submission id for one inventory form on `target`, with its stamp. */
export function mintInventorySubmission(
  session: WebSession,
  target: InventoryTarget,
  now: number = Date.now(),
): InventorySubmission {
  const id = mintSubmissionId(session);
  return { id, replay: mintInventoryStamp(session, target, id, now) };
}

/** A stamp the action verified, with what it binds the request to. */
export interface VerifiedInventoryStamp extends ReplayStamp {
  readonly command: InventoryCommand;
  readonly expectedVersion: number | null;
}

/**
 * The stamp, only if this server issued it to this login, for this slot and
 * this submission id, its signed expiry has not passed and it is still inside
 * the window as configured now; otherwise null — one answer for every way it
 * can be wrong.
 */
export function verifyInventoryStamp(
  session: WebSession,
  token: unknown,
  scope: InventoryScope,
  submissionId: string,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
): VerifiedInventoryStamp | null {
  const payload = verifyPayload(session, PURPOSE, token, replaySchema, now);
  const bound = bindingOf(scope);
  if (
    payload === null ||
    typeof token !== 'string' ||
    payload.scope !== bound.scope ||
    payload.targetId !== bound.targetId ||
    payload.submissionId !== submissionId ||
    !SCOPE_COMMANDS[scope.kind].includes(payload.command) ||
    // Only a shipment move carries a version, and every one does.
    (payload.expectedVersion !== null) !== (scope.kind === 'SHIPMENT')
  ) {
    return null;
  }
  const current = payload.issuedAt + inventoryReplayWindowSeconds(env) * 1000;
  if (now > current) return null;
  return {
    token,
    until: Math.min(payload.until, current),
    command: payload.command,
    expectedVersion: payload.expectedVersion,
  };
}
