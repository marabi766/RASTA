import type { z } from 'zod';
import { MAINTENANCE_EVENT_SCHEMAS, MAINTENANCE_EVENTS, type MaintenanceEventName } from './events';

/**
 * Where each maintenance event goes on the wire.
 *
 * The same shape ADR-036 established for the economic, marketplace and
 * document domains, introduced here as part of ADR-051 Phase B3. Until now the
 * decision lived at each of nine call sites; this file only moves it to one
 * place and makes it exhaustive under the type checker. Every key below is the
 * key that call site already passed — no routing changes.
 *
 * **The stream is `topic + partitionKey` (ADR-051 § C-7),** so this file also
 * decides what B3 allocates a sequence against.
 */

export type MaintenancePayload<N extends MaintenanceEventName> = z.infer<
  (typeof MAINTENANCE_EVENT_SCHEMAS)[N]
>;

/** The aggregate each event is *about*, which is not what orders it. */
export const AGGREGATE_OF = {
  MAINTENANCE_DUE: 'MaintenanceSchedule',
  BREAKDOWN_REPORTED: 'MaintenanceRequest',
  MAINTENANCE_CREATED: 'MaintenanceRequest',
  WORKSHOP_ASSIGNED: 'RepairOrder',
  MAINTENANCE_STARTED: 'MaintenanceRequest',
  REPAIR_COMPLETED: 'RepairOrder',
  MAINTENANCE_COMPLETED: 'MaintenanceRequest',
  MAINTENANCE_APPROVED: 'MaintenanceRequest',
  MAINTENANCE_CANCELLED: 'MaintenanceRequest',
} as const satisfies Record<MaintenanceEventName, string>;

export const PARTITION_SCOPES = { ASSET: 'ASSET' } as const;
export type PartitionScope = (typeof PARTITION_SCOPES)[keyof typeof PARTITION_SCOPES];

export interface PartitionDecision {
  readonly scope: PartitionScope;
  readonly key: string;
}

type PartitionRule<N extends MaintenanceEventName> = (
  payload: MaintenancePayload<N>,
) => PartitionDecision;

/**
 * The one place a maintenance event's Kafka key is decided.
 *
 * **Every maintenance event is asset-scoped**, and that uniformity is the
 * point rather than an accident. A machine's maintenance history is one story:
 * reported → created → assigned → started → repaired → completed → approved.
 * A consumer rebuilding it must see those in order, and Kafka guarantees order
 * within a partition and nowhere else. Keying by request or repair-order id
 * would scatter one machine's history across partitions — which is exactly
 * what `events.ts` means when it says `assetId` is load-bearing on every
 * payload, not decorative.
 *
 * A mapped type over the event union, so adding a name to
 * `MAINTENANCE_EVENTS` without deciding how it is ordered fails
 * `pnpm typecheck`.
 *
 * **No ordering is claimed between this topic and `rasta.fleet.v1`,** even for
 * the same `assetId`. Both are STRICT after Q-36, and both being strict does
 * *not* make them ordered relative to each other: two databases, two counters,
 * no shared lock or transaction (ADR-051 § C-7, plan § B4). A negative test
 * holds that line so nobody later infers a guarantee that was never made.
 */
export const PARTITION_KEY_POLICY: { [N in MaintenanceEventName]: PartitionRule<N> } = {
  MAINTENANCE_DUE: (payload) => ({ scope: 'ASSET', key: payload.assetId }),
  BREAKDOWN_REPORTED: (payload) => ({ scope: 'ASSET', key: payload.assetId }),
  MAINTENANCE_CREATED: (payload) => ({ scope: 'ASSET', key: payload.assetId }),
  WORKSHOP_ASSIGNED: (payload) => ({ scope: 'ASSET', key: payload.assetId }),
  MAINTENANCE_STARTED: (payload) => ({ scope: 'ASSET', key: payload.assetId }),
  REPAIR_COMPLETED: (payload) => ({ scope: 'ASSET', key: payload.assetId }),
  MAINTENANCE_COMPLETED: (payload) => ({ scope: 'ASSET', key: payload.assetId }),
  MAINTENANCE_APPROVED: (payload) => ({ scope: 'ASSET', key: payload.assetId }),
  MAINTENANCE_CANCELLED: (payload) => ({ scope: 'ASSET', key: payload.assetId }),
};

/**
 * Resolves the partition key from the **validated** payload.
 *
 * Read off the payload rather than off a variable at the call site, so the key
 * and what the consumer sees cannot disagree — and so the sequence B3
 * allocates belongs to the stream the message is actually published on.
 */
export function resolvePartitionKey(
  eventName: MaintenanceEventName,
  payload: unknown,
): PartitionDecision {
  const rule = PARTITION_KEY_POLICY[eventName] as PartitionRule<MaintenanceEventName>;
  const decision = rule(payload as MaintenancePayload<MaintenanceEventName>);
  if (!decision.key) {
    throw new Error(
      `Maintenance routing: ${eventName} resolved to an empty partition key. ` +
        'An event without a stream cannot be ordered or sequenced.',
    );
  }
  return decision;
}

/** Every event this service produces, for the exhaustiveness tests. */
export const PRODUCED_EVENTS = Object.values(MAINTENANCE_EVENTS);
