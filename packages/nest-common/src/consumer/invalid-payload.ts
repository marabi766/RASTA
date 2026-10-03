import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import { UnprocessableEventError } from './event-consumer';

/** The shape of a zod error this reads, so no particular zod instance is assumed. */
interface SchemaIssues {
  readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly code: string }[];
}

/** How many issues the message names; the rest are counted. */
const MAX_NAMED_ISSUES = 5;

/**
 * The refusal for a KNOWN event whose payload fails the consumer's schema
 * (audit L7-26, docs/07 § 7.6).
 *
 * Such an event is a producer defect that no retry fixes, so it is
 * dead-lettered at once as `VALIDATION_FAILED` rather than acknowledged as
 * `SKIPPED` — an inspection failure or a usage reading that silently vanished
 * left no trace anyone could replay. The handler throws this before writing
 * its processed-event marker, so a corrected event with the same id, replayed
 * once the producer is fixed, is still applied. An event name the consumer
 * does not handle is not this case: it stays a skip (forward compatibility).
 *
 * The message reaches the log and `x-dlq-error`, so it carries identifiers and
 * closed codes only (S-09): the event name and id, and per issue the field
 * path and zod's issue code. A path segment is shown only when it is one of
 * `fields` — the names the consumer's schema declares — or an array index;
 * any other segment is a key the payload supplied and is shown as `*`. Zod's
 * issue messages are left out because some repeat the value received.
 */
export function invalidPayloadError(
  envelope: Pick<EventEnvelope, 'eventName' | 'eventId'>,
  error: SchemaIssues,
  fields: readonly string[],
): UnprocessableEventError {
  const declared = new Set(fields);
  const segment = (key: PropertyKey): string =>
    typeof key === 'number' || (typeof key === 'string' && declared.has(key)) ? String(key) : '*';
  const named = error.issues
    .slice(0, MAX_NAMED_ISSUES)
    .map((issue) => `${issue.path.map(segment).join('.') || '(root)'} ${issue.code}`);
  const more =
    error.issues.length > MAX_NAMED_ISSUES
      ? `; and ${error.issues.length - MAX_NAMED_ISSUES} more`
      : '';
  return new UnprocessableEventError(
    DLQ_REASONS.VALIDATION_FAILED,
    `${envelope.eventName} ${envelope.eventId} payload fails its schema: ${named.join('; ')}${more}`,
  );
}

/**
 * The refusal for a KNOWN tenant-scoped event that carries no tenant anywhere
 * — neither in its payload nor on its envelope (audit L7-26).
 *
 * For an event name the consumer projects into a tenant's rows, a missing
 * tenant is a broken producer, not an event meant for someone else: there is
 * no organization to scope the write to, and guessing one would invent the
 * fact the row exists to carry. Acknowledging it as `SKIPPED` would lose it
 * without a trace, so it is dead-lettered at once as `VALIDATION_FAILED`,
 * thrown before the processed-event marker so a corrected replay with the
 * same id is still applied. Event names the consumer does not handle keep
 * their skip (forward compatibility).
 *
 * The message carries the event name and id only (S-09).
 */
export function missingTenantError(
  envelope: Pick<EventEnvelope, 'eventName' | 'eventId'>,
): UnprocessableEventError {
  return new UnprocessableEventError(
    DLQ_REASONS.VALIDATION_FAILED,
    `${envelope.eventName} ${envelope.eventId} carries no tenant`,
  );
}
