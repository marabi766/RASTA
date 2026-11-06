import { z } from 'zod';

import {
  DEMAND_INVALID_MESSAGE,
  DEMAND_REFUSAL_MESSAGES,
  KEY_REUSED_MESSAGE,
  type DemandBody,
  type DemandField,
} from '@/lib/demand-commands';

import type { WebServerEnv } from './env';
import type { WebSession } from './session';
import { isProvenRefusal, writeThroughGateway, type FieldMapping, type WriteResult } from './write';

/**
 * Submitting a demand through the gateway (EXP-004, COM-007;
 * `POST /v1/demand-requests`). The form's schema says what a person may type
 * and in what words a mistake is said; procurement-service decides what is true.
 *
 * ## A key, and so a retry — inside a deadline
 *
 * The endpoint **requires** an `Idempotency-Key` (8–255 characters): the same
 * key with the same body from the same person answers the stored first response
 * and does nothing again; another body or person under it is `409
 * IDEMPOTENCY_KEY_REUSED`; a duplicate still running is `409 CONFLICT` with
 * `Retry-After`. The key is the form's submission id, and it is sent only inside
 * the deadline the page signed (`demand-replay.ts`) — and WITH that deadline, as
 * `Idempotency-Replay-Deadline` (FU-156, PM decision D-125): procurement-service
 * refuses the request on its own clock once it has passed (`409
 * REPLAY_WINDOW_CLOSED`, nothing executed), so no pause between this portal's
 * check and the service's claim can execute it after the key was forgotten
 * (PR-830 r1 F2). The portal's margin stays as a second guard.
 */

/** Never on the buyer side, whatever the configuration says (procurement-service `access.ts`). */
const REFUSED_ROLES: readonly string[] = ['AUDITOR', 'SYSTEM_ADMIN'];

/**
 * Whether the demand screens and form are worth drawing: a role
 * `WEB_PROCUREMENT_DEMAND_ROLES` names (mirroring `PROCUREMENT_DEMAND_ROLES`),
 * none the service refuses, and — `roles` being `sessionWriteRoles` — an
 * organization to be the buyer. **UX, not access control**: the service decides
 * on every request; `null` (roles unreadable) draws nothing.
 */
export function canUseDemands(
  roles: readonly string[] | null,
  env: Pick<WebServerEnv, 'WEB_PROCUREMENT_DEMAND_ROLES'>,
): boolean {
  if (roles === null || roles.some((role) => REFUSED_ROLES.includes(role))) return false;
  return roles.some((role) => env.WEB_PROCUREMENT_DEMAND_ROLES.includes(role));
}

export const DEMAND_FIELD_MAPPING: FieldMapping<DemandField> = {
  paths: { productId: 'productId', quantity: 'quantity', note: 'note' },
  byDetailCode: DEMAND_REFUSAL_MESSAGES,
  byCode: { IDEMPOTENCY_KEY_REUSED: KEY_REUSED_MESSAGE },
  // Never the service's own sentence: a text field could echo what was typed.
  fallback: DEMAND_INVALID_MESSAGE,
};

/**
 * Whether a failed write is **proven** not to have written anything: the shared
 * writer's one rule ({@link isProvenRefusal}: a `4xx` whose documented code is
 * answered with its own status; procurement-service refuses before the demand
 * is written — `AGGREGATION_DEMAND_LIMIT_REACHED` may still commit the window's
 * EXTEND end, never the demand, and releases the key). Everything else — a
 * `5xx` (a post-commit read can fail; the gateway's `503` can follow an upstream
 * reset after the commit), a timeout, a reset, a `4xx` without a documented code
 * (a proxy's page proves nothing) — is unconfirmed. It proves only that THIS
 * attempt did nothing: a retry's refusal says nothing about the earlier one.
 */
export function provenUnwritten(status: number, code: string | undefined): boolean {
  return isProvenRefusal(status, code);
}

const answerSchema = z.object({ id: z.string().min(1) });
export type WrittenDemand = z.infer<typeof answerSchema>;

export const submitDemand = (
  session: WebSession,
  body: DemandBody,
  submissionId: string,
  replayDeadline: number,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<WrittenDemand, DemandField>> =>
  writeThroughGateway(session, {
    path: '/v1/demand-requests',
    body,
    submissionId,
    replayDeadline,
    schema: answerSchema,
    mapping: DEMAND_FIELD_MAPPING,
    fetchImpl,
  });
