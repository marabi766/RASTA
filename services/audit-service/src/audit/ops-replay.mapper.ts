import type { ZodIssue } from 'zod';
import {
  eventEnvelopeSchema,
  OPS_REPLAY_PRODUCER,
  OPS_REPLAY_TOPIC,
  REPLAY_EXECUTED,
  REPLAY_EXECUTED_VERSION,
  replayExecutedPayloadSchemaV1,
  type AuditChange,
  type EventEnvelope,
} from '@rasta/contracts';
import type { EventDelivery } from '@rasta/nest-common';
import { toEnvelopeProvenance, type AuditEventRecord } from './audit.mapper';
import { INGESTION_FAILURE_REASONS } from '../observability/metrics';

/**
 * One `REPLAY_EXECUTED` becomes one audit row: the platform's record of an
 * executed DLQ replay (`rasta.ops.replay.v1`, docs/runbooks/replay-dlq.md).
 *
 * Validating, like path B and for path B's reason: every field was written
 * *for* audit by one producer, the operator's replay tool, so a wrong field is
 * a claim this store would make forever. Everything is checked first, nothing
 * is repaired, and a refusal throws — retried, then dead-lettered to
 * `rasta.audit.v1.dlq`, from where the fixed record can be replayed.
 *
 * ## What the row says
 *
 *   actor          `USER`, the operator the tool was run as (`REPLAY_OPERATOR`)
 *   organization   the replayed event's tenant; `null` — a platform record,
 *                  visible to `SYSTEM_ADMIN` only (ADR-053 § 10) — for an
 *                  event that had none. The envelope states it too, and the
 *                  two must agree.
 *   action         `REPLAY_EXECUTED`, the event's own name: ADR-053 defines no
 *                  dotted verb for it, and inventing one would be a contract
 *                  nobody agreed to.
 *   resource       `Event`, the replayed event's id.
 *   correlation    the run's report id — the envelope's `correlationId` — so
 *                  one run's records are one indexed lookup.
 *   changes        where the event moved, as before/after pairs (dead-letter
 *                  topic, partition, offset → `.retry` topic, partition,
 *                  offset), and what it was replayed as and under: its name
 *                  and the staleness verdict, each `from: null`. Ids and
 *                  positions only; the replayed payload never reaches here.
 */

/** The replay-record consumer group. Also the `processed_event` key. */
export const OPS_REPLAY_CONSUMER = 'audit-service.ops-replay';

/** The `resourceType` of every replay row: what was replayed is an event. */
export const REPLAYED_RESOURCE_TYPE = 'Event';

const MAX_REPORTED_ISSUES = 10;

export const OPS_REPLAY_REJECTION_REASONS = [
  INGESTION_FAILURE_REASONS.REPLAY_UNSUPPORTED_EVENT,
  INGESTION_FAILURE_REASONS.REPLAY_INVALID_PAYLOAD,
  INGESTION_FAILURE_REASONS.REPLAY_TENANT_MISMATCH,
] as const;

export type OpsReplayRejectionReason = (typeof OPS_REPLAY_REJECTION_REASONS)[number];

/**
 * A replay record this store will not keep. Its message reaches the log and
 * the dead letter's `x-dlq-error`, so it names schema paths and fixed phrases,
 * never a value.
 */
export class OpsReplayRejectedError extends Error {
  constructor(
    readonly reason: OpsReplayRejectionReason,
    readonly detail: string,
  ) {
    super(`replay record rejected: ${reason} (${detail})`);
    this.name = 'OpsReplayRejectedError';
  }
}

function describeIssues(issues: readonly ZodIssue[]): string {
  const named = issues.map(
    (issue) => `${issue.path.length === 0 ? '(root)' : issue.path.join('.')} ${issue.code}`,
  );
  const shown = named.slice(0, MAX_REPORTED_ISSUES).join(', ');
  return named.length > MAX_REPORTED_ISSUES ? `${shown}, …(${named.length} total)` : shown;
}

/** Validates one delivered replay record and maps it into the row the store keeps. */
export function toReplayExecutedRecord(
  envelope: EventEnvelope,
  delivery: EventDelivery,
): AuditEventRecord {
  const unsupported = INGESTION_FAILURE_REASONS.REPLAY_UNSUPPORTED_EVENT;
  const invalid = INGESTION_FAILURE_REASONS.REPLAY_INVALID_PAYLOAD;

  const parsedEnvelope = eventEnvelopeSchema.safeParse(envelope);
  if (!parsedEnvelope.success) {
    throw new OpsReplayRejectedError(unsupported, describeIssues(parsedEnvelope.error.issues));
  }
  const checked: EventEnvelope = { ...parsedEnvelope.data, payload: parsedEnvelope.data.payload };

  if (checked.eventName !== REPLAY_EXECUTED) {
    throw new OpsReplayRejectedError(unsupported, `eventName is not ${REPLAY_EXECUTED}`);
  }
  if (checked.eventVersion !== REPLAY_EXECUTED_VERSION) {
    throw new OpsReplayRejectedError(unsupported, `eventVersion is not ${REPLAY_EXECUTED_VERSION}`);
  }
  // `sourceTopic` is what tells a replay row from every other row, so a
  // record delivered anywhere else is refused rather than misfiled.
  if (delivery.topic !== OPS_REPLAY_TOPIC) {
    throw new OpsReplayRejectedError(unsupported, `not delivered on ${OPS_REPLAY_TOPIC}`);
  }
  if (checked.producer !== OPS_REPLAY_PRODUCER) {
    throw new OpsReplayRejectedError(unsupported, `producer is not ${OPS_REPLAY_PRODUCER}`);
  }

  const parsedPayload = replayExecutedPayloadSchemaV1.safeParse(checked.payload);
  if (!parsedPayload.success) {
    throw new OpsReplayRejectedError(invalid, describeIssues(parsedPayload.error.issues));
  }
  const payload = parsedPayload.data;

  // The record states its run and operator twice — in the envelope and in the
  // payload — and a record that disagrees with itself is not picked from.
  if (checked.correlationId !== payload.reportId) {
    throw new OpsReplayRejectedError(invalid, 'correlationId is not the payload reportId');
  }
  if (checked.actor?.type !== 'USER' || checked.actor.id !== payload.operator) {
    throw new OpsReplayRejectedError(invalid, 'actor is not the payload operator');
  }

  // The tenant, exactly as path B takes it: both absent is a platform record,
  // both present and equal is that tenant's, anything else is refused.
  const tenant = payload.replayedEvent.tenantId;
  if ((checked.tenantId ?? undefined) !== tenant) {
    throw new OpsReplayRejectedError(
      INGESTION_FAILURE_REASONS.REPLAY_TENANT_MISMATCH,
      'envelope tenantId is not the replayed event tenantId',
    );
  }

  const changes: AuditChange[] = [
    { field: 'topic', from: payload.dlq.topic, to: payload.target.topic },
    { field: 'partition', from: payload.dlq.partition, to: payload.target.partition },
    { field: 'offset', from: payload.dlq.offset, to: payload.target.offset },
    { field: 'eventName', from: null, to: payload.replayedEvent.eventName },
    { field: 'stale', from: null, to: payload.stale },
  ];

  return {
    ...toEnvelopeProvenance(checked, delivery),

    actorType: 'USER',
    actorId: payload.operator,
    actorRoles: [],

    organizationId: tenant ?? null,

    action: REPLAY_EXECUTED,
    resourceType: REPLAYED_RESOURCE_TYPE,
    resourceId: payload.replayedEvent.eventId,

    outcome: 'SUCCESS',
    errorCode: null,
    reason: null,
    changes,
    occurrenceCount: 1,

    sourceIp: null,
    sourceUserAgent: null,
    correctionOf: null,
  };
}
