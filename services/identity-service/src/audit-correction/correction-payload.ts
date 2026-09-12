import { isIP } from 'node:net';
import {
  AUDIT_CORRECTION_ACTION,
  auditTrailPayloadSchemaV1,
  type AuditChange,
  type AuditChangeValue,
  type AuditTrailPayloadV1,
} from '@rasta/contracts';
import { SENSITIVE_KEYS } from '@rasta/logging';
import { RastaError } from '@rasta/nest-common';

/**
 * The `AUDIT_EVENT_RECORDED` v1 payload of one correction (ADR-053 § 7).
 *
 * Pure: every input is passed in, so each field's provenance is a unit test.
 *
 *   actor.id, roles     the verified token
 *   organizationId      the trusted audit-service lookup of the target — absent
 *                       exactly when the target is genuinely platform-scoped
 *   action … outcome    fixed by ADR-053 § 7
 *   resourceId,         the target id the lookup proved
 *   correctionOf
 *   reason, changes     the validated command; changes redacted below
 *   source              the request context, kept only when safe as-is
 */

/** The resource type ADR-053 § 7 names for a corrected record. */
export const CORRECTION_RESOURCE_TYPE = 'AuditEvent';

/** The contract's role-list bound. A longer list is refused, never truncated. */
const ACTOR_ROLES_MAX = 64;
const SOURCE_IP_MAX_LENGTH = 64;
const USER_AGENT_MAX_LENGTH = 512;
const FIRST_PRINTABLE_CODE = 0x20;
const DELETE_CODE = 0x7f;

/**
 * `SENSITIVE_KEYS` from `@rasta/logging`, matched case-insensitively — the list
 * and the matching audit-service's path-B consumer enforces. A key added there
 * is redacted here the moment it is declared.
 */
const SENSITIVE = new Set<string>(SENSITIVE_KEYS.map((key) => key.toLowerCase()));

/** `password`, and also `credentials.password`: any sensitive segment counts. */
export function isSensitiveField(field: string): boolean {
  return field.split('.').some((segment) => SENSITIVE.has(segment.toLowerCase()));
}

/** The canonical redaction marker (ADR-053 § 5 point 2). */
const REDACTED: AuditChangeValue = { redacted: true };

/**
 * Replaces every value of a sensitive field with the redaction marker.
 *
 * Only the *fact* that a sensitive field was corrected is evidence (ADR-053 §
 * 5). A `{ hash }` marker is replaced too: a digest of a short secret is a
 * dictionary lookup away from the secret. `null` stays `null` — it discloses
 * nothing and "was unset" is itself the fact. Nothing else is rewritten.
 */
export function redactChanges(changes: readonly AuditChange[]): AuditChange[] {
  return changes.map((change) => {
    if (!isSensitiveField(change.field)) {
      return { field: change.field, from: change.from, to: change.to };
    }
    return {
      field: change.field,
      from: change.from === null ? null : REDACTED,
      to: change.to === null ? null : REDACTED,
    };
  });
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < FIRST_PRINTABLE_CODE || code === DELETE_CODE) return true;
  }
  return false;
}

/**
 * The request's own source, kept only when it is safe **as it is**.
 *
 * Dropped, never repaired: a caller controls `User-Agent`, and a truncated or
 * cleaned value would be a value nobody sent. The address must be a literal IP.
 */
export function safeSource(source: {
  ip?: string;
  userAgent?: string;
}): { ip?: string; userAgent?: string } | undefined {
  const ip =
    typeof source.ip === 'string' &&
    source.ip.length <= SOURCE_IP_MAX_LENGTH &&
    isIP(source.ip) !== 0
      ? source.ip
      : undefined;
  const userAgent =
    typeof source.userAgent === 'string' &&
    source.userAgent.trim().length > 0 &&
    source.userAgent.length <= USER_AGENT_MAX_LENGTH &&
    !hasControlCharacter(source.userAgent)
      ? source.userAgent
      : undefined;

  if (ip === undefined && userAgent === undefined) return undefined;
  return { ...(ip !== undefined ? { ip } : {}), ...(userAgent !== undefined ? { userAgent } : {}) };
}

export interface CorrectionPayloadInput {
  readonly actorId: string;
  readonly actorRoles: readonly string[];
  /** From the trusted lookup. `null` organization = a platform-scoped target. */
  readonly target: { readonly id: string; readonly organizationId: string | null };
  readonly reason: string;
  readonly changes: readonly AuditChange[];
  readonly source: { ip?: string; userAgent?: string };
}

/**
 * Builds and validates the correction payload.
 *
 * Validated with `auditTrailPayloadSchemaV1` — the schema audit-service
 * consumes against — *before* anything is written, so a message the store would
 * dead-letter never enters the outbox. A failure is reported without the
 * schema's own message, which can quote the value it rejected.
 */
export function buildCorrectionPayload(input: CorrectionPayloadInput): AuditTrailPayloadV1 {
  const roles = [...new Set(input.actorRoles)];
  if (roles.length > ACTOR_ROLES_MAX) {
    throw RastaError.internal('The correction could not be attributed to its actor');
  }
  const source = safeSource(input.source);

  const candidate = {
    actor: { type: 'USER' as const, id: input.actorId, roles },
    ...(input.target.organizationId !== null
      ? { organizationId: input.target.organizationId }
      : {}),
    action: AUDIT_CORRECTION_ACTION,
    resourceType: CORRECTION_RESOURCE_TYPE,
    resourceId: input.target.id,
    outcome: 'SUCCESS' as const,
    reason: input.reason,
    changes: redactChanges(input.changes),
    occurrenceCount: 1,
    ...(source !== undefined ? { source } : {}),
    correctionOf: input.target.id,
  };

  const parsed = auditTrailPayloadSchemaV1.safeParse(candidate);
  if (!parsed.success) {
    throw RastaError.internal('The correction could not be expressed as a valid audit event');
  }
  return parsed.data;
}
