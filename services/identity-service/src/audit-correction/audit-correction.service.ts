import { Injectable } from '@nestjs/common';
import {
  AUDIT_EVENT_RECORDED,
  AUDIT_EVENT_RECORDED_VERSION,
  AUDIT_TRAIL_TOPIC,
} from '@rasta/contracts';
import { RastaError, getContext, type RequestContext } from '@rasta/nest-common';
import { IdentityRepository, isUniqueViolation } from '../identity/identity.repository';
import { AuditLookupClient } from './audit-lookup.client';
import {
  AuditCorrectionCommandRepository,
  type AuditCorrectionCommandRecord,
} from './audit-correction.repository';
import { buildCorrectionPayload, CORRECTION_RESOURCE_TYPE } from './correction-payload';
import { hashCorrectionCommand, type AuditCorrectionCommand } from './dto';

/**
 * The audit correction command (ADR-053 § 7, AUD-003 correction).
 *
 * A correction is **never** an edit. This command writes nothing to
 * audit-service and cannot: it enqueues one `AUDIT_EVENT_RECORDED` v1 message on
 * identity's standard outbox, and audit-service's path-B consumer records it as
 * a fresh, chained row linked to the original by `correctionOf`. The original
 * row, its hash and its chain are untouched by construction.
 *
 * ## The order of operations is the security property
 *
 *   1. authority       verified token only: a USER holding SYSTEM_ADMIN
 *   2. key             an Idempotency-Key is mandatory — the command is
 *                      irreversible
 *   3. replay          same actor + key: the stored response, or
 *                      IDEMPOTENCY_KEY_REUSED for a different request
 *   4. target          audit-service proves the target exists exactly as
 *                      named, and says which scope it is in (object-level
 *                      authorization: the only record this can correct is the
 *                      one the trusted lookup returned)
 *   5. payload         built from 1 and 4 plus the validated command, and
 *                      checked against the wire contract
 *   6. commit          one transaction: lock the (actor, key) command, re-read
 *                      it and replay or refuse if a concurrent duplicate
 *                      committed first, otherwise outbox row + command record
 *
 * Nothing from the request body can name an organization, actor or source, and
 * a missing or mismatched target stops at step 4 having written nothing.
 */

/** ADR-053 § 7: corrections are SYSTEM_ADMIN only. */
export const AUDIT_CORRECTION_ROLE = 'SYSTEM_ADMIN';

/** 1–255 printable ASCII characters, no spaces — a key, not a message. */
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;

/** What the command answers, and what a retry with the same key replays. */
export interface AuditCorrectionAccepted {
  readonly status: 'ACCEPTED';
  /**
   * The `eventId` of the one message this command produced — the value
   * audit-service records as the correction's `sourceEventId`.
   */
  readonly eventId: string;
  /** The audit record being corrected. */
  readonly correctionOf: string;
  readonly acceptedAt: string;
}

/**
 * The verified caller, if and only if they may correct evidence.
 *
 * A human `USER` token holding `SYSTEM_ADMIN`. A service token is refused even
 * though the shared role guard treats one as satisfying every role: a
 * correction must be traceable to one accountable person (ADR-053 § 7).
 */
export function assertCorrectionAuthority(context: RequestContext): {
  actorId: string;
  roles: readonly string[];
} {
  if (
    context.authType !== 'USER' ||
    typeof context.userId !== 'string' ||
    context.userId.trim().length === 0 ||
    !context.roles.includes(AUDIT_CORRECTION_ROLE)
  ) {
    throw RastaError.forbidden('Only a platform administrator may correct an audit record');
  }
  return { actorId: context.userId, roles: context.roles };
}

/** The `Idempotency-Key` header, or `400` naming what is required. */
export function assertIdempotencyKey(key: unknown): string {
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw RastaError.validation([
      {
        path: 'headers.idempotency-key',
        message:
          'An audit correction is irreversible and requires an Idempotency-Key header ' +
          'of 1-255 printable characters',
        code: 'required',
      },
    ]);
  }
  return key;
}

/** The stored response for the same request, or the platform refusal for a different one. */
export function replayOrRefuse(
  record: AuditCorrectionCommandRecord,
  requestHash: string,
): AuditCorrectionAccepted {
  if (record.requestHash !== requestHash) {
    throw RastaError.idempotencyKeyReused(record.idempotencyKey);
  }
  return acceptedResponse(record.responseBody);
}

/**
 * The accepted response, rebuilt in one fixed key order.
 *
 * The stored copy comes back from JSONB, which reorders object keys, so a
 * replay returned as stored would serialise differently from the original even
 * though every value is the same. Rebuilding it makes a replay byte-identical.
 */
function acceptedResponse(body: AuditCorrectionAccepted): AuditCorrectionAccepted {
  return {
    status: body.status,
    eventId: body.eventId,
    correctionOf: body.correctionOf,
    acceptedAt: body.acceptedAt,
  };
}

@Injectable()
export class AuditCorrectionService {
  constructor(
    private readonly repository: IdentityRepository,
    private readonly commands: AuditCorrectionCommandRepository,
    private readonly lookups: AuditLookupClient,
  ) {}

  async submit(
    command: AuditCorrectionCommand,
    idempotencyKey: unknown,
  ): Promise<AuditCorrectionAccepted> {
    const context = getContext();
    const { actorId, roles } = assertCorrectionAuthority(context);
    const key = assertIdempotencyKey(idempotencyKey);
    const requestHash = hashCorrectionCommand(command);

    // A retry is answered before audit-service is asked anything.
    const existing = await this.commands.find(actorId, key);
    if (existing) return replayOrRefuse(existing, requestHash);

    const target = await this.lookups.findTarget(
      command.auditEventId,
      new Date(command.occurredAt),
    );
    if (!target) {
      // Indistinguishable from any other unknown id; nothing has been written.
      throw RastaError.notFound(CORRECTION_RESOURCE_TYPE, command.auditEventId);
    }

    const payload = buildCorrectionPayload({
      actorId,
      actorRoles: roles,
      target,
      reason: command.reason,
      changes: command.changes,
      source: { ip: context.ip, userAgent: context.userAgent },
    });

    try {
      return await this.repository.transaction(async (tx) => {
        // Decide under the command's own lock, before anything is allocated. A
        // concurrent duplicate that passed the check above waits here for the
        // winner to commit, then replays it without ever touching the outbox
        // stream counter. The lock is taken only now, so no transaction is held
        // open across the audit-service lookup.
        await this.commands.lockCommandKey(tx, actorId, key);
        const winner = await this.commands.find(actorId, key, tx);
        if (winner) return replayOrRefuse(winner, requestHash);

        const eventId = await this.repository.enqueueEvent(tx, {
          aggregateType: CORRECTION_RESOURCE_TYPE,
          // The target, so every correction of one record is one ordered stream
          // on the trail topic, partitioned by the record it corrects.
          aggregateId: target.id,
          eventName: AUDIT_EVENT_RECORDED,
          eventVersion: AUDIT_EVENT_RECORDED_VERSION,
          topic: AUDIT_TRAIL_TOPIC,
          // From the trusted lookup, never the administrator's own tenant:
          // `null` is an explicit platform scope, not "use the context".
          organizationId: target.organizationId,
          payload,
        });

        const accepted: AuditCorrectionAccepted = {
          status: 'ACCEPTED',
          eventId,
          correctionOf: target.id,
          acceptedAt: new Date().toISOString(),
        };

        await this.commands.create(tx, {
          actorId,
          idempotencyKey: key,
          requestHash,
          targetId: target.id,
          eventId,
          responseBody: accepted,
        });

        return accepted;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Defensive: a writer outside the lock protocol committed the same
        // command first; this attempt rolled back with its outbox row. Answer
        // as that one did.
        const winner = await this.commands.find(actorId, key);
        if (winner) return replayOrRefuse(winner, requestHash);
      }
      if (error instanceof RastaError) throw error;
      // The command and its outbox row share one transaction, so a failure
      // here left neither behind.
      throw RastaError.internal(
        'The correction could not be recorded; nothing was changed and it is safe to retry',
      );
    }
  }
}
