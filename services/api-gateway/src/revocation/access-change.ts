import { eventEnvelopeSchema } from '@rasta/contracts';
import { z } from 'zod';

/**
 * The identity events the revocation list reads, and what each one says about
 * one (user, organization) pair (ADR-060, gateway revocation list addendum).
 *
 * A revocation sets the pair's cutoff: a token issued before it is refused.
 * Every one of the five also states the roles the pair holds from that moment
 * — none, for a revoked or expired membership — which is what refuses a token
 * issued after the change while the Keycloak projection still lags behind it
 * (ADR-060 § 7), and what lets a confirmed re-grant through again.
 *
 * The payloads are read with the fields the list needs and nothing else, and
 * no field of them is ever repeated: the identity reason (`reason`) is not
 * read at all.
 */
export const REVOKING_EVENTS = [
  'ROLE_REVOKED',
  'MEMBERSHIP_REVOKED',
  'MEMBERSHIP_EXPIRED',
] as const;
export const GRANTING_EVENTS = ['ROLE_ASSIGNED', 'MEMBERSHIP_CREATED'] as const;
const READ_EVENTS: readonly string[] = [...REVOKING_EVENTS, ...GRANTING_EVENTS];

/** The identity topic, owned by identity-service alone (`TOPIC_PRODUCERS`). */
export const IDENTITY_TOPIC = 'rasta.identity.v1';

export interface AccessChange {
  kind: 'revoke' | 'grant';
  userId: string;
  organizationId: string;
  /** The roles the pair holds from `atMs` on. */
  roles: string[];
  /** The envelope's `occurredAt`, epoch milliseconds: identity-service's clock. */
  atMs: number;
}

export type ReadResult =
  | { outcome: 'change'; change: AccessChange }
  /** An event the list does not read. */
  | { outcome: 'ignored' }
  /**
   * Possibly one the list reads, but it cannot be applied. Only the event name
   * is kept — when it could be read — for the log; never the payload, and
   * never the validation message, which may quote it.
   */
  | { outcome: 'unreadable'; eventName?: string };

const id = z.string().min(1);
const roles = z.array(z.string().min(1));

const PAYLOADS = {
  ROLE_REVOKED: z.object({ userId: id, organizationId: id, newRoles: roles }),
  ROLE_ASSIGNED: z.object({ userId: id, organizationId: id, newRoles: roles }),
  MEMBERSHIP_REVOKED: z.object({ userId: id, organizationId: id }),
  MEMBERSHIP_EXPIRED: z.object({ userId: id, organizationId: id }),
  MEMBERSHIP_CREATED: z.object({ userId: id, organizationId: id, roles }),
} as const;

/**
 * Reads one message of the identity topic.
 *
 * Unreadable, and so held against every pair by the caller, when the message
 * is not JSON, names no event, or names one of the five and then fails its
 * envelope, its version, its payload, or the tenant binding: the envelope's
 * `tenantId` must be present and equal the payload's `organizationId`.
 * Which pair a message that fails any of these concerned is not known, so no
 * pair can be chosen to refuse; guessing one could miss the real one.
 */
export function readAccessChange(value: Buffer | string | null): ReadResult {
  let raw: unknown;
  try {
    raw = value === null ? null : JSON.parse(value.toString());
  } catch {
    return { outcome: 'unreadable' };
  }

  const eventName =
    raw !== null && typeof raw === 'object'
      ? (raw as { eventName?: unknown }).eventName
      : undefined;
  if (typeof eventName !== 'string') return { outcome: 'unreadable' };
  if (!READ_EVENTS.includes(eventName)) return { outcome: 'ignored' };

  const unreadable: ReadResult = { outcome: 'unreadable', eventName };
  const envelope = eventEnvelopeSchema.safeParse(raw);
  // Version 1 is the only payload these schemas describe; a later one is not
  // guessed at.
  if (!envelope.success || envelope.data.eventVersion !== 1) return unreadable;

  const payload = PAYLOADS[eventName as keyof typeof PAYLOADS].safeParse(envelope.data.payload);
  if (!payload.success) return unreadable;
  if (envelope.data.tenantId !== payload.data.organizationId) return unreadable;

  const atMs = Date.parse(envelope.data.occurredAt);
  if (!Number.isFinite(atMs)) return unreadable;

  const data = payload.data as {
    userId: string;
    organizationId: string;
    newRoles?: string[];
    roles?: string[];
  };
  return {
    outcome: 'change',
    change: {
      kind: (REVOKING_EVENTS as readonly string[]).includes(eventName) ? 'revoke' : 'grant',
      userId: data.userId,
      organizationId: data.organizationId,
      // A revoked or expired membership holds nothing from that moment.
      roles: data.newRoles ?? data.roles ?? [],
      atMs,
    },
  };
}
